package databank

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func writeFile(t *testing.T, dir, name string, data []byte) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, data, 0644); err != nil {
		t.Fatalf("write: %v", err)
	}
	return p
}

func TestContentKeyIdenticalAndDifferent(t *testing.T) {
	dir := t.TempDir()
	small := bytes.Repeat([]byte("AB"), 100) // 200 bytes (< 192 KiB → full hash)
	a := writeFile(t, dir, "a.bin", small)
	b := writeFile(t, dir, "b.bin", small) // identical content, different name
	c := writeFile(t, dir, "c.bin", bytes.Repeat([]byte("CD"), 100))

	ha, err := ContentKey(a, int64(len(small)))
	if err != nil {
		t.Fatalf("ContentKey a: %v", err)
	}
	hb, _ := ContentKey(b, int64(len(small)))
	hc, _ := ContentKey(c, int64(len(small)))
	if !bytes.Equal(ha, hb) {
		t.Errorf("identical files must share content key")
	}
	if bytes.Equal(ha, hc) {
		t.Errorf("different content must differ")
	}
}

func TestContentKeyLargeSampled(t *testing.T) {
	dir := t.TempDir()
	big := bytes.Repeat([]byte("X"), 1<<20) // 1 MiB
	a := writeFile(t, dir, "big_a.bin", big)
	b := writeFile(t, dir, "big_b.bin", append([]byte("DIFFERENT-HEAD"), big[14:]...))
	ha, _ := ContentKey(a, int64(len(big)))
	hb, _ := ContentKey(b, int64(len(big)))
	if bytes.Equal(ha, hb) {
		t.Errorf("files differing in the head must have different keys")
	}
}

func mustSizeCollisions(t *testing.T, db *DB) []CollisionFile {
	t.Helper()
	files, err := db.SizeCollisionFiles()
	if err != nil {
		t.Fatalf("SizeCollisionFiles: %v", err)
	}
	return files
}

func TestHashCollisionsParallel(t *testing.T) {
	dir := t.TempDir()
	db, _ := Open(dir)
	defer db.Close()

	// A few KB of content; well under the 192 KiB full-hash limit.
	content := bytes.Repeat([]byte("dedup-parallel-content-"), 200) // ~4.6 KB
	other := bytes.Repeat([]byte("a-different-payload-here"), 192)   // same length is irrelevant; we control Size below
	size := int64(len(content))
	// Pad `other` to the SAME size as content so it shares the size bucket.
	if int64(len(other)) < size {
		other = append(other, bytes.Repeat([]byte{'Z'}, int(size-int64(len(other))))...)
	} else {
		other = other[:size]
	}

	// a/x.bin and b/x.bin: identical content, SAME base name "x.bin".
	for _, sub := range []string{"a", "b", "c", "d"} {
		if err := os.MkdirAll(filepath.Join(dir, sub), 0755); err != nil {
			t.Fatalf("mkdir %s: %v", sub, err)
		}
	}
	writeFile(t, dir, filepath.Join("a", "x.bin"), content)
	writeFile(t, dir, filepath.Join("b", "x.bin"), content)
	writeFile(t, dir, filepath.Join("c", "y.bin"), content) // identical bytes, DIFFERENT name
	writeFile(t, dir, filepath.Join("d", "z.bin"), other)   // same size, DIFFERENT content

	ax, _ := db.InsertFile(&FileRecord{Path: "a/x.bin", Filename: "x.bin", Extension: ".bin", FileType: "bin", Size: size, ModTime: 1})
	bx, _ := db.InsertFile(&FileRecord{Path: "b/x.bin", Filename: "x.bin", Extension: ".bin", FileType: "bin", Size: size, ModTime: 1})
	cy, _ := db.InsertFile(&FileRecord{Path: "c/y.bin", Filename: "y.bin", Extension: ".bin", FileType: "bin", Size: size, ModTime: 1})
	dz, _ := db.InsertFile(&FileRecord{Path: "d/z.bin", Filename: "z.bin", Extension: ".bin", FileType: "bin", Size: size, ModTime: 1})

	files := mustSizeCollisions(t, db)
	if len(files) != 4 {
		t.Fatalf("expected 4 size-collision files, got %d", len(files))
	}

	HashCollisions(db, dir, files, 4, func() bool { return false }, nil)

	hAX, _ := db.ContentHashOf(ax)
	hBX, _ := db.ContentHashOf(bx)
	hCY, _ := db.ContentHashOf(cy)
	hDZ, _ := db.ContentHashOf(dz)

	if len(hAX) == 0 || len(hBX) == 0 || len(hCY) == 0 || len(hDZ) == 0 {
		t.Fatalf("all four size-collision files must be hashed: aX=%d bX=%d cY=%d dZ=%d", len(hAX), len(hBX), len(hCY), len(hDZ))
	}
	// Cluster merge: a/x and b/x (same name+size) share via representative.
	if !bytes.Equal(hAX, hBX) {
		t.Errorf("a/x and b/x (same name+size) must share content_hash")
	}
	// Cross-name merge: c/y hashed individually but byte-identical → same hash.
	if !bytes.Equal(hAX, hCY) {
		t.Errorf("c/y (different name, identical bytes) must land in the same content group as a/x")
	}
	// Different content → different hash.
	if bytes.Equal(hAX, hDZ) {
		t.Errorf("d/z (same size, different content) must have a DIFFERENT hash")
	}
}

