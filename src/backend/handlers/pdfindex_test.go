package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"boardripper/databank"
	"boardripper/pdfindex"
)

func newPdfIndexTestHandler(t *testing.T) *PdfIndexHandler {
	t.Helper()
	db, err := pdfindex.Open(filepath.Join(t.TempDir(), "pdfindex.db"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	ix := pdfindex.NewIndexer(db, nil, nil, func() []string { return nil }, 1)
	return NewPdfIndexHandler(db, ix, nil)
}

func TestStatusEndpoint404ThenClaim(t *testing.T) {
	h := newPdfIndexTestHandler(t)
	req := httptest.NewRequest("POST", "/api/pdfindex/files/5/begin", nil)
	req.SetPathValue("id", "5")
	w := httptest.NewRecorder()
	h.Begin(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("begin: code %d", w.Code)
	}
	req2 := httptest.NewRequest("GET", "/api/pdfindex/status/5", nil)
	req2.SetPathValue("id", "5")
	w2 := httptest.NewRecorder()
	h.Status(w2, req2)
	var st pdfindex.StatusRow
	json.NewDecoder(w2.Body).Decode(&st)
	if st.Status != "indexing" {
		t.Errorf("status = %q, want indexing", st.Status)
	}
}

// TestSearchCollapsesContentGroup verifies that two byte-identical PDFs that
// both hold indexed pages (e.g. indexed individually before a dedup pass)
// collapse to ONE search result, attributed to the lowest-id member, with the
// other path listed in `copies`.
func TestSearchCollapsesContentGroup(t *testing.T) {
	bank, err := databank.Open(t.TempDir())
	if err != nil {
		t.Fatalf("databank open: %v", err)
	}
	t.Cleanup(func() { bank.Close() })
	if err := bank.MigratePdfIndexV1(); err != nil { // creates pdf_donors
		t.Fatalf("migrate: %v", err)
	}
	pdb, err := pdfindex.Open(filepath.Join(t.TempDir(), "pdfindex.db"))
	if err != nil {
		t.Fatalf("pdfindex open: %v", err)
	}
	t.Cleanup(func() { pdb.Close() })

	// Two byte-identical PDFs (same size, same content hash).
	canon, _ := bank.InsertFile(&databank.FileRecord{Path: "a/board.pdf", Filename: "board.pdf", Extension: ".pdf", FileType: "pdf", Size: 100, ModTime: 1})
	dup, _ := bank.InsertFile(&databank.FileRecord{Path: "b/board.pdf", Filename: "board.pdf", Extension: ".pdf", FileType: "pdf", Size: 100, ModTime: 1})
	hash := []byte("0123456789abcdef0123456789abcdef")
	bank.SetContentHash(canon, hash)
	bank.SetContentHash(dup, hash)

	// Both files were indexed individually and hold the same page text.
	for _, id := range []int64{canon, dup} {
		if err := pdb.UpsertPages(id, []pdfindex.Page{{Num: 1, Text: "alpha connector beta"}}); err != nil {
			t.Fatalf("UpsertPages(%d): %v", id, err)
		}
		if _, err := pdb.Finalize(id); err != nil {
			t.Fatalf("Finalize(%d): %v", id, err)
		}
	}

	ix := pdfindex.NewIndexer(pdb, nil, nil, func() []string { return nil }, 1)
	h := NewPdfIndexHandler(pdb, ix, bank)

	req := httptest.NewRequest("GET", "/api/databank/search?q=connector", nil)
	w := httptest.NewRecorder()
	h.Search(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("search code %d", w.Code)
	}
	var resp struct {
		Results []struct {
			FileID int64    `json:"file_id"`
			Path   string   `json:"path"`
			Copies []string `json:"copies"`
		} `json:"results"`
		Total int `json:"total"`
	}
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.Total != 1 || len(resp.Results) != 1 {
		t.Fatalf("expected 1 collapsed result, got total=%d len=%d", resp.Total, len(resp.Results))
	}
	r := resp.Results[0]
	if r.FileID != canon {
		t.Errorf("representative file_id = %d, want canonical %d", r.FileID, canon)
	}
	if len(r.Copies) != 1 || r.Copies[0] != "b/board.pdf" {
		t.Errorf("copies = %v, want [b/board.pdf]", r.Copies)
	}
}
