package pdfindex

import (
	"path/filepath"
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
