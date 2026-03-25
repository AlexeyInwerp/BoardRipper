# Scanner Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split file scanning and PDF extraction into independent operations, add live filesystem browsing, database management UI, scan persistence, and cancellation fixes.

**Architecture:** Backend scanner gets `activeOp` mutex to enforce one operation at a time. PDF extractor gains cancellation via `context.Context`. Frontend persists scan status to localStorage and only polls when backend reports activity. Settings panel gains database stats and reset buttons. Live browse endpoint reads filesystem on demand.

**Tech Stack:** Go (net/http, SQLite), React 19, TypeScript, pdfjs-dist

**Spec:** `docs/superpowers/specs/2026-03-25-scanner-overhaul-design.md`

---

## File Map

**Backend (modify):**
- `src/backend/databank/scanner.go` — remove postScanFn, add activeOp tracking, ScanPdfAsync, browse
- `src/backend/databank/pdftext.go` — add cancellation (done channel + context) to ExtractAll/ExtractOne
- `src/backend/databank/db.go` — add Stats(), ResetAll(), ResetPdfText() methods
- `src/backend/handlers/databank.go` — add ScanPdf, Stats, Reset, ResetPdf, Browse handlers; remove Reextract
- `src/backend/main.go` — remove auto-scan + postScanFn, conditional auto_scan, register new routes

**Frontend (modify):**
- `src/frontend/src/store/databank-store.ts` — split triggerScan/triggerPdfScan, localStorage persistence, browse API, stats
- `src/frontend/src/panels/LibraryPanel.tsx` — two scan buttons, folders mode toggle, live browser
- `src/frontend/src/panels/SettingsPanel.tsx` — DB info section, auto-scan toggle, reset buttons

---

**Review fixes applied:** Tasks 1-3 merged into single backend task to avoid non-compiling commit boundaries. `activeOp` clearing moved into `finishScan`. Reset uses scanner-level method with atomic mutex. `useDatabank` hook exposes all 4 new fields. `AutoScanToggle` uses direct fetch. Synchronous `Scan()` documented as non-cancellable. `ReextractAll` removed as dead code.

### Task 1: Backend — All scanner, extractor, handler, and main.go changes

**Files:**
- Modify: `src/backend/databank/scanner.go`

- [ ] **Step 1: Add activeOp field and PdfCompletedAt to Scanner/ScanStatus**

In `scanner.go`, update `ScanStatus` to add `PdfCompletedAt`:

```go
// In ScanStatus struct, after PdfCurrent:
PdfCompletedAt int64 `json:"pdf_completed_at,omitempty"`
```

Update `Scanner` struct — replace `postScanFn` with `activeOp`:

```go
type Scanner struct {
	db         *DB
	dataDir    string
	libraryDir string

	mu        sync.Mutex
	status    ScanStatus
	cancelCh  chan struct{}
	cancelFn  func()
	activeOp  string // "", "file", or "pdf"
	extractor *PdfExtractor // set via SetExtractor
}
```

- [ ] **Step 2: Remove SetPostScanFn and runPostScan methods**

Delete `SetPostScanFn()` and `runPostScan()` functions entirely.

- [ ] **Step 3: Update ScanAsync to set activeOp and remove postScan call**

```go
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
		s.mu.Lock()
		s.activeOp = ""
		s.cancelFn = nil
		s.cancelCh = nil
		s.mu.Unlock()
	}()
	return s.Status(), nil
}
```

- [ ] **Step 4: Add ScanPdfAsync method**

```go
func (s *Scanner) ScanPdfAsync() (ScanStatus, error) {
	s.mu.Lock()
	if s.activeOp != "" {
		st := s.status
		s.mu.Unlock()
		return st, fmt.Errorf("operation %q already running", s.activeOp)
	}
	if s.extractor == nil {
		s.mu.Unlock()
		return ScanStatus{}, fmt.Errorf("no extractor configured")
	}
	s.activeOp = "pdf"
	done := make(chan struct{})
	s.cancelCh = done
	s.cancelFn = func() { close(done) }
	s.mu.Unlock()

	go func() {
		log.Println("PDF extraction: starting...")
		extracted, errors := s.extractor.ExtractAllCancellable(2, done)
		log.Printf("PDF extraction: done — %d extracted, %d errors", extracted, errors)

		s.mu.Lock()
		s.status.PdfCompletedAt = time.Now().Unix()
		s.activeOp = ""
		s.cancelFn = nil
		s.cancelCh = nil
		s.mu.Unlock()
		s.persistStatus()
	}()
	return s.Status(), nil
}
```

- [ ] **Step 5: Add SetExtractor and ActiveOp methods**

