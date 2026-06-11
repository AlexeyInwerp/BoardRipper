package databank

import (
	"boardripper/boarddb"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strconv"
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
	Phase       string `json:"phase,omitempty"`        // current phase description
	LastFile    string `json:"last_file,omitempty"`    // last processed file (for verbose display)
	CompletedAt int64  `json:"completed_at,omitempty"` // unix timestamp of last scan completion
}

// Scanner walks DATA_DIR and syncs findings with the database.
type Scanner struct {
	db         *DB
	dataDir    string
	libraryDir string // optional separate library directory
	boardDB    *boarddb.DB // optional board reference database

	mu       sync.Mutex
	status   ScanStatus
	cancelFn func()       // cancel the current scan goroutine
	cancelCh chan struct{} // closed on cancel
	activeOp string       // "", "file"
}

// SetBoardDB registers the board reference database for ODM-aware metadata extraction.
func (s *Scanner) SetBoardDB(bdb *boarddb.DB) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.boardDB = bdb
}

// ActiveOp returns the currently running operation ("", "file", or "pdf").
func (s *Scanner) ActiveOp() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.activeOp
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

	// Restore last scan status from DB so Status() returns meaningful data after restart
	s.loadPersistedStatus()

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

// loadPersistedStatus restores the last scan results from the config table
// so Status() returns meaningful data immediately after a container restart.
func (s *Scanner) loadPersistedStatus() {
	data, err := s.db.GetConfig("last_scan_status")
	if err != nil || data == "" {
		return
	}
	var st ScanStatus
	if err := json.Unmarshal([]byte(data), &st); err != nil {
		log.Printf("Scanner: failed to parse persisted status: %v", err)
		return
	}
	st.Running = false // never start in running state
	s.mu.Lock()
	s.status = st
	s.mu.Unlock()
	log.Printf("Scanner: restored last scan status (%d files, completed %dms ago)",
		st.Total, time.Now().UnixMilli()-st.Duration)
}

