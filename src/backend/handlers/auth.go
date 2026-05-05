package handlers

import "net/http"

const updateCookieName = "br_update_token"

// WithUpdateAuth wraps next with auth: passes if either the
// X-BoardRipper-Update-Token header or the br_update_token cookie matches.
func WithUpdateAuth(secret string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-BoardRipper-Update-Token") == secret {
			next.ServeHTTP(w, r); return
		}
		if c, err := r.Cookie(updateCookieName); err == nil && c.Value == secret {
			next.ServeHTTP(w, r); return
		}
		w.WriteHeader(401)
	})
}

// BootstrapHandler sets the br_update_token cookie. Frontend calls this once
// on first UI load; subsequent /api/update/* calls accept the cookie.
type BootstrapHandler struct{ secret string }

func NewBootstrapHandler(secret string) *BootstrapHandler { return &BootstrapHandler{secret: secret} }

func (h *BootstrapHandler) Serve(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{
		Name:     updateCookieName,
		Value:    h.secret,
		Path:     "/api/update/",
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
	})
	w.WriteHeader(204)
}
