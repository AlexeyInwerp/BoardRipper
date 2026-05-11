// Package updater fetches and verifies signed manifests from the configured
// source list and orchestrates self-update via Docker socket.
package updater

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Network-asset download caps. The signed manifest carries an exact SizeBytes
// for the tarball; we use it. The fallback cap exists for forward-compat with
// older or hand-edited manifests that omit it — a malicious mirror serving an
// infinite stream would otherwise OOM the container or fill the data volume
// before any integrity check ran.
const (
	downloadTimeout      = 10 * time.Minute // accommodates 30–40 MB tarball over slow links
	fallbackMaxAssetSize = 1 << 30          // 1 GiB hard cap when SizeBytes is unset
)

// Build-time variables injected via -ldflags.
var (
	Version    = "dev"
	PubKey     = "" // base64-encoded minisign public key
	SourceList = "" // comma-separated mirror base URLs
)

// Sources returns the parsed source list.
func Sources() []string {
	if SourceList == "" {
		return nil
	}
	parts := []string{}
	for _, s := range splitCSV(SourceList) {
		s = strings.TrimSpace(s)
		if s != "" { parts = append(parts, s) }
	}
	return parts
}

func splitCSV(s string) []string {
	out := []string{}
	cur := ""
	for _, r := range s {
		if r == ',' {
			out = append(out, cur)
			cur = ""
		} else {
			cur += string(r)
		}
	}
	if cur != "" { out = append(out, cur) }
	return out
}

// UpdateState is the cached result of the last update check.
type UpdateState struct {
	CurrentVersion string     `json:"current_version"`
	LatestVersion  string     `json:"latest_version,omitempty"`
	HasUpdate      bool       `json:"has_update"`
	CheckedAt      *time.Time `json:"checked_at,omitempty"`
	Manifest       *Manifest  `json:"manifest,omitempty"`
	Error          string     `json:"error,omitempty"`
	DockerAvail    bool       `json:"docker_available"`
}

// ProgressEntry is one line of update progress.
type ProgressEntry struct {
	Time    time.Time `json:"time"`
	Message string    `json:"message"`
	Status  string    `json:"status"` // "info", "error", "done"
}

// Updater manages update checking and application.
type Updater struct {
	mu       sync.RWMutex
	state    UpdateState
	progress []ProgressEntry
	updating bool
	stopCh   chan struct{}
	dataDir  string
}

// New creates an Updater. dataDir is where downloaded assets are staged.
func New(dataDir string) *Updater {
	return &Updater{
		state: UpdateState{
			CurrentVersion: Version,
			DockerAvail:    isDockerAvailable(),
		},
		dataDir: dataDir,
		stopCh:  make(chan struct{}),
	}
}

// State returns a snapshot of the current update state.
func (u *Updater) State() UpdateState {
	u.mu.RLock()
	defer u.mu.RUnlock()
	s := u.state
	s.DockerAvail = isDockerAvailable()
	return s
}

// Progress returns all progress entries since the last update attempt.
func (u *Updater) Progress() []ProgressEntry {
	u.mu.RLock()
	defer u.mu.RUnlock()
	out := make([]ProgressEntry, len(u.progress))
	copy(out, u.progress)
	return out
}

// IsUpdating returns true if an update is in progress.
func (u *Updater) IsUpdating() bool {
	u.mu.RLock()
	defer u.mu.RUnlock()
	return u.updating
}

func (u *Updater) logProgress(msg, status string) {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.progress = append(u.progress, ProgressEntry{
		Time:    time.Now(),
		Message: msg,
		Status:  status,
	})
	log.Printf("[updater] %s", msg)
}

// PushError appends a terminal "error" entry to the progress log. Used by
// the HTTP handler to forward Apply()/ApplyBundle() return values that
// would otherwise be invisible to the SSE stream — without this, a failure
// in applyTarball or orchestrateRestart's preflight (the early returns
// before any logProgress call) leaves the frontend stuck on "Updating…"
// until the 2-minute health-poll timeout expires.
func (u *Updater) PushError(msg string) {
	u.logProgress(msg, "error")
}