// persistStatus saves the current scan results to the config table.
func (s *Scanner) persistStatus() {
	s.mu.Lock()
	st := s.status
	s.mu.Unlock()

	data, err := json.Marshal(st)
	if err != nil {
		log.Printf("Scanner: failed to marshal status: %v", err)
		return
	}
	if err := s.db.SetConfig("last_scan_status", string(data)); err != nil {
		log.Printf("Scanner: failed to persist status: %v", err)
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

// ExtractMetadata runs the same metadata extraction the scanner / IndexFile
// use, in a thread-safe way. Used by the drop-to-incoming upload handler so
// it can choose a brand/model subfolder for the file before writing it,
// without duplicating the resolver logic. relPath is forward-slash, relative
// to the scan root.
func (s *Scanner) ExtractMetadata(relPath string) Metadata {
	s.mu.Lock()
	bdb := s.boardDB
	s.mu.Unlock()
	return ExtractMetadataWithBoardDB(relPath, bdb)
}

// IndexFile indexes a single file that already exists on disk under the
// scan root, without walking the whole library. It mirrors scanWorker's
// per-file insert/update path so a dropped file shows up in the library
// immediately (used by the drop-to-incoming upload handler). PDFs are
// additionally queued for background text extraction. Auto-match bindings
// are intentionally NOT run here — that pass is O(boards×pdfs) and is left
// to the next full scan; the frontend already binds the open board↔PDF in
// memory for the current session.
func (s *Scanner) IndexFile(relPath string) error {
	relPath = filepath.ToSlash(filepath.Clean(relPath))
	abs := filepath.Join(s.ScanRoot(), filepath.FromSlash(relPath))
	info, err := os.Stat(abs)
	if err != nil {
		return err
	}
	if info.IsDir() || !IsSupportedFile(info.Name()) {
		return fmt.Errorf("not a supported file: %s", relPath)
	}
	size := info.Size()
	modTime := info.ModTime().Unix()

	s.mu.Lock()
	bdb := s.boardDB
	s.mu.Unlock()

	// Insert-or-update by path (files.path has a UNIQUE constraint).
	if existing, err := s.db.GetFileByPath(relPath); err == nil && existing != nil {
		if existing.Size != size || existing.ModTime != modTime {
			if err := s.db.UpdateFileScan(existing.ID, size, modTime, time.Now().Unix()); err != nil {
				return err
			}
		}
		log.Printf("Scanner: indexed (update) %s", relPath)
		return nil
	}

	meta := ExtractMetadataWithBoardDB(relPath, bdb)
	rec := FileRecord{
		Path:              relPath,
		Filename:          filepath.Base(relPath),
		Extension:         strings.ToLower(filepath.Ext(relPath)),
		FileType:          FileTypeFromExt(relPath),
		Size:              size,
		ModTime:           modTime,
		ScanTime:          time.Now().Unix(),
		BoardNumber:       meta.BoardNumber,
		Manufacturer:      meta.Manufacturer,
		Model:             meta.Model,
		BoardManufacturer: meta.BoardManufacturer,
		ResolutionStatus:  meta.ResolutionStatus,
		BoardUUID:         meta.BoardUUID,
		BoardColor:        meta.BoardColor,
		BoardColorHex:     meta.BoardColorHex,
	}
	id, err := s.db.InsertFile(&rec)
	if err != nil {
		return err
	}
	rec.ID = id
	log.Printf("Scanner: indexed (new) %s [%s] %s", rec.Path, rec.FileType, formatSize(rec.Size))

	// PDF text extraction is no longer done here: it moved to the separate
	// pdfindex pipeline (wazero/pdfium). A dropped PDF gets indexed via the
	// on-open fast-path or the next pdfindex run; IndexFile only ensures the
	// file is present in the databank immediately.
	return nil
}

// Status returns the current scan status.
func (s *Scanner) Status() ScanStatus {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.status
}

// ScanAsync starts a background scan. Returns immediately with current status.
// Returns an error if another operation is already running.
func (s *Scanner) ScanAsync() (ScanStatus, error) {
	s.mu.Lock()
	if s.activeOp != "" {
		st := s.status
		s.mu.Unlock()
		return st, fmt.Errorf("operation %q already running", s.activeOp)
	}
	s.activeOp = "file"
	s.status = ScanStatus{Running: true}
	done := make(chan struct{})
	s.cancelCh = done
	s.cancelFn = func() { close(done) }
	s.mu.Unlock()

	go func() {
		s.scanWorker(done)
	}()
	return s.Status(), nil
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

// Scan performs a synchronous scan. Blocks until done.
// Used only for auto-scan on startup — has no cancel channel.
func (s *Scanner) Scan() ScanStatus {
	s.mu.Lock()
	if s.activeOp != "" {
		st := s.status
		s.mu.Unlock()
		return st
	}
	s.activeOp = "file"
	s.status = ScanStatus{Running: true}
	s.mu.Unlock()
	s.scanWorker(nil)
	return s.Status()
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

	var added, updated, deleted, errors, scanned, total, reresolved int64

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

	// Stream-insert new files in batches so a freshly-indexed library of
	// 100k+ files doesn't accumulate the entire FileRecord slice in memory
	// before any DB write happens. Pre-allocated `pending` buffer is
	// reused across flushes (length reset, capacity retained).
	const batchSize = 1000
	pending := make([]FileRecord, 0, batchSize)
	flushPending := func() {
		if len(pending) == 0 {
			return
		}
		err := s.db.WriteTx(func(tx *sql.Tx) error {
			for j := range pending {
				if _, err := InsertFileTx(tx, &pending[j]); err != nil {
					return err
				}
			}
			return nil
		})
		if err != nil {
			log.Printf("Scanner: batch insert error (%d files): %v", len(pending), err)
			atomic.AddInt64(&errors, int64(len(pending)))
		} else {
			for i := range pending {
				log.Printf("Scanner: + %s [%s] %s", pending[i].Path, pending[i].FileType, formatSize(pending[i].Size))
			}
			atomic.AddInt64(&added, int64(len(pending)))
		}
		pending = pending[:0]
	}

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
				// Disk-unchanged. Re-resolve metadata against the current
				// boards.db so a freshly-imported reference DB (e.g. apple-
				// boards.ts promotion) can lift previously-Unsorted rows
				// into proper hierarchy without forcing the user to Reset
				// All. Only triggers when board_uuid actually changes, so
				// this is a no-op on a stable DB.
				if s.boardDB != nil && s.boardDB.Available() {
					meta := ExtractMetadataWithBoardDB(df.relPath, s.boardDB)
					if meta.BoardUUID != rec.BoardUUID {
						if err := s.db.UpdateFileResolution(
							rec.ID,
							meta.BoardNumber, meta.Manufacturer, meta.Model,
							meta.BoardManufacturer, meta.ResolutionStatus,
							meta.BoardUUID, meta.BoardColor, meta.BoardColorHex,
						); err != nil {
							log.Printf("Scanner: re-resolve error for %s: %v", df.relPath, err)
							atomic.AddInt64(&errors, 1)
						} else {
							atomic.AddInt64(&reresolved, 1)
						}
					}
				}
				continue
			}
			// Changed — update scan fields
			if err := s.db.UpdateFileScan(rec.ID, df.size, df.modTime, time.Now().Unix()); err != nil {
				log.Printf("Scanner: update error for %s: %v", df.relPath, err)
				atomic.AddInt64(&errors, 1)
				continue
			}
			atomic.AddInt64(&updated, 1)
		} else {
			// New file — append to the pending insert buffer; flush when full.
			meta := ExtractMetadataWithBoardDB(df.relPath, s.boardDB)
			fileType := FileTypeFromExt(df.relPath)
			ext := strings.ToLower(filepath.Ext(df.relPath))

			pending = append(pending, FileRecord{
				Path:              df.relPath,
				Filename:          filepath.Base(df.relPath),
				Extension:         ext,
				FileType:          fileType,
				Size:              df.size,
				ModTime:           df.modTime,
				ScanTime:          time.Now().Unix(),
				BoardNumber:       meta.BoardNumber,
				Manufacturer:      meta.Manufacturer,
				Model:             meta.Model,
				BoardManufacturer: meta.BoardManufacturer,
				ResolutionStatus:  meta.ResolutionStatus,
				BoardUUID:         meta.BoardUUID,
				BoardColor:        meta.BoardColor,
				BoardColorHex:     meta.BoardColorHex,
			})
			if len(pending) >= batchSize {
				flushPending()
			}
		}
	}

	// Final drain of any remaining pending inserts (also runs on cancel,
	// so partial scans persist whatever was already queued).
	flushPending()

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

		// Phase 5: Hash size-colliding files so duplicates are marked inline.
		// Leaves the file list deduplicated after every scan (a clean,
		// deduped list for the PDF indexer) instead of relying on a separate
		// on-demand "Find duplicates" pass.
		s.mu.Lock()
		s.status.Phase = "Finding duplicates"
		s.mu.Unlock()
		s.dedupSizeCollisions(cancelled)

		// Phase 6: Auto-match board-PDF bindings for new files.
		// OFF by default — on large libraries the O(boards×pdfs) match loop
		// adds hours to the scan. Opt in via config `auto_bind=true`.
		if !cancelled() {
			if v, _ := s.db.GetConfig("auto_bind"); v == "true" {
				s.mu.Lock()
				s.status.Phase = "Auto-matching bindings"
				s.mu.Unlock()
				s.autoMatchBindings()
			}
		}
	}

	if reresolved > 0 {
		log.Printf("Scanner: re-resolved %d unchanged file(s) against current boards.db", reresolved)
	}
	s.finishScan(scanned, total, added, updated, deleted, errors, start, cancelled())
}

