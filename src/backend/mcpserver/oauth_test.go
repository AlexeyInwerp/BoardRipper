package mcpserver

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

// Drives the full OAuth 2.1 authorization-code + PKCE dance against the embedded
// AS, then verifies the issued token via the resource-server verifier.
func TestOAuth_FullAuthorizationCodeFlow(t *testing.T) {
	o := NewOAuth()
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/mcp/oauth/register", o.Register)
	mux.HandleFunc("/api/mcp/oauth/authorize", o.Authorize)
	mux.HandleFunc("POST /api/mcp/oauth/token", o.Token)
	srv := httptest.NewServer(mux)
	defer srv.Close()

	// 1) Dynamic client registration.
	regBody, _ := json.Marshal(map[string]any{
		"redirect_uris": []string{"http://localhost:9999/callback"},
		"client_name":   "Test Agent",
	})
	rr, err := http.Post(srv.URL+"/api/mcp/oauth/register", "application/json", strings.NewReader(string(regBody)))
	if err != nil || rr.StatusCode != 201 {
		t.Fatalf("register: err=%v code=%d", err, rr.StatusCode)
	}
	var reg struct {
		ClientID string `json:"client_id"`
	}
	json.NewDecoder(rr.Body).Decode(&reg)
	if reg.ClientID == "" {
		t.Fatal("no client_id from registration")
	}

	// 2) PKCE pair.
	verifier := "test-verifier-abcdefghijklmnopqrstuvwxyz0123456789"
	sum := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(sum[:])

	// 3) Authorize: POST the consent "approve" decision; expect a redirect with a code.
	noRedir := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	form := url.Values{
		"response_type":         {"code"},
		"client_id":             {reg.ClientID},
		"redirect_uri":          {"http://localhost:9999/callback"},
		"code_challenge":        {challenge},
		"code_challenge_method": {"S256"},
		"state":                 {"xyz"},
		"decision":              {"approve"},
	}
	ar, err := noRedir.PostForm(srv.URL+"/api/mcp/oauth/authorize", form)
	if err != nil || ar.StatusCode != http.StatusFound {
		t.Fatalf("authorize: err=%v code=%d", err, ar.StatusCode)
	}
	loc := ar.Header.Get("Location")
	u, _ := url.Parse(loc)
	code := u.Query().Get("code")
	if code == "" || u.Query().Get("state") != "xyz" {
		t.Fatalf("authorize redirect missing code/state: %s", loc)
	}

	// 4) Token exchange with the matching code_verifier.
	tform := url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"redirect_uri":  {"http://localhost:9999/callback"},
		"client_id":     {reg.ClientID},
		"code_verifier": {verifier},
	}
	tr, err := http.PostForm(srv.URL+"/api/mcp/oauth/token", tform)
	if err != nil || tr.StatusCode != 200 {
		t.Fatalf("token: err=%v code=%d", err, tr.StatusCode)
	}
	var tok struct {
		AccessToken string `json:"access_token"`
		TokenType   string `json:"token_type"`
		Scope       string `json:"scope"`
	}
	json.NewDecoder(tr.Body).Decode(&tok)
	if tok.AccessToken == "" || tok.TokenType != "Bearer" {
		t.Fatalf("bad token response: %+v", tok)
	}

	// 5) Resource-server verification accepts the token.
	info, err := o.Verifier()(context.Background(), tok.AccessToken, nil)
	if err != nil || info == nil {
		t.Fatalf("verify: err=%v info=%v", err, info)
	}
	// A bogus token is rejected.
	if _, err := o.Verifier()(context.Background(), "nope", nil); err == nil {
		t.Fatal("expected invalid token to be rejected")
	}
}

func TestOAuth_PKCEMismatchRejected(t *testing.T) {
	o := NewOAuth()
	o.clients["c1"] = &oauthClient{ID: "c1", RedirectURIs: []string{"http://x/cb"}}
	// Plant a code with a known challenge, then exchange with a wrong verifier.
	sum := sha256.Sum256([]byte("right-verifier"))
	o.codes["thecode"] = &authCode{clientID: "c1", redirectURI: "http://x/cb",
		challenge: base64.RawURLEncoding.EncodeToString(sum[:]), scope: oauthScope, expiry: nowFunc().Add(codeTTL)}

	rec := httptest.NewRecorder()
	form := url.Values{
		"grant_type": {"authorization_code"}, "code": {"thecode"},
		"redirect_uri": {"http://x/cb"}, "client_id": {"c1"}, "code_verifier": {"wrong-verifier"},
	}
	req := httptest.NewRequest("POST", "/t", strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	o.Token(rec, req)
	if rec.Code != 400 {
		t.Fatalf("PKCE mismatch should be invalid_grant (400), got %d", rec.Code)
	}
}

func TestGateAuto_OAuthModeChallenges(t *testing.T) {
	st := NewState(&fakeConfig{m: map[string]string{"mcp_enabled": "1", "mcp_auth_mode": "oauth"}})
	o := NewOAuth()
	h := GateAuto(st, "unused-secret", nil, o, okHandler())

	// No token → 401 with WWW-Authenticate pointing at the PRM document.
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "http://host/api/mcp", nil)
	h.ServeHTTP(rec, req)
	if rec.Code != 401 {
		t.Fatalf("oauth mode no-token should 401, got %d", rec.Code)
	}
	if wa := rec.Header().Get("WWW-Authenticate"); !strings.Contains(wa, "resource_metadata") {
		t.Fatalf("missing resource_metadata challenge: %q", wa)
	}

	// A valid issued token passes.
	o.tokens["good"] = &accessToken{clientID: "c1", scope: oauthScope, expiry: nowFunc().Add(accessTokenTTL)}
	rec2 := httptest.NewRecorder()
	req2 := httptest.NewRequest("POST", "http://host/api/mcp", nil)
	req2.Header.Set("Authorization", "Bearer good")
	h.ServeHTTP(rec2, req2)
	if rec2.Code != 200 {
		t.Fatalf("valid oauth token should pass, got %d", rec2.Code)
	}
}
