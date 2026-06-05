package handlers

import (
	"bytes"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func newTestFileHandler(t *testing.T) *FileHandler {
	t.Helper()
	tmpDir := t.TempDir()
	return NewFileHandler(tmpDir, func() string { return tmpDir }, nil)
}

// multipartUpload builds a POST /api/upload request carrying one file.
func multipartUpload(t *testing.T, filename string, content []byte) *http.Request {
	t.Helper()
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	fw, err := mw.CreateFormFile("file", filename)
	if err != nil {
		t.Fatalf("CreateFormFile: %v", err)
	}
	if _, err := fw.Write(content); err != nil {
		t.Fatalf("write content: %v", err)
	}
	mw.Close()
	req := httptest.NewRequest("POST", "/api/upload", &body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	return req
}

func TestUpload_SavesBoardToIncomingAndIndexes(t *testing.T) {
	root := t.TempDir()
	var indexed []string
	h := NewFileHandler(root, func() string { return root }, func(relPath string) error {
		indexed = append(indexed, relPath)
		return nil
	})

	req := multipartUpload(t, "820-02016.bvr", []byte("BVRAW_FORMAT_3\n"))
	w := httptest.NewRecorder()
	h.Upload(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	dest := filepath.Join(root, "incoming", "820-02016.bvr")
	if _, err := os.Stat(dest); err != nil {
		t.Fatalf("expected file at %s: %v", dest, err)
	}
	if len(indexed) != 1 || indexed[0] != "incoming/820-02016.bvr" {
		t.Fatalf("expected index call with incoming/820-02016.bvr, got %v", indexed)
	}
}

func TestUpload_AcceptsPdf(t *testing.T) {
	root := t.TempDir()
	h := NewFileHandler(root, func() string { return root }, nil)
	req := multipartUpload(t, "schematic.pdf", []byte("%PDF-1.4\n"))
	w := httptest.NewRecorder()
	h.Upload(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 for pdf, got %d: %s", w.Code, w.Body.String())
	}
	if _, err := os.Stat(filepath.Join(root, "incoming", "schematic.pdf")); err != nil {
		t.Fatalf("pdf not saved: %v", err)
	}
}

func TestUpload_RejectsUnsupported(t *testing.T) {
	root := t.TempDir()
	h := NewFileHandler(root, func() string { return root }, nil)
	req := multipartUpload(t, "notes.txt", []byte("hello"))
	w := httptest.NewRecorder()
	h.Upload(w, req)
	if w.Code == http.StatusOK {
		t.Fatalf("expected rejection of unsupported .txt, got 200")
	}
}

// A path-laden filename must be flattened to its base — no escaping incoming/.
func TestUpload_SanitizesFilename(t *testing.T) {
	root := t.TempDir()
	h := NewFileHandler(root, func() string { return root }, nil)
	req := multipartUpload(t, "../../evil.brd", []byte("x"))
	w := httptest.NewRecorder()
	h.Upload(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	if _, err := os.Stat(filepath.Join(root, "incoming", "evil.brd")); err != nil {
		t.Fatalf("expected sanitized file in incoming/: %v", err)
	}
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

func TestGet_DefaultsToInline(t *testing.T) {
	root := t.TempDir()
	h := NewFileHandler(root, func() string { return root }, nil)
	if err := os.WriteFile(filepath.Join(root, "test.bvr"), []byte("BVRAW_FORMAT_3\n"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	req := httptest.NewRequest("GET", "/api/files/test.bvr", nil)
	req.SetPathValue("name", "test.bvr")
	w := httptest.NewRecorder()
	h.Get(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	got := w.Header().Get("Content-Disposition")
	want := `inline; filename="test.bvr"`
	if got != want {
		t.Errorf("Content-Disposition: got %q, want %q", got, want)
	}
}

func TestGet_DownloadQueryFlipsToAttachment(t *testing.T) {
	root := t.TempDir()
	h := NewFileHandler(root, func() string { return root }, nil)
	if err := os.WriteFile(filepath.Join(root, "test.bvr"), []byte("BVRAW_FORMAT_3\n"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	req := httptest.NewRequest("GET", "/api/files/test.bvr?download=1", nil)
	req.SetPathValue("name", "test.bvr")
	w := httptest.NewRecorder()
	h.Get(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	got := w.Header().Get("Content-Disposition")
	want := `attachment; filename="test.bvr"`
	if got != want {
		t.Errorf("Content-Disposition: got %q, want %q", got, want)
	}
}

func TestGetByPath_DownloadQueryFlipsToAttachment(t *testing.T) {
	root := t.TempDir()
	h := NewFileHandler(root, func() string { return root }, nil)
	subDir := filepath.Join(root, "boards")
	if err := os.MkdirAll(subDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(subDir, "a.brd"), []byte("hi"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	req := httptest.NewRequest("GET", "/api/files/path/boards/a.brd?download=1", nil)
	req.SetPathValue("path", "boards/a.brd")
	w := httptest.NewRecorder()
	h.GetByPath(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	got := w.Header().Get("Content-Disposition")
	want := `attachment; filename="a.brd"`
	if got != want {
		t.Errorf("Content-Disposition: got %q, want %q", got, want)
	}
}
