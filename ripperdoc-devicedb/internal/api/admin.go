package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"ripperdoc.de/devicedb/internal/store"
)

// Admin endpoints require a user-token with scope "contributions:moderate".
//
//	GET   /v1/admin/contributions/queue?status=submitted&order=oldest_first&limit=50
//	POST  /v1/admin/contributions/{uuid}/accept
//	POST  /v1/admin/contributions/{uuid}/reject   body: {reason}
//	POST  /v1/admin/contributors/{uuid}/block     body: {reason}
//	POST  /v1/admin/snapshot/regenerate

func (s *Server) handleAdminQueue(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSONError(w, &store.APIError{Code: "method_not_allowed", HTTP: 405})
		return
	}
	auth := s.authenticate(w, r, false)
	if auth == nil {
		return
	}
	if !requireScope(w, auth, "contributions:moderate") {
		return
	}
	status := r.URL.Query().Get("status")
	order := r.URL.Query().Get("order")
	limitStr := r.URL.Query().Get("limit")
	limit := 50
	if v, err := strconv.Atoi(limitStr); err == nil {
		limit = v
	}
	rows, err := s.Store.Queue(status, order, limit)
	if err != nil {
		writeJSONError(w, asAPIError(err))
		return
	}
	writeJSON(w, map[string]any{"contributions": rows})
}

// handleAdminContributionAction routes /v1/admin/contributions/{uuid}/{accept|reject}
func (s *Server) handleAdminContributionAction(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSONError(w, &store.APIError{Code: "method_not_allowed", HTTP: 405})
		return
	}
	auth := s.authenticate(w, r, false)
	if auth == nil {
		return
	}
	if !requireScope(w, auth, "contributions:moderate") {
		return
	}
	tail := strings.TrimPrefix(r.URL.Path, "/v1/admin/contributions/")
	parts := strings.SplitN(tail, "/", 2)
	if len(parts) != 2 {
		writeJSONError(w, &store.APIError{Code: "bad_path", HTTP: 400})
		return
	}
	uuid, action := parts[0], parts[1]
	switch action {
	case "accept":
		newStatus, err := s.Store.Accept(uuid, auth.ContributorUUID)
		if err != nil {
			if errors.Is(err, store.ErrNotFound) {
				writeJSONError(w, &store.APIError{Code: "not_found", HTTP: 404})
				return
			}
			writeJSONError(w, asAPIError(err))
			return
		}
		// Auto-regenerate snapshot in background — keep admin response fast.
		if s.Snapshots != nil && newStatus == "accepted" {
			go func() {
				if _, err := s.Snapshots.Regenerate(); err != nil {
					// snapshot package logs internally; surface here for context.
					// We do NOT fail the accept on snapshot regen errors.
					_ = err
				}
			}()
		}
		writeJSON(w, map[string]any{"uuid": uuid, "status": newStatus})
	case "reject":
		var body struct {
			Reason string `json:"reason"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body.Reason == "" {
			writeJSONError(w, &store.APIError{Code: "missing_reason", Message: "reason required", HTTP: 400})
			return
		}
		if err := s.Store.Reject(uuid, auth.ContributorUUID, body.Reason); err != nil {
			if errors.Is(err, store.ErrNotFound) {
				writeJSONError(w, &store.APIError{Code: "not_found", HTTP: 404})
				return
			}
			writeJSONError(w, asAPIError(err))
			return
		}
		writeJSON(w, map[string]any{"uuid": uuid, "status": "rejected"})
	default:
		writeJSONError(w, &store.APIError{Code: "unknown_action", Message: action, HTTP: 400})
	}
}

func (s *Server) handleAdminContributorBlock(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSONError(w, &store.APIError{Code: "method_not_allowed", HTTP: 405})
		return
	}
	auth := s.authenticate(w, r, false)
	if auth == nil {
		return
	}
	if !requireScope(w, auth, "contributions:moderate") {
		return
	}
	tail := strings.TrimPrefix(r.URL.Path, "/v1/admin/contributors/")
	parts := strings.SplitN(tail, "/", 2)
	if len(parts) != 2 || parts[1] != "block" {
		writeJSONError(w, &store.APIError{Code: "bad_path", HTTP: 400})
		return
	}
	uuid := parts[0]
	var body struct {
		Reason string `json:"reason"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	if err := s.Store.BlockContributor(uuid, body.Reason); err != nil {
		writeJSONError(w, asAPIError(err))
		return
	}
	writeJSON(w, map[string]any{"uuid": uuid, "blocked": true})
}

func (s *Server) handleAdminSnapshotRegen(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSONError(w, &store.APIError{Code: "method_not_allowed", HTTP: 405})
		return
	}
	auth := s.authenticate(w, r, false)
	if auth == nil {
		return
	}
	if !requireScope(w, auth, "contributions:moderate") {
		return
	}
	if s.Snapshots == nil {
		writeJSONError(w, &store.APIError{Code: "snapshots_disabled", HTTP: 503})
		return
	}
	man, err := s.Snapshots.Regenerate()
	if err != nil {
		writeJSONError(w, asAPIError(err))
		return
	}
	writeJSON(w, man)
}
