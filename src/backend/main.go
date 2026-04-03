package main

import (
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"

	"boardripper/boarddb"
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

	// Initialize board reference database (optional — disabled if boards.db missing)
	boardDBPath := filepath.Join(dataDir, "boards.db")
	bdb := boarddb.Open(boardDBPath)
	if bdb != nil {
		defer bdb.Close()
	}

	// Create scanner and PDF extractor
	// LIBRARY_DIR env sets the default scan root (Docker: /library, dev: unset)
	libraryDir := os.Getenv("LIBRARY_DIR")
	scanner := databank.NewScanner(db, dataDir, libraryDir)
	scanner.SetBoardDB(bdb)
	extractor := databank.NewPdfExtractor(db, dataDir)
	extractor.SetScanner(scanner)

	scanner.SetExtractor(extractor)

	// Conditional auto-scan based on config (default: off)
	if autoScan, _ := db.GetConfig("auto_scan"); autoScan == "true" {
		go func() {
			log.Println("Auto-scan: starting file indexing...")
			status := scanner.Scan()
			log.Printf("Auto-scan complete: %d files (%d added, %d updated, %d deleted) in %dms",
				status.Total, status.Added, status.Updated, status.Deleted, status.Duration)
		}()
	} else {
		log.Println("Auto-scan disabled (set auto_scan=true in config to enable)")
	}

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
	mux.HandleFunc("POST /api/databank/scan/stop", dbHandler.ScanStop)
	mux.HandleFunc("GET /api/databank/scan/status", dbHandler.ScanStatus)
	mux.HandleFunc("GET /api/databank/files", dbHandler.ListFiles)
	mux.HandleFunc("GET /api/databank/files/{id}", dbHandler.GetFile)
	mux.HandleFunc("PATCH /api/databank/files/{id}", dbHandler.UpdateFile)
	mux.HandleFunc("GET /api/databank/tree", dbHandler.Tree)
	mux.HandleFunc("POST /api/databank/bindings", dbHandler.CreateBinding)
	mux.HandleFunc("DELETE /api/databank/bindings/{id}", dbHandler.DeleteBinding)
	mux.HandleFunc("GET /api/databank/search", dbHandler.Search)
	mux.HandleFunc("POST /api/databank/scan/pdf", dbHandler.ScanPdf)
	mux.HandleFunc("GET /api/databank/stats", dbHandler.Stats)
	mux.HandleFunc("POST /api/databank/reset", dbHandler.Reset)
	mux.HandleFunc("POST /api/databank/reset-pdf", dbHandler.ResetPdf)
	mux.HandleFunc("GET /api/databank/browse", dbHandler.Browse)
	mux.HandleFunc("GET /api/databank/pdf-errors", dbHandler.PdfScanErrors)
	mux.HandleFunc("DELETE /api/databank/pdf-errors", dbHandler.PdfScanErrorsClear)
	mux.HandleFunc("GET /api/databank/files/{id}/dump", dbHandler.DumpText)
	mux.HandleFunc("PUT /api/databank/files/{id}/text", dbHandler.UploadText)
	mux.HandleFunc("GET /api/databank/preview/{id}", dbHandler.PreviewGet)
	mux.HandleFunc("PUT /api/databank/preview/{id}", dbHandler.PreviewPut)

	// Board reference database API routes
	boardsHandler := handlers.NewBoardsHandler(bdb)
	mux.HandleFunc("GET /api/boards/resolve", boardsHandler.Resolve)
	mux.HandleFunc("GET /api/boards/stats", boardsHandler.Stats)

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
