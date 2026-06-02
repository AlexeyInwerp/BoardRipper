// Package contribdb implements the online boards-database contribution
// pipeline (spec 2026-05-18-online-boards-db-design.md, §6.1).
//
// Responsibilities:
//
//   - Mint and persist the install token at <dataDir>/.contrib-secret (mode
//     0600), retry-register with the canonical server on every boot until
//     success, and persist the assigned contributor UUID to
//     <dataDir>/.contrib-uuid.
//   - Pull the signed snapshot manifest from /v1/snapshots/latest, verify
//     its Ed25519 signature (separate keypair from the updater), fetch the
//     tarball, sha256-verify, atomically swap <dataDir>/contribdb/snapshot.db,
//     and hot-swap the running boarddb handle when the new counter beats the
//     baked-in one.
//   - Accept frontend submissions via /api/contribdb/submit, persist them to a
//     local outbox SQLite at <dataDir>/contribdb/outbox.db, and push them
//     to /v1/contributions with exponential backoff.
//   - Periodically reconcile the outbox against /v1/contributions/mine,
//     transitioning rows to accepted/rejected/superseded/withdrawn.
//
// This package mirrors the directory shape of obd/ and reuses the
// single-flight + drop-guard discipline documented in CLAUDE.md. Failure
// modes log under the "[contribdb] [scope]" prefix and surface in a
// ring buffer attached to the Status struct.
package contribdb

import (
	"context"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"

	"boardripper/boarddb"
	"boardripper/databank"
)

// DefaultBaseURL is the canonical-server base URL when no override is set
// (env DEVICEDB_BASE_URL, or databank config key contribdb_base_url).
//
// The path suffix /devicedb/api matches the public mount point of the PHP
// service on Linevast — see ripperdoc-devicedb/php/.htaccess. Client code
// concatenates "/v1/<endpoint>" onto this base, so the resolved URLs land
// at https://www.ripperdoc.de/devicedb/api/v1/<endpoint>.
//
// For local development against the Go reference at localhost:18099 (which
// serves /v1/* at its root), set DEVICEDB_BASE_URL=http://localhost:18099 .
const DefaultBaseURL = "https://www.ripperdoc.de/devicedb/api"

// Service is the contribdb runtime — installed once at boot, drives the
// register-on-boot retry, snapshot puller, outbox pusher, and reconciler.
type Service struct {
	cfg     ServiceConfig
	db      *databank.DB
	bdb     *boarddb.DB
	outbox  *Outbox
	client  *Client
	scheduler *Scheduler

	// Mutable runtime state. Guarded by mu.
	mu              sync.RWMutex
	installToken    string    // base64 plaintext, persisted in .contrib-secret
	contributorUUID string    // persisted in .contrib-uuid (populated post-register)
	registered      bool
	lastSyncAt      time.Time
	lastSyncErr     string
	snapshotCounter int64
	recentErrors    []string

	// Single-flight gates — see CLAUDE.md, obd/ pattern.
	pullingMu sync.Mutex
	pulling   bool
	pushingMu sync.Mutex
	pushing   bool
}

// ServiceConfig captures the boot-time parameters of a Service. Constructed
// inside Open() but exported for tests.
type ServiceConfig struct {
	Enabled     bool
	DataDir     string
	BaseURL     string
	Version     string // build-time version string for the version_hint field
	// SnapshotPubKey is the base64 Ed25519/minisign public key used to verify
	// the snapshot manifest. Empty disables snapshot pulls (push path still
	// works against the canonical server).
	SnapshotPubKey string
}

const (
	defaultPullInterval    = 24 * time.Hour
	defaultPushRetryDelay  = 60 * time.Second
	maxRecentErrors        = 20
	contribSecretFile      = ".contrib-secret"
	contribUUIDFile        = ".contrib-uuid"
	subdir                 = "contribdb"
	snapshotFilename       = "snapshot.db"
	outboxFilename         = "outbox.db"
)

