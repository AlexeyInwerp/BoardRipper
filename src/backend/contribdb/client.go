package contribdb

import (
	"net/http"
	"time"

	"boardripper/databank"
)

// Client wraps an HTTP client with sane timeouts plus the helpers needed to
// inject the install-token and (optionally) user-token auth headers.
type Client struct {
	baseURL      string
	installToken string
	db           *databank.DB
	http         *http.Client
}

// NewClient builds a contribdb HTTP client. baseURL is the canonical-server
// origin (e.g. https://www.ripperdoc.de). installToken is the persisted
// plaintext from .contrib-secret. db is consulted for the optional user
// token (config key contribdb_user_token).
func NewClient(baseURL, installToken string, db *databank.DB) *Client {
	return &Client{
		baseURL:      baseURL,
		installToken: installToken,
		db:           db,
		http: &http.Client{
			// Timeout per request (read+write). Snapshot tarball download
			// uses a per-request override via context, so this is the
			// fallback for everything else.
			Timeout: 60 * time.Second,
		},
	}
}

// userAgent returns a value safe to send on every request. Mirrors the obd
// scraper's UA shape so server-side log analytics can group BoardRipper
// installs by version.
func (c *Client) userAgent() string {
	return "BoardRipper-contribdb/dev (+https://www.ripperdoc.de)"
}

// userToken reads the optional user token from the databank config. Returns
// empty when unset.
func (c *Client) userToken() string {
	if c.db == nil {
		return ""
	}
	v, _ := c.db.GetConfig("contribdb_user_token")
	return v
}

// setAuth applies the install-token header and, if configured, the
// user-token bearer. Both can be present at once — per spec §5.3 the
// server gives user identity precedence for attribution and records the
// install fingerprint alongside.
func (c *Client) setAuth(req *http.Request) {
	if c.installToken != "" {
		req.Header.Set("X-BoardRipper-Install-Token", c.installToken)
	}
	if ut := c.userToken(); ut != "" {
		req.Header.Set("Authorization", "Bearer "+ut)
	}
	req.Header.Set("User-Agent", c.userAgent())
}

// BaseURL returns the configured canonical-server base URL.
func (c *Client) BaseURL() string {
	if c == nil {
		return ""
	}
	return c.baseURL
}

// Do is a thin wrapper that sets auth headers then dispatches via the
// inner http.Client. Callers build the request themselves so they retain
// control over the body, context, and method.
func (c *Client) Do(req *http.Request) (*http.Response, error) {
	c.setAuth(req)
	return c.http.Do(req)
}
