package api

import (
	"encoding/json"
	"net/http"

	"ripperdoc.de/devicedb/internal/store"
)

// handleUserRegister serves POST /v1/users/register. Prototype-only:
// password-less, no email verification. Creates a contributors row
// (kind='user') and one user_tokens row (default scope
// "contributions:submit"). Plaintext token is returned exactly once.
//
// Real GitHub-OAuth flow is Phase 3.
func (s *Server) handleUserRegister(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSONError(w, &store.APIError{Code: "method_not_allowed", HTTP: 405})
		return
	}
	// Same IP-rate cap as install register — spam guard.
	if s.RateLimits != nil && !s.RateLimits.allowRegister(clientIP(r)) {
		w.Header().Set("Retry-After", "60")
		writeJSONError(w, &store.APIError{Code: "rate_limited", HTTP: 429})
		return
	}
	var body struct {
		Handle string `json:"handle"`
		Email  string `json:"email"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSONError(w, &store.APIError{Code: "bad_json", Message: err.Error(), HTTP: 400})
		return
	}
	if body.Handle == "" {
		writeJSONError(w, &store.APIError{Code: "missing_handle", Message: "handle required", HTTP: 400})
		return
	}
	uuid, token, err := s.Store.RegisterUser(body.Handle, body.Email)
	if err != nil {
		writeJSONError(w, asAPIError(err))
		return
	}
	writeJSON(w, map[string]any{
		"user_uuid": uuid,
		"token":     token,
		"warning":   "save this token now — it is shown exactly once",
	})
}
