package mcpserver

import (
	"context"
	"encoding/json"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const bridgeTimeout = 10 * time.Second

// liveTool registers a tool that forwards {op, args} to the active browser tab
// and returns the tab's JSON result verbatim. When gate is non-nil and returns
// false, the tool refuses (used for the drive-UI opt-in so the Settings toggle
// takes effect without a server restart).
func liveTool[T any](s *mcp.Server, b *Bridge, name, desc, op string, readOnly bool, gate func() bool) {
	mcp.AddTool(s, &mcp.Tool{
		Name:        name,
		Description: desc,
		Annotations: ro(readOnly),
	}, func(ctx context.Context, _ *mcp.CallToolRequest, a T) (*mcp.CallToolResult, map[string]any, error) {
		if gate != nil && !gate() {
			return errResult("drive-UI is disabled — enable “Allow agents to control the UI” in Settings ▸ Integrations"), nil, nil
		}
		if b == nil {
			return errResult("bridge unavailable"), nil, nil
		}
		sess := extractSession(a)
		res, err := b.Request(ctx, sess, op, a, bridgeTimeout)
		if err != nil {
			return errResult(err.Error()), nil, nil
		}
		out := map[string]any{}
		if len(res) > 0 {
			if err := json.Unmarshal(res, &out); err != nil {
				return errResult("tab returned a non-object result: " + err.Error()), nil, nil
			}
		}
		return nil, out, nil
	})
}

// sessioned is implemented by every live-tool arg struct so liveTool can target
// a specific browser page when the agent passes one.
type sessioned interface{ session() string }

func extractSession(a any) string {
	if s, ok := a.(sessioned); ok {
		return s.session()
	}
	return ""
}

type emptyArgs struct {
	Session string `json:"session,omitempty" jsonschema:"optional browser session id from board_sessions"`
}

func (a emptyArgs) session() string { return a.Session }

type filterArgs struct {
	Filter  string `json:"filter,omitempty" jsonschema:"optional case-insensitive substring filter"`
	Session string `json:"session,omitempty"`
}

func (a filterArgs) session() string { return a.Session }

type netArgs struct {
	Net     string `json:"net" jsonschema:"net name"`
	Session string `json:"session,omitempty"`
}

func (a netArgs) session() string { return a.Session }

type netNeighborsArgs struct {
	Net     string `json:"net" jsonschema:"anchor net name"`
	Depth   int    `json:"depth,omitempty" jsonschema:"hops through 2-pin components (default 1)"`
	Session string `json:"session,omitempty"`
}

func (a netNeighborsArgs) session() string { return a.Session }

type partArgs struct {
	Refdes  string `json:"refdes" jsonschema:"component reference designator (e.g. U1, PM8998)"`
	Session string `json:"session,omitempty"`
}

func (a partArgs) session() string { return a.Session }

type pinArgs struct {
	Part    string `json:"part" jsonschema:"component refdes"`
	Pin     string `json:"pin" jsonschema:"pin name or number"`
	Session string `json:"session,omitempty"`
}

func (a pinArgs) session() string { return a.Session }

// drive-UI arg structs

type sideArgs struct {
	Side    string `json:"side" jsonschema:"top or bottom"`
	Session string `json:"session,omitempty"`
}

func (a sideArgs) session() string { return a.Session }

type pdfGotoArgs struct {
	Page    int    `json:"page,omitempty" jsonschema:"1-based page to navigate to"`
	Term    string `json:"term,omitempty" jsonschema:"optional text to search and jump to"`
	Session string `json:"session,omitempty"`
}

func (a pdfGotoArgs) session() string { return a.Session }

// sessionsResult wraps the session descriptors in an object (the SDK requires
// every tool's output schema to be a JSON object, not a bare array).
type sessionsResult struct {
	Sessions []json.RawMessage `json:"sessions"`
}

func registerLiveTools(s *mcp.Server, deps *Deps) {
	b := deps.Bridge

	// board_sessions is answered in Go from the registry (not proxied).
	mcp.AddTool(s, &mcp.Tool{
		Name:        "board_sessions",
		Description: "List the boards currently open in connected BoardRipper pages (for disambiguation when several are open).",
		Annotations: ro(true),
	}, func(ctx context.Context, _ *mcp.CallToolRequest, _ struct{}) (*mcp.CallToolResult, sessionsResult, error) {
		if b == nil {
			return nil, sessionsResult{Sessions: []json.RawMessage{}}, nil
		}
		return nil, sessionsResult{Sessions: b.Sessions()}, nil
	})

	// --- read tools ---
	liveTool[emptyArgs](s, b, "board_active", "Describe the active board: name, format, part/net counts, and shown side.", "board_active", true, nil)
	liveTool[filterArgs](s, b, "list_nets", "List net names on the active board (optional substring filter).", "list_nets", true, nil)
	liveTool[filterArgs](s, b, "list_parts", "List component reference designators on the active board (optional substring filter).", "list_parts", true, nil)
	liveTool[netArgs](s, b, "net_info", "List the pins and parts that belong to a given net.", "net_info", true, nil)
	liveTool[netNeighborsArgs](s, b, "net_neighbors", "Find nets adjacent to an anchor net through 2-pin components (computeAdjacentNets); good for tracing power sequences.", "net_neighbors", true, nil)
	liveTool[pinArgs](s, b, "pin_connectivity", "Given a part and pin, return its net and the other pins on that net.", "pin_connectivity", true, nil)
	liveTool[partArgs](s, b, "part_info", "Return a component's pins, value, package, side, and bounds.", "part_info", true, nil)

	// --- drive-UI tools (always registered; gated per-call on DriveUI()) ---
	gate := func() bool { return deps.State != nil && deps.State.DriveUI() }
	liveTool[netArgs](s, b, "highlight_net", "Highlight a net on the live board so the user can see it.", "highlight_net", false, gate)
	liveTool[emptyArgs](s, b, "clear_highlight", "Clear any net highlight on the live board.", "clear_highlight", false, gate)
	liveTool[partArgs](s, b, "select_part", "Select and centre a component by reference designator on the live board.", "select_part", false, gate)
	liveTool[sideArgs](s, b, "set_side", "Show the top or bottom side of the live board.", "set_side", false, gate)
	liveTool[pdfGotoArgs](s, b, "pdf_goto", "Navigate the open PDF to a page (optionally jumping to a search term).", "pdf_goto", false, gate)
}
