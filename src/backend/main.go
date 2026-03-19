package main

import (
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"

	"boardripper/databank"
	"boardripper/handlers"
)

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	dataDir := os.Getenv("DATA_DIR")
	if dataDir == "" {
		dataDir = "./data"
	}

	// Ensure data directory exists
	if err := os.MkdirAll(dataDir, 0755); err != nil {
		log.Fatalf("Failed to create data directory: %v", err)
	}

	staticDir := os.Getenv("STATIC_DIR")
	if staticDir == "" {
		staticDir = "./static"
	}

	// Initialize databank database
	db, err := databank.Open(dataDir)
	if err != nil {
		log.Fatalf("Failed to open databank: %v", err)
	}
	defer db.Close()

	// Create scanner and PDF extractor
	// LIBRARY_DIR env sets the default scan root (Docker: /library, dev: unset)
	libraryDir := os.Getenv("LIBRARY_DIR")
	scanner := databank.NewScanner(db, dataDir, libraryDir)
	extractor := databank.NewPdfExtractor(db, dataDir)

	// Run initial scan + PDF text extraction in background
	go func() {
		log.Println("Starting initial databank scan...")
		status := scanner.Scan()
		log.Printf("Initial scan complete: %d files (%d added, %d updated, %d deleted)",
			status.Total, status.Added, status.Updated, status.Deleted)

		// Extract text from new PDFs (2 concurrent workers for NAS)
		extracted, errors := extractor.ExtractAll(2)
		if extracted > 0 || errors > 0 {
			log.Printf("PDF text extraction: %d extracted, %d errors", extracted, errors)
		}
	}()

	mux := http.NewServeMux()

	// File API routes (existing)
	fileHandler := handlers.NewFileHandler(dataDir, scanner.ScanRoot)
	mux.HandleFunc("POST /api/upload", fileHandler.Upload)
	mux.HandleFunc("GET /api/files", fileHandler.List)
	mux.HandleFunc("GET /api/files/{name}", fileHandler.Get)
	mux.HandleFunc("DELETE /api/files/{name}", fileHandler.Delete)

	// Recursive file serving for databank (subdirectory support)
	mux.HandleFunc("GET /api/files/path/{path...}", fileHandler.GetByPath)

	// Databank API routes
	dbHandler := handlers.NewDatabankHandler(db, scanner, extractor, dataDir)
	mux.HandleFunc("POST /api/databank/scan", dbHandler.Scan)
	mux.HandleFunc("GET /api/databank/scan/status", dbHandler.ScanStatus)
	mux.HandleFunc("GET /api/databank/files", dbHandler.ListFiles)
	mux.HandleFunc("GET /api/databank/files/{id}", dbHandler.GetFile)
	mux.HandleFunc("PATCH /api/databank/files/{id}", dbHandler.UpdateFile)
	mux.HandleFunc("GET /api/databank/tree", dbHandler.Tree)
	mux.HandleFunc("POST /api/databank/bindings", dbHandler.CreateBinding)
	mux.HandleFunc("DELETE /api/databank/bindings/{id}", dbHandler.DeleteBinding)
	mux.HandleFunc("GET /api/databank/search", dbHandler.Search)
	mux.HandleFunc("PUT /api/databank/files/{id}/text", dbHandler.UploadText)
	mux.HandleFunc("GET /api/databank/preview/{id}", dbHandler.PreviewGet)
	mux.HandleFunc("PUT /api/databank/preview/{id}", dbHandler.PreviewPut)

	// Config API routes
	mux.HandleFunc("GET /api/config", dbHandler.GetConfig)
	mux.HandleFunc("PUT /api/config", dbHandler.SetConfig)

	// Serve static frontend files
	fs := http.FileServer(http.Dir(staticDir))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		// Try to serve the file directly
		path := filepath.Join(staticDir, r.URL.Path)
		_, statErr := os.Stat(path)
		if os.IsNotExist(statErr) {
			// SPA fallback: serve index.html for client-side routing
			w.Header().Set("Cache-Control", "no-store")
			http.ServeFile(w, r, filepath.Join(staticDir, "index.html"))
			return
		}
		// index.html must never be cached; hashed assets can be cached forever
		if r.URL.Path == "/" || r.URL.Path == "/index.html" {
			w.Header().Set("Cache-Control", "no-store")
		} else {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		}
		fs.ServeHTTP(w, r)
	})

	log.Printf("BoardRipper server starting on :%s", port)
	log.Printf("Static files: %s", staticDir)
	log.Printf("Data directory: %s", dataDir)
	log.Printf("Library scan root: %s", scanner.ScanRoot())

	addr := fmt.Sprintf(":%s", port)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatalf("Server failed: %v", err)
	}
}
