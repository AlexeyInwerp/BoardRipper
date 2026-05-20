package handlers

import (
	"net/http"

	"boardripper/databank"
)

// DedupHandler exposes the on-demand "Find duplicates" pass: it hashes
// size-collision files and reports content groups. Non-destructive.
type DedupHandler struct {
	runner *databank.DedupRunner
	db     *databank.DB
}

func NewDedupHandler(runner *databank.DedupRunner, db *databank.DB) *DedupHandler {
	return &DedupHandler{runner: runner, db: db}
}

// Run starts the dedup pass (idempotent — a second call while running is a no-op).
// POST /api/databank/dedup/run
func (h *DedupHandler) Run(w http.ResponseWriter, r *http.Request) {
	if err := h.runner.Run(); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, h.runner.Progress())
}

// Stop cancels an in-flight pass.
// POST /api/databank/dedup/stop
func (h *DedupHandler) Stop(w http.ResponseWriter, r *http.Request) {
	h.runner.Stop()
	writeJSON(w, h.runner.Progress())
}

// ProgressEndpoint reports live pass progress.
// GET /api/databank/dedup/progress
func (h *DedupHandler) ProgressEndpoint(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, h.runner.Progress())
}

// Stats reports content-group counts and reclaimable bytes.
// GET /api/databank/dedup/stats
func (h *DedupHandler) Stats(w http.ResponseWriter, r *http.Request) {
	s, err := h.db.DedupStats()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, s)
}
