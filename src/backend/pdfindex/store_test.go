package pdfindex

import (
	"path/filepath"
	"sync"
	"testing"
)

func openTestDB(t *testing.T) *DB {
	t.Helper()
	db, err := Open(filepath.Join(t.TempDir(), "pdfindex.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

func TestClaimIsExclusive(t *testing.T) {
	db := openTestDB(t)
	won, err := db.Claim(42, "pdfium")
	if err != nil || !won {
		t.Fatalf("first claim: won=%v err=%v", won, err)
	}
	won2, err := db.Claim(42, "pdfjs")
	if err != nil {
		t.Fatalf("second claim err: %v", err)
	}
	if won2 {
		t.Errorf("second claim should have lost (row is 'indexing')")
	}
	st, err := db.Status(42)
	if err != nil {
		t.Fatalf("Status: %v", err)
	}
	if st.Status != "indexing" || st.Source != "pdfium" {
		t.Errorf("got status=%q source=%q, want indexing/pdfium", st.Status, st.Source)
	}
}

func TestFinalizeEmptyVsIndexed(t *testing.T) {
	db := openTestDB(t)
	db.Claim(1, "pdfium")
	st, _ := db.Finalize(1)
	if st.Status != "empty" {
		t.Errorf("no pages → want empty, got %q", st.Status)
	}
	db.Claim(2, "pdfium")
	if err := db.UpsertPages(2, []Page{{Num: 1, Text: "hello world"}}); err != nil {
		t.Fatalf("UpsertPages: %v", err)
	}
	st2, _ := db.Finalize(2)
	if st2.Status != "indexed" || st2.PageCount != 1 {
		t.Errorf("one page → want indexed/1, got %q/%d", st2.Status, st2.PageCount)
	}
}

func TestReclaimAfterFail(t *testing.T) {
	db := openTestDB(t)
	db.Claim(7, "pdfium")
	db.Fail(7, "boom")
	st, _ := db.Status(7)
	if st.Status != "failed" {
		t.Fatalf("want failed, got %q", st.Status)
	}
	won, _ := db.Claim(7, "pdfium")
	if !won {
		t.Errorf("failed row should be reclaimable")
	}
}

func TestConcurrentClaimExactlyOneWins(t *testing.T) {
	db := openTestDB(t)
	const N = 20
	var wg sync.WaitGroup
	wins := make(chan bool, N)
	for i := 0; i < N; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			won, err := db.Claim(99, "pdfium")
			if err != nil {
				t.Errorf("claim err: %v", err)
			}
			wins <- won
		}()
	}
	wg.Wait()
	close(wins)
	count := 0
	for w := range wins {
		if w {
			count++
		}
	}
	if count != 1 {
		t.Errorf("exactly one claim should win, got %d", count)
	}
}

func TestUpsertPagesFTS5Searchable(t *testing.T) {
	db := openTestDB(t)
	db.Claim(5, "pdfium")
	if err := db.UpsertPages(5, []Page{{Num: 1, Text: "STM32 connector usb"}}); err != nil {
		t.Fatalf("UpsertPages: %v", err)
	}
	if err := db.UpsertPages(5, []Page{{Num: 1, Text: "STM32 connector usb power"}}); err != nil {
		t.Fatalf("re-upsert: %v", err)
	}
	var hits int
	err := db.reader.QueryRow(
		`SELECT COUNT(*) FROM pdf_text WHERE pdf_text MATCH 'power'`).Scan(&hits)
	if err != nil {
		t.Fatalf("fts query: %v", err)
	}
	if hits != 1 {
		t.Errorf("want 1 hit for 'power' after re-upsert, got %d", hits)
	}
}

func TestReclaimStale(t *testing.T) {
	db := openTestDB(t)
	db.Claim(11, "pdfium")
	db.writer.Exec(`UPDATE pdf_index_status SET attempted_at = 0 WHERE file_id = 11`)
	db.Claim(12, "pdfium") // fresh, must NOT be reclaimed
	n, err := db.ReclaimStale(600)
	if err != nil {
		t.Fatalf("ReclaimStale: %v", err)
	}
	if n != 1 {
		t.Errorf("want 1 stale reclaimed, got %d", n)
	}
	st, _ := db.Status(11)
	if st.Status != "pending" {
		t.Errorf("stale row should be pending, got %q", st.Status)
	}
	st2, _ := db.Status(12)
	if st2.Status != "indexing" {
		t.Errorf("fresh row should stay indexing, got %q", st2.Status)
	}
}
