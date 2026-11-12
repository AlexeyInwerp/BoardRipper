package mcpserver

import (
	"net"
	"net/http"
	"os"
	"strings"
)

// DNS rebinding: a web page on attacker.example can make its own hostname
// resolve to this server's LAN address. The browser then treats requests to
// the server as same-origin and lets the page read the answers — including a
// token minted by /api/mcp/pair. Every header such a request carries is the
// attacker's own, except one thing it cannot fake: the Host is the attacker's
// domain. So the endpoints that hand out or change credentials only answer for
// host names an attacker cannot control (MCP spec, "Security Best Practices").
//
// Allowed without configuration:
//   - IP literals and localhost (a rebinding page always uses a domain name),
//   - single-label names (rd-nas) and the private suffixes .local, .lan,
//     .home, .home.arpa, .internal, .localdomain,
//   - Tailscale MagicDNS names (*.ts.net — resolved by Tailscale, not the attacker),
//   - requests a reverse proxy forwarded over HTTPS (a rebound page cannot
//     present the proxy's certificate),
//   - names listed in BR_ALLOWED_HOSTS (comma-separated, exact or ".suffix").

var privateSuffixes = []string{".local", ".lan", ".home", ".home.arpa", ".internal", ".localdomain", ".ts.net"}

func extraAllowedHosts() []string {
	var out []string
	for _, h := range strings.Split(os.Getenv("BR_ALLOWED_HOSTS"), ",") {
		if h = strings.ToLower(strings.TrimSpace(h)); h != "" {
			out = append(out, h)
		}
	}
	return out
}

// HostAllowed reports whether r's Host is one a rebinding page cannot use.
func HostAllowed(r *http.Request) bool {
	if strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https") {
		return true
	}
	host := r.Host
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	host = strings.ToLower(strings.TrimSuffix(strings.Trim(host, "[]"), "."))
	if host == "" {
		return false
	}
	if host == "localhost" || strings.HasSuffix(host, ".localhost") || net.ParseIP(host) != nil {
		return true
	}
	if !strings.Contains(host, ".") {
		return true
	}
	for _, s := range privateSuffixes {
		if strings.HasSuffix(host, s) {
			return true
		}
	}
	for _, a := range extraAllowedHosts() {
		if host == a || (strings.HasPrefix(a, ".") && strings.HasSuffix(host, a)) {
			return true
		}
	}
	return false
}

// RequireAllowedHost wraps a credential endpoint with HostAllowed.
func RequireAllowedHost(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !HostAllowed(r) {
			http.Error(w, "This address ("+r.Host+") is not on BoardRipper's list of trusted host names, so it will not hand out or change AI credentials here. Open BoardRipper by its IP address or local name, or add the name to BR_ALLOWED_HOSTS.", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}
