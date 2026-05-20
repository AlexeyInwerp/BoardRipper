package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"syscall"
	"time"

	"encoding/json"

	"boardripper/boarddb"
	"boardripper/databank"
	"boardripper/handlers"
	"boardripper/librarysync"
	"boardripper/obd"
	"boardripper/pdfindex"
	"boardripper/updater"
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

	// Initialize board reference database (optional — disabled if boards.db missing).
	// Resolution order:
	//   1. BOARDDB_PATH env (explicit override — production / docker-compose)
	//   2. DATA_DIR/boards.db (user-curated DB on a mounted volume)
	//   3. /boards.db (image-bundled fallback so the Docker container ships
	//      with a populated reference DB even when /data is an empty volume)
	boardDBPath := os.Getenv("BOARDDB_PATH")
	if boardDBPath == "" {
		boardDBPath = filepath.Join(dataDir, "boards.db")
		if _, err := os.Stat(boardDBPath); errors.Is(err, os.ErrNotExist) {
			if _, err := os.Stat("/boards.db"); err == nil {
				boardDBPath = "/boards.db"
			}
		}
	}
	bdb := boarddb.Open(boardDBPath)
	if bdb != nil {
		defer bdb.Close()
	}

	// Create scanner
	// LIBRARY_DIR env sets the default scan root (Docker: /library, dev: unset)
	libraryDir := os.Getenv("LIBRARY_DIR")
	scanner := databank.NewScanner(db, dataDir, libraryDir)
	scanner.SetBoardDB(bdb)

	// PDF-index migration (v0→v1) runs against databank.db before opening the
	// separate index DB. Migration failure is fatal (data integrity). A failure
	// to OPEN pdfindex.db must NOT kill boot — degrade to "index unavailable".
	if err := db.MigratePdfIndexV1(); err != nil {
		log.Fatalf("pdf-index migration failed: %v", err)
	}
	pdfIndexPath := filepath.Join(dataDir, "pdfindex.db")
	var pdfIndex *pdfindex.DB
	pdfIndex, err = pdfindex.Open(pdfIndexPath)
	if err != nil {
		log.Printf("WARNING: pdfindex.db unavailable (%v) — PDF search disabled this boot", err)
		pdfIndex = nil
	} else {
		defer pdfIndex.Close()
	}
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

	// Per-route handler timeouts. Reads get 30s (covers full-list queries
	// at 100k rows + FTS5 search). Writes get 10s. Long-running endpoints
	// (scan trigger, file upload/download, update apply) stay unwrapped —
	// they have their own cancellation channels or are streaming.
	read := withTimeout(30 * time.Second)
	write := withTimeout(10 * time.Second)

	// Health endpoint — returns 200 {"status":"ok"} once the process is
	// serving. Reached only after all setup above completes, so by
	// definition the server is ready when this handler can be hit.
	ready := func() bool { return true }
	healthHandler := handlers.NewHealthHandler(ready)
	mux.HandleFunc("GET /api/health", healthHandler.Serve)

	// File API routes (existing)
	fileHandler := handlers.NewFileHandler(dataDir, scanner.ScanRoot)
	mux.HandleFunc("POST /api/upload", fileHandler.Upload)                  // streaming upload — no wrap
	mux.HandleFunc("GET /api/files", read(fileHandler.List))
	mux.HandleFunc("GET /api/files/{name}", fileHandler.Get)                // streaming download — no wrap
	mux.HandleFunc("DELETE /api/files/{name}", write(fileHandler.Delete))

	// Recursive file serving for databank (subdirectory support)
	mux.HandleFunc("GET /api/files/path/{path...}", fileHandler.GetByPath)  // streaming download — no wrap
	mux.HandleFunc("GET /api/files/probe", read(fileHandler.Probe))         // diagnostic: cloud-placeholder triage

	// Databank API routes
	dbHandler := handlers.NewDatabankHandler(db, scanner, dataDir)
	mux.HandleFunc("POST /api/databank/scan", dbHandler.Scan)               // returns immediately, scan runs in goroutine
	mux.HandleFunc("POST /api/databank/scan/stop", write(dbHandler.ScanStop))
	mux.HandleFunc("GET /api/databank/scan/status", read(dbHandler.ScanStatus))
	mux.HandleFunc("GET /api/databank/files", read(dbHandler.ListFiles))
	mux.HandleFunc("GET /api/databank/files/{id}", read(dbHandler.GetFile))
	mux.HandleFunc("PATCH /api/databank/files/{id}", write(dbHandler.UpdateFile))
	mux.HandleFunc("GET /api/databank/tree", read(dbHandler.Tree))
	mux.HandleFunc("POST /api/databank/bindings", write(dbHandler.CreateBinding))
	mux.HandleFunc("PATCH /api/databank/bindings/{id}", write(dbHandler.UpdateBinding))
	mux.HandleFunc("DELETE /api/databank/bindings/{id}", write(dbHandler.DeleteBinding))
	// GET /api/databank/search is registered below inside the pdfIndex block.
	// When pdfIndex is nil (degraded boot), search is unavailable — no route.
	mux.HandleFunc("GET /api/databank/stats", read(dbHandler.Stats))
	mux.HandleFunc("POST /api/databank/reset", write(dbHandler.Reset))
	mux.HandleFunc("GET /api/databank/browse", read(dbHandler.Browse))
	mux.HandleFunc("GET /api/databank/preview/{id}", dbHandler.PreviewGet)  // streaming PNG — no wrap
	mux.HandleFunc("PUT /api/databank/preview/{id}", write(dbHandler.PreviewPut))
	mux.HandleFunc("GET /api/databank/donors", read(dbHandler.ListDonors))
	mux.HandleFunc("PUT /api/databank/donors/{id}", write(dbHandler.AddDonor))
	mux.HandleFunc("DELETE /api/databank/donors/{id}", write(dbHandler.RemoveDonor))

	// Content dedup ("Find duplicates") API routes
	dedupRunner := databank.NewDedupRunner(db, scanner.ScanRoot)
	dedupHandler := handlers.NewDedupHandler(dedupRunner, db)
	mux.HandleFunc("POST /api/databank/dedup/run", dedupHandler.Run)
	mux.HandleFunc("POST /api/databank/dedup/stop", write(dedupHandler.Stop))
	mux.HandleFunc("GET /api/databank/dedup/progress", read(dedupHandler.ProgressEndpoint))
	mux.HandleFunc("GET /api/databank/dedup/stats", read(dedupHandler.Stats))

	// Board reference database API routes
	boardsHandler := handlers.NewBoardsHandler(bdb)
	mux.HandleFunc("GET /api/boards/resolve", read(boardsHandler.Resolve))
	mux.HandleFunc("GET /api/boards/stats", read(boardsHandler.Stats))
	mux.HandleFunc("GET /api/boards/hierarchy", read(boardsHandler.Hierarchy))

	// Config API routes
	mux.HandleFunc("GET /api/config", read(dbHandler.GetConfig))
	mux.HandleFunc("PUT /api/config", write(dbHandler.SetConfig))

	// Update API routes
	upd := updater.New(dataDir)
	upd.StartBackgroundChecker(6 * time.Hour)
	defer upd.Stop()
	updateHandler := handlers.NewUpdateHandler(upd)

	secret, err := updater.EnsureSecret(dataDir)
	if err != nil {
		log.Fatal("update secret:", err)
	}
	log.Printf("update auth: per-install secret loaded from %s", filepath.Join(dataDir, ".update-secret"))

	bootstrap := handlers.NewBootstrapHandler(secret)
	mux.HandleFunc("GET /api/update/bootstrap", bootstrap.Serve)

	mux.Handle("GET /api/update/status",   handlers.WithUpdateAuth(secret, read(updateHandler.Status)))
	mux.Handle("POST /api/update/check",   handlers.WithUpdateAuth(secret, http.HandlerFunc(updateHandler.Check)))   // hits GitHub, can take 30s+
	mux.Handle("POST /api/update/apply",   handlers.WithUpdateAuth(secret, http.HandlerFunc(updateHandler.Apply)))   // long-running — Docker pull + restart
	mux.Handle("POST /api/update/apply-bundle", handlers.WithUpdateAuth(secret, http.HandlerFunc(updateHandler.ApplyBundle))) // multipart upload of .brupdate
	mux.Handle("GET /api/update/progress", handlers.WithUpdateAuth(secret, read(updateHandler.Progress)))

	// Library Sync API routes — periodic mirror of an upstream HTTP/WebDAV
	// library into LIBRARY_DIR. The engine + scheduler share one rootCtx so a
	// graceful shutdown cancels both.
	syncRootCtx, syncRootCancel := context.WithCancel(context.Background())
	defer syncRootCancel()
	syncEngine := librarysync.New(db)
	syncHandler := handlers.NewSyncHandler(db, syncEngine)
	mux.HandleFunc("/api/sync/config", write(syncHandler.Config))     // GET + PUT
	mux.HandleFunc("POST /api/sync/test", write(syncHandler.Test))
	mux.HandleFunc("POST /api/sync/start", write(syncHandler.Start))
	mux.HandleFunc("POST /api/sync/stop", write(syncHandler.Stop))
	mux.HandleFunc("GET /api/sync/status", read(syncHandler.Status))
	mux.HandleFunc("GET /api/sync/check-target", read(syncHandler.CheckTarget))
	go librarysync.Run(syncRootCtx, syncEngine, db)

	// OpenBoardData (OBD) API routes — independent filesystem-backed data layer
	// rooted at <dataDir>/obd/. /data is always writable across container updates;
	// the library mount is typically read-only and was losing the cache pre-v0.20.3.
	// MigrateLegacyCache transparently moves any pre-existing cache from the old
	// library-rooted path on first boot.
	obdRoot := filepath.Join(dataDir, "obd")
	configLibRoot, _ := db.GetConfig("library_dir")
	obd.MigrateLegacyCache(obdRoot, []string{configLibRoot, libraryDir})
	obdStore := obd.NewStore(obdRoot)
	obdScraper := obd.NewScraper("https://openboarddata.org")
	obdHandler := handlers.NewObdHandler(obdStore, obdScraper)
	mux.HandleFunc("POST /api/obd/index/sync", obdHandler.IndexSync) // long-running — no wrap
	mux.HandleFunc("GET /api/obd/match", read(obdHandler.Match))
	mux.HandleFunc("GET /api/obd/data", read(obdHandler.Data))
	mux.HandleFunc("POST /api/obd/fetch", obdHandler.Fetch) // 30s upstream timeout — no wrap
	mux.HandleFunc("DELETE /api/obd/cache", write(obdHandler.CacheDelete))

	// PDF index API routes — only registered when pdfindex.db is available and
	// the pdfium WASM engine initialises successfully.
	if pdfIndex != nil {
		poolMax := 2
		if v := os.Getenv("PDFINDEX_POOL_MAX"); v != "" {
			if n, err := strconv.Atoi(v); err == nil && n > 0 {
				poolMax = n
			}
		}
		engine, eerr := pdfindex.NewEngine(poolMax)
		if eerr != nil {
			log.Printf("WARNING: pdfium engine init failed (%v) — backend PDF indexing disabled", eerr)
		} else {
			defer engine.Close()
			termsFn := func() []string { return loadWatermarkTerms(db) }
			source := handlers.NewPdfIndexSource(db, scanner.ScanRoot)
			indexer := pdfindex.NewIndexer(pdfIndex, engine, source, termsFn, poolMax)
			defer close(indexer.StartWatchdog(5*time.Minute, 600))

			pdfIdxHandler := handlers.NewPdfIndexHandler(pdfIndex, indexer, db)
			mux.HandleFunc("GET /api/pdfindex/status/{id}", read(pdfIdxHandler.Status))
			mux.HandleFunc("GET /api/pdfindex/stats", read(pdfIdxHandler.Stats))
			mux.HandleFunc("POST /api/pdfindex/run", pdfIdxHandler.Run)
			mux.HandleFunc("POST /api/pdfindex/stop", write(pdfIdxHandler.Stop))
			mux.HandleFunc("GET /api/pdfindex/progress", read(pdfIdxHandler.ProgressEndpoint))
			mux.HandleFunc("POST /api/pdfindex/reindex", write(pdfIdxHandler.Reindex))
				mux.HandleFunc("POST /api/pdfindex/reindex-watermark", write(pdfIdxHandler.ReindexWatermark))
			mux.HandleFunc("POST /api/pdfindex/files/{id}/index", write(pdfIdxHandler.PriorityIndex))
			mux.HandleFunc("POST /api/pdfindex/files/{id}/begin", write(pdfIdxHandler.Begin))
			mux.HandleFunc("PUT /api/pdfindex/files/{id}/pages", pdfIdxHandler.Pages)
			mux.HandleFunc("POST /api/pdfindex/files/{id}/finalize", write(pdfIdxHandler.Finalize))
			mux.HandleFunc("POST /api/pdfindex/files/{id}/fail", write(pdfIdxHandler.FailEndpoint))
			mux.HandleFunc("GET /api/pdfindex/failed", read(pdfIdxHandler.Failed))
			mux.HandleFunc("DELETE /api/pdfindex/files/{id}", write(pdfIdxHandler.Delete))
			mux.HandleFunc("POST /api/pdfindex/index-folder", write(pdfIdxHandler.IndexFolder))
			mux.HandleFunc("GET /api/databank/search", read(pdfIdxHandler.Search))

			if v, _ := db.GetConfig("pdf_index_auto_run"); v == "true" {
				go func() {
					log.Println("pdfindex: auto-run enabled — starting bulk sweep")
					_ = indexer.Run()
				}()
			}
		}
	}

	// Serve static frontend files.
	//
	// Cache policy:
	// - index.html + SPA fallback: multi-layered no-cache directives so
	//   every deploy is picked up on the next request even if a
	//   reverse-proxy (DSM, Cloudflare, etc.) silently drops one of
	//   them. no-cache forces revalidation, no-store forbids any copy,
	//   must-revalidate disables stale-while-revalidate, Pragma covers
	//   HTTP/1.0 caches. Expires=0 is a legacy belt-and-suspenders.
	// - hashed assets (/assets/*, worker files, etc.): immutable for a
	//   year; filename hash auto-busts on content change.
	// - robots.txt, favicon, etc.: same immutable rule — they're
	//   non-hashed but change rarely, and a hard-reload still clears
	//   them via Cache-Control: no-cache from the browser.
	setNoCacheHeaders := func(w http.ResponseWriter) {
		w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate, max-age=0")
		w.Header().Set("Pragma", "no-cache")
		w.Header().Set("Expires", "0")
	}
	fs := http.FileServer(http.Dir(staticDir))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		// Try to serve the file directly
		path := filepath.Join(staticDir, r.URL.Path)
		_, statErr := os.Stat(path)
		if os.IsNotExist(statErr) {
			// SPA fallback: serve index.html for client-side routing
			setNoCacheHeaders(w)
			http.ServeFile(w, r, filepath.Join(staticDir, "index.html"))
			return
		}
		// index.html must never be cached; hashed assets can be cached forever
		if r.URL.Path == "/" || r.URL.Path == "/index.html" {
			setNoCacheHeaders(w)
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
	// Middleware order (outer → inner):
	//   securityHeaders → CSRF check → gzip → mux
	// CSRF check has to see the request before mux dispatches; gzip wraps
	// only the inner handler so headers go on the un-compressed response.
	handler := withSecurityHeaders(withCSRFCheck(gzipMiddleware(mux)))
	// Protocol-level timeouts (slowloris defence). ReadHeaderTimeout caps
	// how long a client can drip-feed headers; ReadTimeout caps the whole
	// request including body (file uploads up to ~5 min); WriteTimeout
	// caps response generation (large list payloads + 100MB+ static
	// downloads); IdleTimeout drops kept-alive connections that go quiet.
	srv := &http.Server{
		Addr:              addr,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       5 * time.Minute,
		WriteTimeout:      5 * time.Minute,
		IdleTimeout:       2 * time.Minute,
	}

	// Graceful shutdown. On SIGTERM (Docker stop / Synology container
	// restart) or SIGINT (Ctrl-C in dev): cancel any active scan, stop
	// accepting new HTTP connections, drain in-flight requests for up to
	// 30s, then close the DB. The drain bound matters: long-running
	// endpoints (PDF extract, file upload) hold the connection, so we
	// cap shutdown so the container actually exits.
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)
	serverErrCh := make(chan error, 1)
	go func() {
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			serverErrCh <- err
		}
		close(serverErrCh)
	}()

	select {
	case err := <-serverErrCh:
		if err != nil {
			log.Fatalf("Server failed: %v", err)
		}
	case sig := <-sigCh:
		log.Printf("Received %s — shutting down (30s drain timeout)", sig)
		// Cancel active scan first so workers stop hitting the DB.
		scanner.StopScan()
		// Stop accepting new connections; let in-flight ones finish.
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if err := srv.Shutdown(shutdownCtx); err != nil {
			log.Printf("Graceful shutdown failed: %v (forcing close)", err)
			_ = srv.Close()
		}
		log.Print("Shutdown complete")
	}
}

// loadWatermarkTerms reads the pdf_watermark_terms config key (a JSON array of
// strings) and returns the parsed slice. Returns nil when the key is absent,
// empty, or unparseable — the indexer treats nil as "no filtering".
func loadWatermarkTerms(db *databank.DB) []string {
	raw, err := db.GetConfig("pdf_watermark_terms")
	if err != nil || raw == "" {
		return nil
	}
	var terms []string
	if err := json.Unmarshal([]byte(raw), &terms); err != nil {
		return nil
	}
	return terms
}
