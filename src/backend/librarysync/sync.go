package librarysync

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"boardripper/databank"
)

// Status mirrors the JSON contract of GET /api/sync/status. Field names and
// tags must not change without updating the contract on the frontend side.
type Status struct {
	Running        bool   `json:"running"`
	Phase          string `json:"phase"`
	Description    string `json:"description"`
	StartedAtISO   string `json:"started_at_iso"`
	FilesTotal     int64  `json:"files_total"`
	FilesDone      int64  `json:"files_done"`
	BytesTotal     int64  `json:"bytes_total"`
	BytesDone      int64  `json:"bytes_done"`
	CurrentFile    string `json:"current_file"`
	Errors         int64  `json:"errors"`
	LastRunAtISO   string `json:"last_run_at_iso"`
	LastRunFiles   int64  `json:"last_run_files"`
	LastRunBytes   int64  `json:"last_run_bytes"`
	LastRunExit    int    `json:"last_run_exit"`
	LastRunMessage string `json:"last_run_message"`
	NextRunAtISO   string `json:"next_run_at_iso"`

	// RecentErrors is a ring buffer of the most recent per-file errors
	// (most recent last). Capped at maxRecentErrors. Cleared on Start.
	RecentErrors []ErrorEntry `json:"recent_errors"`
}

// ErrorEntry captures a single per-file failure surfaced to the UI.
type ErrorEntry struct {
	TimeISO string `json:"time_iso"`
	Path    string `json:"path"`
	Message string `json:"message"`
}

const maxRecentErrors = 50

// Engine performs library sync runs in a background goroutine, mirroring the
// scanner.Status pattern for thread-safe progress reporting and cancellation.
type Engine struct {
	db *databank.DB

	mu      sync.Mutex
	status  Status
	cancel  context.CancelFunc
	running bool
}

// New constructs an Engine bound to the databank.DB. The DB is used for the
// sync_* config keys and the password key __sync_secret_pass.
func New(db *databank.DB) *Engine {
	e := &Engine{db: db}
	e.loadLastRun()
	return e
}

// loadLastRun seeds the in-memory status from persisted last_run_* config
// keys so a fresh server reports useful history.
func (e *Engine) loadLastRun() {
	last, _ := e.db.GetConfig("sync_last_run_iso")
	files, _ := e.db.GetConfig("sync_last_run_files")
	bytesC, _ := e.db.GetConfig("sync_last_run_bytes")
	exit, _ := e.db.GetConfig("sync_last_run_exit")
	msg, _ := e.db.GetConfig("sync_last_run_message")

	e.mu.Lock()
	e.status.Phase = "idle"
	e.status.LastRunAtISO = last
	if v, err := strconv.ParseInt(files, 10, 64); err == nil {
		e.status.LastRunFiles = v
	}
	if v, err := strconv.ParseInt(bytesC, 10, 64); err == nil {
		e.status.LastRunBytes = v
	}
	if v, err := strconv.Atoi(exit); err == nil {
		e.status.LastRunExit = v
	}
	e.status.LastRunMessage = msg
	e.status.NextRunAtISO = e.nextRunISO()
	e.mu.Unlock()
}

// nextRunISO computes the next scheduled run timestamp as an RFC3339 string,
// or empty string if scheduling is off.
func (e *Engine) nextRunISO() string {
	enabled, _ := e.db.GetConfig("sync_enabled")
	if enabled != "1" {
		return ""
	}
	sched, _ := e.db.GetConfig("sync_schedule")
	next, ok := nextRunTime(sched, time.Now())
	if !ok {
		return ""
	}
	return next.UTC().Format(time.RFC3339)
}

// Status returns a thread-safe snapshot of the current Status.
func (e *Engine) Status() Status {
	e.mu.Lock()
	st := e.status
	e.mu.Unlock()
	st.NextRunAtISO = e.nextRunISO()
	return st
}

// Running reports whether a sync goroutine is currently active.
func (e *Engine) Running() bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.running
}

