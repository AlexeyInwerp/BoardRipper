package updater

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strings"
	"sync"
	"time"
)

// dockerSocket is the Engine API endpoint this process talks to. A var, not a
// const, only so the Docker-backed orchestration test can point it at a
// non-standard socket (Colima, Rancher, a rootless daemon) — nothing at
// runtime rewrites it.
var dockerSocket = "/var/run/docker.sock"

// Docker Engine API version. Resolved lazily from `GET /_ping` so we speak
// whatever the local daemon supports — Synology DSM 7's bundled Container
// Manager tops out at API 1.41, while Docker Desktop 29+ requires ≥1.44 and
// rejects 1.41 as "too old". A hardcoded path can satisfy one but not the
// other; probing the daemon makes us speak the right dialect on either.
//
// Fallback "v1.41" only applies if /_ping fails entirely (daemon down or
// unreachable) — in which case nothing else will work either, but we don't
// want a panic at first use.
var (
	apiVersion     = "v1.41"
	apiVersionOnce sync.Once
)

func dockerAPI() string {
	apiVersionOnce.Do(func() {
		client := &http.Client{
			Transport: &http.Transport{
				DialContext: func(_ context.Context, _, _ string) (net.Conn, error) {
					return net.Dial("unix", dockerSocket)
				},
			},
			Timeout: 2 * time.Second,
		}
		resp, err := client.Get("http://docker/_ping")
		if err != nil {
			return
		}
		defer resp.Body.Close()
		if v := resp.Header.Get("Api-Version"); v != "" {
			apiVersion = "v" + v
		}
	})
	return apiVersion
}

// isDockerAvailable checks if the Docker socket exists and is usable.
func isDockerAvailable() bool {
	info, err := os.Stat(dockerSocket)
	if err != nil {
		return false
	}
	// Must be a socket
	return info.Mode()&os.ModeSocket != 0
}

// dockerClient returns an HTTP client that talks to the Docker Engine API via Unix socket.
func dockerClient() *http.Client {
	return &http.Client{
		Transport: &http.Transport{
			DialContext: func(_ context.Context, _, _ string) (net.Conn, error) {
				return net.Dial("unix", dockerSocket)
			},
		},
		Timeout: 30 * time.Second,
	}
}

// dockerLoad loads a tar.gz image into Docker via the Engine API (no CLI needed).
func (u *Updater) dockerLoad(tarPath string) error {
	f, err := os.Open(tarPath)
	if err != nil {
		return err
	}
	defer f.Close()

	gz, err := gzip.NewReader(f)
	if err != nil {
		return fmt.Errorf("gzip decompress failed: %w", err)
	}
	defer gz.Close()

	// POST /images/load with the raw tar stream
	client := &http.Client{
		Transport: &http.Transport{
			DialContext: func(_ context.Context, _, _ string) (net.Conn, error) {
				return net.Dial("unix", dockerSocket)
			},
		},
		Timeout: 10 * time.Minute,
	}
	req, _ := http.NewRequest("POST", "http://docker/" + dockerAPI() + "/images/load", gz)
	req.Header.Set("Content-Type", "application/x-tar")
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("docker image load failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return fmt.Errorf("docker image load returned %d", resp.StatusCode)
	}

	// /images/load returns HTTP 200 and then streams newline-delimited JSON that
	// can STILL carry a terminal errorDetail (corrupt layer, image-format /
	// version mismatch, out-of-space). Draining to io.Discard would swallow that
	// and let applyTarball/ApplyBundle proceed — Apply() would persist the new
	// counter and swap onto an image that never actually loaded. Scan the stream
	// exactly like the pull path (pullDockerImage/dockerPullByDigest) and fail if
	// any line reports an error, so the caller aborts BEFORE the counter is
	// written.
	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	var loadErr string
	for scanner.Scan() {
		var msg struct {
			ErrorDetail struct {
				Message string `json:"message"`
			} `json:"errorDetail"`
			Error string `json:"error"`
		}
		if err := json.Unmarshal(scanner.Bytes(), &msg); err != nil {
			continue
		}
		if msg.ErrorDetail.Message != "" {
			loadErr = msg.ErrorDetail.Message
		} else if msg.Error != "" {
			loadErr = msg.Error
		}
	}
	if loadErr != "" {
		return fmt.Errorf("docker image load stream error: %s", loadErr)
	}
	return nil
}

// containerInfo holds the subset of Docker container inspect data we need.
type containerInfo struct {
	ID      string
	Name    string
	Image   string
	Env     []string
	User    string
	Mounts  []mount
	Ports   map[string][]portBinding
	Restart string
	// Issue #21: the swap must preserve these or the new container silently
	// lands on the default bridge with no Compose ownership and no limits.
	Labels      map[string]string  // incl. com.docker.compose.* — restores Compose ownership
	Networks    []containerNetwork // user-defined networks (e.g. reverse-proxy net), sorted by name
	NetworkMode string             // "host"/"none"/"container:…" are exclusive and bypass EndpointsConfig
	Memory      int64              // bytes; 0 = unset
	NanoCpus    int64              // 1e9 = 1 CPU; 0 = unset
}

// containerNetwork is one network attachment carried across the update swap.
type containerNetwork struct {
	Name    string
	ID      string
	Aliases []string
}

type mount struct {
	Source      string `json:"Source"`
	Destination string `json:"Destination"`
	RW          bool   `json:"RW"`
}

type portBinding struct {
	HostIP   string `json:"HostIp"`
	HostPort string `json:"HostPort"`
}

