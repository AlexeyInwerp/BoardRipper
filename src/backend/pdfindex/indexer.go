package pdfindex

import (
	"context"
	"errors"
	"log"
	"sync"
	"sync/atomic"
	"time"
)

// ErrAlreadyRunning is returned by RunFolder (and startScoped) when a sweep is
// already in progress. Run() swallows it to stay idempotent.
var ErrAlreadyRunning = errors.New("pdfindex: already running")

// PdfFile identifies a PDF in the source.
type PdfFile struct {
	ID   int64
	Path string
}

// Source is satisfied by any adapter that can enumerate and read PDF files
// (e.g. a databank-backed adapter). Kept minimal so tests can use fakes.
type Source interface {
	ListPDFs() ([]PdfFile, error)
	// ListPDFsUnder returns only PDFs whose Path equals prefix or begins with
	// prefix+"/". An empty prefix returns all files (same as ListPDFs).
	ListPDFsUnder(prefix string) ([]PdfFile, error)
	ReadFile(relPath string) ([]byte, error)
	// CanonicalFor returns the canonical file_id for this file's content group
	// and true, or (0,false) if the file has no content hash (singleton).
	CanonicalFor(fileID int64) (int64, bool, error)
}

// Extractor is satisfied by Engine (real pdfium WASM) and by fakes in tests.
type Extractor interface {
	ExtractFile(data []byte) ([]string, error)
}

// Progress is a snapshot of the current sweep's progress.
type Progress struct {
	Running       bool   `json:"running"`
	Total         int64  `json:"total"`
	Done          int64  `json:"done"`
	Errors        int64  `json:"errors"`
	CurrentFile   string `json:"current_file"`
	StartedAt     int64  `json:"started_at"`
	Workers       int    `json:"workers"`        // configured pool size (max parallel extractors)
	ActiveWorkers int    `json:"active_workers"` // workers currently extracting (live)
}

// Indexer runs autonomous bulk indexing with a priority queue for on-demand
// re-indexing of individual files (e.g. triggered by a file-upload event).
type Indexer struct {
	store   *DB
	extract Extractor
	src     Source
	terms   func() []string
	workers int

	mu       sync.Mutex
	running  bool
	cancel   context.CancelFunc
	prog     Progress
	priority chan int64
	active   atomic.Int64 // workers currently inside the extract+store path
}

// NewIndexer creates a new Indexer. workers ≥ 1.
func NewIndexer(store *DB, e Extractor, src Source, terms func() []string, workers int) *Indexer {
	if workers < 1 {
		workers = 1
	}
	return &Indexer{
		store:    store,
		extract:  e,
		src:      src,
		terms:    terms,
		workers:  workers,
		priority: make(chan int64, 256),
	}
}

// Enqueue pushes a single file ID to the front-of-queue priority lane.
// Non-blocking: drops silently if the 256-slot buffer is full.
func (ix *Indexer) Enqueue(fileID int64) {
	select {
	case ix.priority <- fileID:
	default:
	}
}

// Progress returns a point-in-time snapshot (safe to call from any goroutine).
func (ix *Indexer) Progress() Progress {
	ix.mu.Lock()
	defer ix.mu.Unlock()
	p := ix.prog
	p.Workers = ix.workers
	p.ActiveWorkers = int(ix.active.Load())
	return p
}

// Stop cancels the running sweep. No-op if not running.
func (ix *Indexer) Stop() {
	ix.mu.Lock()
	if ix.cancel != nil {
		ix.cancel()
	}
	ix.mu.Unlock()
}

// Run starts a sweep over all files returned by Source.ListPDFs, pre-filtered
// to only pending (not yet done/active) files so Progress.Total reflects real
// remaining work. It is a no-op if a sweep is already in progress.
// The sweep runs in the background; call Progress() to observe it and wait for
// Running == false.
func (ix *Indexer) Run() error {
	err := ix.startScoped(ix.src.ListPDFs)
	if errors.Is(err, ErrAlreadyRunning) {
		return nil // bulk Run stays idempotent
	}
	return err
}

