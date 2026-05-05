// Package updater checks GitHub Releases for new BoardRipper versions
// and orchestrates self-update via Docker socket.
package updater

import (
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
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
	panic("phase D: Apply rewritten in D3")
}

// isNewer returns true if release > current, comparing semver-like tags.
func isNewer(release, current string) bool {
	rp := parseVersion(release)
	cp := parseVersion(current)

	for i := 0; i < len(rp) && i < len(cp); i++ {
		if rp[i] > cp[i] {
			return true
		}
		if rp[i] < cp[i] {
			return false
		}
	}
	// If all numeric parts equal, more parts = newer (0.2.5.1 > 0.2.5)
	return len(rp) > len(cp)
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

func humanSize(bytes int64) string {
	if bytes < 1024 {
		return fmt.Sprintf("%d B", bytes)
	}
	kb := float64(bytes) / 1024
	if kb < 1024 {
		return fmt.Sprintf("%.1f KB", kb)
	}
	mb := kb / 1024
	return fmt.Sprintf("%.1f MB", mb)
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
	return os.WriteFile(u.installedCounterPath(), []byte(strconv.FormatInt(n, 10)), 0o644)
}
