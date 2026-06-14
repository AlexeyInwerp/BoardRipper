package mcpserver

import (
	"encoding/json"
	"net/http"
)

// StatusHandler reports enable state for the SPA bootstrap and Settings UI. It
// never returns the secret. Unauthenticated (no sensitive data).
func StatusHandler(st *State, b *Bridge) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		clients := 0
		if b != nil {
			clients = b.ClientCount()
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"enabled":  st.Enabled(),
			"drive_ui": st.DriveUI(),
			"clients":  clients,
		})
	}
}

// TokenHandler returns the bearer token for display in Settings. Returns 404
// when MCP is disabled. Same-origin/CSRF protections from the standard
// middleware stack apply; it is meaningful only to the local operator viewing
// their own Settings on a trusted LAN.
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