```go
func (s *Scanner) SetExtractor(e *PdfExtractor) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.extractor = e
}

func (s *Scanner) ActiveOp() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.activeOp
}
```

- [ ] **Step 6: Update StopScan to work for both operations**

```go
func (s *Scanner) StopScan() ScanStatus {
	s.mu.Lock()
	if s.cancelFn != nil {
		s.cancelFn()
		// Don't nil out cancelFn here — the goroutine clears activeOp when it exits
	}
	s.mu.Unlock()
	return s.Status()
}
```

- [ ] **Step 7: Update Scan (synchronous) to use activeOp**

```go
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

	s.mu.Lock()
	s.activeOp = ""
	s.mu.Unlock()

	return s.Status()
}
```

- [ ] **Step 8: Verify build**

Run: `cd src/backend && go build ./...`
Expected: Build succeeds (pdftext changes come in Task 2).

Note: Build may fail because `ExtractAllCancellable` doesn't exist yet — that's expected. Proceed to Task 2.

- [ ] **Step 9: Commit**

```bash
git add src/backend/databank/scanner.go
git commit -m "refactor: decouple scanner ops with activeOp mutex, remove postScanFn"
```

---

### Task 2: Backend — Add cancellation to PDF extractor

**Files:**
- Modify: `src/backend/databank/pdftext.go`

- [ ] **Step 1: Add ExtractAllCancellable method**

Add a new method that wraps `ExtractAll` logic but checks a `done` channel:

```go
// ExtractAllCancellable is like ExtractAll but supports cancellation via done channel.
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

	cancelled := func() bool {
		if done == nil {
			return false
		}
		select {
		case <-done:
			return true
		default:
			return false
		}
	}

	work := make(chan FileRecord, concurrency)
	var mu sync.Mutex
	var wg sync.WaitGroup

	for i := 0; i < concurrency; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for file := range work {
				if cancelled() {
					continue // drain channel
				}
				if err := e.ExtractOneCancellable(file, done); err != nil {
					log.Printf("PdfExtractor: error extracting %s: %v", file.Filename, err)
					e.logScanError(file, err)
					mu.Lock()
					errors++
					mu.Unlock()
				} else {
					mu.Lock()
					extracted++
					mu.Unlock()
				}

				if e.scanner != nil {
					mu.Lock()
					e.scanner.SetPdfStatus(true, int64(extracted), total, int64(errors), file.Filename)
					mu.Unlock()
				}
			}
		}()
	}

	for _, f := range toExtract {
		if cancelled() {
			break
		}
		work <- f
	}
	close(work)
	wg.Wait()
	log.Printf("PdfExtractor: done — %d extracted, %d errors", extracted, errors)

	if e.scanner != nil {
		e.scanner.SetPdfStatus(false, int64(extracted), total, int64(errors), "")
	}

	return extracted, errors
}
```

- [ ] **Step 2: Add ExtractOneCancellable that uses context from done channel**

```go
// ExtractOneCancellable is like ExtractOne but cancels via done channel.
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

	// Derive context from done channel — cancels both timeout and stop
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
		if done != nil {
			select {
			case <-done:
				return fmt.Errorf("extract %s: cancelled", file.Filename)
			default:
			}
		}
		return fmt.Errorf("extract %s: timeout after %v", file.Filename, extractTimeout)
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
```

- [ ] **Step 3: Verify build**

Run: `cd src/backend && go build ./...`
Expected: Build succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/backend/databank/pdftext.go
git commit -m "feat: add cancellable PDF extraction with done channel + context"
```

---

### Task 3: Backend — Add Stats, Reset, Browse endpoints and DB methods

**Files:**
- Modify: `src/backend/databank/db.go`
- Modify: `src/backend/databank/scanner.go` (browse method)
- Modify: `src/backend/handlers/databank.go`
- Modify: `src/backend/main.go`

- [ ] **Step 1: Add Stats struct and method to db.go**

```go
// DatabankStats holds aggregate database info.
type DatabankStats struct {
	Boards         int   `json:"boards"`
	Pdfs           int   `json:"pdfs"`
	Bindings       int   `json:"bindings"`
	PdfPages       int   `json:"pdf_pages"`
	PdfErrors      int   `json:"pdf_errors"`
	DbSizeBytes    int64 `json:"db_size_bytes"`
	LastFileScanAt int64 `json:"last_file_scan_at"`
	LastPdfScanAt  int64 `json:"last_pdf_scan_at"`
}

