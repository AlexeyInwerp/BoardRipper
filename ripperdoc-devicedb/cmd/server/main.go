// ripperdoc-devicedb server binary.
//
// Boots:
//   1. open / migrate canonical SQLite DB at DATA_DIR/devicedb.sqlite
//   2. seed from SEED_DB_PATH (or /seed/boards.db) once if seed_state.seeded=0
//   3. construct snapshot manager (signing key from SNAPSHOT_PRIVATE_KEY_PATH
//      or ephemeral dev key with a warning)
//   4. wire HTTP routes (canonical + /devicedb/ alias + static frontend)
//   5. listen on LISTEN_ADDR (default :8090)
package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"ripperdoc.de/devicedb/internal/api"
	"ripperdoc.de/devicedb/internal/snapshot"
	"ripperdoc.de/devicedb/internal/store"
)

func main() {
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)
	log.SetPrefix("")

	addr := envOr("LISTEN_ADDR", ":8090")
	dataDir := envOr("DATA_DIR", "./data")
	seedPath := envOr("SEED_DB_PATH", "/seed/boards.db")
	webDir := envOr("WEB_DIR", "./web")
	cors := envOr("CORS_ALLOWED_ORIGINS", "*")
	snapKeyPath := os.Getenv("SNAPSHOT_PRIVATE_KEY_PATH")
	tarballURL := envOr("SNAPSHOT_TARBALL_BASE_URL", "http://localhost:8090/v1/snapshots")

	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		log.Fatalf("[devicedb] mkdir %s: %v", dataDir, err)
	}

	dbPath := filepath.Join(dataDir, "devicedb.sqlite")
	s, err := store.Open(dbPath)
	if err != nil {
		log.Fatalf("[devicedb] open store: %v", err)
	}
	defer s.Close()

	if err := s.SeedIfNeeded(seedPath); err != nil {
		log.Printf("[devicedb] [seed] WARNING: %v", err)
	}

	snapDir := filepath.Join(dataDir, "snapshots")
	snapMgr, err := snapshot.NewManager(s, snapDir, tarballURL, snapKeyPath)
	if err != nil {
		log.Fatalf("[devicedb] snapshot manager: %v", err)
	}

	server := &api.Server{
		Store:       s,
		Snapshots:   snapMgr,
		WebDir:      webDir,
		CORSAllowed: cors,
		RateLimits:  api.NewRateLimitState(),
	}

	srv := &http.Server{
		Addr:              addr,
		Handler:           server.Routes(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	// Graceful shutdown on SIGINT/SIGTERM.
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	go func() {
		log.Printf("[devicedb] listening on %s (data=%s, web=%s)", addr, dataDir, webDir)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("[devicedb] listen: %v", err)
		}
	}()

	<-ctx.Done()
	log.Printf("[devicedb] shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = srv.Shutdown(shutdownCtx)
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
