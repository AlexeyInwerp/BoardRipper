package databank

import (
	"database/sql"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

func formatSize(bytes int64) string {
	if bytes < 1024 {
		return fmt.Sprintf("%dB", bytes)
	} else if bytes < 1024*1024 {
		return fmt.Sprintf("%.1fKB", float64(bytes)/1024)
	}
	return fmt.Sprintf("%.1fMB", float64(bytes)/(1024*1024))
}

// ScanStatus reports the current state of a scan operation.
type ScanStatus struct {
	Running  bool   `json:"running"`
	Scanned  int64  `json:"scanned"`
	Total    int64  `json:"total"`
	Added    int64  `json:"added"`
	Updated  int64  `json:"updated"`
	Deleted  int64  `json:"deleted"`
	Errors   int64  `json:"errors"`
	Duration int64  `json:"duration_ms"`
	Phase    string `json:"phase,omitempty"`     // current phase description
	LastFile string `json:"last_file,omitempty"` // last processed file (for verbose display)

	// Phase 2: PDF text extraction (runs after file scan)
	PdfRunning   bool   `json:"pdf_running"`
	PdfExtracted int64  `json:"pdf_extracted"`
	PdfTotal     int64  `json:"pdf_total"`
	PdfErrors    int64  `json:"pdf_errors"`
	PdfCurrent   string `json:"pdf_current,omitempty"`
}

// Scanner walks DATA_DIR and syncs findings with the database.
type Scanner struct {
	db         *DB
	dataDir    string
	libraryDir string // optional separate library directory

	mu         sync.Mutex
	status     ScanStatus
	cancelFn   func()     // cancel the current scan goroutine
	postScanFn func()     // called after scan completes (e.g. PDF extraction)
}

// SetPostScanFn registers a callback to run after each scan completes (file indexing done).
func (s *Scanner) SetPostScanFn(fn func()) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.postScanFn = fn
}

// NewScanner creates a scanner for the given data directory.
// envLibraryDir is the LIBRARY_DIR env default (e.g. "/library" in Docker, "" in dev).
// A persisted DB config value takes precedence over the env default.
func NewScanner(db *DB, dataDir string, envLibraryDir string) *Scanner {
	s := &Scanner{db: db, dataDir: dataDir}

	// Priority: DB config > env var > none
	if dir, err := db.GetConfig("library_dir"); err == nil && dir != "" {
		s.libraryDir = dir
		log.Printf("Scanner: library_dir from config: %s", dir)
	} else if envLibraryDir != "" {
		s.libraryDir = envLibraryDir
		log.Printf("Scanner: library_dir from LIBRARY_DIR env: %s", envLibraryDir)
	}

	// Check if supported extensions changed since last scan (code update added new formats)
	s.checkExtensionsChanged()

	return s
}

// checkExtensionsChanged compares the current extensions fingerprint with
// the one stored in the DB. If different, logs a notice — the startup scan
// will naturally pick up files with newly-supported extensions.
func (s *Scanner) checkExtensionsChanged() {
	fp := ExtensionsFingerprint()
	stored, _ := s.db.GetConfig("extensions_fingerprint")
	if stored != fp {
		if stored != "" {
			log.Printf("Scanner: supported extensions changed (%s → %s) — startup scan will index new file types", stored, fp)
		}
		_ = s.db.SetConfig("extensions_fingerprint", fp)
	}
}

// SetLibraryDir updates the library directory used for scanning.
func (s *Scanner) SetLibraryDir(dir string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.libraryDir = dir
	log.Printf("Scanner: library_dir set to: %q", dir)
}

// ScanRoot returns the directory that the scanner will walk.
// If a library_dir is configured and exists, it's used; otherwise dataDir.
func (s *Scanner) ScanRoot() string {
	s.mu.Lock()
	dir := s.libraryDir
	s.mu.Unlock()

	if dir != "" {
		if info, err := os.Stat(dir); err == nil && info.IsDir() {
			return dir
		}
		log.Printf("Scanner: library_dir %q not accessible, falling back to dataDir", dir)
	}
	return s.dataDir
}

