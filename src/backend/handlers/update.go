package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"boardripper/updater"
)

// UpdateHandler serves update-related API endpoints.
type UpdateHandler struct {
	upd *updater.Updater
}

// NewUpdateHandler creates an UpdateHandler.
func NewUpdateHandler(upd *updater.Updater) *UpdateHandler {
	return &UpdateHandler{upd: upd}
}

// Status returns the current update state.
func (h *UpdateHandler) Status(w http.ResponseWriter, r *http.Request) {
	state := h.upd.State()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(state)
}

// Check forces an immediate update check.
func (h *UpdateHandler) Check(w http.ResponseWriter, r *http.Request) {
	state, err := h.upd.Check()
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadGateway)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(state)
}

// Apply starts the update process in the background.
func (h *UpdateHandler) Apply(w http.ResponseWriter, r *http.Request) {
	if h.upd.IsUpdating() {
		http.Error(w, `{"error":"update already in progress"}`, http.StatusConflict)
		return
	}

	go h.upd.Apply()

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusAccepted)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"message": "Update started",
	})
}

// Progress streams update progress via Server-Sent Events.
func (h *UpdateHandler) Progress(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming not supported", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	flusher.Flush()

	sent := 0
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()

	ctx := r.Context()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			entries := h.upd.Progress()
			for i := sent; i < len(entries); i++ {
				data, _ := json.Marshal(entries[i])
				fmt.Fprintf(w, "data: %s\n\n", data)
				flusher.Flush()

				// Stop streaming on terminal status
				if entries[i].Status == "done" || entries[i].Status == "error" {
					return
				}
			}
			sent = len(entries)
		}
	}
}
