package mcpserver

import (
	"context"
	"net/http"
	"sync"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// activity records lightweight MCP usage signal for the Settings UI: which tool
// an agent last called, when, and the running total. Concurrency-safe.
type activity struct {
	mu         sync.Mutex
	lastTool   string
	lastToolAt time.Time
	totalCalls int64
}

func (a *activity) record(tool string) {
	a.mu.Lock()
	a.lastTool = tool
	a.lastToolAt = nowFunc()
	a.totalCalls++
	a.mu.Unlock()
}

// ActivitySnapshot is the JSON-friendly view returned by /api/mcp/status.
type ActivitySnapshot struct {
	LastTool     string `json:"last_tool"`
	LastToolAtMs int64  `json:"last_tool_at_ms"` // unix ms, 0 if never
	TotalCalls   int64  `json:"total_calls"`
}

func (a *activity) snapshot() ActivitySnapshot {
	a.mu.Lock()
	defer a.mu.Unlock()
	var at int64
	if !a.lastToolAt.IsZero() {
		at = a.lastToolAt.UnixMilli()
	}
	return ActivitySnapshot{LastTool: a.lastTool, LastToolAtMs: at, TotalCalls: a.totalCalls}
}

// nowFunc is overridable in tests.
var nowFunc = time.Now

// technicianPersona primes any connecting client as a repair technician +
// educator. Prepended to boardripperInstructions so every initialize carries
// it. Names kb_search (the Phase 3 knowledge-base search tool) alongside the
// other reference-data tools.
const technicianPersona = `You are acting as an electronics repair technician working a live board in BoardRipper. Understand the circuit before you judge it: build a mental model step by step from what the board and its schematic actually show, form hypotheses, and test them with measurements rather than guessing. Work incrementally — identify the board, map its power domains, follow the suspect signal, narrow down. You have eyes (board_snapshot, pdf_page_image), the schematic and its text (pdf_page_text, pdf_search_open, pdf_search), the netlist/parts, reference data (obd_*), a knowledge base (kb_search), and a shared worklist to record findings and ask the user to probe. Prefer evidence over assumption; when unsure, request a measurement and wait. Never guess — don't invent a net's function, a part's role, or an expected value you don't have; if you must infer, say so and lower your confidence. Treat unlabeled / auto-named nets as low-trust: they carry no meaning, so infer their role only from what they connect to, say you're inferring, and confirm before acting on it.

When you request measurements, be economical and correct: don't ask for the same electrical node twice — nets bridged by a populated 0Ω resistor or closed jumper are one node (but have the user confirm the link if it may be unpopulated). Pick the meter mode that fits the target: diode mode for data lines, not for power rails or CPU/GPU phases (there it reads low and meter-dependent); use voltage or resistance-to-ground for rails; reserve continuity mode for continuity only. Remind the user to power down before resistance/diode probing and to re-check any abnormal reading — but calibrate these safety reminders to their apparent skill and drop them for an evidently experienced tech.

Teach as you fix. Explain your reasoning and the circuit in plain terms, calibrated to the user's level — enough that they learn why, not just what. Ground every explanation in the board (nets/parts as [n:NET] / [p:REFDES:PIN] chips, the schematic to point at the actual circuit), and define jargon the first time you use it. Safety-reminder verbosity, explanation depth, and terseness of findings all move together off one read of the user's expertise: teach a beginner, stay terse for an expert.`

// boardripperInstructions is the server-level orientation sent in the MCP
// initialize response so every client (not just Claude Code users) understands
// the available workflow and how to drive the worklist loop.
const boardripperInstructions = `BoardRipper exposes the PCB board open in the user's browser, plus a shared repair "worklist". Tools act on the most-recently-focused browser tab (list tabs with board_sessions; every live tool takes an optional session). Many read tools work with no board too (pdf_search, obd_match/obd_data, board_resolve, file_list/file_get).

Inspect the board: list_parts / list_nets / find_parts (by description), part_info, net_info, net_neighbors, pin_connectivity. Drive the UI (only when the user enabled drive-UI; otherwise these no-op): highlight_net, clear_highlight, select_part, set_side, pdf_goto.

The worklist is a shared, two-way repair record — a "case" the user and you build together. It is source-agnostic: you can populate it OR review one the user built by hand and suggest next steps.
- Read it: worklist_get (parts/nets with repair marks + notes, ticket note, measurements, transcript). get_measurements returns net readings — BOTH user-recorded and agent-requested (filter by status=requested|recorded or source=agent|user).
- Build it: worklist_add / worklist_update (parts or nets, with a repair mark + note), worklist_set_list_note (your diagnosis summary). Notes accept [n:NET] and [p:REFDES:PIN] chips that are clickable on the board.
- Measurements: request_measurement asks the user to probe a target. target=net shows an inline V/Diode/Ω field on that net's row (kind=voltage|diode|resistance); target=part/pin is posted to the relay transcript. The user fills it in; read the result later with get_measurements.
- Talk to the user: post_message (a short note into the worklist transcript — keep full prose in chat), get_user_messages (what the user typed back; defaults to unread).

Typical loop: read the worklist / measurements -> add suspect parts+nets with marks -> request the measurements you need -> wait, then get_measurements -> narrow down -> worklist_set_list_note with the conclusion. To review a user-built worklist, start by reading worklist_get + get_measurements (you will see their source='user' readings), then suggest next probes via request_measurement and a post_message summary.`

// Deps is the set of backend stores the tools read from. Optional stores
// (PDF/Boards/OBD) may be left nil — the corresponding tools are then skipped.
// IMPORTANT: pass an untyped nil (do not assign a typed-nil pointer) so the
// nil checks below behave correctly.
type Deps struct {
	State  *State
	Bridge *Bridge
	PDF    PDFSearcher
	Files  FileStore
	Boards BoardResolver
	OBD    ObdStore
	// FileBytes reads a library file's bytes by id (path-sandboxed eager read).
	// Left nil disables file_download. Returns filename + MIME alongside bytes.
	FileBytes func(ctx context.Context, id int64) (data []byte, name, mime string, err error)
}

// Server wraps the SDK MCP server plus its Streamable HTTP handler.
type Server struct {
	deps *Deps
	mcp  *mcp.Server
	http *mcp.StreamableHTTPHandler
	act  *activity
	kb   []kbChunk
}

type pingResult struct {
	OK      bool   `json:"ok"`
	Service string `json:"service"`
}

// New builds the MCP server and registers all tools.
func New(deps *Deps) *Server {
	s := &Server{deps: deps, act: &activity{}}
	s.mcp = mcp.NewServer(&mcp.Implementation{Name: "boardripper", Version: "1"}, &mcp.ServerOptions{Instructions: technicianPersona + "\n\n" + boardripperInstructions})

	// Record tool usage centrally for the Settings live-status panel.
	s.mcp.AddReceivingMiddleware(func(next mcp.MethodHandler) mcp.MethodHandler {
		return func(ctx context.Context, method string, req mcp.Request) (mcp.Result, error) {
			if method == "tools/call" {
				if r, ok := req.(*mcp.CallToolRequest); ok && r.Params != nil {
					s.act.record(r.Params.Name)
				}
			}
			return next(ctx, method, req)
		}
	})

	mcp.AddTool(s.mcp, &mcp.Tool{
		Name:        "ping",
		Description: "Health check; returns ok.",
		Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true},
	}, func(ctx context.Context, _ *mcp.CallToolRequest, _ struct{}) (*mcp.CallToolResult, pingResult, error) {
		return nil, pingResult{OK: true, Service: "boardripper"}, nil
	})

	registerNativeTools(s.mcp, deps)
	registerLiveTools(s.mcp, deps)

	if chunks, err := loadKB(); err == nil {
		s.kb = chunks
		registerKBResources(s.mcp, chunks)
		registerKBSearch(s.mcp, s.kb)
	}

	registerPrompts(s.mcp)

	s.http = mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return s.mcp }, nil)
	return s
}

