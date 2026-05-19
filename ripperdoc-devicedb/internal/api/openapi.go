package api

import (
	"encoding/json"
	"net/http"

	"ripperdoc.de/devicedb/internal/store"
)

// handleOpenAPI returns a hand-curated OpenAPI 3.1 document. For Phase 2 it
// is minimal but accurate; Phase 3 can wire a generator. The field allowlist
// inside `components.schemas.SubmissionTarget` is built from
// store.FieldAllowlist so it always tracks the server source of truth
// (spec §9 invariant #8).
func (s *Server) handleOpenAPI(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSONError(w, &store.APIError{Code: "method_not_allowed", HTTP: 405})
		return
	}

	allowlist := map[string][]string{}
	for tt, fields := range store.FieldAllowlist {
		for f := range fields {
			allowlist[tt] = append(allowlist[tt], f)
		}
	}

	doc := map[string]any{
		"openapi": "3.1.0",
		"info": map[string]any{
			"title":   "ripperdoc-devicedb",
			"version": "1.0.0",
			"summary": "Canonical online boards database — read + contribute.",
		},
		"servers": []map[string]any{
			{"url": "/v1", "description": "canonical path"},
			{"url": "/devicedb/api/v1", "description": "alias for the static frontend"},
		},
		"paths": map[string]any{
			"/entities":                                map[string]any{"get": opSummary("Full Brand→Family→Model→Board tree")},
			"/entities/{type}/{uuid}":                  map[string]any{"get": opSummary("Single entity by type and UUID")},
			"/entities/{type}/{uuid}/contributions":    map[string]any{"get": opSummary("Public edit history (default status=accepted)")},
			"/resolve":                                 map[string]any{"get": opSummary("Best-effort board-number resolver")},
			"/snapshots/latest":                        map[string]any{"get": opSummary("Signed snapshot manifest")},
			"/snapshots/{counter}/tarball":             map[string]any{"get": opSummary("Signed snapshot tarball")},
			"/installs/register":                       map[string]any{"post": opSummary("Register a new install token")},
			"/users/register":                          map[string]any{"post": opSummary("Prototype: register a user, mint a token")},
			"/contributions":                           map[string]any{"post": opSummary("Submit a patch"), "get": opSummary("List caller's submissions")},
			"/contributions/mine":                      map[string]any{"get": opSummary("Caller's submissions")},
			"/contributions/{uuid}":                    map[string]any{"get": opSummary("Single submission"), "delete": opSummary("Withdraw own pending submission")},
			"/admin/contributions/queue":               map[string]any{"get": opSummary("Moderator queue (scope: contributions:moderate)")},
			"/admin/contributions/{uuid}/accept":       map[string]any{"post": opSummary("Apply patch (scope: contributions:moderate)")},
			"/admin/contributions/{uuid}/reject":       map[string]any{"post": opSummary("Reject with reason")},
			"/admin/contributors/{uuid}/block":         map[string]any{"post": opSummary("Block a contributor")},
			"/admin/snapshot/regenerate":               map[string]any{"post": opSummary("Force snapshot regeneration")},
			"/health":                                  map[string]any{"get": opSummary("Liveness probe")},
		},
		"components": map[string]any{
			"schemas": map[string]any{
				"FieldAllowlist": map[string]any{
					"description": "Per-target writable field list, hard-coded in the server (spec §9 #8)",
					"type":        "object",
					"properties":  allowlistToProps(allowlist),
				},
			},
			"securitySchemes": map[string]any{
				"InstallToken": map[string]any{
					"type":        "apiKey",
					"in":          "header",
					"name":        "X-BoardRipper-Install-Token",
					"description": "Per-install secret minted on first launch.",
				},
				"UserToken": map[string]any{
					"type":   "http",
					"scheme": "bearer",
				},
			},
		},
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(doc)
}

func opSummary(s string) map[string]any { return map[string]any{"summary": s} }

func allowlistToProps(m map[string][]string) map[string]any {
	out := map[string]any{}
	for tt, fs := range m {
		out[tt] = map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "example": fs}
	}
	return out
}
