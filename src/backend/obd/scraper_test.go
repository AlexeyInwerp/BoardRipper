package obd

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
)

func newFixtureServer(t *testing.T) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Query().Get("a") {
		case "":
			body, _ := os.ReadFile("testdata/sample-index-root.html")
			w.Write(body)
		case "showboards":
			cat := r.URL.Query().Get("category")
			if cat != "laptops" {
				// Other categories return an empty list.
				w.Write([]byte("<html><body>empty</body></html>"))
				return
			}
			body, _ := os.ReadFile("testdata/sample-index-laptops.html")
			w.Write(body)
		case "generate":
			body, _ := os.ReadFile("testdata/sample.obd.txt")
			w.Write(body)
		default:
			http.NotFound(w, r)
		}
	})
	return httptest.NewServer(mux)
}

func TestScraper_BuildsIndex(t *testing.T) {
	srv := newFixtureServer(t)
	defer srv.Close()

	sc := NewScraper(srv.URL)
	sc.RequestDelay = 0 // speed up tests
	idx, err := sc.SyncIndex()
	if err != nil {
		t.Fatalf("SyncIndex: %v", err)
	}
	if len(idx.Boards) != 4 {
		t.Errorf("Boards len = %d, want 4 — got %v", len(idx.Boards), idx.Boards)
	}
	for _, b := range idx.Boards {
		if b.Brand != "apple" {
			t.Errorf("entry %v: brand = %q, want apple", b, b.Brand)
		}
		if b.Category != "laptops" {
			t.Errorf("entry %v: category = %q, want laptops", b, b.Category)
		}
	}
}

func TestScraper_DropGuard(t *testing.T) {
	srv := newFixtureServer(t)
	defer srv.Close()

	prev := &Index{Boards: make([]IndexEntry, 100)} // 100 prior boards
	sc := NewScraper(srv.URL)
	sc.RequestDelay = 0
	if _, err := sc.SyncIndexWithGuard(prev); err == nil || !strings.Contains(err.Error(), "drop guard") {
		t.Errorf("expected drop-guard error, got %v", err)
	}
}

func TestScraper_FetchBoard(t *testing.T) {
	srv := newFixtureServer(t)
	defer srv.Close()
	sc := NewScraper(srv.URL)

	raw, err := sc.FetchBoard("laptops/apple/820-00045")
	if err != nil {
		t.Fatalf("FetchBoard: %v", err)
	}
	if !strings.HasPrefix(raw, "OBDATA_V002") {
		t.Errorf("body does not start with magic: %q", raw[:min(40, len(raw))])
	}
}

func TestScraper_FetchBoard_RejectsNonMagic(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte("<html>404 page disguised as 200</html>"))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	sc := NewScraper(srv.URL)
	if _, err := sc.FetchBoard("laptops/apple/820-00045"); err == nil {
		t.Error("expected magic-line rejection, got nil")
	}
}

func TestScraper_BpathExtraction(t *testing.T) {
	html := `<a href="?a=showboardsolutions&bpath=laptops/apple/820-00045">x</a>
	         <a href="?a=showboardsolutions&amp;bpath=laptops/apple/820-00165">y</a>
	         <a href="?a=other">z</a>`
	got := extractBpaths(html)
	if len(got) != 2 {
		t.Errorf("extractBpaths: %v", got)
	}
}

// min available since Go 1.21; provide for older toolchains.
func min(a, b int) int { if a < b { return a }; return b }

// Compile-time check that url package is used (for future expansion).
var _ = url.URL{}
