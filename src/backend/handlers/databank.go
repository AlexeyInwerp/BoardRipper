package handlers

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"boardripper/databank"
)

// allowedConfigKeys is the set of config keys that can be set via the API.
//
// Library Sync owns the `sync_*` namespace. The secret password key
// (`__sync_secret_pass`) is intentionally NOT in this set: it can only be
// written via PUT /api/sync/config so it never appears as a free-form value
// in the generic /api/config payload.
var allowedConfigKeys = map[string]bool{
	"auto_scan":             true,
	"auto_bind":             true,
	"library_dir":           true,
	"sync_enabled":          true,
	"sync_url":              true,
	"sync_user":             true,
	"sync_target":           true,
	"sync_schedule":         true,
	"sync_strict":           true,
	"sync_last_run_iso":     true,
	"sync_last_run_files":   true,
	"sync_last_run_bytes":   true,
	"sync_last_run_exit":    true,
	"sync_last_run_message": true,
	"pdf_watermark_terms":   true,
}

// DatabankHandler serves all /api/databank/* endpoints.
type DatabankHandler struct {
	db      *databank.DB
	scanner *databank.Scanner
	dataDir string
}

// NewDatabankHandler creates a new handler with the given database, scanner, and data directory.
func NewDatabankHandler(db *databank.DB, scanner *databank.Scanner, dataDir string) *DatabankHandler {
	return &DatabankHandler{db: db, scanner: scanner, dataDir: dataDir}
}

