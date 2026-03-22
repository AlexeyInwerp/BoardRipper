package databank

import (
	"fmt"
	"log"
	"path/filepath"
	"strings"
	"sync"

	"rsc.io/pdf"
)

// PdfExtractor handles PDF text extraction and FTS5 indexing.
type PdfExtractor struct {
	db         *DB
	dataDir    string
	scanRootFn func() string // returns the library scan root (may differ from dataDir)
	scanner    *Scanner      // for reporting progress
}

// NewPdfExtractor creates a new extractor.
func NewPdfExtractor(db *DB, dataDir string) *PdfExtractor {
	return &PdfExtractor{db: db, dataDir: dataDir}
}

// SetScanner sets the scanner for progress reporting and scan root resolution.
func (e *PdfExtractor) SetScanner(s *Scanner) {
	e.scanner = s
	e.scanRootFn = s.ScanRoot
}

// ExtractAll processes all unextracted PDFs in the database.
// Uses a worker pool with the given concurrency.
// Reports progress through the scanner's status if available.
func (e *PdfExtractor) ExtractAll(concurrency int) (extracted, errors int) {
	files, err := e.db.ListFiles("pdf", "", false)
	if err != nil {
		log.Printf("PdfExtractor: failed to list PDFs: %v", err)
		return 0, 1
	}

	// Filter to only unextracted PDFs
	var toExtract []FileRecord
	for _, f := range files {
		hasText, _ := e.db.HasPdfText(f.ID)
		if !hasText {
			toExtract = append(toExtract, f)
		}
	}

	if len(toExtract) == 0 {
		return 0, 0
	}

	total := int64(len(toExtract))
	log.Printf("PdfExtractor: %d PDFs to extract", total)

	// Report phase 2 start
	if e.scanner != nil {
		e.scanner.SetPdfStatus(true, 0, total, 0, "")
	}

	var mu sync.Mutex
	var wg sync.WaitGroup
	sem := make(chan struct{}, concurrency)

	for _, f := range toExtract {
		wg.Add(1)
		sem <- struct{}{}
		go func(file FileRecord) {
			defer wg.Done()
			defer func() { <-sem }()

			if err := e.ExtractOne(file); err != nil {
				log.Printf("PdfExtractor: error extracting %s: %v", file.Filename, err)
				mu.Lock()
				errors++
				mu.Unlock()
			} else {
				mu.Lock()
				extracted++
				mu.Unlock()
			}

			// Update progress
			if e.scanner != nil {
				mu.Lock()
				e.scanner.SetPdfStatus(true, int64(extracted), total, int64(errors), file.Filename)
				mu.Unlock()
			}
		}(f)
	}

	wg.Wait()
	log.Printf("PdfExtractor: done — %d extracted, %d errors", extracted, errors)

	// Report phase 2 complete
	if e.scanner != nil {
		e.scanner.SetPdfStatus(false, int64(extracted), total, int64(errors), "")
	}

	return extracted, errors
}

// ExtractOne extracts text from a single PDF file and stores it in the database.
func (e *PdfExtractor) ExtractOne(file FileRecord) error {
	// Use the library scan root if available, otherwise dataDir
	root := e.dataDir
	if e.scanRootFn != nil {
		root = e.scanRootFn()
	}
	absPath := filepath.Join(root, file.Path)

	pages, err := extractPdfText(absPath)
	if err != nil {
		return fmt.Errorf("extract %s: %w", file.Filename, err)
	}

	// Store in pdf_pages and index in pdf_text FTS5
	for pageNum, text := range pages {
		text = strings.TrimSpace(text)
		if text == "" {
			continue
		}
		if err := e.db.InsertPdfPage(file.ID, pageNum+1, text, "go"); err != nil {
			return fmt.Errorf("insert page %d: %w", pageNum+1, err)
		}
	}

	log.Printf("PdfExtractor: extracted %d pages from %s", len(pages), file.Filename)
	return nil
}

// extractPdfText reads a PDF file and returns text content per page.
// Uses rsc.io/pdf which provides low-level PDF access.
// rsc.io/pdf panics on unsupported features (e.g. AES encryption), so we recover.
func extractPdfText(path string) (pages []string, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("pdf panic: %v", r)
		}
	}()

	r, openErr := pdf.Open(path)
	if openErr != nil {
		return nil, fmt.Errorf("open pdf: %w", openErr)
	}

	numPages := r.NumPage()
	pages = make([]string, numPages)

	for i := 1; i <= numPages; i++ {
		text, pgErr := extractOnePage(r, i)
		if pgErr != nil {
			log.Printf("PdfExtractor: page %d text extraction failed: %v", i, pgErr)
			continue
		}
		pages[i-1] = text
	}

	return pages, nil
}

