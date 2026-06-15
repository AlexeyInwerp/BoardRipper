package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// The MCP endpoints + OAuth handshake are Authorization-header authenticated and
// must accept the OAuth client's cross-origin register/token POSTs. Cookie-based
// UI endpoints must still reject cross-origin writes.
func TestCSRF_MCPExemptButUIProtected(t *testing.T) {
	h := withCSRFCheck(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) }))

	cases := []struct {
		name, method, path, origin string
		want                       int
	}{
		{"mcp register cross-origin allowed", "POST", "/api/mcp/oauth/register", "http://localhost:6274", 200},
		{"mcp token cross-origin allowed", "POST", "/api/mcp/oauth/token", "http://localhost:6274", 200},
		{"mcp call cross-origin allowed", "POST", "/api/mcp", "http://localhost:6274", 200},
		{"well-known oauth cross-origin allowed", "POST", "/.well-known/oauth-protected-resource", "http://x:9", 200},
		{"config cross-origin rejected", "PUT", "/api/config", "http://evil.example", 403},
		{"config same-origin allowed", "PUT", "/api/config", "http://app.host", 200},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			req := httptest.NewRequest(c.method, "http://app.host"+c.path, nil)
			req.Host = "app.host"
			req.Header.Set("Origin", c.origin)
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			if rec.Code != c.want {
				t.Fatalf("%s %s (Origin %s): code=%d want=%d", c.method, c.path, c.origin, rec.Code, c.want)
			}
		})
	}
}
