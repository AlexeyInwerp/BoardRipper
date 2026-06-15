package mcpserver

import (
	"crypto/subtle"
	"fmt"
	"log"
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

// GateAuto enforces the enable flag and then the per-request auth scheme:
// OAuth bearer-token verification when AuthMode()=="oauth" (with the proper
// 401 + WWW-Authenticate → protected-resource-metadata challenge), otherwise
// the static bearer secret. 404 when disabled.
func GateAuto(st *State, secret string, oauth *OAuth, next http.Handler) http.Handler {
	secretB := []byte(secret)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !st.Enabled() {
			http.NotFound(w, r)
			return
		}
		if st.AuthMode() == "oauth" {
			// Explicit verification (no scope requirement — token presence is the
			// grant) with the proper challenge + a diagnostic log on rejection.
			tok := strings.TrimSpace(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
			info, err := oauth.Verifier()(r.Context(), tok, r)
			if err != nil || info == nil {
				log.Printf("mcp oauth: rejected %s %s (token_len=%d, reason=%v)", r.Method, r.URL.Path, len(tok), err)
				w.Header().Set("WWW-Authenticate", fmt.Sprintf("Bearer resource_metadata=%q", oauth.ResourceMetadataURL(r)))
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}
			next.ServeHTTP(w, r)
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
