package databank

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// DonorSnapshotEntry is one donor keyed by its stable relative library path.
type DonorSnapshotEntry struct {
	Path        string `json:"path"`
	AddedAt     int64  `json:"added_at"`
	ContentHash string `json:"content_hash,omitempty"` // hex; secondary resolver for moved files
}

// DonorSnapshot is the path-keyed backup of the donor list.
type DonorSnapshot struct {
	Version   int                  `json:"version"`
	CreatedAt int64                `json:"created_at"`
	Donors    []DonorSnapshotEntry `json:"donors"`
}

// DonorBackupInfo describes a snapshot file on disk (no body).
type DonorBackupInfo struct {
	Name      string `json:"name"`
	CreatedAt int64  `json:"created_at"`
	Count     int    `json:"count"`
}

const donorSnapshotVersion = 1

// WriteDonorSnapshot writes snap atomically to <dir>/donors-<CreatedAt>.json,
// creating dir if needed. Returns the full path.
func WriteDonorSnapshot(dir string, snap *DonorSnapshot) (string, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	name := fmt.Sprintf("donors-%d.json", snap.CreatedAt)
	full := filepath.Join(dir, name)
	data, err := json.MarshalIndent(snap, "", "  ")
	if err != nil {
		return "", err
	}
	tmp := full + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return "", err
	}
	if err := os.Rename(tmp, full); err != nil {
		return "", err
	}
	return full, nil
}

// ReadDonorSnapshot decodes a snapshot file.
func ReadDonorSnapshot(path string) (*DonorSnapshot, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var snap DonorSnapshot
	if err := json.Unmarshal(data, &snap); err != nil {
		return nil, err
	}
	return &snap, nil
}

// ListDonorSnapshots returns snapshot metadata newest-first. A missing dir is
// not an error (returns empty).
func ListDonorSnapshots(dir string) ([]DonorBackupInfo, error) {
	ents, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var out []DonorBackupInfo
	for _, e := range ents {
		if e.IsDir() || !strings.HasPrefix(e.Name(), "donors-") || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		snap, err := ReadDonorSnapshot(filepath.Join(dir, e.Name()))
		if err != nil {
			continue // skip corrupt files rather than failing the whole list
		}
		out = append(out, DonorBackupInfo{Name: e.Name(), CreatedAt: snap.CreatedAt, Count: len(snap.Donors)})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt > out[j].CreatedAt })
	return out, nil
}

// PruneDonorSnapshots deletes all but the newest keep snapshots.
func PruneDonorSnapshots(dir string, keep int) error {
	infos, err := ListDonorSnapshots(dir)
	if err != nil {
		return err
	}
	for i := keep; i < len(infos); i++ {
		_ = os.Remove(filepath.Join(dir, infos[i].Name))
	}
	return nil
}
