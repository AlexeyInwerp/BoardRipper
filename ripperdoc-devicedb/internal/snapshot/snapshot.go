// Package snapshot generates the signed `.tar.gz` snapshot of the canonical
// entity tables that BoardRipper installs pull from `/v1/snapshots/latest`.
//
// Strict invariant per spec §9 #2: only entity tables leave the server.
// Contributions, contributors, *_tokens, and audit tables MUST NOT be in the
// tarball — a leak of *_tokens would be catastrophic.
package snapshot

import (
	"archive/tar"
	"compress/gzip"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"ripperdoc.de/devicedb/internal/store"
)

// Manifest is the wire shape of GET /v1/snapshots/latest, mirroring spec §6.4.
type Manifest struct {
	Version             int    `json:"version"`
	Counter             int    `json:"counter"`
	ReleasedAt          string `json:"released_at"`
	NotAfter            string `json:"not_after"`
	MinSupportedVersion string `json:"min_supported_version"`
	TarballURL          string `json:"tarball_url"`
	TarballSHA256       string `json:"tarball_sha256"`
	SizeBytes           int64  `json:"size_bytes"`
	Signature           string `json:"signature"`
}

// Manager owns the snapshot output dir + the signing key. Single-flight via
// mu so concurrent Regenerate calls don't race.
type Manager struct {
	store      *store.Store
	outputDir  string
	tarballURL string // base URL for the tarball (without filename) — handler may also re-route /v1/snapshots/<n>/tarball internally
	mu         sync.Mutex
	priv       ed25519.PrivateKey
	pub        ed25519.PublicKey
	devKey     bool
}

// NewManager creates the manager. If keyPath is empty, a dev keypair is
// generated in-process and a WARNING is logged — fine for prototype, never
// acceptable in production (see spec §7.2 "offline-signing chore").
func NewManager(s *store.Store, outputDir, tarballURL, keyPath string) (*Manager, error) {
	if err := os.MkdirAll(outputDir, 0o755); err != nil {
		return nil, fmt.Errorf("mkdir snapshot dir: %w", err)
	}
	m := &Manager{store: s, outputDir: outputDir, tarballURL: tarballURL}

	if keyPath != "" {
		if _, err := os.Stat(keyPath); err == nil {
			b, err := os.ReadFile(keyPath)
			if err != nil {
				return nil, fmt.Errorf("read snapshot key: %w", err)
			}
			if len(b) != ed25519.PrivateKeySize {
				return nil, fmt.Errorf("snapshot key wrong size: %d", len(b))
			}
			m.priv = ed25519.PrivateKey(b)
			m.pub = m.priv.Public().(ed25519.PublicKey)
			log.Printf("[devicedb] [snapshot] loaded signing key from %s", keyPath)
			return m, nil
		}
		log.Printf("[devicedb] [snapshot] key path %s does not exist, generating dev key", keyPath)
	}
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	m.priv = priv
	m.pub = pub
	m.devKey = true
	log.Printf("[devicedb] [snapshot] WARNING: using ephemeral dev signing key (pubkey=%s); set SNAPSHOT_PRIVATE_KEY_PATH for production",
		base64.StdEncoding.EncodeToString(pub))
	return m, nil
}

// PublicKey returns the in-use Ed25519 public key (base64) for diagnostics.
func (m *Manager) PublicKey() string {
	return base64.StdEncoding.EncodeToString(m.pub)
}

// LatestManifest reads `latest-manifest.json` from outputDir; returns
// ErrNoSnapshot if none has been generated yet.
var ErrNoSnapshot = errors.New("no snapshot generated yet")

func (m *Manager) LatestManifest() (*Manifest, error) {
	path := filepath.Join(m.outputDir, "latest-manifest.json")
	b, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil, ErrNoSnapshot
	}
	if err != nil {
		return nil, err
	}
	var man Manifest
	if err := json.Unmarshal(b, &man); err != nil {
		return nil, err
	}
	return &man, nil
}

// TarballPath returns the on-disk path to the `.tar.gz` for the given counter.
func (m *Manager) TarballPath(counter int) string {
	return filepath.Join(m.outputDir, fmt.Sprintf("boards-%d.tar.gz", counter))
}

