package mcpserver

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestGateOAuth_ExplicitWhenTokenMode(t *testing.T) {
	next := func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(200) }

	get := func(st *State) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		GateOAuth(st, next)(rec, httptest.NewRequest("GET", prmWellKnown, nil))
		return rec
	}

	// MCP disabled: stay invisible (404), same as /api/mcp.
	if rec := get(NewState(&fakeConfig{m: map[string]string{}})); rec.Code != 404 {
		t.Fatalf("disabled: status=%d, want 404", rec.Code)
	}
	// Enabled + token mode: explicit 403 with an actionable explanation, so
	// clients auto-probing OAuth after a 401 surface the real reason.
	rec := get(NewState(&fakeConfig{m: map[string]string{"mcp_enabled": "1"}}))
	if rec.Code != 403 || !strings.Contains(rec.Body.String(), "OAuth is disabled") {
		t.Fatalf("token mode: status=%d body=%q, want 403 + explanation", rec.Code, rec.Body.String())
	}
	// Enabled + oauth mode: served.
	if rec := get(NewState(&fakeConfig{m: map[string]string{"mcp_enabled": "1", "mcp_auth_mode": "oauth"}})); rec.Code != 200 {
		t.Fatalf("oauth mode: status=%d, want 200", rec.Code)
	}
}
