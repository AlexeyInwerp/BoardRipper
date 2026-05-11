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
	"strings"
	"sync"
	"time"
)

const dockerSocket = "/var/run/docker.sock"

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
	io.Copy(io.Discard, resp.Body) // drain response

	if resp.StatusCode != 200 {
		return fmt.Errorf("docker image load returned %d", resp.StatusCode)
	}
	return nil
}

// containerInfo holds the subset of Docker container inspect data we need.
type containerInfo struct {
	ID      string
	Name    string
	Image   string
	Env     []string
	Mounts  []mount
	Ports   map[string][]portBinding
	Restart string
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
			Image string   `json:"Image"`
			Env   []string `json:"Env"`
		} `json:"Config"`
		HostConfig struct {
			Binds       []string                       `json:"Binds"`
			PortBindings map[string][]portBinding       `json:"PortBindings"`
			RestartPolicy struct {
				Name string `json:"Name"`
			} `json:"RestartPolicy"`
		} `json:"HostConfig"`
		Mounts []mount `json:"Mounts"`
	}
	if err := json.NewDecoder(resp2.Body).Decode(&inspect); err != nil {
		return nil, fmt.Errorf("failed to parse container inspect: %w", err)
	}

	return &containerInfo{
		ID:      inspect.ID,
		Name:    strings.TrimPrefix(inspect.Name, "/"),
		Image:   inspect.Config.Image,
		Env:     inspect.Config.Env,
		Mounts:  inspect.Mounts,
		Ports:   inspect.HostConfig.PortBindings,
		Restart: inspect.HostConfig.RestartPolicy.Name,
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

	logFn(fmt.Sprintf("Self container: name=%s id=%s image=%s restart=%s", self.Name, shortID(self.ID), self.Image, self.Restart), "info")
	logFn(fmt.Sprintf("Mounts: %d, env vars: %d, port bindings: %d", len(self.Mounts), len(self.Env), len(self.Ports)), "info")

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

	// Build the create body for the new container
	createBody := map[string]interface{}{
		"Image": newImage,
		"Env":   self.Env,
		"HostConfig": map[string]interface{}{
			"Binds":         bindsFromMounts(self.Mounts),
			"PortBindings":  self.Ports,
			"RestartPolicy": map[string]string{"Name": self.Restart},
		},
	}
	bodyJSON, _ := json.Marshal(createBody)

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
	script := fmt.Sprintf(`#!/bin/sh
set -e
SOCK="/var/run/docker.sock"
API="http://localhost/%s"

# Helper: Docker API via curl
dapi() { curl -sf --unix-socket "$SOCK" "$@"; }

echo "[orchestrator] Stopping $BR_NAME..."
dapi -X POST "$API/containers/$BR_ID/stop?t=10" >/dev/null 2>&1 || true
sleep 2

echo "[orchestrator] Removing old -old container if exists..."
dapi -X DELETE "$API/containers/$BR_NAME-old?force=true" >/dev/null 2>&1 || true

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

echo "[orchestrator] Starting new container $NEW_ID..."
START_CODE=$(dapi -o /dev/null -w "%%{http_code}" -X POST "$API/containers/$NEW_ID/start")
if [ "$START_CODE" != "204" ] && [ "$START_CODE" != "304" ]; then
  echo "[orchestrator] FAIL: start returned $START_CODE — rolling back"
  dapi -X DELETE "$API/containers/$NEW_ID?force=true" >/dev/null 2>&1 || true
  dapi -X POST "$API/containers/$BR_ID/rename?name=$BR_NAME" >/dev/null 2>&1 || true
  dapi -X POST "$API/containers/$BR_ID/start" >/dev/null 2>&1 || true
  exit 1
fi

echo "[orchestrator] Resolving new container IP for healthcheck..."
NEW_IP=""
ipattempts=0
while [ -z "$NEW_IP" ] && [ $ipattempts -lt 10 ]; do
  # Pick the first non-empty IPAddress field — covers both the default bridge
  # (.NetworkSettings.IPAddress) and user-defined networks
  # (.NetworkSettings.Networks.<name>.IPAddress).
  NEW_IP=$(dapi "$API/containers/$NEW_ID/json" 2>/dev/null \
    | sed -n 's/.*"IPAddress":"\([^"]*\)".*/\1/p' | grep -v '^$' | head -1)
  [ -z "$NEW_IP" ] && sleep 1
  ipattempts=$((ipattempts + 1))
done
if [ -z "$NEW_IP" ]; then
  echo "[orchestrator] WARN: could not resolve new container IP after 10s — falling back to name lookup (only works on user-defined networks)"
  NEW_IP="$BR_NAME"
fi
echo "[orchestrator] Polling http://$NEW_IP:8080/api/health (60s timeout)..."
i=0
ok=0
while [ $i -lt 30 ]; do
  # wget is available in busybox/alpine; using IP avoids needing the container
  # name to resolve on the default bridge network (DNS by name is only
  # automatic on user-defined networks).
  if wget -q -O - --timeout=2 "http://$NEW_IP:8080/api/health" 2>/dev/null | grep -q '"status":"ok"'; then
    ok=1
    break
  fi
  sleep 2
  i=$((i + 1))
done

if [ "$ok" = "1" ]; then
  echo "[orchestrator] Health check passed — removing old container."
  dapi -X DELETE "$API/containers/$BR_NAME-old?force=true" >/dev/null 2>&1 || true
  echo "[orchestrator] Done."
  exit 0
fi

echo "[orchestrator] WARN: health check failed after 60s — rolling back to previous container."
dapi -X POST "$API/containers/$NEW_ID/stop?t=5" >/dev/null 2>&1 || true
dapi -X DELETE "$API/containers/$NEW_ID?force=true" >/dev/null 2>&1 || true
dapi -X POST "$API/containers/$BR_ID/rename?name=$BR_NAME" >/dev/null 2>&1 || true
dapi -X POST "$API/containers/$BR_ID/start" >/dev/null 2>&1 || true
echo "[orchestrator] Rollback complete — previous container restarted."
exit 1
`,
		dockerAPI(),       // API= path version
		newImage,          // create-log line: human-readable image reference
		string(bodyJSON),  // CREATE_BODY heredoc (JSON produced by this binary, not user-derived)
	)

	client := dockerClient()

	// Create the orchestrator container using the pinned orchestrator image (with curl).
	// $BR_NAME and $BR_ID feed the script via Env, not via shell-interpolation
	// of self.Name / self.ID into the script body. See H5 in the secure-update-
	// pipeline audit: any future widening of Docker's container-name charset
	// (or a malicious image relabeling its container) would otherwise become a
	// shell-injection vector inside a Docker-socket-privileged container.
	orchBody := map[string]interface{}{
		"Image": orchImage,
		"Cmd":   []string{"sh", "-c", "apk add --no-cache curl >/dev/null 2>&1 && " + script},
		"Env": []string{
			"BR_NAME=" + self.Name,
			"BR_ID=" + self.ID,
		},
		"HostConfig": map[string]interface{}{
			"Binds":     []string{"/var/run/docker.sock:/var/run/docker.sock"},
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
