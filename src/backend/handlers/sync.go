package handlers

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"boardripper/databank"
	"boardripper/librarysync"
)

// SyncHandler serves all /api/sync/* endpoints.
type SyncHandler struct {
	db     *databank.DB
	engine *librarysync.Engine
}

// NewSyncHandler constructs a handler bound to the given DB and engine.
func NewSyncHandler(db *databank.DB, engine *librarysync.Engine) *SyncHandler {
	return &SyncHandler{db: db, engine: engine}
}

// defaultTarget returns sync_target if set, otherwise library_dir.
func defaultTarget(db *databank.DB) string {
	v, _ := db.GetConfig("sync_target")
	if v != "" {
		return v
	}
	v, _ = db.GetConfig("library_dir")
	return v
}

// configResponse is the shape returned by GET /api/sync/config and the 200
// payload of PUT /api/sync/config. Note: password is never serialized; only
// `has_password` exposes presence.
type configResponse struct {
	Enabled     bool   `json:"enabled"`
	URL         string `json:"url"`
	User        string `json:"user"`
	HasPassword bool   `json:"has_password"`
	Target      string `json:"target"`
	Schedule    string `json:"schedule"`
	Strict      bool   `json:"strict"`
}

func (h *SyncHandler) buildConfigResponse() configResponse {
	enabled, _ := h.db.GetConfig("sync_enabled")
	url, _ := h.db.GetConfig("sync_url")
	user, _ := h.db.GetConfig("sync_user")
	pass, _ := h.db.GetConfig("__sync_secret_pass")
	sched, _ := h.db.GetConfig("sync_schedule")
	strict, _ := h.db.GetConfig("sync_strict")
	if sched == "" {
		sched = "off"
	}
	return configResponse{
		Enabled:     enabled == "1",
		URL:         url,
		User:        user,
		HasPassword: pass != "",
		Target:      defaultTarget(h.db),
		Schedule:    sched,
		Strict:      strict == "1",
	}
}

// validSchedules guards against arbitrary values reaching the scheduler.
var validSchedules = map[string]bool{
	"off": true, "daily": true, "weekly": true, "monthly": true,
}

