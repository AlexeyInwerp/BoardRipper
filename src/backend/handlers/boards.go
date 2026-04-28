package handlers

import (
	"encoding/json"
	"net/http"

	"boardripper/boarddb"
)

// BoardsHandler serves the board reference database API.
type BoardsHandler struct {
	bdb *boarddb.DB
}

// NewBoardsHandler creates a new boards handler.
func NewBoardsHandler(bdb *boarddb.DB) *BoardsHandler {
	return &BoardsHandler{bdb: bdb}
}

// Resolve handles GET /api/boards/resolve?q=NM-A251
func (h *BoardsHandler) Resolve(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query().Get("q")
	if q == "" {
		http.Error(w, `{"error":"missing q parameter"}`, http.StatusBadRequest)
		return
	}

	extracted := boarddb.ExtractBoardNumbers(q)

	var result struct {
		Extracted []boarddb.ExtractedNumber `json:"extracted"`
		Match     *boarddb.BoardMatch       `json:"match"`
	}
	result.Extracted = extracted

	if h.bdb != nil && h.bdb.Available() {
		// Try resolving the raw query first
		result.Match = h.bdb.Resolve(q)
		// If no match, try each extracted number
		if result.Match == nil {
			for _, e := range extracted {
				result.Match = h.bdb.Resolve(e.Number)
				if result.Match != nil {
					break
				}
			}
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(result)
}

// Hierarchy handles GET /api/boards/hierarchy — returns the full
// Brand → Family → Model → Board tree (with aliases) for the Database
// Editor panel. Read-only; small payload at v2 scale (~150 entities).
func (h *BoardsHandler) Hierarchy(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if h.bdb == nil || !h.bdb.Available() {
		json.NewEncoder(w).Encode(map[string]any{"available": false})
		return
	}
	brands := h.bdb.Hierarchy()
	json.NewEncoder(w).Encode(map[string]any{
		"available": true,
		"brands":    brands,
	})
}

// Stats handles GET /api/boards/stats
func (h *BoardsHandler) Stats(w http.ResponseWriter, r *http.Request) {
	if h.bdb == nil || !h.bdb.Available() {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"available": false})
		return
	}
	stats := h.bdb.Stats()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"available": true, "stats": stats})
}
