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
	"runtime/debug"
	"strconv"
	"strings"
	"syscall"
	"time"

	"encoding/json"

	"boardripper/boarddb"
	"boardripper/databank"
	"boardripper/handlers"
	"boardripper/librarysync"
	"boardripper/mcpserver"
	"boardripper/obd"
	"boardripper/pdfindex"
	"boardripper/updater"
)

// configureMemoryLimit sets Go's soft memory limit (GOMEMLIMIT) from the
// container's cgroup memory limit when one is enforced and the operator hasn't
// set GOMEMLIMIT explicitly. Without it the runtime has no notion of its budget:
// freed heap lingers in RSS and, near a hard cgroup cap, the process is
// OOM-killed instead of GCing harder first. It's a SOFT limit — the GC works
// harder to stay under it but never kills — so it's safe to derive
// automatically. Paired with GODEBUG=madvdontneed=1 (set in the Dockerfile),
// which returns the freed pages to the OS promptly. The wasm/pdfium linear
// memory is Go-heap-backed and counts toward this limit, so it's capped
// per-worker (see pdfindex) to keep the GC from thrashing against a pinned floor.
func configureMemoryLimit() {
	if os.Getenv("GOMEMLIMIT") != "" {
		return // explicit override already applied by the runtime at startup
	}
	limit, ok := cgroupMemoryLimit()
	if !ok {
		return // unlimited or undetectable — leave the runtime default
	}
	// Leave headroom below the hard cgroup cap for non-heap allocations
	// (goroutine stacks, runtime metadata) so GC pressure kicks in before OOM.
	soft := int64(float64(limit) * 0.9)
	debug.SetMemoryLimit(soft)
	log.Printf("GOMEMLIMIT set to %d MiB (90%% of cgroup limit %d MiB)", soft>>20, limit>>20)
}

// cgroupMemoryLimit returns the enforced memory limit in bytes, or ok=false when
// the container is unlimited/undetectable. Handles cgroup v2 (memory.max) and
// v1 (memory.limit_in_bytes), rejecting the "unlimited" sentinels each reports.
func cgroupMemoryLimit() (int64, bool) {
	// cgroup v2
	if b, err := os.ReadFile("/sys/fs/cgroup/memory.max"); err == nil {
		s := strings.TrimSpace(string(b))
		if s == "max" {
			return 0, false
		}
		if v, err := strconv.ParseInt(s, 10, 64); err == nil {
			return v, plausibleMemLimit(v)
		}
	}
	// cgroup v1
	if b, err := os.ReadFile("/sys/fs/cgroup/memory/memory.limit_in_bytes"); err == nil {
		if v, err := strconv.ParseInt(strings.TrimSpace(string(b)), 10, 64); err == nil {
			return v, plausibleMemLimit(v)
		}
	}
	return 0, false
}

// plausibleMemLimit rejects the near-maxint "unlimited" sentinels cgroups report
// so we never clamp to a meaningless value. Anything ≥ 64 GiB is treated as
// effectively unlimited for this container.
func plausibleMemLimit(v int64) bool {
	const maxPlausible = int64(64) << 30
	return v > 0 && v < maxPlausible
}

