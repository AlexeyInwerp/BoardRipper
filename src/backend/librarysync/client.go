package librarysync

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// userAgent identifies BoardRipper to upstream HTTP servers.
const userAgent = "BoardRipper/sync"

// allowPrivateNetwork is true when the operator explicitly opts in to
// syncing from RFC1918 / loopback / link-local destinations. Default
// false because the sync_url is operator-supplied and a hostile or
// CSRF'd value pointing at 127.0.0.1 or 169.254.169.254 turns sync into
// an SSRF beachhead onto the host network (metadata service, internal
// DSM API, sibling containers). LAN-to-LAN sync is a legitimate
// self-hosted use case — operators flip BR_SYNC_ALLOW_PRIVATE_NETWORK=1
// to re-enable it.
var allowPrivateNetwork = os.Getenv("BR_SYNC_ALLOW_PRIVATE_NETWORK") == "1"

// errPrivateNetworkRefused is returned by the SSRF-guarded dialer when
// the resolved IP is private and the env-var opt-in is not set.
var errPrivateNetworkRefused = errors.New(
	"refusing to dial private/loopback address (set BR_SYNC_ALLOW_PRIVATE_NETWORK=1 to allow)")

// isPrivateOrLocal returns true for any IP we consider "internal":
// RFC1918, loopback, link-local (including AWS-metadata 169.254.169.254),
// ULA, and the IPv4-mapped equivalents.
func isPrivateOrLocal(ip net.IP) bool {
	if ip == nil {
		return false
	}
	if ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() ||
		ip.IsPrivate() || ip.IsUnspecified() || ip.IsMulticast() {
		return true
	}
	return false
}

// safeDialContext gates Dial on the SSRF check. Resolves the destination
// host (which may itself be a hostname pointing at a private IP — the
// "DNS rebinding" trick), then refuses if any resolved address lands in
// private space and the opt-in env var is unset.
func safeDialContext(ctx context.Context, network, address string) (net.Conn, error) {
	if allowPrivateNetwork {
		return (&net.Dialer{Timeout: 30 * time.Second}).DialContext(ctx, network, address)
	}
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return nil, err
	}
	ips, err := (&net.Resolver{}).LookupIP(ctx, "ip", host)
	if err != nil {
		return nil, err
	}
	for _, ip := range ips {
		if isPrivateOrLocal(ip) {
			return nil, errPrivateNetworkRefused
		}
	}
	// Re-dial against the resolved address (use the first non-private
	// hit) so the kernel doesn't repeat the DNS lookup and possibly
	// get a different answer on the second try (DNS rebinding).
	first := ips[0]
	return (&net.Dialer{Timeout: 30 * time.Second}).DialContext(ctx, network, net.JoinHostPort(first.String(), port))
}

// httpClient is a package-shared client with a generous timeout. The timeout
// is the wall-clock budget per request including redirect chain and body
// download, which matters because some manifests reference multi-hundred-MB
// schematics. Cancellation is also wired through context for explicit stop.
//
// Two security knobs:
//   - SSRF guard via safeDialContext (blocks private IPs by default).
//   - Redirect cap of 3 so a malicious mirror can't 302-chain us into
//     an internal target.
var httpClient = &http.Client{
	Timeout: 5 * time.Minute,
	Transport: &http.Transport{
		DialContext:           safeDialContext,
		MaxIdleConns:          10,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   30 * time.Second,
		ResponseHeaderTimeout: 30 * time.Second,
	},
	CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 3 {
			return errors.New("too many redirects")
		}
		return nil
	},
}

// fetch performs an HTTP request against rawURL with optional Basic auth.
// It returns the *http.Response with the body still open — caller must Close.
func fetch(ctx context.Context, method, rawURL, user, pass string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, rawURL, nil)
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("User-Agent", userAgent)
	if user != "" {
		req.SetBasicAuth(user, pass)
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	return resp, nil
}

// pathEncode URL-encodes each path segment of p but preserves "/" separators
// so the resulting string can be appended directly to a base URL. Unlike
// url.PathEscape on the whole string, this is safe for nested directories.
func pathEncode(p string) string {
	parts := strings.Split(p, "/")
	for i, seg := range parts {
		parts[i] = url.PathEscape(seg)
	}
	return strings.Join(parts, "/")
}

// joinURL appends a relative path to base, ensuring exactly one slash between
// them. The relative portion is URL-encoded segment-by-segment.
func joinURL(base, rel string) string {
	base = strings.TrimRight(base, "/")
	rel = strings.TrimLeft(rel, "/")
	if rel == "" {
		return base
	}
	return base + "/" + pathEncode(rel)
}

// FetchManifestForTest performs an authenticated GET of <baseURL>/manifest.txt
// and returns the raw *http.Response. Caller is responsible for closing the
// body. Used by /api/sync/test which only needs to probe the first 1 KiB.
func FetchManifestForTest(ctx context.Context, baseURL, user, pass string) (*http.Response, error) {
	baseURL = strings.TrimRight(baseURL, "/")
	return fetch(ctx, http.MethodGet, baseURL+"/manifest.txt", user, pass)
}
