package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

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
	return NewPdfIndexHandler(db, ix)
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
