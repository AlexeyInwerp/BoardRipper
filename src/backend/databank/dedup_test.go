package databank

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
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
