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
