package handlers

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestAuthMiddleware_Rejects401WithoutCredentials(t *testing.T) {
	h := WithUpdateAuth("topsecret", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
	}))
	r := httptest.NewRequest("POST", "/api/update/apply", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 401 { t.Errorf("got %d, want 401", w.Code) }
}

func TestAuthMiddleware_AcceptsHeader(t *testing.T) {
	h := WithUpdateAuth("topsecret", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
	}))
	r := httptest.NewRequest("POST", "/api/update/apply", nil)
	r.Header.Set("X-BoardRipper-Update-Token", "topsecret")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 200 { t.Errorf("got %d, want 200", w.Code) }
}

func TestAuthMiddleware_AcceptsCookie(t *testing.T) {
	h := WithUpdateAuth("topsecret", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
	}))
	r := httptest.NewRequest("POST", "/api/update/apply", nil)
	r.AddCookie(&http.Cookie{Name: "br_update_token", Value: "topsecret"})
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 200 { t.Errorf("got %d, want 200", w.Code) }
}

func TestBootstrapHandler_SetsCookie(t *testing.T) {
	h := NewBootstrapHandler("topsecret")
	r := httptest.NewRequest("GET", "/api/update/bootstrap", nil)
	w := httptest.NewRecorder()
	h.Serve(w, r)
	if w.Code != 204 { t.Errorf("got %d, want 204", w.Code) }
	cookies := w.Result().Cookies()
	found := false
	for _, c := range cookies {
		if c.Name == "br_update_token" && c.Value == "topsecret" && c.HttpOnly && c.SameSite == http.SameSiteStrictMode {
			if c.Secure {
				t.Errorf("Secure should be false for non-TLS request, got true")
			}
			found = true
		}
	}
	if !found { t.Errorf("bootstrap did not set HttpOnly+SameSite=Strict cookie") }
}
