package pdfindex

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func TestSearchPages(t *testing.T) {
	db := openTestDB(t)
	db.Claim(1, "pdfium")
	db.UpsertPages(1, []Page{{1, "STM32 usb connector"}, {2, "power rail"}})
	db.Finalize(1)
	db.Claim(2, "pdfium")
	db.UpsertPages(2, []Page{{1, "usb hub only"}})
	db.Finalize(2)

	hits, err := db.SearchPages(context.Background(), "usb", nil, 100)
	if err != nil {
		t.Fatalf("SearchPages: %v", err)
	}
	if len(hits) != 2 {
		t.Errorf("want 2 hits for 'usb', got %d", len(hits))
	}

	if len(hits) > 0 && !strings.Contains(hits[0].Snippet, "<b>") {
		t.Errorf("snippet should contain <b> highlight, got %q", hits[0].Snippet)
	}

	hits2, _ := db.SearchPages(context.Background(), "usb", []int64{2}, 100)
	if len(hits2) != 1 || hits2[0].FileID != 2 {
		t.Errorf("donor-scoped want [file 2], got %+v", hits2)
	}
}

// A partial part number must match longer variants via prefix matching:
// searching "AOZ5332" must find the token "AOZ5332QI".
func TestSearchPrefixMatchesPartNumberVariants(t *testing.T) {
	db := openTestDB(t)
	db.Claim(1, "pdfium")
	db.UpsertPages(1, []Page{{1, "buck regulator AOZ5332QI 3A"}})
	db.Finalize(1)
	db.Claim(2, "pdfium")
	db.UpsertPages(2, []Page{{1, "buck regulator AOZ5332DI 5A"}})
	db.Finalize(2)

	full, _ := db.SearchPages(context.Background(), "AOZ5332QI", nil, 100)
	if len(full) != 1 {
		t.Errorf("exact 'AOZ5332QI' want 1, got %d", len(full))
	}
	// The partial query must match BOTH variants (more results, not fewer).
	partial, _ := db.SearchPages(context.Background(), "AOZ5332", nil, 100)
	if len(partial) != 2 {
		t.Errorf("prefix 'AOZ5332' should match both QI and DI variants, want 2, got %d", len(partial))
	}
}

func indexPages(t *testing.T, db *DB, fileID int64, texts ...string) {
	t.Helper()
	pages := make([]Page, len(texts))
	for i, s := range texts {
		pages[i] = Page{Num: i + 1, Text: s}
	}
	if err := db.ReplacePages(fileID, pages); err != nil {
		t.Fatal(err)
	}
}

func collect(t *testing.T, db *DB, q string, restrict []int64, opt SearchOptions) ([]SearchHit, SearchSummary) {
	t.Helper()
	var hits []SearchHit
	sum, err := db.SearchFiles(context.Background(), q, restrict, opt, func(h SearchHit) error {
		hits = append(hits, h)
		return nil
	})
	if err != nil {
		t.Fatalf("SearchFiles(%q): %v", q, err)
	}
	return hits, sum
}

// One hit per file, at its first matching page, with exact per-file counts.
func TestSearchFilesOneRowPerFileWithCounts(t *testing.T) {
	db := openTestDB(t)
	indexPages(t, db, 1, "intro", "PP3V3_S5 rail", "PP3V3_S5 again", "nothing")
	indexPages(t, db, 2, "PP3V3_G3H here")
	hits, sum := collect(t, db, "pp3v3", nil, SearchOptions{})
	if len(hits) != 2 || sum.Partial {
		t.Fatalf("hits = %+v partial=%v, want 2 complete", hits, sum.Partial)
	}
	if hits[0].FileID != 1 || hits[0].PageNum != 2 {
		t.Errorf("file 1 first hit = %+v, want page 2", hits[0])
	}
	if sum.Counts[1] != 2 || sum.Counts[2] != 1 {
		t.Errorf("counts = %v, want 1:2 2:1", sum.Counts)
	}
	if !strings.Contains(hits[0].Snippet, "<b>PP3V3</b>") {
		t.Errorf("snippet = %q, want the match bolded", hits[0].Snippet)
	}
}

// The file cap stops new rows and says so; the deadline does too.
func TestSearchFilesCapsArePartial(t *testing.T) {
	db := openTestDB(t)
	for i := int64(1); i <= 10; i++ {
		indexPages(t, db, i, "10UF 25V 0402")
	}
	hits, sum := collect(t, db, "10uf 25v", nil, SearchOptions{MaxFiles: 3})
	if len(hits) != 3 || !sum.Partial || sum.Reason != "files" {
		t.Fatalf("hits=%d partial=%v reason=%q, want 3 / true / files", len(hits), sum.Partial, sum.Reason)
	}
	_, sum = collect(t, db, "10uf", nil, SearchOptions{MaxPages: 4})
	if !sum.Partial || sum.Reason != "pages" || sum.Pages != 4 {
		t.Fatalf("page cap: %+v", sum)
	}
}

