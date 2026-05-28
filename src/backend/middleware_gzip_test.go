package main

import (
	"bytes"
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestGzipCompressesJSON verifies a compressible response is gzipped when the
// client advertises gzip.
func TestGzipCompressesJSON(t *testing.T) {
	h := gzipMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"hello":"` + strings.Repeat("x", 1000) + `"}`))
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/x", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if got := rec.Header().Get("Content-Encoding"); got != "gzip" {
		t.Fatalf("expected gzip encoding, got %q", got)
	}
	gz, err := gzip.NewReader(rec.Body)
	if err != nil {
		t.Fatalf("gzip reader: %v", err)
	}
	body, _ := io.ReadAll(gz)
	if !strings.Contains(string(body), `"hello"`) {
		t.Fatalf("decompressed body missing payload: %q", body)
	}
}

// TestGzipSkipsEventStream verifies SSE responses are NOT gzipped and the
// wrapper exposes a working Flusher.
func TestGzipSkipsEventStream(t *testing.T) {
	flushed := false
	h := gzipMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Mirror handlers/update.go: assert Flusher BEFORE writing headers.
		f, ok := w.(http.Flusher)
		if !ok {
			t.Errorf("gzip wrapper must implement http.Flusher for SSE handlers")
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache, no-transform")
		f.Flush()
		_, _ = w.Write([]byte("data: hello\n\n"))
		f.Flush()
		flushed = true
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/update/progress", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if !flushed {
		t.Fatalf("handler did not complete (Flusher assertion failed)")
	}
	if enc := rec.Header().Get("Content-Encoding"); enc == "gzip" {
		t.Fatalf("event-stream must NOT be gzip-encoded, got %q", enc)
	}
	if !strings.Contains(rec.Body.String(), "data: hello") {
		t.Fatalf("SSE body should be passed through verbatim, got %q", rec.Body.String())
	}
}

// TestGzipSkipsNDJSON verifies NDJSON streams are not gzipped.
func TestGzipSkipsNDJSON(t *testing.T) {
	h := gzipMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/x-ndjson")
		f, ok := w.(http.Flusher)
		if !ok {
			t.Errorf("gzip wrapper must implement http.Flusher for NDJSON streams")
			return
		}
		_, _ = w.Write([]byte(`{"n":1}` + "\n"))
		f.Flush()
		_, _ = w.Write([]byte(`{"n":2}` + "\n"))
		f.Flush()
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/databank/search/stream", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if enc := rec.Header().Get("Content-Encoding"); enc == "gzip" {
		t.Fatalf("NDJSON must NOT be gzip-encoded, got %q", enc)
	}
	if !bytes.Contains(rec.Body.Bytes(), []byte(`{"n":2}`)) {
		t.Fatalf("NDJSON body should pass through verbatim, got %q", rec.Body.String())
	}
}

// TestGzipNoTransformRespected verifies a compressible content type is left
// uncompressed when Cache-Control: no-transform is set.
func TestGzipNoTransformRespected(t *testing.T) {
	h := gzipMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-transform")
		_, _ = w.Write([]byte(`{"x":1}`))
	}))
	req := httptest.NewRequest(http.MethodGet, "/api/x", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if enc := rec.Header().Get("Content-Encoding"); enc == "gzip" {
		t.Fatalf("no-transform must prevent gzip, got %q", enc)
	}
}

// TestGzipSkippedWithoutAcceptEncoding verifies passthrough when the client
// does not advertise gzip.
func TestGzipSkippedWithoutAcceptEncoding(t *testing.T) {
	h := gzipMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"x":1}`))
	}))
	req := httptest.NewRequest(http.MethodGet, "/api/x", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if enc := rec.Header().Get("Content-Encoding"); enc != "" {
		t.Fatalf("no Accept-Encoding should mean no gzip, got %q", enc)
	}
	if rec.Body.String() != `{"x":1}` {
		t.Fatalf("body mismatch: %q", rec.Body.String())
	}
}
