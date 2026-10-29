package pdfindex

// Large-index search measurement. Not run by default:
//
//	BR_SEARCH_BENCH=1 go test ./pdfindex/ -run TestSearchScaleMeasure -v -timeout 30m
//
// Builds a seeded schematic-like index (BR_SEARCH_BENCH_FILES × 100 pages,
// default 2,000 files = 200k pages) and times the pre-2026-10-29 ranked query
// against SearchFiles, unrestricted and donor-scoped. It reports numbers; it
// asserts only that SearchFiles stays inside its own deadline.

import (
	"context"
	"fmt"
	"math/rand"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestSearchScaleMeasure(t *testing.T) {
	if os.Getenv("BR_SEARCH_BENCH") == "" {
		t.Skip("set BR_SEARCH_BENCH=1 to run")
	}
	files := 2000
	if v, err := strconv.Atoi(os.Getenv("BR_SEARCH_BENCH_FILES")); err == nil && v > 0 {
		files = v
	}
	dir := os.Getenv("BR_SEARCH_BENCH_DIR")
	if dir == "" {
		dir = t.TempDir()
	}
	path := filepath.Join(dir, fmt.Sprintf("bench-%d.db", files))
	fresh := false
	if _, err := os.Stat(path); err != nil {
		fresh = true
	}
	db, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if fresh {
		start := time.Now()
		rng := rand.New(rand.NewSource(42))
		values := []string{"10UF", "25V", "0402", "100NF", "2.2K", "0603", "1UF", "16V", "4.7UF", "10K"}
		nets := []string{"PP3V3_S5", "SMC_RESET_L", "PPBUS_G3H", "PP1V8_AON", "GND", "USB_DP", "I2C_SCL"}
		words := []string{"connector", "regulator", "power", "reset", "clock", "sense", "enable", "battery"}
		for f := 1; f <= files; f++ {
			pages := make([]Page, 100)
			for p := range pages {
				var b strings.Builder
				for b.Len() < 1500 {
					switch rng.Intn(4) {
					case 0:
						fmt.Fprintf(&b, "C%d ", rng.Intn(9000)+1)
					case 1:
						b.WriteString(values[rng.Intn(len(values))] + " ")
					case 2:
						b.WriteString(nets[rng.Intn(len(nets))] + " ")
					default:
						fmt.Fprintf(&b, "%s U%d R%d ", words[rng.Intn(len(words))], rng.Intn(99)+1, rng.Intn(2000)+1)
					}
				}
				pages[p] = Page{Num: p + 1, Text: b.String()}
			}
			if err := db.ReplacePages(int64(f), pages); err != nil {
				t.Fatal(err)
			}
		}
		t.Logf("built %d files × 100 pages in %v", files, time.Since(start).Round(time.Second))
	}
	if st, err := os.Stat(path); err == nil {
		t.Logf("db size %d MB", st.Size()>>20)
	}

	ranked := func(q string, restrict []int64) (time.Duration, int) {
		pq := parseQuery(q)
		where := `pdf_text MATCH ?`
		args := []any{pq.fts}
		if len(restrict) > 0 {
			ph := make([]string, len(restrict))
			for i, id := range restrict {
				ph[i] = "?"
				args = append(args, id)
			}
			where += ` AND pdf_text.rowid IN (SELECT rowid FROM pdf_pages WHERE file_id IN (` + strings.Join(ph, ",") + `))`
		}
		args = append(args, 1000)
		start := time.Now()
		rows, err := db.reader.Query(`WITH ranked AS (
			SELECT pdf_text.rowid, rank, snippet(pdf_text, 0, '<b>', '</b>', '...', 32) AS snip
			FROM pdf_text WHERE `+where+` ORDER BY rank LIMIT ?)
			SELECT p.file_id, p.page_num, r.snip FROM ranked r JOIN pdf_pages p ON p.rowid = r.rowid ORDER BY r.rank`, args...)
		if err != nil {
			t.Fatal(err)
		}
		n := 0
		for rows.Next() {
			n++
		}
		rows.Close()
		return time.Since(start), n
	}
	scan := func(q string, restrict []int64) (time.Duration, time.Duration, SearchSummary) {
		start := time.Now()
		var first time.Duration
		sum, err := db.SearchFiles(context.Background(), q, restrict, SearchOptions{}, func(SearchHit) error {
			if first == 0 {
				first = time.Since(start)
			}
			return nil
		})
		if err != nil {
			t.Fatalf("SearchFiles(%q): %v", q, err)
		}
		return first, time.Since(start), sum
	}

	donors := make([]int64, 0, files)
	for i := 1; i <= files; i++ {
		donors = append(donors, int64(i))
	}
	t.Logf("%-16s %-6s %12s %12s %12s %8s %8s", "query", "scope", "old ranked", "new first", "new done", "files", "partial")
	for _, q := range []string{"10UF 25V", "PP3V3", "SMC_RESET_L", "U12", "10UF 25V 0402", "connector"} {
		for _, restrict := range [][]int64{nil, donors} {
			scope := "all"
			if restrict != nil {
				scope = "donor"
			}
			var old string
			if restrict != nil && os.Getenv("BR_SEARCH_BENCH_OLD_DONOR") == "" {
				old = "skipped" // minutes at this size; BR_SEARCH_BENCH_OLD_DONOR=1 to time it
			} else {
				d, _ := ranked(q, restrict)
				old = d.Round(time.Millisecond).String()
			}
			first, done, sum := scan(q, restrict)
			t.Logf("%-16s %-6s %12s %12s %12s %8d %8s", q, scope, old,
				first.Round(time.Millisecond), done.Round(time.Millisecond), len(sum.Order), sum.Reason)
			if done > 15*time.Second {
				t.Errorf("SearchFiles(%q, %s) took %v, past its own 10 s deadline", q, scope, done)
			}
		}
	}
}
