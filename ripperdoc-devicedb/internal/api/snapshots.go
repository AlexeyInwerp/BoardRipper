package api

import (
	"errors"
	"net/http"
	"os"
	"strconv"
	"strings"

	"ripperdoc.de/devicedb/internal/snapshot"
	"ripperdoc.de/devicedb/internal/store"
)

// handleSnapshotLatest serves GET /v1/snapshots/latest — the signed manifest.
func (s *Server) handleSnapshotLatest(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSONError(w, &store.APIError{Code: "method_not_allowed", HTTP: 405})
		return
	}
	if s.Snapshots == nil {
		writeJSONError(w, &store.APIError{Code: "snapshots_disabled", HTTP: 503})
		return
	}
	man, err := s.Snapshots.LatestManifest()
	if err != nil {
		if errors.Is(err, snapshot.ErrNoSnapshot) {
			// Generate one on demand so a fresh server still has something
			// to hand a BoardRipper install.
			gen, err := s.Snapshots.Regenerate()
			if err != nil {
				writeJSONError(w, asAPIError(err))
				return
			}
			writeJSON(w, gen)
			return
		}
		writeJSONError(w, asAPIError(err))
		return
	}
	writeJSON(w, man)
}

// handleSnapshotTarball serves GET /v1/snapshots/{counter}/tarball.
func (s *Server) handleSnapshotTarball(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSONError(w, &store.APIError{Code: "method_not_allowed", HTTP: 405})
		return
	}
	if s.Snapshots == nil {
		writeJSONError(w, &store.APIError{Code: "snapshots_disabled", HTTP: 503})
		return
	}
	// Accept both URL shapes:
	//   /v1/snapshots/<counter>/tarball           (REST-style)
	//   /v1/snapshots/boards-<counter>.tar.gz     (static-file-style, what
	//                                              the manifest currently
	//                                              advertises)
	p := strings.TrimPrefix(r.URL.Path, "/v1/snapshots/")
	if p == "" || p == "latest" {
		writeJSONError(w, &store.APIError{Code: "not_found", HTTP: 404})
		return
	}
	var counter int
	var err error
	if strings.HasPrefix(p, "boards-") && strings.HasSuffix(p, ".tar.gz") {
		mid := strings.TrimSuffix(strings.TrimPrefix(p, "boards-"), ".tar.gz")
		counter, err = strconv.Atoi(mid)
		if err != nil {
			writeJSONError(w, &store.APIError{Code: "bad_counter", HTTP: 400})
			return
		}
	} else {
		parts := strings.SplitN(p, "/", 2)
		if len(parts) != 2 || parts[1] != "tarball" {
			writeJSONError(w, &store.APIError{Code: "not_found", HTTP: 404})
			return
		}
		counter, err = strconv.Atoi(parts[0])
		if err != nil {
			writeJSONError(w, &store.APIError{Code: "bad_counter", HTTP: 400})
			return
		}
	}
	path := s.Snapshots.TarballPath(counter)
	f, err := os.Open(path)
	if err != nil {
		writeJSONError(w, &store.APIError{Code: "not_found", HTTP: 404})
		return
	}
	defer f.Close()
	w.Header().Set("Content-Type", "application/octet-stream")
	st, _ := f.Stat()
	if st != nil {
		w.Header().Set("Content-Length", strconv.FormatInt(st.Size(), 10))
	}
	http.ServeContent(w, r, "boards.tar.gz", st.ModTime(), f)
}
