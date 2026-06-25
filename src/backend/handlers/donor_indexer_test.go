package handlers

import (
	"path/filepath"
	"testing"

	"boardripper/pdfindex"
)

func TestPdfDonorIndexerStatusFor(t *testing.T) {
	store, err := pdfindex.Open(filepath.Join(t.TempDir(), "pdfindex.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	// File 7 indexed; file 8 never seen → maps to "pending".
	if won, err := store.Claim(7, "test"); err != nil || !won {
		t.Fatalf("Claim: won=%v err=%v", won, err)
	}
	if err := store.UpsertPages(7, []pdfindex.Page{{Num: 1, Text: "hi"}}); err != nil {
		t.Fatalf("UpsertPages: %v", err)
	}
	if _, err := store.Finalize(7); err != nil {
		t.Fatalf("Finalize: %v", err)
	}

	di := NewPdfDonorIndexer(nil, store) // ix unused by StatusFor
	got := di.StatusFor([]int64{7, 8})
	if got[7] != "indexed" {
		t.Errorf("status[7] = %q, want indexed", got[7])
	}
	if got[8] != "pending" {
		t.Errorf("status[8] = %q, want pending (no row)", got[8])
	}
}
