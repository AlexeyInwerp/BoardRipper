package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"boardripper/databank"
)

// ScanRootFunc returns the current scan root directory.
type ScanRootFunc func() string

type FileHandler struct {
	dataDir     string
	scanRootFn  ScanRootFunc // returns the active scan root (may differ from dataDir if library_dir is set)
}

type FileInfo struct {
	Name     string    `json:"name"`
	Size     int64     `json:"size"`
	Modified time.Time `json:"modified"`
}

func NewFileHandler(dataDir string, scanRootFn ScanRootFunc) *FileHandler {
	return &FileHandler{dataDir: dataDir, scanRootFn: scanRootFn}
}

func (h *FileHandler) Upload(w http.ResponseWriter, r *http.Request) {
	// Limit upload size to 50MB
	r.Body = http.MaxBytesReader(w, r.Body, 50<<20)

	file, header, err := r.FormFile("file")
	if err != nil {
		http.Error(w, "Failed to read file: "+err.Error(), http.StatusBadRequest)
		return
	}
	defer file.Close()

	// Validate file extension
	if !databank.IsBoardFile(header.Filename) {
		http.Error(w, "Supported formats: "+databank.BoardExtensionList(), http.StatusBadRequest)
		return
	}

	// Sanitize filename
	safeName := filepath.Base(header.Filename)
	destPath := filepath.Join(h.dataDir, safeName)

	dst, err := os.Create(destPath)
	if err != nil {
		http.Error(w, "Failed to save file: "+err.Error(), http.StatusInternalServerError)
		return
	}
	defer dst.Close()

	if _, err := io.Copy(dst, file); err != nil {
		dst.Close()
		os.Remove(destPath)
		http.Error(w, "Failed to write file: "+err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"name":   safeName,
		"status": "ok",
	})
}