// Start kicks off a sync run in a goroutine. Returns an error if a run is
// already in progress (HTTP 409 territory).
func (e *Engine) Start(parent context.Context) (Status, error) {
	e.mu.Lock()
	if e.running {
		st := e.status
		e.mu.Unlock()
		return st, fmt.Errorf("sync already running")
	}

	cfg, err := e.loadConfig()
	if err != nil {
		e.mu.Unlock()
		return Status{}, err
	}
	if cfg.URL == "" {
		e.mu.Unlock()
		return Status{}, fmt.Errorf("sync_url is not configured")
	}
	if cfg.Target == "" {
		e.mu.Unlock()
		return Status{}, fmt.Errorf("sync target is not configured (set sync_target or library_dir)")
	}

	ctx, cancel := context.WithCancel(parent)
	e.cancel = cancel
	e.running = true

	startedAt := time.Now().UTC()
	// Reset progress fields but keep last_run_* for the UI.
	e.status.Running = true
	e.status.Phase = "manifest"
	e.status.Description = "fetching manifest.txt"
	e.status.StartedAtISO = startedAt.Format(time.RFC3339)
	e.status.FilesTotal = 0
	e.status.FilesDone = 0
	e.status.BytesTotal = 0
	e.status.BytesDone = 0
	e.status.CurrentFile = ""
	e.status.Errors = 0
	e.status.RecentErrors = nil
	st := e.status
	e.mu.Unlock()

	go e.run(ctx, cfg)
	return st, nil
}

// Stop cancels a running sync. Returns an error if no run is active.
func (e *Engine) Stop() (Status, error) {
	e.mu.Lock()
	if !e.running || e.cancel == nil {
		st := e.status
		e.mu.Unlock()
		return st, fmt.Errorf("sync is not running")
	}
	e.cancel()
	st := e.status
	e.mu.Unlock()
	return st, nil
}

// runConfig is the resolved set of parameters for a single sync run.
type runConfig struct {
	URL      string
	User     string
	Password string
	Target   string
	Strict   bool
}

func (e *Engine) loadConfig() (runConfig, error) {
	url, _ := e.db.GetConfig("sync_url")
	user, _ := e.db.GetConfig("sync_user")
	pass, _ := e.db.GetConfig("__sync_secret_pass")
	target, _ := e.db.GetConfig("sync_target")
	if target == "" {
		target, _ = e.db.GetConfig("library_dir")
	}
	strict, _ := e.db.GetConfig("sync_strict")
	return runConfig{
		URL:      strings.TrimRight(url, "/"),
		User:     user,
		Password: pass,
		Target:   target,
		Strict:   strict == "1",
	}, nil
}

