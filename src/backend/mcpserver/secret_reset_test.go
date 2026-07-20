package mcpserver

import (
	"os"
	"path/filepath"
	"testing"
)

func TestResetSecretOnce(t *testing.T) {
	dir := t.TempDir()

	// Fresh install: no secret yet → nothing to invalidate, marker written,
	// no rotation reported.
	rotated, err := ResetSecretOnce(dir)
	if err != nil {
		t.Fatal(err)
	}
	if rotated {
		t.Fatal("fresh install must not report a rotation")
	}
	if _, err := os.Stat(filepath.Join(dir, secretResetMarker)); err != nil {
		t.Fatalf("marker not written on fresh install: %v", err)
	}

	// Existing install upgrading: pre-existing secret + no marker → rotate once.
	dir2 := t.TempDir()
	old, err := EnsureSecret(dir2)
	if err != nil {
		t.Fatal(err)
	}
	rotated, err = ResetSecretOnce(dir2)
	if err != nil {
		t.Fatal(err)
	}
	if !rotated {
		t.Fatal("upgrade with existing secret must rotate")
	}
	fresh, err := EnsureSecret(dir2)
	if err != nil {
		t.Fatal(err)
	}
	if fresh == old {
		t.Fatal("secret unchanged after reset")
	}

	// Second boot: marker present → no further rotation.
	rotated, err = ResetSecretOnce(dir2)
	if err != nil {
		t.Fatal(err)
	}
	if rotated {
		t.Fatal("reset must happen exactly once")
	}
	again, _ := EnsureSecret(dir2)
	if again != fresh {
		t.Fatal("secret must be stable after the one-time reset")
	}
}
