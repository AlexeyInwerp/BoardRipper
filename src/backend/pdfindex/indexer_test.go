package pdfindex

import (
	"strings"
	"sync"
	"testing"
	"time"
)

type fakeSource struct {
	files []PdfFile
	data  map[string][]byte
}

func (f *fakeSource) ListPDFs() ([]PdfFile, error) { return f.files, nil }

func (f *fakeSource) ListPDFsUnder(prefix string) ([]PdfFile, error) {
	p := strings.Trim(prefix, "/")
	if p == "" {
		return f.files, nil
	}
	var out []PdfFile
	for _, file := range f.files {
		fp := strings.Trim(file.Path, "/")
		if fp == p || strings.HasPrefix(fp, p+"/") {
			out = append(out, file)
		}
	}
	return out, nil
}

func (f *fakeSource) ReadFile(p string) ([]byte, error) { return f.data[p], nil }

func (f *fakeSource) CanonicalFor(fileID int64) (int64, bool, error) { return 0, false, nil }

type fakeExtractor struct{}

func (fakeExtractor) ExtractFile(b []byte) ([]string, error) { return []string{string(b)}, nil }

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("condition not met within timeout")
}

func TestIndexerRunIndexesAll(t *testing.T) {
	db := openTestDB(t)
	src := &fakeSource{
		files: []PdfFile{{ID: 1, Path: "a.pdf"}, {ID: 2, Path: "b.pdf"}},
		data:  map[string][]byte{"a.pdf": []byte("alpha connector"), "b.pdf": []byte("beta usb")},
	}
	ix := NewIndexer(db, fakeExtractor{}, src, func() []string { return nil }, 2)
	if err := ix.Run(); err != nil {
		t.Fatalf("Run: %v", err)
	}
	waitFor(t, func() bool { return !ix.Progress().Running })
	s, _ := db.Stats()
	if s.Indexed != 2 || s.Pages != 2 {
		t.Errorf("stats after run = %+v, want 2 indexed / 2 pages", s)
	}
}

// TestPendingFilter verifies that Run() pre-filters already-indexed files so
// Progress.Total reflects only the genuinely pending count.
func TestPendingFilter(t *testing.T) {
	db := openTestDB(t)
	src := &fakeSource{
		files: []PdfFile{
			{ID: 1, Path: "a.pdf"},
			{ID: 2, Path: "b.pdf"},
		},
		data: map[string][]byte{
			"a.pdf": []byte("alpha connector"),
			"b.pdf": []byte("beta usb"),
		},
	}
	ix := NewIndexer(db, fakeExtractor{}, src, func() []string { return nil }, 2)

	// Pre-index file 1 so it shows as 'indexed' in the store.
	if won, err := db.Claim(1, "pdfium"); err != nil || !won {
		t.Fatalf("Claim(1): won=%v err=%v", won, err)
	}
	if err := db.UpsertPages(1, []Page{{Num: 1, Text: "alpha connector"}}); err != nil {
		t.Fatalf("UpsertPages: %v", err)
	}
	if _, err := db.Finalize(1); err != nil {
		t.Fatalf("Finalize: %v", err)
	}

	if err := ix.Run(); err != nil {
		t.Fatalf("Run: %v", err)
	}
	waitFor(t, func() bool { return !ix.Progress().Running })
	// Progress.Total must be 1 (only file 2 is pending; enumeration now runs
	// asynchronously, so read Total after the sweep settles — it persists).
	if p := ix.Progress(); p.Total != 1 {
		t.Errorf("Progress.Total = %d, want 1 (pending only)", p.Total)
	}
	s, _ := db.Stats()
	if s.Indexed != 2 {
		t.Errorf("stats.Indexed = %d, want 2", s.Indexed)
	}
}

