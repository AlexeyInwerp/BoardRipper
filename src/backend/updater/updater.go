// Package updater checks GitHub Releases for new BoardRipper versions
// and orchestrates self-update via Docker socket.
package updater

import (
	"encoding/json"
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

// Build-time variables injected via -ldflags.
var (
	Version     = "dev"            // e.g. "v0.2.5-beta.1"
	GitHubToken = ""               // fine-grained PAT (read-only contents)
	RepoOwner   = "AlexeyInwerp"
	RepoName    = "BoardRipper"
)

// ReleaseInfo holds data from a GitHub release.
type ReleaseInfo struct {
	TagName     string `json:"tag_name"`
	Name        string `json:"name"`
	Body        string `json:"body"`
	PublishedAt string `json:"published_at"`
	HTMLURL     string `json:"html_url"`
	Assets      []struct {
		ID                 int64  `json:"id"`
		Name               string `json:"name"`
		BrowserDownloadURL string `json:"browser_download_url"`
		Size               int64  `json:"size"`
	} `json:"assets"`
}

// UpdateState is the cached result of the last update check.
type UpdateState struct {
	CurrentVersion string       `json:"current_version"`
	LatestVersion  string       `json:"latest_version,omitempty"`
	HasUpdate      bool         `json:"has_update"`
	CheckedAt      *time.Time   `json:"checked_at,omitempty"`
	ReleaseInfo    *ReleaseInfo `json:"release_info,omitempty"`
	Error          string       `json:"error,omitempty"`
	DockerAvail    bool         `json:"docker_available"`
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

// Check queries GitHub for the latest release and updates cached state.
func (u *Updater) Check() (*UpdateState, error) {
	rel, err := fetchLatestRelease()
	if err != nil {
		u.mu.Lock()
		u.state.Error = err.Error()
		u.mu.Unlock()
		return nil, err
	}

	now := time.Now()
	u.mu.Lock()
	u.state.LatestVersion = rel.TagName
	u.state.HasUpdate = isNewer(rel.TagName, Version)
	u.state.CheckedAt = &now
	u.state.ReleaseInfo = rel
	u.state.Error = ""
	snap := u.state
	u.mu.Unlock()

	if snap.HasUpdate {
		log.Printf("[updater] Update available: %s → %s", Version, rel.TagName)
	} else {
		log.Printf("[updater] Up to date (%s)", Version)
	}
	return &snap, nil
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

// Apply downloads the Docker image asset and orchestrates the container update.
func (u *Updater) Apply() error {
	u.mu.Lock()
	if u.updating {
		u.mu.Unlock()
		return fmt.Errorf("update already in progress")
	}
	u.updating = true
	u.progress = nil
	u.mu.Unlock()

	defer func() {
		u.mu.Lock()
		u.updating = false
		u.mu.Unlock()
	}()

	if !isDockerAvailable() {
		u.logProgress("Docker socket not available — cannot self-update", "error")
		return fmt.Errorf("docker not available")
	}

	// Ensure we have the latest release info
	u.logProgress("Checking for latest release...", "info")
	state, err := u.Check()
	if err != nil {
		u.logProgress(fmt.Sprintf("Failed to check for updates: %v", err), "error")
		return err
	}
	if !state.HasUpdate {
		u.logProgress("Already running latest version", "info")
		return fmt.Errorf("no update available")
	}

	rel := state.ReleaseInfo
	version := rel.TagName

	// Find the Docker image asset
	var assetID int64
	var assetSize int64
	for _, a := range rel.Assets {
		if strings.Contains(a.Name, "docker") && strings.HasSuffix(a.Name, ".tar.gz") {
			assetID = a.ID
			assetSize = a.Size
			break
		}
	}
	if assetID == 0 {
		u.logProgress("No Docker image asset found in release", "error")
		return fmt.Errorf("no docker asset in release %s", version)
	}

	// Use GitHub API endpoint for asset download (works with private repos)
	assetURL := fmt.Sprintf("https://api.github.com/repos/%s/%s/releases/assets/%d",
		RepoOwner, RepoName, assetID)

	// Download the image
	destPath := filepath.Join(u.dataDir, fmt.Sprintf("boardripper-docker-%s.tar.gz", version))
	u.logProgress(fmt.Sprintf("Downloading %s (%s)...", version, humanSize(assetSize)), "info")
	if err := downloadAsset(assetURL, destPath); err != nil {
		u.logProgress(fmt.Sprintf("Download failed: %v", err), "error")
		return err
	}
	defer os.Remove(destPath)
	u.logProgress("Download complete", "info")

	// Load image into Docker
	u.logProgress("Loading Docker image...", "info")
	if err := dockerLoad(destPath); err != nil {
		u.logProgress(fmt.Sprintf("Docker load failed: %v", err), "error")
		return err
	}
	u.logProgress("Image loaded", "info")

	// Orchestrate container restart
	u.logProgress("Restarting container with new image...", "info")
	if err := orchestrateRestart(version, u.logProgress); err != nil {
		u.logProgress(fmt.Sprintf("Restart failed: %v", err), "error")
		return err
	}

	u.logProgress(fmt.Sprintf("Update to %s complete — restarting...", version), "done")
	return nil
}

// fetchLatestRelease calls the GitHub API.
// Uses /releases?per_page=1 instead of /releases/latest to include pre-releases.
func fetchLatestRelease() (*ReleaseInfo, error) {
	if GitHubToken == "" {
		return nil, fmt.Errorf("no GitHub token configured — required for private repo")
	}

	url := fmt.Sprintf("https://api.github.com/repos/%s/%s/releases?per_page=1", RepoOwner, RepoName)
	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "BoardRipper/"+Version)
	req.Header.Set("Authorization", "Bearer "+GitHubToken)

	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("GitHub API request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return nil, fmt.Errorf("GitHub API returned %d: %s", resp.StatusCode, string(body))
	}

	var releases []ReleaseInfo
	if err := json.NewDecoder(resp.Body).Decode(&releases); err != nil {
		return nil, fmt.Errorf("failed to parse releases JSON: %w", err)
	}
	if len(releases) == 0 {
		return nil, fmt.Errorf("no releases found")
	}
	return &releases[0], nil
}

// downloadAsset fetches a release asset to disk via the GitHub API.
// Uses Accept: application/octet-stream which works for private repos.
func downloadAsset(url, dest string) error {
	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Set("User-Agent", "BoardRipper/"+Version)
	req.Header.Set("Accept", "application/octet-stream")
	if GitHubToken != "" {
		req.Header.Set("Authorization", "Bearer "+GitHubToken)
	}

	// Follow redirects (GitHub redirects to S3)
	client := &http.Client{Timeout: 10 * time.Minute}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("download returned %d: %s", resp.StatusCode, string(body))
	}

	f, err := os.Create(dest)
	if err != nil {
		return err
	}
	defer f.Close()

	_, err = io.Copy(f, resp.Body)
	return err
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
// "v0.2.5-beta.1" → [0, 2, 5, 1]
// "v0.2.6-beta-4-g9572f7b" (git describe) → [0, 2, 6]
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

	// Remove pre-release labels but keep their numeric suffixes
	// "0.2.5-beta.1" → "0.2.5.1"
	v = strings.NewReplacer(
		"-beta", "",
		"-alpha", "",
		"-rc", "",
	).Replace(v)

	// Strip any remaining dash-suffix (safety net)
	if idx := strings.Index(v, "-"); idx >= 0 {
		v = v[:idx]
	}

	parts := strings.Split(v, ".")
	nums := make([]int, 0, len(parts))
	for _, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil {
			continue
		}
		nums = append(nums, n)
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
