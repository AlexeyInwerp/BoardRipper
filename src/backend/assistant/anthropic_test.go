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

	"boardripper/mcpserver"
)

// A fake Messages API: first a tool_use for list_parts, then text.
func TestAnthropicToolLoop(t *testing.T) {
	var mu sync.Mutex
	var bodies []map[string]any
	var headers []http.Header
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		mu.Lock()
		bodies = append(bodies, body)
		headers = append(headers, r.Header.Clone())
		n := len(bodies)
		mu.Unlock()
		w.Header().Set("Content-Type", "text/event-stream")
		send := func(ev string, data string) { fmt.Fprintf(w, "event: %s\ndata: %s\n\n", ev, data) }
		send("message_start", `{"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-opus-5-5","content":[],"stop_reason":null,"usage":{"input_tokens":10,"output_tokens":0}}}`)
		if n == 1 {
			send("content_block_start", `{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"list_parts","input":{}}}`)
			send("content_block_delta", `{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"filter\":\"U\"}"}}`)
			send("content_block_stop", `{"type":"content_block_stop","index":0}`)
			send("message_delta", `{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":5}}`)
		} else {
			send("content_block_start", `{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`)
			send("content_block_delta", `{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Found them."}}`)
			send("content_block_stop", `{"type":"content_block_stop","index":0}`)
			send("message_delta", `{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}`)
		}
		send("message_stop", `{"type":"message_stop"}`)
	}))
	defer srv.Close()

	store, _ := LoadStore("")
	browser := "browser-0123456789"
	_ = store.apply(browser, ConfigChange{Provider: "anthropic", APIKey: "sk-test", BaseURL: srv.URL, Activate: true})
	agents := mcpserver.LoadAgents("")
	m := &Manager{Store: store, Agents: agents, MCP: mcpserver.New(&mcpserver.Deps{State: mcpserver.NewState(nil), Bridge: mcpserver.NewBridge(), Agents: agents})}

	var text strings.Builder
	m.Run(context.Background(), browser, "", "which ICs?", func(e Event) {
		if e.Type == "error" {
			t.Errorf("error: %s", e.Message)
		}
		if e.Type == "text" {
			text.WriteString(e.Text)
		}
	})
	if text.String() != "Found them." || len(bodies) != 2 {
		t.Fatalf("text=%q requests=%d", text.String(), len(bodies))
	}
	if got := headers[0].Get("Anthropic-Beta"); !strings.Contains(got, "server-side-fallback-2026-07-01") {
		t.Errorf("fallback beta header missing: %q", got)
	}
	if bodies[0]["fallbacks"] != "default" || bodies[0]["model"] != "claude-opus-5-5" {
		t.Errorf("first request: fallbacks=%v model=%v", bodies[0]["fallbacks"], bodies[0]["model"])
	}
	msgs := bodies[1]["messages"].([]any)
	if len(msgs) != 3 {
		t.Fatalf("second request carries %d messages, want user/assistant/tool_result", len(msgs))
	}
	res := msgs[2].(map[string]any)["content"].([]any)[0].(map[string]any)
	if res["type"] != "tool_result" || res["tool_use_id"] != "toolu_1" {
		t.Fatalf("tool result block = %v", res)
	}
	var hasWeb bool
	for _, tl := range bodies[0]["tools"].([]any) {
		if tl.(map[string]any)["type"] == "web_search_20260209" {
			hasWeb = true
		}
	}
	if !hasWeb {
		t.Error("web search tool missing for claude-opus-5-5")
	}
}
