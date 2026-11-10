// Package worklists stores repair worklists as one JSON document per file
// under <dataDir>/worklists/<id>.json (spec:
// docs/specs/2026-11-10-worklist-storage-redesign.md).
//
// The server does not interpret a worklist beyond its header fields: id, rev,
// updatedAt and deleted. Everything else (name, board, tags, entries,
// readings…) is the frontend's document and is stored as sent. That keeps the
// on-disk format the frontend's own, so the desktop app's Electron main
// process can read and write the very same directory when no backend runs.
//
// Concurrency: a PUT carries the rev it was based on; a mismatch is a
// conflict and the caller gets the server's copy to merge into (409). The
// server stamps rev and updatedAt, so `since` queries use one clock.
// A delete is a tombstone (deleted = time); tombstones older than
// TombstoneTTL move to worklists/.trash/ at start-up.
package worklists

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

// TombstoneTTL is how long a deleted worklist stays in the live directory (so
// other clients learn about the delete through `since`) before it is moved to
// .trash/.
const TombstoneTTL = 30 * 24 * time.Hour

// MaxDocBytes caps one worklist document.
const MaxDocBytes = 4 << 20

var idRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,80}$`)

// ValidID reports whether id is safe to use as a file name.
func ValidID(id string) bool { return idRe.MatchString(id) }

// ErrConflict is returned by Put when the caller's rev is not the stored one.
var ErrConflict = errors.New("worklist: revision conflict")

// ErrNotFound is returned when no document has the id.
var ErrNotFound = errors.New("worklist: not found")

type header struct {
	ID        string `json:"id"`
	Rev       int64  `json:"rev"`
	UpdatedAt int64  `json:"updatedAt"`
	Deleted   int64  `json:"deleted,omitempty"`
}

type entry struct {
	h   header
	raw []byte
}

// Store is the in-memory index over the directory. Safe for concurrent use.
type Store struct {
	dir string
	mu  sync.RWMutex
	doc map[string]entry
	now func() time.Time
}

// Open loads every <id>.json under dir (created if missing) and moves expired
// tombstones to dir/.trash/.
func Open(dir string) (*Store, error) { return openAt(dir, time.Now) }

func openAt(dir string, now func() time.Time) (*Store, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	s := &Store{dir: dir, doc: map[string]entry{}, now: now}
	ents, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	cutoff := s.now().Add(-TombstoneTTL).UnixMilli()
	for _, de := range ents {
		name := de.Name()
		if de.IsDir() || !strings.HasSuffix(name, ".json") {
			continue
		}
		id := strings.TrimSuffix(name, ".json")
		if !ValidID(id) {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			continue
		}
		var h header
		if json.Unmarshal(raw, &h) != nil || h.ID != id {
			continue
		}
		if h.Deleted != 0 && h.Deleted < cutoff {
			s.trash(id)
			continue
		}
		s.doc[id] = entry{h: h, raw: raw}
	}
	return s, nil
}

func (s *Store) path(id string) string { return filepath.Join(s.dir, id+".json") }

func (s *Store) trash(id string) {
	tdir := filepath.Join(s.dir, ".trash")
	if os.MkdirAll(tdir, 0o755) != nil {
		return
	}
	_ = os.Rename(s.path(id), filepath.Join(tdir, fmt.Sprintf("%s.%d.json", id, s.now().UnixMilli())))
}

// List returns every document changed after since (ms; 0 = all), tombstones
// included, oldest change first, plus the server time the caller should use
// as its next since.
func (s *Store) List(since int64) ([]json.RawMessage, int64) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	es := make([]entry, 0, len(s.doc))
	for _, e := range s.doc {
		if e.h.UpdatedAt > since {
			es = append(es, e)
		}
	}
	sort.Slice(es, func(i, j int) bool { return es[i].h.UpdatedAt < es[j].h.UpdatedAt })
	out := make([]json.RawMessage, len(es))
	for i, e := range es {
		out[i] = json.RawMessage(e.raw)
	}
	return out, s.now().UnixMilli()
}

// Get returns one document, tombstones included.
func (s *Store) Get(id string) (json.RawMessage, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	e, ok := s.doc[id]
	if !ok {
		return nil, ErrNotFound
	}
	return json.RawMessage(e.raw), nil
}

// Put stores body as document id. body's rev must equal the stored rev (0 for
// a new document); on success rev is incremented and updatedAt set to now.
// On ErrConflict the stored document is returned for the caller to merge.
func (s *Store) Put(id string, body []byte) (json.RawMessage, error) {
	if !ValidID(id) {
		return nil, fmt.Errorf("worklist: bad id")
	}
	if len(body) > MaxDocBytes {
		return nil, fmt.Errorf("worklist: document too large")
	}
	var doc map[string]any
	if err := json.Unmarshal(body, &doc); err != nil {
		return nil, fmt.Errorf("worklist: %w", err)
	}
	if got, _ := doc["id"].(string); got != id {
		return nil, fmt.Errorf("worklist: id in body does not match")
	}
	baseRev, _ := doc["rev"].(float64)

	s.mu.Lock()
	defer s.mu.Unlock()
	cur, exists := s.doc[id]
	if exists && int64(baseRev) != cur.h.Rev {
		return json.RawMessage(cur.raw), ErrConflict
	}
	if !exists && baseRev != 0 {
		// The caller believes it exists (it was purged or never reached this
		// server): accept it as new rather than refusing the user's work.
		baseRev = 0
	}
	now := s.now().UnixMilli()
	if exists && now <= cur.h.UpdatedAt {
		now = cur.h.UpdatedAt + 1 // strictly increasing, so `since` never misses it
	}
	doc["rev"] = int64(baseRev) + 1
	doc["updatedAt"] = now
	raw, err := json.Marshal(doc)
	if err != nil {
		return nil, err
	}
	if err := writeAtomic(s.path(id), raw); err != nil {
		return nil, err
	}
	var h header
	_ = json.Unmarshal(raw, &h)
	s.doc[id] = entry{h: h, raw: raw}
	return json.RawMessage(raw), nil
}

// Delete turns document id into a tombstone (deleted = now). rev must match
// like Put. Deleting a missing document is not an error.
func (s *Store) Delete(id string, rev int64) (json.RawMessage, error) {
	s.mu.RLock()
	cur, ok := s.doc[id]
	s.mu.RUnlock()
	if !ok {
		return nil, nil
	}
	var doc map[string]any
	if err := json.Unmarshal(cur.raw, &doc); err != nil {
		return nil, err
	}
	doc["rev"] = rev
	doc["deleted"] = s.now().UnixMilli()
	body, _ := json.Marshal(doc)
	return s.Put(id, body)
}

// writeAtomic writes data to path through a temp file in the same directory
// and a rename, so a crash leaves either the old or the new file, never half.
func writeAtomic(path string, data []byte) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), ".wl-*.tmp")
	if err != nil {
		return err
	}
	name := tmp.Name()
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		os.Remove(name)
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		os.Remove(name)
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(name)
		return err
	}
	return os.Rename(name, path)
}
