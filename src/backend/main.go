package main

import (
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"

	"boardviewer/handlers"
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

	mux := http.NewServeMux()

	// API routes
	fileHandler := handlers.NewFileHandler(dataDir)
	mux.HandleFunc("POST /api/upload", fileHandler.Upload)
	mux.HandleFunc("GET /api/files", fileHandler.List)
	mux.HandleFunc("GET /api/files/{name}", fileHandler.Get)
	mux.HandleFunc("DELETE /api/files/{name}", fileHandler.Delete)

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

	log.Printf("Boardviewer server starting on :%s", port)
	log.Printf("Static files: %s", staticDir)
	log.Printf("Data directory: %s", dataDir)

	addr := fmt.Sprintf(":%s", port)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatalf("Server failed: %v", err)
	}
}
