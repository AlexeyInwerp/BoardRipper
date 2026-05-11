package handlers

import (
	"crypto/subtle"
	"net/http"
)

const updateCookieName = "br_update_token"

// WithUpdateAuth wraps next with auth: passes if either the
// X-BoardRipper-Update-Token header or the br_update_token cookie matches.
// Constant-time compare so the check itself never leaks timing data about
// the per-install secret to a remote attacker.
func WithUpdateAuth(secret string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		secretB := []byte(secret)
		if h := r.Header.Get("X-BoardRipper-Update-Token"); h != "" &&
			subtle.ConstantTimeCompare([]byte(h), secretB) == 1 {
			next.ServeHTTP(w, r)
			return
		}
		if c, err := r.Cookie(updateCookieName); err == nil &&
			subtle.ConstantTimeCompare([]byte(c.Value), secretB) == 1 {
			next.ServeHTTP(w, r)
			return
		}
		w.WriteHeader(401)
	})
}

// BootstrapHandler sets the br_update_token cookie. Frontend calls this once
// on first UI load; subsequent /api/update/* calls accept the cookie.
type BootstrapHandler struct{ secret string }

func NewBootstrapHandler(secret string) *BootstrapHandler { return &BootstrapHandler{secret: secret} }

func (h *BootstrapHandler) Serve(w http.ResponseWriter, r *http.Request) {
	secure := r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https"
	http.SetCookie(w, &http.Cookie{
		Name:     updateCookieName,
		Value:    h.secret,
		Path:     "/api/update/",
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteStrictMode,
	})
	w.WriteHeader(204)
}
