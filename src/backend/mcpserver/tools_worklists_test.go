package mcpserver

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"boardripper/worklists"
)

func TestWorklistTools(t *testing.T) {
	st, err := worklists.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	put := func(id, body string) {
		if _, err := st.Put(id, []byte(body)); err != nil {
			t.Fatalf("put %s: %v", id, err)
		}
	}
	put("wl-a", `{"id":"wl-a","rev":0,"name":"No power","board":"820-02016","tags":["A2337","water"],"entries":[{"refdes":"U7700","mark":"bad","note":"","at":1},{"refdes":"C1","mark":"none","note":"","at":1,"removed":2}],"netEntries":[{"netName":"PPBUS_AON","mark":"none","note":"","at":1}]}`)
	put("wl-b", `{"id":"wl-b","rev":0,"name":"Other","board":"820-01598","tags":[],"entries":[],"netEntries":[]}`)

	deps := &Deps{
		State:     NewState(&fakeConfig{m: map[string]string{"mcp_enabled": "1"}}),
		Bridge:    NewBridge(),
		Worklists: st,
	}
	sess := connectClient(t, deps)
	defer sess.Close()

	call := func(name string, args map[string]any) (string, bool) {
		res, err := sess.CallTool(context.Background(), &mcp.CallToolParams{Name: name, Arguments: args})
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		js, _ := json.Marshal(res.StructuredContent)
		return string(js), res.IsError
	}

	js, isErr := call("worklist_list", map[string]any{"query": "820 02016 water"})
	if isErr || !strings.Contains(js, `"wl-a"`) || strings.Contains(js, `"wl-b"`) {
		t.Fatalf("worklist_list query: %s", js)
	}
	if !strings.Contains(js, `"parts":1`) || !strings.Contains(js, `"nets":1`) {
		t.Fatalf("removed rows must not count: %s", js)
	}
	js, _ = call("worklist_list", nil)
	if !strings.Contains(js, `"total":2`) {
		t.Fatalf("worklist_list all: %s", js)
	}
	js, isErr = call("worklist_read", map[string]any{"id": "wl-a"})
	if isErr || !strings.Contains(js, "U7700") {
		t.Fatalf("worklist_read: %s", js)
	}
	if _, isErr = call("worklist_read", map[string]any{"id": "wl-zzz"}); !isErr {
		t.Fatal("worklist_read of an unknown id must be an error")
	}
}
