package handlers

import (
	"context"
	"strings"

	"boardripper/databank"
	"boardripper/pdfindex"
)

// dbSource adapts databank + the eager file reader to pdfindex.Source.
type dbSource struct {
	db       *databank.DB
	scanRoot func() string
}

// NewPdfIndexSource returns a pdfindex.Source backed by the databank and the
// eager file reader (cloud-placeholder-safe full read + size verification).
func NewPdfIndexSource(db *databank.DB, scanRoot func() string) pdfindex.Source {
	return &dbSource{db: db, scanRoot: scanRoot}
}

func (s *dbSource) ListPDFs() ([]pdfindex.PdfFile, error) {
	// Only canonical PDFs reach the indexer's work list: unique-size singletons
	// plus the lowest-id member of each byte-identical content group. Non-canonical
	// duplicates are excluded so the indexer never enumerates them.
	refs, err := s.db.CanonicalPDFs(context.Background())
	if err != nil {
		return nil, err
	}
	out := make([]pdfindex.PdfFile, 0, len(refs))
	for _, r := range refs {
		out = append(out, pdfindex.PdfFile{ID: r.ID, Path: r.Path})
	}
	return out, nil
}

func (s *dbSource) ListPDFsUnder(prefix string) ([]pdfindex.PdfFile, error) {
	all, err := s.ListPDFs()
	if err != nil {
		return nil, err
	}
	p := strings.Trim(prefix, "/")
	if p == "" {
		return all, nil
	}
	out := make([]pdfindex.PdfFile, 0)
	for _, f := range all {
		fp := strings.Trim(f.Path, "/")
		if fp == p || strings.HasPrefix(fp, p+"/") {
			out = append(out, f)
		}
	}
	return out, nil
}

func (s *dbSource) ReadFile(relPath string) ([]byte, error) {
	return readFileEager(s.scanRoot(), relPath)
}

// CanonicalFor reports whether fileID is part of a content group and, if so,
// the canonical (MIN id) member. A file with no content hash is a singleton.
func (s *dbSource) CanonicalFor(fileID int64) (int64, bool, error) {
	hash, err := s.db.ContentHashOf(fileID)
	if err != nil || hash == nil {
		return 0, false, nil // no hash → singleton, not a duplicate
	}
	canon, err := s.db.CanonicalForHash(hash)
	if err != nil {
		return 0, false, err
	}
	return canon, true, nil
}
