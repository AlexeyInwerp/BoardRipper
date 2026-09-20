package updater

// Docker-backed end-to-end tests for the self-update container swap.
//
// These drive orchestrateSwap against a REAL daemon, because the bug they
// cover is not expressible in a unit test: it lives in Docker's network
// topology, not in our Go. Measured on Docker 29.5.2 before the fix —
//
//	app on a user-defined bridge network, probe from a container on the
//	default bridge:  wget: download timed out
//	same probe from a container on the app's network:  {"status":"ok"}
//
// Docker DROPs traffic between two bridge networks (DOCKER-ISOLATION-STAGE-*),
// so the orchestrator — which was always created on the default bridge — could
// never health-check a container created by Compose. Every DSM Container
// Manager "project" install is a Compose install, so on those the probe
// timed out and the orchestrator rolled back to the old container on EVERY
// update. A plain `docker run` install shares the default bridge with the
// orchestrator, which is why our own NAS updated fine and the reports came
// only from users (DSM 7.4.1-90080, Container Manager, 2026-09-20).
//
// Opt-in: they need a Docker daemon and two locally-present BoardRipper
// images, neither of which CI has.
//
//	UPDATER_DOCKER_E2E=1 \
//	  BR_E2E_OLD_IMAGE=ghcr.io/alexeyinwerp/boardripper:v0.41.0 \
//	  BR_E2E_NEW_IMAGE=ghcr.io/alexeyinwerp/boardripper:v0.42.0 \
//	  go test ./updater/ -run TestOrchestratorSwap -v -timeout 10m

import (
	"encoding/json"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

const (
	e2eNetwork = "br-e2e-net"
	e2eName    = "br-e2e-app"
	e2eVolume  = "br-e2e-data"
)

func requireDockerE2E(t *testing.T) (oldImage, newImage string) {
	t.Helper()
	if os.Getenv("UPDATER_DOCKER_E2E") == "" {
		t.Skip("set UPDATER_DOCKER_E2E=1 (plus BR_E2E_OLD_IMAGE / BR_E2E_NEW_IMAGE) to run the Docker-backed swap tests")
	}
	oldImage = os.Getenv("BR_E2E_OLD_IMAGE")
	newImage = os.Getenv("BR_E2E_NEW_IMAGE")
	if oldImage == "" || newImage == "" {
		t.Fatal("BR_E2E_OLD_IMAGE and BR_E2E_NEW_IMAGE must name two locally-present BoardRipper images")
	}
	// Point the package's Engine-API client at whatever socket this machine's
	// daemon actually listens on (Colima and rootless setups are not at
	// /var/run/docker.sock). The orchestrator container still bind-mounts
	// /var/run/docker.sock, which is the path INSIDE the daemon's own host.
	if sock := resolveDockerSocket(t); sock != "" {
		prev := dockerSocket
		dockerSocket = sock
		t.Cleanup(func() { dockerSocket = prev })
	}
	if !isDockerAvailable() {
		t.Fatalf("docker socket %s is not usable", dockerSocket)
	}
	return oldImage, newImage
}

func resolveDockerSocket(t *testing.T) string {
	t.Helper()
	if s := os.Getenv("DOCKER_SOCKET"); s != "" {
		return s
	}
	if h := os.Getenv("DOCKER_HOST"); strings.HasPrefix(h, "unix://") {
		return strings.TrimPrefix(h, "unix://")
	}
	out, err := exec.Command("docker", "context", "inspect", "--format", "{{.Endpoints.docker.Host}}").Output()
	if err == nil {
		if h := strings.TrimSpace(string(out)); strings.HasPrefix(h, "unix://") {
			return strings.TrimPrefix(h, "unix://")
		}
	}
	return ""
}

func dockerCLI(t *testing.T, args ...string) string {
	t.Helper()
	out, err := exec.Command("docker", args...).CombinedOutput()
	if err != nil {
		t.Fatalf("docker %s: %v\n%s", strings.Join(args, " "), err, out)
	}
	return strings.TrimSpace(string(out))
}

func dockerCLIQuiet(args ...string) {
	_ = exec.Command("docker", args...).Run()
}

// startAppContainer runs the "currently installed" BoardRipper container the
// swap will replace, and returns it described the way findSelfContainer would.
func startAppContainer(t *testing.T, image string, runArgs ...string) *containerInfo {
	t.Helper()
	dockerCLIQuiet("rm", "-f", e2eName)
	dockerCLIQuiet("volume", "rm", "-f", e2eVolume)
	// A named volume, not a host temp dir: its Source is a path inside the
	// daemon's own filesystem, so the bind works the same on a Linux host and
	// in a Colima/Docker Desktop VM. It is also what lets the orchestrator tee
	// its console log somewhere that survives AutoRemove — the mechanism this
	// test doubles as coverage for.
	dockerCLI(t, "volume", "create", e2eVolume)
	args := append([]string{"run", "-d", "--name", e2eName, "--user", "0:0", "-v", e2eVolume + ":/data"}, runArgs...)
	args = append(args, image)
	dockerCLI(t, args...)
	t.Cleanup(func() {
		dockerCLIQuiet("rm", "-f", e2eName)
		dockerCLIQuiet("rm", "-f", e2eName+"-old")
		dockerCLIQuiet("rm", "-f", e2eName+"-failed")
		dockerCLIQuiet("rm", "-f", "boardripper-orchestrator")
		dockerCLIQuiet("volume", "rm", "-f", e2eVolume)
	})
	return inspectAsSelf(t, e2eName)
}

// inspectAsSelf builds a containerInfo from a live container, mirroring what
// findSelfContainer reads out of /containers/{id}/json.
func inspectAsSelf(t *testing.T, name string) *containerInfo {
	t.Helper()
	raw := dockerCLI(t, "inspect", name)
	var inspected []struct {
		ID     string `json:"Id"`
		Name   string `json:"Name"`
		Config struct {
			Image  string            `json:"Image"`
			Env    []string          `json:"Env"`
			User   string            `json:"User"`
			Labels map[string]string `json:"Labels"`
		} `json:"Config"`
		HostConfig struct {
			PortBindings  map[string][]portBinding `json:"PortBindings"`
			RestartPolicy struct {
				Name string `json:"Name"`
			} `json:"RestartPolicy"`
			NetworkMode string `json:"NetworkMode"`
		} `json:"HostConfig"`
		Mounts          []mount `json:"Mounts"`
		NetworkSettings struct {
			Networks map[string]struct {
				NetworkID string `json:"NetworkID"`
			} `json:"Networks"`
		} `json:"NetworkSettings"`
	}
	if err := json.Unmarshal([]byte(raw), &inspected); err != nil || len(inspected) != 1 {
		t.Fatalf("inspect %s: %v", name, err)
	}
	in := inspected[0]
	var nets []containerNetwork
	for n, v := range in.NetworkSettings.Networks {
		nets = append(nets, containerNetwork{Name: n, ID: v.NetworkID})
	}
	return &containerInfo{
		ID:          in.ID,
		Name:        strings.TrimPrefix(in.Name, "/"),
		Image:       in.Config.Image,
		Env:         in.Config.Env,
		User:        in.Config.User,
		Mounts:      in.Mounts,
		Ports:       in.HostConfig.PortBindings,
		Restart:     in.HostConfig.RestartPolicy.Name,
		Labels:      in.Config.Labels,
		Networks:    nets,
		NetworkMode: in.HostConfig.NetworkMode,
	}
}

// captureOrchestratorLogs follows the orchestrator container's console from as
// early as possible. It auto-removes on exit, so this is the only way to see a
// failure that happens before the tee'd log file is opened (a shell syntax
// error in the generated script, say).
func captureOrchestratorLogs(t *testing.T) func() string {
	t.Helper()
	var buf strings.Builder
	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := 0; i < 50; i++ {
			out, _ := exec.Command("docker", "logs", "-f", "boardripper-orchestrator").CombinedOutput()
			if len(out) > 0 {
				buf.Write(out)
				return
			}
			time.Sleep(200 * time.Millisecond)
		}
	}()
	return func() string {
		select {
		case <-done:
		case <-time.After(5 * time.Second):
		}
		return buf.String()
	}
}

