package mcpserver

import (
	"net/http"
	"net/http/httptest"
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

	// The install secret is NOT an oauth token — oauth mode keeps rejecting it.
	rec = httptest.NewRecorder()
	req = httptest.NewRequest("POST", "/api/mcp", nil)
	req.Header.Set("Authorization", "Bearer install-secret")
	h.ServeHTTP(rec, req)
	if rec.Code != 401 {
		t.Fatalf("install secret in oauth mode: status=%d, want 401", rec.Code)
	}
}

func TestScopeFrom_DefaultsToShared(t *testing.T) {
	if sc := ScopeFrom(t.Context()); !sc.Shared() || sc.ClientID != "" {
		t.Fatalf("zero scope must be shared, got %+v", sc)
	}
}