// Check queries the configured sources for the latest release and updates cached state.
func (u *Updater) Check() (*UpdateState, error) {
	if PubKey == "" {
		u.mu.Lock()
		u.state.Error = "updater not configured: PubKey is empty (built without -ldflags)"
		u.mu.Unlock()
		return &u.state, errors.New(u.state.Error)
	}
	srcs := Sources()
	if len(srcs) == 0 {
		u.mu.Lock()
		u.state.Error = "updater not configured: SourceList is empty"
		u.mu.Unlock()
		return &u.state, errors.New(u.state.Error)
	}
	m, err := FetchFromSources(srcs, PubKey)
	now := time.Now()
	u.mu.Lock()
	defer u.mu.Unlock()
	u.state.CheckedAt = &now
	if err != nil {
		u.state.Error = err.Error()
		u.state.HasUpdate = false
		return &u.state, err
	}
	installedCtr := u.readInstalledCounter()
	if err := ValidateManifest(m, installedCtr, Version); err != nil {
		u.state.Error = err.Error()
		u.state.HasUpdate = false
		return &u.state, err
	}
	u.state.Error = ""
	u.state.LatestVersion = m.Version
	// HasUpdate requires both a higher counter AND a different version. This
	// surfaces a re-signed-but-same-version manifest (e.g., post-expiry re-sign
	// pointing at the existing release) as "no update" — counter advances are
	// freshness, not new code.
	u.state.HasUpdate = m.Counter > installedCtr && m.Version != Version
	u.state.Manifest = m
	return &u.state, nil
}

// StartBackgroundChecker runs a periodic check every interval.
func (u *Updater) StartBackgroundChecker(interval time.Duration) {
	go func() {
		// Initial check after 30s
		select {
		case <-time.After(30 * time.Second):
		case <-u.stopCh:
			return
		}
		u.Check()

		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				u.Check()
			case <-u.stopCh:
				return
			}
		}
	}()
}

// Stop halts the background checker.
func (u *Updater) Stop() {
	close(u.stopCh)
}

// Apply downloads a release image and orchestrates the container update.
func (u *Updater) Apply() error {
	u.mu.Lock()
	if u.updating {
		u.mu.Unlock()
		return errors.New("update already in progress")
	}
	u.updating = true
	u.progress = nil
	m := u.state.Manifest
	u.mu.Unlock()
	defer func() { u.mu.Lock(); u.updating = false; u.mu.Unlock() }()

	if m == nil {
		return errors.New("no manifest available — call Check() first")
	}
	if !isDockerAvailable() {
		return errors.New("Docker socket not available")
	}

	// Tag the previous image for rollback (best-effort).
	if err := u.tagPrevious(); err != nil {
		u.logProgress("warn: tagPrevious failed: "+err.Error()+" (rollback unavailable)", "info")
	}

	// 1. Try pull-by-digest from registry; fall back to tarball.
	pulledOK := false
	if m.Image.Registry != "" && m.Image.Digest != "" {
		if err := u.dockerPullByDigest(m.Image.Registry, m.Image.Digest); err != nil {
			u.logProgress("Registry pull failed, falling back to tarball: "+err.Error(), "info")
		} else {
			pulledOK = true
		}
	}
	if !pulledOK {
		if err := u.applyTarball(m); err != nil {
			return fmt.Errorf("tarball apply: %w", err)
		}
	}

	// 2. Persist new counter BEFORE restart so a failed restart doesn't lose progress.
	if err := u.writeInstalledCounter(m.Counter); err != nil {
		u.logProgress("warn: counter persist: "+err.Error(), "info")
	}

	// 3. Restart via orchestrator.
	return u.orchestrateRestart(m)
}

// applyTarball downloads, verifies, and docker-loads the release tarball.
func (u *Updater) applyTarball(m *Manifest) error {
	dest := filepath.Join(u.dataDir, "boardripper-"+m.Version+".tar.gz")
	if err := downloadAssetVerified(m.Tarball.URLPrimary, dest, m.Tarball.SizeBytes, m.Tarball.SHA256); err != nil {
		return fmt.Errorf("download: %w", err)
	}
	if err := u.dockerLoad(dest); err != nil {
		return fmt.Errorf("docker load: %w", err)
	}
	return nil
}

