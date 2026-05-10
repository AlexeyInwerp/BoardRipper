package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestProbe_HappyPathLocalFile(t *testing.T) {
	h := newTestFileHandler(t)
	body := []byte("hello probe world")
	fp := filepath.Join(h.dataDir, "ok.txt")
	if err := os.WriteFile(fp, body, 0644); err != nil {
		t.Fatalf("write: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/files/probe?path=ok.txt", nil)
	rec := httptest.NewRecorder()
	h.Probe(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%q", rec.Code, rec.Body.String())
	}

	var res ProbeResult
	if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil {
		t.Fatalf("decode: %v body=%q", err, rec.Body.String())
	}
	if res.Size != int64(len(body)) {
		t.Errorf("size: got %d want %d", res.Size, len(body))
	}
	if !res.Probe.Ok {
		t.Errorf("probe.ok should be true; got %+v", res.Probe)
	}
	if res.Probe.BytesRead == 0 {
		t.Errorf("expected bytes_read > 0; got %d", res.Probe.BytesRead)
	}
	if res.PlaceholderSignal {
		t.Errorf("local file should not signal placeholder; got %+v", res)
	}
	if res.Probe.TimedOut {
		t.Errorf("local file should not time out; got %+v", res.Probe)
	}
}

func TestProbe_NotFound(t *testing.T) {
	h := newTestFileHandler(t)
	req := httptest.NewRequest(http.MethodGet, "/api/files/probe?path=nope.bin", nil)
	rec := httptest.NewRecorder()
	h.Probe(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", rec.Code)
	}
}

func TestProbe_RejectsTraversal(t *testing.T) {
	h := newTestFileHandler(t)
	req := httptest.NewRequest(http.MethodGet, "/api/files/probe?path=..%2Fetc%2Fpasswd", nil)
	rec := httptest.NewRecorder()
	h.Probe(rec, req)
	// The query parser decodes %2F → /, then filepath.Clean normalizes
	// "../etc/passwd". The contains-".." check rejects it.
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d body=%q", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "Invalid path") {
		t.Fatalf("body should mention 'Invalid path'; got %q", rec.Body.String())
	}
}

func TestProbe_MissingPathParam(t *testing.T) {
	h := newTestFileHandler(t)
	req := httptest.NewRequest(http.MethodGet, "/api/files/probe", nil)
	rec := httptest.NewRecorder()
	h.Probe(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rec.Code)
	}
}