func (db *DB) Stats(dataDir string) (*DatabankStats, error) {
	s := &DatabankStats{}

	db.reader.QueryRow(`SELECT COUNT(*) FROM files WHERE file_type='board'`).Scan(&s.Boards)
	db.reader.QueryRow(`SELECT COUNT(*) FROM files WHERE file_type='pdf'`).Scan(&s.Pdfs)
	db.reader.QueryRow(`SELECT COUNT(*) FROM bindings`).Scan(&s.Bindings)
	db.reader.QueryRow(`SELECT COUNT(*) FROM pdf_pages WHERE page_num > 0`).Scan(&s.PdfPages)
	db.reader.QueryRow(`SELECT COUNT(*) FROM pdf_scan_errors`).Scan(&s.PdfErrors)

	// Sum DB file sizes (main + WAL + SHM)
	for _, suffix := range []string{"", "-wal", "-shm"} {
		path := filepath.Join(dataDir, "databank.db"+suffix)
		if info, err := os.Stat(path); err == nil {
			s.DbSizeBytes += info.Size()
		}
	}

	if v, err := db.GetConfig("last_file_scan_at"); err == nil && v != "" {
		fmt.Sscanf(v, "%d", &s.LastFileScanAt)
	}
	if v, err := db.GetConfig("last_pdf_scan_at"); err == nil && v != "" {
		fmt.Sscanf(v, "%d", &s.LastPdfScanAt)
	}

	return s, nil
}
```

- [ ] **Step 2: Add ResetAll and ResetPdfText to db.go**

```go
// ResetAll wipes all scan data from the database.
func (db *DB) ResetAll(dataDir string) error {
	db.mu.Lock()
	defer db.mu.Unlock()

	stmts := []string{
		`DELETE FROM pdf_text`,
		`DELETE FROM pdf_pages`,
		`DELETE FROM pdf_scan_errors`,
		`DELETE FROM bindings`,
		`DELETE FROM files`,
	}
	for _, stmt := range stmts {
		if _, err := db.writer.Exec(stmt); err != nil {
			return fmt.Errorf("reset %s: %w", stmt, err)
		}
	}

	// Clear config keys (without holding mu again — we already hold it)
	for _, key := range []string{"last_scan_status", "last_file_scan_at", "last_pdf_scan_at"} {
		db.writer.Exec(`DELETE FROM config WHERE key = ?`, key)
	}

	// Delete preview PNGs
	previewDir := filepath.Join(dataDir, ".previews")
	os.RemoveAll(previewDir)

	return nil
}

// ResetPdfText wipes PDF text and error data only.
func (db *DB) ResetPdfText() error {
	db.mu.Lock()
	defer db.mu.Unlock()

	stmts := []string{
		`DELETE FROM pdf_text`,
		`DELETE FROM pdf_pages`,
		`DELETE FROM pdf_scan_errors`,
	}
	for _, stmt := range stmts {
		if _, err := db.writer.Exec(stmt); err != nil {
			return fmt.Errorf("reset-pdf %s: %w", stmt, err)
		}
	}

	db.writer.Exec(`DELETE FROM config WHERE key = ?`, "last_pdf_scan_at")
	return nil
}
```

- [ ] **Step 3: Add BrowseDir to scanner.go**

```go
// BrowseEntry is a single item in a directory listing.
type BrowseEntry struct {
	Name     string `json:"name"`
	IsDir    bool   `json:"is_dir"`
	Size     int64  `json:"size,omitempty"`
	ModTime  int64  `json:"mod_time,omitempty"`
	FileType string `json:"file_type,omitempty"`
}

// BrowseResult is a directory listing response.
type BrowseResult struct {
	Path    string        `json:"path"`
	Entries []BrowseEntry `json:"entries"`
}

