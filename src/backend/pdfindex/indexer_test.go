package pdfindex

import (
	"testing"
	"time"
)

type fakeSource struct {
	files []PdfFile
	data  map[string][]byte
}

func (f *fakeSource) ListPDFs() ([]PdfFile, error)      { return f.files, nil }
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