// dedupSizeCollisions hashes every size-colliding file that doesn't yet have a
// content_hash, so duplicates are marked during the scan (a clean, deduped
// file list for the PDF indexer). Idempotent: already-hashed files are skipped.
func (s *Scanner) dedupSizeCollisions(cancelled func() bool) {
	files, err := s.db.SizeCollisionFiles()
	if err != nil {
		log.Printf("Scanner: dedup list error: %v", err)
		return
	}
	root := s.ScanRoot()
	HashCollisions(s.db, root, files, 4, cancelled, func(done, total int64) {
		s.mu.Lock()
		s.status.LastFile = "Deduplicating " + strconv.FormatInt(done, 10) + "/" + strconv.FormatInt(total, 10)
		s.mu.Unlock()
	})
}

func (s *Scanner) finishScan(scanned, total, added, updated, deleted, errors int64, start time.Time, stopped bool) {
	duration := time.Since(start).Milliseconds()
	s.mu.Lock()
	s.status = ScanStatus{
		Running:     false,
		Scanned:     scanned,
		Total:       total,
		Added:       added,
		Updated:     updated,
		Deleted:     deleted,
		Errors:      errors,
		Duration:    duration,
		CompletedAt: time.Now().Unix(),
	}
	s.activeOp = ""
	s.cancelFn = nil
	s.cancelCh = nil
	s.mu.Unlock()

	if stopped {
		log.Printf("Scanner: stopped after %dms — %d/%d files processed, %d added, %d updated, %d deleted, %d errors",
			duration, scanned, total, added, updated, deleted, errors)
	} else {
		log.Printf("Scanner: done in %dms — %d files, %d added, %d updated, %d deleted, %d errors",
			duration, total, added, updated, deleted, errors)
	}

	// Persist scan results so they survive container restarts
	s.persistStatus()

	if !stopped {
		_ = s.db.SetConfig("last_file_scan_at", fmt.Sprintf("%d", time.Now().Unix()))
	}
}

