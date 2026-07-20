package mcpserver

import (
	"os"
	"path/filepath"
	"testing"
)

func TestPairing_MintIdempotentAndLabelUpdate(t *testing.T) {
	dir := t.TempDir()
	ps, err := LoadPairings(dir)
	if err != nil {
		t.Fatal(err)
	}
	tok1, err := ps.PairClient("c1", "Alex")
	if err != nil {
		t.Fatal(err)
	}
	if len(tok1) != 64 {
		t.Fatalf("token len = %d, want 64 hex chars", len(tok1))
	}
	tok2, err := ps.PairClient("c1", "Alex bench 2")
	if err != nil {
		t.Fatal(err)
	}
	if tok1 != tok2 {
		t.Fatal("re-pairing the same client minted a new token")
	}
	if got := ps.LabelFor("c1"); got != "Alex bench 2" {
		t.Fatalf("label not updated on re-pair: %q", got)
	}
	if id, ok := ps.ClientForToken(tok1); !ok || id != "c1" {
		t.Fatalf("ClientForToken = %q, %v; want c1, true", id, ok)
	}
}

func TestPairing_RotateInvalidatesOld(t *testing.T) {
	ps, err := LoadPairings(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	old, _ := ps.PairClient("c1", "A")
	fresh, err := ps.Rotate("c1")
	if err != nil {
		t.Fatal(err)
	}
	if fresh == old {
		t.Fatal("rotate returned the same token")
	}
	if _, ok := ps.ClientForToken(old); ok {
		t.Fatal("old token still resolves after rotate")
	}
	if id, ok := ps.ClientForToken(fresh); !ok || id != "c1" {
		t.Fatalf("fresh token: got %q, %v", id, ok)
	}
	if _, err := ps.Rotate("never-paired"); err == nil {
		t.Fatal("rotate of unknown client should error")
	}
}

func TestPairing_PersistsAcrossReload(t *testing.T) {
	dir := t.TempDir()
	ps, _ := LoadPairings(dir)
	tok, _ := ps.PairClient("c9", "Marc")

	info, err := os.Stat(filepath.Join(dir, "mcp-pairings.json"))
	if err != nil {
		t.Fatalf("pairings file not written: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("file mode = %o, want 600", info.Mode().Perm())
	}

	ps2, err := LoadPairings(dir)
	if err != nil {
		t.Fatal(err)
	}
	if id, ok := ps2.ClientForToken(tok); !ok || id != "c9" {
		t.Fatalf("after reload: got %q, %v", id, ok)
	}
	if got := ps2.LabelFor("c9"); got != "Marc" {
		t.Fatalf("label after reload = %q", got)
	}
}

func TestPairing_UnknownToken(t *testing.T) {
	ps, _ := LoadPairings(t.TempDir())
	if _, ok := ps.ClientForToken("deadbeef"); ok {
		t.Fatal("unknown token resolved")
	}
	if _, ok := ps.ClientForToken(""); ok {
		t.Fatal("empty token resolved")
	}
}
