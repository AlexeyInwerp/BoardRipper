package databank

import (
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// ScanStatus reports the current state of a scan operation.
type ScanStatus struct {
	Running  bool  `json:"running"`
	Scanned  int64 `json:"scanned"`
	Total    int64 `json:"total"`
	Added    int64 `json:"added"`
	Updated  int64 `json:"updated"`
	Deleted  int64 `json:"deleted"`
	Errors   int64 `json:"errors"`
	Duration int64 `json:"duration_ms"`
}

// Scanner walks DATA_DIR and syncs findings with the database.
type Scanner struct {
	db      *DB
	dataDir string

	mu     sync.Mutex
	status ScanStatus
}

// NewScanner creates a scanner for the given data directory.
func NewScanner(db *DB, dataDir string) *Scanner {
	return &Scanner{db: db, dataDir: dataDir}
}

// Status returns the current scan status.
func (s *Scanner) Status() ScanStatus {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.status
}

// Scan performs a full incremental scan. It's safe to call from multiple goroutines
// but only one scan runs at a time.
func (s *Scanner) Scan() ScanStatus {
	s.mu.Lock()
	if s.status.Running {
		st := s.status
		s.mu.Unlock()
		return st
	}
	s.status = ScanStatus{Running: true}
	s.mu.Unlock()

	start := time.Now()

	var added, updated, deleted, errors, scanned, total int64

	// Phase 1: Walk filesystem and collect all supported files
	type diskFile struct {
		relPath string
		size    int64
		modTime int64
	}
	var diskFiles []diskFile

	err := filepath.Walk(s.dataDir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil // skip errors
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

		relPath, _ := filepath.Rel(s.dataDir, path)
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

	total = int64(len(diskFiles))
	s.mu.Lock()
	s.status.Total = total
	s.mu.Unlock()

	// Phase 2: Get existing DB records for diff
	existing, err := s.db.AllFilePaths()
	if err != nil {
		log.Printf("Scanner: failed to read existing files: %v", err)
		s.mu.Lock()
		s.status.Running = false
		s.status.Errors = 1
		s.mu.Unlock()
		return s.Status()
	}

	// Phase 3: Process each disk file
	seen := make(map[string]bool, len(diskFiles))

	for _, df := range diskFiles {
		seen[df.relPath] = true
		atomic.AddInt64(&scanned, 1)

		s.mu.Lock()
		s.status.Scanned = scanned
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
			// New file — insert
			meta := ExtractMetadata(df.relPath)
			fileType := FileTypeFromExt(df.relPath)
			ext := strings.ToLower(filepath.Ext(df.relPath))

			rec := &FileRecord{
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
			}

			if _, err := s.db.InsertFile(rec); err != nil {
				log.Printf("Scanner: insert error for %s: %v", df.relPath, err)
				atomic.AddInt64(&errors, 1)
				continue
			}
			atomic.AddInt64(&added, 1)
		}
	}

	// Phase 4: Delete DB records for files no longer on disk
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
	s.autoMatchBindings()

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
	s.mu.Unlock()

	log.Printf("Scanner: done in %dms — %d files, %d added, %d updated, %d deleted, %d errors",
		duration, total, added, updated, deleted, errors)

	return s.Status()
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
