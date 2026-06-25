package updater

import (
	"reflect"
	"strings"
	"testing"
)

// ─── filterStaleAliases ──────────────────────────────────────────────────────
//
// A running container's NetworkSettings.Networks[].Aliases includes Docker's
// auto-injected short container ID alongside user/compose aliases. Re-applying
// the old short ID to the NEW container (which has a different ID) is harmless
// but stale, so we drop it. Real aliases (compose service name, user --alias)
// must survive — they're how a reverse proxy resolves the container by name.

func TestFilterStaleAliases_DropsShortContainerID(t *testing.T) {
	id := "abc123def4567890fedcba9876543210" // full 64-ish hex id
	got := filterStaleAliases(id, []string{"boardripper", "abc123def456"})
	want := []string{"boardripper"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("filterStaleAliases dropped wrong entries: got %v, want %v", got, want)
	}
}

func TestFilterStaleAliases_KeepsRealAliases(t *testing.T) {
	id := "ffffffffffffffffffffffffffffffff"
	got := filterStaleAliases(id, []string{"proxy-svc", "db"})
	want := []string{"proxy-svc", "db"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("filterStaleAliases mangled real aliases: got %v, want %v", got, want)
	}
}

// ─── buildCreateBody ─────────────────────────────────────────────────────────
//
// Regression net for issue #21: the in-app self-update recreated the container
// with no NetworkingConfig, no Labels, and no resource limits — so it landed on
// the default bridge only (reverse proxy → 502), Compose disowned it (labels
// gone), and mem_limit was dropped. The create body must carry all three.

func sampleSelf() *containerInfo {
	return &containerInfo{
		ID:      "deadbeefcafe0000111122223333444455556666",
		Name:    "boardripper",
		Image:   "ghcr.io/alexeyinwerp/boardripper:old",
		User:    "0:0",
		Env:     []string{"PORT=8080"},
		Mounts:  []mount{{Source: "/srv/data", Destination: "/data", RW: true}},
		Ports:   map[string][]portBinding{"8080/tcp": {{HostIP: "", HostPort: "8081"}}},
		Restart: "unless-stopped",
		Labels: map[string]string{
			"com.docker.compose.project": "br",
			"com.docker.compose.service": "boardripper",
		},
		Networks: []containerNetwork{
			{Name: "proxy", ID: "net1id", Aliases: []string{"boardripper"}},
		},
		Memory:   536870912,
		NanoCpus: 1500000000,
	}
}

func TestBuildCreateBody_PreservesNetworkLabelsAndLimits(t *testing.T) {
	self := sampleSelf()
	body := buildCreateBody(self, "ghcr.io/alexeyinwerp/boardripper@sha256:abc")

	if body["Image"] != "ghcr.io/alexeyinwerp/boardripper@sha256:abc" {
		t.Fatalf("Image not set to new ref: %v", body["Image"])
	}
	if body["User"] != "0:0" {
		t.Fatalf("User not preserved: %v", body["User"])
	}

	// Labels (Compose ownership) preserved verbatim.
	if !reflect.DeepEqual(body["Labels"], self.Labels) {
		t.Fatalf("Labels not preserved: got %v", body["Labels"])
	}

	hc, ok := body["HostConfig"].(map[string]interface{})
	if !ok {
		t.Fatalf("HostConfig missing or wrong type")
	}
	if hc["Memory"] != int64(536870912) {
		t.Fatalf("Memory limit not preserved: %v", hc["Memory"])
	}
	if hc["NanoCpus"] != int64(1500000000) {
		t.Fatalf("NanoCpus limit not preserved: %v", hc["NanoCpus"])
	}
	// Existing HostConfig fields still present.
	if hc["Binds"] == nil || hc["PortBindings"] == nil || hc["RestartPolicy"] == nil {
		t.Fatalf("existing HostConfig fields lost: %#v", hc)
	}

	// Primary network attached at create with its (filtered) aliases.
	nc, ok := body["NetworkingConfig"].(map[string]interface{})
	if !ok {
		t.Fatalf("NetworkingConfig missing")
	}
	ep, ok := nc["EndpointsConfig"].(map[string]interface{})
	if !ok {
		t.Fatalf("EndpointsConfig missing")
	}
	proxy, ok := ep["proxy"].(map[string]interface{})
	if !ok {
		t.Fatalf("primary network 'proxy' not in EndpointsConfig: %#v", ep)
	}
	if !reflect.DeepEqual(proxy["Aliases"], []string{"boardripper"}) {
		t.Fatalf("primary network aliases not preserved: %v", proxy["Aliases"])
	}
}

