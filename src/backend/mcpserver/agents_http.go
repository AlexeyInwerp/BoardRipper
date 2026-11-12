package mcpserver

import (
	"encoding/json"
	"errors"
	"net/http"
)

// AgentsListHandler serves GET /api/agents: the connected-assistants list,
// with each browser's label filled in from the pairings.
func AgentsListHandler(ar *AgentRegistry, ps *PairingStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		type row struct {
			Agent
			BrowserLabel string `json:"browser_label,omitempty"`
			LastSeenMs   int64  `json:"last_seen_ms"`
		}
		out := []row{}
		if ar != nil {
			for _, a := range ar.List() {
				rw := row{Agent: a, LastSeenMs: a.LastSeen.UnixMilli()}
				if ps != nil && a.BrowserID != "" {
					rw.BrowserLabel = ps.LabelFor(a.BrowserID)
				}
				out = append(out, rw)
			}
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"agents": out})
	}
}

// AgentUpdateHandler serves POST /api/agents/update {key, drive, blocked, forget}.
// Outside /api/mcp on purpose: the CSRF same-origin check exempts that prefix
// (bearer-authenticated MCP traffic), and this endpoint changes permissions.
func AgentUpdateHandler(ar *AgentRegistry) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Key string `json:"key"`
			AgentUpdate
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil || req.Key == "" {
			http.Error(w, "bad request body", http.StatusBadRequest)
			return
		}
		if ar == nil {
			http.NotFound(w, r)
			return
		}
		if err := ar.Update(req.Key, req.AgentUpdate); err != nil {
			code := http.StatusInternalServerError
			if errors.Is(err, errNoAgent) {
				code = http.StatusNotFound
			}
			http.Error(w, err.Error(), code)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}
