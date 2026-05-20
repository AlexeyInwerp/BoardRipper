package handlers

import (
	"context"

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
	files, err := s.db.ListFiles(context.Background(), "pdf", "", false)
	if err != nil {
		return nil, err
	}
	out := make([]pdfindex.PdfFile, 0, len(files))
	for _, f := range files {
		out = append(out, pdfindex.PdfFile{ID: f.ID, Path: f.Path})
	}
	return out, nil
}

func (s *dbSource) ReadFile(relPath string) ([]byte, error) {
	return readFileEager(s.scanRoot(), relPath)
}
