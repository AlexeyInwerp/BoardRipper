package mcpserver

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"boardripper/pdfindex"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// --- secret ---

func TestEnsureSecret_GeneratesPersistsRotates(t *testing.T) {
	dir := t.TempDir()
	s1, err := EnsureSecret(dir)
	if err != nil || len(s1) < 32 {
		t.Fatalf("EnsureSecret: %v len=%d", err, len(s1))
	}
	s2, _ := EnsureSecret(dir)
	if s1 != s2 {
		t.Fatalf("non-idempotent: %q != %q", s1, s2)
	}
	s3, _ := RotateSecret(dir)
	if s3 == s1 {
		t.Fatalf("rotate did not change secret")
	}
}

// --- state ---

type fakeConfig struct{ m map[string]string }

func (f *fakeConfig) GetConfig(k string) (string, error) { return f.m[k], nil }

func TestState_Flags(t *testing.T) {
	if NewState(&fakeConfig{m: map[string]string{}}).Enabled() {
		t.Fatal("should default off")
	}
	st := NewState(&fakeConfig{m: map[string]string{"mcp_enabled": "1", "mcp_drive_ui": "true"}})
	if !st.Enabled() || !st.DriveUI() {
		t.Fatal("flags not read")
	}
}

// --- gate ---

func okHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) })
}

func TestGate(t *testing.T) {
	const sec = "secret123secret123secret123secret1"
	cases := []struct {
		name    string
		enabled bool
		token   string
		want    int
	}{
		{"disabled-404", false, sec, 404},
		{"bad-token-401", true, "wrong", 401},
		{"good-token-200", true, sec, 200},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			m := map[string]string{}
			if c.enabled {
				m["mcp_enabled"] = "1"
			}
			h := Gate(NewState(&fakeConfig{m: m}), sec, okHandler())
			rec := httptest.NewRecorder()
			req := httptest.NewRequest("POST", "/api/mcp", nil)
			req.Header.Set("Authorization", "Bearer "+c.token)
			h.ServeHTTP(rec, req)
			if rec.Code != c.want {
				t.Fatalf("code=%d want=%d", rec.Code, c.want)
			}
		})
	}
}

// --- bridge correlation ---

func TestBridge_RequestResponseCorrelation(t *testing.T) {
	b := NewBridge()
	sess := b.register("s1", json.RawMessage(`{"name":"DemoBoard"}`))
	defer b.unregister("s1")

	go func() {
		f := <-sess.outbound
		_ = b.deliver(bridgeReply{ID: f.ID, OK: true, Result: json.RawMessage(`{"nets":3}`)})
	}()

	res, err := b.Request(context.Background(), "", "list_nets", map[string]any{}, 2*time.Second)
	if err != nil {
		t.Fatalf("Request: %v", err)
	}
	if string(res) != `{"nets":3}` {
		t.Fatalf("result=%s", res)
	}
}

func TestBridge_Timeout(t *testing.T) {
	b := NewBridge()
	b.register("s1", json.RawMessage(`{}`))
	defer b.unregister("s1")
	if _, err := b.Request(context.Background(), "", "list_nets", nil, 80*time.Millisecond); err == nil {
		t.Fatal("expected timeout")
	}
}

func TestBridge_NoSession(t *testing.T) {
	b := NewBridge()
	if _, err := b.Request(context.Background(), "", "list_nets", nil, time.Second); err == nil {
		t.Fatal("expected no-session error")
	}
}

func TestBridge_PicksMostRecentlyFocused(t *testing.T) {
	b := NewBridge()
	b.register("a", json.RawMessage(`{"name":"A"}`))
	time.Sleep(2 * time.Millisecond)
	b.register("b", json.RawMessage(`{"name":"B"}`))
	b.touchFocus("a") // a now most recent
	if got := b.pick(""); got == nil || got.id != "a" {
		t.Fatalf("pick = %v, want a", got)
	}
	if got := b.pick("b"); got == nil || got.id != "b" {
		t.Fatalf("explicit pick failed")
	}
}

// --- in-memory MCP client smoke test (ping + pdf_search + drive gate) ---

type fakePDF struct{ hits []pdfindex.SearchHit }

func (f *fakePDF) SearchPages(q string, r []int64, l int) ([]pdfindex.SearchHit, error) {
	return f.hits, nil
}