// awaitSwap waits for the orchestrator to finish and reports the image the
// container named e2eName is running on. A rollback restores the OLD image
// under the same name, so the image reference is the whole verdict.
func awaitSwap(t *testing.T, deadline time.Duration) (image string, oldLeftBehind bool) {
	t.Helper()
	stop := time.Now().Add(deadline)
	for time.Now().Before(stop) {
		if exec.Command("docker", "inspect", "boardripper-orchestrator").Run() != nil {
			// Orchestrator is gone (AutoRemove) — the swap has concluded.
			break
		}
		time.Sleep(2 * time.Second)
	}
	out, err := exec.Command("docker", "inspect", "--format", "{{.Config.Image}}", e2eName).Output()
	if err != nil {
		t.Fatalf("container %s missing after swap: %v", e2eName, err)
	}
	oldLeftBehind = exec.Command("docker", "inspect", e2eName+"-old").Run() == nil
	return strings.TrimSpace(string(out)), oldLeftBehind
}

func swapManifest(newImage string) *Manifest {
	registry, tag := parseDockerImageRef(newImage)
	return &Manifest{
		Version:           "0.0.0-e2e",
		Image:             ManifestImage{Registry: registry, Tag: tag},
		OrchestratorImage: "alpine:latest",
	}
}

// dumpOrchestratorLog prints both halves of the record: the Go-side progress
// entries, and the orchestrator's own console output, which it tees into the
// app's data volume precisely because the container auto-removes itself.
func dumpOrchestratorLog(t *testing.T, u *Updater, console func() string) {
	t.Helper()
	for _, p := range u.progress {
		t.Logf("[updater] %s", p.Message)
	}
	if console != nil {
		if c := console(); c != "" {
			t.Logf("orchestrator console:\n%s", c)
		}
	}
	out, err := exec.Command("docker", "run", "--rm", "-v", e2eVolume+":/d", "alpine",
		"cat", "/d/"+orchLogFileName).CombinedOutput()
	if err != nil {
		t.Logf("orchestrator log unavailable: %v", err)
		return
	}
	t.Logf("orchestrator log:\n%s", out)
}