// Regenerate creates a fresh snapshot, signs the manifest, writes
// `boards-<counter>.tar.gz` + `latest-manifest.json`. Single-flight via mu.
//
// Returns the generated manifest (with `signature` populated).
func (m *Manager) Regenerate() (*Manifest, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	// Read current counter; bump for the new snapshot.
	var counter int
	if err := m.store.DB.QueryRow("SELECT counter FROM snapshot_state WHERE id=1").Scan(&counter); err != nil {
		return nil, err
	}
	counter++

	// VACUUM INTO a temp file, then filter out the non-entity tables.
	tmpDB := filepath.Join(m.outputDir, fmt.Sprintf("staging-%d.db", counter))
	_ = os.Remove(tmpDB)
	defer os.Remove(tmpDB)

	// SQLite VACUUM INTO does not accept bound parameters — the path must be a
	// string literal. Path is server-generated (filepath.Join with a numeric
	// counter) so no untrusted input flows in here.
	escaped := strings.ReplaceAll(tmpDB, "'", "''")
	if _, err := m.store.DB.Exec("VACUUM INTO '" + escaped + "'"); err != nil {
		return nil, fmt.Errorf("vacuum into: %w", err)
	}

	// Open the staging copy and drop tables that must never leave the server.
	stage, err := sql.Open("sqlite", "file:"+tmpDB+"?_pragma=foreign_keys(off)")
	if err != nil {
		return nil, err
	}
	dropTables := []string{
		"contribution_audit", "contributions", "install_tokens", "user_tokens",
		"contributors", "snapshot_state", "seed_state",
	}
	for _, t := range dropTables {
		if _, err := stage.Exec("DROP TABLE IF EXISTS " + t); err != nil {
			stage.Close()
			return nil, fmt.Errorf("drop %s: %w", t, err)
		}
	}
	// Compact after dropping.
	if _, err := stage.Exec("VACUUM"); err != nil {
		stage.Close()
		return nil, err
	}
	stage.Close()

	// Build tarball.
	tarPath := m.TarballPath(counter)
	tarTmp := tarPath + ".tmp"
	if err := writeTarball(tarTmp, tmpDB, counter); err != nil {
		return nil, err
	}
	// sha256
	sum, size, err := sha256File(tarTmp)
	if err != nil {
		return nil, err
	}
	if err := os.Rename(tarTmp, tarPath); err != nil {
		return nil, err
	}

	now := time.Now().UTC()
	man := &Manifest{
		Version:             1,
		Counter:             counter,
		ReleasedAt:          now.Format(time.RFC3339),
		NotAfter:            now.Add(90 * 24 * time.Hour).Format(time.RFC3339),
		MinSupportedVersion: "0.31.0",
		TarballURL:          fmt.Sprintf("%s/boards-%d.tar.gz", trimTrailingSlash(m.tarballURL), counter),
		TarballSHA256:       sum,
		SizeBytes:           size,
	}
	signMe, err := canonicalManifestBytes(man)
	if err != nil {
		return nil, err
	}
	sig := ed25519.Sign(m.priv, signMe)
	man.Signature = base64.StdEncoding.EncodeToString(sig)
	if m.devKey {
		log.Printf("[devicedb] [snapshot] regenerated counter=%d (dev-signed)", counter)
	} else {
		log.Printf("[devicedb] [snapshot] regenerated counter=%d", counter)
	}

	manPath := filepath.Join(m.outputDir, "latest-manifest.json")
	manTmp := manPath + ".tmp"
	manBytes, _ := json.MarshalIndent(man, "", "  ")
	if err := os.WriteFile(manTmp, manBytes, 0o644); err != nil {
		return nil, err
	}
	if err := os.Rename(manTmp, manPath); err != nil {
		return nil, err
	}

	// Persist new counter + clear dirty.
	if _, err := m.store.DB.Exec(`UPDATE snapshot_state SET counter=?, dirty=0, last_generated_at=? WHERE id=1`,
		counter, now.Format(time.RFC3339)); err != nil {
		return nil, err
	}
	return man, nil
}

// canonicalManifestBytes serializes the manifest minus the signature, in a
// deterministic byte order, so the receiver can verify.
func canonicalManifestBytes(m *Manifest) ([]byte, error) {
	// Order matters for verification. Hand-build to avoid map randomness.
	type ordered struct {
		Version             int    `json:"version"`
		Counter             int    `json:"counter"`
		ReleasedAt          string `json:"released_at"`
		NotAfter            string `json:"not_after"`
		MinSupportedVersion string `json:"min_supported_version"`
		TarballURL          string `json:"tarball_url"`
		TarballSHA256       string `json:"tarball_sha256"`
		SizeBytes           int64  `json:"size_bytes"`
	}
	return json.Marshal(ordered{
		Version: m.Version, Counter: m.Counter, ReleasedAt: m.ReleasedAt, NotAfter: m.NotAfter,
		MinSupportedVersion: m.MinSupportedVersion, TarballURL: m.TarballURL,
		TarballSHA256: m.TarballSHA256, SizeBytes: m.SizeBytes,
	})
}

func writeTarball(outPath, dbPath string, counter int) error {
	f, err := os.Create(outPath)
	if err != nil {
		return err
	}
	defer f.Close()
	gz := gzip.NewWriter(f)
	defer gz.Close()
	tw := tar.NewWriter(gz)
	defer tw.Close()

	// 1. boards.db
	dbBytes, err := os.ReadFile(dbPath)
	if err != nil {
		return err
	}
	hdr := &tar.Header{
		Name:    "boards.db",
		Mode:    0o644,
		Size:    int64(len(dbBytes)),
		ModTime: time.Now(),
	}
	if err := tw.WriteHeader(hdr); err != nil {
		return err
	}
	if _, err := tw.Write(dbBytes); err != nil {
		return err
	}

	// 2. metadata.json
	meta := map[string]any{
		"counter":        counter,
		"generated_at":   time.Now().UTC().Format(time.RFC3339),
		"schema_version": 2,
	}
	metaBytes, _ := json.MarshalIndent(meta, "", "  ")
	hdr2 := &tar.Header{
		Name:    "metadata.json",
		Mode:    0o644,
		Size:    int64(len(metaBytes)),
		ModTime: time.Now(),
	}
	if err := tw.WriteHeader(hdr2); err != nil {
		return err
	}
	if _, err := tw.Write(metaBytes); err != nil {
		return err
	}
	return nil
}

func sha256File(path string) (string, int64, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", 0, err
	}
	defer f.Close()
	h := sha256.New()
	n, err := io.Copy(h, f)
	if err != nil {
		return "", 0, err
	}
	return hex.EncodeToString(h.Sum(nil)), n, nil
}

func trimTrailingSlash(s string) string {
	for len(s) > 0 && s[len(s)-1] == '/' {
		s = s[:len(s)-1]
	}
	return s
}
