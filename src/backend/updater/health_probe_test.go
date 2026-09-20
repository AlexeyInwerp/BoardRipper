package updater

import (
	"strings"
	"testing"
)

// ─── appListenPort ───────────────────────────────────────────────────────────
//
// The health probe hardcoded :8080 for four releases. docker-compose.yml
// documents PORT as "no need to change", but nothing stops an install from
// changing it — and a probe on the wrong port fails exactly like an unhealthy
// container: a full probe budget of timeouts, then a rollback to the previous
// image.

func TestAppListenPort_DefaultsTo8080(t *testing.T) {
	if got := appListenPort([]string{"DATA_DIR=/data", "PATH=/usr/bin"}); got != "8080" {
		t.Fatalf("no PORT in env: got %q, want 8080", got)
	}
}

func TestAppListenPort_ReadsPortEnv(t *testing.T) {
	if got := appListenPort([]string{"DATA_DIR=/data", "PORT=9000"}); got != "9000" {
		t.Fatalf("got %q, want 9000", got)
	}
}

func TestAppListenPort_IgnoresNonNumericAndLookalikes(t *testing.T) {
	// PDFINDEX_POOL_MAX and friends must not be mistaken for PORT, and a
	// garbage value falls back rather than building a broken URL.
	env := []string{"PDFINDEX_POOL_MAX=2", "EXPORT=1", "PORT=notaport"}
	if got := appListenPort(env); got != "8080" {
		t.Fatalf("got %q, want the 8080 fallback", got)
	}
}

// ─── publishedHostPort ───────────────────────────────────────────────────────

func TestPublishedHostPort_TCPBinding(t *testing.T) {
	ports := map[string][]portBinding{"8080/tcp": {{HostIP: "", HostPort: "8081"}}}
	if got := publishedHostPort(ports, "8080"); got != "8081" {
		t.Fatalf("got %q, want 8081", got)
	}
}

func TestPublishedHostPort_LoopbackOnlyIsUnreachable(t *testing.T) {
	// The orchestrator probes the host through the default gateway (the docker0
	// address). A publication bound to 127.0.0.1 does not answer there, so
	// reporting it would make the probe spend its whole budget on an endpoint
	// that can never respond.
	ports := map[string][]portBinding{"8080/tcp": {{HostIP: "127.0.0.1", HostPort: "8081"}}}
	if got := publishedHostPort(ports, "8080"); got != "" {
		t.Fatalf("loopback binding: got %q, want \"\"", got)
	}
}

func TestPublishedHostPort_PrefersRoutableBinding(t *testing.T) {
	ports := map[string][]portBinding{"8080/tcp": {
		{HostIP: "127.0.0.1", HostPort: "8081"},
		{HostIP: "0.0.0.0", HostPort: "8082"},
	}}
	if got := publishedHostPort(ports, "8080"); got != "8082" {
		t.Fatalf("got %q, want 8082", got)
	}
}

func TestPublishedHostPort_UnpublishedPort(t *testing.T) {
	ports := map[string][]portBinding{"9999/tcp": {{HostPort: "9999"}}}
	if got := publishedHostPort(ports, "8080"); got != "" {
		t.Fatalf("got %q, want \"\" — 8080 is not published", got)
	}
}

// ─── orchestratorNetworks ────────────────────────────────────────────────────
//
// The reported bug (DSM 7.4.1 + Container Manager, 2026-09-20): Docker DROPs
// traffic between two bridge networks, so an orchestrator sitting on the
// default bridge cannot health-check a container on a Compose network. Every
// Container Manager "project" is a Compose install, so those rolled back on
// every update while `docker run` installs — same network as the orchestrator —
// updated fine.

func TestOrchestratorNetworks_JoinsComposeNetwork(t *testing.T) {
	self := &containerInfo{
		NetworkMode: "boardripper_default",
		Networks:    []containerNetwork{{Name: "boardripper_default", ID: "netid1"}},
	}
	got := orchestratorNetworks(self)
	if len(got) != 1 || got[0].Name != "boardripper_default" {
		t.Fatalf("got %+v, want the Compose network", got)
	}
}

