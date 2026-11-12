package assistant

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"boardripper/mcpserver"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// Tools the in-app assistant does not get. The chat itself is the transcript
// (post_message, get_user_messages), the MCP session already targets this
// browser (board_sessions), and raw file downloads are large binaries a model
// cannot use from a tool result (pdf_download, file_download).
var excludedTools = map[string]bool{
	"post_message": true, "get_user_messages": true, "board_sessions": true,
	"pdf_download": true, "file_download": true, "ping": true,
}

// maxToolText bounds one tool result's text. A whole netlist can be several
// hundred kilobytes; the model is told it was cut and can page instead.
const maxToolText = 40000

// toolDef is a tool as the providers need it.
type toolDef struct {
	Name        string
	Description string
	Schema      map[string]any
}

// toolOutput is a tool result in provider-neutral form.
type toolOutput struct {
	Text    string
	Images  []toolImage
	IsError bool
}

type toolImage struct {
	MIME string
	Data []byte
}

func listTools(ctx context.Context, cs *mcp.ClientSession) ([]toolDef, error) {
	lt, err := cs.ListTools(ctx, nil)
	if err != nil {
		return nil, err
	}
	var out []toolDef
	for _, t := range lt.Tools {
		if excludedTools[t.Name] {
			continue
		}
		schema := map[string]any{"type": "object", "properties": map[string]any{}}
		if t.InputSchema != nil {
			if b, err := json.Marshal(t.InputSchema); err == nil {
				var m map[string]any
				if json.Unmarshal(b, &m) == nil && m != nil {
					schema = m
				}
			}
		}
		// The session is already scoped to this browser; don't invite the
		// model to pick another one.
		if props, ok := schema["properties"].(map[string]any); ok {
			delete(props, "session")
		}
		out = append(out, toolDef{Name: t.Name, Description: t.Description, Schema: schema})
	}
	return out, nil
}

func callTool(ctx context.Context, cs *mcp.ClientSession, name string, args map[string]any) toolOutput {
	res, err := cs.CallTool(ctx, &mcp.CallToolParams{Name: name, Arguments: args})
	if err != nil {
		return toolOutput{Text: "tool error: " + err.Error(), IsError: true}
	}
	var out toolOutput
	out.IsError = res.IsError
	var texts []string
	for _, c := range res.Content {
		switch v := c.(type) {
		case *mcp.TextContent:
			texts = append(texts, v.Text)
		case *mcp.ImageContent:
			out.Images = append(out.Images, toolImage{MIME: v.MIMEType, Data: v.Data})
		}
	}
	if len(texts) == 0 && res.StructuredContent != nil {
		if b, err := json.Marshal(res.StructuredContent); err == nil {
			texts = append(texts, string(b))
		}
	}
	out.Text = strings.Join(texts, "\n")
	if len(out.Text) > maxToolText {
		out.Text = out.Text[:maxToolText] + fmt.Sprintf("\n…[cut at %d characters; ask for less, e.g. with a filter, limit or offset]", maxToolText)
	}
	if out.Text == "" && len(out.Images) == 0 {
		out.Text = "(no result)"
	}
	return out
}

// approvalKind says what the user must allow before a tool runs: "" (nothing,
// it only reads), "drive" (changes what the board or PDF shows) or "edit"
// (writes to the worklist).
func approvalKind(name string) string {
	if !mcpserver.IsMutatingTool(name) {
		return ""
	}
	if mcpserver.ToolGroupOf(name) == "drive" {
		return "drive"
	}
	return "edit"
}
