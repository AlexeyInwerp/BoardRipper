package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"boardripper/obd"
)

func newTestHandler(t *testing.T) (*ObdHandler, *obd.Store, *httptest.Server) {
	t.Helper()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Query().Get("a") {
		case "":
			b, _ := os.ReadFile("../obd/testdata/sample-index-root.html")
			w.Write(b)
		case "showboards":
			if r.URL.Query().Get("category") == "laptops" {
				b, _ := os.ReadFile("../obd/testdata/sample-index-laptops.html")
				w.Write(b)
				return
			}
			w.Write([]byte("empty"))
		case "generate":
			b, _ := os.ReadFile("../obd/testdata/sample.obd.txt")
			w.Write(b)
		default:
			http.NotFound(w, r)
		}
	}))
	store := obd.NewStore(t.TempDir())
	sc := obd.NewScraper(upstream.URL)
	sc.RequestDelay = 0
	return NewObdHandler(store, sc), store, upstream
}

func TestMatch_NoIndex(t *testing.T) {
	h, _, srv := newTestHandler(t)
	defer srv.Close()
	req := httptest.NewRequest("GET", "/api/obd/match?board_number=820-00045", nil)
	w := httptest.NewRecorder()
	h.Match(w, req)

	var out struct {
		Matches []obd.Match `json:"matches"`
	}
	json.NewDecoder(w.Body).Decode(&out)
	if len(out.Matches) != 0 {
		t.Errorf("expected no matches without index, got %v", out.Matches)
	}
}

func TestIndexSyncThenMatch(t *testing.T) {
	h, _, srv := newTestHandler(t)
	defer srv.Close()

	w := httptest.NewRecorder()
	h.IndexSync(w, httptest.NewRequest("POST", "/api/obd/index/sync", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("IndexSync code = %d, body = %q", w.Code, w.Body.String())
	}

	// Single-variant match.
	w = httptest.NewRecorder()
	h.Match(w, httptest.NewRequest("GET", "/api/obd/match?board_number=820-00045", nil))
	var single struct {
		Matches []obd.Match `json:"matches"`
		Index   IndexStatus `json:"index"`
	}
	json.NewDecoder(w.Body).Decode(&single)
	if len(single.Matches) != 1 || single.Matches[0].Fetched {
		t.Errorf("single match: %v", single.Matches)
	}
	if !single.Index.Synced || single.Index.BoardCount != 4 {
		t.Errorf("Index status = %+v", single.Index)
	}

	// Multi-variant match.
	w = httptest.NewRecorder()
	h.Match(w, httptest.NewRequest("GET", "/api/obd/match?board_number=iP7P", nil))
	var multi struct {
		Matches []obd.Match `json:"matches"`
		Index   IndexStatus `json:"index"`
	}
	json.NewDecoder(w.Body).Decode(&multi)
	if len(multi.Matches) != 2 {
		t.Errorf("multi match expected 2, got %v", multi.Matches)
	}

	// Empty board_number probe — should still return synced index status.
	w = httptest.NewRecorder()
	h.Match(w, httptest.NewRequest("GET", "/api/obd/match?board_number=", nil))
	var probe struct {
		Matches []obd.Match `json:"matches"`
		Index   IndexStatus `json:"index"`
	}
	json.NewDecoder(w.Body).Decode(&probe)
	if !probe.Index.Synced || len(probe.Matches) != 0 {
		t.Errorf("probe response = %+v / %v", probe.Index, probe.Matches)
	}
}

func TestFetch_RejectsUnknownBpath(t *testing.T) {
	h, _, srv := newTestHandler(t)
	defer srv.Close()

	// Sync first so index exists, then ask for an unknown bpath.
	wRec := httptest.NewRecorder()
	h.IndexSync(wRec, httptest.NewRequest("POST", "/api/obd/index/sync", nil))

	w := httptest.NewRecorder()
	h.Fetch(w, httptest.NewRequest("POST", "/api/obd/fetch?bpath=pwned/../../etc/passwd", nil))
	if w.Code != http.StatusBadRequest {
		t.Errorf("Fetch unknown bpath: code = %d, body = %q", w.Code, w.Body.String())
	}
}

func TestFetch_HappyPath(t *testing.T) {
	h, _, srv := newTestHandler(t)
	defer srv.Close()

	wRec := httptest.NewRecorder()
	h.IndexSync(wRec, httptest.NewRequest("POST", "/api/obd/index/sync", nil))

	w := httptest.NewRecorder()
	h.Fetch(w, httptest.NewRequest("POST", "/api/obd/fetch?bpath=laptops/apple/820-00045", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("Fetch: code = %d, body = %q", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "PP3V3_S0_REG") {
		t.Errorf("response missing expected net: %q", w.Body.String())
	}
}

func TestFetch_RejectsNonMagic(t *testing.T) {
	store := obd.NewStore(t.TempDir())

	// Pre-seed an index so the bpath is recognized.
	idx := &obd.Index{
		Source:   "x",
		SyncedAt: "2026-05-01T00:00:00Z",
		Boards:   []obd.IndexEntry{{Bpath: "laptops/apple/820-00045", Brand: "apple", Category: "laptops"}},
	}
	if err := store.WriteIndex(idx); err != nil {
		t.Fatalf("seed index: %v", err)
	}

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte("<html>not OBDATA</html>"))
	}))
	defer upstream.Close()

	h := NewObdHandler(store, obd.NewScraper(upstream.URL))
	w := httptest.NewRecorder()
	h.Fetch(w, httptest.NewRequest("POST", "/api/obd/fetch?bpath=laptops/apple/820-00045", nil))
	if w.Code != http.StatusBadGateway {
		t.Errorf("expected 502 on non-magic body, got %d", w.Code)
	}
}