// Open boots the contribdb service. Always returns a non-nil Service when
// enabled, even if registration fails — registration is retried on next
// boot, never blocks startup. When cfg.Enabled is false, returns a Service
// whose Status() reports disabled=true and whose handlers refuse work.
//
// db is the databank handle (used for the config table — sync cadence,
// user token, base URL override). bdb is the boards.db handle so we can
// hot-swap to a newer snapshot; pass nil if boarddb is unavailable.
func Open(ctx context.Context, db *databank.DB, bdb *boarddb.DB, cfg ServiceConfig) (*Service, error) {
	if !cfg.Enabled {
		log.Printf("[contribdb] disabled (CONTRIBDB_ENABLED=false)")
		return &Service{cfg: cfg, db: db, bdb: bdb}, nil
	}
	if cfg.BaseURL == "" {
		cfg.BaseURL = DefaultBaseURL
	}
	if err := os.MkdirAll(filepath.Join(cfg.DataDir, subdir), 0o755); err != nil {
		return nil, fmt.Errorf("contribdb: mkdir %s: %w", subdir, err)
	}

	s := &Service{
		cfg: cfg,
		db:  db,
		bdb: bdb,
	}

	// Ensure install token + load contributor UUID if present from a
	// previous boot. Register-on-boot runs async; not fatal on failure.
	tok, err := EnsureInstallSecret(cfg.DataDir)
	if err != nil {
		return nil, fmt.Errorf("contribdb: ensure secret: %w", err)
	}
	s.mu.Lock()
	s.installToken = tok
	s.contributorUUID = readContributorUUID(cfg.DataDir)
	s.registered = s.contributorUUID != ""
	s.mu.Unlock()

	// Open outbox SQLite.
	outboxPath := filepath.Join(cfg.DataDir, subdir, outboxFilename)
	ob, err := OpenOutbox(outboxPath)
	if err != nil {
		return nil, fmt.Errorf("contribdb: open outbox: %w", err)
	}
	s.outbox = ob

	// HTTP client with auth + reasonable timeouts.
	s.client = NewClient(cfg.BaseURL, tok, db)

	// Probe local snapshot counter (best-effort) so the manifest's
	// counter check has a baseline.
	if c, err := readSnapshotCounter(cfg.DataDir); err == nil {
		s.mu.Lock()
		s.snapshotCounter = c
		s.mu.Unlock()
	}

	// Hot-swap to snapshot.db if it's already on disk from a prior boot AND
	// (a) bdb is non-nil, (b) its path is not already pointing at snapshot.
	if bdb != nil && bdb.Available() {
		snapPath := filepath.Join(cfg.DataDir, subdir, snapshotFilename)
		if _, statErr := os.Stat(snapPath); statErr == nil && snapPath != bdb.Path() {
			if err := bdb.Reopen(snapPath); err != nil {
				log.Printf("[contribdb] [boot] snapshot hot-swap skipped: %v", err)
			}
		}
	}

	// Background goroutines: register retry + sync scheduler. ctx is the
	// caller's root context; cancellation drains both loops cleanly.
	s.scheduler = NewScheduler(s)
	go s.registerOnBootLoop(ctx)
	go s.scheduler.Run(ctx)

	log.Printf("[contribdb] enabled (base_url=%s, registered=%v, snapshot_counter=%d)",
		cfg.BaseURL, s.registered, s.snapshotCounter)
	return s, nil
}

// Close shuts down the service. Safe to call on a nil receiver.
func (s *Service) Close() error {
	if s == nil {
		return nil
	}
	if s.outbox != nil {
		return s.outbox.Close()
	}
	return nil
}

// Enabled returns whether the service is active.
func (s *Service) Enabled() bool {
	return s != nil && s.cfg.Enabled
}

// recordError appends a structured error string to the ring buffer.
func (s *Service) recordError(scope, msg string) {
	entry := fmt.Sprintf("%s [%s] %s", time.Now().UTC().Format(time.RFC3339), scope, msg)
	s.mu.Lock()
	s.recentErrors = append(s.recentErrors, entry)
	if len(s.recentErrors) > maxRecentErrors {
		s.recentErrors = s.recentErrors[len(s.recentErrors)-maxRecentErrors:]
	}
	s.mu.Unlock()
	log.Printf("[contribdb] [%s] %s", scope, msg)
}

// InstallToken returns the plaintext install token. Used by the
// install-token-display handler. Read under the lock so the post-mint
// state is consistent.
func (s *Service) InstallToken() string {
	if s == nil {
		return ""
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.installToken
}

// ContributorUUID returns the assigned UUID, or empty if not yet registered.
func (s *Service) ContributorUUID() string {
	if s == nil {
		return ""
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.contributorUUID
}

// Registered reports whether the install has a contributor UUID assigned.
func (s *Service) Registered() bool {
	if s == nil {
		return false
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.registered
}

// Status is the JSON payload returned by GET /api/contribdb/status. Field
// names match the spec §6 status struct.
type Status struct {
	Enabled         bool      `json:"enabled"`
	BaseURL         string    `json:"base_url"`
	InstallUUID     string    `json:"install_uuid,omitempty"`
	Registered      bool      `json:"registered"`
	LastSyncAt      time.Time `json:"last_sync_at,omitempty"`
	LastSyncError   string    `json:"last_sync_error,omitempty"`
	SnapshotCounter int64     `json:"snapshot_counter"`
	OutboxPending   int       `json:"outbox_pending"`
	OutboxFailed    int       `json:"outbox_failed"`
	RecentErrors    []string  `json:"recent_errors,omitempty"`
}

// Status returns the current service status. Safe on nil/disabled.
func (s *Service) Status() Status {
	if s == nil {
		return Status{}
	}
	if !s.cfg.Enabled {
		return Status{Enabled: false}
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	st := Status{
		Enabled:         true,
		BaseURL:         s.cfg.BaseURL,
		InstallUUID:     s.contributorUUID,
		Registered:      s.registered,
		LastSyncAt:      s.lastSyncAt,
		LastSyncError:   s.lastSyncErr,
		SnapshotCounter: s.snapshotCounter,
		RecentErrors:    append([]string(nil), s.recentErrors...),
	}
	if s.outbox != nil {
		pending, failed, _ := s.outbox.Counts()
		st.OutboxPending = pending
		st.OutboxFailed = failed
	}
	return st
}

// Outbox returns the outbox handle (for the submit/mine handlers).
func (s *Service) Outbox() *Outbox {
	if s == nil {
		return nil
	}
	return s.outbox
}

// Client returns the HTTP client. Used by handlers that need to call the
// canonical server directly (e.g. user-token validation).
func (s *Service) Client() *Client {
	if s == nil {
		return nil
	}
	return s.client
}