// autoMatchBindings creates bindings between boards and PDFs based on filename matching.
//
// Failure budget: when InsertBinding starts returning errors for *every* row
// (seen on libraries with FK-constraint pathology), we'd otherwise log one
// line per pair and hammer the writer mutex for thousands of iterations,
// which makes the API look unresponsive. The first few failures get full
// diagnostics; after consecutiveFKThreshold consecutive FK errors we abort
// the phase and log a single summary so the rest of the scan completes.
func (s *Scanner) autoMatchBindings() {
	const sampleErrLimit = 5
	const consecutiveFKThreshold = 50

	boards, err := s.db.ListFiles(context.Background(), "board", "", false)
	if err != nil {
		log.Printf("Scanner: auto-match error listing boards: %v", err)
		return
	}
	pdfs, err := s.db.ListFiles(context.Background(), "pdf", "", false)
	if err != nil {
		log.Printf("Scanner: auto-match error listing PDFs: %v", err)
		return
	}

	var bound, errs, consecutiveErrs, skipped int

	for _, board := range boards {
		existing, _ := s.db.GetBindingsForBoard(context.Background(), board.ID)
		if len(existing) > 0 {
			continue
		}

		boardDir := filepath.Dir(board.Path)
		var bestPdf *FileRecord
		bestScore := 0
		for i := range pdfs {
			// Drop page-fragment / pure-digit PDF names — they substring-match
			// too many boards and produce garbage bindings (see MatchScore +
			// IsLikelyJunkPdfName in metadata.go).
			if IsLikelyJunkPdfName(pdfs[i].Filename) {
				continue
			}
			score := MatchScore(board.Filename, pdfs[i].Filename)
			if score == 0 {
				continue
			}
			// Folder scope: same-folder pairs keep the score-50 threshold;
			// cross-folder pairs must be a strong match (≥ 80, i.e. exact
			// base name or Apple-board-number embedded in the PDF name).
			// Without this guard, "any board × any PDF" anywhere in the
			// library is fair game and unrelated docs latch on easily.
			if filepath.Dir(pdfs[i].Path) != boardDir && score < 80 {
				continue
			}
			if score > bestScore {
				bestScore = score
				bestPdf = &pdfs[i]
			}
		}
		if bestPdf == nil || bestScore < 50 {
			continue
		}

		if _, err := s.db.InsertBinding(board.ID, bestPdf.ID, true, "schematic", true); err != nil {
			errs++
			consecutiveErrs++
			if errs <= sampleErrLimit {
				log.Printf("Scanner: auto-bind error board#%d %q -> pdf#%d %q: %v",
					board.ID, board.Filename, bestPdf.ID, bestPdf.Filename, err)
			}
			if consecutiveErrs >= consecutiveFKThreshold {
				skipped = len(boards)
				log.Printf("Scanner: auto-bind aborted after %d consecutive errors — likely a structural issue with the bindings table; skipping remaining %d boards in this phase",
					consecutiveErrs, skipped)
				break
			}
			continue
		}

		consecutiveErrs = 0
		bound++
		if bound <= sampleErrLimit {
			log.Printf("Scanner: auto-bound board#%d %q <-> pdf#%d %q (score=%d)",
				board.ID, board.Filename, bestPdf.ID, bestPdf.Filename, bestScore)
		}
	}

	if bound+errs > 0 {
		log.Printf("Scanner: auto-bind summary — %d bound, %d failed%s",
			bound, errs,
			func() string {
				if skipped > 0 {
					return ", phase aborted early"
				}
				return ""
			}())
	}
}