func main() {
	// Derive a soft GOMEMLIMIT from the cgroup cap before any allocation-heavy
	// work (DB open, board index) so the GC budget is in force from the start.
	configureMemoryLimit()

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
	// Record the boards.db path so the scanner can fingerprint it (mtime+size)
	// and skip re-resolving unchanged files unless the reference DB or resolver
	// logic changed. bdb is nil when boards.db is absent; the path is still
	// harmless (stat fails → empty data fingerprint).
	scanner.SetBoardDBPath(boardDBPath)

	// PDF-index migration (v0→v1) runs against databank.db before opening the
	// separate index DB. Only the FAST half runs here (create pdf_donors);
	// failure is fatal (the PDF handlers need that table). Dropping the legacy
	// FTS5 tables is deferred to a background goroutine (launched below) so a
	// large legacy index can't block /api/health past the updater's 60s
	// healthcheck — that was the v0.31.0/v0.31.1 "update failed" rollback.
	if err := db.MigratePdfIndexV1(); err != nil {
		log.Fatalf("pdf-index migration failed: %v", err)
	}
	// Background, off the boot path: reclaim the legacy in-process PDF-index
	// tables. Idempotent + self-skipping, so a crash mid-drop just retries next
	// boot. Errors are logged, never fatal — leftover dead tables are harmless.
	go func() {
		if err := db.CleanupLegacyPdfTables(); err != nil {
			log.Printf("WARNING: legacy PDF-index cleanup failed (%v) — retrying next boot", err)
		}
	}()
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
	fileHandler := handlers.NewFileHandler(dataDir, scanner.ScanRoot, scanner.ExtractMetadata, scanner.IndexFile)
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
	// /files/stream is a literal segment so it wins over /files/{id} on Go 1.22+
	// ServeMux precedence — long-lived NDJSON stream, no read() wrapper so the
	// per-request deadline doesn't truncate a slow client mid-flight.
	mux.HandleFunc("GET /api/databank/files/stream", dbHandler.ListFilesStream)
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
	mux.HandleFunc("GET /api/databank/donors/export", read(dbHandler.ExportDonors))
	mux.HandleFunc("POST /api/databank/donors/import", write(dbHandler.ImportDonors))
	mux.HandleFunc("GET /api/databank/donors/backups", read(dbHandler.ListDonorBackups))
	mux.HandleFunc("POST /api/databank/donors/restore", write(dbHandler.RestoreDonors))

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

			// Wire the scanner → pdfindex re-queue path: when a PDF file's
			// size or mod_time changes vs the stored row, the scanner flips
			// its pdf_index_status back to 'pending' so the next indexer run
			// re-extracts text from the new bytes. Captures pdfIndex by
			// reference; safe to call concurrently with scans.
			scanner.SetPdfModifiedHook(func(fileID int64) error {
				return pdfIndex.MarkPending(fileID)
			})
			// Symmetric drop: when the Phase-4 prune removes a file that
			// vanished from disk, drop its rows in the separate pdfindex.db too
			// (pdf_pages + pdf_index_status) so they don't leak.
			scanner.SetPdfDeleteHook(func(id int64) error {
				return pdfIndex.DeleteFile(id)
			})
			// Cascade a full databank wipe (POST /api/databank/reset) to
			// pdfindex.db as well, so a reset doesn't leave orphaned pages/FTS
			// rows that later mis-attribute snippets to reused file ids.
			dbHandler.SetPdfIndexReset(pdfIndex.ResetAll)
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
			// Bare (no read() wrapper): read()'s 30s context deadline + the wrapper
			// chain would interfere with incremental per-row Flush()es. Same pattern
			// as other no-wrap handlers (e.g. dbHandler.PreviewGet).
			mux.HandleFunc("GET /api/databank/search/stream", pdfIdxHandler.SearchStream)
			mux.HandleFunc("POST /api/databank/reset-pdf", write(pdfIdxHandler.ResetPdf))

			// Donors: server-side index trigger + status enrichment, and a
			// one-time background backfill of any donor not yet indexed.
			// Runs regardless of pdf_index_auto_run (donors must be searchable)
			// and off the boot path so it never delays /api/health.
			donorIdx := handlers.NewPdfDonorIndexer(indexer, pdfIndex)
			dbHandler.SetDonorIndexer(donorIdx)
			go func() {
				ids, err := db.DonorFileIDs()
				if err != nil {
					log.Printf("donor backfill: list donors: %v", err)
					return
				}
				if len(ids) > 0 {
					log.Printf("donor backfill: ensuring %d donor(s) indexed", len(ids))
					donorIdx.EnsureIndexed(ids)
				}
			}()

			if v, _ := db.GetConfig("pdf_index_auto_run"); v == "true" {
				go func() {
					log.Println("pdfindex: auto-run enabled — starting bulk sweep")
					_ = indexer.Run()
				}()
			}
		}
	}

	// --- MCP server (off by default; enabled via Settings ▸ Integrations) ---
	mcpSecret, err := mcpserver.EnsureSecret(dataDir)
	if err != nil {
		log.Fatalf("mcp secret: %v", err)
	}
	mcpState := mcpserver.NewState(db)
	mcpBridge := mcpserver.NewBridge()
	mcpDeps := &mcpserver.Deps{
		State:  mcpState,
		Bridge: mcpBridge,
		Files:  db,
		Boards: bdb,
		OBD:    obdStore,
		FileBytes: func(ctx context.Context, id int64) ([]byte, string, string, error) {
			rec, err := db.GetFileByID(ctx, id)
			if err != nil || rec == nil {
				return nil, "", "", fmt.Errorf("file %d not found", id)
			}
			if rec.Size > mcpserver.MaxDownloadBytes {
				return nil, "", "", fmt.Errorf("file too large: %d bytes", rec.Size)
			}
			data, err := handlers.ReadFileEager(scanner.ScanRoot(), rec.Path)
			if err != nil {
				return nil, "", "", err
			}
			return data, rec.Filename, mcpserver.MimeForExt(rec.Extension), nil
		},
	}
	if pdfIndex != nil {
		mcpDeps.PDF = pdfIndex // avoid typed-nil in the PDFSearcher interface
	}
	mcpSrv := mcpserver.New(mcpDeps)
	mcpOAuth := mcpserver.NewOAuth()
	mux.Handle("/api/mcp", mcpserver.GateAuto(mcpState, mcpSecret, mcpOAuth, mcpSrv.Handler()))
	mux.Handle("/api/mcp/", mcpserver.GateAuto(mcpState, mcpSecret, mcpOAuth, mcpSrv.Handler()))
	// Bridge is authenticated + gated inside ServeWS: 404 when MCP is off, and
	// the first frame must carry the per-install MCP secret (M14).
	mux.Handle("/api/mcp/bridge", mcpBridge.ServeWS(mcpState, mcpSecret))
	mux.HandleFunc("GET /api/mcp/status", mcpserver.StatusHandler(mcpState, mcpBridge, mcpSrv))
	mux.HandleFunc("GET /api/mcp/token", mcpserver.TokenHandler(mcpState, mcpSecret))
	mux.HandleFunc("POST /api/mcp/selftest", mcpserver.SelfTestHandler(mcpState, mcpSrv))
	// OAuth 2.1 onboarding: discovery + the embedded authorization server. Every
	// endpoint (discovery, dynamic registration, authorize, token) is gated by
	// GateOAuth so it returns 404 unless MCP is enabled AND mcp_auth_mode=oauth —
	// invisible when the feature is off or the deployment uses static-token auth
	// (L6). Discovery is unauthenticated (clients fetch it pre-auth); the
	// more-specific patterns win over the /api/mcp/ subtree.
	mux.HandleFunc("GET /.well-known/oauth-protected-resource", mcpserver.GateOAuth(mcpState, mcpOAuth.ProtectedResourceMetadata))
	mux.HandleFunc("GET /.well-known/oauth-authorization-server", mcpserver.GateOAuth(mcpState, mcpOAuth.AuthServerMetadata))
	mux.HandleFunc("GET /api/mcp/oauth/jwks", mcpserver.GateOAuth(mcpState, mcpOAuth.JWKS))
	mux.HandleFunc("POST /api/mcp/oauth/register", mcpserver.GateOAuth(mcpState, mcpOAuth.Register))
	mux.HandleFunc("/api/mcp/oauth/authorize", mcpserver.GateOAuth(mcpState, mcpOAuth.Authorize))
	mux.HandleFunc("POST /api/mcp/oauth/token", mcpserver.GateOAuth(mcpState, mcpOAuth.Token))

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
