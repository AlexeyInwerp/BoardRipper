package databank

import (
	"context"
	"fmt"
	"log"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode"

	"rsc.io/pdf"
)

// Per-file extraction timeout. rsc.io/pdf can hang on certain PDFs
// (e.g. heavily compressed streams), blocking the worker pool.
const extractTimeout = 2 * time.Minute

var (
	// PCB design metadata lines that add no search value
	noisePatterns = regexp.MustCompile(`(?i)^(MIN_LINE_WIDTH|MIN_NECK_WIDTH|VOLTAGE|SYNC_DATE|SYNC_MASTER|LAST_MODIFICATION|BOM_COST_GROUP)=`)
	// Page number patterns like "5 OF 119", "10 OF 145"
	pageNumPattern = regexp.MustCompile(`^\d{1,3} OF \d{1,3}$`)
)

// cleanPageText removes noise lines from extracted PDF text to reduce storage
// and improve FTS5 search quality. Removes:
// - PCB design metadata (MIN_LINE_WIDTH=, VOLTAGE=, etc.)
// - Page number references ("N OF M")
// - Lines that are purely numeric (bare page cross-references)
// - Consecutive blank lines
// - Lines with only non-letter ASCII noise
func cleanPageText(text string) string {
	text = strings.TrimSpace(text)
	if text == "" {
		return ""
	}

	lines := strings.Split(text, "\n")
	var cleaned []string
	lastBlank := false

	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			if !lastBlank {
				cleaned = append(cleaned, "")
				lastBlank = true
			}
			continue
		}
		lastBlank = false

		// Skip PCB metadata
		if noisePatterns.MatchString(line) {
			continue
		}

		// Skip page number references
		if pageNumPattern.MatchString(line) {
			continue
		}

		// Skip lines that are purely small numbers (page cross-references like "28", "100 101")
		// but keep component package sizes (0402, 0603, 0805, etc.)
		if isOnlySmallNumbers(line) {
			continue
		}

		cleaned = append(cleaned, line)
	}

	return strings.TrimSpace(strings.Join(cleaned, "\n"))
}

// isOnlySmallNumbers returns true if a line contains only numbers ≤ 200
// separated by spaces (page cross-references). Returns false for lines
// with numbers > 200 which could be component package sizes (0402, 0603, etc.).
func isOnlySmallNumbers(s string) bool {
	fields := strings.Fields(s)
	if len(fields) == 0 {
		return false
	}
	for _, f := range fields {
		// Each field must be a pure number
		n := 0
		allDigits := true
		for _, r := range f {
			if !unicode.IsDigit(r) {
				allDigits = false
				break
			}
			n = n*10 + int(r-'0')
		}
		if !allDigits {
			return false
		}
		// Keep numbers > 200 (likely package sizes: 0402, 0603, 0805, 1206, etc.)
		if n > 200 {
			return false
		}
	}
	return true
}

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

	// Use batch status check instead of N individual queries
	extractedSet, err := e.db.BatchExtractStatus()
	if err != nil {
		log.Printf("PdfExtractor: failed to check extract status: %v", err)
		return 0, 1
	}

	// Filter to only unextracted PDFs
	var toExtract []FileRecord
	for _, f := range files {
		if !extractedSet[f.ID] {
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

	// Bounded worker pool: only `concurrency` goroutines, fed via channel.
	// Avoids allocating goroutines for all PDFs upfront (which caused OOM on NAS).
	// Counters are atomic.Int64 so each worker increments and the
	// progress-reporting Load() is consistent without holding a lock that
	// could race with another worker's increment between increment and
	// Load (the previous mutex-then-release-then-reacquire pattern allowed
	// SetPdfStatus to observe values from two different worker iterations).
	work := make(chan FileRecord, concurrency)
	var extractedCount, errCount atomic.Int64
	var wg sync.WaitGroup

	for i := 0; i < concurrency; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for file := range work {
				if err := e.ExtractOne(file); err != nil {
					log.Printf("PdfExtractor: error extracting %s: %v", file.Filename, err)
					e.logScanError(file, err)
					errCount.Add(1)
				} else {
					extractedCount.Add(1)
				}

				if e.scanner != nil {
					e.scanner.SetPdfStatus(true, extractedCount.Load(), total, errCount.Load(), file.Filename)
				}
			}
		}()
	}

	for _, f := range toExtract {
		work <- f
	}
	close(work)
	wg.Wait()

	finalExtracted, finalErrors := extractedCount.Load(), errCount.Load()
	log.Printf("PdfExtractor: done — %d extracted, %d errors", finalExtracted, finalErrors)

	// Report phase 2 complete
	if e.scanner != nil {
		e.scanner.SetPdfStatus(false, finalExtracted, total, finalErrors, "")
	}

	return int(finalExtracted), int(finalErrors)
}

