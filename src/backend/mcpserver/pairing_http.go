package mcpserver

import (
	"encoding/json"
	"net/http"
	"strings"
)

// PairHandler mints (or returns) the per-browser pairing token for a client
// identity. Same-origin, unauthenticated — the same trust level as
// GET /api/mcp/token: pairing is a usability boundary on a trusted LAN, not a
// security one. 404 when MCP is disabled so the endpoint stays invisible.
func PairHandler(st *State, ps *PairingStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, label, ok := decodePairReq(st, ps, w, r)
		if !ok {
			return
		}
		tok, err := ps.PairClient(id, label)
		if err != nil {
			http.Error(w, "pairing failed: "+err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"token": tok, "label": ps.LabelFor(id)})
	}
}

// RotateHandler mints a replacement token for an already-paired client; the
// old token stops working immediately.
func RotateHandler(st *State, ps *PairingStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, _, ok := decodePairReq(st, ps, w, r)
		if !ok {
			return
		}
		tok, err := ps.Rotate(id)
		if err != nil {
			http.Error(w, "rotate failed: "+err.Error(), http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"token": tok})
	}
}

// decodePairReq shares the gating + body validation of the two pair
// endpoints; writes the error response itself when returning ok=false.
func decodePairReq(st *State, ps *PairingStore, w http.ResponseWriter, r *http.Request) (id, label string, ok bool) {
	if st == nil || !st.Enabled() || ps == nil {
		http.NotFound(w, r)
		return "", "", false
	}
	var req struct {
		ClientID string `json:"client_id"`
		Label    string `json:"label"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
		http.Error(w, "bad request body", http.StatusBadRequest)
		return "", "", false
	}
	id = strings.TrimSpace(req.ClientID)
	if len(id) < 8 || len(id) > 64 {
		http.Error(w, "client_id must be 8-64 characters", http.StatusBadRequest)
		return "", "", false
	}
	label = strings.TrimSpace(req.Label)
	if len(label) > 64 {
		label = label[:64]
	}
	return id, label, true
}
