package updater

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func sha256Hex(b []byte) string {
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

func TestDownloadAssetVerified_HappyPath(t *testing.T) {
	body := []byte("hello world")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Write(body)
	}))
	defer srv.Close()

	dir := t.TempDir()
	dest := filepath.Join(dir, "asset.bin")
	if err := downloadAssetVerified(srv.URL, dest, int64(len(body)), sha256Hex(body)); err != nil {
		t.Fatalf("happy path failed: %v", err)
	}
	got, err := os.ReadFile(dest)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(body) {
		t.Fatalf("content mismatch: got %q, want %q", got, body)
	}
}

func TestDownloadAssetVerified_RejectsOversizeStream(t *testing.T) {
	// Server claims size 8 in the manifest but actually serves 1 MB.
	declared := int64(8)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte(strings.Repeat("A", 1024*1024)))
	}))
	defer srv.Close()

	dir := t.TempDir()
	dest := filepath.Join(dir, "asset.bin")
	err := downloadAssetVerified(srv.URL, dest, declared, sha256Hex([]byte(strings.Repeat("A", int(declared)))))
	if err == nil {
		t.Fatal("expected oversize stream to be rejected, got nil")
	}
	if !strings.Contains(err.Error(), "exceeds cap") && !strings.Contains(err.Error(), "size mismatch") {
		t.Fatalf("expected size-cap or size-mismatch error, got: %v", err)
	}
	// File on disk must not exceed the cap+1 (one byte past).
	st, err := os.Stat(dest)
	if err != nil {
		t.Fatal(err)
	}
	if st.Size() > declared+1 {
		t.Fatalf("file grew past cap: size=%d cap=%d", st.Size(), declared)
	}
}

func TestDownloadAssetVerified_RejectsSHAMismatch(t *testing.T) {
	body := []byte("legit content")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Write(body)
	}))
	defer srv.Close()

	dir := t.TempDir()
	dest := filepath.Join(dir, "asset.bin")
	wrong := sha256Hex([]byte("not the real content"))
	err := downloadAssetVerified(srv.URL, dest, int64(len(body)), wrong)
	if err == nil {
		t.Fatal("expected sha256 mismatch, got nil")
	}
	if !strings.Contains(err.Error(), "sha256 mismatch") {
		t.Fatalf("expected sha256 mismatch error, got: %v", err)
	}
}

func TestDownloadAssetVerified_RejectsHTTPNon200(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "gone", http.StatusGone)
	}))
	defer srv.Close()

	dir := t.TempDir()
	dest := filepath.Join(dir, "asset.bin")
	err := downloadAssetVerified(srv.URL, dest, 0, "")
	if err == nil {
		t.Fatal("expected non-200 to fail, got nil")
	}
	if !strings.Contains(err.Error(), "HTTP 410") {
		t.Fatalf("expected HTTP 410 error, got: %v", err)
	}
}

func TestDownloadAssetVerified_FallbackCapAppliesWhenSizeBytesUnset(t *testing.T) {
	// Without SizeBytes the function falls back to fallbackMaxAssetSize. Verify
	// a tiny stream under a 0 declared size still completes (cap is huge).
	body := []byte("ok")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Write(body)
	}))
	defer srv.Close()

	dir := t.TempDir()
	dest := filepath.Join(dir, "asset.bin")
	if err := downloadAssetVerified(srv.URL, dest, 0, sha256Hex(body)); err != nil {
		t.Fatalf("zero-size manifest legitimate file should succeed: %v", err)
	}
}

func TestDownloadAssetVerified_RejectsShortStream(t *testing.T) {
	// Manifest declares 100 bytes but server serves only 10.
	body := []byte("only10byte")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Write(body)
	}))
	defer srv.Close()

	dir := t.TempDir()
	dest := filepath.Join(dir, "asset.bin")
	err := downloadAssetVerified(srv.URL, dest, 100, sha256Hex(make([]byte, 100)))
	if err == nil {
		t.Fatal("expected short-stream size mismatch, got nil")
	}
	if !strings.Contains(err.Error(), "size mismatch") {
		t.Fatalf("expected size mismatch error, got: %v", err)
	}
}