// downloadAssetVerified streams url → dest while computing SHA-256 and
// enforcing both the manifest's declared size and a hard fallback cap. A
// malicious mirror serving a never-ending stream is rejected before it can
// fill the data volume; a stream that diverges from the signed SHA fails the
// hash check after the bytes have already been written, but never grows the
// file beyond the cap. Streaming avoids the previous os.ReadFile-after-copy
// pattern that doubled peak RAM on a 30–40 MB tarball.
func downloadAssetVerified(url, dest string, sizeBytes int64, expectedSHA256 string) error {
	client := &http.Client{Timeout: downloadTimeout}
	resp, err := client.Get(url) //nolint:gosec // URL comes from a signed manifest
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("HTTP %d downloading %s", resp.StatusCode, url)
	}

	maxBytes := sizeBytes
	if maxBytes <= 0 {
		maxBytes = fallbackMaxAssetSize
	}
	// Read one byte past the cap so io.Copy returns n > maxBytes when the
	// upstream actually ships more (otherwise io.LimitReader silently truncates
	// at exactly the limit and a too-long stream looks identical to a perfect fit).
	body := io.LimitReader(resp.Body, maxBytes+1)

	out, err := os.Create(dest)
	if err != nil {
		return err
	}
	defer out.Close()

	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(out, h), body)
	if err != nil {
		return fmt.Errorf("stream copy: %w", err)
	}
	if n > maxBytes {
		return fmt.Errorf("asset exceeds cap: read %d bytes, cap %d", n, maxBytes)
	}
	if sizeBytes > 0 && n != sizeBytes {
		return fmt.Errorf("asset size mismatch: got %d bytes, manifest declared %d", n, sizeBytes)
	}
	if expectedSHA256 != "" {
		got := hex.EncodeToString(h.Sum(nil))
		want := strings.ToLower(strings.TrimSpace(expectedSHA256))
		if got != want {
			return fmt.Errorf("sha256 mismatch: got %s, want %s", got, want)
		}
	}
	return nil
}

// parseVersion extracts numeric parts from a version string.
// Pre-release sorts below release via -1 marker:
//   "v0.3.0"        → [0, 3, 0]
//   "v0.3.0-beta.1" → [0, 3, 0, -1, 1]
// Git describe suffixes are stripped: "v0.2.6-beta-4-g9572f7b" → [0, 2, 6, -1]
func parseVersion(v string) []int {
	v = strings.TrimPrefix(v, "v")

	// Strip git describe suffix: "-N-gHASH" at the end
	// e.g. "0.2.6-beta-4-g9572f7b" → "0.2.6-beta"
	if idx := strings.LastIndex(v, "-g"); idx >= 0 {
		// Verify it looks like a git hash after -g
		hash := v[idx+2:]
		if len(hash) >= 7 && len(hash) <= 40 {
			v = v[:idx]
			// Also strip the commit count: "0.2.6-beta-4" → "0.2.6-beta"
			if dashIdx := strings.LastIndex(v, "-"); dashIdx >= 0 {
				if _, err := strconv.Atoi(v[dashIdx+1:]); err == nil {
					v = v[:dashIdx]
				}
			}
		}
	}

	// Separate pre-release label from version core: "0.2.5-beta.1" → core="0.2.5", pre="beta.1"
	preRelease := ""
	if idx := strings.Index(v, "-"); idx >= 0 {
		preRelease = v[idx+1:]
		v = v[:idx]
	}

	parts := strings.Split(v, ".")
	nums := make([]int, 0, len(parts)+2)
	for _, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil {
			continue
		}
		nums = append(nums, n)
	}

	if preRelease != "" {
		// Pre-release sorts BELOW the release: append -1 marker, then pre-release number.
		// e.g. v0.3.0-beta.1 → [0,3,0,-1,1] < v0.3.0 → [0,3,0]
		nums = append(nums, -1)
		for _, p := range strings.Split(preRelease, ".") {
			n, err := strconv.Atoi(p)
			if err != nil {
				continue
			}
			nums = append(nums, n)
		}
	}

	return nums
}

func (u *Updater) installedCounterPath() string {
	return filepath.Join(u.dataDir, ".update-counter")
}

func (u *Updater) readInstalledCounter() int64 {
	b, err := os.ReadFile(u.installedCounterPath())
	if err != nil { return 0 }
	n, _ := strconv.ParseInt(strings.TrimSpace(string(b)), 10, 64)
	return n
}

func (u *Updater) writeInstalledCounter(n int64) error {
	// 0o600 matches .update-secret — neither file should be readable by
	// processes other than the BoardRipper user. World-readable opens up
	// "any container on the host can zero this and replay a stale signed
	// manifest" — see the secure-update-pipeline audit.
	return os.WriteFile(u.installedCounterPath(), []byte(strconv.FormatInt(n, 10)), 0o600)
}