// Status returns the current scan status.
func (s *Scanner) Status() ScanStatus {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.status
}

// SetPdfStatus updates the PDF extraction progress fields.
func (s *Scanner) SetPdfStatus(running bool, extracted, total, errors int64, current string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.status.PdfRunning = running
	s.status.PdfExtracted = extracted
	s.status.PdfTotal = total
	s.status.PdfErrors = errors
	s.status.PdfCurrent = current
	if running {
		s.status.Phase = fmt.Sprintf("PDF text extraction (%d/%d)", extracted, total)
	}
}

// ScanAsync starts a background scan. Returns immediately with current status.
// If a scan is already running, it's a no-op.
func (s *Scanner) ScanAsync() ScanStatus {
	s.mu.Lock()
	if s.status.Running {
		st := s.status
		s.mu.Unlock()
		return st
	}
	s.status = ScanStatus{Running: true}
	done := make(chan struct{})
	s.cancelFn = func() { close(done) }
	s.mu.Unlock()

	go func() {
		s.scanWorker(done)
		s.runPostScan()
	}()
	return s.Status()
}

func (s *Scanner) runPostScan() {
	s.mu.Lock()
	fn := s.postScanFn
	s.mu.Unlock()
	if fn != nil {
		fn()
	}
}

// StopScan cancels a running scan.
func (s *Scanner) StopScan() ScanStatus {
	s.mu.Lock()
	if s.cancelFn != nil {
		s.cancelFn()
		s.cancelFn = nil
	}
	s.mu.Unlock()
	return s.Status()
}

// Scan performs a synchronous scan (for backwards compat / Electron). Blocks until done.
func (s *Scanner) Scan() ScanStatus {
	s.mu.Lock()
	if s.status.Running {
		st := s.status
		s.mu.Unlock()
		return st
	}
	s.status = ScanStatus{Running: true}
	s.mu.Unlock()

	s.scanWorker(nil)
	st := s.Status()
	s.runPostScan()
	return st
}