// Config dispatches GET / PUT for /api/sync/config.
func (h *SyncHandler) Config(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		h.getConfig(w, r)
	case http.MethodPut:
		h.putConfig(w, r)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (h *SyncHandler) getConfig(w http.ResponseWriter, _ *http.Request) {
	resp := h.buildConfigResponse()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

func (h *SyncHandler) putConfig(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Enabled       *bool   `json:"enabled,omitempty"`
		URL           *string `json:"url,omitempty"`
		User          *string `json:"user,omitempty"`
		Password      *string `json:"password,omitempty"`
		ClearPassword bool    `json:"clear_password,omitempty"`
		Target        *string `json:"target,omitempty"`
		Schedule      *string `json:"schedule,omitempty"`
		Strict        *bool   `json:"strict,omitempty"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 256<<10)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON: "+err.Error(), http.StatusBadRequest)
		return
	}

	if req.Schedule != nil && !validSchedules[*req.Schedule] {
		http.Error(w, "invalid schedule (allowed: off|daily|weekly|monthly)", http.StatusBadRequest)
		return
	}

	if req.Enabled != nil {
		v := "0"
		if *req.Enabled {
			v = "1"
		}
		if err := h.db.SetConfig("sync_enabled", v); err != nil {
			http.Error(w, "Failed to set sync_enabled: "+err.Error(), http.StatusInternalServerError)
			return
		}
	}
	// "Password is being supplied" means EITHER an explicit clear OR a
	// non-empty value. `req.Password != nil` alone isn't enough — a JSON
	// body of `{"url":"...","password":""}` deserializes to a non-nil
	// pointer at an empty string, but doesn't actually supply credentials,
	// so the URL change must still drop the saved password to avoid
	// re-using it against the new host.
	passwordSupplied := req.ClearPassword || (req.Password != nil && *req.Password != "")
	if req.URL != nil {
		newURL := strings.TrimSpace(*req.URL)
		oldURL, _ := h.db.GetConfig("sync_url")
		// If the URL changes and no new password is supplied in the same
		// PUT, drop the saved password BEFORE writing the new URL so a
		// concurrent /api/sync/test (or /api/sync/start) can't grab the
		// new URL + old password mid-update. Audit's "swap sync_url +
		// reuse saved password to exfil to attacker.com" path.
		if oldURL != "" && newURL != oldURL && !passwordSupplied {
			_ = h.db.SetConfig("__sync_secret_pass", "")
		}
		if err := h.db.SetConfig("sync_url", newURL); err != nil {
			http.Error(w, "Failed to set sync_url: "+err.Error(), http.StatusInternalServerError)
			return
		}
	}
	if req.User != nil {
		if err := h.db.SetConfig("sync_user", *req.User); err != nil {
			http.Error(w, "Failed to set sync_user: "+err.Error(), http.StatusInternalServerError)
			return
		}
	}
	// Password handling: empty == no change. clear_password=true == delete.
	if req.ClearPassword {
		if err := h.db.SetConfig("__sync_secret_pass", ""); err != nil {
			http.Error(w, "Failed to clear password: "+err.Error(), http.StatusInternalServerError)
			return
		}
	} else if req.Password != nil && *req.Password != "" {
		if err := h.db.SetConfig("__sync_secret_pass", *req.Password); err != nil {
			http.Error(w, "Failed to set password: "+err.Error(), http.StatusInternalServerError)
			return
		}
	}
	if req.Target != nil {
		if err := h.db.SetConfig("sync_target", *req.Target); err != nil {
			http.Error(w, "Failed to set sync_target: "+err.Error(), http.StatusInternalServerError)
			return
		}
	}
	if req.Schedule != nil {
		if err := h.db.SetConfig("sync_schedule", *req.Schedule); err != nil {
			http.Error(w, "Failed to set sync_schedule: "+err.Error(), http.StatusInternalServerError)
			return
		}
	}
	if req.Strict != nil {
		v := "0"
		if *req.Strict {
			v = "1"
		}
		if err := h.db.SetConfig("sync_strict", v); err != nil {
			http.Error(w, "Failed to set sync_strict: "+err.Error(), http.StatusInternalServerError)
			return
		}
	}

	resp := h.buildConfigResponse()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

// Test handles POST /api/sync/test — performs an authenticated GET of
// manifest.txt and returns ok/manifest_bytes/message in the JSON payload.
// Always 200 — failure is in the body.
func (h *SyncHandler) Test(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	type testResp struct {
		OK            bool   `json:"ok"`
		ManifestBytes int64  `json:"manifest_bytes"`
		Message       string `json:"message"`
	}
	respond := func(r testResp) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(r)
	}

	url, _ := h.db.GetConfig("sync_url")
	user, _ := h.db.GetConfig("sync_user")
	pass, _ := h.db.GetConfig("__sync_secret_pass")
	if url == "" {
		respond(testResp{OK: false, Message: "sync_url is not configured"})
		return
	}
	url = strings.TrimRight(url, "/")

	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	resp, err := librarysync.FetchManifestForTest(ctx, url, user, pass)
	if err != nil {
		respond(testResp{OK: false, Message: err.Error()})
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		respond(testResp{OK: false, Message: resp.Status})
		return
	}

	// Read up to 1 KiB so we don't pull the whole manifest just for a probe.
	limited := io.LimitReader(resp.Body, 1024)
	buf, _ := io.ReadAll(limited)
	respond(testResp{OK: true, ManifestBytes: int64(len(buf)), Message: ""})
}

// Start handles POST /api/sync/start.
func (h *SyncHandler) Start(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	st, err := h.engine.Start(context.Background())
	if err != nil {
		// Distinguish "already running" (409) from configuration errors (400).
		if strings.Contains(err.Error(), "already running") {
			http.Error(w, err.Error(), http.StatusConflict)
			return
		}
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(st)
}

// Stop handles POST /api/sync/stop.
func (h *SyncHandler) Stop(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	st, err := h.engine.Stop()
	if err != nil {
		http.Error(w, err.Error(), http.StatusConflict)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(st)
}

// Status handles GET /api/sync/status.
func (h *SyncHandler) Status(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(h.engine.Status())
}

// CheckTarget handles GET /api/sync/check-target?path=<path>. Always 200 —
// errors map to {exists:false, writable:false, free_bytes:0}.
func (h *SyncHandler) CheckTarget(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	type result struct {
		Exists    bool   `json:"exists"`
		IsDir     bool   `json:"is_dir"`
		Writable  bool   `json:"writable"`
		FreeBytes uint64 `json:"free_bytes"`
	}
	respond := func(r result) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(r)
	}

	path := r.URL.Query().Get("path")
	if path == "" {
		respond(result{})
		return
	}

	info, err := os.Stat(path)
	if err == nil {
		// Path exists.
		if !info.IsDir() {
			respond(result{Exists: true, IsDir: false, Writable: false, FreeBytes: freeBytes(filepath.Dir(path))})
			return
		}
		respond(result{
			Exists:    true,
			IsDir:     true,
			Writable:  isWritableDir(path),
			FreeBytes: freeBytes(path),
		})
		return
	}

	// Path doesn't exist — walk up to the nearest existing parent and report
	// writability of that. This lets the user pick a non-existent leaf
	// inside a writable directory.
	parent := filepath.Dir(path)
	for parent != "" && parent != "." {
		if pi, perr := os.Stat(parent); perr == nil && pi.IsDir() {
			respond(result{
				Exists:    false,
				IsDir:     false,
				Writable:  isWritableDir(parent),
				FreeBytes: freeBytes(parent),
			})
			return
		}
		next := filepath.Dir(parent)
		if next == parent {
			break
		}
		parent = next
	}
	respond(result{})
}

// isWritableDir probes by creating and removing a small marker file. Returns
// false if the path is not a directory or any filesystem call fails.
func isWritableDir(dir string) bool {
	probe := filepath.Join(dir, ".brsync-rwprobe")
	f, err := os.OpenFile(probe, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return false
	}
	_ = f.Close()
	_ = os.Remove(probe)
	return true
}

// freeBytes returns the available bytes on the filesystem hosting `path`.
// Uses syscall.Statfs which is available on Linux + Darwin (the project's
// supported runtimes). Returns 0 on any error.
func freeBytes(path string) uint64 {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return 0
	}
	// Bavail = blocks available to non-superuser; on Linux+Darwin Bsize is
	// uint32/int64 respectively, so explicitly widen to uint64 first.
	return uint64(st.Bavail) * uint64(st.Bsize)
}
