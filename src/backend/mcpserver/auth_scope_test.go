package mcpserver

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// scopeEcho captures the scope the wrapped handler observed on the request
// context, proving GateAuto attached it (or didn't).
func scopeEcho(got *Scope) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		*got = ScopeFrom(r.Context())
		w.WriteHeader(http.StatusOK)
	})
}

func TestGateAuto_ScopeResolution(t *testing.T) {
	st := NewState(&fakeConfig{m: map[string]string{"mcp_enabled": "1"}})
	ps, err := LoadPairings(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	paired, err := ps.PairClient("c1", "Alex")
	if err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		name       string
		bearer     string
		wantStatus int
		wantClient string
	}{
		{"install secret is shared scope", "install-secret", 200, ""},
		{"paired token is client scope", paired, 200, "c1"},
		{"garbage token rejected", "nope", 401, ""},
		{"missing token rejected", "", 401, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var got Scope
			h := GateAuto(st, "install-secret", ps, NewOAuth(), scopeEcho(&got))
			rec := httptest.NewRecorder()
			req := httptest.NewRequest("POST", "/api/mcp", nil)
			if tc.bearer != "" {
				req.Header.Set("Authorization", "Bearer "+tc.bearer)
			}
			h.ServeHTTP(rec, req)
			if rec.Code != tc.wantStatus {
				t.Fatalf("status = %d, want %d", rec.Code, tc.wantStatus)
			}
			if tc.wantStatus == 401 {
				if !strings.Contains(rec.Body.String(), "session-separation update") {
					t.Fatalf("401 body must explain the token reset, got: %s", rec.Body.String())
				}
				// Clients that get a bare 401 fall back to OAuth discovery
				// (hidden in token mode → confusing 404); the challenge header
				// carries the real reason for them to surface.
				if ch := rec.Header().Get("WWW-Authenticate"); !strings.Contains(ch, `error="invalid_token"`) || !strings.Contains(ch, "error_description=") {
					t.Fatalf("401 missing RFC6750 challenge, got: %q", ch)
				}
			}
			if tc.wantStatus == 200 {
				if got.ClientID != tc.wantClient {
					t.Fatalf("scope client = %q, want %q", got.ClientID, tc.wantClient)
				}
				if wantShared := tc.wantClient == ""; got.Shared() != wantShared {
					t.Fatalf("Shared() = %v, want %v", got.Shared(), wantShared)
				}
			}
		})
	}
}

func TestGateAuto_PairedTokenWorksInOAuthMode(t *testing.T) {
	st := NewState(&fakeConfig{m: map[string]string{"mcp_enabled": "1", "mcp_auth_mode": "oauth"}})
	ps, _ := LoadPairings(t.TempDir())
	paired, _ := ps.PairClient("c1", "Alex")

	var got Scope
	h := GateAuto(st, "install-secret", ps, NewOAuth(), scopeEcho(&got))

	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/mcp", nil)
	req.Header.Set("Authorization", "Bearer "+paired)
	h.ServeHTTP(rec, req)
	if rec.Code != 200 || got.ClientID != "c1" {
		t.Fatalf("paired token in oauth mode: status=%d client=%q", rec.Code, got.ClientID)
	}

	// OAuth mode is a superset of token mode: the shared install secret keeps
	// working (shared scope), so different users can mix schemes on one
	// install — some on static tokens, some via OAuth.
	got = Scope{ClientID: "sentinel"}
	rec = httptest.NewRecorder()
	req = httptest.NewRequest("POST", "/api/mcp", nil)
	req.Header.Set("Authorization", "Bearer install-secret")
	h.ServeHTTP(rec, req)
	if rec.Code != 200 || !got.Shared() {
		t.Fatalf("install secret in oauth mode: status=%d scope=%+v, want 200 shared", rec.Code, got)
	}

	// Garbage in oauth mode still gets the PRM challenge (OAuth onboarding).
	rec = httptest.NewRecorder()
	req = httptest.NewRequest("POST", "/api/mcp", nil)
	req.Header.Set("Authorization", "Bearer nope")
	h.ServeHTTP(rec, req)
	if rec.Code != 401 || !strings.Contains(rec.Header().Get("WWW-Authenticate"), "resource_metadata") {
		t.Fatalf("garbage in oauth mode: status=%d challenge=%q, want 401 + resource_metadata", rec.Code, rec.Header().Get("WWW-Authenticate"))
	}
}

func TestScopeFrom_DefaultsToShared(t *testing.T) {
	if sc := ScopeFrom(t.Context()); !sc.Shared() || sc.ClientID != "" {
		t.Fatalf("zero scope must be shared, got %+v", sc)
	}
}