func (s *Scanner) scanWorker(cancel <-chan struct{}) {
	start := time.Now()

	cancelled := func() bool {
		if cancel == nil {
			return false
		}
		select {
		case <-cancel:
			return true
		default:
			return false
		}
	}

	var added, updated, deleted, errors, scanned, total int64

	// Phase 1: Walk filesystem and collect all supported files
	type diskFile struct {
		relPath string
		size    int64
		modTime int64
	}
	var diskFiles []diskFile

	scanRoot := s.ScanRoot()
	log.Printf("Scanner: scanning %s", scanRoot)

	s.mu.Lock()
	s.status.Phase = "Walking filesystem"
	s.mu.Unlock()

	err := filepath.Walk(scanRoot, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil // skip errors
		}
		if cancelled() {
			return filepath.SkipAll
		}
		// Skip hidden directories (like .previews)
		if info.IsDir() && strings.HasPrefix(info.Name(), ".") {
			return filepath.SkipDir
		}
		if info.IsDir() {
			return nil
		}
		if !IsSupportedFile(info.Name()) {
			return nil
		}

		relPath, _ := filepath.Rel(scanRoot, path)
		// Normalize to forward slashes for cross-platform consistency
		relPath = filepath.ToSlash(relPath)

		diskFiles = append(diskFiles, diskFile{
			relPath: relPath,
			size:    info.Size(),
			modTime: info.ModTime().Unix(),
		})
		return nil
	})
	if err != nil {
		log.Printf("Scanner: walk error: %v", err)
	}

	if cancelled() {
		s.finishScan(scanned, total, added, updated, deleted, errors, start, true)
		return
	}

	total = int64(len(diskFiles))
	// Log file type breakdown
	typeCounts := make(map[string]int)
	for _, df := range diskFiles {
		ft := FileTypeFromExt(df.relPath)
		if ft == "" {
			ft = "other"
		}
		typeCounts[ft]++
	}
	parts := make([]string, 0, len(typeCounts))
	for ft, c := range typeCounts {
		parts = append(parts, fmt.Sprintf("%d %s", c, ft))
	}
	log.Printf("Scanner: found %d files (%s)", total, strings.Join(parts, ", "))

	s.mu.Lock()
	s.status.Total = total
	s.status.Phase = "Comparing with database"
	s.mu.Unlock()

	// Phase 2: Get existing DB records for diff
	existing, err := s.db.AllFilePaths()
	if err != nil {
		log.Printf("Scanner: failed to read existing files: %v", err)
		s.mu.Lock()
		s.status.Running = false
		s.status.Errors = 1
		s.cancelFn = nil
		s.mu.Unlock()
		return
	}

	// Phase 3: Process each disk file
	seen := make(map[string]bool, len(diskFiles))

	s.mu.Lock()
	s.status.Phase = "Processing files"
	s.mu.Unlock()

	// Separate files into updates (existing, changed) and inserts (new)
	var toInsert []FileRecord
	for _, df := range diskFiles {
		if cancelled() {
			break
		}
		seen[df.relPath] = true
		atomic.AddInt64(&scanned, 1)

		s.mu.Lock()
		s.status.Scanned = scanned
		s.status.LastFile = df.relPath
		s.mu.Unlock()

		if rec, ok := existing[df.relPath]; ok {
			// File exists in DB — check if changed
			if rec.Size == df.size && rec.ModTime == df.modTime {
				continue // unchanged
			}
			// Changed — update scan fields
			if err := s.db.UpdateFileScan(rec.ID, df.size, df.modTime, time.Now().Unix()); err != nil {
				log.Printf("Scanner: update error for %s: %v", df.relPath, err)
				atomic.AddInt64(&errors, 1)
				continue
			}
			atomic.AddInt64(&updated, 1)
		} else {
			// New file — collect for batch insert
			meta := ExtractMetadata(df.relPath)
			fileType := FileTypeFromExt(df.relPath)
			ext := strings.ToLower(filepath.Ext(df.relPath))

			toInsert = append(toInsert, FileRecord{
				Path:         df.relPath,
				Filename:     filepath.Base(df.relPath),
				Extension:    ext,
				FileType:     fileType,
				Size:         df.size,
				ModTime:      df.modTime,
				ScanTime:     time.Now().Unix(),
				BoardNumber:  meta.BoardNumber,
				Manufacturer: meta.Manufacturer,
				Model:        meta.Model,
			})
		}
	}

	// Batch insert new files in transactions of 100
	const batchSize = 100
	for i := 0; i < len(toInsert); i += batchSize {
		if cancelled() {
			break
		}
		end := i + batchSize
		if end > len(toInsert) {
			end = len(toInsert)
		}
		batch := toInsert[i:end]
		err := s.db.WriteTx(func(tx *sql.Tx) error {
			for j := range batch {
				if _, err := InsertFileTx(tx, &batch[j]); err != nil {
					return err
				}
			}
			return nil
		})
		if err != nil {
			log.Printf("Scanner: batch insert error (%d files): %v", len(batch), err)
			atomic.AddInt64(&errors, int64(len(batch)))
		} else {
			for _, f := range batch {
				log.Printf("Scanner: + %s [%s] %s", f.Path, f.FileType, formatSize(f.Size))
			}
			atomic.AddInt64(&added, int64(len(batch)))
		}
	}

	if !cancelled() {
		// Phase 4: Delete DB records for files no longer on disk
		s.mu.Lock()
		s.status.Phase = "Cleaning removed files"
		s.mu.Unlock()
		for path, rec := range existing {
			if !seen[path] {
				if err := s.db.DeleteFile(rec.ID); err != nil {
					log.Printf("Scanner: delete error for %s: %v", path, err)
					atomic.AddInt64(&errors, 1)
					continue
				}
				atomic.AddInt64(&deleted, 1)
			}
		}

		// Phase 5: Auto-match board-PDF bindings for new files
		s.mu.Lock()
		s.status.Phase = "Auto-matching bindings"
		s.mu.Unlock()
		s.autoMatchBindings()
	}

	s.finishScan(scanned, total, added, updated, deleted, errors, start, cancelled())
}

