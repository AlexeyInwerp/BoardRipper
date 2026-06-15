package mcpserver

import (
	"context"
	"encoding/json"
	"net/http"
	"time"
)

// StatusHandler reports enable state + live usage for the SPA bootstrap and the
// Settings ▸ Integrations panel. It never returns the secret. Unauthenticated
// (no sensitive data). srv may be nil (activity omitted).
func StatusHandler(st *State, b *Bridge, srv *Server) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		clients := 0
		if b != nil {
			clients = b.ClientCount()
		}
		out := map[string]any{
			"enabled":  st.Enabled(),
			"drive_ui": st.DriveUI(),
			"clients":  clients,
		}
		if srv != nil {
			out["activity"] = srv.Activity()
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(out)
	}
}

// TokenHandler returns the bearer token for display in Settings. Returns 404
// when MCP is disabled. Same-origin/CSRF protections from the standard
// middleware stack apply; meaningful only to the local operator on a trusted LAN.
func TokenHandler(st *State, secret string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !st.Enabled() {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"token": secret})
	}
}

// SelfTestHandler powers the Settings "Test connection" button: runs an
// in-process MCP round trip and returns {ok, tools:[...]}. 404 when disabled.
func SelfTestHandler(st *State, srv *Server) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !st.Enabled() || srv == nil {
			http.NotFound(w, r)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()
		tools, err := srv.SelfTest(ctx)
		w.Header().Set("Content-Type", "application/json")
		if err != nil {
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": err.Error()})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "tools": tools, "count": len(tools)})
	}
}