// ExtractAllCancellable is like ExtractAll but accepts a done channel for cancellation.
// Workers stop when the done channel is closed.
func (e *PdfExtractor) ExtractAllCancellable(concurrency int, done <-chan struct{}) (extracted, errors int) {
	files, err := e.db.ListFiles("pdf", "", false)
	if err != nil {
		log.Printf("PdfExtractor: failed to list PDFs: %v", err)
		return 0, 1
	}

	extractedSet, err := e.db.BatchExtractStatus()
	if err != nil {
		log.Printf("PdfExtractor: failed to check extract status: %v", err)
		return 0, 1
	}

	var toExtract []FileRecord
	for _, f := range files {
		if !extractedSet[f.ID] {
			toExtract = append(toExtract, f)
		}
	}

	if len(toExtract) == 0 {
		return 0, 0
	}

	total := int64(len(toExtract))
	log.Printf("PdfExtractor: %d PDFs to extract", total)

	if e.scanner != nil {
		e.scanner.SetPdfStatus(true, 0, total, 0, "")
	}

	work := make(chan FileRecord, concurrency)
	var extractedCount, errCount atomic.Int64
	var wg sync.WaitGroup

	for i := 0; i < concurrency; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for file := range work {
				if err := e.ExtractOneCancellable(file, done); err != nil {
					log.Printf("PdfExtractor: error extracting %s: %v", file.Filename, err)
					e.logScanError(file, err)
					errCount.Add(1)
				} else {
					extractedCount.Add(1)
				}

				if e.scanner != nil {
					e.scanner.SetPdfStatus(true, extractedCount.Load(), total, errCount.Load(), file.Filename)
				}
			}
		}()
	}

	for _, f := range toExtract {
		select {
		case <-done:
			goto cancelled
		case work <- f:
		}
		select {
		case <-done:
			goto cancelled
		default:
		}
	}
cancelled:
	close(work)
	wg.Wait()

	finalExtracted, finalErrors := extractedCount.Load(), errCount.Load()
	log.Printf("PdfExtractor: done — %d extracted, %d errors", finalExtracted, finalErrors)

	if e.scanner != nil {
		e.scanner.SetPdfStatus(false, finalExtracted, total, finalErrors, "")
	}

	return int(finalExtracted), int(finalErrors)
}

// ExtractOneCancellable is like ExtractOne but respects a done channel for cancellation.
func (e *PdfExtractor) ExtractOneCancellable(file FileRecord, done <-chan struct{}) error {
	root := e.dataDir
	if e.scanRootFn != nil {
		root = e.scanRootFn()
	}
	absPath := filepath.Join(root, file.Path)

	type result struct {
		pages []string
		err   error
	}
	ctx, cancel := context.WithTimeout(context.Background(), extractTimeout)
	defer cancel()

	// Also cancel if done channel closes
	go func() {
		select {
		case <-done:
			cancel()
		case <-ctx.Done():
		}
	}()

	ch := make(chan result, 1)
	go func() {
		pages, err := extractPdfText(absPath)
		ch <- result{pages, err}
	}()

	var pages []string
	select {
	case res := <-ch:
		if res.err != nil {
			return fmt.Errorf("extract %s: %w", file.Filename, res.err)
		}
		pages = res.pages
	case <-ctx.Done():
		return fmt.Errorf("extract %s: cancelled or timeout", file.Filename)
	}

	stored := 0
	for pageNum, text := range pages {
		text = cleanPageText(text)
		if text == "" {
			continue
		}
		if err := e.db.InsertPdfPage(file.ID, pageNum+1, text, "go"); err != nil {
			return fmt.Errorf("insert page %d: %w", pageNum+1, err)
		}
		stored++
	}

	if stored == 0 {
		_ = e.db.InsertPdfPage(file.ID, 0, "(no extractable text)", "go")
		log.Printf("PdfExtractor: %s — no extractable text (encrypted/broken)", file.Filename)
	} else {
		log.Printf("PdfExtractor: extracted %d pages from %s", stored, file.Filename)
	}
	return nil
}

// logScanError stores a verbose PDF extraction error in the database for later review.
// Duplicates (same file_id + same error message) are silently skipped via UNIQUE constraint.
func (e *PdfExtractor) logScanError(file FileRecord, extractErr error) {
	// Build verbose detail: file metadata + full error chain
	detail := fmt.Sprintf("file_id=%d\npath=%s\nfilename=%s\nsize=%d\nmod_time=%d\nerror=%v",
		file.ID, file.Path, file.Filename, file.Size, file.ModTime, extractErr)

	// Truncate error message to first line for the dedup key
	errMsg := extractErr.Error()
	if idx := strings.Index(errMsg, "\n"); idx > 0 {
		errMsg = errMsg[:idx]
	}

	if err := e.db.InsertPdfScanError(file.ID, file.Path, errMsg, detail); err != nil {
		log.Printf("PdfExtractor: failed to log scan error for %s: %v", file.Filename, err)
	}
}