// run is the body of a sync goroutine. It always finalises the engine state
// and persists last_run_* keys regardless of the exit reason.
func (e *Engine) run(ctx context.Context, cfg runConfig) {
	exitCode := 0
	exitMessage := ""
	startedAt := time.Now()

	defer func() {
		e.mu.Lock()
		filesDone := e.status.FilesDone
		bytesDone := e.status.BytesDone
		// Phase is set explicitly below; only flip to "error" if we somehow
		// fell through without a final phase.
		if e.status.Phase != "done" && e.status.Phase != "cancelled" && e.status.Phase != "error" {
			e.status.Phase = "error"
			if exitMessage == "" {
				exitMessage = "sync ended unexpectedly"
			}
			if exitCode == 0 {
				exitCode = 1
			}
		}
		e.status.Running = false
		e.status.LastRunAtISO = time.Now().UTC().Format(time.RFC3339)
		e.status.LastRunFiles = filesDone
		e.status.LastRunBytes = bytesDone
		e.status.LastRunExit = exitCode
		e.status.LastRunMessage = exitMessage
		e.running = false
		e.cancel = nil
		e.mu.Unlock()

		// Persist last_run_* keys so a restart reports last results.
		_ = e.db.SetConfig("sync_last_run_iso", time.Now().UTC().Format(time.RFC3339))
		_ = e.db.SetConfig("sync_last_run_files", strconv.FormatInt(filesDone, 10))
		_ = e.db.SetConfig("sync_last_run_bytes", strconv.FormatInt(bytesDone, 10))
		_ = e.db.SetConfig("sync_last_run_exit", strconv.Itoa(exitCode))
		_ = e.db.SetConfig("sync_last_run_message", exitMessage)

		fmt.Printf("librarysync: run finished in %s — files=%d bytes=%d exit=%d msg=%q\n",
			time.Since(startedAt).Round(time.Millisecond), filesDone, bytesDone, exitCode, exitMessage)
	}()

	// Phase 1: manifest
	manifest, err := e.fetchManifest(ctx, cfg)
	if err != nil {
		if ctx.Err() != nil {
			e.setPhase("cancelled", "cancelled before manifest fetch", "")
			exitCode = 130
			exitMessage = "cancelled"
			return
		}
		e.setPhase("error", "manifest fetch failed: "+err.Error(), "")
		exitCode = 1
		exitMessage = err.Error()
		return
	}

	// Phase 2: diff
	// Walk the manifest, stat each entry locally, build the download queue.
	// We deliberately do NOT pre-compute bytes_total via HEAD requests — for a
	// 100k-entry manifest that would mean 100k serial HTTPS round-trips before
	// a single file gets downloaded. bytes_done populates progressively from
	// Content-Length as each download completes, which is what users actually
	// watch. (rclone behaves the same way.)
	e.setPhase("diff", "diffing manifest against local target", "")

	type queueEntry struct {
		path string
	}
	var queue []queueEntry
	manifestSet := make(map[string]bool, len(manifest))
	totalEntries := len(manifest)
	const diffProgressEvery = 1000
	for i, entry := range manifest {
		if i%diffProgressEvery == 0 {
			if ctx.Err() != nil {
				e.setPhase("cancelled", "cancelled during diff", "")
				exitCode = 130
				exitMessage = "cancelled"
				return
			}
			e.mu.Lock()
			e.status.Description = fmt.Sprintf("diffing %d / %d (%d queued so far)", i, totalEntries, len(queue))
			e.mu.Unlock()
		}
		manifestSet[entry] = true
		local := filepath.Join(cfg.Target, filepath.FromSlash(entry))
		info, err := os.Stat(local)
		if err == nil && !info.IsDir() && info.Size() > 0 {
			// Already present locally — skip.
			continue
		}
		queue = append(queue, queueEntry{path: entry})
	}

	e.mu.Lock()
	e.status.FilesTotal = int64(len(queue))
	e.status.BytesTotal = 0 // populated progressively by Content-Length on download
	e.status.Description = fmt.Sprintf("queued %d / %d files for download", len(queue), totalEntries)
	e.mu.Unlock()

	if ctx.Err() != nil {
		e.setPhase("cancelled", "cancelled during diff", "")
		exitCode = 130
		exitMessage = "cancelled"
		return
	}

	// Phase 3: download
	e.setPhase("download", fmt.Sprintf("downloading %d files", len(queue)), "")

	for _, item := range queue {
		if ctx.Err() != nil {
			e.setPhase("cancelled", "cancelled during download", "")
			exitCode = 130
			exitMessage = "cancelled"
			return
		}

		e.mu.Lock()
		e.status.CurrentFile = item.path
		e.status.Description = "downloading " + item.path
		e.mu.Unlock()

		written, err := e.downloadFile(ctx, cfg, item.path)
		if err != nil {
			fmt.Printf("librarysync: download failed for %s: %v\n", item.path, err)
			e.recordError(item.path, err)
			continue
		}
		e.mu.Lock()
		e.status.FilesDone++
		e.status.BytesDone += written
		e.mu.Unlock()
	}

	if ctx.Err() != nil {
		e.setPhase("cancelled", "cancelled during download", "")
		exitCode = 130
		exitMessage = "cancelled"
		return
	}

	// Phase 4 (optional): strict prune
	if cfg.Strict {
		e.setPhase("download", "pruning files not in manifest", "")
		if err := e.prune(ctx, cfg.Target, manifestSet); err != nil {
			fmt.Printf("librarysync: prune error: %v\n", err)
		}
	}

	// Phase 5: done
	e.setPhase("done", "sync complete", "")
	exitCode = 0
	exitMessage = ""
}

func (e *Engine) setPhase(phase, description, currentFile string) {
	e.mu.Lock()
	e.status.Phase = phase
	e.status.Description = description
	if currentFile != "" {
		e.status.CurrentFile = currentFile
	}
	e.mu.Unlock()
}

// recordError appends a per-file failure to the ring buffer (capped) and
// increments the error count. Both updates happen under the lock so the
// frontend never sees an inconsistent count vs. list.
func (e *Engine) recordError(path string, err error) {
	entry := ErrorEntry{
		TimeISO: time.Now().UTC().Format(time.RFC3339),
		Path:    path,
		Message: err.Error(),
	}
	e.mu.Lock()
	e.status.Errors++
	e.status.RecentErrors = append(e.status.RecentErrors, entry)
	if len(e.status.RecentErrors) > maxRecentErrors {
		// Drop oldest, keep most recent.
		e.status.RecentErrors = e.status.RecentErrors[len(e.status.RecentErrors)-maxRecentErrors:]
	}
	e.mu.Unlock()
}

