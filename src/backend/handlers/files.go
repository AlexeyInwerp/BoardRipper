package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"boardripper/databank"
)

// ScanRootFunc returns the current scan root directory.
type ScanRootFunc func() string

// IndexFileFunc indexes a single file (given as a scan-root-relative,
// forward-slash path) into the databank so it appears in the library
// without a full rescan, and returns the resulting file record (so the
// upload response can hand the caller a real databank id). May be nil
// (indexing is then skipped).
type IndexFileFunc func(relPath string) (*databank.FileRecord, error)

// ExtractMetadataFunc runs the resolver / pattern-matcher used by the
// scanner so the upload handler can pre-route the file into a brand /
// model subfolder under incoming/. Same forward-slash relPath shape as
// IndexFileFunc. May be nil (then everything lands in incoming/ flat).
type ExtractMetadataFunc func(relPath string) databank.Metadata

// incomingSubdir is the parent folder under the scan root where dropped
// files are saved. New drops are organised into brand/model subfolders
// underneath (e.g. incoming/Apple/MacBook Pro 16"/820-XXXXX.brd); files
// whose brand the resolver can't identify land in incoming/uncategorized/.
// Files dropped before this routing was added remain wherever they were —
// the scanner reconciles them on the next pass.
const incomingSubdir = "incoming"

// uncategorizedSubdir is the bucket for dropped files the resolver couldn't
// assign a brand to. Matches the user-facing word the LibraryPanel uses for
// the same fallback (LibraryPanel's "Unknown" / "[ODM] X" buckets).
const uncategorizedSubdir = "uncategorized"

// maxUploadBytes caps a single drop-to-incoming upload. Matches the eager
// serve cap (serve.go) so anything we accept we can also serve back.
const maxUploadBytes = 512 << 20 // 512 MiB

type FileHandler struct {
	dataDir    string
	scanRootFn ScanRootFunc        // returns the active scan root (may differ from dataDir if library_dir is set)
	extractFn  ExtractMetadataFunc // resolves brand/model so we can pick a subfolder (may be nil → flat incoming/)
	indexFn    IndexFileFunc       // indexes an uploaded file into the databank (may be nil)
}

type FileInfo struct {
	Name     string    `json:"name"`
	Size     int64     `json:"size"`
	Modified time.Time `json:"modified"`
}

func NewFileHandler(dataDir string, scanRootFn ScanRootFunc, extractFn ExtractMetadataFunc, indexFn IndexFileFunc) *FileHandler {
	return &FileHandler{dataDir: dataDir, scanRootFn: scanRootFn, extractFn: extractFn, indexFn: indexFn}
}

// sanitizePathPart strips characters that would break the on-disk layout
// out of a single path component. Path separators and ':' (Windows /
// macOS-reserved) collapse to '_', control bytes are dropped, and a
// resulting empty / "." / ".." string becomes "_" so we always produce
// a real directory name.
func sanitizePathPart(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch {
		case r == '/' || r == '\\' || r == ':':
			b.WriteRune('_')
		case r < 0x20 || r == 0x7F:
			// drop control bytes
		default:
			b.WriteRune(r)
		}
	}
	out := strings.TrimSpace(b.String())
	out = strings.Trim(out, ".")
	if out == "" || out == "." || out == ".." {
		return "_"
	}
	return out
}

// decideIncomingSubdir picks the subfolder under incoming/ for a freshly-
// dropped file based on what the resolver could tell us. Brand resolved →
// incoming/{brand}/{model}/ (model only when present); brand empty →
// incoming/uncategorized/. Returned path uses forward slashes so it can be
// concatenated to either the disk path (after FromSlash) or the URL/db
// path verbatim.
func decideIncomingSubdir(meta databank.Metadata) string {
	if meta.Manufacturer == "" {
		return uncategorizedSubdir
	}
	brand := sanitizePathPart(meta.Manufacturer)
	model := strings.TrimSpace(meta.Model)
	if model == "" || strings.EqualFold(model, "Unknown model") {
		return brand
	}
	return brand + "/" + sanitizePathPart(model)
}

// resolveWithinRoot rejects paths whose symlink-resolved target escapes
// `root`. `..` traversal is also blocked. os.Stat / os.Open follow
// symlinks transparently, so a symlink inside the library mount that
// points at /etc/passwd would otherwise be served verbatim. Returns the
// fully-resolved absolute path on success.
func resolveWithinRoot(root, relPath string) (string, error) {
	abs := filepath.Join(root, relPath)
	resolved, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return "", err
	}
	rootResolved, err := filepath.EvalSymlinks(root)
	if err != nil {
		return "", err
	}
	rel, err := filepath.Rel(rootResolved, resolved)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("path escapes root")
	}
	return resolved, nil
}

