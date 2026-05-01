package handlers

import (
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"time"

	"boardripper/obd"
)

// ObdHandler serves /api/obd/* endpoints.
type ObdHandler struct {
	store   *obd.Store
	scraper *obd.Scraper

	// indexSyncing single-flights /api/obd/index/sync.
	indexSyncing bool
	indexSyncMu  sync.Mutex

	// fetchInflight single-flights /api/obd/fetch per bpath. Each entry
	// is a channel that closes when the fetch completes.
	fetchInflight map[string]chan struct{}
	fetchMu       sync.Mutex
}

// NewObdHandler wires a handler against the given store and scraper.
// If store is nil, all endpoints return 503 — used when the library
// has no library_root configured.
func NewObdHandler(store *obd.Store, scraper *obd.Scraper) *ObdHandler {
	return &ObdHandler{
		store:         store,
		scraper:       scraper,
		fetchInflight: make(map[string]chan struct{}),
	}
}

func (h *ObdHandler) requireLibrary(w http.ResponseWriter) bool {
	if h.store == nil {
		http.Error(w, "library_dir not configured", http.StatusServiceUnavailable)
		return false
	}
	return true
}

// writeJSON serializes v as JSON to the response. The encode error is
// intentionally discarded — by the time it could fire, the 200 status
// line has already been flushed and there is no useful recovery path.
func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

// IndexSync runs a synchronous scrape and writes index.json. Single-flight.
func (h *ObdHandler) IndexSync(w http.ResponseWriter, r *http.Request) {
	if !h.requireLibrary(w) {
		return
	}
	h.indexSyncMu.Lock()
	if h.indexSyncing {
		h.indexSyncMu.Unlock()
		http.Error(w, "sync already in progress", http.StatusConflict)
		return
	}
	h.indexSyncing = true
	h.indexSyncMu.Unlock()
	defer func() {
		h.indexSyncMu.Lock()
		h.indexSyncing = false
		h.indexSyncMu.Unlock()
	}()

	prev, _ := h.store.ReadIndex() // nil on first sync — guard tolerates this
	idx, err := h.scraper.SyncIndexWithGuard(prev)
	if err != nil {
		http.Error(w, "scrape failed: "+err.Error(), http.StatusBadGateway)
		return
	}
	if err := h.store.WriteIndex(idx); err != nil {
		http.Error(w, "write index.json: "+err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]any{
		"synced_at":   idx.SyncedAt,
		"board_count": len(idx.Boards),
	})
}

// IndexStatus is included in every Match response so the frontend can
// know whether index.json exists and when it was last synced without a
// separate round trip.
type IndexStatus struct {
	Synced     bool   `json:"synced"`
	SyncedAt   string `json:"synced_at,omitempty"`
	BoardCount int    `json:"board_count"`
}

// Match returns matching index entries for a board's board_number.
// The Index field is always populated so the frontend can refresh
// index status by calling this endpoint with empty board_number.
func (h *ObdHandler) Match(w http.ResponseWriter, r *http.Request) {
	if !h.requireLibrary(w) {
		return
	}
	bn := normalizeForMatch(r.URL.Query().Get("board_number"))
	out := struct {
		Matches []obd.Match `json:"matches"`
		Index   IndexStatus `json:"index"`
	}{Matches: []obd.Match{}}

	idx, err := h.store.ReadIndex()
	if err == nil && idx != nil {
		out.Index = IndexStatus{Synced: true, SyncedAt: idx.SyncedAt, BoardCount: len(idx.Boards)}
	}

	if bn == "" || idx == nil {
		writeJSON(w, out)
		return
	}
	for _, e := range idx.Boards {
		leaf := e.Bpath
		if i := strings.LastIndex(leaf, "/"); i >= 0 {
			leaf = leaf[i+1:]
		}
		if !strings.Contains(normalizeForMatch(leaf), bn) {
			continue
		}
		fetched, fetchedAt := h.store.IsFetched(e.Bpath)
		out.Matches = append(out.Matches, obd.Match{
			Bpath:     e.Bpath,
			Brand:     e.Brand,
			Category:  e.Category,
			Fetched:   fetched,
			FetchedAt: fetchedAt,
		})
	}
	writeJSON(w, out)
}