func (h *FileHandler) List(w http.ResponseWriter, r *http.Request) {
	entries, err := os.ReadDir(h.dataDir)
	if err != nil {
		http.Error(w, "Failed to list files: "+err.Error(), http.StatusInternalServerError)
		return
	}

	files := make([]FileInfo, 0)
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		if !databank.IsSupportedFile(entry.Name()) {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		files = append(files, FileInfo{
			Name:     entry.Name(),
			Size:     info.Size(),
			Modified: info.ModTime(),
		})
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(files)
}

func (h *FileHandler) Get(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if name == "" {
		http.Error(w, "Missing file name", http.StatusBadRequest)
		return
	}

	// Prevent directory traversal
	safeName := filepath.Base(name)
	filePath := filepath.Join(h.dataDir, safeName)

	if _, err := os.Stat(filePath); os.IsNotExist(err) {
		http.Error(w, "File not found", http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Disposition", fmt.Sprintf("inline; filename=%q", safeName))
	serveFileEager(w, r, filePath, "text/plain; charset=utf-8")
}

// GetByPath serves files from subdirectories within dataDir.
// The path is taken from the full URL after /api/files/path/.
func (h *FileHandler) GetByPath(w http.ResponseWriter, r *http.Request) {
	// Extract the path portion after /api/files/path/
	relPath := r.PathValue("path")
	if relPath == "" {
		http.Error(w, "Missing file path", http.StatusBadRequest)
		return
	}

	// Prevent directory traversal: clean the path and reject anything with ..
	relPath = filepath.Clean(relPath)
	if strings.Contains(relPath, "..") {
		http.Error(w, "Invalid path", http.StatusBadRequest)
		return
	}

	// Check scan root first (may be library_dir), then fall back to dataDir
	filePath := filepath.Join(h.scanRootFn(), relPath)
	info, err := os.Stat(filePath)
	if os.IsNotExist(err) {
		// Try dataDir as fallback
		filePath = filepath.Join(h.dataDir, relPath)
		info, err = os.Stat(filePath)
	}
	if os.IsNotExist(err) || (info != nil && info.IsDir()) {
		http.Error(w, "File not found", http.StatusNotFound)
		return
	}

	safeName := filepath.Base(relPath)
	ext := strings.ToLower(filepath.Ext(safeName))

	// Determine content type
	contentType := "application/octet-stream"
	if ext == ".pdf" {
		contentType = "application/pdf"
	} else if databank.IsBoardFile(safeName) {
		contentType = "text/plain; charset=utf-8"
	}

	w.Header().Set("Content-Disposition", fmt.Sprintf("inline; filename=%q", safeName))
	serveFileEager(w, r, filePath, contentType)
}

// probeReadBytes is how many bytes the diagnostic Probe handler reads
// before declaring success. Small enough that even a slow cloud-sync
// driver shouldn't take more than a few seconds.
const probeReadBytes = 64 * 1024

// probeReadDeadline is the per-request budget for Probe. Shorter than
// the main serve deadline so the diagnostic endpoint can't itself hang.
const probeReadDeadline = 5 * time.Second

// ProbeResult is the shape returned by GET /api/files/probe. All fields
// are diagnostic — operators paste this output when reporting cloud-sync
// failures so we know whether they're hitting a placeholder, a slow
// network, or a real read error.
type ProbeResult struct {
	Path         string `json:"path"`
	ResolvedPath string `json:"resolved_path"`
	Size         int64  `json:"size"`
	Blocks       int64  `json:"blocks"`
	BlocksKnown  bool   `json:"blocks_known"`
	ModTime      string `json:"mod_time"`
	// PlaceholderSignal is true when size>0 && blocks==0 — the
	// cross-platform cloud-placeholder signature. Diagnostic only; the
	// serve path does NOT gate on this (see serve_blocks_unix.go).
	PlaceholderSignal bool `json:"placeholder_signal"`
	Probe             struct {
		Ok        bool   `json:"ok"`
		BytesRead int    `json:"bytes_read"`
		Errno     string `json:"errno,omitempty"`
		Error     string `json:"error,omitempty"`
		ElapsedMs int64  `json:"elapsed_ms"`
		// TimedOut is true if the probe hit probeReadDeadline before
		// reaching probeReadBytes. Distinct from Error so callers can
		// tell "kernel hung" from "kernel returned an error".
		TimedOut bool `json:"timed_out"`
	} `json:"probe"`
}

// Probe is a diagnostic endpoint that stat()s the requested path and
// attempts a small read with a short deadline. Used to triage cloud-sync
// failures — a placeholder typically reports size>0/blocks=0 and the
// probe read either deadlocks (Docker-on-Mac with macOS File Provider)
// or returns errno=ENXIO/EIO. Path-resolution and traversal-protection
// mirror GetByPath.
func (h *FileHandler) Probe(w http.ResponseWriter, r *http.Request) {
	relPath := r.URL.Query().Get("path")
	if relPath == "" {
		http.Error(w, "Missing path query param", http.StatusBadRequest)
		return
	}
	relPath = filepath.Clean(relPath)
	if strings.Contains(relPath, "..") {
		http.Error(w, "Invalid path", http.StatusBadRequest)
		return
	}

	resolved := filepath.Join(h.scanRootFn(), relPath)
	info, err := os.Stat(resolved)
	if os.IsNotExist(err) {
		resolved = filepath.Join(h.dataDir, relPath)
		info, err = os.Stat(resolved)
	}
	if os.IsNotExist(err) {
		http.Error(w, "File not found", http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, "Stat error: "+err.Error(), http.StatusInternalServerError)
		return
	}

	res := ProbeResult{
		Path:         relPath,
		ResolvedPath: resolved,
		Size:         info.Size(),
		ModTime:      info.ModTime().UTC().Format(time.RFC3339),
	}
	if b, ok := statBlocks(info); ok {
		res.Blocks = b
		res.BlocksKnown = true
		res.PlaceholderSignal = res.Size > 0 && b == 0
	}

	if !info.IsDir() {
		probeStart := time.Now()
		ctx, cancel := context.WithTimeout(r.Context(), probeReadDeadline)
		defer cancel()
		type probeResult struct {
			n   int
			err error
		}
		ch := make(chan probeResult, 1)
		go func() {
			f, openErr := os.Open(resolved)
			if openErr != nil {
				ch <- probeResult{0, openErr}
				return
			}
			defer f.Close()
			buf := make([]byte, probeReadBytes)
			n, readErr := io.ReadFull(f, buf)
			// io.ReadFull returns io.ErrUnexpectedEOF on short EOF and
			// io.EOF on zero-byte read. Either is a successful probe of a
			// real (small) file — promote both to nil so we don't surface
			// them as errors.
			if readErr == io.EOF || readErr == io.ErrUnexpectedEOF {
				readErr = nil
			}
			ch <- probeResult{n, readErr}
		}()

		select {
		case <-ctx.Done():
			res.Probe.TimedOut = true
			res.Probe.ElapsedMs = time.Since(probeStart).Milliseconds()
			res.Probe.Error = "probe deadline exceeded — kernel-side read is hung (placeholder unreachable through this mount?)"
		case pr := <-ch:
			res.Probe.BytesRead = pr.n
			res.Probe.ElapsedMs = time.Since(probeStart).Milliseconds()
			if pr.err == nil {
				res.Probe.Ok = true
			} else {
				res.Probe.Errno = errnoName(pr.err)
				res.Probe.Error = pr.err.Error()
			}
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(res)
}

func (h *FileHandler) Delete(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if name == "" {
		http.Error(w, "Missing file name", http.StatusBadRequest)
		return
	}

	safeName := filepath.Base(name)
	filePath := filepath.Join(h.dataDir, safeName)

	if err := os.Remove(filePath); err != nil {
		if os.IsNotExist(err) {
			http.Error(w, "File not found", http.StatusNotFound)
		} else {
			http.Error(w, "Failed to delete: "+err.Error(), http.StatusInternalServerError)
		}
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "deleted"})
}
