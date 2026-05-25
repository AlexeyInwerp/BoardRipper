package databank

import (
	"bytes"
	"testing"
)

// TestScanDedupsSizeCollisions exercises the scan-time dedup phase helper in
// isolation: two byte-identical files (same size) must end up sharing a
// content_hash with the lower id as canonical, while a unique-size file is
// never read and keeps a NULL hash.
func TestScanDedupsSizeCollisions(t *testing.T) {
	dir := t.TempDir()
	db, err := Open(dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer db.Close()

	same := []byte("scan-time duplicate content")
	writeFile(t, dir, "a.pdf", same)
	writeFile(t, dir, "b.pdf", same) // identical content + size, different name
	writeFile(t, dir, "c.pdf", []byte("a-uniquely-sized-file"))

	fa, _ := db.InsertFile(&FileRecord{Path: "a.pdf", Filename: "a.pdf", Extension: ".pdf", FileType: "pdf", Size: int64(len(same)), ModTime: 1})
	fb, _ := db.InsertFile(&FileRecord{Path: "b.pdf", Filename: "b.pdf", Extension: ".pdf", FileType: "pdf", Size: int64(len(same)), ModTime: 1})
	fc, _ := db.InsertFile(&FileRecord{Path: "c.pdf", Filename: "c.pdf", Extension: ".pdf", FileType: "pdf", Size: 21, ModTime: 1})

	// libraryDir (third arg) is the temp dir, so ScanRoot() resolves there and
	// relative paths join back to the real files on disk.
	s := NewScanner(db, dir, dir)
	if got := s.ScanRoot(); got != dir {
		t.Fatalf("ScanRoot = %q, want temp dir %q", got, dir)
	}

	s.dedupSizeCollisions(func() bool { return false })

	ha, err := db.ContentHashOf(fa)
	if err != nil {
		t.Fatalf("ContentHashOf(a): %v", err)
	}
	hb, _ := db.ContentHashOf(fb)
	if len(ha) == 0 || !bytes.Equal(ha, hb) {
		t.Fatalf("identical files a,b must share a non-empty content_hash; got a=%x b=%x", ha, hb)
	}

	canon, err := db.CanonicalForHash(ha)
	if err != nil {
		t.Fatalf("CanonicalForHash: %v", err)
	}
	if canon != fa {
		t.Errorf("canonical = %d, want lower id %d", canon, fa)
	}
	if fb <= fa {
		t.Fatalf("test setup invariant broken: expected fb (%d) > fa (%d)", fb, fa)
	}

	// Unique-size file must never be hashed.
	hc, _ := db.ContentHashOf(fc)
	if len(hc) != 0 {
		t.Errorf("unique-size file must keep NULL hash; got %x", hc)
	}
}
