package mcpserver

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
)

// Flipping Settings > Integrations back to Token mode must not log out agents
// that already completed the OAuth dance — the mode flag gates *onboarding*
// (discovery/register/authorize/token), not verification of tokens already
// issued. Revocation is the explicit reset button, not a side effect of the
// toggle.
func TestGateAuto_OAuthTokenSurvivesModeSwitch(t *testing.T) {
	cfg := &fakeConfig{m: map[string]string{"mcp_enabled": "1", "mcp_auth_mode": "oauth"}}
	st := NewState(cfg)
	o := NewOAuth()
	o.tokens["issued"] = &accessToken{clientID: "c1", scope: oauthScope, expiry: nowFunc().Add(accessTokenTTL)}
	h := GateAuto(st, "install-secret", nil, o, okHandler())

	call := func(bearer string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest("POST", "http://host/api/mcp", nil)
		if bearer != "" {
			req.Header.Set("Authorization", "Bearer "+bearer)
		}
		h.ServeHTTP(rec, req)
		return rec
	}

	if rec := call("issued"); rec.Code != 200 {
		t.Fatalf("oauth mode: issued token should pass, got %d", rec.Code)
	}

	cfg.m["mcp_auth_mode"] = "token" // the operator flips the switch

	if rec := call("issued"); rec.Code != 200 {
		t.Fatalf("token mode: already-issued oauth token must keep working, got %d", rec.Code)
	}

	// Failure semantics stay mode-specific: token mode must NOT point clients at
	// an onboarding path that is switched off, so it keeps the RFC 6750 body.
	rec := call("nope")
	if rec.Code != 401 {
		t.Fatalf("token mode garbage: want 401, got %d", rec.Code)
	}
	if ch := rec.Header().Get("WWW-Authenticate"); !strings.Contains(ch, `error="invalid_token"`) {
		t.Fatalf("token mode garbage should get the invalid_token challenge, got %q", ch)
	}
	if strings.Contains(rec.Header().Get("WWW-Authenticate"), "resource_metadata") {
		t.Fatal("token mode must not advertise OAuth discovery")
	}

	// Back in oauth mode, an unknown token gets the PRM challenge so capable
	// clients can onboard.
	cfg.m["mcp_auth_mode"] = "oauth"
	if ch := call("nope").Header().Get("WWW-Authenticate"); !strings.Contains(ch, "resource_metadata") {
		t.Fatalf("oauth mode garbage should get resource_metadata, got %q", ch)
	}
}

// RevokeAll is the teeth behind the reset button: every issued token stops
// verifying at once, and registered clients are dropped so a re-connect goes
// through consent again.
func TestOAuth_RevokeAll(t *testing.T) {
	o := NewOAuth()
	o.clients["c1"] = &oauthClient{ID: "c1", RedirectURIs: []string{"http://x/cb"}}
	o.codes["pending"] = &authCode{clientID: "c1", expiry: nowFunc().Add(codeTTL)}
	o.tokens["a"] = &accessToken{clientID: "c1", scope: oauthScope, expiry: nowFunc().Add(accessTokenTTL)}
	o.tokens["b"] = &accessToken{clientID: "c1", scope: oauthScope, expiry: nowFunc().Add(accessTokenTTL)}

	if n := o.RevokeAll(); n != 2 {
		t.Fatalf("RevokeAll should report 2 revoked tokens, got %d", n)
	}
	if _, err := o.Verifier()(context.Background(), "a", nil); err == nil {
		t.Fatal("revoked token still verifies")
	}
	if len(o.clients) != 0 || len(o.codes) != 0 || len(o.tokens) != 0 {
		t.Fatalf("tables not cleared: clients=%d codes=%d tokens=%d", len(o.clients), len(o.codes), len(o.tokens))
	}
	if n := o.RevokeAll(); n != 0 { // idempotent
		t.Fatalf("second RevokeAll should report 0, got %d", n)
	}
}

// The reset endpoint must stay reachable in *token* mode — that is precisely
// when an operator wants to kick lingering OAuth agents off. It is only hidden
// when MCP itself is disabled.
func TestResetOAuthHandler_ReachableInTokenMode(t *testing.T) {
	o := NewOAuth()
	o.tokens["a"] = &accessToken{clientID: "c1", scope: oauthScope, expiry: nowFunc().Add(accessTokenTTL)}
	st := NewState(&fakeConfig{m: map[string]string{"mcp_enabled": "1", "mcp_auth_mode": "token"}})

	rec := httptest.NewRecorder()
	ResetOAuthHandler(st, o)(rec, httptest.NewRequest("POST", "/api/mcp/oauth/reset", nil))
	if rec.Code != 200 {
		t.Fatalf("reset in token mode: want 200, got %d (%s)", rec.Code, rec.Body.String())
	}
	var body struct {
		Revoked int `json:"revoked"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil || body.Revoked != 1 {
		t.Fatalf("reset body = %s (err=%v)", rec.Body.String(), err)
	}

	// Invisible while MCP is off, matching every other /api/mcp endpoint.
	off := NewState(&fakeConfig{m: map[string]string{}})
	rec2 := httptest.NewRecorder()
	ResetOAuthHandler(off, o)(rec2, httptest.NewRequest("POST", "/api/mcp/oauth/reset", nil))
	if rec2.Code != 404 {
		t.Fatalf("reset with MCP disabled: want 404, got %d", rec2.Code)
	}
}
