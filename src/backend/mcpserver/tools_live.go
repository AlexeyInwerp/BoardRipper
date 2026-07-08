package mcpserver

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const bridgeTimeout = 10 * time.Second

// bridgeRenderTimeout is used by binary-reply tools (e.g. pdf_download) whose
// browser-side work (base64-encoding a whole file) takes longer than a plain
// data lookup.
const bridgeRenderTimeout = 30 * time.Second

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

// decodeBinaryReply decodes a bridge binary reply of the shape
// {base64, mime, ...meta}: it base64-decodes the payload and returns the
// remaining fields (minus "base64") as metadata. mime defaults to
// "application/octet-stream" when the tab didn't supply one. Split out from
// liveBinaryTool so the decode/strip logic is unit-testable without a live
// bridge/socket.
func decodeBinaryReply(raw json.RawMessage) (mime string, data []byte, meta map[string]any, err error) {
	var r struct {
		Base64 string `json:"base64"`
		MIME   string `json:"mime"`
	}
	if err := json.Unmarshal(raw, &r); err != nil {
		return "", nil, nil, fmt.Errorf("bad binary reply: %w", err)
	}
	data, err = base64.StdEncoding.DecodeString(r.Base64)
	if err != nil {
		return "", nil, nil, fmt.Errorf("bad base64 from tab: %w", err)
	}
	meta = map[string]any{}
	_ = json.Unmarshal(raw, &meta)
	delete(meta, "base64")
	mime = r.MIME
	if mime == "" {
		mime = "application/octet-stream"
	}
	return mime, data, meta, nil
}

