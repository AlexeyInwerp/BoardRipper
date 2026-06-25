package databank

import (
	"path/filepath"
	"testing"
)

func TestWriteListReadDonorSnapshot(t *testing.T) {
	dir := t.TempDir()
	snap := &DonorSnapshot{
		Version: 1, CreatedAt: 1000,
		Donors: []DonorSnapshotEntry{
			{Path: "a/x.pdf", AddedAt: 900},
			{Path: "b/y.pdf", AddedAt: 950, ContentHash: "deadbeef"},
		},
	}
	p, err := WriteDonorSnapshot(dir, snap)
	if err != nil {
		t.Fatalf("Write: %v", err)
	}
	if filepath.Dir(p) != dir {
		t.Errorf("snapshot path %q not under %q", p, dir)
	}

	infos, err := ListDonorSnapshots(dir)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(infos) != 1 || infos[0].Count != 2 || infos[0].CreatedAt != 1000 {
		t.Fatalf("infos = %+v, want one with count 2 / created 1000", infos)
	}

	got, err := ReadDonorSnapshot(p)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if len(got.Donors) != 2 || got.Donors[1].ContentHash != "deadbeef" {
		t.Fatalf("read snapshot = %+v", got)
	}
}

func TestPruneKeepsNewest(t *testing.T) {
	dir := t.TempDir()
	for _, ts := range []int64{100, 200, 300, 400} {
		if _, err := WriteDonorSnapshot(dir, &DonorSnapshot{Version: 1, CreatedAt: ts}); err != nil {
			t.Fatalf("Write %d: %v", ts, err)
		}
	}
	if err := PruneDonorSnapshots(dir, 2); err != nil {
		t.Fatalf("Prune: %v", err)
	}
	infos, _ := ListDonorSnapshots(dir)
	if len(infos) != 2 || infos[0].CreatedAt != 400 || infos[1].CreatedAt != 300 {
		t.Fatalf("after prune = %+v, want 400,300", infos)
	}
}

func TestListMissingDirIsEmpty(t *testing.T) {
	infos, err := ListDonorSnapshots(filepath.Join(t.TempDir(), "nope"))
	if err != nil {
		t.Fatalf("List missing: %v", err)
	}
	if len(infos) != 0 {
		t.Fatalf("want empty, got %+v", infos)
	}
}
