package handlers

import (
	"encoding/json"
	"net/http"
)

// HealthHandler returns 200 once the server has finished startup.
type HealthHandler struct {
	ready func() bool
}

func NewHealthHandler(ready func() bool) *HealthHandler {
	return &HealthHandler{ready: ready}
}

func (h *HealthHandler) Serve(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if h.ready != nil && !h.ready() {
		w.WriteHeader(503)
		json.NewEncoder(w).Encode(map[string]any{"status": "starting"})
		return
	}
	w.WriteHeader(200)
	json.NewEncoder(w).Encode(map[string]any{"status": "ok"})
}