// findSelfContainer finds the current BoardRipper container by matching hostname to container ID.
func findSelfContainer() (*containerInfo, error) {
	client := dockerClient()

	hostname, err := os.Hostname()
	if err != nil {
		return nil, fmt.Errorf("cannot get hostname: %w", err)
	}

	// List all containers, find ours by hostname (Docker sets hostname = short container ID)
	resp, err := client.Get("http://docker/" + dockerAPI() + "/containers/json?all=true")
	if err != nil {
		return nil, fmt.Errorf("Docker API error: %w", err)
	}
	defer resp.Body.Close()

	// 4xx/5xx responses come back with a JSON `{"message":...}` body. Without
	// this status check, the parse-as-array below fails with the cryptic
	// "json: cannot unmarshal object into ... []struct" — that's how the
	// v1.41-vs-29.x mismatch surfaced before we bumped the path.
	if resp.StatusCode >= 400 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return nil, fmt.Errorf("Docker API HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}

	var containers []struct {
		ID    string   `json:"Id"`
		Names []string `json:"Names"`
		Image string   `json:"Image"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&containers); err != nil {
		return nil, fmt.Errorf("failed to parse container list: %w", err)
	}

	var containerID string
	for _, c := range containers {
		if strings.HasPrefix(c.ID, hostname) {
			containerID = c.ID
			break
		}
	}
	if containerID == "" {
		return nil, fmt.Errorf("cannot find own container (hostname=%s)", hostname)
	}

	// Inspect the container for full config
	resp2, err := client.Get(fmt.Sprintf("http://docker/" + dockerAPI() + "/containers/%s/json", containerID))
	if err != nil {
		return nil, fmt.Errorf("container inspect failed: %w", err)
	}
	defer resp2.Body.Close()

	var inspect struct {
		ID     string `json:"Id"`
		Name   string `json:"Name"`
		Config struct {
			Image  string            `json:"Image"`
			Env    []string          `json:"Env"`
			User   string            `json:"User"`
			Labels map[string]string `json:"Labels"`
		} `json:"Config"`
		HostConfig struct {
			Binds       []string                       `json:"Binds"`
			PortBindings map[string][]portBinding       `json:"PortBindings"`
			RestartPolicy struct {
				Name string `json:"Name"`
			} `json:"RestartPolicy"`
			NetworkMode string `json:"NetworkMode"`
			Memory      int64  `json:"Memory"`
			NanoCpus    int64  `json:"NanoCpus"`
		} `json:"HostConfig"`
		Mounts          []mount `json:"Mounts"`
		NetworkSettings struct {
			Networks map[string]struct {
				NetworkID string   `json:"NetworkID"`
				Aliases   []string `json:"Aliases"`
			} `json:"Networks"`
		} `json:"NetworkSettings"`
	}
	if err := json.NewDecoder(resp2.Body).Decode(&inspect); err != nil {
		return nil, fmt.Errorf("failed to parse container inspect: %w", err)
	}

	// Flatten the network map into a name-sorted slice so the "primary" network
	// (attached at container-create) is deterministic across updates. Issue #21:
	// without this the recreated container lands on the default bridge only.
	networks := make([]containerNetwork, 0, len(inspect.NetworkSettings.Networks))
	for name, n := range inspect.NetworkSettings.Networks {
		networks = append(networks, containerNetwork{Name: name, ID: n.NetworkID, Aliases: n.Aliases})
	}
	sort.Slice(networks, func(i, j int) bool { return networks[i].Name < networks[j].Name })

	return &containerInfo{
		ID:          inspect.ID,
		Name:        strings.TrimPrefix(inspect.Name, "/"),
		Image:       inspect.Config.Image,
		Env:         inspect.Config.Env,
		User:        inspect.Config.User,
		Mounts:      inspect.Mounts,
		Ports:       inspect.HostConfig.PortBindings,
		Restart:     inspect.HostConfig.RestartPolicy.Name,
		Labels:      inspect.Config.Labels,
		Networks:    networks,
		NetworkMode: inspect.HostConfig.NetworkMode,
		Memory:      inspect.HostConfig.Memory,
		NanoCpus:    inspect.HostConfig.NanoCpus,
	}, nil
}

// pullDockerImage pulls `image:tag` via the Engine API and waits for
// completion. The Engine API does NOT auto-pull on `POST /containers/create`
// (unlike `docker run` on the CLI), so without this step the orchestrator
// fails on hosts that don't already have alpine:latest in their local image
// cache — which is most fresh installs and any air-gapped Synology / homelab
// box. logFn is forwarded the streamed status updates so the operator sees
// progress in the Debug tab.
func pullDockerImage(image, tag string, logFn func(string, string)) error {
	client := &http.Client{
		Transport: &http.Transport{
			DialContext: func(_ context.Context, _, _ string) (net.Conn, error) {
				return net.Dial("unix", dockerSocket)
			},
		},
		Timeout: 5 * time.Minute,
	}

	q := url.Values{}
	q.Set("fromImage", image)
	q.Set("tag", tag)
	endpoint := "http://docker/" + dockerAPI() + "/images/create?" + q.Encode()

	logFn(fmt.Sprintf("Pulling %s:%s ...", image, tag), "info")
	req, _ := http.NewRequest("POST", endpoint, nil)
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("docker image pull request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return fmt.Errorf("docker image pull returned %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}

	// Stream is newline-delimited JSON. We mostly drain it but surface a
	// terminal `errorDetail` so the caller can react cleanly (instead of
	// failing later at container-create with the more cryptic
	// "no such image"). The last status line tells the operator whether
	// the image was downloaded fresh or already current.
	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	var lastStatus, pullErr string
	for scanner.Scan() {
		var msg struct {
			Status      string `json:"status"`
			ErrorDetail struct {
				Message string `json:"message"`
			} `json:"errorDetail"`
			Error string `json:"error"`
		}
		if err := json.Unmarshal(scanner.Bytes(), &msg); err != nil {
			continue
		}
		if msg.ErrorDetail.Message != "" {
			pullErr = msg.ErrorDetail.Message
		} else if msg.Error != "" {
			pullErr = msg.Error
		}
		if msg.Status != "" {
			lastStatus = msg.Status
		}
	}
	if pullErr != "" {
		return fmt.Errorf("%s — try `docker pull %s:%s` manually and retry", pullErr, image, tag)
	}
	if lastStatus != "" {
		logFn(lastStatus, "info")
	}
	return nil
}

// dockerPullByDigest pulls registry@digest via the Docker Engine API.
// The Engine API's POST /images/create with a digest tag does a content-addressed
// pull that is immune to tag-mutable attacks.
func (u *Updater) dockerPullByDigest(registry, digest string) error {
	ref := registry + "@" + digest
	u.logProgress("Pulling "+ref, "info")

	client := &http.Client{
		Transport: &http.Transport{
			DialContext: func(_ context.Context, _, _ string) (net.Conn, error) {
				return net.Dial("unix", dockerSocket)
			},
		},
		Timeout: 5 * time.Minute,
	}

	q := url.Values{}
	q.Set("fromImage", registry)
	q.Set("tag", digest)
	endpoint := "http://docker/" + dockerAPI() + "/images/create?" + q.Encode()

	req, _ := http.NewRequest("POST", endpoint, nil)
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("pull request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return fmt.Errorf("pull returned %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}

	// Stream is newline-delimited JSON. Drain until EOF; surface any error field.
	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	var lastStatus, pullErr string
	for scanner.Scan() {
		var msg struct {
			Status      string `json:"status"`
			ErrorDetail struct {
				Message string `json:"message"`
			} `json:"errorDetail"`
			Error string `json:"error"`
		}
		if err := json.Unmarshal(scanner.Bytes(), &msg); err != nil {
			continue
		}
		if msg.ErrorDetail.Message != "" {
			pullErr = msg.ErrorDetail.Message
		} else if msg.Error != "" {
			pullErr = msg.Error
		}
		if msg.Status != "" {
			lastStatus = msg.Status
		}
	}
	if pullErr != "" {
		return fmt.Errorf("pull stream error: %s", pullErr)
	}
	if lastStatus != "" {
		u.logProgress(lastStatus, "info")
	}
	return nil
}

// dockerSockPOST sends a POST to the Docker Engine API via the Unix socket.
// body may be nil for requests with no payload. The response body is drained
// and discarded; only the status code is returned.
func dockerSockPOST(endpoint string, body []byte) (int, error) {
	client := dockerClient()
	var bodyReader io.Reader
	if body != nil {
		bodyReader = bytes.NewReader(body)
	}
	req, err := http.NewRequest("POST", "http://docker/" + dockerAPI() + ""+endpoint, bodyReader)
	if err != nil {
		return 0, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := client.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, resp.Body)
	return resp.StatusCode, nil
}

// tagPrevious tags the currently-running container's image as
// boardripper:previous so a failed update can be reverted manually.
// This is best-effort — the caller logs and continues on error.
func (u *Updater) tagPrevious() error {
	ci, err := findSelfContainer()
	if err != nil {
		return fmt.Errorf("findSelfContainer: %w", err)
	}
	if ci.Image == "" {
		return errors.New("self image unknown")
	}
	// POST /images/{name}/tag?repo=boardripper&tag=previous
	// The image name may contain slashes so we use url.PathEscape on the
	// reference but keep the query params unescaped (they're plain identifiers).
	imgRef := url.PathEscape(ci.Image)
	endpoint := fmt.Sprintf("/images/%s/tag?repo=boardripper&tag=previous", imgRef)
	code, err := dockerSockPOST(endpoint, nil)
	if err != nil {
		return fmt.Errorf("tag API call failed: %w", err)
	}
	// 201 = created, 200 = already existed; both are success.
	if code != 201 && code != 200 {
		return fmt.Errorf("tag API returned HTTP %d", code)
	}
	u.logProgress(fmt.Sprintf("Tagged %s as boardripper:previous", ci.Image), "info")
	return nil
}

// buildSwapScript renders the shell the orchestrator container runs: stop the
// old container, recreate it on the new image, health-check it, and roll back
// if the check fails. Extracted from orchestrateSwap so the generated script
// can be asserted on directly (health_probe_test.go).
func buildSwapScript(self *containerInfo, newImage string) string {
	createBody := buildCreateBody(self, newImage)
	bodyJSON, _ := json.Marshal(createBody)
	connectScript := networkConnectScript(self)

	// Shell script for the orchestrator to execute. self.Name and self.ID
	// come in via $BR_NAME / $BR_ID environment variables (set on the
	// orchestrator container's Env), NOT via string interpolation into the
	// script body. Docker constrains container names to a safe charset
	// today, but interpolating user-controllable identifiers into a bash
	// heredoc is brittle — if a future Docker release widens the allowed
	// chars (or if a malicious image relabels the container at runtime),
	// shell injection becomes possible. Env vars sidestep this entirely.
	//
	// The two parameters that DO need interpolation — dockerAPI() and the
	// container-create body JSON — are both produced by this binary, not
	// derived from user input, so they remain inline.
	return fmt.Sprintf(`#!/bin/sh
set -e
SOCK="/var/run/docker.sock"
API="http://localhost/%s"

# Helper: Docker API via curl
dapi() { curl -sf --unix-socket "$SOCK" "$@"; }

# curl is the only way to speak HTTP over a unix socket here (busybox wget
# cannot), and it is installed at run time from the Alpine CDN. When that
# install fails the swap must say so: chaining it with && instead left a
# silent no-op that looks exactly like an update that "did nothing".
if ! command -v curl >/dev/null 2>&1; then
  echo "[orchestrator] FATAL: curl could not be installed in the orchestrator container (no network access to the Alpine CDN?). Nothing was changed — the running container is untouched."
  exit 1
fi

echo "[orchestrator] Stopping $BR_NAME..."
dapi -X POST "$API/containers/$BR_ID/stop?t=10" >/dev/null 2>&1 || true
sleep 2

echo "[orchestrator] Removing leftovers from a previous swap if they exist..."
dapi -X DELETE "$API/containers/$BR_NAME-old?force=true" >/dev/null 2>&1 || true
dapi -X DELETE "$API/containers/$BR_NAME-failed?force=true" >/dev/null 2>&1 || true

echo "[orchestrator] Renaming $BR_NAME → $BR_NAME-old..."
dapi -X POST "$API/containers/$BR_ID/rename?name=$BR_NAME-old" >/dev/null

echo "[orchestrator] Creating new container $BR_NAME with image %s..."
CREATE_BODY=$(cat <<'ENDJSON'
%s
ENDJSON
)
RESP=$(dapi -X POST -H "Content-Type: application/json" -d "$CREATE_BODY" "$API/containers/create?name=$BR_NAME")
NEW_ID=$(echo "$RESP" | sed -n 's/.*"Id":"\([^"]*\)".*/\1/p')
if [ -z "$NEW_ID" ]; then
  echo "[orchestrator] FAIL: create returned: $RESP — rolling back"
  dapi -X POST "$API/containers/$BR_ID/rename?name=$BR_NAME" >/dev/null 2>&1 || true
  dapi -X POST "$API/containers/$BR_ID/start" >/dev/null 2>&1 || true
  exit 1
fi

# Issue #21: reattach any additional user-defined networks (beyond the primary,
# attached at create) before start, so the app is reachable on every network the
# instant it comes up. Empty when the container had <=1 network or host mode.
%s
echo "[orchestrator] Starting new container $NEW_ID..."
START_CODE=$(dapi -o /dev/null -w "%%{http_code}" -X POST "$API/containers/$NEW_ID/start")
if [ "$START_CODE" != "204" ] && [ "$START_CODE" != "304" ]; then
  echo "[orchestrator] FAIL: start returned $START_CODE — rolling back"
  dapi -X DELETE "$API/containers/$NEW_ID?force=true" >/dev/null 2>&1 || true
  dapi -X POST "$API/containers/$BR_ID/rename?name=$BR_NAME" >/dev/null 2>&1 || true
  dapi -X POST "$API/containers/$BR_ID/start" >/dev/null 2>&1 || true
  exit 1
fi

echo "[orchestrator] Resolving health-probe endpoints..."
NEW_IP=""
ipattempts=0
while [ -z "$NEW_IP" ] && [ $ipattempts -lt 10 ]; do
  # Every IPAddress in the inspect JSON — .NetworkSettings.IPAddress (default
  # bridge) and .NetworkSettings.Networks.<name>.IPAddress (user-defined) —
  # first non-empty wins. grep -o, not a greedy sed: the JSON is one line, so
  # a greedy match yields only the LAST field, which is the empty top-level
  # one on some topologies.
  NEW_IP=$(dapi "$API/containers/$NEW_ID/json" 2>/dev/null \
    | grep -o '"IPAddress":"[^"]*"' | cut -d'"' -f4 | grep -v '^$' | head -1)
  [ -z "$NEW_IP" ] && sleep 1
  ipattempts=$((ipattempts + 1))
done

# Candidate health endpoints, every one tried each poll round. None of them is
# reachable in every topology, which is why there is a list rather than a pick:
#   - container IP    — only from a network the orchestrator shares with it.
#                       Docker DROPs traffic between two bridge networks, so on
#                       a Compose install (every DSM Container Manager
#                       "project") this is unreachable from the default bridge.
#   - host gateway    — only when a port is published on 0.0.0.0, or when the
#                       app runs on the host network (no container IP at all).
#   - container name  — only on a user-defined network the orchestrator joined.
GW=$(ip route 2>/dev/null | awk '/^default/{print $3; exit}')
URLS=""
[ -n "$NEW_IP" ] && URLS="http://$NEW_IP:$BR_PORT/api/health"
if [ -n "$GW" ]; then
  if [ -n "$BR_HOSTPORT" ]; then
    URLS="$URLS http://$GW:$BR_HOSTPORT/api/health"
  else
    URLS="$URLS http://$GW:$BR_PORT/api/health"
  fi
fi
URLS="$URLS http://$BR_NAME:$BR_PORT/api/health"
echo "[orchestrator] Polling up to 120s:$(for u in $URLS; do printf ' %%s' "$u"; done)"
# Wall-clock deadline, not a round count: each candidate can burn its full
# 2s timeout, so "30 rounds" was anywhere between 60s and four minutes
# depending on how many endpoints hang rather than refuse.
deadline=$(( $(date +%%s) + 120 ))
ok=0
while [ "$(date +%%s)" -lt "$deadline" ]; do
  for u in $URLS; do
    if wget -q -O - --timeout=2 "$u" 2>/dev/null | grep -q '"status":"ok"'; then
      ok=1
      echo "[orchestrator] Health check passed via $u"
      break
    fi
  done
  if [ "$ok" = "1" ]; then break; fi
  sleep 2
done

if [ "$ok" = "1" ]; then
  echo "[orchestrator] Removing old container."
  dapi -X DELETE "$API/containers/$BR_NAME-old?force=true" >/dev/null 2>&1 || true
  echo "[orchestrator] Done."
  exit 0
fi

echo "[orchestrator] WARN: health check failed after 120s — rolling back to previous container."
echo "[orchestrator] Last 50 log lines from the container that failed its health check:"
dapi "$API/containers/$NEW_ID/logs?stdout=1&stderr=1&tail=50" 2>/dev/null | tr -d '\000-\010\013\014\016-\037' || true
dapi -X POST "$API/containers/$NEW_ID/stop?t=5" >/dev/null 2>&1 || true
# Keep the failed container (renamed) rather than deleting it: it is the only
# record of WHY the new version would not serve, and the next update removes it
# first. Deleting it is what left an unreachable install with nothing to report.
dapi -X DELETE "$API/containers/$BR_NAME-failed?force=true" >/dev/null 2>&1 || true
if ! dapi -X POST "$API/containers/$NEW_ID/rename?name=$BR_NAME-failed" >/dev/null 2>&1; then
  dapi -X DELETE "$API/containers/$NEW_ID?force=true" >/dev/null 2>&1 || true
fi
dapi -X POST "$API/containers/$BR_ID/rename?name=$BR_NAME" >/dev/null 2>&1 || true
dapi -X POST "$API/containers/$BR_ID/start" >/dev/null 2>&1 || true
echo "[orchestrator] Rollback complete — previous container restarted; the failed one is kept as $BR_NAME-failed."
exit 1
`,
		dockerAPI(),       // API= path version
		newImage,          // create-log line: human-readable image reference
		string(bodyJSON),  // CREATE_BODY heredoc (JSON produced by this binary, not user-derived)
		connectScript,     // post-create network reattach (issue #21); "" for single-network/host
	)
}

// orchestrateRestart launches a lightweight Alpine container that:
// 1. Stops the current container
// 2. Renames it to -old
// 3. Creates a new container with the same config + new image
// 4. Starts the new container
// 5. On failure, rolls back
//
// This is necessary because the current container cannot stop itself
// and continue executing — the Go process dies when Docker stops it.
func (u *Updater) orchestrateRestart(m *Manifest) error {
	logFn := u.logProgress
	logFn("Locating self container via Docker socket...", "info")
	self, err := findSelfContainer()
	if err != nil {
		return fmt.Errorf("cannot identify self: %w", err)
	}

	return u.orchestrateSwap(self, m)
}

// orchestrateSwap is orchestrateRestart minus the self-discovery step: given a
// description of the container to replace, it builds and launches the
// orchestrator. Split out so the swap can be driven against a real Docker
// daemon in a test (TestOrchestratorSwap_* in orchestration_docker_test.go)
// without the test process having to BE a container.
func (u *Updater) orchestrateSwap(self *containerInfo, m *Manifest) error {
	logFn := u.logProgress
	logFn(fmt.Sprintf("Self container: name=%s id=%s image=%s restart=%s", self.Name, shortID(self.ID), self.Image, self.Restart), "info")
	logFn(fmt.Sprintf("Mounts: %d, env vars: %d, port bindings: %d", len(self.Mounts), len(self.Env), len(self.Ports)), "info")
	netNames := make([]string, len(self.Networks))
	for i, n := range self.Networks {
		netNames[i] = n.Name
	}
	logFn(fmt.Sprintf("Preserving across swap — networks: [%s] mode=%s, labels: %d, mem: %dMiB, nanocpus: %d",
		strings.Join(netNames, " "), self.NetworkMode, len(self.Labels), self.Memory/(1024*1024), self.NanoCpus), "info")

	// Determine the orchestrator image. The manifest pins a content-addressed
	// digest for reproducibility; fall back to alpine:latest for dev builds
	// where OrchestratorImage may be empty.
	orchImage := m.OrchestratorImage
	if orchImage == "" {
		orchImage = "alpine:latest"
	}

	// Ensure the orchestrator base image is present locally — Engine API
	// won't auto-pull on container create.
	orchName, orchTag := parseDockerImageRef(orchImage)
	if err := pullDockerImage(orchName, orchTag, logFn); err != nil {
		return fmt.Errorf("orchestrator image %s unavailable: %w", orchImage, err)
	}

	// Image reference for `containers/create`. Bug class: v0.19.2 shipped a
	// "boardripper:<version>" local-tag form here, but pull-by-digest never
	// creates a named tag in the local image store, so containers/create 404'd
	// and the orchestrator left the host with no running container. The
	// canonical <registry>@<digest> form fixes both pull paths (registry pull
	// and tarball-load preserve the same digest).
	newImage := selectNewImageRef(m)

	// Build the create body for the new container.
	// "User" propagates the runtime user override (e.g. `--user 0:0` from
	// `docker run`) into the new container's Config. Without this, deploys
	// that override the image-default USER (the production NAS install does
	// this via deploy-remote.sh:143 because the bind-mounted data dir has
	// mixed root/65532 ownership) silently regressed to image-default USER
	// on every update — the new container would start, fail to read/write
	// /data files that the root-running OLD container had written, and the
	// orchestrator would time out on /api/health and roll back. Image-default
	// USER installs (self.User == "") fall through unchanged.
	//
	// buildCreateBody additionally carries (issue #21) the container's Compose
	// labels, resource limits, and primary network attachment so the recreated
	// container stays reachable on the user's reverse-proxy network and owned by
	// Docker Compose. Networks beyond the first are reconnected post-create via
	// networkConnectScript (Docker's create only honors one EndpointsConfig).
	script := buildSwapScript(self, newImage)

	client := dockerClient()

	// Create the orchestrator container using the pinned orchestrator image (with curl).
	// $BR_NAME and $BR_ID feed the script via Env, not via shell-interpolation
	// of self.Name / self.ID into the script body. See H5 in the secure-update-
	// pipeline audit: any future widening of Docker's container-name charset
	// (or a malicious image relabeling its container) would otherwise become a
	// shell-injection vector inside a Docker-socket-privileged container.
	appPort := appListenPort(self.Env)
	hostPort := publishedHostPort(self.Ports, appPort)
	logFn(fmt.Sprintf("Health probe targets: container port %s, published host port %q, networks to join: %d",
		appPort, hostPort, len(orchestratorNetworks(self))), "info")

	binds := []string{"/var/run/docker.sock:/var/run/docker.sock"}
	cmd := "apk add --no-cache curl >/dev/null 2>&1 || true\n" + script
	// The orchestrator auto-removes, so its console log dies with it — which is
	// exactly what made a rollback on somebody else's NAS undiagnosable. Tee the
	// whole run into the app's own data dir instead, where the user can read it
	// after the fact (the rolled-back container serves the same directory).
	if src := dataDirSource(self.Mounts, self.Env); src != "" {
		binds = append(binds, src+":"+orchLogMountPath)
		// The closing brace must follow a newline, not a ";" — the script's own
		// last line already ends in one, and `exit 1\n ; }` is a syntax error
		// that kills the whole swap before the first API call (measured: the
		// orchestrator exited instantly and the container was never touched).
		cmd = "{ " + cmd + "\n} 2>&1 | tee " + orchLogMountPath + "/" + orchLogFileName
	}

	orchBody := map[string]interface{}{
		"Image": orchImage,
		"Cmd":   []string{"sh", "-c", cmd},
		"Env": []string{
			"BR_NAME=" + self.Name,
			"BR_ID=" + self.ID,
			"BR_PORT=" + appPort,
			"BR_HOSTPORT=" + hostPort,
		},
		"HostConfig": map[string]interface{}{
			"Binds":     binds,
			"AutoRemove": true,
		},
	}
	orchJSON, _ := json.Marshal(orchBody)

	logFn(fmt.Sprintf("Building orchestrator script (length=%d bytes, target image=%s)", len(script), newImage), "info")

	// Delete any existing orchestrator container first
	logFn("Removing leftover boardripper-orchestrator container if present...", "info")
	delReq, _ := http.NewRequest("DELETE",
		"http://docker/" + dockerAPI() + "/containers/boardripper-orchestrator?force=true", nil)
	if resp, err := client.Do(delReq); err == nil {
		resp.Body.Close()
	}

	logFn("Creating orchestrator container...", "info")
	createReq, _ := http.NewRequest("POST",
		"http://docker/" + dockerAPI() + "/containers/create?name=boardripper-orchestrator",
		bytes.NewReader(orchJSON))
	createReq.Header.Set("Content-Type", "application/json")

	createResp, err := client.Do(createReq)
	if err != nil {
		return fmt.Errorf("failed to create orchestrator: %w", err)
	}
	defer createResp.Body.Close()

	if createResp.StatusCode != 201 {
		body, _ := io.ReadAll(io.LimitReader(createResp.Body, 512))
		return fmt.Errorf("orchestrator create returned %d: %s", createResp.StatusCode, string(body))
	}

	var created struct {
		ID string `json:"Id"`
	}
	json.NewDecoder(createResp.Body).Decode(&created)
	logFn(fmt.Sprintf("Orchestrator created: id=%s", shortID(created.ID)), "info")

	// Join the app's own networks BEFORE starting, so the health probe can
	// reach the new container by IP (and by name). The orchestrator keeps its
	// default-bridge attachment — it needs egress for `apk add curl`, and a
	// Compose network may be `internal: true`.
	for _, n := range orchestratorNetworks(self) {
		connBody, _ := json.Marshal(map[string]interface{}{"Container": created.ID})
		connReq, _ := http.NewRequest("POST",
			"http://docker/"+dockerAPI()+"/networks/"+n.ID+"/connect", bytes.NewReader(connBody))
		connReq.Header.Set("Content-Type", "application/json")
		connResp, cerr := client.Do(connReq)
		if cerr != nil {
			logFn(fmt.Sprintf("WARN: orchestrator could not join network %s (%v) — health probe falls back to the published host port", n.Name, cerr), "info")
			continue
		}
		body, _ := io.ReadAll(io.LimitReader(connResp.Body, 512))
		connResp.Body.Close()
		if connResp.StatusCode >= 400 {
			logFn(fmt.Sprintf("WARN: orchestrator could not join network %s (HTTP %d: %s) — health probe falls back to the published host port",
				n.Name, connResp.StatusCode, strings.TrimSpace(string(body))), "info")
			continue
		}
		logFn(fmt.Sprintf("Orchestrator joined network %s for the health probe", n.Name), "info")
	}

	// Start the orchestrator
	logFn("Starting orchestrator container...", "info")
	startReq, _ := http.NewRequest("POST",
		fmt.Sprintf("http://docker/" + dockerAPI() + "/containers/%s/start", created.ID), nil)
	startResp, err := client.Do(startReq)
	if err != nil {
		return fmt.Errorf("failed to start orchestrator: %w", err)
	}
	startResp.Body.Close()

	logFn("Orchestrator launched — this container will exit and the new image will start momentarily", "done")
	return nil
}

// shortID returns the first 12 chars of a container ID for compact logging.
func shortID(id string) string {
	if len(id) > 12 {
		return id[:12]
	}
	return id
}

// parseDockerImageRef splits a Docker image reference into (name, tag) for the
// Engine API's POST /images/create call, which takes the two as separate
// query params. Accepts three reference forms:
//
//   - "alpine@sha256:abc..."           → ("alpine", "sha256:abc...")
//   - "alpine:3.19"                    → ("alpine", "3.19")
//   - "alpine"                         → ("alpine", "latest")
//   - "ghcr.io/org/repo@sha256:abc..." → ("ghcr.io/org/repo", "sha256:abc...")
//   - "ghcr.io/org/repo:v1.2"          → ("ghcr.io/org/repo", "v1.2")
//
// Note: the digest form puts "sha256:..." in the tag slot. The Engine API's
// /images/create endpoint accepts a digest as the "tag" param and treats it
// as a content-addressed pull — the de-facto convention.
func parseDockerImageRef(ref string) (name, tag string) {
	if at := strings.Index(ref, "@"); at >= 0 {
		return ref[:at], ref[at+1:]
	}
	if colon := strings.LastIndex(ref, ":"); colon >= 0 {
		return ref[:colon], ref[colon+1:]
	}
	return ref, "latest"
}

// selectNewImageRef picks the image reference for the new container's
// containers/create call. Preference order:
//
//  1. <registry>@<digest> — content-addressed; preferred because pull-by-digest
//     never creates a named tag in the local image store, so the digest is the
//     only stable handle the registry path produces. Tarball-load preserves the
//     same digest, so this form resolves either way.
//  2. <registry>:<tag>    — fallback when the manifest omits Digest but has Tag.
//  3. boardripper:<ver>   — last-ditch local tag for malformed manifests.
//
// v0.19.2 shipped form 3 unconditionally; pull-by-digest then 404'd at
// containers/create and the orchestrator's `set -e` killed the rollback path.
// This helper is a drop-in capture of the corrected logic so it can be
// regression-tested in isolation.
func selectNewImageRef(m *Manifest) string {
	switch {
	case m.Image.Registry != "" && m.Image.Digest != "":
		return m.Image.Registry + "@" + m.Image.Digest
	case m.Image.Registry != "" && m.Image.Tag != "":
		return m.Image.Registry + ":" + m.Image.Tag
	default:
		return fmt.Sprintf("boardripper:%s", m.Version)
	}
}

// bindsFromMounts converts Docker mount objects to bind strings.
func bindsFromMounts(mounts []mount) []string {
	var binds []string
	for _, m := range mounts {
		b := m.Source + ":" + m.Destination
		if !m.RW {
			b += ":ro"
		}
		binds = append(binds, b)
	}
	return binds
}

// ─── Issue #21: preserve networks / labels / limits across the update swap ───

// isExclusiveNetMode reports whether a NetworkMode is one of the special modes
// that cannot be expressed via NetworkingConfig.EndpointsConfig and instead
// must be propagated verbatim as HostConfig.NetworkMode (and excludes any
// per-network connect calls). "host"/"none"/"container:<id>" are mutually
// exclusive with user-defined network attachments.
func isExclusiveNetMode(mode string) bool {
	return mode == "host" || mode == "none" || strings.HasPrefix(mode, "container:")
}

// Where the app's data dir is bind-mounted inside the orchestrator, and the
// file the orchestrator's console log is teed into. The orchestrator container
// auto-removes itself, so without this the only record of a failed swap is a
// console log that no longer exists by the time anyone looks.
const (
	orchLogMountPath = "/brlog"
	orchLogFileName  = "update-orchestrator.log"
)

// appListenPort reports the port the server listens on INSIDE the container,
// read from the container's own PORT env (main.go's default is 8080). The
// health probe used to hardcode 8080, which silently fails on any install that
// sets PORT.
func appListenPort(env []string) string {
	for _, e := range env {
		if v, ok := strings.CutPrefix(e, "PORT="); ok {
			v = strings.TrimSpace(v)
			if v != "" && isNumericPort(v) {
				return v
			}
		}
	}
	return "8080"
}

func isNumericPort(s string) bool {
	if len(s) == 0 || len(s) > 5 {
		return false
	}
	for _, c := range s {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

// publishedHostPort returns the host port the app's container port is published
// on, or "" when it isn't published in a way the orchestrator can reach. A
// binding on 127.0.0.1 counts as unreachable: the orchestrator probes the host
// via the default gateway (the docker0 address), which a loopback-only
// publication does not answer on.
func publishedHostPort(ports map[string][]portBinding, appPort string) string {
	for _, key := range []string{appPort + "/tcp", appPort} {
		for _, b := range ports[key] {
			if b.HostPort == "" {
				continue
			}
			if b.HostIP == "" || b.HostIP == "0.0.0.0" || b.HostIP == "::" {
				return b.HostPort
			}
		}
	}
	return ""
}

// orchestratorNetworks lists the networks the orchestrator must join to be able
// to reach the new container by IP. Docker DROPs traffic between two bridge
// networks, so an orchestrator left on the default bridge cannot health-check a
// container on a Compose network — which is every DSM Container Manager
// "project" install, and why those rolled back on every single update while a
// plain `docker run` install (default bridge, same network) updated fine.
//
// Exclusive modes (host/none/container:) have no joinable network; the gateway
// probe covers those instead.
func orchestratorNetworks(self *containerInfo) []containerNetwork {
	if isExclusiveNetMode(self.NetworkMode) {
		return nil
	}
	var out []containerNetwork
	for _, n := range self.Networks {
		// The orchestrator is already on the default bridge (it needs it to
		// reach the Alpine CDN for curl); re-connecting would 403.
		if n.Name == "bridge" {
			continue
		}
		out = append(out, n)
	}
	return out
}

// dataDirSource returns the host path backing the container's data directory,
// or "" if it has none (or it is read-only). The destination comes from the
// container's own DATA_DIR env — an install is free to mount it somewhere other
// than /data, and the orchestrator log should follow the data, not a constant.
func dataDirSource(mounts []mount, env []string) string {
	dest := "/data"
	for _, e := range env {
		if v, ok := strings.CutPrefix(e, "DATA_DIR="); ok && strings.HasPrefix(v, "/") {
			dest = strings.TrimRight(v, "/")
			if dest == "" {
				dest = "/data"
			}
		}
	}
	for _, m := range mounts {
		if m.Destination == dest && m.RW && m.Source != "" {
			return m.Source
		}
	}
	return ""
}

// filterStaleAliases drops the auto-injected short container-ID alias that
// Docker reports in a running container's NetworkSettings.Networks[].Aliases.
// Re-applying the OLD container's short ID to the new container (which has a
// different ID) is harmless but stale; user/compose aliases (the proxy's DNS
// name) must survive.
func filterStaleAliases(containerID string, aliases []string) []string {
	out := make([]string, 0, len(aliases))
	for _, a := range aliases {
		if len(a) >= 12 && strings.HasPrefix(containerID, a) {
			continue // the short-ID alias for this very container
		}
		out = append(out, a)
	}
	return out
}

// buildCreateBody assembles the POST /containers/create payload for the new
// container. Beyond the original Image/User/Env/Binds/Ports/Restart it now
// carries — issue #21 — the Compose labels, resource limits, and the primary
// network attachment (with aliases), so the recreated container is reachable
// on the same user-defined network(s) and stays owned by Docker Compose.
func buildCreateBody(self *containerInfo, newImage string) map[string]interface{} {
	hostConfig := map[string]interface{}{
		"Binds":         bindsFromMounts(self.Mounts),
		"PortBindings":  self.Ports,
		"RestartPolicy": map[string]string{"Name": self.Restart},
	}
	if self.Memory > 0 {
		hostConfig["Memory"] = self.Memory
	}
	if self.NanoCpus > 0 {
		hostConfig["NanoCpus"] = self.NanoCpus
	}

	body := map[string]interface{}{
		"Image":      newImage,
		"User":       self.User,
		"Env":        self.Env,
		"HostConfig": hostConfig,
	}
	if len(self.Labels) > 0 {
		body["Labels"] = self.Labels
	}

	// Exclusive network modes (host/none/container:) can't use EndpointsConfig;
	// pass them through HostConfig.NetworkMode and skip the per-network attach.
	if isExclusiveNetMode(self.NetworkMode) {
		hostConfig["NetworkMode"] = self.NetworkMode
		return body
	}

	// Docker's container-create reliably attaches only ONE network from
	// EndpointsConfig; the rest are reconnected post-create (networkConnectScript).
	// Attaching the primary here also suppresses the implicit default-bridge
	// attachment, so the new container's network set matches the old one's.
	if len(self.Networks) > 0 {
		primary := self.Networks[0]
		ep := map[string]interface{}{}
		if aliases := filterStaleAliases(self.ID, primary.Aliases); len(aliases) > 0 {
			ep["Aliases"] = aliases
		}
		body["NetworkingConfig"] = map[string]interface{}{
			"EndpointsConfig": map[string]interface{}{primary.Name: ep},
		}
	}
	return body
}

// networkConnectScript emits the shell lines (run by the orchestrator between
// container-create and container-start) that reattach every network BEYOND the
// primary one, since container-create only honors a single EndpointsConfig
// entry. Returns "" when there's nothing to do (≤1 network, or an exclusive
// network mode). The connect body references $NEW_ID (the just-created
// container) — the JSON fragments are produced here, not from user input.
func networkConnectScript(self *containerInfo) string {
	if isExclusiveNetMode(self.NetworkMode) || len(self.Networks) <= 1 {
		return ""
	}
	var b strings.Builder
	for _, n := range self.Networks[1:] {
		epJSON := "{}"
		if aliases := filterStaleAliases(self.ID, n.Aliases); len(aliases) > 0 {
			j, _ := json.Marshal(map[string]interface{}{"Aliases": aliases})
			epJSON = string(j)
		}
		// Quoting: single-quoted literals around a double-quoted "$NEW_ID" so the
		// shell expands the container id but nothing else. Network ID goes in the
		// URL path (hex, safe); aliases are DNS labels (no shell metacharacters).
		fmt.Fprintf(&b, `echo "[orchestrator] Reattaching to network %s..."
dapi -X POST -H "Content-Type: application/json" -d '{"Container":"'"$NEW_ID"'","EndpointConfig":%s}' "$API/networks/%s/connect" >/dev/null 2>&1 || echo "[orchestrator] WARN: could not reattach to network %s — reverse proxy on it may 502 until reconnected"
`, n.Name, epJSON, n.ID, n.Name)
	}
	return b.String()
}