func TestFetch_SingleFlight(t *testing.T) {
	h, _, srv := newTestHandler(t)
	defer srv.Close()
	wRec := httptest.NewRecorder()
	h.IndexSync(wRec, httptest.NewRequest("POST", "/api/obd/index/sync", nil))

	var wg sync.WaitGroup
	codes := make([]int, 5)
	for i := 0; i < 5; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			w := httptest.NewRecorder()
			h.Fetch(w, httptest.NewRequest("POST", "/api/obd/fetch?bpath=laptops/apple/820-00045", nil))
			codes[i] = w.Code
		}(i)
	}
	wg.Wait()
	for i, c := range codes {
		if c != http.StatusOK {
			t.Errorf("concurrent fetch %d code = %d", i, c)
		}
	}
}

func TestIndexSync_ConcurrentReturns409(t *testing.T) {
	h, _, srv := newTestHandler(t)
	defer srv.Close()

	// Force a slow scraper by pointing at a server that blocks until cancelled.
	hangDone := make(chan struct{})
	hang := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		<-hangDone // block until the test signals done
	}))
	t.Cleanup(func() {
		close(hangDone) // unblock all handler goroutines
		hang.Close()
	})
	sc := obd.NewScraper(hang.URL)
	sc.HTTPClient = &http.Client{} // no timeout
	h.scraper = sc

	go h.IndexSync(httptest.NewRecorder(), httptest.NewRequest("POST", "/api/obd/index/sync", nil))

	// Give the goroutine a moment to take the lock and start the HTTP call.
	for i := 0; i < 200; i++ {
		h.indexSyncMu.Lock()
		busy := h.indexSyncing
		h.indexSyncMu.Unlock()
		if busy {
			break
		}
		time.Sleep(time.Millisecond)
	}

	w := httptest.NewRecorder()
	h.IndexSync(w, httptest.NewRequest("POST", "/api/obd/index/sync", nil))
	if w.Code != http.StatusConflict {
		t.Errorf("second sync code = %d, want 409", w.Code)
	}
}

func TestCacheDelete(t *testing.T) {
	h, store, srv := newTestHandler(t)
	defer srv.Close()
	wRec := httptest.NewRecorder()
	h.IndexSync(wRec, httptest.NewRequest("POST", "/api/obd/index/sync", nil))
	h.Fetch(httptest.NewRecorder(), httptest.NewRequest("POST", "/api/obd/fetch?bpath=laptops/apple/820-00045", nil))

	w := httptest.NewRecorder()
	h.CacheDelete(w, httptest.NewRequest("DELETE", "/api/obd/cache", nil))
	if w.Code != http.StatusOK {
		t.Errorf("CacheDelete code = %d, body = %q", w.Code, w.Body.String())
	}
	idx, _ := store.ReadIndex()
	if idx != nil {
		t.Error("index.json should be gone after CacheDelete")
	}
}
