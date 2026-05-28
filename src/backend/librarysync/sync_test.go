package librarysync

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"boardripper/databank"
)

func init() {
	// httptest serves on 127.0.0.1, which the SSRF guard blocks by default.
	// Flip the package-level opt-in for the duration of the test binary.
	allowPrivateNetwork = true
}

// stubServer is an in-memory WebDAV-ish file source: a manifest plus a map of
// path → body. It records every GET path so tests can assert which files were
// actually fetched (diff-then-fetch). Paths returning a non-200 are simulated
// via the errorPaths set.
type stubServer struct {
	mu         sync.Mutex
	manifest   []string
	bodies     map[string]string
	errorPaths map[string]int // path → status code to return
	fetched    []string       // GET paths (excluding manifest.txt), in order
}

func (s *stubServer) handler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/")
		if path == "manifest.txt" {
			w.Header().Set("Content-Type", "text/plain")
			_, _ = w.Write([]byte(strings.Join(s.manifest, "\n") + "\n"))
			return
		}
		s.mu.Lock()
		s.fetched = append(s.fetched, path)
		code, isErr := s.errorPaths[path]
		body, ok := s.bodies[path]
		s.mu.Unlock()

		if isErr {
			http.Error(w, "boom", code)
			return
		}
		if !ok {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write([]byte(body))
	}
}

func (s *stubServer) fetchedPaths() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]string, len(s.fetched))
	copy(out, s.fetched)
	return out
}

// newEngineWithConfig builds an Engine wired to a temp databank.DB seeded with
// the sync_url and sync_target config keys. Returns the engine and the target
// directory.
func newEngineWithConfig(t *testing.T, url string) (*Engine, string) {
	t.Helper()
	db, err := databank.Open(t.TempDir())
	if err != nil {
		t.Fatalf("databank open: %v", err)
	}
	t.Cleanup(func() { db.Close() })

	target := t.TempDir()
	if err := db.SetConfig("sync_url", url); err != nil {
		t.Fatalf("set sync_url: %v", err)
	}
	if err := db.SetConfig("sync_target", target); err != nil {
		t.Fatalf("set sync_target: %v", err)
	}
	return New(db), target
}

// runSync starts a sync and waits for it to finish (or fails on timeout).
func runSync(t *testing.T, e *Engine) Status {
	t.Helper()
	if _, err := e.Start(context.Background()); err != nil {
		t.Fatalf("Start: %v", err)
	}
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if !e.Running() {
			return e.Status()
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("sync did not finish within deadline (phase=%s)", e.Status().Phase)
	return Status{}
}

func TestSyncDiffThenFetch(t *testing.T) {
	stub := &stubServer{
		manifest: []string{"a.txt", "sub/b.txt", "already_here.txt"},
		bodies: map[string]string{
			"a.txt":            "alpha",
			"sub/b.txt":        "bravo",
			"already_here.txt": "should-not-be-fetched",
		},
	}
	srv := httptest.NewServer(stub.handler())
	defer srv.Close()

	e, target := newEngineWithConfig(t, srv.URL)

	// Pre-create one of the manifest files locally so diff skips it.
	if err := os.WriteFile(filepath.Join(target, "already_here.txt"), []byte("existing"), 0o644); err != nil {
		t.Fatalf("pre-create: %v", err)
	}

	st := runSync(t, e)
	if st.Phase != "done" {
		t.Fatalf("phase = %q, want done (msg=%q)", st.Phase, st.LastRunMessage)
	}

	fetched := stub.fetchedPaths()
	for _, p := range fetched {
		if p == "already_here.txt" {
			t.Errorf("diff should have skipped the locally-present file, but it was fetched")
		}
	}
	if len(fetched) != 2 {
		t.Errorf("expected exactly 2 fetches (a.txt, sub/b.txt), got %v", fetched)
	}
	// The two missing files must now exist with the right content.
	if b, _ := os.ReadFile(filepath.Join(target, "a.txt")); string(b) != "alpha" {
		t.Errorf("a.txt content = %q, want alpha", b)
	}
	if b, _ := os.ReadFile(filepath.Join(target, "sub", "b.txt")); string(b) != "bravo" {
		t.Errorf("sub/b.txt content = %q, want bravo", b)
	}
	// The pre-existing file must be untouched (not overwritten).
	if b, _ := os.ReadFile(filepath.Join(target, "already_here.txt")); string(b) != "existing" {
		t.Errorf("pre-existing file was overwritten: %q", b)
	}
	if st.FilesDone != 2 {
		t.Errorf("FilesDone = %d, want 2", st.FilesDone)
	}
}

func TestSyncSkipsZeroByteFiles(t *testing.T) {
	stub := &stubServer{
		manifest: []string{"real.txt", "empty.txt"},
		bodies: map[string]string{
			"real.txt":  "content",
			"empty.txt": "", // zero-byte source → must be skipped
		},
	}
	srv := httptest.NewServer(stub.handler())
	defer srv.Close()

	e, target := newEngineWithConfig(t, srv.URL)
	st := runSync(t, e)
	if st.Phase != "done" {
		t.Fatalf("phase = %q, want done", st.Phase)
	}

	if _, err := os.Stat(filepath.Join(target, "empty.txt")); !os.IsNotExist(err) {
		t.Errorf("zero-byte file should NOT have been written, stat err = %v", err)
	}
	if b, _ := os.ReadFile(filepath.Join(target, "real.txt")); string(b) != "content" {
		t.Errorf("real.txt content = %q, want content", b)
	}
	// Skip is silent: neither counted as done nor as an error.
	if st.FilesDone != 1 {
		t.Errorf("FilesDone = %d, want 1 (zero-byte skip not counted)", st.FilesDone)
	}
	if st.Errors != 0 {
		t.Errorf("Errors = %d, want 0 (zero-byte skip is not an error)", st.Errors)
	}
}

func TestSyncSurfacesErrors(t *testing.T) {
	stub := &stubServer{
		manifest: []string{"ok.txt", "boom.txt"},
		bodies: map[string]string{
			"ok.txt": "fine",
		},
		errorPaths: map[string]int{
			"boom.txt": http.StatusInternalServerError,
		},
	}
	srv := httptest.NewServer(stub.handler())
	defer srv.Close()

	e, target := newEngineWithConfig(t, srv.URL)
	st := runSync(t, e)

	// Per-file failure does not abort the run — the good file still lands.
	if b, _ := os.ReadFile(filepath.Join(target, "ok.txt")); string(b) != "fine" {
		t.Errorf("ok.txt should have downloaded despite sibling error: %q", b)
	}
	if st.Errors != 1 {
		t.Errorf("Errors = %d, want 1", st.Errors)
	}
	if len(st.RecentErrors) != 1 {
		t.Fatalf("RecentErrors len = %d, want 1", len(st.RecentErrors))
	}
	if st.RecentErrors[0].Path != "boom.txt" {
		t.Errorf("error path = %q, want boom.txt", st.RecentErrors[0].Path)
	}
	if !strings.Contains(st.RecentErrors[0].Message, "500") {
		t.Errorf("error message should mention HTTP 500, got %q", st.RecentErrors[0].Message)
	}
	if st.FilesDone != 1 {
		t.Errorf("FilesDone = %d, want 1 (only ok.txt)", st.FilesDone)
	}
}

func TestSyncRequiresURL(t *testing.T) {
	db, err := databank.Open(t.TempDir())
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer db.Close()
	e := New(db)
	if _, err := e.Start(context.Background()); err == nil {
		t.Errorf("Start without sync_url should error")
	}
}