func TestSizeCollisionsExcludesUniqueSize(t *testing.T) {
	dir := t.TempDir()
	db, _ := Open(dir)
	defer db.Close()
	same := []byte("collision-bucket")
	writeFile(t, dir, "p.bin", same)
	writeFile(t, dir, "q.bin", same)
	writeFile(t, dir, "uniq.bin", []byte("a-uniquely-sized-file-xyz"))
	db.InsertFile(&FileRecord{Path: "p.bin", Filename: "p.bin", Extension: ".bin", FileType: "bin", Size: int64(len(same)), ModTime: 1})
	db.InsertFile(&FileRecord{Path: "q.bin", Filename: "q.bin", Extension: ".bin", FileType: "bin", Size: int64(len(same)), ModTime: 1})
	db.InsertFile(&FileRecord{Path: "uniq.bin", Filename: "uniq.bin", Extension: ".bin", FileType: "bin", Size: 25, ModTime: 1})
	files := mustSizeCollisions(t, db)
	for _, f := range files {
		if f.Path == "uniq.bin" {
			t.Errorf("unique-size file must be excluded from SizeCollisionFiles")
		}
	}
	if len(files) != 2 {
		t.Errorf("expected exactly the 2 collision files, got %d", len(files))
	}
}

func TestDedupRunnerAssignsHashes(t *testing.T) {
	dir := t.TempDir()
	db, _ := Open(dir)
	defer db.Close()
	same := []byte("hello duplicate content")
	writeFile(t, dir, "x.pdf", same)
	writeFile(t, dir, "y.pdf", same)
	writeFile(t, dir, "z.pdf", []byte("unique-size-different"))
	f1, _ := db.InsertFile(&FileRecord{Path: "x.pdf", Filename: "x.pdf", Extension: ".pdf", FileType: "pdf", Size: int64(len(same)), ModTime: 1})
	f2, _ := db.InsertFile(&FileRecord{Path: "y.pdf", Filename: "y.pdf", Extension: ".pdf", FileType: "pdf", Size: int64(len(same)), ModTime: 1})
	db.InsertFile(&FileRecord{Path: "z.pdf", Filename: "z.pdf", Extension: ".pdf", FileType: "pdf", Size: 21, ModTime: 1})

	r := NewDedupRunner(db, func() string { return dir })
	if err := r.Run(); err != nil {
		t.Fatalf("Run: %v", err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) && r.Progress().Running {
		time.Sleep(20 * time.Millisecond)
	}
	h1, _ := db.ContentHashOf(f1)
	h2, _ := db.ContentHashOf(f2)
	if h1 == nil || !bytes.Equal(h1, h2) {
		t.Errorf("identical files x,y must get equal content_hash")
	}
	s, _ := db.DedupStats()
	if s.Groups != 1 || s.DuplicateFiles != 1 {
		t.Errorf("stats = %+v, want 1 group / 1 duplicate", s)
	}
}
