package handlers

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// allowedExtensions is the single source of truth for accepted board file formats.
// To add a new format, append its lowercase extension here.
var allowedExtensions = map[string]bool{
	".bvr": true,
	".bv":  true,
	".brd": true,
	".fz":  true,
	".cae": true,
	".cad": true,
	".pcb": true,
	".bdv": true,
}

// allowedExtensionList returns a human-readable list for error messages.
func allowedExtensionList() string {
	list := ""
	for ext := range allowedExtensions {
		if list != "" {
			list += ", "
		}
		list += ext
	}
	return list
}

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
	ext := strings.ToLower(filepath.Ext(header.Filename))
	if !allowedExtensions[ext] {
		http.Error(w, "Supported formats: "+allowedExtensionList(), http.StatusBadRequest)
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
		http.Error(w, "Failed to write file: "+err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"name":   safeName,
		"status": "ok",
	})
}

// allAllowedExtensions includes both board and PDF extensions for listing.
var allAllowedExtensions = map[string]bool{
	".bvr": true, ".bv": true, ".brd": true, ".bdv": true, ".fz": true,
	".cae": true, ".cad": true, ".pcb": true, ".pdf": true,
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
		ext := strings.ToLower(filepath.Ext(entry.Name()))
		if !allAllowedExtensions[ext] {
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

	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Content-Disposition", fmt.Sprintf("inline; filename=%q", safeName))
	http.ServeFile(w, r, filePath)
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
	} else if allowedExtensions[ext] {
		contentType = "text/plain; charset=utf-8"
	}

	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Disposition", fmt.Sprintf("inline; filename=%q", safeName))
	http.ServeFile(w, r, filePath)
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
