package mcpserver

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const pairingsFile = "mcp-pairings.json"

// Pairing binds one per-browser client identity to its bearer token. Not a
// security boundary (internal tool, trusted LAN) — pairing exists so each
// technician's agent is scoped to their own browser sessions instead of the
// install-wide most-recently-focused page.
type Pairing struct {
	Token     string    `json:"token"`
	ClientID  string    `json:"client_id"`
	Label     string    `json:"label"`
	CreatedAt time.Time `json:"created_at"`
	LastUsed  time.Time `json:"last_used"`
}

// PairingStore is the persisted client_id → token registry, one token per
// client. All methods are concurrency-safe; every mutation is written through
// to <dataDir>/mcp-pairings.json (0600, atomic tmp+rename).
type PairingStore struct {
	mu       sync.Mutex
	path     string
	byClient map[string]*Pairing
}

// LoadPairings reads (or initialises) the pairing registry under dataDir.
// A missing file is not an error; a corrupt file is (fail loud, the operator
// can delete it).
func LoadPairings(dataDir string) (*PairingStore, error) {
	ps := &PairingStore{
		path:     filepath.Join(dataDir, pairingsFile),
		byClient: map[string]*Pairing{},
	}
	b, err := os.ReadFile(ps.path)
	if errors.Is(err, os.ErrNotExist) {
		return ps, nil
	}
	if err != nil {
		return nil, err
	}
	var file struct {
		Pairings []*Pairing `json:"pairings"`
	}
	if err := json.Unmarshal(b, &file); err != nil {
		return nil, err
	}
	for _, p := range file.Pairings {
		if p.ClientID != "" && p.Token != "" {
			ps.byClient[p.ClientID] = p
		}
	}
	return ps, nil
}

// PairClient returns the client's token, minting one on first pairing.
// Re-pairing is idempotent (same token) but refreshes the stored label.
func (ps *PairingStore) PairClient(clientID, label string) (string, error) {
	ps.mu.Lock()
	defer ps.mu.Unlock()
	if p := ps.byClient[clientID]; p != nil {
		if label != "" && label != p.Label {
			p.Label = label
			if err := ps.persistLocked(); err != nil {
				return "", err
			}
		}
		return p.Token, nil
	}
	tok, err := newPairingToken()
	if err != nil {
		return "", err
	}
	ps.byClient[clientID] = &Pairing{Token: tok, ClientID: clientID, Label: label, CreatedAt: time.Now()}
	if err := ps.persistLocked(); err != nil {
		return "", err
	}
	return tok, nil
}

// Rotate mints a replacement token for an already-paired client; the previous
// token stops resolving immediately.
func (ps *PairingStore) Rotate(clientID string) (string, error) {
	ps.mu.Lock()
	defer ps.mu.Unlock()
	p := ps.byClient[clientID]
	if p == nil {
		return "", errors.New("client not paired")
	}
	tok, err := newPairingToken()
	if err != nil {
		return "", err
	}
	p.Token = tok
	p.CreatedAt = time.Now()
	if err := ps.persistLocked(); err != nil {
		return "", err
	}
	return tok, nil
}

// ClientForToken resolves a bearer token to its client id. Constant-time
// comparison per entry; the registry is a handful of technicians, so the loop
// is trivially cheap.
func (ps *PairingStore) ClientForToken(token string) (string, bool) {
	if token == "" {
		return "", false
	}
	ps.mu.Lock()
	defer ps.mu.Unlock()
	tb := []byte(token)
	for id, p := range ps.byClient {
		if subtle.ConstantTimeCompare(tb, []byte(p.Token)) == 1 {
			p.LastUsed = time.Now() // best-effort; persisted on next mutation
			return id, true
		}
	}
	return "", false
}

// LabelFor returns the stored label for a client id ("" when unknown).
func (ps *PairingStore) LabelFor(clientID string) string {
	ps.mu.Lock()
	defer ps.mu.Unlock()
	if p := ps.byClient[clientID]; p != nil {
		return p.Label
	}
	return ""
}

func (ps *PairingStore) persistLocked() error {
	var file struct {
		Pairings []*Pairing `json:"pairings"`
	}
	for _, p := range ps.byClient {
		file.Pairings = append(file.Pairings, p)
	}
	b, err := json.MarshalIndent(&file, "", "  ")
	if err != nil {
		return err
	}
	tmp := ps.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, ps.path)
}

func newPairingToken() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}
