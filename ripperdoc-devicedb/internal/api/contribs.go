package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"ripperdoc.de/devicedb/internal/store"
)

// submissionWireBody is the JSON shape accepted by POST /v1/contributions
// per spec §5.5. The internal SubmissionInput is built from this.
type submissionWireBody struct {
	Target struct {
		Type  string `json:"type"`
		UUID  string `json:"uuid"`
		Field string `json:"field"`
	} `json:"target"`
	To       *string `json:"to"`
	From     *string `json:"from"`
	Evidence struct {
		SourceURL       *string         `json:"source_url"`
		BoardInHand     bool            `json:"board_in_hand"`
		BoardInHandCtx  json.RawMessage `json:"board_in_hand_ctx"`
		Rationale       *string         `json:"rationale"`
	} `json:"evidence"`
	Confidence *string `json:"confidence"`
	ClientTS   string  `json:"client_ts"`
}

// handleContributions routes POST/GET on /v1/contributions.
func (s *Server) handleContributions(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodPost:
		s.postContribution(w, r)
	case http.MethodGet:
		// Only /v1/contributions/mine is supported; clients should use
		// /v1/contributions/mine. Allow this top-level GET to return mine
		// when authenticated, to keep symmetry with POST.
		s.listMine(w, r)
	default:
		writeJSONError(w, &store.APIError{Code: "method_not_allowed", HTTP: 405})
	}
}

func (s *Server) postContribution(w http.ResponseWriter, r *http.Request) {
	auth := s.authenticate(w, r, true)
	if auth == nil {
		return
	}
	var body submissionWireBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSONError(w, &store.APIError{Code: "bad_json", Message: err.Error(), HTTP: 400})
		return
	}
	if body.Target.Type == "" || body.Target.UUID == "" || body.Target.Field == "" {
		writeJSONError(w, &store.APIError{Code: "bad_request", Message: "target.type/uuid/field required", HTTP: 400})
		return
	}
	var inHandCtx *string
	if len(body.Evidence.BoardInHandCtx) > 0 {
		raw := string(body.Evidence.BoardInHandCtx)
		inHandCtx = &raw
	}
	var installUUID *string
	if auth.IsInstall {
		v := auth.InstallUUID
		installUUID = &v
	}
	in := &store.SubmissionInput{
		TargetType:        body.Target.Type,
		TargetUUID:        body.Target.UUID,
		TargetField:       body.Target.Field,
		ValueTo:           body.To,
		ValueFrom:         body.From,
		EvidenceSourceURL: body.Evidence.SourceURL,
		EvidenceInHand:    body.Evidence.BoardInHand,
		EvidenceInHandCtx: inHandCtx,
		EvidenceRationale: body.Evidence.Rationale,
		Confidence:        body.Confidence,
		ClientTS:          body.ClientTS,
		ContributorUUID:   auth.ContributorUUID,
		InstallUUID:       installUUID,
	}
	res, err := s.Store.Submit(in)
	if err != nil {
		writeJSONError(w, asAPIError(err))
		return
	}
	w.WriteHeader(http.StatusCreated)
	writeJSON(w, res)
}

func (s *Server) listMine(w http.ResponseWriter, r *http.Request) {
	auth := s.authenticate(w, r, false)
	if auth == nil {
		return
	}
	status := r.URL.Query().Get("status")
	rows, err := s.Store.ListByContributor(auth.ContributorUUID, status, 100)
	if err != nil {
		writeJSONError(w, asAPIError(err))
		return
	}
	writeJSON(w, map[string]any{"contributions": rows})
}

// handleContributionDetail covers:
//
//	GET    /v1/contributions/mine          → caller's submissions
//	DELETE /v1/contributions/{uuid}        → withdraw (caller must own)
//	GET    /v1/contributions/{uuid}        → single (caller must own or be reviewer)
func (s *Server) handleContributionDetail(w http.ResponseWriter, r *http.Request) {
	tail := strings.TrimPrefix(r.URL.Path, "/v1/contributions/")
	if tail == "mine" {
		s.listMine(w, r)
		return
	}
	auth := s.authenticate(w, r, false)
	if auth == nil {
		return
	}
	if tail == "" {
		writeJSONError(w, &store.APIError{Code: "bad_path", HTTP: 400})
		return
	}
	switch r.Method {
	case http.MethodGet:
		c, err := s.Store.ContributionByUUID(tail)
		if err != nil {
			if errors.Is(err, store.ErrNotFound) {
				writeJSONError(w, &store.APIError{Code: "not_found", HTTP: 404})
				return
			}
			writeJSONError(w, asAPIError(err))
			return
		}
		// Author or reviewer-scope can read.
		if c.ContributorUUID != auth.ContributorUUID && !auth.HasScope("contributions:moderate") {
			writeJSONError(w, &store.APIError{Code: "not_yours", HTTP: 403})
			return
		}
		writeJSON(w, c)
	case http.MethodDelete:
		if err := s.Store.Withdraw(tail, auth.ContributorUUID); err != nil {
			if errors.Is(err, store.ErrNotFound) {
				writeJSONError(w, &store.APIError{Code: "not_found", HTTP: 404})
				return
			}
			writeJSONError(w, asAPIError(err))
			return
		}
		w.WriteHeader(http.StatusNoContent)
	default:
		writeJSONError(w, &store.APIError{Code: "method_not_allowed", HTTP: 405})
	}
}
