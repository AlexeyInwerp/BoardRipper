package mcpserver

import (
	"context"
	"encoding/json"
	"sort"
	"strings"
	"unicode"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// WorklistStore is the slice of worklists.Store the native worklist tools
// need: every document, and one by id. Worklists live on the server since
// 2026-11-10 (docs/specs/2026-11-10-worklist-storage-redesign.md), so an
// agent can read them with no browser open.
type WorklistStore interface {
	List(since int64) ([]json.RawMessage, int64)
	Get(id string) (json.RawMessage, error)
}

type worklistListArgs struct {
	Query string `json:"query,omitempty" jsonschema:"optional: words that must all appear in the worklist's name, board name or tags (case and separators ignored), e.g. '820-02016' or 'A2337 water'"`
}
type worklistSummary struct {
	ID        string   `json:"id"`
	Name      string   `json:"name"`
	Board     string   `json:"board"`
	Tags      []string `json:"tags"`
	Parts     int      `json:"parts"`
	Nets      int      `json:"nets"`
	UpdatedAt int64    `json:"updated_at"`
}
type worklistListResult struct {
	Worklists []worklistSummary `json:"worklists"`
	Total     int               `json:"total"`
}
type worklistReadArgs struct {
	ID string `json:"id" jsonschema:"worklist id from worklist_list"`
}
type worklistReadResult struct {
	Worklist map[string]any `json:"worklist"`
}

// looseKey drops case and everything but letters, digits and '+', the same
// rule the frontend's loose search uses.
func looseKey(s string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(s) {
		if unicode.IsLetter(r) || unicode.IsDigit(r) || r == '+' {
			b.WriteRune(r)
		}
	}
	return b.String()
}

func liveRows(v any) int {
	rows, _ := v.([]any)
	n := 0
	for _, r := range rows {
		if m, ok := r.(map[string]any); ok && m["removed"] == nil {
			n++
		}
	}
	return n
}

func registerWorklistTools(s *mcp.Server, store WorklistStore) {
	mcp.AddTool(s, &mcp.Tool{
		Name:        "worklist_list",
		Description: "List every repair worklist stored on this BoardRipper (not just the open board's), newest first: id, name, the board name it is attributed to, tags, part/net counts. Filter with query (matches name, board name or tags). Works with no browser open. Read one with worklist_read.",
		Annotations: ro(true),
	}, func(_ context.Context, _ *mcp.CallToolRequest, a worklistListArgs) (*mcp.CallToolResult, worklistListResult, error) {
		docs, _ := store.List(0)
		var words []string
		for _, w := range strings.Fields(a.Query) {
			if k := looseKey(w); k != "" {
				words = append(words, k)
			}
		}
		out := []worklistSummary{}
		for _, raw := range docs {
			var d map[string]any
			if json.Unmarshal(raw, &d) != nil || d["deleted"] != nil {
				continue
			}
			sum := worklistSummary{Parts: liveRows(d["entries"]), Nets: liveRows(d["netEntries"])}
			sum.ID, _ = d["id"].(string)
			sum.Name, _ = d["name"].(string)
			sum.Board, _ = d["board"].(string)
			if f, ok := d["updatedAt"].(float64); ok {
				sum.UpdatedAt = int64(f)
			}
			for _, t := range asSlice(d["tags"]) {
				if ts, ok := t.(string); ok {
					sum.Tags = append(sum.Tags, ts)
				}
			}
			hay := looseKey(sum.Name + " " + sum.Board + " " + strings.Join(sum.Tags, " "))
			ok := true
			for _, w := range words {
				if !strings.Contains(hay, w) {
					ok = false
					break
				}
			}
			if ok {
				out = append(out, sum)
			}
		}
		sort.Slice(out, func(i, j int) bool { return out[i].UpdatedAt > out[j].UpdatedAt })
		return nil, worklistListResult{Worklists: out, Total: len(out)}, nil
	})

	mcp.AddTool(s, &mcp.Tool{
		Name:        "worklist_read",
		Description: "Read one stored worklist by id (from worklist_list): name, board name, tags, part and net rows with marks, notes and readings, ticket note, message transcript. Rows marked 'removed' were deleted. Works with no browser open; to edit the worklist loaded on the open board use the live worklist tools.",
		Annotations: ro(true),
	}, func(_ context.Context, _ *mcp.CallToolRequest, a worklistReadArgs) (*mcp.CallToolResult, worklistReadResult, error) {
		raw, err := store.Get(a.ID)
		if err != nil {
			return errResult("no worklist with that id"), worklistReadResult{Worklist: map[string]any{}}, nil
		}
		var d map[string]any
		if err := json.Unmarshal(raw, &d); err != nil || d["deleted"] != nil {
			return errResult("no worklist with that id"), worklistReadResult{Worklist: map[string]any{}}, nil
		}
		return nil, worklistReadResult{Worklist: d}, nil
	})
}

func asSlice(v any) []any { s, _ := v.([]any); return s }