func TestBuildCreateBody_OmitsAbsentExtras(t *testing.T) {
	// A plain `docker run` deploy (the NAS install): default bridge only,
	// no compose labels, no explicit limits. We must NOT inject empty
	// Labels/NetworkingConfig or zero limits that could change behavior.
	self := &containerInfo{
		Image:    "boardripper:old",
		Restart:  "no",
		Networks: []containerNetwork{{Name: "bridge", ID: "br0", Aliases: nil}},
	}
	body := buildCreateBody(self, "boardripper:new")

	if _, present := body["Labels"]; present {
		t.Fatalf("Labels should be omitted when none exist")
	}
	hc := body["HostConfig"].(map[string]interface{})
	if _, present := hc["Memory"]; present {
		t.Fatalf("Memory should be omitted when zero")
	}
	if _, present := hc["NanoCpus"]; present {
		t.Fatalf("NanoCpus should be omitted when zero")
	}
	// bridge is still attached so the new container has the same single network.
	nc := body["NetworkingConfig"].(map[string]interface{})
	ep := nc["EndpointsConfig"].(map[string]interface{})
	if _, ok := ep["bridge"]; !ok {
		t.Fatalf("bridge network not attached: %#v", ep)
	}
}

func TestBuildCreateBody_HostNetworkModeSkipsEndpoints(t *testing.T) {
	self := &containerInfo{
		Image:       "boardripper:old",
		Restart:     "always",
		NetworkMode: "host",
		Networks:    []containerNetwork{{Name: "host", ID: ""}},
	}
	body := buildCreateBody(self, "boardripper:new")
	if _, present := body["NetworkingConfig"]; present {
		t.Fatalf("host mode must not use NetworkingConfig/EndpointsConfig")
	}
	hc := body["HostConfig"].(map[string]interface{})
	if hc["NetworkMode"] != "host" {
		t.Fatalf("host NetworkMode not propagated: %v", hc["NetworkMode"])
	}
}

// ─── networkConnectScript ────────────────────────────────────────────────────
//
// Docker's container-create only honors one network in EndpointsConfig, so any
// SECOND+ network the container had must be reattached via POST
// /networks/{id}/connect after create and before start. The primary (index 0)
// is already attached at create and must NOT be reconnected here.

func TestNetworkConnectScript_ConnectsAdditionalNetworks(t *testing.T) {
	self := &containerInfo{
		Networks: []containerNetwork{
			{Name: "proxy", ID: "net1id", Aliases: []string{"boardripper"}},
			{Name: "backend", ID: "net2id", Aliases: []string{"api"}},
		},
	}
	script := networkConnectScript(self)

	if !strings.Contains(script, "/networks/net2id/connect") {
		t.Fatalf("secondary network not connected:\n%s", script)
	}
	if strings.Contains(script, "/networks/net1id/connect") {
		t.Fatalf("primary network must not be reconnected (already attached at create):\n%s", script)
	}
	if !strings.Contains(script, "$NEW_ID") {
		t.Fatalf("connect body must reference the new container id:\n%s", script)
	}
	if !strings.Contains(script, `"api"`) {
		t.Fatalf("secondary network aliases not carried into connect body:\n%s", script)
	}
}

func TestNetworkConnectScript_EmptyForSingleOrZero(t *testing.T) {
	if s := networkConnectScript(&containerInfo{Networks: []containerNetwork{{Name: "proxy", ID: "n1"}}}); s != "" {
		t.Fatalf("single network needs no connect script, got:\n%s", s)
	}
	if s := networkConnectScript(&containerInfo{}); s != "" {
		t.Fatalf("zero networks needs no connect script, got:\n%s", s)
	}
}

func TestNetworkConnectScript_EmptyForHostMode(t *testing.T) {
	self := &containerInfo{
		NetworkMode: "host",
		Networks:    []containerNetwork{{Name: "host"}},
	}
	if s := networkConnectScript(self); s != "" {
		t.Fatalf("host mode needs no connect script, got:\n%s", s)
	}
}
