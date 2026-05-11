package handlers

import (
	"encoding/json"
	"fmt"
	"io"
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

	go func() {
		if err := h.upd.Apply(); err != nil {
			// Surface the error through the SSE progress channel so the
			// frontend's overlay/dropdown can show it instead of hanging
			// silently. Apply()'s internal logProgress calls cover most of
			// the flow but a few code paths (applyTarball returning early,
			// orchestrateRestart's preflight failures) used to bubble back
			// here without ever appearing on the SSE stream.
			h.upd.PushError("Update failed: " + err.Error())
		}
	}()

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusAccepted)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"message": "Update started",
	})
}

// ApplyBundle accepts a multipart upload of an update bundle (.brupdate / .tar
// containing manifest.json + manifest.json.minisig + boardripper-vX.Y.Z.tar.gz)
// and applies it. Same trust envelope as the network path — the manifest
// signature is the only thing that grants trust. Recovery path for installs
// where the in-binary updater can't reach GHCR / ripperdoc.de.
func (h *UpdateHandler) ApplyBundle(w http.ResponseWriter, r *http.Request) {
	if h.upd.IsUpdating() {
		http.Error(w, `{"error":"update already in progress"}`, http.StatusConflict)
		return
	}

	// 48 MiB ceiling on the multipart body. Bundle is manifest (~1 KiB) +
	// signature (~150 B) + image tarball (typically ~30 MiB). 48 MiB
	// leaves headroom; tighter than the previous 64 MiB so a holder of
	// the bootstrap cookie can't stack as many concurrent allocations
	// against the 512 MiB container memory limit. Per-member extraction
	// in extractBundle is independently capped.
	r.Body = http.MaxBytesReader(w, r.Body, 48<<20)
	if err := r.ParseMultipartForm(48 << 20); err != nil {
		http.Error(w, `{"error":"parse multipart: `+err.Error()+`"}`, http.StatusBadRequest)
		return
	}
	defer r.MultipartForm.RemoveAll()

	file, _, err := r.FormFile("bundle")
	if err != nil {
		http.Error(w, `{"error":"missing 'bundle' form field"}`, http.StatusBadRequest)
		return
	}
	defer file.Close()

	body, err := io.ReadAll(file)
	if err != nil {
		http.Error(w, `{"error":"read upload: `+err.Error()+`"}`, http.StatusBadRequest)
		return
	}

	go func() {
		if err := h.upd.ApplyBundle(body); err != nil {
			// Most ApplyBundle paths logProgress before returning; the early
			// returns (manifest signature failure, member missing) don't, so
			// forward the return value the same way Apply does.
			h.upd.PushError("Bundle update failed: " + err.Error())
		}
	}()

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusAccepted)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"message": "Bundle update started",
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
	w.Header().Set("Cache-Control", "no-cache, no-transform")
	w.Header().Set("Connection", "keep-alive")
	// Disable buffering on common reverse proxies — without this, Synology
	// DSM / nginx hold the stream open and only release the buffered chunks
	// when the connection closes. The orchestrator kills the container long
	// before that happens, so the user sees zero progress lines.
	w.Header().Set("X-Accel-Buffering", "no")
	flusher.Flush()

	sent := 0
	// 100 ms tick: the entire Apply() can complete in well under 500 ms on a
	// fast NAS (cached image load + already-pulled alpine), so a coarser
	// poll loses entries to the orchestrator-stop race. 100 ms keeps
	// CPU cost negligible and bounds loss to ~1–2 entries worst case.
	ticker := time.NewTicker(100 * time.Millisecond)
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
