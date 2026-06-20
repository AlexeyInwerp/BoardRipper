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
}

// Server wraps the SDK MCP server plus its Streamable HTTP handler.
type Server struct {
	deps *Deps
	mcp  *mcp.Server
	http *mcp.StreamableHTTPHandler
	act  *activity
}

type pingResult struct {
	OK      bool   `json:"ok"`
	Service string `json:"service"`
}

// New builds the MCP server and registers all tools.
func New(deps *Deps) *Server {
	s := &Server{deps: deps, act: &activity{}}
	s.mcp = mcp.NewServer(&mcp.Implementation{Name: "boardripper", Version: "1"}, nil)

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
