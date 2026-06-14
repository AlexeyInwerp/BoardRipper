package mcpserver

import (
	"context"
	"net/http"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

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
}

type pingResult struct {
	OK      bool   `json:"ok"`
	Service string `json:"service"`
}

// New builds the MCP server and registers all tools.
func New(deps *Deps) *Server {
	s := &Server{deps: deps}
	s.mcp = mcp.NewServer(&mcp.Implementation{Name: "boardripper", Version: "1"}, nil)

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

// errResult builds a tool-level error result (visible to the model so it can
// self-correct), with no structured output.
func errResult(msg string) *mcp.CallToolResult {
	return &mcp.CallToolResult{
		IsError: true,
		Content: []mcp.Content{&mcp.TextContent{Text: msg}},
	}
}
