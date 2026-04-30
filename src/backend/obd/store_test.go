package obd

import (
	"os"
	"path/filepath"
	"testing"
)

func TestStore_AtomicWriteAndRead(t *testing.T) {
	dir := t.TempDir()
	s := NewStore(dir)

	idx := &Index{
		SyncedAt: "2026-05-01T12:00:00Z",
		Source:   "https://openboarddata.org",
		Boards:   []IndexEntry{{Bpath: "laptops/apple/820-00045", Brand: "apple", Category: "laptops"}},
	}
	if err := s.WriteIndex(idx); err != nil {
		t.Fatalf("WriteIndex: %v", err)
	}

	// File exists; tmp does not.
	if _, err := os.Stat(filepath.Join(dir, "index.json")); err != nil {
		t.Errorf("index.json missing: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "index.json.tmp")); !os.IsNotExist(err) {
		t.Errorf("tmp file should be gone, stat err = %v", err)
	}

	got, err := s.ReadIndex()
	if err != nil {
		t.Fatalf("ReadIndex: %v", err)
	}
	if len(got.Boards) != 1 || got.Boards[0].Bpath != "laptops/apple/820-00045" {
		t.Errorf("ReadIndex returned %v", got)
	}
}

func TestStore_ReadIndex_NoFile(t *testing.T) {
	s := NewStore(t.TempDir())
	idx, err := s.ReadIndex()
	if err != nil {
		t.Fatalf("ReadIndex on missing file should not error: %v", err)
	}
	if idx != nil {
		t.Errorf("ReadIndex on missing file should return nil, got %v", idx)
	}
}

func TestStore_WriteBoard_AtomicAndFetched(t *testing.T) {
	dir := t.TempDir()
	s := NewStore(dir)

	bpath := "laptops/apple/820-00045"
	raw := "OBDATA_V002\nBRAND apple\n"
	parsed := &ObdData{Bpath: bpath}

	if fetched, _ := s.IsFetched(bpath); fetched {
		t.Error("IsFetched should be false before write")
	}

	if err := s.WriteBoard(bpath, raw, parsed); err != nil {
		t.Fatalf("WriteBoard: %v", err)
	}

	fetched, fetchedAt := s.IsFetched(bpath)
	if !fetched || fetchedAt == nil {
		t.Errorf("IsFetched after WriteBoard = (%v, %v), want (true, <ts>)", fetched, fetchedAt)
	}

	// Subdir was created.
	if _, err := os.Stat(filepath.Join(dir, "laptops", "apple", "820-00045.txt")); err != nil {
		t.Errorf(".txt missing: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "laptops", "apple", "820-00045.parsed.json")); err != nil {
		t.Errorf(".parsed.json missing: %v", err)
	}
}

func TestStore_DeleteCache(t *testing.T) {
	dir := t.TempDir()
	s := NewStore(dir)
	if err := s.WriteBoard("a/b/c", "OBDATA_V002\n", &ObdData{}); err != nil {
		t.Fatalf("WriteBoard: %v", err)
	}
	if err := s.DeleteCache(); err != nil {
		t.Fatalf("DeleteCache: %v", err)
	}
	// Root dir is recreated empty.
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("ReadDir: %v", err)
	}
	if len(entries) != 0 {
		t.Errorf("DeleteCache should leave dir empty, got %v", entries)
	}
}

func TestStore_ValidatesBpath(t *testing.T) {
	s := NewStore(t.TempDir())
	bad := []string{"../escape", "/abs/path", "a/../b", "a/b/", "", "..", "a//b"}
	for _, b := range bad {
		if err := s.WriteBoard(b, "OBDATA_V002", &ObdData{}); err == nil {
			t.Errorf("WriteBoard(%q) should reject invalid bpath", b)
		}
	}
}