// TestOrchestratorSwap_ComposeNetworkNoPublishedPort is the reported failure in
// its purest form: the app sits on a user-defined (Compose) network and
// publishes nothing the orchestrator could reach from the default bridge. The
// only way the health probe can succeed is the orchestrator joining that
// network — which is what the fix added.
func TestOrchestratorSwap_ComposeNetworkNoPublishedPort(t *testing.T) {
	oldImage, newImage := requireDockerE2E(t)

	dockerCLIQuiet("network", "rm", e2eNetwork)
	dockerCLI(t, "network", "create", e2eNetwork)
	t.Cleanup(func() { dockerCLIQuiet("network", "rm", e2eNetwork) })

	self := startAppContainer(t, oldImage, "--network", e2eNetwork)
	if self.NetworkMode != e2eNetwork {
		t.Fatalf("precondition: expected network mode %q, got %q", e2eNetwork, self.NetworkMode)
	}

	u := New(t.TempDir())
	if err := u.orchestrateSwap(self, swapManifest(newImage)); err != nil {
		t.Fatalf("orchestrateSwap: %v", err)
	}
	console := captureOrchestratorLogs(t)
	image, oldLeft := awaitSwap(t, 3*time.Minute)
	dumpOrchestratorLog(t, u, console)

	if image != newImage {
		t.Fatalf("container is running %q, want %q — the health probe failed and the orchestrator rolled back", image, newImage)
	}
	if oldLeft {
		t.Errorf("%s-old survived the swap — the orchestrator did not reach its cleanup step", e2eName)
	}
}

// TestOrchestratorSwap_HostNetwork covers the other topology with no reachable
// container IP: --network host, where NetworkSettings carries no address at all
// and there is no network to join. The probe has to find the app on the host
// gateway instead.
func TestOrchestratorSwap_HostNetwork(t *testing.T) {
	oldImage, newImage := requireDockerE2E(t)

	self := startAppContainer(t, oldImage, "--network", "host", "-e", "PORT=18097")
	if self.NetworkMode != "host" {
		t.Fatalf("precondition: expected host network mode, got %q", self.NetworkMode)
	}
	if got := appListenPort(self.Env); got != "18097" {
		t.Fatalf("appListenPort read %q from the container env, want 18097", got)
	}

	u := New(t.TempDir())
	if err := u.orchestrateSwap(self, swapManifest(newImage)); err != nil {
		t.Fatalf("orchestrateSwap: %v", err)
	}
	console := captureOrchestratorLogs(t)
	image, oldLeft := awaitSwap(t, 3*time.Minute)
	dumpOrchestratorLog(t, u, console)

	if image != newImage {
		t.Fatalf("container is running %q, want %q — the health probe failed and the orchestrator rolled back", image, newImage)
	}
	if oldLeft {
		t.Errorf("%s-old survived the swap", e2eName)
	}
}

// TestOrchestratorSwap_RollsBackOnDeadImage is the other half of the contract:
// the probe must still FAIL when the new image genuinely cannot serve, and the
// old container must come back. Without this, "make the probe pass" could be
// satisfied by never probing at all.
func TestOrchestratorSwap_RollsBackOnDeadImage(t *testing.T) {
	oldImage, _ := requireDockerE2E(t)

	dockerCLIQuiet("network", "rm", e2eNetwork)
	dockerCLI(t, "network", "create", e2eNetwork)
	t.Cleanup(func() { dockerCLIQuiet("network", "rm", e2eNetwork) })

	self := startAppContainer(t, oldImage, "--network", e2eNetwork)

	u := New(t.TempDir())
	// alpine exits immediately: a container that starts and serves nothing.
	if err := u.orchestrateSwap(self, swapManifest("alpine:latest")); err != nil {
		t.Fatalf("orchestrateSwap: %v", err)
	}
	console := captureOrchestratorLogs(t)
	// Budget: the probe itself is 120s, plus container stop/start either side.
	image, oldLeft := awaitSwap(t, 6*time.Minute)
	dumpOrchestratorLog(t, u, console)

	if image != oldImage {
		t.Fatalf("after a failed health check the container runs %q, want the old image %q", image, oldImage)
	}
	if oldLeft {
		t.Errorf("%s-old should have been renamed back, not left in place", e2eName)
	}
	// The container that failed is kept, not deleted: on an install nobody can
	// reach, its logs are the only answer to "why did the update not take".
	if exec.Command("docker", "inspect", e2eName+"-failed").Run() != nil {
		t.Errorf("%s-failed is gone — a rollback left no evidence behind", e2eName)
	}
}
