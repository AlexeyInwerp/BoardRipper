package handlers

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func newTestFileHandler(t *testing.T) *FileHandler {
	t.Helper()
	tmpDir := t.TempDir()
	return NewFileHandler(tmpDir, func() string { return tmpDir })
}

func TestUpload_RejectsEmptyBody(t *testing.T) {
	h := newTestFileHandler(t)
	req := httptest.NewRequest("POST", "/api/upload", nil)
	w := httptest.NewRecorder()
	h.Upload(w, req)
	if w.Code == http.StatusOK {
		t.Errorf("expected error for empty upload, got %d", w.Code)
	}
}

func TestList_ReturnsJSON(t *testing.T) {
	h := newTestFileHandler(t)
	req := httptest.NewRequest("GET", "/api/files", nil)
	w := httptest.NewRecorder()
	h.List(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	ct := w.Header().Get("Content-Type")
	if ct != "application/json" {
		t.Errorf("expected application/json, got %q", ct)
	}
}

func TestList_EmptyDir(t *testing.T) {
	h := newTestFileHandler(t)
	req := httptest.NewRequest("GET", "/api/files", nil)
	w := httptest.NewRecorder()
	h.List(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	body := w.Body.String()
	if body != "[]" && body != "[]\n" {
		t.Logf("body: %s", body)
	}
}

func TestDelete_RejectsEmptyName(t *testing.T) {
	h := newTestFileHandler(t)
	req := httptest.NewRequest("DELETE", "/api/files/", nil)
	req.SetPathValue("name", "")
	w := httptest.NewRecorder()
	h.Delete(w, req)
	if w.Code == http.StatusOK {
		t.Error("expected rejection of empty filename")
	}
}

func TestGet_RejectsTraversal(t *testing.T) {
	h := newTestFileHandler(t)
	req := httptest.NewRequest("GET", "/api/files/../../../etc/passwd", nil)
	req.SetPathValue("name", "../../../etc/passwd")
	w := httptest.NewRecorder()
	h.Get(w, req)
	if w.Code == http.StatusOK {
		t.Error("path traversal should be rejected")
	}
}
