// Package api wires the HTTP routes for ripperdoc-devicedb.
//
// Two URL roots resolve to the same handler set:
//
//	/v1/...               — canonical, used by BoardRipper installs
//	/devicedb/api/v1/...  — user-friendly alias, used by the static
//	                        frontend under /devicedb/
//
// All API responses are JSON. Read endpoints are public and CORS-open;
// writes require an auth header (install-token or user-bearer).
package api

import (
	"net/http"
	"path"
	"strings"

	"ripperdoc.de/devicedb/internal/snapshot"
	"ripperdoc.de/devicedb/internal/store"
)

// Server bundles every dependency the handlers need.
type Server struct {
	Store           *store.Store
	Snapshots       *snapshot.Manager
	WebDir          string // static-files dir served at /devicedb/
	CORSAllowed     string // either "*" or a comma list
	RateLimits      *RateLimitState
}

// Routes returns a *http.ServeMux fully wired with all endpoints.
//
// `/v1/` is the canonical path. `/devicedb/api/v1/` is an alias served
// off the same mux entries — the muxAdapter handler rewrites the request
// URL before dispatch.
func (s *Server) Routes() http.Handler {
	mux := http.NewServeMux()

	// Read endpoints
	mux.HandleFunc("/v1/entities", s.handleEntities)
	mux.HandleFunc("/v1/entities/", s.handleEntityDetail)
	mux.HandleFunc("/v1/resolve", s.handleResolve)
	mux.HandleFunc("/v1/snapshots/latest", s.handleSnapshotLatest)
	mux.HandleFunc("/v1/snapshots/", s.handleSnapshotTarball) // /v1/snapshots/{counter}/tarball
	mux.HandleFunc("/v1/openapi.json", s.handleOpenAPI)
	mux.HandleFunc("/v1/health", s.handleHealth)

	// Write endpoints (auth required)
	mux.HandleFunc("/v1/contributions", s.handleContributions)
	mux.HandleFunc("/v1/contributions/", s.handleContributionDetail)
	mux.HandleFunc("/v1/installs/register", s.handleInstallRegister)
	mux.HandleFunc("/v1/users/register", s.handleUserRegister)

	// Admin (scope-gated)
	mux.HandleFunc("/v1/admin/contributions/queue", s.handleAdminQueue)
	mux.HandleFunc("/v1/admin/contributions/", s.handleAdminContributionAction)
	mux.HandleFunc("/v1/admin/contributors/", s.handleAdminContributorBlock)
	mux.HandleFunc("/v1/admin/snapshot/regenerate", s.handleAdminSnapshotRegen)

	// Static frontend at /devicedb/  (web/ dir; .gitkeep for now)
	if s.WebDir != "" {
		fs := http.FileServer(http.Dir(s.WebDir))
		mux.Handle("/devicedb/", http.StripPrefix("/devicedb/", fs))
	}

	// /devicedb/api/v1/ alias → rewrite to /v1/.
	root := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Top-level CORS + logging is applied above by wrap().
		const alias = "/devicedb/api/v1/"
		if strings.HasPrefix(r.URL.Path, alias) {
			r2 := *r
			u := *r.URL
			u.Path = "/v1/" + strings.TrimPrefix(r.URL.Path, alias)
			u.RawPath = ""
			r2.URL = &u
			mux.ServeHTTP(w, &r2)
			return
		}
		// "/" → redirect to /devicedb/ landing
		if r.URL.Path == "/" {
			http.Redirect(w, r, "/devicedb/", http.StatusFound)
			return
		}
		mux.ServeHTTP(w, r)
	})

	return s.wrap(root)
}

// wrap composes CORS + logging + recover middleware.
func (s *Server) wrap(next http.Handler) http.Handler {
	return logMiddleware(corsMiddleware(s.CORSAllowed, recoverMiddleware(next)))
}

// helper for /v1/snapshots/{counter}/tarball routing — used by handleSnapshotTarball.
func splitTarballPath(p string) (counter, tail string, ok bool) {
	// Expect /v1/snapshots/<counter>/tarball
	p = strings.TrimPrefix(p, "/v1/snapshots/")
	if p == "" {
		return "", "", false
	}
	parts := strings.SplitN(p, "/", 2)
	if len(parts) != 2 {
		return "", "", false
	}
	return parts[0], parts[1], true
}

// JoinURL joins a base URL and a path, normalising slashes.
func JoinURL(base, p string) string {
	return strings.TrimRight(base, "/") + path.Clean("/"+p)
}