// extractOnePage extracts text from a single page, recovering from panics
// that rsc.io/pdf triggers on malformed or encrypted page data.
func extractOnePage(r *pdf.Reader, i int) (text string, err error) {
	defer func() {
		if rv := recover(); rv != nil {
			err = fmt.Errorf("pdf panic on page %d: %v", i, rv)
		}
	}()

	page := r.Page(i)
	if page.V.IsNull() {
		return "", nil
	}
	return extractPageText(page)
}

// extractPageText extracts all text content from a single PDF page.
// rsc.io/pdf panics on malformed streams, so we recover gracefully.
func extractPageText(page pdf.Page) (text string, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("pdf panic: %v", r)
		}
	}()

	content := page.Content()
	var buf strings.Builder

	for _, t := range content.Text {
		buf.WriteString(t.S)
		// Add space between text segments for readability
		if t.S != "" && !strings.HasSuffix(t.S, " ") && !strings.HasSuffix(t.S, "\n") {
			buf.WriteByte(' ')
		}
	}

	return buf.String(), nil
}

// ReplaceText replaces the text for a file with client-extracted (pdfjs) text.
// This is the hybrid approach: frontend sends higher-quality text to replace Go-extracted text.
func (e *PdfExtractor) ReplaceText(fileID int64, pages map[int]string) error {
	// Delete existing text for this file
	if err := e.db.DeletePdfText(fileID); err != nil {
		return err
	}

	// Insert new text
	for pageNum, text := range pages {
		text = strings.TrimSpace(text)
		if text == "" {
			continue
		}
		if err := e.db.InsertPdfPage(fileID, pageNum, text, "pdfjs"); err != nil {
			return fmt.Errorf("insert page %d: %w", pageNum, err)
		}
	}

	return nil
}

// --- DB helpers for PDF text ---

// HasPdfText checks if a file has any extracted text.
func (db *DB) HasPdfText(fileID int64) (bool, error) {
	var count int
	err := db.reader.QueryRow(`SELECT COUNT(*) FROM pdf_pages WHERE file_id = ?`, fileID).Scan(&count)
	return count > 0, err
}

// InsertPdfPage stores extracted text for a single page and indexes it in FTS5.
func (db *DB) InsertPdfPage(fileID int64, pageNum int, text, source string) error {
	db.mu.Lock()
	defer db.mu.Unlock()

	// Insert into pdf_pages
	_, err := db.writer.Exec(
		`INSERT OR REPLACE INTO pdf_pages (file_id, page_num, text_content, source) VALUES (?, ?, ?, ?)`,
		fileID, pageNum, text, source,
	)
	if err != nil {
		return err
	}

	// Index in FTS5 — first delete any existing entry for this page
	_, _ = db.writer.Exec(`DELETE FROM pdf_text WHERE file_id = ? AND page_num = ?`, fileID, pageNum)

	_, err = db.writer.Exec(
		`INSERT INTO pdf_text (file_id, page_num, content) VALUES (?, ?, ?)`,
		fileID, pageNum, text,
	)
	return err
}

// DeletePdfText removes all extracted text and FTS5 entries for a file.
func (db *DB) DeletePdfText(fileID int64) error {
	db.mu.Lock()
	defer db.mu.Unlock()

	if _, err := db.writer.Exec(`DELETE FROM pdf_text WHERE file_id = ?`, fileID); err != nil {
		return err
	}
	_, err := db.writer.Exec(`DELETE FROM pdf_pages WHERE file_id = ?`, fileID)
	return err
}

// GetPdfTextStats returns the number of pages with extracted text for a file.
func (db *DB) GetPdfTextStats(fileID int64) (pageCount int, source string, err error) {
	err = db.reader.QueryRow(
		`SELECT COUNT(*), COALESCE(MAX(source), '') FROM pdf_pages WHERE file_id = ?`,
		fileID,
	).Scan(&pageCount, &source)
	return
}

// BatchExtractStatus returns extraction status for multiple file IDs.
func (db *DB) BatchExtractStatus() (map[int64]bool, error) {
	rows, err := db.reader.Query(`SELECT DISTINCT file_id FROM pdf_pages`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	result := make(map[int64]bool)
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		result[id] = true
	}
	return result, rows.Err()
}
