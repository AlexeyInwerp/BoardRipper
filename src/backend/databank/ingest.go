package databank

import (
	"bytes"
	"context"
	"log"
	"path/filepath"
)

// FindIdenticalFile reports whether the library already holds a byte-identical
// copy of the file at absPath (typically a just-received upload still sitting
// in its temp location). It is the ingest-time half of the content dedup
// layer: the same size-bucket + ContentKey rule the scan-time pass uses, so an
// upload can never create a copy the dedup views would later collapse.
//
// Returns (match, key, nil):
//   - match != nil: an existing row with the same bytes; key is its content
//     key. The caller should discard absPath and reuse match.
//   - match == nil, key != nil: at least one stored file shares the size but
//     none matched. key should be stored on the new row (SetContentHash) so it
//     joins the size-collision group the scanner would have hashed anyway.
//   - match == nil, key == nil: unique size — never read, no hash, matching
//     the scanner's "unique size can't be a duplicate" invariant.
//
// Candidates that have never been hashed are hashed here and their hash is
// persisted, so repeated drops of the same size get cheaper and the dedup
// views benefit as a side effect. A candidate that has vanished from disk or
// fails to read is skipped, never matched.
func (s *Scanner) FindIdenticalFile(absPath string, size int64) (*FileRecord, []byte, error) {
	cands, err := s.db.FilesBySize(size)
	if err != nil {
		return nil, nil, err
	}
	if len(cands) == 0 {
		return nil, nil, nil
	}
	key, err := ContentKey(absPath, size)
	if err != nil {
		return nil, nil, err
	}
	root := s.ScanRoot()
	for _, c := range cands {
		h := c.Hash
		if h == nil {
			h, err = ContentKey(filepath.Join(root, filepath.FromSlash(c.Path)), c.Size)
			if err != nil {
				log.Printf("ingest: hash candidate %s: %v (skipped)", c.Path, err)
				continue
			}
			if err := s.db.SetContentHash(c.ID, h); err != nil {
				log.Printf("ingest: store hash id=%d: %v", c.ID, err)
			}
		}
		if bytes.Equal(h, key) {
			rec, err := s.db.GetFileByID(context.Background(), c.ID)
			if err != nil {
				return nil, key, err
			}
			return rec, key, nil
		}
	}
	return nil, key, nil
}