// Scan triggers a background file scan and returns immediately.
func (h *DatabankHandler) Scan(w http.ResponseWriter, r *http.Request) {
	status, err := h.scanner.ScanAsync()
	if err != nil {
		http.Error(w, err.Error(), http.StatusConflict)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(status)
}

// Stats returns database statistics.
func (h *DatabankHandler) Stats(w http.ResponseWriter, r *http.Request) {
	stats, err := h.db.Stats(h.dataDir)
	if err != nil {
		http.Error(w, "Failed to get stats: "+err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(stats)
}

// Reset wipes all scan data.
func (h *DatabankHandler) Reset(w http.ResponseWriter, r *http.Request) {
	if err := h.scanner.ResetAll(); err != nil {
		http.Error(w, err.Error(), http.StatusConflict)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "reset"})
}

// Browse returns a live filesystem directory listing.
func (h *DatabankHandler) Browse(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Query().Get("path")
	result, err := h.scanner.BrowseDir(path)
	if err != nil {
		http.Error(w, "Browse failed: "+err.Error(), http.StatusBadRequest)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(result)
}

// ScanStop cancels a running scan.
func (h *DatabankHandler) ScanStop(w http.ResponseWriter, r *http.Request) {
	status := h.scanner.StopScan()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(status)
}

// ScanStatus returns the current scan progress.
func (h *DatabankHandler) ScanStatus(w http.ResponseWriter, r *http.Request) {
	status := h.scanner.Status()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(status)
}

// ListFiles returns all files, with optional filtering.
// Query params:
//
//	type (board|pdf), manufacturer, donor (1), q (search query)
//	ids (comma-separated id list — short-circuits other filters; capped at maxIDsPerRequest)
//
// The `ids` filter exists so the History tab can hydrate ≤ historyDepth
// records on first paint without paying the cost of the full list.
func (h *DatabankHandler) ListFiles(w http.ResponseWriter, r *http.Request) {
	if idsParam := r.URL.Query().Get("ids"); idsParam != "" {
		ids, err := parseIDList(idsParam)
		if err != nil {
			http.Error(w, "Invalid ids: "+err.Error(), http.StatusBadRequest)
			return
		}
		files, err := h.db.ListFilesByIDs(r.Context(), ids)
		if err != nil {
			http.Error(w, "Failed to list files: "+err.Error(), http.StatusInternalServerError)
			return
		}
		if files == nil {
			files = []databank.FileRecord{}
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(files)
		return
	}

	fileType := r.URL.Query().Get("type")
	manufacturer := r.URL.Query().Get("manufacturer")
	donorOnly := r.URL.Query().Get("donor") == "1"

	// ETag fast-path: only meaningful for the unfiltered full-list query
	// (the same request that the IDB snapshot caches). Filtered responses
	// would need their own keys and aren't worth the bookkeeping here.
	if fileType == "" && manufacturer == "" && !donorOnly {
		if etag, err := h.db.FilesETag(); err == nil && etag != "" {
			if match := r.Header.Get("If-None-Match"); match != "" && match == etag {
				w.Header().Set("ETag", etag)
				w.WriteHeader(http.StatusNotModified)
				return
			}
			w.Header().Set("ETag", etag)
			// Cache-Control: response is conditionally cacheable — clients
			// must revalidate (so the ETag is checked) but the body can be
			// reused on a 304.
			w.Header().Set("Cache-Control", "no-cache")
		}
	}

	files, err := h.db.ListFiles(r.Context(), fileType, manufacturer, donorOnly)
	if err != nil {
		http.Error(w, "Failed to list files: "+err.Error(), http.StatusInternalServerError)
		return
	}

	if files == nil {
		files = []databank.FileRecord{}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(files)
}

// ListFilesStream streams the full unfiltered file list as NDJSON.
// First line: {"type":"begin","signature":"<etag-body>","total":<count>}
// Then one  : {"type":"file", ...FileRecord}
// Final line: {"type":"done","count":<actual>}
//
// Flushes every flushEveryN rows so the client renders progressively instead
// of waiting for the whole multi-MB body. ETag-aware: matches the bulk endpoint
// so a 304 still short-circuits this path.
func (h *DatabankHandler) ListFilesStream(w http.ResponseWriter, r *http.Request) {
	etag, _ := h.db.FilesETag()
	if etag != "" {
		if match := r.Header.Get("If-None-Match"); match != "" && match == etag {
			w.Header().Set("ETag", etag)
			w.WriteHeader(http.StatusNotModified)
			return
		}
		w.Header().Set("ETag", etag)
		w.Header().Set("Cache-Control", "no-cache")
	}

	// Derive the "total" hint from the ETag body (shape `last_scan:count`);
	// purely advisory — the client trusts the actual stream. Saves a second
	// COUNT(*) round-trip just to populate the progress bar.
	var total int64
	if sigBody := strings.Trim(etag, "\""); sigBody != "" {
		if idx := strings.LastIndex(sigBody, ":"); idx >= 0 {
			if n, err := strconv.ParseInt(sigBody[idx+1:], 10, 64); err == nil {
				total = n
			}
		}
	}

	w.Header().Set("Content-Type", "application/x-ndjson")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	// Encourage proxies/buffers to not coalesce — without this, nginx-like
	// intermediaries can buffer the whole response back into one block.
	w.Header().Set("X-Accel-Buffering", "no")

	flusher, _ := w.(http.Flusher)
	enc := json.NewEncoder(w)
	// File paths/names rarely contain `<>&` and even when they do the worker
	// reads the response as raw NDJSON, never sticks it into an HTML document.
	// Skipping the escape scan saves a per-string pass on every one of N
	// records — small but measurable on 100k-row streams.
	enc.SetEscapeHTML(false)

	// Compact signature for the "begin" line — strips the ETag's enclosing
	// quotes so the JS side can compare it directly with libraryCache's
	// `${last_file_scan_at}:${boards+pdfs}` shape.
	sig := strings.Trim(etag, "\"")
	_ = enc.Encode(struct {
		Type      string `json:"type"`
		Signature string `json:"signature,omitempty"`
		Total     int64  `json:"total"`
	}{"begin", sig, total})
	if flusher != nil {
		flusher.Flush()
	}

	const flushEveryN = 1024
	var count int64
	err := h.db.ListFilesStreaming(r.Context(), func(f *databank.FileRecord) error {
		// Encode the file record under a "type"-tagged envelope. Lifting the
		// FileRecord fields up through json marshaling is cleaner than holding
		// a parallel wrapper struct — the embedded pointer gives us all the
		// existing `json:` tags for free.
		if err := enc.Encode(struct {
			Type string `json:"type"`
			*databank.FileRecord
		}{"file", f}); err != nil {
			return err
		}
		count++
		if count%flushEveryN == 0 && flusher != nil {
			flusher.Flush()
		}
		return nil
	})

	if err != nil {
		// Stream is already mid-flight; we can't change status codes. Surface
		// the error inline so the client treats it as a load failure instead
		// of a silent truncation.
		_ = enc.Encode(struct {
			Type  string `json:"type"`
			Error string `json:"error"`
		}{"error", err.Error()})
		if flusher != nil {
			flusher.Flush()
		}
		return
	}

	_ = enc.Encode(struct {
		Type  string `json:"type"`
		Count int64  `json:"count"`
	}{"done", count})
	if flusher != nil {
		flusher.Flush()
	}
}

// maxIDsPerRequest caps a single `ids=` query so a malformed client can't
// blow up the SQL placeholder list.
const maxIDsPerRequest = 1024

func parseIDList(s string) ([]int64, error) {
	parts := strings.Split(s, ",")
	if len(parts) > maxIDsPerRequest {
		return nil, fmt.Errorf("too many ids (max %d)", maxIDsPerRequest)
	}
	ids := make([]int64, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		id, err := strconv.ParseInt(p, 10, 64)
		if err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, nil
}

// GetFile returns a single file record with its bindings (both directions).
func (h *DatabankHandler) GetFile(w http.ResponseWriter, r *http.Request) {
	idStr := r.PathValue("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		http.Error(w, "Invalid file ID", http.StatusBadRequest)
		return
	}

	file, err := h.db.GetFileByID(r.Context(), id)
	if err != nil {
		http.Error(w, "File not found", http.StatusNotFound)
		return
	}

	// Include bindings (both directions: file as board or as PDF)
	bindings, _ := h.db.GetBindingsForFile(r.Context(), id)
	if bindings == nil {
		bindings = []databank.BindingDetail{}
	}

	resp := struct {
		*databank.FileRecord
		Bindings []databank.BindingDetail `json:"bindings"`
	}{file, bindings}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

// UpdateFile updates metadata fields for a file (PATCH).
func (h *DatabankHandler) UpdateFile(w http.ResponseWriter, r *http.Request) {
	idStr := r.PathValue("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		http.Error(w, "Invalid file ID", http.StatusBadRequest)
		return
	}

	// Get existing record
	existing, err := h.db.GetFileByID(r.Context(), id)
	if err != nil {
		http.Error(w, "File not found", http.StatusNotFound)
		return
	}

	// Parse partial update
	var update struct {
		BoardNumber  *string `json:"board_number"`
		Manufacturer *string `json:"manufacturer"`
		Model        *string `json:"model"`
		DonorPool    *bool   `json:"donor_pool"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 256<<10)
	if err := json.NewDecoder(r.Body).Decode(&update); err != nil {
		http.Error(w, "Invalid JSON: "+err.Error(), http.StatusBadRequest)
		return
	}

	// Merge with existing values
	boardNumber := existing.BoardNumber
	manufacturer := existing.Manufacturer
	model := existing.Model
	donorPool := existing.DonorPool

	if update.BoardNumber != nil {
		boardNumber = *update.BoardNumber
	}
	if update.Manufacturer != nil {
		manufacturer = *update.Manufacturer
	}
	if update.Model != nil {
		model = *update.Model
	}
	if update.DonorPool != nil {
		donorPool = *update.DonorPool
	}

	if err := h.db.UpdateFileMetadata(id, boardNumber, manufacturer, model, donorPool); err != nil {
		http.Error(w, "Update failed: "+err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

// Tree returns the folder tree structure.
func (h *DatabankHandler) Tree(w http.ResponseWriter, r *http.Request) {
	tree, err := h.scanner.BuildFolderTree()
	if err != nil {
		http.Error(w, "Failed to build tree: "+err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(tree)
}

// CreateBinding creates a new board-PDF binding.
// Optional `category` (default "schematic") and `auto_open` (default true)
// drive the FileDetailPane grouping and the Auto-PDF filter respectively.
func (h *DatabankHandler) CreateBinding(w http.ResponseWriter, r *http.Request) {
	var req struct {
		BoardFileID int64   `json:"board_file_id"`
		PdfFileID   int64   `json:"pdf_file_id"`
		Category    *string `json:"category,omitempty"`
		AutoOpen    *bool   `json:"auto_open,omitempty"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON: "+err.Error(), http.StatusBadRequest)
		return
	}

	if req.BoardFileID == 0 || req.PdfFileID == 0 {
		http.Error(w, "board_file_id and pdf_file_id are required", http.StatusBadRequest)
		return
	}

	category := "schematic"
	if req.Category != nil {
		category = *req.Category
	}
	autoOpen := true
	if req.AutoOpen != nil {
		autoOpen = *req.AutoOpen
	}

	id, err := h.db.InsertBinding(req.BoardFileID, req.PdfFileID, false, category, autoOpen)
	if err != nil {
		http.Error(w, "Failed to create binding: "+err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]int64{"id": id})
}

// UpdateBinding patches a binding's category and/or auto_open flag.
func (h *DatabankHandler) UpdateBinding(w http.ResponseWriter, r *http.Request) {
	idStr := r.PathValue("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		http.Error(w, "Invalid binding ID", http.StatusBadRequest)
		return
	}

	var req struct {
		Category *string `json:"category,omitempty"`
		AutoOpen *bool   `json:"auto_open,omitempty"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON: "+err.Error(), http.StatusBadRequest)
		return
	}

	if req.Category == nil && req.AutoOpen == nil {
		http.Error(w, "must set at least one of category, auto_open", http.StatusBadRequest)
		return
	}

	if err := h.db.UpdateBinding(id, req.Category, req.AutoOpen); err != nil {
		http.Error(w, "Failed to update binding: "+err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

// DeleteBinding removes a binding by ID.
func (h *DatabankHandler) DeleteBinding(w http.ResponseWriter, r *http.Request) {
	idStr := r.PathValue("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		http.Error(w, "Invalid binding ID", http.StatusBadRequest)
		return
	}

	if err := h.db.DeleteBinding(id); err != nil {
		http.Error(w, "Failed to delete binding: "+err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "deleted"})
}

func (h *DatabankHandler) previewPath(id int64) string {
	return filepath.Join(h.dataDir, ".previews", fmt.Sprintf("%d.png", id))
}

// PreviewGet serves a cached preview image.
func (h *DatabankHandler) PreviewGet(w http.ResponseWriter, r *http.Request) {
	idStr := r.PathValue("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		http.Error(w, "Invalid file ID", http.StatusBadRequest)
		return
	}

	path := h.previewPath(id)
	if _, err := os.Stat(path); os.IsNotExist(err) {
		http.Error(w, "Preview not found", http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "public, max-age=86400")
	http.ServeFile(w, r, path)
}

// PreviewPut accepts a client-generated preview image (PNG).
func (h *DatabankHandler) PreviewPut(w http.ResponseWriter, r *http.Request) {
	idStr := r.PathValue("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		http.Error(w, "Invalid file ID", http.StatusBadRequest)
		return
	}

	// Verify file exists
	_, err = h.db.GetFileByID(r.Context(), id)
	if err != nil {
		http.Error(w, "File not found", http.StatusNotFound)
		return
	}

	// Limit upload to 512KB
	r.Body = http.MaxBytesReader(w, r.Body, 512*1024)

	// Ensure previews directory exists
	previewDir := filepath.Join(h.dataDir, ".previews")
	if err := os.MkdirAll(previewDir, 0755); err != nil {
		http.Error(w, "Failed to create preview dir", http.StatusInternalServerError)
		return
	}

	// Write preview file
	path := h.previewPath(id)
	f, err := os.Create(path)
	if err != nil {
		http.Error(w, "Failed to create preview file", http.StatusInternalServerError)
		return
	}
	defer f.Close()

	if _, err := io.Copy(f, r.Body); err != nil {
		os.Remove(path)
		http.Error(w, "Failed to write preview", http.StatusInternalServerError)
		return
	}

	// Mark file as having a preview
	h.db.SetHasPreview(id, true)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

// GetConfig returns all config values, enriched with runtime info.
// GET /api/config — returns config as JSON object.
// Includes "_scan_root" (effective scan directory) for the frontend.
func (h *DatabankHandler) GetConfig(w http.ResponseWriter, r *http.Request) {
	all, err := h.db.AllConfig()
	if err != nil {
		http.Error(w, "Failed to read config: "+err.Error(), http.StatusInternalServerError)
		return
	}
	// Include effective scan root so frontend knows where files are coming from
	all["_scan_root"] = h.scanner.ScanRoot()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(all)
}

// SetConfig updates a single config key.
// PUT /api/config — body: {"key": "...", "value": "..."}
func (h *DatabankHandler) SetConfig(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Key   string `json:"key"`
		Value string `json:"value"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 256<<10)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON: "+err.Error(), http.StatusBadRequest)
		return
	}
	if req.Key == "" {
		http.Error(w, "key is required", http.StatusBadRequest)
		return
	}
	if !allowedConfigKeys[req.Key] {
		http.Error(w, "unknown config key: "+req.Key, http.StatusBadRequest)
		return
	}

	if err := h.db.SetConfig(req.Key, req.Value); err != nil {
		http.Error(w, "Failed to set config: "+err.Error(), http.StatusInternalServerError)
		return
	}

	// If library_dir changed, update scanner's scan root
	if req.Key == "library_dir" {
		h.scanner.SetLibraryDir(req.Value)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

// ListDonors returns all entries in the donor list with their file metadata.
// GET /api/databank/donors — returns []databank.DonorEntry (empty array, never null).
func (h *DatabankHandler) ListDonors(w http.ResponseWriter, r *http.Request) {
	donors, err := h.db.ListDonors()
	if err != nil {
		http.Error(w, "Failed to list donors: "+err.Error(), http.StatusInternalServerError)
		return
	}
	if donors == nil {
		donors = []databank.DonorEntry{}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(donors)
}

// AddDonor adds a file to the donor list.
// PUT /api/databank/donors/{id} — 400 if the file does not exist or is not a PDF.
func (h *DatabankHandler) AddDonor(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		http.Error(w, "Invalid file ID", http.StatusBadRequest)
		return
	}

	file, err := h.db.GetFileByID(r.Context(), id)
	if err != nil {
		http.Error(w, "File not found", http.StatusBadRequest)
		return
	}
	if file.FileType != "pdf" {
		http.Error(w, "File is not a PDF", http.StatusBadRequest)
		return
	}

	if err := h.db.AddDonor(id); err != nil {
		http.Error(w, "Failed to add donor: "+err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

// RemoveDonor removes a file from the donor list.
// DELETE /api/databank/donors/{id}
func (h *DatabankHandler) RemoveDonor(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		http.Error(w, "Invalid file ID", http.StatusBadRequest)
		return
	}

	if err := h.db.RemoveDonor(id); err != nil {
		http.Error(w, "Failed to remove donor: "+err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "deleted"})
}