// BrowseDir returns a live filesystem listing of the given relative path under ScanRoot.
func (s *Scanner) BrowseDir(relPath string) (*BrowseResult, error) {
	root := s.ScanRoot()

	// Clean and validate path
	relPath = filepath.Clean(relPath)
	if relPath == "." {
		relPath = ""
	}

	absPath := filepath.Join(root, relPath)

	// Resolve symlinks and verify we're still within scan root
	resolved, err := filepath.EvalSymlinks(absPath)
	if err != nil {
		return nil, fmt.Errorf("resolve path: %w", err)
	}
	resolvedRoot, _ := filepath.EvalSymlinks(root)
	if !strings.HasPrefix(resolved, resolvedRoot) {
		return nil, fmt.Errorf("path escapes scan root")
	}

	entries, err := os.ReadDir(resolved)
	if err != nil {
		return nil, fmt.Errorf("read dir: %w", err)
	}

	result := &BrowseResult{Path: relPath, Entries: []BrowseEntry{}}

	for _, entry := range entries {
		name := entry.Name()

		// Skip hidden
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
			Name:     name,
			IsDir:    false,
			Size:     info.Size(),
			ModTime:  info.ModTime().Unix(),
			FileType: FileTypeFromExt(name),
		})
	}

	return result, nil
}
```

- [ ] **Step 4: Add handler methods to databank.go**

Add to `handlers/databank.go`:

```go
// ScanPdf triggers PDF text extraction only.
func (h *DatabankHandler) ScanPdf(w http.ResponseWriter, r *http.Request) {
	status, err := h.scanner.ScanPdfAsync()
	if err != nil {
		http.Error(w, err.Error(), http.StatusConflict)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(status)
}

// Stats returns database statistics.
func (h *DatabankHandler) Stats(w http.ResponseWriter, r *http.Request) {
	stats, err := h.db.Stats(h.dataDir)
	if err != nil {
		http.Error(w, "Failed to get stats: "+err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(stats)
}

// Reset wipes all scan data.
func (h *DatabankHandler) Reset(w http.ResponseWriter, r *http.Request) {
	if op := h.scanner.ActiveOp(); op != "" {
		http.Error(w, "Cannot reset while "+op+" scan is running", http.StatusConflict)
		return
	}
	if err := h.db.ResetAll(h.dataDir); err != nil {
		http.Error(w, "Reset failed: "+err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "reset"})
}

// ResetPdf wipes PDF text data only.
func (h *DatabankHandler) ResetPdf(w http.ResponseWriter, r *http.Request) {
	if op := h.scanner.ActiveOp(); op != "" {
		http.Error(w, "Cannot reset while "+op+" scan is running", http.StatusConflict)
		return
	}
	if err := h.db.ResetPdfText(); err != nil {
		http.Error(w, "Reset failed: "+err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "reset"})
}

// Browse returns a live filesystem directory listing.
func (h *DatabankHandler) Browse(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Query().Get("path")
	result, err := h.scanner.BrowseDir(path)
	if err != nil {
		http.Error(w, "Browse failed: "+err.Error(), http.StatusBadRequest)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(result)
}
```

Also update `Scan` handler to return 409 on conflict:

```go
func (h *DatabankHandler) Scan(w http.ResponseWriter, r *http.Request) {
	status, err := h.scanner.ScanAsync()
	if err != nil {
		http.Error(w, err.Error(), http.StatusConflict)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(status)
}
```

- [ ] **Step 5: Update main.go — remove auto-scan, add routes**

Replace the postScanFn setup and startup goroutine with conditional auto-scan:

```go
// Replace lines 49-67 with:
scanner.SetExtractor(extractor)

// Conditional auto-scan based on config (default: off)
if autoScan, _ := db.GetConfig("auto_scan"); autoScan == "true" {
	go func() {
		log.Println("Auto-scan: starting file indexing...")
		status := scanner.Scan()
		log.Printf("Auto-scan complete: %d files (%d added, %d updated, %d deleted) in %dms",
			status.Total, status.Added, status.Updated, status.Deleted, status.Duration)
	}()
} else {
	log.Println("Auto-scan disabled (set auto_scan=true in config to enable)")
}
```

Add new routes and remove old `reextract`:

```go
// Replace: mux.HandleFunc("POST /api/databank/reextract", dbHandler.Reextract)
// With:
mux.HandleFunc("POST /api/databank/scan/pdf", dbHandler.ScanPdf)
mux.HandleFunc("GET /api/databank/stats", dbHandler.Stats)
mux.HandleFunc("POST /api/databank/reset", dbHandler.Reset)
mux.HandleFunc("POST /api/databank/reset-pdf", dbHandler.ResetPdf)
mux.HandleFunc("GET /api/databank/browse", dbHandler.Browse)
```

- [ ] **Step 6: Store last_file_scan_at in finishScan**

In `scanner.go` `finishScan()`, after `s.persistStatus()`, add:

```go
if !stopped {
	_ = s.db.SetConfig("last_file_scan_at", fmt.Sprintf("%d", time.Now().Unix()))
}
```

- [ ] **Step 7: Store last_pdf_scan_at in ScanPdfAsync**

Already handled in the ScanPdfAsync goroutine above (via `PdfCompletedAt`). Also add:

```go
_ = s.db.SetConfig("last_pdf_scan_at", fmt.Sprintf("%d", time.Now().Unix()))
```

after `s.status.PdfCompletedAt = time.Now().Unix()` in the ScanPdfAsync goroutine.

- [ ] **Step 8: Verify build**

Run: `cd src/backend && go build ./...`
Expected: Build succeeds.

- [ ] **Step 9: Commit**

```bash
git add src/backend/
git commit -m "feat: add stats, reset, browse endpoints; remove auto-scan and reextract"
```

---

### Task 4: Frontend — Split scan operations and add localStorage persistence

**Files:**
- Modify: `src/frontend/src/store/databank-store.ts`

- [ ] **Step 1: Add ScanStatus completed_at and pdf_completed_at fields**

In the `ScanStatus` interface, add:

```typescript
completed_at?: number;
pdf_completed_at?: number;
```

- [ ] **Step 2: Add DatabankStats interface**

```typescript
export interface DatabankStats {
  boards: number;
  pdfs: number;
  bindings: number;
  pdf_pages: number;
  pdf_errors: number;
  db_size_bytes: number;
  last_file_scan_at: number;
  last_pdf_scan_at: number;
}
```

- [ ] **Step 3: Add BrowseEntry and BrowseResult interfaces**

```typescript
export interface BrowseEntry {
  name: string;
  is_dir: boolean;
  size?: number;
  mod_time?: number;
  file_type?: string;
}

export interface BrowseResult {
  path: string;
  entries: BrowseEntry[];
}
```

- [ ] **Step 4: Add stats and browse state to DatabankStore**

Add private fields:

```typescript
private _stats: DatabankStats | null = null;
private _browseMode: 'database' | 'live' = (() => {
  try { return (localStorage.getItem('boardripper-library-browse-mode') as 'database' | 'live') || 'database'; }
  catch { return 'database' as const; }
})();
private _browseResult: BrowseResult | null = null;
private _browsing = false;
```

Add getters:

```typescript
get stats() { return this._stats; }
get browseMode() { return this._browseMode; }
get browseResult() { return this._browseResult; }
get browsing() { return this._browsing; }
```

- [ ] **Step 5: Restore scan status from localStorage on construction**

Add to the class constructor area (after `_backendAvailable`):

```typescript
// Restore last scan status from localStorage
private _scanStatus: ScanStatus | null = (() => {
  try {
    const stored = localStorage.getItem('boardripper-scan-status');
    return stored ? JSON.parse(stored) : null;
  } catch { return null; }
})();
```

Remove the existing `private _scanStatus: ScanStatus | null = null;` line.

- [ ] **Step 6: Persist scan status to localStorage after each update**

Add a helper method:

```typescript
private _persistScanStatus() {
  try {
    if (this._scanStatus) {
      localStorage.setItem('boardripper-scan-status', JSON.stringify(this._scanStatus));
    }
  } catch { /* ignore */ }
}
```

Call `this._persistScanStatus()` in:
- End of `_startScanPolling` interval callback (after `this._scanStatus = status`)
- End of `stopScan` (after `this._scanStatus = status`)
- End of `triggerScan` (Electron branch)

- [ ] **Step 7: Split triggerScan into triggerFileScan and triggerPdfScan**

Rename `triggerScan()` to `triggerFileScan()` and add `triggerPdfScan()`:

```typescript
async triggerFileScan(): Promise<void> {
  log.scan.log('File scan: starting...');
  this._scanStatus = { running: true, scanned: 0, total: 0, added: 0, updated: 0, deleted: 0, errors: 0, duration_ms: 0 };
  this.notify();

  if (isElectron()) {
    await this._electronScan();
    this._scanStatus = {
      running: false, scanned: this._files.length, total: this._files.length,
      added: this._files.length, updated: 0, deleted: 0, errors: 0, duration_ms: 0,
    };
    this._persistScanStatus();
    this.notify();
  } else {
    const res = await this.apiFetch<ScanStatus>('/api/databank/scan', { method: 'POST' });
    if (!res) return; // 409 or error
    this._startScanPolling();
  }
}

async triggerPdfScan(): Promise<void> {
  log.scan.log('PDF extraction: starting...');
  const res = await this.apiFetch<ScanStatus>('/api/databank/scan/pdf', { method: 'POST' });
  if (!res) return;
  this._startScanPolling();
}
```

- [ ] **Step 8: Add fetchStats, resetAll, resetPdf, browse methods**

```typescript
async fetchStats(): Promise<void> {
  const data = await this.apiFetch<DatabankStats>('/api/databank/stats');
  if (data) {
    this._stats = data;
    this.notify();
  }
}

async resetAll(): Promise<boolean> {
  const res = await this.apiFetch<{ status: string }>('/api/databank/reset', { method: 'POST' });
  if (res) {
    log.scan.log('Database reset complete');
    this._files = [];
    this._folderTree = null;
    this._scanStatus = null;
    this._stats = null;
    try { localStorage.removeItem('boardripper-scan-status'); } catch { /* ignore */ }
    await this.fetchStats();
    this.notify();
    return true;
  }
  return false;
}

async resetPdf(): Promise<boolean> {
  const res = await this.apiFetch<{ status: string }>('/api/databank/reset-pdf', { method: 'POST' });
  if (res) {
    log.scan.log('PDF text reset complete');
    await this.fetchStats();
    this.notify();
    return true;
  }
  return false;
}

async browse(path: string): Promise<void> {
  this._browsing = true;
  this.notify();
  const data = await this.apiFetch<BrowseResult>(`/api/databank/browse?path=${encodeURIComponent(path)}`);
  if (data) {
    this._browseResult = data;
  }
  this._browsing = false;
  this.notify();
}

setBrowseMode(mode: 'database' | 'live') {
  this._browseMode = mode;
  try { localStorage.setItem('boardripper-library-browse-mode', mode); } catch { /* ignore */ }
  if (mode === 'live') {
    this.browse(''); // load root
  }
  this.notify();
}
```

- [ ] **Step 9: Update checkScanStatus to log transitions**

Add logging to `checkScanStatus`:

```typescript
async checkScanStatus(): Promise<void> {
  if (isElectron()) return;
  const status = await this.apiFetch<ScanStatus>('/api/databank/scan/status');
  if (status) {
    this._scanStatus = status;
    this._persistScanStatus();
    this.notify();
    if (status.running || status.pdf_running) {
      log.scan.log(`Resuming poll: ${status.running ? 'file scan' : 'PDF extraction'} in progress`);
      this._startScanPolling();
    }
  }
}
```

- [ ] **Step 10: Verify build**

Run: `cd src/frontend && npx tsc -b --noEmit`
Expected: Clean build.

- [ ] **Step 11: Commit**

```bash
git add src/frontend/src/store/databank-store.ts
git commit -m "feat: split scan ops, add localStorage persistence, stats/reset/browse API"
```

---

### Task 5: Frontend — Update LibraryPanel with two scan buttons and live browser

**Files:**
- Modify: `src/frontend/src/panels/LibraryPanel.tsx`

- [ ] **Step 1: Update scan button references**

Replace all references to `databankStore.triggerScan()` with `databankStore.triggerFileScan()`.

- [ ] **Step 2: Replace single Scan button with two buttons**

Replace the scan button block (lines ~181-196) with:

```tsx
{scanStatus?.running ? (
  <button className="library-scan-btn library-scan-stop"
    onClick={() => databankStore.stopScan()} title="Stop file scan">Stop</button>
) : scanStatus?.pdf_running ? (
  <button className="library-scan-btn library-scan-stop"
    onClick={() => databankStore.stopScan()} title="Stop PDF extraction">Stop</button>
) : (
  <>
    <button className="library-scan-btn"
      onClick={() => databankStore.triggerFileScan()}
      title="Scan filesystem for board and PDF files">Files</button>
    <button className="library-scan-btn"
      onClick={() => databankStore.triggerPdfScan()}
      title="Extract text from PDFs for full-text search">PDFs</button>
  </>
)}
```

- [ ] **Step 3: Add Database/Live toggle when Folders tab active**

After the view mode tabs div, add a conditional toggle:

```tsx
{viewMode === 'folders' && (
  <div className="library-browse-toggle">
    <button className={`library-tab ${browseMode === 'database' ? 'active' : ''}`}
      onClick={() => databankStore.setBrowseMode('database')}>Database</button>
    <button className={`library-tab ${browseMode === 'live' ? 'active' : ''}`}
      onClick={() => databankStore.setBrowseMode('live')}>Live</button>
  </div>
)}
```

Wire up the `browseMode` from the hook (add to `useDatabank` destructure).

- [ ] **Step 4: Add LiveBrowser component**

Add a simple component that renders the browse result:

```tsx
function LiveBrowser() {
  const { browseResult, browsing } = useDatabank();
  const [currentPath, setCurrentPath] = useState('');

  useEffect(() => {
    databankStore.browse(currentPath);
  }, [currentPath]);

  if (browsing) return <div className="library-empty">Loading...</div>;
  if (!browseResult) return <div className="library-empty">No data</div>;

  const entries = browseResult.entries;
  const dirs = entries.filter(e => e.is_dir).sort((a, b) => a.name.localeCompare(b.name));
  const files = entries.filter(e => !e.is_dir).sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="library-file-list">
      {currentPath && (
        <div className="library-file-row library-folder-row"
          onClick={() => setCurrentPath(currentPath.split('/').slice(0, -1).join('/'))}>
          <span className="library-file-icon">↩</span>
          <span className="library-file-name">..</span>
        </div>
      )}
      {dirs.map(d => (
        <div key={d.name} className="library-file-row library-folder-row"
          onClick={() => setCurrentPath(currentPath ? `${currentPath}/${d.name}` : d.name)}>
          <span className="library-file-icon">📁</span>
          <span className="library-file-name">{d.name}</span>
        </div>
      ))}
      {files.map(f => (
        <div key={f.name} className="library-file-row"
          onDoubleClick={() => handleOpenLiveFile(currentPath ? `${currentPath}/${f.name}` : f.name, f.name)}>
          <span className="library-file-icon">{f.file_type === 'pdf' ? '📄' : '🔧'}</span>
          <span className="library-file-name">{f.name}</span>
          <span className="library-file-size">{f.size ? formatSize(f.size) : ''}</span>
        </div>
      ))}
      {dirs.length === 0 && files.length === 0 && (
        <div className="library-empty">Empty directory</div>
      )}
    </div>
  );
}
```

Note: `handleOpenLiveFile` will use `databankStore.fetchFileBuffer` with a synthesized DatabankFile-like object, or directly fetch via `/api/files/path/`. Wire it to the existing file-open logic used by the panel. The exact wiring depends on how files are opened in the panel — look at the existing `onDoubleClick` handler for database files and replicate the pattern.

- [ ] **Step 5: Render LiveBrowser when in live folders mode**

In the main render, where the folders tree is shown, add a condition:

```tsx
{viewMode === 'folders' && browseMode === 'live' ? (
  <LiveBrowser />
) : viewMode === 'folders' ? (
  /* existing folder tree rendering */
) : /* ... existing metadata/model views */}
```

- [ ] **Step 6: Hide scan buttons in live mode**

Wrap the scan buttons area with a condition:

```tsx
{!(viewMode === 'folders' && browseMode === 'live') && (
  /* scan buttons + checkboxes */
)}
```

- [ ] **Step 7: Verify build**

Run: `cd src/frontend && npx tsc -b --noEmit`

- [ ] **Step 8: Commit**

```bash
git add src/frontend/src/panels/LibraryPanel.tsx
git commit -m "feat: split scan buttons, add live filesystem browser in folders view"
```

---

### Task 6: Frontend — Settings panel: DB info, auto-scan, reset buttons

**Files:**
- Modify: `src/frontend/src/panels/SettingsPanel.tsx`
- Modify: `src/frontend/src/hooks/useDatabank.ts` (expose stats)

- [ ] **Step 1: Expose stats in useDatabank hook**

In `src/frontend/src/hooks/useDatabank.ts`, add `stats` and `browseMode` to the returned object from the `getSnapshot` function. Check the existing pattern and add:

```typescript
stats: databankStore.stats,
browseMode: databankStore.browseMode,
```

- [ ] **Step 2: Add DatabaseInfoSection component to SettingsPanel**

```tsx
function DatabaseInfoSection() {
  const { stats, backendAvailable, scanStatus } = useDatabank();
  const [resetting, setResetting] = useState(false);

  useEffect(() => {
    if (backendAvailable) databankStore.fetchStats();
  }, [backendAvailable]);

  if (!backendAvailable) {
    return <div className="color-rule-hint">Backend not available.</div>;
  }

  const formatBytes = (b: number) => {
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
    return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  };

  const formatTime = (ts: number) => {
    if (!ts) return 'Never';
    return new Date(ts * 1000).toLocaleString();
  };

  const handleReset = async () => {
    if (!confirm('Reset entire database? This deletes all indexed files, bindings, and PDF text.')) return;
    setResetting(true);
    await databankStore.resetAll();
    setResetting(false);
  };

  const handleResetPdf = async () => {
    if (!confirm('Reset all PDF text? File index and bindings will be kept.')) return;
    setResetting(true);
    await databankStore.resetPdf();
    setResetting(false);
  };

  const scanning = scanStatus?.running || scanStatus?.pdf_running;

  return (
    <div className="settings-db-info">
      {stats && (
        <>
          <div className="settings-row settings-toggle-row">
            <label className="settings-label">Board files</label>
            <span>{stats.boards}</span>
          </div>
          <div className="settings-row settings-toggle-row">
            <label className="settings-label">PDF files</label>
            <span>{stats.pdfs}</span>
          </div>
          <div className="settings-row settings-toggle-row">
            <label className="settings-label">Bindings</label>
            <span>{stats.bindings}</span>
          </div>
          <div className="settings-row settings-toggle-row">
            <label className="settings-label">PDF pages indexed</label>
            <span>{stats.pdf_pages}</span>
          </div>
          <div className="settings-row settings-toggle-row">
            <label className="settings-label">PDF scan errors</label>
            <span>{stats.pdf_errors}</span>
          </div>
          <div className="settings-row settings-toggle-row">
            <label className="settings-label">Database size</label>
            <span>{formatBytes(stats.db_size_bytes)}</span>
          </div>
          <div className="settings-row settings-toggle-row">
            <label className="settings-label">Last file scan</label>
            <span>{formatTime(stats.last_file_scan_at)}</span>
          </div>
          <div className="settings-row settings-toggle-row">
            <label className="settings-label">Last PDF scan</label>
            <span>{formatTime(stats.last_pdf_scan_at)}</span>
          </div>
        </>
      )}
      <div className="settings-library-edit" style={{ marginTop: 8, gap: 6 }}>
        <button className="settings-action-btn" onClick={handleResetPdf}
          disabled={resetting || !!scanning}>Reset PDF Text</button>
        <button className="settings-action-btn" onClick={handleReset}
          disabled={resetting || !!scanning}
          style={{ color: '#f87171' }}>Reset Database</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Add AutoScanToggle component**

```tsx
function AutoScanToggle() {
  const { backendAvailable } = useDatabank();
  const [autoScan, setAutoScan] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!backendAvailable) return;
    (async () => {
      const cfg = await databankStore.apiFetch<Record<string, string>>('/api/config');
      if (cfg) {
        setAutoScan(cfg.auto_scan === 'true');
        setLoaded(true);
      }
    })();
  }, [backendAvailable]);

  const toggle = async (v: boolean) => {
    setAutoScan(v);
    await databankStore.apiFetch('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'auto_scan', value: v ? 'true' : '' }),
    });
  };

  if (!loaded) return null;

  return (
    <div className="settings-row settings-toggle-row">
      <label className="settings-label">Auto-scan on startup</label>
      <input type="checkbox" checked={autoScan} onChange={e => toggle(e.target.checked)} />
    </div>
  );
}
```

Note: `apiFetch` is private on `DatabankStore`. Either make it public or use a direct `fetch` call. Simplest: use direct fetch with try/catch.

- [ ] **Step 4: Add both components to the Server/Library section**

Replace the existing section content:

```tsx
<CollapsibleSection id="server" title="Server / Library" isOpen={openSections.has('server')}
  onToggle={toggleSection} sectionRef={serverRef} isFocused={focusedSection === 'server'}>
  <LibraryFolderSetting />
  <AutoScanToggle />
  <DatabaseInfoSection />
</CollapsibleSection>
```

- [ ] **Step 5: Verify build**

Run: `cd src/frontend && npx tsc -b --noEmit`

- [ ] **Step 6: Commit**

```bash
git add src/frontend/
git commit -m "feat: add DB stats, auto-scan toggle, and reset buttons to settings"
```

---

### Task 7: Integration test and cleanup

- [ ] **Step 1: Restart backend and verify new endpoints**

```bash
kill $(lsof -ti :1336) 2>/dev/null
cd src/backend && PORT=1336 go run . &
sleep 2

# Test stats
curl -s http://localhost:1336/api/databank/stats | python3 -m json.tool

# Test browse
curl -s "http://localhost:1336/api/databank/browse?path=" | python3 -m json.tool

# Test scan/pdf (should work if files are indexed)
curl -s -X POST http://localhost:1336/api/databank/scan/pdf

# Test stop
curl -s -X POST http://localhost:1336/api/databank/scan/stop
```

- [ ] **Step 2: Update LibraryPanel handleScan references**

Search for any remaining references to `triggerScan` in the codebase and update to `triggerFileScan`:

```bash
grep -rn "triggerScan" src/frontend/src/
```

Update all occurrences (e.g. in `LibraryFolderSetting` in SettingsPanel.tsx line 370).

- [ ] **Step 3: Remove Reextract handler**

In `handlers/databank.go`, delete the `Reextract` method entirely.

- [ ] **Step 4: Final build check**

```bash
cd src/backend && go build ./...
cd src/frontend && npx tsc -b --noEmit
```

- [ ] **Step 5: Commit all cleanup**

```bash
git add -A
git commit -m "chore: cleanup triggerScan refs, remove Reextract handler"
```

---

### Task 8: Version bump, tag, release, deploy

- [ ] **Step 1: Bump version to 0.2.0-beta**

In `src/frontend/package.json`, change version to `"0.2.0-beta"`.

- [ ] **Step 2: Commit and tag**

```bash
git add src/frontend/package.json
git commit -m "release: v0.2.0-beta — scanner overhaul"
git tag v0.2.0-beta
```

- [ ] **Step 3: Push**

```bash
git push origin main --tags
```

- [ ] **Step 4: Deploy to NAS**

```bash
./NASdeploy.sh
```

- [ ] **Step 5: Create GitHub release**

Wait for CI, then verify release was created. If release workflow fails (known frontend test issue), create manually:

```bash
gh release create v0.2.0-beta --title "BoardRipper v0.2.0-beta" --generate-notes --prerelease
```