// liveBinaryTool registers a bridge-backed tool whose browser reply is
// {base64, mime, ...meta}; it decodes base64 and emits an MCP image/blob
// content block via binaryResult. Uses the longer render timeout.
func liveBinaryTool[T any](s *mcp.Server, b *Bridge, name, desc, op string, gate func() bool) {
	mcp.AddTool(s, &mcp.Tool{Name: name, Description: desc, Annotations: ro(true)},
		func(ctx context.Context, _ *mcp.CallToolRequest, a T) (*mcp.CallToolResult, any, error) {
			if gate != nil && !gate() {
				return errResult("disabled"), nil, nil
			}
			if b == nil {
				return errResult("bridge unavailable"), nil, nil
			}
			res, err := b.Request(ctx, extractSession(a), op, a, bridgeRenderTimeout)
			if err != nil {
				return errResult(err.Error()), nil, nil
			}
			mime, data, meta, err := decodeBinaryReply(res)
			if err != nil {
				return errResult(err.Error()), nil, nil
			}
			return binaryResult(mime, data, meta), nil, nil
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
	Limit   int    `json:"limit,omitempty" jsonschema:"max items to return (default 200, cap 1000)"`
	Offset  int    `json:"offset,omitempty" jsonschema:"pagination offset (default 0)"`
	Session string `json:"session,omitempty"`
}

func (a filterArgs) session() string { return a.Session }

// partsFilterArgs is list_parts: substring + side filter + pagination.
type partsFilterArgs struct {
	Filter  string `json:"filter,omitempty" jsonschema:"optional case-insensitive substring filter on refdes"`
	Side    string `json:"side,omitempty" jsonschema:"filter by side: top or bottom"`
	Limit   int    `json:"limit,omitempty" jsonschema:"max items to return (default 200, cap 1000)"`
	Offset  int    `json:"offset,omitempty" jsonschema:"pagination offset (default 0)"`
	Session string `json:"session,omitempty"`
}

func (a partsFilterArgs) session() string { return a.Session }

// findPartsArgs is find_parts: free-text search across refdes + part metadata
// (value/serial/package/part-type). Surfaces part descriptions when no
// schematic PDF is available.
type findPartsArgs struct {
	Query   string `json:"query" jsonschema:"text to find in refdes or part description (value/serial/package/type)"`
	Limit   int    `json:"limit,omitempty" jsonschema:"max items (default 200, cap 1000)"`
	Offset  int    `json:"offset,omitempty" jsonschema:"pagination offset (default 0)"`
	Session string `json:"session,omitempty"`
}

func (a findPartsArgs) session() string { return a.Session }

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

// pdfPageArgs is pdf_page_text: read the OPEN PDF's cached text layer for one
// page (defaults to the current page). No re-extraction.
type pdfPageArgs struct {
	Page    int    `json:"page,omitempty" jsonschema:"1-based page (default: current page)"`
	Session string `json:"session,omitempty"`
}

func (a pdfPageArgs) session() string { return a.Session }

// pdfFindArgs is pdf_search_open: case-insensitive substring search within the
// OPEN PDF document (distinct from the library-wide pdf_search tool).
type pdfFindArgs struct {
	Query   string `json:"query" jsonschema:"text to find in the open PDF"`
	Limit   int    `json:"limit,omitempty" jsonschema:"max matches (default 200, cap 1000)"`
	Session string `json:"session,omitempty"`
}

func (a pdfFindArgs) session() string { return a.Session }

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
	liveTool[emptyArgs](s, b, "board_active", "Describe the active board: name, part/net counts, shown side, plus a session id and a generation token that changes when the open board changes (re-read your data when it changes).", "board_active", true, nil)
	liveTool[emptyArgs](s, b, "board_overview", "One-call orientation: the active board's name, part/net counts, shown side, open PDFs (name/page/pageCount/fileId), and a worklist summary (entry counts, pending measurements, unread user messages). Recommended first call.", "board_overview", true, nil)
	liveTool[filterArgs](s, b, "list_nets", "List net names on the active board. Supports a substring filter and limit/offset pagination; returns {nets,total,has_more,offset}. Filter before paging — don't enumerate thousands.", "list_nets", true, nil)
	liveTool[partsFilterArgs](s, b, "list_parts", "List component reference designators on the active board. Supports substring + side (top|bottom) filters and limit/offset pagination; returns {parts:[{refdes,side}],total,has_more,offset}.", "list_parts", true, nil)
	liveTool[netArgs](s, b, "net_info", "List the pins and parts that belong to a given net.", "net_info", true, nil)
	liveTool[netNeighborsArgs](s, b, "net_neighbors", "Find nets adjacent to an anchor net through 2-pin components (computeAdjacentNets); good for tracing power sequences.", "net_neighbors", true, nil)
	liveTool[pinArgs](s, b, "pin_connectivity", "Given a part and pin, return its net and the other pins on that net.", "pin_connectivity", true, nil)
	liveTool[partArgs](s, b, "part_info", "Return a component's full info: pins, and any descriptive metadata the boardview carried — value, serial (these often hold the real part name/number), package, part-type, side, height, angle.", "part_info", true, nil)
	liveTool[findPartsArgs](s, b, "find_parts", "Search parts by free text across refdes + description fields (value/serial/package/part-type). Use this to locate a component by name/number when no schematic PDF is available — many boardviews store the real part name in the description. Returns {parts:[{refdes,side,value,serial,package,part_type}],total,has_more,offset}.", "find_parts", true, nil)
	liveTool[pdfPageArgs](s, b, "pdf_page_text", "Extracted text of a page of the open PDF (defaults to the current page). Reads the already-cached text layer; no re-extraction.", "pdf_page_text", true, nil)
	liveTool[pdfFindArgs](s, b, "pdf_search_open", "Search WITHIN the open PDF document (instant, in-memory; also works for drag-dropped files). For library-wide search use pdf_search.", "pdf_search_open", true, nil)
	liveBinaryTool[emptyArgs](s, b, "pdf_download", "Download the currently open PDF as bytes (application/pdf) so the model can read the schematic natively. Works for library and drag-dropped files.", "pdf_download", nil)

	// --- drive-UI tools (always registered; gated per-call on DriveUI()) ---
	gate := func() bool { return deps.State != nil && deps.State.DriveUI() }
	liveTool[netArgs](s, b, "highlight_net", "Highlight a net on the live board so the user can see it.", "highlight_net", false, gate)
	liveTool[emptyArgs](s, b, "clear_highlight", "Clear any net highlight on the live board.", "clear_highlight", false, gate)
	liveTool[partArgs](s, b, "select_part", "Select and centre a component by reference designator on the live board.", "select_part", false, gate)
	liveTool[sideArgs](s, b, "set_side", "Show the top or bottom side of the live board.", "set_side", false, gate)
	liveTool[pdfGotoArgs](s, b, "pdf_goto", "Navigate the open PDF to a page (optionally jumping to a search term).", "pdf_goto", false, gate)

	// ── Worklist AI-mode feedback loop ──
	// Reads: the agent sees what's on the worklist + measurement results + user prompts.
	liveTool[emptyArgs](s, b, "worklist_get", "Read the active board's worklist: part/net entries (with repair marks + notes + ai flag, and inline net measurements), the ticket note, and the message transcript.", "worklist_get", true, nil)
	liveTool[getMeasurementsArgs](s, b, "get_measurements", "Read net measurement rows on the active worklist. Each row is an inline field on a net entry (both user-recorded and agent-requested readings). Optional filters: status=requested|recorded, source=agent|user. Returns {measurements:[{netName,kind,status,value,unit,expected,source}]}.", "get_measurements", true, nil)
	liveTool[getUserMessagesArgs](s, b, "get_user_messages", "Read the user's relay-prompt messages (defaults to only-unread, marking them read). This is how the user talks back to you from the worklist panel.", "get_user_messages", true, nil)
	// Writes: the agent populates the worklist + requests measurements + posts notes (gated on drive-UI).
	liveTool[worklistAddArgs](s, b, "worklist_add", "Add/update a part or net on the active worklist (kind=part|net, id=refdes|net), with an optional repair mark + note. Note text may use [n:NET] / [p:REFDES:PIN] chips (clickable on the board).", "worklist_add", false, gate)
	liveTool[worklistAddArgs](s, b, "worklist_update", "Update a part/net entry's mark or note on the active worklist (same args as worklist_add).", "worklist_update", false, gate)
	liveTool[worklistNoteArgs](s, b, "worklist_set_list_note", "Set the worklist's ticket/diagnosis note (compressed summary of your finding; may use [n:]/[p:] chips).", "worklist_set_list_note", false, gate)
	liveTool[requestMeasurementArgs](s, b, "request_measurement", "Ask the user to take a measurement. target=net → inline net field (kind=voltage|diode|resistance only); target=part/pin → posted to the relay transcript via post_message. prompt=what+how, expected=spec. Read net results later with get_measurements.", "request_measurement", false, gate)
	liveTool[postMessageArgs](s, b, "post_message", "Post a short message into the worklist transcript (your compressed answer; full prose stays in chat). May use [n:]/[p:] chips.", "post_message", false, gate)
}

type getMeasurementsArgs struct {
	Status  string `json:"status,omitempty" jsonschema:"optional filter: requested | recorded"`
	Source  string `json:"source,omitempty" jsonschema:"optional filter: agent | user"`
	Session string `json:"session,omitempty"`
}

func (a getMeasurementsArgs) session() string { return a.Session }

type getUserMessagesArgs struct {
	OnlyUnread *bool  `json:"only_unread,omitempty" jsonschema:"default true: return only messages you haven't read yet"`
	Session    string `json:"session,omitempty"`
}

func (a getUserMessagesArgs) session() string { return a.Session }

type worklistAddArgs struct {
	Kind    string `json:"kind" jsonschema:"part or net"`
	ID      string `json:"id" jsonschema:"reference designator (kind=part) or net name (kind=net)"`
	Mark    string `json:"mark,omitempty" jsonschema:"part: replaced|reworked|cleaned; net: short|solved|absent"`
	Note    string `json:"note,omitempty"`
	Session string `json:"session,omitempty"`
}

func (a worklistAddArgs) session() string { return a.Session }

type worklistNoteArgs struct {
	Note    string `json:"note"`
	Session string `json:"session,omitempty"`
}

func (a worklistNoteArgs) session() string { return a.Session }

type requestMeasurementArgs struct {
	Target   string `json:"target" jsonschema:"what to measure on: refdes, net, or REFDES.PIN"`
	Kind     string `json:"kind,omitempty" jsonschema:"diode|voltage|resistance|continuity|other"`
	Prompt   string `json:"prompt" jsonschema:"what to measure and how (probe placement, range)"`
	Expected string `json:"expected,omitempty" jsonschema:"the spec/expected value, if known"`
	Session  string `json:"session,omitempty"`
}

func (a requestMeasurementArgs) session() string { return a.Session }

type postMessageArgs struct {
	Text    string `json:"text"`
	Session string `json:"session,omitempty"`
}

func (a postMessageArgs) session() string { return a.Session }
