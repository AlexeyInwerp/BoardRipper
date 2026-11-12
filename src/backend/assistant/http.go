package assistant

import (
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Routes registers the assistant's endpoints. They sit outside /api/mcp on
// purpose: the CSRF same-origin check exempts that prefix. wrap is applied to
// every handler (the credential host allow-list). enabled reports whether
// the AI server is on — the assistant reaches the board through it.
func (m *Manager) Routes(mux *http.ServeMux, wrap func(http.Handler) http.Handler, enabled func() bool) {
	h := func(pattern string, f http.HandlerFunc) { mux.Handle(pattern, wrap(f)) }

	h("GET /api/assistant/config", func(w http.ResponseWriter, r *http.Request) {
		b, ok := browserFromQuery(w, r)
		if !ok {
			return
		}
		writeJSON(w, m.Store.public(b))
	})
	h("POST /api/assistant/config", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			ClientID string `json:"client_id"`
			ConfigChange
		}
		if !decode(w, r, &req) || !validBrowser(w, req.ClientID) {
			return
		}
		if err := m.Store.apply(req.ClientID, req.ConfigChange); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		writeJSON(w, m.Store.public(req.ClientID))
	})
	h("GET /api/assistant/models", func(w http.ResponseWriter, r *http.Request) {
		b, ok := browserFromQuery(w, r)
		if !ok {
			return
		}
		ids, err := m.Models(r.Context(), b, r.URL.Query().Get("provider"))
		if err != nil {
			writeJSON(w, map[string]any{"models": []string{}, "error": err.Error()})
			return
		}
		writeJSON(w, map[string]any{"models": ids})
	})
	h("POST /api/assistant/chat", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			ClientID     string `json:"client_id"`
			Conversation string `json:"conversation"`
			Message      string `json:"message"`
		}
		if !decode(w, r, &req) || !validBrowser(w, req.ClientID) {
			return
		}
		if strings.TrimSpace(req.Message) == "" {
			http.Error(w, "empty message", http.StatusBadRequest)
			return
		}
		// A turn can wait minutes on a tool approval; the server's 5-minute
		// write timeout must not cut the stream.
		_ = http.NewResponseController(w).SetWriteDeadline(time.Time{})
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("X-Accel-Buffering", "no")
		flusher, _ := w.(http.Flusher)
		var mu sync.Mutex
		emit := func(ev Event) {
			mu.Lock()
			defer mu.Unlock()
			b, _ := json.Marshal(ev)
			_, _ = w.Write([]byte("data: "))
			_, _ = w.Write(b)
			_, _ = w.Write([]byte("\n\n"))
			if flusher != nil {
				flusher.Flush()
			}
		}
		if enabled != nil && !enabled() {
			emit(Event{Type: "error", Message: "The AI server is off. Turn it on in Settings ▸ Integrations; the assistant reaches the board through it."})
			emit(Event{Type: "done"})
			return
		}
		m.Run(r.Context(), req.ClientID, req.Conversation, req.Message, emit)
	})
	h("POST /api/assistant/approve", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			ClientID     string `json:"client_id"`
			Conversation string `json:"conversation"`
			ID           string `json:"id"`
			Decision     string `json:"decision"`
		}
		if !decode(w, r, &req) || !validBrowser(w, req.ClientID) {
			return
		}
		if err := m.Approve(req.ClientID, req.Conversation, req.ID, req.Decision); err != nil {
			http.Error(w, err.Error(), http.StatusConflict)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
	for _, action := range []string{"stop", "reset"} {
		action := action
		h("POST /api/assistant/"+action, func(w http.ResponseWriter, r *http.Request) {
			var req struct {
				ClientID     string `json:"client_id"`
				Conversation string `json:"conversation"`
			}
			if !decode(w, r, &req) || !validBrowser(w, req.ClientID) {
				return
			}
			if action == "stop" {
				m.Stop(req.ClientID, req.Conversation)
			} else {
				m.Reset(req.ClientID, req.Conversation)
			}
			w.WriteHeader(http.StatusNoContent)
		})
	}
}

func validBrowser(w http.ResponseWriter, id string) bool {
	if len(id) < 8 || len(id) > 64 {
		http.Error(w, "client_id must be 8-64 characters", http.StatusBadRequest)
		return false
	}
	return true
}

func browserFromQuery(w http.ResponseWriter, r *http.Request) (string, bool) {
	id := r.URL.Query().Get("client_id")
	return id, validBrowser(w, id)
}

func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(v); err != nil {
		http.Error(w, "bad request body", http.StatusBadRequest)
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}
