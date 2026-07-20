package mcpserver

import (
	"context"
	"crypto/subtle"
	"fmt"
	"log"
	"net/http"
	"strings"
)

// Scope is the session visibility resolved from the caller's bearer token.
// The zero value is the SHARED scope (install secret / OAuth token): all
// bridge sessions are visible, matching pre-pairing behavior. This also means
// paths that bypass GateAuto — SelfTest's in-memory transport, unit tests —
// fail open to shared, which is the intended trust model for an internal tool.
type Scope struct {
	// ClientID is the paired browser identity the caller is confined to;
	// empty means shared/unscoped.
	ClientID string
}

// Shared reports whether the caller may reach every session.
func (s Scope) Shared() bool { return s.ClientID == "" }

type scopeKey struct{}

func withScope(ctx context.Context, s Scope) context.Context {
	return context.WithValue(ctx, scopeKey{}, s)
}

// ScopeFrom returns the scope GateAuto attached to the request context, or
// the shared zero value when none was attached.
func ScopeFrom(ctx context.Context) Scope {
	if v, ok := ctx.Value(scopeKey{}).(Scope); ok {
		return v
	}
	return Scope{}
}

// unauthorizedBody explains WHY an old token stopped working and where to get
// a new one — this is the message agents configured before the session
// separation update actually see when their shared token was reset.
const unauthorizedBody = "unauthorized: this MCP token is not valid. The MCP token system was reset by the multi-user session-separation update (resetting the shared credential was the only way to properly migrate). Open BoardRipper Settings > Integrations and reconnect: each browser now has its own \"This browser's agent\" token (recommended), or use the new shared token for cross-session work."

// unauthorizedChallenge is the WWW-Authenticate header for static-token 401s.
// Without it, spec-following MCP clients react to a bare 401 by attempting
// OAuth discovery — which is deliberately hidden (404) in token mode — and
// then surface a confusing "oauth 404" instead of the real reason. RFC 6750
// error_description gives them a human-readable cause to show. Must stay a
// single line with no double quotes inside the description.
const unauthorizedChallenge = `Bearer error="invalid_token", error_description="MCP tokens were reset by the session-separation update. Get a new token in BoardRipper Settings > Integrations. OAuth is disabled on this install (token mode)."`

// writeUnauthorized emits the static-token 401 with both the machine-readable
// challenge and the human-readable explanation.
func writeUnauthorized(w http.ResponseWriter) {
	w.Header().Set("WWW-Authenticate", unauthorizedChallenge)
	http.Error(w, unauthorizedBody, http.StatusUnauthorized)
}

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
			writeUnauthorized(w)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// GateAuto enforces the enable flag and then the per-request auth scheme:
// paired per-browser tokens first (accepted in BOTH auth modes — pairing is
// how multi-user installs separate sessions, independent of how the shared
// credential is issued), then OAuth bearer-token verification when
// AuthMode()=="oauth" (with the proper 401 + WWW-Authenticate →
// protected-resource-metadata challenge), otherwise the static bearer secret.
// The resolved Scope is attached to the request context (ScopeFrom); the
// install secret and OAuth tokens carry the shared scope. 404 when disabled.
func GateAuto(st *State, secret string, pairings *PairingStore, oauth *OAuth, next http.Handler) http.Handler {
	secretB := []byte(secret)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !st.Enabled() {
			http.NotFound(w, r)
			return
		}
		if pairings != nil {
			tok := strings.TrimSpace(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
			if id, ok := pairings.ClientForToken(tok); ok {
				next.ServeHTTP(w, r.WithContext(withScope(r.Context(), Scope{ClientID: id})))
				return
			}
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
			writeUnauthorized(w)
			return
		}
		next.ServeHTTP(w, r)
	})
}
