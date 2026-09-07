package handlers

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"boardripper/databank"
)

func newTestFileHandler(t *testing.T) *FileHandler {
	t.Helper()
	tmpDir := t.TempDir()
	return NewFileHandler(tmpDir, func() string { return tmpDir }, nil, nil)
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
	h := NewFileHandler(root, func() string { return root }, nil, func(relPath string, _ []byte) (*databank.FileRecord, error) {
		indexed = append(indexed, relPath)
		return &databank.FileRecord{ID: 99, FileType: "board", Path: relPath}, nil
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
	// The upload response carries the ingested databank id + type so the client
	// can tag the open file without a name+size fallback.
	var resp map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("response not JSON: %v", err)
	}
	if resp["id"] != float64(99) {
		t.Fatalf("expected id 99 in upload response, got %v", resp["id"])
	}
	if resp["file_type"] != "board" {
		t.Fatalf("expected file_type board, got %v", resp["file_type"])
	}
}

func TestUpload_AcceptsPdf(t *testing.T) {
	root := t.TempDir()
	h := NewFileHandler(root, func() string { return root }, nil, nil)
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
	h := NewFileHandler(root, func() string { return root }, nil, nil)
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
	h := NewFileHandler(root, func() string { return root }, nil, nil)
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
	h := NewFileHandler(root, func() string { return root }, nil, nil)
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
	h := NewFileHandler(root, func() string { return root }, nil, nil)
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
	h := NewFileHandler(root, func() string { return root }, nil, nil)
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

// A drop whose bytes already exist in the library (any name, any folder) must
// not be written: the response points at the existing record instead.
func TestUpload_IdenticalContentIsNotCopied(t *testing.T) {
	root := t.TempDir()
	var indexed []string
	h := NewFileHandler(root, func() string { return root }, nil, func(relPath string, _ []byte) (*databank.FileRecord, error) {
		indexed = append(indexed, relPath)
		return &databank.FileRecord{ID: 7, FileType: "pdf", Path: relPath}, nil
	})
	h.SetDedupFunc(func(absPath string, size int64) (*databank.FileRecord, []byte, error) {
		return &databank.FileRecord{ID: 42, FileType: "pdf", Path: "Apple/820-1/orig.pdf", Filename: "orig.pdf"}, []byte{9}, nil
	})
	var submitted []int64
	h.SetPdfSubmitHook(func(id int64) { submitted = append(submitted, id) })

	w := httptest.NewRecorder()
	h.Upload(w, multipartUpload(t, "copy.pdf", []byte("%PDF-1.4 same bytes")))
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var resp map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["status"] != "exists" || resp["id"] != float64(42) || resp["path"] != "Apple/820-1/orig.pdf" {
		t.Fatalf("unexpected response: %v", resp)
	}
	if _, err := os.Stat(filepath.Join(root, "incoming", "copy.pdf")); !os.IsNotExist(err) {
		t.Fatalf("duplicate must not be written to incoming/, stat err=%v", err)
	}
	if len(indexed) != 0 {
		t.Fatalf("duplicate must not be indexed as a new row, got %v", indexed)
	}
	if len(submitted) != 1 || submitted[0] != 42 {
		t.Fatalf("expected the existing pdf to be (re)submitted, got %v", submitted)
	}
	// No temp file left behind.
	entries, _ := os.ReadDir(filepath.Join(root, "incoming"))
	if len(entries) != 0 {
		t.Fatalf("incoming/ should be empty, got %d entries", len(entries))
	}
}

// Same name at the destination but different bytes: never overwrite — save
// under a "(2)" sibling and say so.
func TestUpload_NameCollisionIsRenamedNotOverwritten(t *testing.T) {
	root := t.TempDir()
	var got []string
	h := NewFileHandler(root, func() string { return root }, nil, func(relPath string, _ []byte) (*databank.FileRecord, error) {
		got = append(got, relPath)
		return &databank.FileRecord{ID: int64(len(got)), FileType: "board", Path: relPath}, nil
	})
	// No dedup fn: the on-disk comparison alone must protect the original.

	h.Upload(httptest.NewRecorder(), multipartUpload(t, "820-1.brd", []byte("original bytes")))
	w := httptest.NewRecorder()
	h.Upload(w, multipartUpload(t, "820-1.brd", []byte("different bytes!")))
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var resp map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["status"] != "renamed" || resp["name"] != "820-1 (2).brd" || resp["path"] != "incoming/820-1 (2).brd" {
		t.Fatalf("unexpected response: %v", resp)
	}
	orig, _ := os.ReadFile(filepath.Join(root, "incoming", "820-1.brd"))
	if string(orig) != "original bytes" {
		t.Fatalf("original was overwritten: %q", orig)
	}
	if _, err := os.Stat(filepath.Join(root, "incoming", "820-1 (2).brd")); err != nil {
		t.Fatalf("renamed copy missing: %v", err)
	}
	if len(got) != 2 || got[1] != "incoming/820-1 (2).brd" {
		t.Fatalf("expected index of renamed path, got %v", got)
	}
}

// Same name AND same bytes already on disk (e.g. copied in by hand before a
// scan): nothing is written and the existing path is (re)indexed.
func TestUpload_SameBytesOnDiskIsReused(t *testing.T) {
	root := t.TempDir()
	var got []string
	h := NewFileHandler(root, func() string { return root }, nil, func(relPath string, _ []byte) (*databank.FileRecord, error) {
		got = append(got, relPath)
		return &databank.FileRecord{ID: 5, FileType: "board", Path: relPath}, nil
	})
	if err := os.MkdirAll(filepath.Join(root, "incoming"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "incoming", "820-1.brd"), []byte("the very same bytes"), 0o644); err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	h.Upload(w, multipartUpload(t, "820-1.brd", []byte("the very same bytes")))
	var resp map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["status"] != "exists" || resp["id"] != float64(5) || resp["path"] != "incoming/820-1.brd" {
		t.Fatalf("unexpected response: %v", resp)
	}
	entries, _ := os.ReadDir(filepath.Join(root, "incoming"))
	if len(entries) != 1 {
		t.Fatalf("expected exactly the original file, got %d entries", len(entries))
	}
	if len(got) != 1 || got[0] != "incoming/820-1.brd" {
		t.Fatalf("expected reindex of the existing path, got %v", got)
	}
}
