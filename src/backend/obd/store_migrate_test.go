package obd

import (
	"os"
	"path/filepath"
	"testing"
)

func TestMigrateLegacyCache_emptyNewRoot_renamesFromCandidate(t *testing.T) {
	tmp := t.TempDir()
	dataDir := filepath.Join(tmp, "data")
	libDir := filepath.Join(tmp, "library")
	oldCache := filepath.Join(libDir, ".boardripper", "openboarddata")
	newCache := filepath.Join(dataDir, "obd")

	if err := os.MkdirAll(oldCache, 0o755); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(oldCache, "marker.json")
	if err := os.WriteFile(marker, []byte(`{"x":1}`), 0o644); err != nil {
		t.Fatal(err)
	}

	MigrateLegacyCache(newCache, []string{libDir})

	if _, err := os.Stat(filepath.Join(newCache, "marker.json")); err != nil {
		t.Fatalf("expected marker at new cache: %v", err)
	}
	if _, err := os.Stat(oldCache); !os.IsNotExist(err) {
		t.Fatalf("expected old cache to be gone, stat err = %v", err)
	}
}

func TestMigrateLegacyCache_newRootHasContent_noop(t *testing.T) {
	tmp := t.TempDir()
	libDir := filepath.Join(tmp, "library")
	oldCache := filepath.Join(libDir, ".boardripper", "openboarddata")
	newCache := filepath.Join(tmp, "data", "obd")

	if err := os.MkdirAll(oldCache, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(oldCache, "old.json"), []byte("o"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(newCache, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(newCache, "new.json"), []byte("n"), 0o644); err != nil {
		t.Fatal(err)
	}

	MigrateLegacyCache(newCache, []string{libDir})

	if _, err := os.Stat(filepath.Join(oldCache, "old.json")); err != nil {
		t.Fatalf("expected old cache to still exist: %v", err)
	}
	if _, err := os.Stat(filepath.Join(newCache, "new.json")); err != nil {
		t.Fatalf("expected new cache to still exist: %v", err)
	}
}

func TestMigrateLegacyCache_noCandidates_noop(t *testing.T) {
	tmp := t.TempDir()
	newCache := filepath.Join(tmp, "data", "obd")

	MigrateLegacyCache(newCache, []string{filepath.Join(tmp, "nonexistent")})

	if _, err := os.Stat(newCache); !os.IsNotExist(err) {
		t.Fatalf("expected newCache not to exist, got %v", err)
	}
}

func TestMigrateLegacyCache_emptyCandidates_skipsBlanks(t *testing.T) {
	tmp := t.TempDir()
	newCache := filepath.Join(tmp, "data", "obd")
	MigrateLegacyCache(newCache, []string{"", ""})
	if _, err := os.Stat(newCache); !os.IsNotExist(err) {
		t.Fatalf("expected newCache not to exist, got %v", err)
	}
}
