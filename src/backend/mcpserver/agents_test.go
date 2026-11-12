package mcpserver

import (
	"context"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// connect runs an in-memory client against s with sc attached to the
// server-side context, the way GateAuto attaches it for HTTP.
func connect(t *testing.T, s *Server, sc Scope, clientName string) *mcp.ClientSession {
	t.Helper()
	ctx := withScope(context.Background(), sc)
	ct, st := mcp.NewInMemoryTransports()
	ss, err := s.mcp.Connect(ctx, st, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ss.Close() })
	c := mcp.NewClient(&mcp.Implementation{Name: clientName, Title: "Test " + clientName, Version: "9"}, nil)
	cs, err := c.Connect(context.Background(), ct, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cs.Close() })
	return cs
}

func TestToolGroupsCoverEveryTool(t *testing.T) {
	s := New(&Deps{State: NewState(nil), Bridge: NewBridge(), Agents: LoadAgents("")})
	cs := connect(t, s, Scope{}, "cover")
	lt, err := cs.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, tool := range lt.Tools {
		if _, ok := toolGroup[tool.Name]; !ok {
			t.Errorf("tool %q has no group in groups.go", tool.Name)
		}
		a := tool.Annotations
		if a == nil {
			t.Errorf("tool %q has no annotations", tool.Name)
			continue
		}
		if mutatingTools[tool.Name] == a.ReadOnlyHint {
			t.Errorf("tool %q: mutatingTools=%v but readOnlyHint=%v", tool.Name, mutatingTools[tool.Name], a.ReadOnlyHint)
		}
		if a.OpenWorldHint == nil || *a.OpenWorldHint {
			t.Errorf("tool %q: openWorldHint must be false", tool.Name)
		}
		if !a.ReadOnlyHint && (a.DestructiveHint == nil || *a.DestructiveHint) {
			t.Errorf("tool %q: destructiveHint must be false", tool.Name)
		}
	}
}

func TestToolFilterAndAgentRecord(t *testing.T) {
	ar := LoadAgents("")
	s := New(&Deps{State: NewState(nil), Bridge: NewBridge(), Agents: ar})
	sc := Scope{ClientID: "browser-abc12345", Kind: "browser", Groups: map[string]bool{"board": true}, ReadOnly: true}
	cs := connect(t, s, sc, "cursor")
	lt, err := cs.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, tool := range lt.Tools {
		if toolGroup[tool.Name] != "board" {
			t.Errorf("tool %q leaked through ?tools=board", tool.Name)
		}
	}
	if _, err := cs.CallTool(context.Background(), &mcp.CallToolParams{Name: "highlight_net", Arguments: map[string]any{"net": "GND"}}); err == nil {
		t.Error("highlight_net should be refused outside the connection's groups")
	}
	agents := ar.List()
	if len(agents) != 1 || agents[0].Name != "Test cursor" || agents[0].Credential != "browser" || agents[0].BrowserID != "browser-abc12345" {
		t.Fatalf("agent record = %+v", agents)
	}
}

func TestBlockedAgentAndDriveOverride(t *testing.T) {
	ar := LoadAgents("")
	s := New(&Deps{State: NewState(nil), Bridge: NewBridge(), Agents: ar})
	cs := connect(t, s, Scope{Kind: "shared"}, "codex")
	if _, err := cs.CallTool(context.Background(), &mcp.CallToolParams{Name: "ping"}); err != nil {
		t.Fatal(err)
	}
	key := ar.List()[0].Key

	// Global drive is off (nil config); the agent's own override turns it on.
	on := "on"
	if err := ar.Update(key, AgentUpdate{Drive: &on}); err != nil {
		t.Fatal(err)
	}
	ctx := context.WithValue(context.Background(), agentCtxKey{}, key)
	if !ar.DriveAllowed(ctx, false) {
		t.Error("per-agent drive override was not applied")
	}
	if ar.DriveAllowed(context.Background(), false) {
		t.Error("an unknown agent must follow the global switch")
	}

	yes := true
	if err := ar.Update(key, AgentUpdate{Blocked: &yes}); err != nil {
		t.Fatal(err)
	}
	_, err := cs.CallTool(context.Background(), &mcp.CallToolParams{Name: "ping"})
	if err == nil || !strings.Contains(err.Error(), "disconnected") {
		t.Errorf("blocked agent got err=%v", err)
	}
}

func TestHostAllowed(t *testing.T) {
	t.Setenv("BR_ALLOWED_HOSTS", "boardripper.example.org, .mylab.net")
	cases := map[string]bool{
		"localhost:1336": true, "127.0.0.1:1336": true, "[::1]:1336": true, "192.168.1.20": true,
		"rd-nas:1234": true, "rd-nas.local": true, "nas.home.arpa": true,
		"rd-nas.taila1bfc9.ts.net:1234": true,
		"boardripper.example.org": true, "bench.mylab.net": true,
		"attacker.example:1336": false, "rebind.evil.com": false, "": false,
	}
	for host, want := range cases {
		r := httptest.NewRequest("GET", "/api/mcp/token", nil)
		r.Host = host
		if got := HostAllowed(r); got != want {
			t.Errorf("HostAllowed(%q) = %v, want %v", host, got, want)
		}
	}
	r := httptest.NewRequest("GET", "/api/mcp/token", nil)
	r.Host = "boardripper.somedomain.com"
	r.Header.Set("X-Forwarded-Proto", "https")
	if !HostAllowed(r) {
		t.Error("an HTTPS reverse proxy must be allowed")
	}
}
