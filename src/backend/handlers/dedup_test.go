package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"boardripper/databank"
)

func TestDedupHandlerProgress(t *testing.T) {
	db, err := databank.Open(t.TempDir())
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	r := databank.NewDedupRunner(db, func() string { return t.TempDir() })
	h := NewDedupHandler(r, db)
	req := httptest.NewRequest("GET", "/api/databank/dedup/progress", nil)
	w := httptest.NewRecorder()
	h.ProgressEndpoint(w, req)
	if w.Code != http.StatusOK {
		t.Errorf("code = %d", w.Code)
	}
}

func TestDedupHandlerStats(t *testing.T) {
	db, err := databank.Open(t.TempDir())
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	r := databank.NewDedupRunner(db, func() string { return t.TempDir() })
	h := NewDedupHandler(r, db)
	req := httptest.NewRequest("GET", "/api/databank/dedup/stats", nil)
	w := httptest.NewRecorder()
	h.Stats(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("code = %d", w.Code)
	}
	var s databank.DedupStats
	if err := json.NewDecoder(w.Body).Decode(&s); err != nil {
		t.Fatalf("decode stats: %v", err)
	}
}