// TestRunFolder verifies that RunFolder indexes only files under the given prefix.
func TestRunFolder(t *testing.T) {
	db := openTestDB(t)
	src := &fakeSource{
		files: []PdfFile{
			{ID: 1, Path: "top.pdf"},
			{ID: 2, Path: "sub/a.pdf"},
			{ID: 3, Path: "sub/b.pdf"},
		},
		data: map[string][]byte{
			"top.pdf": []byte("top level doc"),
			"sub/a.pdf": []byte("sub alpha"),
			"sub/b.pdf": []byte("sub beta"),
		},
	}
	ix := NewIndexer(db, fakeExtractor{}, src, func() []string { return nil }, 2)

	if err := ix.RunFolder("sub"); err != nil {
		t.Fatalf("RunFolder: %v", err)
	}
	waitFor(t, func() bool { return !ix.Progress().Running })
	// Total should be 2 (sub/a.pdf and sub/b.pdf only). Enumeration is async now,
	// so read Total after the sweep settles — it persists past completion.
	if p := ix.Progress(); p.Total != 2 {
		t.Errorf("Progress.Total = %d, want 2 (sub/ only)", p.Total)
	}

	// File 1 (top.pdf) must NOT be indexed.
	st1, _ := db.Status(1)
	if st1.Status != "" {
		t.Errorf("top.pdf status = %q, want empty (not touched)", st1.Status)
	}
	// Files 2 and 3 must be indexed.
	st2, _ := db.Status(2)
	st3, _ := db.Status(3)
	if st2.Status != "indexed" || st3.Status != "indexed" {
		t.Errorf("sub files: status2=%q status3=%q, both want 'indexed'", st2.Status, st3.Status)
	}
}

// TestRunFolderConflict verifies that RunFolder returns ErrAlreadyRunning when
// a sweep is already in progress, and that Run() is idempotent (returns nil).
func TestRunFolderConflict(t *testing.T) {
	db := openTestDB(t)
	// Use a large set so the sweep is still running when we call RunFolder.
	files := make([]PdfFile, 50)
	data := make(map[string][]byte, 50)
	for i := range files {
		files[i] = PdfFile{ID: int64(i + 1), Path: "f" + string(rune('a'+i%26)) + ".pdf"}
		data[files[i].Path] = []byte("content")
	}
	src := &fakeSource{files: files, data: data}
	ix := NewIndexer(db, fakeExtractor{}, src, func() []string { return nil }, 1)

	if err := ix.Run(); err != nil {
		t.Fatalf("Run: %v", err)
	}
	// While the sweep is running, a second Run must be idempotent (nil).
	if err := ix.Run(); err != nil {
		t.Errorf("second Run while running = %v, want nil", err)
	}
	// RunFolder while running must return ErrAlreadyRunning.
	if err := ix.RunFolder("sub"); err != ErrAlreadyRunning {
		t.Errorf("RunFolder while running = %v, want ErrAlreadyRunning", err)
	}
	waitFor(t, func() bool { return !ix.Progress().Running })
}

// slowSource gates ListPDFsUnder on a channel and counts its invocations, so a
// test can hold a sweep inside enumeration and observe concurrent starts.
type slowSource struct {
	fakeSource
	gate   chan struct{}
	mu     sync.Mutex
	nCalls int
}

func (s *slowSource) ListPDFsUnder(prefix string) ([]PdfFile, error) {
	s.mu.Lock()
	s.nCalls++
	s.mu.Unlock()
	<-s.gate // block until the test releases enumeration
	return s.fakeSource.ListPDFsUnder(prefix)
}

func (s *slowSource) calls() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.nCalls
}

// TestRunFolderClaimsBeforeEnumeration is a regression test for the "index
// folder does nothing for 30-60s, then stacks a 'stop previous index?' prompt
// per click" bug. startScoped must reserve the running slot BEFORE the
// (potentially slow) enumeration, so: (1) the start call returns promptly
// instead of blocking the HTTP response on enumeration, and (2) a concurrent
// start fails fast with ErrAlreadyRunning without running its own full
// enumeration (which is what produced the delayed, stacked 409s).
func TestRunFolderClaimsBeforeEnumeration(t *testing.T) {
	db := openTestDB(t)
	src := &slowSource{
		fakeSource: fakeSource{
			files: []PdfFile{{ID: 1, Path: "sub/a.pdf"}},
			data:  map[string][]byte{"sub/a.pdf": []byte("alpha")},
		},
		gate: make(chan struct{}),
	}
	ix := NewIndexer(db, fakeExtractor{}, src, func() []string { return nil }, 1)

	// First start must return promptly even though enumeration is gated shut. If
	// startScoped still enumerated synchronously this would block until the gate
	// opens and the select below would time out.
	done := make(chan error, 1)
	go func() { done <- ix.RunFolder("sub") }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("first RunFolder = %v, want nil", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("first RunFolder blocked on enumeration (running slot not claimed before IO)")
	}

	// The running slot must be claimed immediately, before enumeration returns.
	waitFor(t, func() bool { return ix.Progress().Running })

	// A concurrent start while enumeration is still gated must fail fast and must
	// NOT invoke its own enumeration.
	if err := ix.RunFolder("sub"); err != ErrAlreadyRunning {
		t.Errorf("second RunFolder = %v, want ErrAlreadyRunning", err)
	}

	// Release enumeration and let the sweep drain.
	close(src.gate)
	waitFor(t, func() bool { return !ix.Progress().Running })

	if n := src.calls(); n != 1 {
		t.Errorf("ListPDFsUnder called %d times, want 1 (concurrent start must not enumerate)", n)
	}
}