func connectClient(t *testing.T, deps *Deps) *mcp.ClientSession {
	t.Helper()
	srv := New(deps)
	ct, st := mcp.NewInMemoryTransports()
	if _, err := srv.mcp.Connect(context.Background(), st, nil); err != nil {
		t.Fatalf("server connect: %v", err)
	}
	client := mcp.NewClient(&mcp.Implementation{Name: "test", Version: "1"}, nil)
	sess, err := client.Connect(context.Background(), ct, nil)
	if err != nil {
		t.Fatalf("client connect: %v", err)
	}
	return sess
}

func TestServer_PingAndPdfSearch(t *testing.T) {
	deps := &Deps{
		State:  NewState(&fakeConfig{m: map[string]string{"mcp_enabled": "1"}}),
		Bridge: NewBridge(),
		PDF:    &fakePDF{hits: []pdfindex.SearchHit{{FileID: 7, PageNum: 3, Snippet: "AOZ5332"}}},
	}
	sess := connectClient(t, deps)
	defer sess.Close()

	ping, err := sess.CallTool(context.Background(), &mcp.CallToolParams{Name: "ping"})
	if err != nil || ping.IsError {
		t.Fatalf("ping: err=%v isErr=%v", err, ping.IsError)
	}

	res, err := sess.CallTool(context.Background(), &mcp.CallToolParams{
		Name:      "pdf_search",
		Arguments: map[string]any{"query": "AOZ5332"},
	})
	if err != nil || res.IsError {
		t.Fatalf("pdf_search: err=%v isErr=%v", err, res.IsError)
	}
	js, _ := json.Marshal(res.StructuredContent)
	if !contains(string(js), "AOZ5332") {
		t.Fatalf("pdf_search result missing snippet: %s", js)
	}
}

func TestServer_DriveGateBlocksWhenOff(t *testing.T) {
	deps := &Deps{
		State:  NewState(&fakeConfig{m: map[string]string{"mcp_enabled": "1"}}), // drive off
		Bridge: NewBridge(),
	}
	sess := connectClient(t, deps)
	defer sess.Close()

	res, err := sess.CallTool(context.Background(), &mcp.CallToolParams{
		Name:      "highlight_net",
		Arguments: map[string]any{"net": "GND"},
	})
	if err != nil {
		t.Fatalf("call err: %v", err)
	}
	if !res.IsError {
		t.Fatal("expected drive-UI to be refused when toggle off")
	}
}

func TestServer_ListToolsIncludesLive(t *testing.T) {
	deps := &Deps{State: NewState(&fakeConfig{m: map[string]string{"mcp_enabled": "1"}}), Bridge: NewBridge()}
	sess := connectClient(t, deps)
	defer sess.Close()
	lt, err := sess.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatalf("ListTools: %v", err)
	}
	want := map[string]bool{"ping": false, "board_active": false, "net_neighbors": false, "highlight_net": false}
	for _, tool := range lt.Tools {
		if _, ok := want[tool.Name]; ok {
			want[tool.Name] = true
		}
	}
	for name, found := range want {
		if !found {
			t.Fatalf("tool %q not advertised", name)
		}
	}
}

func TestServer_SelfTestAndActivity(t *testing.T) {
	deps := &Deps{State: NewState(&fakeConfig{m: map[string]string{"mcp_enabled": "1"}}), Bridge: NewBridge()}
	srv := New(deps)
	tools, err := srv.SelfTest(context.Background())
	if err != nil {
		t.Fatalf("SelfTest: %v", err)
	}
	if len(tools) < 10 {
		t.Fatalf("expected many tools, got %d", len(tools))
	}

	// Activity starts empty, records after a call.
	if srv.Activity().TotalCalls != 0 {
		t.Fatalf("expected 0 calls initially")
	}
	sess := connectClient(t, deps) // separate server instance
	defer sess.Close()
	// Drive activity on THIS srv via its own in-memory client.
	ct, st := mcp.NewInMemoryTransports()
	srv.mcp.Connect(context.Background(), st, nil)
	c := mcp.NewClient(&mcp.Implementation{Name: "a", Version: "1"}, nil)
	cs, _ := c.Connect(context.Background(), ct, nil)
	defer cs.Close()
	if _, err := cs.CallTool(context.Background(), &mcp.CallToolParams{Name: "ping"}); err != nil {
		t.Fatalf("ping: %v", err)
	}
	snap := srv.Activity()
	if snap.TotalCalls < 1 || snap.LastTool != "ping" {
		t.Fatalf("activity not recorded: %+v", snap)
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
