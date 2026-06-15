package mcpserver

import (
	"crypto/subtle"
	"net/http"
	"strings"

	"github.com/modelcontextprotocol/go-sdk/auth"
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
			opts := &auth.RequireBearerTokenOptions{
				ResourceMetadataURL: oauth.ResourceMetadataURL(r),
				Scopes:              []string{oauthScope},
			}
			auth.RequireBearerToken(oauth.Verifier(), opts)(next).ServeHTTP(w, r)
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