// normalizeForMatch lowercases and strips spaces and dashes.
func normalizeForMatch(s string) string {
	s = strings.ToLower(s)
	s = strings.ReplaceAll(s, " ", "")
	s = strings.ReplaceAll(s, "-", "")
	return s
}

// Fetch downloads and parses one bpath. Single-flight per bpath.
func (h *ObdHandler) Fetch(w http.ResponseWriter, r *http.Request) {
	if !h.requireLibrary(w) {
		return
	}
	bpath := r.URL.Query().Get("bpath")
	if bpath == "" {
		http.Error(w, "bpath query param required", http.StatusBadRequest)
		return
	}
	idx, err := h.store.ReadIndex()
	if err != nil || idx == nil {
		http.Error(w, "no index synced; sync first", http.StatusBadRequest)
		return
	}
	known := false
	for _, e := range idx.Boards {
		if e.Bpath == bpath {
			known = true
			break
		}
	}
	if !known {
		http.Error(w, "bpath not in index", http.StatusBadRequest)
		return
	}

	// Single-flight per bpath.
	h.fetchMu.Lock()
	ch, inflight := h.fetchInflight[bpath]
	if !inflight {
		ch = make(chan struct{})
		h.fetchInflight[bpath] = ch
	}
	h.fetchMu.Unlock()

	if inflight {
		<-ch
		// Re-read the cache the leader wrote. If the leader failed,
		// the cache may still be empty; report through ReadParsed.
		parsed, perr := h.store.ReadParsed(bpath)
		if perr != nil || parsed == nil {
			http.Error(w, "concurrent fetch failed", http.StatusBadGateway)
			return
		}
		writeJSON(w, parsed)
		return
	}

	// We're the leader.
	defer func() {
		h.fetchMu.Lock()
		delete(h.fetchInflight, bpath)
		close(ch)
		h.fetchMu.Unlock()
	}()

	raw, err := h.scraper.FetchBoard(bpath)
	if err != nil {
		http.Error(w, "fetch upstream: "+err.Error(), http.StatusBadGateway)
		return
	}
	parsed, err := obd.Parse(raw)
	if err != nil {
		http.Error(w, "parse: "+err.Error(), http.StatusBadGateway)
		return
	}
	parsed.Bpath = bpath
	parsed.SourceURL = h.scraper.BaseURL + "/?a=showboardsolutions&bpath=" + bpath
	parsed.FetchedAt = time.Now().UTC().Format(time.RFC3339)

	if err := h.store.WriteBoard(bpath, raw, parsed); err != nil {
		http.Error(w, "write cache: "+err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, parsed)
}

// Data returns the cached parsed payload for one bpath without
// touching the network. 404 if not cached. Used by the BoardViewer
// flow to surface OBD readings in tooltips and the ComponentInfoPanel
// without re-hitting openboarddata.org on every board open.
func (h *ObdHandler) Data(w http.ResponseWriter, r *http.Request) {
	if !h.requireLibrary(w) {
		return
	}
	bpath := r.URL.Query().Get("bpath")
	if bpath == "" {
		http.Error(w, "bpath query param required", http.StatusBadRequest)
		return
	}
	parsed, err := h.store.ReadParsed(bpath)
	if err != nil {
		http.Error(w, "read cache: "+err.Error(), http.StatusInternalServerError)
		return
	}
	if parsed == nil {
		http.Error(w, "not cached", http.StatusNotFound)
		return
	}
	writeJSON(w, parsed)
}

// CacheDelete wipes the entire OBD cache.
func (h *ObdHandler) CacheDelete(w http.ResponseWriter, r *http.Request) {
	if !h.requireLibrary(w) {
		return
	}
	if err := h.store.DeleteCache(); err != nil {
		http.Error(w, "delete cache: "+err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]string{"status": "ok"})
}
