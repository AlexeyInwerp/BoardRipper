package updater

import (
	"os"
	"path/filepath"
	"testing"
)

func TestEnsureSecret_GeneratesIfMissing(t *testing.T) {
	dir := t.TempDir()
	secret, err := EnsureSecret(dir)
	if err != nil {
		t.Fatalf("EnsureSecret: %v", err)
	}
	if len(secret) < 32 {
		t.Errorf("secret too short: %d chars", len(secret))
	}
	if _, err := os.Stat(filepath.Join(dir, ".update-secret")); err != nil {
		t.Errorf("secret file not written: %v", err)
	}
}

func TestEnsureSecret_StableAcrossCalls(t *testing.T) {
	dir := t.TempDir()
	a, _ := EnsureSecret(dir)
	b, _ := EnsureSecret(dir)
	if a != b {
		t.Errorf("secret regenerated unexpectedly")
	}
}

func TestEnsureSecret_FilePermissions(t *testing.T) {
	dir := t.TempDir()
	_, err := EnsureSecret(dir)
	if err != nil {
		t.Fatal(err)
	}
	info, _ := os.Stat(filepath.Join(dir, ".update-secret"))
	if mode := info.Mode().Perm(); mode != 0o600 {
		t.Errorf("expected mode 0600, got %o", mode)
	}
}