// RunFolder starts a sweep limited to PDFs under the given library-relative
// path prefix. Returns ErrAlreadyRunning if a sweep is already in progress
// (the caller should offer to stop-and-index).
func (ix *Indexer) RunFolder(prefix string) error {
	return ix.startScoped(func() ([]PdfFile, error) {
		return ix.src.ListPDFsUnder(prefix)
	})
}

// RunFiles starts a sweep limited to the given file IDs (resolved against
// Source.ListPDFs). Like Run/RunFolder it runs one background sweep and
// filters out already done/active files; it is a no-op returning nil if a
// sweep is already in progress or ids is empty. Used for on-demand indexing
// of a known set (e.g. donor membership) without sweeping the whole library.
func (ix *Indexer) RunFiles(ids []int64) error {
	if len(ids) == 0 {
		return nil
	}
	want := make(map[int64]bool, len(ids))
	for _, id := range ids {
		want[id] = true
	}
	err := ix.startScoped(func() ([]PdfFile, error) {
		all, err := ix.src.ListPDFs()
		if err != nil {
			return nil, err
		}
		out := make([]PdfFile, 0, len(want))
		for _, f := range all {
			if want[f.ID] {
				out = append(out, f)
			}
		}
		return out, nil
	})
	if errors.Is(err, ErrAlreadyRunning) {
		return nil // stay idempotent like Run()
	}
	return err
}

// startScoped is the shared sweep-start helper. It:
//  1. Does a speculative (pre-IO) running check.
//  2. Calls list() to enumerate candidates.
//  3. Queries the store for already-done/active IDs and filters them out.
//  4. Re-checks running (double-checked lock after IO) and starts the sweep.
func (ix *Indexer) startScoped(list func() ([]PdfFile, error)) error {
	ix.mu.Lock()
	if ix.running {
		ix.mu.Unlock()
		return ErrAlreadyRunning
	}
	ix.mu.Unlock()

	files, err := list()
	if err != nil {
		return err
	}
	skip, err := ix.store.DoneOrActiveFileIDs()
	if err != nil {
		return err
	}
	pending := make([]PdfFile, 0, len(files))
	for _, f := range files {
		if !skip[f.ID] {
			pending = append(pending, f)
		}
	}

	ix.mu.Lock()
	if ix.running {
		ix.mu.Unlock()
		return ErrAlreadyRunning // re-check after IO above
	}
	ctx, cancel := context.WithCancel(context.Background())
	ix.cancel = cancel
	ix.running = true
	ix.prog = Progress{Running: true, Total: int64(len(pending)), StartedAt: time.Now().Unix()}
	ix.mu.Unlock()

	go ix.sweep(ctx, pending)
	return nil
}

func (ix *Indexer) sweep(ctx context.Context, files []PdfFile) {
	bulk := make(chan PdfFile)
	byID := make(map[int64]PdfFile, len(files))
	for _, f := range files {
		byID[f.ID] = f
	}

	var wg sync.WaitGroup
	for i := 0; i < ix.workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				// Drain priority queue first (non-blocking check).
				select {
				case <-ctx.Done():
					return
				case id := <-ix.priority:
					if f, ok := byID[id]; ok {
						ix.process(f)
					}
					continue
				default:
				}
				// Then block on either priority, bulk work, or cancellation.
				select {
				case <-ctx.Done():
					return
				case id := <-ix.priority:
					if f, ok := byID[id]; ok {
						ix.process(f)
					}
				case f, ok := <-bulk:
					if !ok {
						return
					}
					ix.process(f)
				}
			}
		}()
	}

	// Feed bulk channel from the file list.
	for _, f := range files {
		select {
		case <-ctx.Done():
			goto finish
		case bulk <- f:
		}
	}
finish:
	close(bulk)
	wg.Wait()

	ix.mu.Lock()
	ix.prog.Running = false
	ix.running = false
	ix.cancel = nil
	ix.mu.Unlock()
}

