package obd

import (
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

// newFixtureServer mimics the parts of openboarddata.org we actually
// touch: GET / serves the catalog table, GET /?a=generate&bpath=… serves
// an OBDATA_V002 file. Anything else is 404.
func newFixtureServer(t *testing.T) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Query().Get("a") {
		case "":
			body, _ := os.ReadFile("testdata/sample-index-root.html")
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
	sc.RequestDelay = 0
	idx, err := sc.SyncIndex()
	if err != nil {
		t.Fatalf("SyncIndex: %v", err)
	}
	// Real fixture lists 6 rows across 3 categories and 2 brands.
	if len(idx.Boards) != 6 {
		t.Fatalf("Boards len = %d, want 6 — got %v", len(idx.Boards), idx.Boards)
	}

	gotBpaths := map[string]IndexEntry{}
	for _, b := range idx.Boards {
		gotBpaths[b.Bpath] = b
	}
	want := map[string]struct{ category, brand string }{
		"consoles/microsoft/edmonton":    {"consoles", "microsoft"},
		"desktops/apple/820-3299":        {"desktops", "apple"},
		"laptops/apple/820-00045":        {"laptops", "apple"},
		"laptops/apple/820-00165":        {"laptops", "apple"},
		"phones/apple/iphone8_intel":     {"phones", "apple"},
		"phones/apple/iphone8_qualcomm":  {"phones", "apple"},
	}
	for bp, w := range want {
		got, ok := gotBpaths[bp]
		if !ok {
			t.Errorf("missing bpath %q", bp)
			continue
		}
		if got.Category != w.category || got.Brand != w.brand {
			t.Errorf("bpath %q: got category=%q brand=%q, want %q/%q",
				bp, got.Category, got.Brand, w.category, w.brand)
		}
	}
}

func TestScraper_DropGuard(t *testing.T) {
	srv := newFixtureServer(t)
	defer srv.Close()

	prev := &Index{Boards: make([]IndexEntry, 100)} // 100 prior boards; new will be 5 → ratio 0.05
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
	// Real openboarddata.org files start with HEADER_DATA_START; the
	// magic line is the second physical line. Only require it appears
	// somewhere in the head.
	if !strings.Contains(raw[:min(500, len(raw))], "OBDATA_V002") {
		t.Errorf("magic missing in head: %q", raw[:min(80, len(raw))])
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

// TestScraper_BpathExtraction verifies the regex against the actual
// shape used by openboarddata.org: unquoted href, no HTML escaping,
// bpath value terminated by `>` (the closing of the anchor tag).
func TestScraper_BpathExtraction(t *testing.T) {
	html := `<tr> <td><a href=?a=showboardsolutions&bpath=laptops/apple/820-00045>laptops/apple/820-00045</a></td><td><a target="_obddl" href=?a=generate&bpath=laptops/apple/820-00045>Download</a></td> </tr>
<tr> <td><a href=?a=showboardsolutions&bpath=laptops/apple/820-00165>laptops/apple/820-00165</a></td>
<a href="?a=showboardsolutions&amp;bpath=phones/apple/ipx_intel">x</a>
<a href="?a=other">unrelated</a>`
	got := extractBpaths(html)
	if len(got) != 3 {
		t.Fatalf("extractBpaths returned %d entries: %v", len(got), got)
	}
	for _, bp := range got {
		if strings.ContainsAny(bp, " <>\"") {
			t.Errorf("bpath %q contains tag noise — regex too greedy", bp)
		}
	}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
