package handlers

import (
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"syscall"
	"testing"
	"time"
)

// fakeFileInfo implements os.FileInfo for tests.
type fakeFileInfo struct {
	name    string
	size    int64
	mode    os.FileMode
	modTime time.Time
	isDir   bool
}

func (f fakeFileInfo) Name() string       { return f.name }
func (f fakeFileInfo) Size() int64        { return f.size }
func (f fakeFileInfo) Mode() os.FileMode  { return f.mode }
func (f fakeFileInfo) ModTime() time.Time { return f.modTime }
func (f fakeFileInfo) IsDir() bool        { return f.isDir }
func (f fakeFileInfo) Sys() interface{}   { return nil }

// blockingReadCloser blocks on Read until Close is called, simulating a
// cloud-placeholder read that never completes within the deadline.
type blockingReadCloser struct{ block chan struct{} }

func (b *blockingReadCloser) Read(p []byte) (int, error) {
	<-b.block
	return 0, io.EOF
}
func (b *blockingReadCloser) Close() error {
	select {
	case <-b.block:
		// already closed
	default:
		close(b.block)
	}
	return nil
}

func TestServeFileEager_HappyPath(t *testing.T) {
	body := "hello world"
	opener := func(path string) (io.ReadCloser, os.FileInfo, error) {
		return io.NopCloser(strings.NewReader(body)), fakeFileInfo{name: "x.txt", size: int64(len(body))}, nil
	}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/x", nil)
	serveFileEagerWith(rec, req, "/fake/x.txt", "text/plain", opener)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	if got := rec.Body.String(); got != body {
		t.Fatalf("body mismatch: got %q want %q", got, body)
	}
	if got := rec.Header().Get("Content-Type"); got != "text/plain" {
		t.Fatalf("Content-Type: got %q want text/plain", got)
	}
	if got := rec.Header().Get("Content-Length"); got != "11" {
		t.Fatalf("Content-Length: got %q want 11", got)
	}
}

func TestServeFileEager_ShortRead(t *testing.T) {
	// Stat says 100 bytes, but reader returns only 5 — simulates a cloud
	// placeholder that returned EOF early.
	opener := func(path string) (io.ReadCloser, os.FileInfo, error) {
		return io.NopCloser(strings.NewReader("hello")), fakeFileInfo{name: "x.bin", size: 100}, nil
	}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/x", nil)
	serveFileEagerWith(rec, req, "/fake/x.bin", "", opener)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503, got %d", rec.Code)
	}
	if got := rec.Header().Get("Retry-After"); got != "5" {
		t.Fatalf("Retry-After: got %q want 5", got)
	}
}

func TestServeFileEager_Deadline(t *testing.T) {
	prev := readDeadlineForTest
	readDeadlineForTest = 50 * time.Millisecond
	defer func() { readDeadlineForTest = prev }()

	opener := func(path string) (io.ReadCloser, os.FileInfo, error) {
		return &blockingReadCloser{block: make(chan struct{})}, fakeFileInfo{name: "x.bin", size: 100}, nil
	}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/x", nil)
	serveFileEagerWith(rec, req, "/fake/x.bin", "", opener)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503, got %d", rec.Code)
	}
	if got := rec.Header().Get("Retry-After"); got != "10" {
		t.Fatalf("Retry-After: got %q want 10", got)
	}
}

func TestServeFileEager_NotFound(t *testing.T) {
	opener := func(path string) (io.ReadCloser, os.FileInfo, error) {
		return nil, nil, &os.PathError{Op: "stat", Path: path, Err: os.ErrNotExist}
	}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/x", nil)
	serveFileEagerWith(rec, req, "/missing", "", opener)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", rec.Code)
	}
}

func TestServeFileEager_TooLarge(t *testing.T) {
	opener := func(path string) (io.ReadCloser, os.FileInfo, error) {
		return io.NopCloser(strings.NewReader("")), fakeFileInfo{name: "huge", size: maxFileBytes + 1}, nil
	}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/x", nil)
	serveFileEagerWith(rec, req, "/fake/huge", "", opener)
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("expected 413, got %d", rec.Code)
	}
}

func TestServeFileEager_OpenError(t *testing.T) {
	opener := func(path string) (io.ReadCloser, os.FileInfo, error) {
		return nil, fakeFileInfo{name: "x.bin", size: 10}, errors.New("synthetic open error")
	}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/x", nil)
	serveFileEagerWith(rec, req, "/fake/x.bin", "", opener)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500, got %d", rec.Code)
	}
}

// edeadlkReadCloser returns syscall.EDEADLK on Read — simulates the
// cloud-placeholder read failure that occurs inside Docker bind-mounts of
// macOS File Provider folders (Docker Desktop's FUSE bridge can't drive
// host-side materialization, so the read deadlocks).
type edeadlkReadCloser struct{}

func (e *edeadlkReadCloser) Read(p []byte) (int, error) {
	return 0, syscall.EDEADLK
}
func (e *edeadlkReadCloser) Close() error { return nil }

func TestServeFileEager_PlaceholderEDEADLK(t *testing.T) {
	opener := func(path string) (io.ReadCloser, os.FileInfo, error) {
		return &edeadlkReadCloser{}, fakeFileInfo{name: "p.bin", size: 1234567}, nil
	}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/x", nil)
	serveFileEagerWith(rec, req, "/fake/p.bin", "", opener)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503, got %d", rec.Code)
	}
	if got := rec.Header().Get("Retry-After"); got != "60" {
		t.Fatalf("Retry-After: got %q want 60", got)
	}
	body := rec.Body.String()
	if !strings.Contains(strings.ToLower(body), "placeholder") {
		t.Fatalf("body should mention 'placeholder'; got %q", body)
	}
}
