package mcpserver

import (
	"crypto/subtle"
	"net/http"
	"strings"
)

// Gate enforces the enable flag and bearer-token auth in front of the MCP
// handler. When MCP is disabled the endpoint returns 404 so it is invisible to
// scanners. When enabled, requests must carry "Authorization: Bearer <secret>".
func Gate(st *State, secret string, next http.Handler) http.Handler {
	secretB := []byte(secret)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !st.Enabled() {
			http.NotFound(w, r)
			return
		}
		tok := strings.TrimSpace(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
		if subtle.ConstantTimeCompare([]byte(tok), secretB) != 1 {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}
