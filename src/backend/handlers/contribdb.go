package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"

	"boardripper/contribdb"
	"boardripper/databank"
)

// ContribDBHandler serves /api/contribdb/* endpoints.
//
// Reuses the existing local-cookie auth used elsewhere — wiring happens in
// main.go via the gzip/CSRF middleware that wraps the whole mux. No extra
// gate here: these handlers act on the user's own install (mirrors §6.2
// of the spec).
type ContribDBHandler struct {
	svc *contribdb.Service
	db  *databank.DB
}

// NewContribDBHandler constructs a handler. svc may be nil (when
// CONTRIBDB_ENABLED=false); all endpoints then 503 with a stable shape.
func NewContribDBHandler(svc *contribdb.Service, db *databank.DB) *ContribDBHandler {
	return &ContribDBHandler{svc: svc, db: db}
}

// enabledOrFail short-circuits with 503 + a JSON body when the service
// is disabled. Centralised so handlers stay one-liner predicates above
// real work.
func (h *ContribDBHandler) enabledOrFail(w http.ResponseWriter) bool {
	if h.svc == nil || !h.svc.Enabled() {
		writeJSONStatus(w, http.StatusServiceUnavailable,
			map[string]string{"error": "contribdb_disabled"})
		return false
	}
	return true
}

// Status returns the current sync/outbox snapshot for the Settings UI.
func (h *ContribDBHandler) Status(w http.ResponseWriter, r *http.Request) {
	if h.svc == nil {
		writeJSON(w, contribdb.Status{Enabled: false})
		return
	}
	writeJSON(w, h.svc.Status())
}

