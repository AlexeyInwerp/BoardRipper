package pdfindex

import (
	"strings"
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
	// Progress.Total must be 1 (only file 2 is pending).
	p := ix.Progress()
	if p.Total != 1 {
		t.Errorf("Progress.Total = %d, want 1 (pending only)", p.Total)
	}

	waitFor(t, func() bool { return !ix.Progress().Running })
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
	// Total should be 2 (sub/a.pdf and sub/b.pdf only).
	p := ix.Progress()
	if p.Total != 2 {
		t.Errorf("Progress.Total = %d, want 2 (sub/ only)", p.Total)
	}

	waitFor(t, func() bool { return !ix.Progress().Running })

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