func TestOrchestratorNetworks_SkipsDefaultBridge(t *testing.T) {
	// The orchestrator is already on the default bridge — it needs the egress
	// for `apk add curl` — and re-connecting returns 403.
	self := &containerInfo{
		NetworkMode: "bridge",
		Networks:    []containerNetwork{{Name: "bridge", ID: "netid0"}},
	}
	if got := orchestratorNetworks(self); len(got) != 0 {
		t.Fatalf("got %+v, want nothing to join", got)
	}
}

func TestOrchestratorNetworks_ExclusiveModesHaveNothingToJoin(t *testing.T) {
	for _, mode := range []string{"host", "none", "container:abc"} {
		self := &containerInfo{NetworkMode: mode, Networks: []containerNetwork{{Name: "x", ID: "y"}}}
		if got := orchestratorNetworks(self); len(got) != 0 {
			t.Fatalf("%s: got %+v, want nothing (the gateway probe covers these)", mode, got)
		}
	}
}

func TestOrchestratorNetworks_MultipleNetworks(t *testing.T) {
	self := &containerInfo{
		NetworkMode: "boardripper_default",
		Networks: []containerNetwork{
			{Name: "boardripper_default", ID: "n1"},
			{Name: "bridge", ID: "n0"},
			{Name: "proxy-net", ID: "n2"},
		},
	}
	got := orchestratorNetworks(self)
	if len(got) != 2 {
		t.Fatalf("got %d networks, want 2 (bridge excluded)", len(got))
	}
}

// ─── dataDirSource ───────────────────────────────────────────────────────────

func TestDataDirSource_FindsWritableDataMount(t *testing.T) {
	mounts := []mount{
		{Source: "/volume1/docker/boardripper/library", Destination: "/library", RW: false},
		{Source: "/volume1/docker/boardripper/data", Destination: "/data", RW: true},
	}
	if got := dataDirSource(mounts, nil); got != "/volume1/docker/boardripper/data" {
		t.Fatalf("got %q", got)
	}
}

func TestDataDirSource_FollowsDataDirEnv(t *testing.T) {
	mounts := []mount{
		{Source: "/volume1/br/data", Destination: "/data", RW: true},
		{Source: "/volume2/br/state", Destination: "/state", RW: true},
	}
	if got := dataDirSource(mounts, []string{"DATA_DIR=/state"}); got != "/volume2/br/state" {
		t.Fatalf("got %q, want the DATA_DIR mount", got)
	}
}

func TestDataDirSource_SkipsReadOnlyAndMissing(t *testing.T) {
	if got := dataDirSource([]mount{{Source: "/x", Destination: "/data", RW: false}}, nil); got != "" {
		t.Fatalf("read-only /data: got %q, want \"\"", got)
	}
	if got := dataDirSource(nil, nil); got != "" {
		t.Fatalf("no mounts: got %q, want \"\"", got)
	}
}

// ─── generated script ────────────────────────────────────────────────────────

// The probe must try every candidate endpoint each round, not pick one: no
// single one is reachable in every topology (see orchestratorNetworks).
func TestOrchestratorScript_ProbesAllCandidates(t *testing.T) {
	self := &containerInfo{
		ID: "abc123", Name: "boardripper",
		Env:         []string{"PORT=8080"},
		NetworkMode: "boardripper_default",
		Networks:    []containerNetwork{{Name: "boardripper_default", ID: "n1"}},
	}
	script := buildSwapScript(self, "ghcr.io/x/y@sha256:deadbeef")

	for _, want := range []string{
		`http://$NEW_IP:$BR_PORT/api/health`,  // shared network
		`http://$GW:$BR_HOSTPORT/api/health`,  // published host port
		`http://$GW:$BR_PORT/api/health`,      // host-network install
		`http://$BR_NAME:$BR_PORT/api/health`, // DNS on a joined user network
		`for u in $URLS; do`,                  // every candidate, every round
	} {
		if !strings.Contains(script, want) {
			t.Errorf("generated script is missing %q", want)
		}
	}
	if strings.Contains(script, ":8080/api/health") {
		t.Error("generated script still hardcodes port 8080 in a probe URL")
	}
	// A stray %% verb in a 200-line shell template renders as %!s(MISSING) and
	// would only surface as a runtime shell error on a user's NAS.
	if strings.Contains(script, "%!") {
		t.Errorf("generated script has a formatting error:\n%s", script)
	}
}
