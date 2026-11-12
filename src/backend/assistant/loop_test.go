package assistant

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"boardripper/mcpserver"
)

// fakeOpenAI answers the first request with one tool call and every later
// one with a plain text answer, recording each request body.
type fakeOpenAI struct {
	mu       sync.Mutex
	tool     string
	args     string
	requests []map[string]any
}

func (f *fakeOpenAI) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	var body map[string]any
	_ = json.NewDecoder(r.Body).Decode(&body)
	f.mu.Lock()
	f.requests = append(f.requests, body)
	n := len(f.requests)
	f.mu.Unlock()
	w.Header().Set("Content-Type", "text/event-stream")
	if n == 1 {
		args, _ := json.Marshal(f.args)
		fmt.Fprintf(w, "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"name\":%q,\"arguments\":%s}}]}}]}\n\n", f.tool, args)
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\ndata: [DONE]\n\n")
		return
	}
	fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"All done.\"}}]}\n\n")
	fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
}

func newManager(t *testing.T, fake *fakeOpenAI) (*Manager, string) {
	t.Helper()
	srv := httptest.NewServer(fake)
	t.Cleanup(srv.Close)
	store, _ := LoadStore("")
	browser := "browser-0123456789"
	if err := store.apply(browser, ConfigChange{Provider: "ollama", BaseURL: srv.URL, Model: "test-model", Activate: true}); err != nil {
		t.Fatal(err)
	}
	agents := mcpserver.LoadAgents("")
	mcp := mcpserver.New(&mcpserver.Deps{State: mcpserver.NewState(nil), Bridge: mcpserver.NewBridge(), Agents: agents})
	return &Manager{Store: store, MCP: mcp, Agents: agents, DriveGlobal: func() bool { return false }}, browser
}

func TestReadToolRunsWithoutAsking(t *testing.T) {
	fake := &fakeOpenAI{tool: "list_parts", args: `{"filter":"U"}`}
	m, browser := newManager(t, fake)
	var events []Event
	m.Run(context.Background(), browser, "", "which ICs?", func(e Event) { events = append(events, e) })

	var text strings.Builder
	for _, e := range events {
		if e.Type == "approval" {
			t.Fatal("a read-only tool must not ask for approval")
		}
		if e.Type == "error" {
			t.Fatalf("error event: %s", e.Message)
		}
		if e.Type == "text" {
			text.WriteString(e.Text)
		}
	}
	if text.String() != "All done." {
		t.Fatalf("final text = %q", text.String())
	}
	if len(fake.requests) != 2 {
		t.Fatalf("requests = %d, want 2", len(fake.requests))
	}
	msgs := fake.requests[1]["messages"].([]any)
	last := msgs[len(msgs)-1].(map[string]any)
	if last["role"] != "tool" || last["tool_call_id"] != "call_1" {
		t.Fatalf("second request must end with the tool result, got %v", last)
	}
	// The tool list reaches the model without the excluded and session fields.
	for _, tl := range fake.requests[0]["tools"].([]any) {
		fn := tl.(map[string]any)["function"].(map[string]any)
		if excludedTools[fn["name"].(string)] {
			t.Errorf("excluded tool %v was offered", fn["name"])
		}
		if props, ok := fn["parameters"].(map[string]any)["properties"].(map[string]any); ok {
			if _, has := props["session"]; has {
				t.Errorf("tool %v still offers a session argument", fn["name"])
			}
		}
	}
}

func TestBoardControlAsksAndRespectsDecline(t *testing.T) {
	fake := &fakeOpenAI{tool: "highlight_net", args: `{"net":"PPBUS_G3H"}`}
	m, browser := newManager(t, fake)
	var mu sync.Mutex
	var events []Event
	done := make(chan struct{})
	go func() {
		m.Run(context.Background(), browser, "", "show the main rail", func(e Event) {
			mu.Lock()
			events = append(events, e)
			mu.Unlock()
			if e.Type == "approval" {
				var conv string
				mu.Lock()
				for _, ev := range events {
					if ev.Conv != "" {
						conv = ev.Conv
					}
				}
				mu.Unlock()
				go func() {
					if err := m.Approve(browser, conv, e.ID, "deny"); err != nil {
						t.Errorf("approve: %v", err)
					}
				}()
			}
		})
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("turn did not finish")
	}
	var asked, declined bool
	for _, e := range events {
		if e.Type == "approval" && e.Kind == "drive" && e.Tool == "highlight_net" {
			asked = true
		}
		if e.Type == "tool" && e.Status == "declined" {
			declined = true
		}
	}
	if !asked || !declined {
		t.Fatalf("asked=%v declined=%v events=%+v", asked, declined, events)
	}
	msgs := fake.requests[1]["messages"].([]any)
	last := msgs[len(msgs)-1].(map[string]any)
	if !strings.Contains(fmt.Sprint(last["content"]), "declined") {
		t.Fatalf("the model must be told the user declined, got %v", last["content"])
	}
}

func TestKeysNeverLeaveTheServer(t *testing.T) {
	store, _ := LoadStore("")
	_ = store.apply("browser-a1234567", ConfigChange{Provider: "anthropic", APIKey: "sk-ant-secret-1234", Activate: true})
	pub := store.public("browser-a1234567")
	b, _ := json.Marshal(pub)
	if strings.Contains(string(b), "secret") {
		t.Fatal("the public config leaks the key")
	}
	if !strings.Contains(string(b), `"key_hint":"1234"`) {
		t.Fatalf("expected a key hint, got %s", b)
	}
	if _, err := store.resolve("browser-b1234567", ""); err == nil {
		t.Fatal("another browser must not resolve this browser's key")
	}
}
