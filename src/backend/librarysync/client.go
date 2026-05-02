package librarysync

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// userAgent identifies BoardRipper to upstream HTTP servers.
const userAgent = "BoardRipper/sync"

// httpClient is a package-shared client with a generous timeout. The timeout
// is the wall-clock budget per request including redirect chain and body
// download, which matters because some manifests reference multi-hundred-MB
// schematics. Cancellation is also wired through context for explicit stop.
var httpClient = &http.Client{
	Timeout: 5 * time.Minute,
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
