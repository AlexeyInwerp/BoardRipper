package worklists

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
)

// Handler serves the worklist API:
//
//	GET    /api/worklists?since=<ms>   {docs: [...], now: <ms>}
//	GET    /api/worklists/{id}         the document (404 if none)
//	PUT    /api/worklists/{id}         body = document with the rev it was based on;
//	                                   200 = stored document, 409 = server's copy
//	DELETE /api/worklists/{id}?rev=<n> tombstone; 200 = tombstone, 409 = server's copy
type Handler struct{ Store *Store }

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeRaw(w http.ResponseWriter, code int, raw json.RawMessage) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	_, _ = w.Write(raw)
}

func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	since, _ := strconv.ParseInt(r.URL.Query().Get("since"), 10, 64)
	docs, now := h.Store.List(since)
	writeJSON(w, http.StatusOK, map[string]any{"docs": docs, "now": now})
}

func (h *Handler) Get(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !ValidID(id) {
		http.Error(w, "bad id", http.StatusBadRequest)
		return
	}
	raw, err := h.Store.Get(id)
	if errors.Is(err, ErrNotFound) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	writeRaw(w, http.StatusOK, raw)
}

func (h *Handler) Put(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !ValidID(id) {
		http.Error(w, "bad id", http.StatusBadRequest)
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, MaxDocBytes+1))
	if err != nil {
		http.Error(w, "read error", http.StatusBadRequest)
		return
	}
	raw, err := h.Store.Put(id, body)
	switch {
	case errors.Is(err, ErrConflict):
		writeRaw(w, http.StatusConflict, raw)
	case err != nil:
		http.Error(w, err.Error(), http.StatusBadRequest)
	default:
		writeRaw(w, http.StatusOK, raw)
	}
}

func (h *Handler) Delete(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !ValidID(id) {
		http.Error(w, "bad id", http.StatusBadRequest)
		return
	}
	rev, _ := strconv.ParseInt(r.URL.Query().Get("rev"), 10, 64)
	raw, err := h.Store.Delete(id, rev)
	switch {
	case errors.Is(err, ErrConflict):
		writeRaw(w, http.StatusConflict, raw)
	case err != nil:
		http.Error(w, err.Error(), http.StatusInternalServerError)
	case raw == nil:
		w.WriteHeader(http.StatusNoContent)
	default:
		writeRaw(w, http.StatusOK, raw)
	}
}
