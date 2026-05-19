package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"ripperdoc.de/devicedb/internal/store"
)

// handleEntities serves GET /v1/entities — full Brand → Family → Model → Board tree.
func (s *Server) handleEntities(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSONError(w, &store.APIError{Code: "method_not_allowed", HTTP: 405})
		return
	}
	tree, err := s.Store.Hierarchy()
	if err != nil {
		writeJSONError(w, asAPIError(err))
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"brands": tree,
	})
}

// handleEntityDetail serves:
//
//	GET /v1/entities/{type}/{uuid}                            — single entity
//	GET /v1/entities/{type}/{uuid}/contributions[?status=...] — public history
func (s *Server) handleEntityDetail(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSONError(w, &store.APIError{Code: "method_not_allowed", HTTP: 405})
		return
	}
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/v1/entities/"), "/")
	if len(parts) < 2 {
		writeJSONError(w, &store.APIError{Code: "bad_path", Message: "expected /v1/entities/{type}/{uuid}[/contributions]", HTTP: 400})
		return
	}
	targetType, uuid := parts[0], parts[1]
	if !validReadType(targetType) {
		writeJSONError(w, &store.APIError{Code: "bad_type", Message: "unknown entity type: " + targetType, HTTP: 400})
		return
	}
	if len(parts) >= 3 && parts[2] == "contributions" {
		status := r.URL.Query().Get("status")
		if status == "" {
			status = "accepted"
		}
		rows, err := s.Store.ContributionsForTarget(targetType, uuid, status)
		if err != nil {
			writeJSONError(w, asAPIError(err))
			return
		}
		writeJSON(w, map[string]any{"contributions": rows})
		return
	}
	ent, err := s.Store.SingleEntity(targetType, uuid)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeJSONError(w, &store.APIError{Code: "not_found", HTTP: 404})
			return
		}
		writeJSONError(w, asAPIError(err))
		return
	}
	writeJSON(w, ent)
}

func validReadType(t string) bool {
	switch t {
	case "brand", "family", "model", "board":
		return true
	}
	return false
}

// handleResolve serves GET /v1/resolve?q=...
func (s *Server) handleResolve(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSONError(w, &store.APIError{Code: "method_not_allowed", HTTP: 405})
		return
	}
	q := r.URL.Query().Get("q")
	if q == "" {
		writeJSONError(w, &store.APIError{Code: "missing_q", Message: "missing q parameter", HTTP: 400})
		return
	}
	res, err := s.Store.Resolve(q)
	if err != nil {
		writeJSONError(w, asAPIError(err))
		return
	}
	writeJSON(w, res)
}

// handleHealth — simple liveness probe.
func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSONError(w, &store.APIError{Code: "method_not_allowed", HTTP: 405})
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(`{"ok":true}`))
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}