// Submit accepts a frontend submission, persists it to the outbox, and
// triggers an asynchronous push. Returns immediately with the local UUID
// and the row's initial status. Body shape mirrors the §5.5 schema but
// allows the frontend to omit the client_ts (we always re-stamp on push).
//
// Note: this handler intentionally does not block on the network push —
// the outbox is the source of truth and the scheduler retries on its own.
func (h *ContribDBHandler) Submit(w http.ResponseWriter, r *http.Request) {
	if !h.enabledOrFail(w) {
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Target struct {
			Type  string `json:"type"`
			UUID  string `json:"uuid"`
			Field string `json:"field"`
		} `json:"target"`
		To       string `json:"to"`
		From     string `json:"from"`
		Evidence struct {
			SourceURL      string          `json:"source_url"`
			BoardInHand    bool            `json:"board_in_hand"`
			BoardInHandCtx json.RawMessage `json:"board_in_hand_ctx"`
			Rationale      string          `json:"rationale"`
		} `json:"evidence"`
		Confidence string `json:"confidence"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 256<<10)
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid JSON: "+err.Error(), http.StatusBadRequest)
		return
	}
	if body.Target.Type == "" || body.Target.UUID == "" || body.Target.Field == "" {
		http.Error(w, "target.type, target.uuid, target.field required", http.StatusBadRequest)
		return
	}
	if body.Evidence.SourceURL == "" && !body.Evidence.BoardInHand && len(body.Evidence.Rationale) < 4 {
		http.Error(w, "evidence required (source_url, board_in_hand, or rationale ≥4 chars)",
			http.StatusBadRequest)
		return
	}

	sub := &contribdb.Submission{
		LocalUUID:         uuid.New().String(),
		TargetType:        body.Target.Type,
		TargetUUID:        body.Target.UUID,
		TargetField:       body.Target.Field,
		ValueTo:           body.To,
		ValueFrom:         body.From,
		EvidenceSourceURL: body.Evidence.SourceURL,
		EvidenceInHand:    body.Evidence.BoardInHand,
		EvidenceRationale: body.Evidence.Rationale,
		Confidence:        body.Confidence,
		Status:            contribdb.StatusPendingSend,
		CreatedAt:         time.Now().UTC(),
	}
	if len(body.Evidence.BoardInHandCtx) > 0 {
		sub.EvidenceInHandCtx = string(body.Evidence.BoardInHandCtx)
	}
	if err := h.svc.Outbox().Enqueue(sub); err != nil {
		http.Error(w, "enqueue: "+err.Error(), http.StatusInternalServerError)
		return
	}
	// Fire-and-forget push attempt; failure leaves the row pending for
	// the scheduler to retry.
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		_ = h.svc.PushOne(ctx, sub)
	}()
	writeJSON(w, map[string]any{
		"local_uuid": sub.LocalUUID,
		"status":     sub.Status,
	})
}

// Mine returns the local outbox view. Spec §6.2: combined outbox + last-
// known server status. We return the outbox rows directly — the
// reconcile loop has already flipped statuses where the server diverged.
func (h *ContribDBHandler) Mine(w http.ResponseWriter, r *http.Request) {
	if !h.enabledOrFail(w) {
		return
	}
	rows, err := h.svc.Outbox().ListAll(500)
	if err != nil {
		http.Error(w, "list: "+err.Error(), http.StatusInternalServerError)
		return
	}
	if rows == nil {
		rows = []*contribdb.Submission{}
	}
	writeJSON(w, map[string]any{"items": rows})
}

// Sync is the manual-trigger endpoint. Runs pull → reconcile, then
// responds with the updated Status.
func (h *ContribDBHandler) Sync(w http.ResponseWriter, r *http.Request) {
	if !h.enabledOrFail(w) {
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Minute)
	defer cancel()
	pullErr := h.svc.PullSnapshot(ctx)
	recErr := h.svc.Reconcile(ctx)
	st := h.svc.Status()
	if pullErr != nil && st.LastSyncError == "" {
		st.LastSyncError = pullErr.Error()
	}
	if recErr != nil && st.LastSyncError == "" {
		st.LastSyncError = recErr.Error()
	}
	writeJSON(w, st)
}

// InstallToken returns the plaintext install token for display in
// Settings. Spec §6.2 / §6.7: this is local-only — never proxied.
func (h *ContribDBHandler) InstallToken(w http.ResponseWriter, r *http.Request) {
	if !h.enabledOrFail(w) {
		return
	}
	writeJSON(w, map[string]string{"install_token": h.svc.InstallToken()})
}

// UserToken accepts a paste-in token, validates it against the canonical
// server by calling GET /v1/contributions/mine, and persists on 200.
func (h *ContribDBHandler) UserToken(w http.ResponseWriter, r *http.Request) {
	if !h.enabledOrFail(w) {
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Token string `json:"token"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 8<<10)
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid JSON", http.StatusBadRequest)
		return
	}
	body.Token = strings.TrimSpace(body.Token)
	if body.Token == "" {
		// Empty token = clear the saved one.
		if err := h.db.SetConfig("contribdb_user_token", ""); err != nil {
			http.Error(w, "clear: "+err.Error(), http.StatusInternalServerError)
			return
		}
		_ = h.db.SetConfig("contribdb_user_handle", "")
		writeJSON(w, map[string]any{"linked": false})
		return
	}

	// Probe the server with the candidate token. Build a one-off request
	// so we don't have to mutate the persisted client's auth.
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		h.svc.Client().BaseURL()+"/v1/contributions/mine", nil)
	if err != nil {
		http.Error(w, "build: "+err.Error(), http.StatusInternalServerError)
		return
	}
	req.Header.Set("Authorization", "Bearer "+body.Token)
	resp, err := (&http.Client{Timeout: 15 * time.Second}).Do(req)
	if err != nil {
		http.Error(w, "probe: "+err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		http.Error(w, "token rejected by server", http.StatusUnauthorized)
		return
	}
	if err := h.db.SetConfig("contribdb_user_token", body.Token); err != nil {
		http.Error(w, "persist: "+err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]any{"linked": true})
}

// UserTokenStatus reports whether a user token is currently linked.
func (h *ContribDBHandler) UserTokenStatus(w http.ResponseWriter, r *http.Request) {
	if !h.enabledOrFail(w) {
		return
	}
	tok, _ := h.db.GetConfig("contribdb_user_token")
	handle, _ := h.db.GetConfig("contribdb_user_handle")
	writeJSON(w, map[string]any{
		"linked": tok != "",
		"handle": handle,
	})
}

// writeJSONStatus is a small variant of writeJSON that sets a status code
// before the body. Used by enabledOrFail to emit a 503 with JSON body.
func writeJSONStatus(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}