// fetchManifest downloads <url>/manifest.txt and parses it into a slice of
// path entries. Comment lines (#…) and blanks are skipped. Per the contract,
// each line is a single path; if a line includes whitespace-separated extras
// the first whitespace-delimited token is treated as the path.
func (e *Engine) fetchManifest(ctx context.Context, cfg runConfig) ([]string, error) {
	resp, err := fetch(ctx, http.MethodGet, cfg.URL+"/manifest.txt", cfg.User, cfg.Password)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("manifest %s", resp.Status)
	}

	var entries []string
	scanner := bufio.NewScanner(resp.Body)
	// PCB schematic paths can be long — bump the line buffer to 1 MiB.
	buf := make([]byte, 0, 64*1024)
	scanner.Buffer(buf, 1<<20)
	for scanner.Scan() {
		line := strings.TrimRight(scanner.Text(), "\r\n")
		// Trim leading whitespace only; trailing whitespace would be inside
		// (or at the end of) a filename, which is legal on most filesystems
		// and definitely the case for copyparty.
		line = strings.TrimLeft(line, " \t")
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		// If the operator ever adds a tab-separated size column ("path\tsize"),
		// drop the trailing column. We explicitly use TAB (not any whitespace)
		// so paths containing spaces — which copyparty's manifest emits as
		// "Computers/1 Laptop/foo.pdf" — are preserved verbatim.
		if idx := strings.LastIndexByte(line, '\t'); idx > 0 {
			line = strings.TrimRight(line[:idx], " \t")
		}
		// Reject path traversal.
		clean := filepath.ToSlash(filepath.Clean(line))
		if strings.HasPrefix(clean, "../") || strings.HasPrefix(clean, "/") || clean == ".." {
			continue
		}
		entries = append(entries, clean)
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	return entries, nil
}


// downloadFile fetches <cfg.URL>/<entry> and writes it atomically to
// <cfg.Target>/<entry>. Returns the number of bytes written on success.
func (e *Engine) downloadFile(ctx context.Context, cfg runConfig, entry string) (int64, error) {
	dest := filepath.Join(cfg.Target, filepath.FromSlash(entry))
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return 0, fmt.Errorf("mkdir parent: %w", err)
	}

	resp, err := fetch(ctx, http.MethodGet, joinURL(cfg.URL, entry), cfg.User, cfg.Password)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 0, fmt.Errorf("HTTP %s", resp.Status)
	}

	tmp := dest + ".part"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return 0, fmt.Errorf("open part: %w", err)
	}

	written, copyErr := io.Copy(f, resp.Body)
	syncErr := f.Sync()
	closeErr := f.Close()
	if copyErr != nil {
		_ = os.Remove(tmp)
		return 0, copyErr
	}
	if syncErr != nil {
		_ = os.Remove(tmp)
		return 0, syncErr
	}
	if closeErr != nil {
		_ = os.Remove(tmp)
		return 0, closeErr
	}
	if err := os.Rename(tmp, dest); err != nil {
		_ = os.Remove(tmp)
		return 0, fmt.Errorf("rename: %w", err)
	}
	return written, nil
}

// pruneSafeNames lists filenames that must never be deleted by strict mode,
// even when absent from the manifest. Mirrors Syncthing/.git defaults.
var pruneSafeNames = map[string]bool{
	".stfolder":    true,
	".stignore":    true,
	"manifest.txt": true,
}

// prune walks target and removes any non-dotfile not present in manifest.
// Defensive: skips dotfiles, dotdirs, and entries in pruneSafeNames.
func (e *Engine) prune(ctx context.Context, target string, manifest map[string]bool) error {
	return filepath.Walk(target, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil
		}
		if ctx.Err() != nil {
			return filepath.SkipAll
		}
		if path == target {
			return nil
		}
		name := filepath.Base(path)
		if strings.HasPrefix(name, ".") {
			if info.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if info.IsDir() {
			return nil
		}
		if pruneSafeNames[name] {
			return nil
		}
		rel, err := filepath.Rel(target, path)
		if err != nil {
			return nil
		}
		rel = filepath.ToSlash(rel)
		if manifest[rel] {
			return nil
		}
		if err := os.Remove(path); err != nil {
			fmt.Printf("librarysync: prune remove %s: %v\n", rel, err)
		} else {
			fmt.Printf("librarysync: pruned %s\n", rel)
		}
		return nil
	})
}
