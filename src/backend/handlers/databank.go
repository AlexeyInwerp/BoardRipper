package handlers

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"

	"boardripper/databank"
)

// DatabankHandler serves all /api/databank/* endpoints.
type DatabankHandler struct {
	db        *databank.DB
	scanner   *databank.Scanner
	extractor *databank.PdfExtractor
	dataDir   string
}

// NewDatabankHandler creates a new handler with the given database, scanner, and extractor.
func NewDatabankHandler(db *databank.DB, scanner *databank.Scanner, extractor *databank.PdfExtractor, dataDir string) *DatabankHandler {
	return &DatabankHandler{db: db, scanner: scanner, extractor: extractor, dataDir: dataDir}
}

// Scan triggers a full rescan of DATA_DIR and returns the results.
func (h *DatabankHandler) Scan(w http.ResponseWriter, r *http.Request) {
	status := h.scanner.Scan()
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
// Query params: type (board|pdf), manufacturer, donor (1), q (search query)
func (h *DatabankHandler) ListFiles(w http.ResponseWriter, r *http.Request) {
	fileType := r.URL.Query().Get("type")
	manufacturer := r.URL.Query().Get("manufacturer")
	donorOnly := r.URL.Query().Get("donor") == "1"

	files, err := h.db.ListFiles(fileType, manufacturer, donorOnly)
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

// GetFile returns a single file record with its bindings (both directions).
func (h *DatabankHandler) GetFile(w http.ResponseWriter, r *http.Request) {
	idStr := r.PathValue("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		http.Error(w, "Invalid file ID", http.StatusBadRequest)
		return
	}

	file, err := h.db.GetFileByID(id)
	if err != nil {
		http.Error(w, "File not found", http.StatusNotFound)
		return
	}

	// Include bindings (both directions: file as board or as PDF)
	bindings, _ := h.db.GetBindingsForFile(id)
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
	existing, err := h.db.GetFileByID(id)
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
func (h *DatabankHandler) CreateBinding(w http.ResponseWriter, r *http.Request) {
	var req struct {
		BoardFileID int64 `json:"board_file_id"`
		PdfFileID   int64 `json:"pdf_file_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON: "+err.Error(), http.StatusBadRequest)
		return
	}

	if req.BoardFileID == 0 || req.PdfFileID == 0 {
		http.Error(w, "board_file_id and pdf_file_id are required", http.StatusBadRequest)
		return
	}

	id, err := h.db.InsertBinding(req.BoardFileID, req.PdfFileID, false)
	if err != nil {
		http.Error(w, "Failed to create binding: "+err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]int64{"id": id})
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
	_, err = h.db.GetFileByID(id)
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

// Search performs full-text search across all indexed PDF pages.
// Query params: q (search terms), donor (1 = donor pool only)
func (h *DatabankHandler) Search(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query().Get("q")
	donorOnly := r.URL.Query().Get("donor") == "1"

	results, err := h.db.Search(query, donorOnly)
	if err != nil {
		http.Error(w, "Search failed: "+err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(results)
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
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON: "+err.Error(), http.StatusBadRequest)
		return
	}
	if req.Key == "" {
		http.Error(w, "key is required", http.StatusBadRequest)
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

// UploadText accepts client-extracted (pdfjs) text to replace Go-extracted text.
// Body: { "pages": { "1": "page 1 text", "2": "page 2 text", ... } }
func (h *DatabankHandler) UploadText(w http.ResponseWriter, r *http.Request) {
	idStr := r.PathValue("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		http.Error(w, "Invalid file ID", http.StatusBadRequest)
		return
	}

	// Verify file exists and is a PDF
	file, err := h.db.GetFileByID(id)
	if err != nil {
		http.Error(w, "File not found", http.StatusNotFound)
		return
	}
	if file.FileType != "pdf" {
		http.Error(w, "File is not a PDF", http.StatusBadRequest)
		return
	}

	var body struct {
		Pages map[string]string `json:"pages"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "Invalid JSON: "+err.Error(), http.StatusBadRequest)
		return
	}

	// Convert string keys to int
	pages := make(map[int]string, len(body.Pages))
	for k, v := range body.Pages {
		num, err := strconv.Atoi(k)
		if err != nil {
			http.Error(w, "Invalid page number: "+k, http.StatusBadRequest)
			return
		}
		pages[num] = v
	}

	if err := h.extractor.ReplaceText(id, pages); err != nil {
		http.Error(w, "Failed to update text: "+err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status": "ok",
		"pages":  len(pages),
	})
}
