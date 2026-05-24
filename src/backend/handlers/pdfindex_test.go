package handlers

import (
	"bufio"
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
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

// TestSearchStreamEmitsResultPerFile verifies the NDJSON streaming endpoint emits
// exactly one "result" line per matching file (not per page), in first-seen FTS
// rank order, followed by a "counts" line with the final per-file hit counts and a
// final "done" line carrying the total number of distinct files.
func TestSearchStreamEmitsResultPerFile(t *testing.T) {
	bank, err := databank.Open(t.TempDir())
	if err != nil {
		t.Fatalf("databank open: %v", err)
	}
	t.Cleanup(func() { bank.Close() })
	if err := bank.MigratePdfIndexV1(); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	pdb, err := pdfindex.Open(filepath.Join(t.TempDir(), "pdfindex.db"))
	if err != nil {
		t.Fatalf("pdfindex open: %v", err)
	}
	t.Cleanup(func() { pdb.Close() })

	// File A matches on pages 1 and 3; file B matches on pages 2 and 4.
	fileA, _ := bank.InsertFile(&databank.FileRecord{Path: "a/boardA.pdf", Filename: "boardA.pdf", Extension: ".pdf", FileType: "pdf", Size: 100, ModTime: 1})
	fileB, _ := bank.InsertFile(&databank.FileRecord{Path: "b/boardB.pdf", Filename: "boardB.pdf", Extension: ".pdf", FileType: "pdf", Size: 200, ModTime: 1})
	if err := pdb.UpsertPages(fileA, []pdfindex.Page{
		{Num: 1, Text: "alpha connector beta"},
		{Num: 3, Text: "gamma connector delta"},
	}); err != nil {
		t.Fatalf("UpsertPages(A): %v", err)
	}
	if err := pdb.UpsertPages(fileB, []pdfindex.Page{
		{Num: 2, Text: "epsilon connector zeta"},
		{Num: 4, Text: "eta connector theta"},
	}); err != nil {
		t.Fatalf("UpsertPages(B): %v", err)
	}
	for _, id := range []int64{fileA, fileB} {
		if _, err := pdb.Finalize(id); err != nil {
			t.Fatalf("Finalize(%d): %v", id, err)
		}
	}

	ix := pdfindex.NewIndexer(pdb, nil, nil, func() []string { return nil }, 1)
	h := NewPdfIndexHandler(pdb, ix, bank)

	req := httptest.NewRequest("GET", "/api/databank/search/stream?q=connector", nil)
	w := httptest.NewRecorder()
	h.SearchStream(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("stream code %d", w.Code)
	}
	if ct := w.Header().Get("Content-Type"); ct != "application/x-ndjson" {
		t.Errorf("content-type = %q, want application/x-ndjson", ct)
	}

	var results int
	resultFiles := map[int64]bool{}
	var counts map[string]int
	var doneTotal int
	sawDone := false

	sc := bufio.NewScanner(bytes.NewReader(w.Body.Bytes()))
	for sc.Scan() {
		line := bytes.TrimSpace(sc.Bytes())
		if len(line) == 0 {
			continue
		}
		var env struct {
			Type   string         `json:"type"`
			FileID int64          `json:"file_id"`
			Counts map[string]int `json:"counts"`
			Total  int            `json:"total"`
		}
		if err := json.Unmarshal(line, &env); err != nil {
			t.Fatalf("bad ndjson line %q: %v", line, err)
		}
		switch env.Type {
		case "result":
			results++
			resultFiles[env.FileID] = true
		case "counts":
			counts = env.Counts
		case "done":
			doneTotal = env.Total
			sawDone = true
		default:
			t.Fatalf("unexpected line type %q", env.Type)
		}
	}
	if err := sc.Err(); err != nil {
		t.Fatalf("scan: %v", err)
	}

	if results != 2 {
		t.Errorf("result lines = %d, want 2 (one per file)", results)
	}
	if !resultFiles[fileA] || !resultFiles[fileB] {
		t.Errorf("result files = %v, want both %d and %d", resultFiles, fileA, fileB)
	}
	if counts == nil {
		t.Fatalf("no counts line emitted")
	}
	for _, id := range []int64{fileA, fileB} {
		key := strconv.FormatInt(id, 10)
		if counts[key] != 2 {
			t.Errorf("counts[%s] = %d, want 2", key, counts[key])
		}
	}
	if !sawDone {
		t.Fatalf("no done line emitted")
	}
	if doneTotal != 2 {
		t.Errorf("done total = %d, want 2", doneTotal)
	}
}

// TestSearchCollapsesPagesToOneRowWithCount verifies that a single PDF matching
// the query on multiple pages produces exactly ONE result row (per file, not per
// page), with hit_count = number of matching pages and page_num = the lowest
// matching page.
func TestSearchCollapsesPagesToOneRowWithCount(t *testing.T) {
	bank, err := databank.Open(t.TempDir())
	if err != nil {
		t.Fatalf("databank open: %v", err)
	}
	t.Cleanup(func() { bank.Close() })
	if err := bank.MigratePdfIndexV1(); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	pdb, err := pdfindex.Open(filepath.Join(t.TempDir(), "pdfindex.db"))
	if err != nil {
		t.Fatalf("pdfindex open: %v", err)
	}
	t.Cleanup(func() { pdb.Close() })

	// One PDF, no content hash (unique-size singleton), matching on three pages.
	id, _ := bank.InsertFile(&databank.FileRecord{Path: "a/board.pdf", Filename: "board.pdf", Extension: ".pdf", FileType: "pdf", Size: 100, ModTime: 1})
	if err := pdb.UpsertPages(id, []pdfindex.Page{
		{Num: 2, Text: "alpha connector beta"},
		{Num: 5, Text: "gamma connector delta"},
		{Num: 9, Text: "epsilon connector zeta"},
	}); err != nil {
		t.Fatalf("UpsertPages: %v", err)
	}
	if _, err := pdb.Finalize(id); err != nil {
		t.Fatalf("Finalize: %v", err)
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
			FileID   int64 `json:"file_id"`
			PageNum  int   `json:"page_num"`
			HitCount int   `json:"hit_count"`
		} `json:"results"`
		Total int `json:"total"`
	}
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.Total != 1 || len(resp.Results) != 1 {
		t.Fatalf("expected 1 result row, got total=%d len=%d", resp.Total, len(resp.Results))
	}
	r := resp.Results[0]
	if r.HitCount != 3 {
		t.Errorf("hit_count = %d, want 3", r.HitCount)
	}
	if r.PageNum != 2 {
		t.Errorf("page_num = %d, want lowest matching page 2", r.PageNum)
	}
}