func TestStartWatchdogStops(t *testing.T) {
	db := openTestDB(t)
	ix := NewIndexer(db, fakeExtractor{}, &fakeSource{}, func() []string { return nil }, 1)
	stop := ix.StartWatchdog(50*time.Millisecond, 600)
	db.Claim(1, "pdfium")
	db.writer.Exec(`UPDATE pdf_index_status SET attempted_at = 0 WHERE file_id = 1`)
	waitFor(t, func() bool {
		st, _ := db.Status(1)
		return st.Status == "pending"
	})
	close(stop)
}

// fakeSourceDedup adds content-group resolution: canonical maps fileID -> the
// canonical fileID for its group (absent = singleton/no hash).
type fakeSourceDedup struct {
	fakeSource
	canonical map[int64]int64
}

func (f *fakeSourceDedup) CanonicalFor(fileID int64) (int64, bool, error) {
	c, ok := f.canonical[fileID]
	return c, ok, nil
}

func TestRunFilesIndexesOnlyListed(t *testing.T) {
	db := openTestDB(t)
	src := &fakeSource{
		files: []PdfFile{{ID: 1, Path: "a.pdf"}, {ID: 2, Path: "b.pdf"}, {ID: 3, Path: "c.pdf"}},
		data:  map[string][]byte{"a.pdf": []byte("alpha"), "b.pdf": []byte("beta"), "c.pdf": []byte("gamma")},
	}
	ix := NewIndexer(db, fakeExtractor{}, src, func() []string { return nil }, 2)

	if err := ix.RunFiles([]int64{1, 3}); err != nil {
		t.Fatalf("RunFiles: %v", err)
	}
	waitFor(t, func() bool { return !ix.Progress().Running })

	if s, _ := db.Status(1); s.Status != "indexed" {
		t.Errorf("file 1 status = %q, want indexed", s.Status)
	}
	if s, _ := db.Status(3); s.Status != "indexed" {
		t.Errorf("file 3 status = %q, want indexed", s.Status)
	}
	// File 2 was never listed → no status row → empty status string.
	if s, _ := db.Status(2); s.Status != "" {
		t.Errorf("file 2 status = %q, want \"\" (untouched)", s.Status)
	}
}

func TestRunFilesEmptyIsNoop(t *testing.T) {
	db := openTestDB(t)
	ix := NewIndexer(db, fakeExtractor{}, &fakeSource{}, func() []string { return nil }, 1)
	if err := ix.RunFiles(nil); err != nil {
		t.Fatalf("RunFiles(nil): %v", err)
	}
	if ix.Progress().Running {
		t.Error("RunFiles(nil) should not start a sweep")
	}
}

func TestIndexerSkipsDuplicate(t *testing.T) {
	db := openTestDB(t)
	src := &fakeSourceDedup{
		fakeSource: fakeSource{
			files: []PdfFile{{ID: 10, Path: "canon.pdf"}, {ID: 50, Path: "copy.pdf"}},
			data:  map[string][]byte{"canon.pdf": []byte("alpha"), "copy.pdf": []byte("alpha")},
		},
		canonical: map[int64]int64{10: 10, 50: 10}, // 50 is a dup of canonical 10
	}
	ix := NewIndexer(db, fakeExtractor{}, src, func() []string { return nil }, 2)
	ix.Run()
	waitFor(t, func() bool { return !ix.Progress().Running })

	st10, _ := db.Status(10)
	st50, _ := db.Status(50)
	if st10.Status != "indexed" {
		t.Errorf("canonical 10 should be indexed, got %q", st10.Status)
	}
	if st50.Status != "duplicate" {
		t.Errorf("copy 50 should be 'duplicate', got %q", st50.Status)
	}
	// Progress.Done reached Total even though one file was skipped as a duplicate.
	p := ix.Progress()
	if p.Done != p.Total {
		t.Errorf("Done=%d != Total=%d (duplicate skip should still count)", p.Done, p.Total)
	}
}