// One-character terms are dropped; a query of only those is refused.
func TestSearchFilesShortTerms(t *testing.T) {
	db := openTestDB(t)
	indexPages(t, db, 1, "C 12 capacitor")
	if _, err := db.SearchFiles(context.Background(), "C", nil, SearchOptions{}, func(SearchHit) error { return nil }); !errors.Is(err, ErrQueryTooShort) {
		t.Fatalf("err = %v, want ErrQueryTooShort", err)
	}
	hits, sum := collect(t, db, "C capacitor", nil, SearchOptions{})
	if len(hits) != 1 || len(sum.Ignored) != 1 || sum.Ignored[0] != "C" {
		t.Fatalf("hits=%d ignored=%v, want 1 hit and C ignored", len(hits), sum.Ignored)
	}
	// "SMC_RESET_L" has a one-letter token but a long term overall: kept.
	indexPages(t, db, 2, "SMC_RESET_L asserted")
	hits, _ = collect(t, db, "SMC_RESET_L", nil, SearchOptions{})
	if len(hits) != 1 || hits[0].FileID != 2 {
		t.Fatalf("SMC_RESET_L hits = %+v", hits)
	}
}

// Donor scope filters after the FTS5 scan (no per-rowid probe).
func TestSearchFilesRestrict(t *testing.T) {
	db := openTestDB(t)
	indexPages(t, db, 1, "usb hub")
	indexPages(t, db, 2, "usb connector")
	indexPages(t, db, 3, "usb phy")
	hits, _ := collect(t, db, "usb", []int64{3, 1}, SearchOptions{})
	if len(hits) != 2 || hits[0].FileID != 1 || hits[1].FileID != 3 {
		t.Fatalf("restricted hits = %+v, want files 1 and 3", hits)
	}
}

// A cancelled caller stops the search and gets the context error back.
func TestSearchFilesCancelled(t *testing.T) {
	db := openTestDB(t)
	indexPages(t, db, 1, "usb")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := db.SearchFiles(ctx, "usb", nil, SearchOptions{}, func(SearchHit) error { return nil })
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
}

// The plan must drive from the FTS5 index in rowid order and never sort: a
// temp b-tree here is the old cost (every match scored or probed).
func TestSearchFilesQueryPlan(t *testing.T) {
	db := openTestDB(t)
	indexPages(t, db, 1, "usb")
	for _, restrict := range []bool{false, true} {
		q := `EXPLAIN QUERY PLAN SELECT p.rowid, p.file_id, p.page_num
			FROM pdf_text CROSS JOIN pdf_pages AS p ON p.rowid = pdf_text.rowid
			WHERE pdf_text MATCH ?1 AND pdf_text.rowid > ?2`
		args := []any{`"usb"*`, 0}
		if restrict {
			q += ` AND p.file_id IN (SELECT value FROM json_each(?3))`
			args = append(args, "[1]")
		}
		q += ` ORDER BY pdf_text.rowid LIMIT 2000`
		rows, err := db.reader.Query(q, args...)
		if err != nil {
			t.Fatal(err)
		}
		var plan []string
		for rows.Next() {
			var id, parent, notused int
			var detail string
			rows.Scan(&id, &parent, &notused, &detail)
			plan = append(plan, detail)
		}
		rows.Close()
		joined := strings.Join(plan, " | ")
		t.Logf("restrict=%v plan: %s", restrict, joined)
		if strings.Contains(joined, "TEMP B-TREE") || !strings.HasPrefix(plan[0], "SCAN pdf_text") {
			t.Errorf("restrict=%v plan: %s", restrict, joined)
		}
	}
}

func TestMakeSnippet(t *testing.T) {
	text := "alpha beta gamma\n\n  delta PP3V3_S5 epsilon"
	got := makeSnippet(text, []string{"pp3v3"}, 32)
	if got != "alpha beta gamma delta <b>PP3V3</b>_S5 epsilon" {
		t.Errorf("snippet = %q", got)
	}
	long := strings.Repeat("word ", 50) + "TARGET " + strings.Repeat("tail ", 50)
	got = makeSnippet(long, []string{"target"}, 32)
	if !strings.HasPrefix(got, "...") || !strings.HasSuffix(got, "...") || !strings.Contains(got, "<b>TARGET</b>") {
		t.Errorf("windowed snippet = %q", got)
	}
}