// Handler returns the Streamable HTTP handler for mounting at /api/mcp.
func (s *Server) Handler() http.Handler { return s.http }

// Activity returns a snapshot of recent MCP tool usage.
func (s *Server) Activity() ActivitySnapshot { return s.act.snapshot() }

// SelfTest exercises the MCP stack in-process (a real client over an in-memory
// transport) and returns the advertised tool names. Powers the Settings
// "Test connection" button — proves the server responds and tools are wired
// without needing an external client.
func (s *Server) SelfTest(ctx context.Context) ([]string, error) {
	ct, st := mcp.NewInMemoryTransports()
	ss, err := s.mcp.Connect(ctx, st, nil)
	if err != nil {
		return nil, err
	}
	defer ss.Close()
	client := mcp.NewClient(&mcp.Implementation{Name: "selftest", Version: "1"}, nil)
	cs, err := client.Connect(ctx, ct, nil)
	if err != nil {
		return nil, err
	}
	defer cs.Close()
	lt, err := cs.ListTools(ctx, nil)
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(lt.Tools))
	for _, t := range lt.Tools {
		names = append(names, t.Name)
	}
	return names, nil
}

// errResult builds a tool-level error result (visible to the model so it can
// self-correct), with no structured output.
func errResult(msg string) *mcp.CallToolResult {
	return &mcp.CallToolResult{
		IsError: true,
		Content: []mcp.Content{&mcp.TextContent{Text: msg}},
	}
}
