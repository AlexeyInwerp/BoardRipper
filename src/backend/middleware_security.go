package main

import (
	"net/http"
	"net/url"
	"strings"
)

// withSecurityHeaders applies a baseline of conservative response headers
// to every response. These are belt-and-suspenders defaults — they don't
// replace per-endpoint authentication but shut down whole classes of
// drive-by attack (clickjacking, MIME-sniffing, Referer leakage).
//
// Intentionally minimal:
//   - X-Content-Type-Options: nosniff — stops MIME-sniffing attacks on
//     served board files / PDFs where the file's first bytes could fool
//     a browser into interpreting `text/plain` as HTML.
//   - X-Frame-Options: DENY — the SPA does not embed itself; blocks
//     clickjacking of state-changing endpoints.
//   - Referrer-Policy: no-referrer — operators on private networks
//     shouldn't leak the server URL out to external links they click.
//
// A full Content-Security-Policy is intentionally deferred — the SPA's
// inline styles and lazy-loaded Vite chunks need testing before locking
// down sources, and a misconfigured CSP silently breaks the UI.
func withSecurityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "no-referrer")
		next.ServeHTTP(w, r)
	})
}

// withCSRFCheck rejects unsafe-method requests (POST/PUT/PATCH/DELETE)
// whose Origin or Referer doesn't match the request Host. Stops the
// classic drive-by CSRF: a browser visiting attacker.example loads
// `<form action="http://your-nas:8081/api/sync/start" method=POST>`
// and the user's still-logged-in session executes it. With this gate
// the browser-supplied Origin header reveals the cross-origin request
// and we refuse to act.
//
// Programmatic clients (curl, fetch from server-side scripts) typically
// send no Origin and no Referer. Those are accepted — the gate is
// specifically a browser-CSRF defence, not a general-purpose auth
// mechanism. Endpoints that need authentication apply their own
// auth-middleware on top (e.g. WithUpdateAuth on /api/update/*).
//
// GET/HEAD/OPTIONS are passed through unchanged: by HTTP spec these
// must be safe / idempotent, so even a cross-origin GET cannot mutate
// state. (The frontend never uses GET for mutations.)
func withCSRFCheck(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet, http.MethodHead, http.MethodOptions:
			next.ServeHTTP(w, r)
			return
		}
		// MCP + its OAuth handshake are authenticated by Authorization header
		// (bearer / OAuth access token) or are the OAuth bootstrap itself — they
		// are not cookie-authenticated, so the cookie-oriented CSRF check does
		// not apply and would wrongly reject the OAuth client's cross-origin
		// register/token POSTs (which carry the client's loopback callback Origin).
		if p := r.URL.Path; strings.HasPrefix(p, "/api/mcp") || strings.HasPrefix(p, "/.well-known/oauth-") {
			next.ServeHTTP(w, r)
			return
		}
		origin := r.Header.Get("Origin")
		referer := r.Header.Get("Referer")
		if origin == "" && referer == "" {
			// curl / non-browser client — let it through.
			next.ServeHTTP(w, r)
			return
		}
		if origin != "" && !sameOriginHost(origin, r.Host) {
			http.Error(w, "cross-origin request rejected", http.StatusForbidden)
			return
		}
		if origin == "" && !sameOriginHost(referer, r.Host) {
			http.Error(w, "cross-origin request rejected", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// sameOriginHost returns true when the given URL's host matches the
// expected host. The URL may be an Origin (`https://host:port`) or a
// Referer (`https://host:port/path?…`). Port differences count — a
// reverse proxy on :443 doesn't match a direct hit on :8081 by accident.
func sameOriginHost(rawURL, expectedHost string) bool {
	if rawURL == "" {
		return false
	}
	u, err := url.Parse(rawURL)
	if err != nil || u.Host == "" {
		return false
	}
	// Strip any trailing dot (some browsers send "host." in Origin).
	got := strings.TrimSuffix(u.Host, ".")
	want := strings.TrimSuffix(expectedHost, ".")
	return strings.EqualFold(got, want)
}