// ResetAll clears the entire databank (files, bindings, PDF text, previews).
// Returns error if any operation is currently running.
func (s *Scanner) ResetAll() error {
	s.mu.Lock()
	if s.activeOp != "" {
		s.mu.Unlock()
		return fmt.Errorf("cannot reset while %q is running", s.activeOp)
	}
	s.mu.Unlock()
	// Now safe — no scan can start because they check activeOp
	if err := s.db.ResetAll(s.dataDir); err != nil {
		return err
	}
	s.mu.Lock()
	s.status = ScanStatus{}
	s.mu.Unlock()
	return nil
}

// BrowseEntry represents a file or directory in a browse listing.
type BrowseEntry struct {
	Name     string `json:"name"`
	IsDir    bool   `json:"is_dir"`
	Size     int64  `json:"size,omitempty"`
	ModTime  int64  `json:"mod_time,omitempty"`
	FileType string `json:"file_type,omitempty"`
}

// BrowseResult is the response from BrowseDir.
type BrowseResult struct {
	Path    string        `json:"path"`
	Entries []BrowseEntry `json:"entries"`
}

// BrowseDir lists the contents of a directory relative to the scan root.
func (s *Scanner) BrowseDir(relPath string) (*BrowseResult, error) {
	root := s.ScanRoot()
	relPath = filepath.Clean(relPath)
	if relPath == "." {
		relPath = ""
	}
	absPath := filepath.Join(root, relPath)

	resolved, err := filepath.EvalSymlinks(absPath)
	if err != nil {
		return nil, fmt.Errorf("resolve path: %w", err)
	}
	resolvedRoot, _ := filepath.EvalSymlinks(root)
	// String-prefix check would let `/library_secrets/...` slip past a root
	// of `/library`. filepath.Rel returns a leading `..` when the target is
	// outside the root, regardless of separator handling.
	rel, err := filepath.Rel(resolvedRoot, resolved)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return nil, fmt.Errorf("path escapes scan root")
	}

	entries, err := os.ReadDir(resolved)
	if err != nil {
		return nil, fmt.Errorf("read dir: %w", err)
	}

	result := &BrowseResult{Path: relPath, Entries: []BrowseEntry{}}
	for _, entry := range entries {
		name := entry.Name()
		if strings.HasPrefix(name, ".") {
			continue
		}
		if entry.IsDir() {
			result.Entries = append(result.Entries, BrowseEntry{Name: name, IsDir: true})
			continue
		}
		if !IsSupportedFile(name) {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		result.Entries = append(result.Entries, BrowseEntry{
			Name: name, IsDir: false, Size: info.Size(),
			ModTime: info.ModTime().Unix(), FileType: FileTypeFromExt(name),
		})
	}
	return result, nil
}

// FolderNode represents a directory in the folder tree.
//
// `FileIDs` lists files in this directory by their database ID — the client
// resolves them via its own Map<id,file>. Embedding full FileRecords here
// duplicates the entire dataset on the wire (the same rows already ship via
// /api/databank/files), so for 100k+ entries it doubles the cold-load
// payload for no benefit.
type FolderNode struct {
	Name     string        `json:"name"`
	Path     string        `json:"path"`
	Children []*FolderNode `json:"children,omitempty"`
	FileIDs  []int64       `json:"file_ids,omitempty"`
}

// BuildFolderTree constructs a tree from all files in the database.
// Only IDs are emitted per leaf; the client joins back to the file list.
func (s *Scanner) BuildFolderTree() (*FolderNode, error) {
	rows, err := s.db.AllFilePathsAndIDs(context.Background())
	if err != nil {
		return nil, err
	}

	root := &FolderNode{Name: "/", Path: ""}
	nodeMap := map[string]*FolderNode{"": root}

	for _, r := range rows {
		dir := filepath.Dir(r.Path)
		if dir == "." {
			dir = ""
		}
		node := ensureDirNode(nodeMap, root, dir)
		node.FileIDs = append(node.FileIDs, r.ID)
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
