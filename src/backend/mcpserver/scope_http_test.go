package mcpserver

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type bearerRT struct{ tok string }

func (rt bearerRT) RoundTrip(r *http.Request) (*http.Response, error) {
	r.Header.Set("Authorization", "Bearer "+rt.tok)
	return http.DefaultTransport.RoundTrip(r)
}

// TestScope_PropagatesThroughStreamableHTTP proves the full stack: GateAuto
// resolves the bearer into a Scope on the request context, the go-sdk carries
// that context into tool handlers, and board_sessions filters accordingly.
// If this test fails after an SDK bump, scope transport is broken — do not
// ship until re-established.
func TestScope_PropagatesThroughStreamableHTTP(t *testing.T) {
	deps := &Deps{State: NewState(&fakeConfig{m: map[string]string{"mcp_enabled": "1"}}), Bridge: NewBridge()}
	srv := New(deps)
	deps.Bridge.register("a1", json.RawMessage(`{"name":"A","session":"a1"}`), "alex", "Alex")
	deps.Bridge.register("m1", json.RawMessage(`{"name":"M","session":"m1"}`), "marc", "Marc")

	ps, err := LoadPairings(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	alexTok, err := ps.PairClient("alex", "Alex")
	if err != nil {
		t.Fatal(err)
	}

	ts := httptest.NewServer(GateAuto(deps.State, "install-secret", ps, NewOAuth(), srv.Handler()))
	defer ts.Close()

	connect := func(bearer string) *mcp.ClientSession {
		t.Helper()
		client := mcp.NewClient(&mcp.Implementation{Name: "scopetest", Version: "1"}, nil)
		tr := &mcp.StreamableClientTransport{
			Endpoint:   ts.URL,
			HTTPClient: &http.Client{Transport: bearerRT{bearer}},
		}
		cs, err := client.Connect(context.Background(), tr, nil)
		if err != nil {
			t.Fatalf("connect(%q): %v", bearer, err)
		}
		return cs
	}
	sessionsOf := func(cs *mcp.ClientSession) []map[string]any {
		t.Helper()
		res, err := cs.CallTool(context.Background(), &mcp.CallToolParams{Name: "board_sessions"})
		if err != nil {
			t.Fatalf("board_sessions: %v", err)
		}
		sc, ok := res.StructuredContent.(map[string]any)
		if !ok {
			t.Fatalf("no structured content: %#v", res.StructuredContent)
		}
		raw, _ := sc["sessions"].([]any)
		out := make([]map[string]any, 0, len(raw))
		for _, e := range raw {
			if m, ok := e.(map[string]any); ok {
				out = append(out, m)
			}
		}
		return out
	}

	// Paired token: only alex's page, enriched with the client label.
	alex := connect(alexTok)
	defer alex.Close()
	mine := sessionsOf(alex)
	if len(mine) != 1 || mine[0]["name"] != "A" || mine[0]["client_label"] != "Alex" {
		t.Fatalf("alex sees %v, want exactly board A with client_label Alex", mine)
	}

	// Shared install token: both pages.
	shared := connect("install-secret")
	defer shared.Close()
	if all := sessionsOf(shared); len(all) != 2 {
		t.Fatalf("shared sees %d sessions, want 2", len(all))
	}

	// A live tool addressed at a foreign session must refuse with the spec
	// error, before any bridge round-trip (instant, no timeout burn).
	res, err := alex.CallTool(context.Background(), &mcp.CallToolParams{
		Name:      "net_info",
		Arguments: map[string]any{"net": "GND", "session": "m1"},
	})
	if err != nil {
		t.Fatalf("net_info transport error: %v", err)
	}
	if !res.IsError {
		t.Fatal("net_info against foreign session did not error")
	}
	var text string
	for _, c := range res.Content {
		if tc, ok := c.(*mcp.TextContent); ok {
			text += tc.Text
		}
	}
	if !strings.Contains(text, "session not found for this token") {
		t.Fatalf("foreign-session error text = %q", text)
	}
}

func TestPairHandlers(t *testing.T) {
	on := NewState(&fakeConfig{m: map[string]string{"mcp_enabled": "1"}})
	off := NewState(&fakeConfig{m: map[string]string{}})
	ps, _ := LoadPairings(t.TempDir())

	post := func(h http.HandlerFunc, body string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		h(rec, httptest.NewRequest("POST", "/api/mcp/pair", strings.NewReader(body)))
		return rec
	}

	// Disabled → 404 (invisible, like every other MCP endpoint).
	if rec := post(PairHandler(off, ps), `{"client_id":"0123456789abcdef","label":"X"}`); rec.Code != 404 {
		t.Fatalf("disabled pair status = %d", rec.Code)
	}
	// Valid pair → token, echoed label.
	rec := post(PairHandler(on, ps), `{"client_id":"0123456789abcdef","label":"Bench 1"}`)
	if rec.Code != 200 {
		t.Fatalf("pair status = %d body=%s", rec.Code, rec.Body)
	}
	var out struct{ Token, Label string }
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil || len(out.Token) != 64 || out.Label != "Bench 1" {
		t.Fatalf("pair reply = %s (err %v)", rec.Body, err)
	}
	if id, ok := ps.ClientForToken(out.Token); !ok || id != "0123456789abcdef" {
		t.Fatal("pair did not persist in store")
	}
	// Too-short client_id → 400.
	if rec := post(PairHandler(on, ps), `{"client_id":"short","label":""}`); rec.Code != 400 {
		t.Fatalf("short client_id status = %d", rec.Code)
	}
	// Rotate: unknown client 400, known client fresh token.
	if rec := post(RotateHandler(on, ps), `{"client_id":"never-paired-here"}`); rec.Code != 400 {
		t.Fatalf("rotate unknown status = %d", rec.Code)
	}
	rec = post(RotateHandler(on, ps), `{"client_id":"0123456789abcdef"}`)
	var rot struct{ Token string }
	if rec.Code != 200 || json.Unmarshal(rec.Body.Bytes(), &rot) != nil || rot.Token == out.Token || len(rot.Token) != 64 {
		t.Fatalf("rotate reply = %d %s", rec.Code, rec.Body)
	}
}
