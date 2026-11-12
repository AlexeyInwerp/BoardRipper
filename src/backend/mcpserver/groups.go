package mcpserver

import (
	"net/http"
	"strings"
)

// Tool groups let a connection ask for fewer tools through the server URL:
//
//	/api/mcp?tools=board,drive,pdf,worklist   only those groups
//	/api/mcp?read_only=1                      no tool that changes anything
//
// Every tool description a client loads costs the model context, and some
// clients cap the number they pass on (Cursor is reported to send only the
// first 40). An editor-side agent rarely needs the library and knowledge-base
// tools, so its recipe asks for less. No parameter means every tool.
var toolGroup = map[string]string{
	"ping": "board", "board_sessions": "board", "board_active": "board", "board_overview": "board",
	"list_nets": "board", "list_parts": "board", "net_info": "board", "net_neighbors": "board",
	"pin_connectivity": "board", "part_info": "board", "selected_part": "board", "board_tabs": "board",
	"find_parts": "board", "board_snapshot": "board",

	"highlight_net": "drive", "clear_highlight": "drive", "select_part": "drive", "set_side": "drive",
	"pdf_goto": "drive", "switch_tab": "drive", "open_file": "drive",

	"pdf_page_text": "pdf", "pdf_search_open": "pdf", "pdf_download": "pdf", "pdf_page_image": "pdf",
	"pdf_search": "pdf",

	"worklist_get": "worklist", "get_measurements": "worklist", "get_user_messages": "worklist",
	"worklist_add": "worklist", "worklist_update": "worklist", "worklist_set_list_note": "worklist",
	"request_measurement": "worklist", "post_message": "worklist", "worklist_list": "worklist",
	"worklist_read": "worklist",

	"obd_match": "library", "obd_data": "library", "board_resolve": "library", "file_list": "library",
	"file_get": "library", "file_download": "library", "kb_search": "library",
}

// ToolGroups is the list the Settings UI and the recipes offer, in order.
var ToolGroups = []string{"board", "drive", "pdf", "worklist", "library"}

// mutatingTools change the board view, the PDF view or the worklist. Kept in
// step with the ro(false) registrations by TestToolGroupsCoverEveryTool.
var mutatingTools = map[string]bool{
	"highlight_net": true, "clear_highlight": true, "select_part": true, "set_side": true,
	"pdf_goto": true, "switch_tab": true, "open_file": true,
	"worklist_add": true, "worklist_update": true, "worklist_set_list_note": true,
	"request_measurement": true, "post_message": true,
}

// toolFilter reads ?tools= and ?read_only= from the request URL.
func toolFilter(r *http.Request) (groups map[string]bool, readOnly bool) {
	q := r.URL.Query()
	if v := strings.TrimSpace(q.Get("tools")); v != "" {
		groups = map[string]bool{}
		for _, g := range strings.Split(v, ",") {
			if g = strings.ToLower(strings.TrimSpace(g)); g != "" {
				groups[g] = true
			}
		}
	}
	switch strings.ToLower(q.Get("read_only")) {
	case "1", "true", "yes":
		readOnly = true
	}
	return groups, readOnly
}

// allowsTool reports whether the connection's tool filter admits name. A tool
// missing from the table belongs to no group: it is shown only when no group
// filter is set, so a new tool is never silently hidden from a plain URL.
func (sc Scope) allowsTool(name string) bool {
	if sc.ReadOnly && mutatingTools[name] {
		return false
	}
	if sc.Groups == nil {
		return true
	}
	return sc.Groups[toolGroup[name]]
}