// Upload saves a dropped board or PDF into <scanRoot>/incoming/ and indexes
// it into the library. The scan root (library_dir if configured, else
// dataDir) is used — not dataDir directly — so the saved file is reachable
// by the same scanner that populates the Library panel. Written atomically
// (temp + rename) so the indexer / a concurrent scan never sees a partial
// file. Best-effort indexing: a write that succeeds but fails to index
// still returns 200, since the next full scan reconciles it.
func (h *FileHandler) Upload(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxUploadBytes)

	file, header, err := r.FormFile("file")
	if err != nil {
		http.Error(w, "Failed to read file: "+err.Error(), http.StatusBadRequest)
		return
	}
	// r.MultipartForm is non-nil once FormFile succeeds. RemoveAll unlinks
	// the on-disk temp files the multipart reader spilled for uploads over
	// the 32 MiB in-memory threshold (mirrors update.go ApplyBundle).
	// Registered before file.Close() so Close runs first (defers are LIFO).
	defer r.MultipartForm.RemoveAll()
	defer file.Close()

	// Accept any supported board or PDF format.
	if !databank.IsSupportedFile(header.Filename) {
		http.Error(w, "Unsupported file type (boards: "+databank.BoardExtensionList()+", or .pdf)", http.StatusBadRequest)
		return
	}

	safeName := filepath.Base(header.Filename)

	// Pre-extract metadata using just the bare incoming/<filename> path so we
	// can route the file into a brand/model subfolder before writing it. This
	// gives the same answer the scanner's resolver would on the next pass —
	// see scanner.ExtractMetadata. When the resolver doesn't know the brand,
	// fall back to incoming/uncategorized/. When extractFn itself is nil
	// (legacy / test wiring) skip subfolder routing entirely and keep the
	// historical flat incoming/ layout.
	subDir := ""
	if h.extractFn != nil {
		preExtractRel := filepath.ToSlash(filepath.Join(incomingSubdir, safeName))
		subDir = decideIncomingSubdir(h.extractFn(preExtractRel))
	}

	incomingDir := filepath.Join(h.scanRootFn(), incomingSubdir, filepath.FromSlash(subDir))
	if err := os.MkdirAll(incomingDir, 0o755); err != nil {
		http.Error(w, "Failed to create incoming folder (library mount read-only?): "+err.Error(), http.StatusInternalServerError)
		return
	}

	destPath := filepath.Join(incomingDir, safeName)
	tmpPath := destPath + ".part"
	dst, err := os.OpenFile(tmpPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		http.Error(w, "Failed to save file: "+err.Error(), http.StatusInternalServerError)
		return
	}
	if _, err := io.Copy(dst, file); err != nil {
		dst.Close()
		os.Remove(tmpPath)
		http.Error(w, "Failed to write file: "+err.Error(), http.StatusInternalServerError)
		return
	}
	if err := dst.Sync(); err != nil {
		dst.Close()
		os.Remove(tmpPath)
		http.Error(w, "Failed to flush file: "+err.Error(), http.StatusInternalServerError)
		return
	}
	dst.Close()
	if err := os.Rename(tmpPath, destPath); err != nil {
		os.Remove(tmpPath)
		http.Error(w, "Failed to finalize file: "+err.Error(), http.StatusInternalServerError)
		return
	}

	relPath := filepath.ToSlash(filepath.Join(incomingSubdir, subDir, safeName))
	resp := map[string]any{
		"name":   safeName,
		"path":   relPath,
		"status": "ok",
	}
	if h.indexFn != nil {
		// Return the ingested databank record so the client can tag the open
		// board/PDF with a real file id immediately (no name+size fallback).
		rec, err := h.indexFn(relPath)
		if err != nil {
			// File is saved; indexing failure is non-fatal (next scan picks it up).
			log.Printf("Upload: saved %s but indexing failed: %v", relPath, err)
		} else if rec != nil {
			resp["id"] = rec.ID
			resp["file_type"] = rec.FileType
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
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
	// Confine this endpoint to user board/PDF files: reject dotfiles
	// (.update-secret, .mcp-secret, .update-counter) and anything that isn't
	// a supported board/PDF (e.g. *.db). Mirrors the allowlist List()/Upload()
	// already apply, keeping the data-dir's private state files unreachable.
	if strings.HasPrefix(safeName, ".") || !databank.IsSupportedFile(safeName) {
		http.Error(w, "File not found", http.StatusNotFound)
		return
	}
	filePath := filepath.Join(h.dataDir, safeName)

	if _, err := os.Stat(filePath); os.IsNotExist(err) {
		http.Error(w, "File not found", http.StatusNotFound)
		return
	}

	disposition := "inline"
	if r.URL.Query().Get("download") == "1" {
		disposition = "attachment"
	}
	w.Header().Set("Content-Disposition", fmt.Sprintf("%s; filename=%q", disposition, safeName))
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

	// Check scan root first (may be library_dir), then fall back to dataDir.
	// resolveWithinRoot also blocks symlink-out-of-root escapes — necessary
	// because os.Stat / os.Open follow symlinks transparently.
	filePath, err := resolveWithinRoot(h.scanRootFn(), relPath)
	if err != nil {
		filePath, err = resolveWithinRoot(h.dataDir, relPath)
	}
	if err != nil {
		http.Error(w, "File not found", http.StatusNotFound)
		return
	}
	info, err := os.Stat(filePath)
	if err != nil || info.IsDir() {
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

	disposition := "inline"
	if r.URL.Query().Get("download") == "1" {
		disposition = "attachment"
	}
	w.Header().Set("Content-Disposition", fmt.Sprintf("%s; filename=%q", disposition, safeName))
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

	resolved, err := resolveWithinRoot(h.scanRootFn(), relPath)
	if err != nil {
		resolved, err = resolveWithinRoot(h.dataDir, relPath)
	}
	if err != nil {
		http.Error(w, "File not found", http.StatusNotFound)
		return
	}
	info, err := os.Stat(resolved)
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
	// Same allowlist as Get(): only user board/PDF files are removable via
	// this endpoint. Reject dotfiles (.update-secret, .mcp-secret,
	// .update-counter) and non-supported files (e.g. *.db) so the data-dir's
	// private state files can't be deleted through it.
	if strings.HasPrefix(safeName, ".") || !databank.IsSupportedFile(safeName) {
		http.Error(w, "File not found", http.StatusNotFound)
		return
	}
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