func (ix *Indexer) process(f PdfFile) {
	ix.mu.Lock()
	ix.prog.CurrentFile = f.Path
	ix.mu.Unlock()

	won, err := ix.store.Claim(f.ID, "pdfium")
	if err != nil {
		log.Printf("pdfindex: claim error file_id=%d path=%q: %v", f.ID, f.Path, err)
		return
	}
	if !won {
		// Another worker/instance already holds the claim — skip silently
		// (this is normal during concurrent sweeps).
		return
	}
	// A claimed file is counted as processed whether it extracts, fails, or is
	// skipped as a duplicate — so Progress.Done always reaches Total.
	defer func() {
		ix.mu.Lock()
		ix.prog.Done++
		ix.mu.Unlock()
	}()

	// Dedup: a non-canonical duplicate is never extracted — mark it and skip.
	// Its search hits resolve via the canonical (already/about to be indexed).
	if canonID, hasHash, _ := ix.src.CanonicalFor(f.ID); hasHash && canonID != f.ID {
		_ = ix.store.MarkDuplicate(f.ID, canonID)
		return
	}

	// No per-file heartbeat needed: the engine enforces a 2-minute per-file kill,
	// well under the 10-minute watchdog reclaim window.
	// Count this worker as actively extracting (live thread-count for the UI).
	ix.active.Add(1)
	defer ix.active.Add(-1)

	data, err := ix.src.ReadFile(f.Path)
	if err != nil {
		log.Printf("pdfindex: FAIL read file_id=%d path=%q: %v", f.ID, f.Path, err)
		ix.fail(f.ID, "read: "+err.Error())
		return
	}
	rawPages, err := ix.extract.ExtractFile(data)
	if err != nil {
		log.Printf("pdfindex: FAIL extract file_id=%d path=%q size=%d: %v", f.ID, f.Path, len(data), err)
		ix.fail(f.ID, "extract: "+err.Error())
		return
	}
	terms := ix.terms()
	pages := make([]Page, 0, len(rawPages))
	for i, raw := range rawPages {
		clean := CleanPageText(raw, terms)
		if clean == "" {
			continue
		}
		pages = append(pages, Page{Num: i + 1, Text: clean})
	}
	// ReplacePages runs even when len(pages)==0: it deletes any prior pages for
	// this file (reversing stale FTS postings from an earlier index) before
	// inserting the fresh set. Without this a re-index left the old pages in
	// place — so a re-save that dropped its text kept stale search hits, and a
	// watermark re-index never stripped the watermark rows. Finalize then
	// counts the fresh set and marks 'indexed' or (zero pages) 'empty'.
	if err := ix.store.ReplacePages(f.ID, pages); err != nil {
		log.Printf("pdfindex: FAIL store file_id=%d path=%q pages=%d: %v", f.ID, f.Path, len(pages), err)
		ix.fail(f.ID, "store: "+err.Error())
		return
	}
	if _, err := ix.store.Finalize(f.ID); err != nil {
		log.Printf("pdfindex: FAIL finalize file_id=%d path=%q: %v", f.ID, f.Path, err)
	}
}

func (ix *Indexer) fail(fileID int64, msg string) {
	ix.mu.Lock()
	ix.prog.Errors++
	ix.mu.Unlock()
	_ = ix.store.Fail(fileID, msg)
}

// StartWatchdog runs a ticker that reclaims 'indexing' rows whose last
// heartbeat (attempted_at) is older than maxAgeSeconds, flipping them back to
// 'pending' so they are retried on the next sweep. Close the returned channel
// to stop the watchdog.
func (ix *Indexer) StartWatchdog(interval time.Duration, maxAgeSeconds int64) chan struct{} {
	stop := make(chan struct{})
	go func() {
		t := time.NewTicker(interval)
		defer t.Stop()
		for {
			select {
			case <-stop:
				return
			case <-t.C:
				if n, err := ix.store.ReclaimStale(maxAgeSeconds); err == nil && n > 0 {
					log.Printf("pdfindex watchdog: reclaimed %d stale row(s)", n)
				}
			}
		}
	}()
	return stop
}
