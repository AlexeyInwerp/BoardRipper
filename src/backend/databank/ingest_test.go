package databank

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

// writeNested is writeFile plus parent-directory creation.
func writeNested(t *testing.T, dir, name string, data []byte) string {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(filepath.Join(dir, name)), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	return writeFile(t, dir, name, data)
}

// FindIdenticalFile must (a) match a stored byte-identical file under any
// name/folder, hashing the unhashed candidate on the way; (b) return a key but
// no match for a same-size-different-bytes file; (c) return neither for a
// unique size, without reading anything.
func TestFindIdenticalFile(t *testing.T) {
	dir := t.TempDir()
	db, err := Open(dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer db.Close()

	same := []byte("identical-content-of-a-boardview-file")
	writeNested(t, dir, "Apple/820-1/orig.brd", same)
	idOrig, _ := db.InsertFile(&FileRecord{Path: "Apple/820-1/orig.brd", Filename: "orig.brd", Extension: ".brd", FileType: "board", Size: int64(len(same)), ModTime: 1})

	s := NewScanner(db, dir, dir)

	// (a) identical bytes under a different name → match, and the candidate
	// gets its hash persisted.
	drop := writeFile(t, dir, "drop-copy.brd", same)
	match, key, err := s.FindIdenticalFile(drop, int64(len(same)))
	if err != nil {
		t.Fatalf("FindIdenticalFile: %v", err)
	}
	if match == nil || match.ID != idOrig {
		t.Fatalf("expected match id=%d, got %+v", idOrig, match)
	}
	if h, _ := db.ContentHashOf(idOrig); !bytes.Equal(h, key) {
		t.Fatalf("candidate hash not persisted / mismatched: %x vs %x", h, key)
	}

	// (b) same size, different bytes → no match but a key to store.
	diff := []byte("IDENTICAL-CONTENT-OF-A-BOARDVIEW-FILE")
	drop2 := writeFile(t, dir, "drop-diff.brd", diff)
	match, key, err = s.FindIdenticalFile(drop2, int64(len(diff)))
	if err != nil {
		t.Fatalf("FindIdenticalFile: %v", err)
	}
	if match != nil {
		t.Fatalf("expected no match for different bytes, got id=%d", match.ID)
	}
	if key == nil {
		t.Fatalf("expected a content key for a size collision")
	}

	// (c) unique size → nothing hashed at all.
	uniq := writeFile(t, dir, "drop-uniq.brd", []byte("a-uniquely-sized-file"))
	match, key, err = s.FindIdenticalFile(uniq, 21)
	if err != nil || match != nil || key != nil {
		t.Fatalf("unique size: want (nil,nil,nil), got (%v,%x,%v)", match, key, err)
	}
}

// IndexFile stores the ingest-time hash on a new row and re-queues a PDF
// whose bytes changed under an existing path.
func TestIndexFile_StoresHashAndRequeuesModifiedPdf(t *testing.T) {
	dir := t.TempDir()
	db, err := Open(dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer db.Close()
	s := NewScanner(db, dir, dir)

	var requeued []int64
	s.SetPdfModifiedHook(func(id int64) error { requeued = append(requeued, id); return nil })

	writeNested(t, dir, "incoming/x.pdf", []byte("%PDF-1.4 one"))
	rec, err := s.IndexFile("incoming/x.pdf", []byte{1, 2, 3})
	if err != nil {
		t.Fatalf("IndexFile: %v", err)
	}
	if h, _ := db.ContentHashOf(rec.ID); !bytes.Equal(h, []byte{1, 2, 3}) {
		t.Fatalf("content hash not stored on new row: %x", h)
	}
	if len(requeued) != 0 {
		t.Fatalf("new row must not fire the modified hook, got %v", requeued)
	}

	// Same path, different size → update branch → hook fires once.
	writeNested(t, dir, "incoming/x.pdf", []byte("%PDF-1.4 two, longer"))
	rec2, err := s.IndexFile("incoming/x.pdf", nil)
	if err != nil {
		t.Fatalf("IndexFile(update): %v", err)
	}
	if rec2.ID != rec.ID {
		t.Fatalf("update must keep the id: %d vs %d", rec2.ID, rec.ID)
	}
	if len(requeued) != 1 || requeued[0] != rec.ID {
		t.Fatalf("expected modified hook for id=%d, got %v", rec.ID, requeued)
	}
}