// ExtractOne extracts text from a single PDF file and stores it in the database.
// Runs with a timeout to prevent rsc.io/pdf hangs from blocking the pipeline.
func (e *PdfExtractor) ExtractOne(file FileRecord) error {
	// Use the library scan root if available, otherwise dataDir
	root := e.dataDir
	if e.scanRootFn != nil {
		root = e.scanRootFn()
	}
	absPath := filepath.Join(root, file.Path)

	// Run extraction in a goroutine with timeout — rsc.io/pdf can hang
	// on certain PDFs (heavily compressed streams, infinite loops in xref).
	type result struct {
		pages []string
		err   error
	}
	ctx, cancel := context.WithTimeout(context.Background(), extractTimeout)
	defer cancel()

	ch := make(chan result, 1)
	go func() {
		pages, err := extractPdfText(absPath)
		ch <- result{pages, err}
	}()

	var pages []string
	select {
	case res := <-ch:
		if res.err != nil {
			return fmt.Errorf("extract %s: %w", file.Filename, res.err)
		}
		pages = res.pages
	case <-ctx.Done():
		return fmt.Errorf("extract %s: timeout after %v (rsc.io/pdf hung)", file.Filename, extractTimeout)
	}

	// Store in pdf_pages and index in pdf_text FTS5
	stored := 0
	for pageNum, text := range pages {
		text = cleanPageText(text)
		if text == "" {
			continue
		}
		if err := e.db.InsertPdfPage(file.ID, pageNum+1, text, "go"); err != nil {
			return fmt.Errorf("insert page %d: %w", pageNum+1, err)
		}
		stored++
	}

	if stored == 0 {
		// Mark as attempted so we don't retry encrypted/broken PDFs forever.
		// Insert a sentinel row with page_num=0 and empty content.
		_ = e.db.InsertPdfPage(file.ID, 0, "(no extractable text)", "go")
		log.Printf("PdfExtractor: %s — no extractable text (encrypted/broken)", file.Filename)
	} else {
		log.Printf("PdfExtractor: extracted %d pages from %s", stored, file.Filename)
	}
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
// Merges adjacent text segments into words based on spatial proximity,
// so that single-character segments (common in many PDFs) form searchable words.
// rsc.io/pdf panics on malformed streams, so we recover gracefully.
func extractPageText(page pdf.Page) (text string, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("pdf panic: %v", r)
		}
	}()

	content := page.Content()
	if len(content.Text) == 0 {
		return "", nil
	}

	var buf strings.Builder
	prev := content.Text[0]
	buf.WriteString(prev.S)

	for i := 1; i < len(content.Text); i++ {
		cur := content.Text[i]
		if cur.S == "" {
			continue
		}

		// Determine if this segment continues the previous word or starts a new one.
		// Same line: Y values within half font-size tolerance.
		fontSize := cur.FontSize
		if fontSize <= 0 {
			fontSize = prev.FontSize
		}
		if fontSize <= 0 {
			fontSize = 10 // fallback
		}
		yTol := fontSize * 0.5
		sameLine := abs(cur.Y-prev.Y) < yTol

		if sameLine {
			// Check horizontal gap: space between end of previous and start of current
			prevEnd := prev.X + prev.W
			gap := cur.X - prevEnd

			if gap > fontSize*0.3 {
				// Significant gap — insert space (word boundary)
				buf.WriteByte(' ')
			} else if gap < -fontSize*0.5 {
				// Large backward jump on same line — likely a new column or overlapping text
				buf.WriteByte(' ')
			}
			// Otherwise: no gap or small gap — characters are adjacent, merge directly
		} else {
			// Different line — insert newline
			buf.WriteByte('\n')
		}

		buf.WriteString(cur.S)
		prev = cur
	}

	return buf.String(), nil
}

func abs(x float64) float64 {
	if x < 0 {
		return -x
	}
	return x
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

// GetPdfPages returns all extracted text pages for a file, ordered by page number.
func (db *DB) GetPdfPages(fileID int64) ([]struct{ PageNum int; Text, Source string }, error) {
	rows, err := db.reader.Query(
		`SELECT page_num, text_content, source FROM pdf_pages WHERE file_id = ? AND page_num > 0 ORDER BY page_num`, fileID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var pages []struct{ PageNum int; Text, Source string }
	for rows.Next() {
		var p struct{ PageNum int; Text, Source string }
		if err := rows.Scan(&p.PageNum, &p.Text, &p.Source); err != nil {
			return nil, err
		}
		pages = append(pages, p)
	}
	return pages, rows.Err()
}

// --- DB helpers for PDF text ---

// HasPdfText checks if a file has any extracted text.
func (db *DB) HasPdfText(fileID int64) (bool, error) {
	var count int
	err := db.reader.QueryRow(`SELECT COUNT(*) FROM pdf_pages WHERE file_id = ?`, fileID).Scan(&count)
	return count > 0, err
}

// InsertPdfPage stores extracted text for a single page and indexes it in FTS5.
// Sentinel rows (page_num=0) are stored in pdf_pages but NOT indexed in FTS5.
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

	// Don't index sentinel rows (page_num=0) in FTS5
	if pageNum <= 0 {
		return nil
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
		`SELECT COUNT(*), COALESCE(MAX(source), '') FROM pdf_pages WHERE file_id = ? AND page_num > 0`,
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
