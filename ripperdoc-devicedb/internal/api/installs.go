package api

import (
	"encoding/json"
	"net/http"

	"ripperdoc.de/devicedb/internal/store"
)

// handleInstallRegister serves POST /v1/installs/register.
// Body: {token, version_hint}. Returns {contributor_uuid, created}.
// Idempotent: re-registering the same hash returns the existing UUID.
func (s *Server) handleInstallRegister(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSONError(w, &store.APIError{Code: "method_not_allowed", HTTP: 405})
		return
	}
	// IP-rate-limit even before parsing body (spec §5.2).
	if s.RateLimits != nil && !s.RateLimits.allowRegister(clientIP(r)) {
		w.Header().Set("Retry-After", "60")
		writeJSONError(w, &store.APIError{Code: "rate_limited", Message: "too many registrations", HTTP: 429})
		return
	}
	var body struct {
		Token       string `json:"token"`
		VersionHint string `json:"version_hint"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSONError(w, &store.APIError{Code: "bad_json", Message: err.Error(), HTTP: 400})
		return
	}
	if body.Token == "" {
		writeJSONError(w, &store.APIError{Code: "missing_token", Message: "token required", HTTP: 400})
		return
	}
	uuid, created, err := s.Store.RegisterInstall(body.Token, body.VersionHint)
	if err != nil {
		writeJSONError(w, asAPIError(err))
		return
	}
	writeJSON(w, map[string]any{
		"contributor_uuid": uuid,
		"created":          created,
	})
}
