package obd

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Store wraps the OBD on-disk cache rooted at <data_dir>/obd/ (pre-v0.20.3 was
// <library_root>/.boardripper/openboarddata/; see MigrateLegacyCache).
type Store struct {
	root string
}

// NewStore returns a store rooted at the given absolute directory.
// The directory is created on first write; reads from a missing dir
// return zero values, not errors.
func NewStore(root string) *Store {
	return &Store{root: root}
}

// Root exposes the on-disk root for the cache-delete handler.
func (s *Store) Root() string { return s.root }

func (s *Store) indexPath() string { return filepath.Join(s.root, "index.json") }

// WriteIndex serializes idx to root/index.json via tmp+rename.
func (s *Store) WriteIndex(idx *Index) error {
	if err := os.MkdirAll(s.root, 0o755); err != nil {
		return err
	}
	tmp := s.indexPath() + ".tmp"
	body, err := json.MarshalIndent(idx, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(tmp, body, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, s.indexPath())
}

// ReadIndex reads root/index.json. Returns (nil, nil) when the file is missing.
func (s *Store) ReadIndex() (*Index, error) {
	body, err := os.ReadFile(s.indexPath())
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var idx Index
	if err := json.Unmarshal(body, &idx); err != nil {
		return nil, fmt.Errorf("decode index.json: %w", err)
	}
	return &idx, nil
}

// validateBpath rejects bpaths that would escape the cache root or are otherwise malformed.
func validateBpath(bpath string) error {
	if bpath == "" {
		return errors.New("bpath: empty")
	}
	if strings.HasPrefix(bpath, "/") || strings.HasPrefix(bpath, "..") {
		return errors.New("bpath: must be relative")
	}
	if strings.Contains(bpath, "//") || strings.HasSuffix(bpath, "/") {
		return errors.New("bpath: malformed")
	}
	for _, seg := range strings.Split(bpath, "/") {
		if seg == "." || seg == ".." || seg == "" {
			return errors.New("bpath: contains forbidden segment")
		}
	}
	return nil
}

func (s *Store) bpathPaths(bpath string) (txt, parsed string) {
	base := filepath.Join(s.root, filepath.FromSlash(bpath))
	return base + ".txt", base + ".parsed.json"
}

// IsFetched reports whether <bpath>.txt exists on disk and (if so) its
// modification time as RFC3339.
func (s *Store) IsFetched(bpath string) (bool, *string) {
	if err := validateBpath(bpath); err != nil {
		return false, nil
	}
	txt, _ := s.bpathPaths(bpath)
	st, err := os.Stat(txt)
	if err != nil {
		return false, nil
	}
	t := st.ModTime().UTC().Format(time.RFC3339)
	return true, &t
}

// WriteBoard atomically writes both the raw text and the parsed JSON.
// Both files use tmp+rename. Parent directories are created as needed.
func (s *Store) WriteBoard(bpath, raw string, parsed *ObdData) error {
	if err := validateBpath(bpath); err != nil {
		return err
	}
	txtPath, parsedPath := s.bpathPaths(bpath)
	if err := os.MkdirAll(filepath.Dir(txtPath), 0o755); err != nil {
		return err
	}

	if err := writeAtomic(txtPath, []byte(raw)); err != nil {
		return err
	}
	body, err := json.MarshalIndent(parsed, "", "  ")
	if err != nil {
		return err
	}
	return writeAtomic(parsedPath, body)
}

// ReadParsed loads the cached parsed payload for the given bpath, or
// (nil, nil) when missing. Normalises nil slices to empty so older
// cached files (parsed before the slice-init fix) round-trip cleanly
// through the JSON contract the frontend relies on.
func (s *Store) ReadParsed(bpath string) (*ObdData, error) {
	if err := validateBpath(bpath); err != nil {
		return nil, err
	}
	_, parsedPath := s.bpathPaths(bpath)
	body, err := os.ReadFile(parsedPath)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var d ObdData
	if err := json.Unmarshal(body, &d); err != nil {
		return nil, fmt.Errorf("decode %s: %w", parsedPath, err)
	}
	for i := range d.Nets {
		if d.Nets[i].Aliases == nil {
			d.Nets[i].Aliases = []string{}
		}
		if d.Nets[i].Comments == nil {
			d.Nets[i].Comments = []string{}
		}
	}
	if d.Sections == nil {
		d.Sections = []DiagnosisSection{}
	}
	for i := range d.Sections {
		if d.Sections[i].Notes == nil {
			d.Sections[i].Notes = []DiagnosisNote{}
		}
	}
	return &d, nil
}

// DeleteCache removes the entire cache directory and recreates it empty.
func (s *Store) DeleteCache() error {
	if err := os.RemoveAll(s.root); err != nil {
		return err
	}
	return os.MkdirAll(s.root, 0o755)
}

// MigrateLegacyCache moves a v0.20.2-or-earlier cache from the old library-rooted
// path to the new dataDir-rooted path, ONCE. Called from main.go before NewStore
// so the resulting store opens against the migrated content.
//
// Behavior:
//   - If newRoot already has any content → no-op (already migrated, or fresh
//     install that started syncing on the new layout). Silent.
//   - If neither candidate path exists → no-op. Silent.
//   - If a candidate exists and os.Rename works → log success and return.
//   - If os.Rename fails (typically EXDEV when /library and /data are different
//     mounts) → log a hint that the user should re-sync via
//     POST /api/obd/index/sync. Do NOT recursively copy — keeps the helper tiny.
//
// candidates is the list of legacy paths to probe in order. Caller passes
// {configLibRoot, libraryDirEnv} — both can be empty strings, which are skipped.
func MigrateLegacyCache(newRoot string, candidates []string) {
	// Skip if new root already has content.
	if entries, err := os.ReadDir(newRoot); err == nil && len(entries) > 0 {
		return
	}
	for _, libRoot := range candidates {
		if libRoot == "" {
			continue
		}
		old := filepath.Join(libRoot, ".boardripper", "openboarddata")
		info, err := os.Stat(old)
		if err != nil || !info.IsDir() {
			continue
		}
		// Ensure the parent of newRoot exists; rename will fail if not.
		if err := os.MkdirAll(filepath.Dir(newRoot), 0o755); err != nil {
			log.Printf("OBD migrate: mkdir parent of %s failed: %v", newRoot, err)
			return
		}
		if err := os.Rename(old, newRoot); err == nil {
			log.Printf("OBD migrate: moved cache from %s to %s", old, newRoot)
			return
		} else {
			log.Printf("OBD migrate: rename %s → %s failed (%v); user can re-sync via /api/obd/index/sync", old, newRoot, err)
			// Don't try further candidates after a rename attempt — the user
			// only had ONE active cache; the failure was filesystem-level
			// (likely EXDEV cross-volume) and trying another candidate
			// won't help.
			return
		}
	}
}

func writeAtomic(path string, body []byte) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, body, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