func (s *Scanner) finishScan(scanned, total, added, updated, deleted, errors int64, start time.Time, stopped bool) {
	duration := time.Since(start).Milliseconds()
	s.mu.Lock()
	s.status = ScanStatus{
		Running:  false,
		Scanned:  scanned,
		Total:    total,
		Added:    added,
		Updated:  updated,
		Deleted:  deleted,
		Errors:   errors,
		Duration: duration,
	}
	s.cancelFn = nil
	s.mu.Unlock()

	if stopped {
		log.Printf("Scanner: stopped after %dms — %d/%d files processed, %d added, %d updated, %d deleted, %d errors",
			duration, scanned, total, added, updated, deleted, errors)
	} else {
		log.Printf("Scanner: done in %dms — %d files, %d added, %d updated, %d deleted, %d errors",
			duration, total, added, updated, deleted, errors)
	}
}

// autoMatchBindings creates bindings between boards and PDFs based on filename matching.
func (s *Scanner) autoMatchBindings() {
	boards, err := s.db.ListFiles("board", "", false)
	if err != nil {
		log.Printf("Scanner: auto-match error listing boards: %v", err)
		return
	}
	pdfs, err := s.db.ListFiles("pdf", "", false)
	if err != nil {
		log.Printf("Scanner: auto-match error listing PDFs: %v", err)
		return
	}

	for _, board := range boards {
		// Check if board already has bindings
		existing, _ := s.db.GetBindingsForBoard(board.ID)
		if len(existing) > 0 {
			continue // already has bindings, don't override
		}

		var bestPdf *FileRecord
		bestScore := 0

		for i := range pdfs {
			score := MatchScore(board.Filename, pdfs[i].Filename)
			if score > bestScore {
				bestScore = score
				bestPdf = &pdfs[i]
			}
		}

		if bestPdf != nil && bestScore >= 50 {
			if _, err := s.db.InsertBinding(board.ID, bestPdf.ID, true); err != nil {
				log.Printf("Scanner: auto-bind error %s->%s: %v", board.Filename, bestPdf.Filename, err)
			} else {
				log.Printf("Scanner: auto-bound %s <-> %s (score=%d)", board.Filename, bestPdf.Filename, bestScore)
			}
		}
	}
}

// FolderNode represents a directory in the folder tree.
type FolderNode struct {
	Name     string        `json:"name"`
	Path     string        `json:"path"`
	Children []*FolderNode `json:"children,omitempty"`
	Files    []FileRecord  `json:"files,omitempty"`
}

// BuildFolderTree constructs a tree from all files in the database.
func (s *Scanner) BuildFolderTree() (*FolderNode, error) {
	files, err := s.db.ListFiles("", "", false)
	if err != nil {
		return nil, err
	}

	root := &FolderNode{Name: "/", Path: ""}
	nodeMap := map[string]*FolderNode{"": root}

	// Ensure all directories exist in tree
	for _, f := range files {
		dir := filepath.Dir(f.Path)
		if dir == "." {
			dir = ""
		}
		ensureDirNode(nodeMap, root, dir)
	}

	// Place files into their directory nodes
	for _, f := range files {
		dir := filepath.Dir(f.Path)
		if dir == "." {
			dir = ""
		}
		node := nodeMap[dir]
		node.Files = append(node.Files, f)
	}

	return root, nil
}

func ensureDirNode(nodeMap map[string]*FolderNode, root *FolderNode, dir string) *FolderNode {
	if dir == "" || dir == "." {
		return root
	}
	if n, ok := nodeMap[dir]; ok {
		return n
	}

	parent := filepath.Dir(dir)
	if parent == "." {
		parent = ""
	}
	parentNode := ensureDirNode(nodeMap, root, parent)

	node := &FolderNode{
		Name: filepath.Base(dir),
		Path: dir,
	}
	parentNode.Children = append(parentNode.Children, node)
	nodeMap[dir] = node
	return node
}
