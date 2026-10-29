package pdfindex

import (
	"context"
	"errors"
	"fmt"
	"log"
	"strings"
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
	// Lookup resolves a single file id to its PdfFile, or ok=false when the id
	// is unknown or not a PDF. Lets Submit/Enqueue reach rows created after a
	// sweep enumerated its work list (e.g. a drop-to-library upload).
	Lookup(fileID int64) (PdfFile, bool, error)
}

// Extractor is satisfied by Engine (real pdfium WASM) and by fakes in tests.
// ExtractFile may return pages together with a *PartialError: the document
// was cut off by its deadline and the pages before the cut are valid.
type Extractor interface {
	ExtractFile(data []byte) ([]string, error)
}

// contextExtractor is implemented by Engine: ExtractFile that also stops when
// ctx is cancelled (a stopped sweep), returning ctx.Err(). Without it, Stop
// waited for every in-flight file — up to the 20-minute per-file deadline.
type contextExtractor interface {
	ExtractFileContext(ctx context.Context, data []byte) ([]string, error)
}

// initErrorer is implemented by Engine: a non-blocking "did init fail?".
type initErrorer interface {
	InitError() error
}

// ErrEngineUnavailable is returned by sweep starts when the extractor failed
// to initialise. Nothing is claimed or read in that state.
var ErrEngineUnavailable = errors.New("pdfindex: text extractor unavailable")

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
	// EngineError is set when the extractor failed to initialise: indexing
	// cannot run on this server, and the UI should say so.
	EngineError string `json:"engine_error,omitempty"`
}

// Indexer runs autonomous bulk indexing with a priority queue for on-demand
// re-indexing of individual files (e.g. triggered by a file-upload event).
type Indexer struct {
	store   *DB
	extract Extractor
	src     Source
	terms   func() []string
	workers int

	mu      sync.Mutex
	running bool
	// rerun asks for one more full sweep once the current one ends: set when
	// a start request (reindex, a scan's changes, a reclaim) arrives while a
	// sweep is running, whose work list was fixed before those rows existed.
	rerun    bool
	cancel   context.CancelFunc
	done     chan struct{} // closed when the current sweep goroutine exits; nil when idle
	prog     Progress
	priority chan int64
	active   atomic.Int64 // workers currently inside the extract+store path
	// heartbeat is how often a file being extracted refreshes attempted_at.
	// Set once at construction; tests shorten it before starting a sweep.
	heartbeat time.Duration
}

// NewIndexer creates a new Indexer. workers ≥ 1.
func NewIndexer(store *DB, e Extractor, src Source, terms func() []string, workers int) *Indexer {
	if workers < 1 {
		workers = 1
	}
	return &Indexer{
		store:     store,
		extract:   e,
		src:       src,
		terms:     terms,
		workers:   workers,
		priority:  make(chan int64, 256),
		heartbeat: defaultHeartbeat,
	}
}

// Enqueue pushes a single file ID to the front-of-queue priority lane.
// Non-blocking: drops (and logs) if the 256-slot buffer is full. An id still
// in the lane when a sweep ends starts another sweep, which drains it.
func (ix *Indexer) Enqueue(fileID int64) {
	select {
	case ix.priority <- fileID:
	default:
		log.Printf("pdfindex: priority lane full, file_id=%d left to the next sweep", fileID)
	}
}

// RequestRun starts a sweep over all pending files, or — when one is already
// running — makes sure another follows it. Use it for anything that has just
// turned rows into 'pending' (reindex, a watermark change, a scan, a
// reclaim): the running sweep enumerated its list before those rows existed
// and would never reach them. Run() alone silently did nothing in that case.
func (ix *Indexer) RequestRun() error {
	return ix.start(ix.src.ListPDFs, true)
}

// Submit indexes one file id as soon as possible, regardless of sweep state.
// If a sweep is running the id goes down the priority lane and the worker
// resolves it via Source.Lookup (so ids enumerated after the sweep started are
// still honoured); otherwise a one-file sweep is started. Unknown ids and
// already-indexed files are no-ops (Claim only wins on pending/failed/absent
// rows). Used by the upload path so a dropped PDF never waits for the next
// scheduled scan.
func (ix *Indexer) Submit(fileID int64) error {
	f, ok, err := ix.src.Lookup(fileID)
	if err != nil {
		return err
	}
	if !ok {
		return nil
	}
	ix.mu.Lock()
	running := ix.running
	ix.mu.Unlock()
	if running {
		ix.Enqueue(fileID)
		return nil
	}
	err = ix.startScoped(func() ([]PdfFile, error) { return []PdfFile{f}, nil })
	if errors.Is(err, ErrAlreadyRunning) {
		// Lost the race with a sweep that started in between — the lane
		// still reaches it.
		ix.Enqueue(fileID)
		return nil
	}
	return err
}

// Progress returns a point-in-time snapshot (safe to call from any goroutine).
func (ix *Indexer) Progress() Progress {
	ix.mu.Lock()
	defer ix.mu.Unlock()
	p := ix.prog
	p.Workers = ix.workers
	p.ActiveWorkers = int(ix.active.Load())
	if err := ix.engineError(); err != nil {
		p.EngineError = err.Error()
	}
	return p
}

// Stop cancels the running sweep. No-op if not running. Returns immediately;
// workers already inside process() finish their current file. Use StopAndWait
// when you must observe Running == false before the next action (e.g. Restart).
func (ix *Indexer) Stop() {
	ix.mu.Lock()
	if ix.cancel != nil {
		ix.cancel()
	}
	ix.mu.Unlock()
}

// StopAndWait cancels the running sweep and blocks until the sweep goroutine has
// fully settled (Running == false, workers drained). No-op if not running.
// Used by Restart so a requeue-then-run can't race the draining workers.
func (ix *Indexer) StopAndWait() {
	ix.mu.Lock()
	if ix.cancel != nil {
		ix.cancel()
	}
	d := ix.done
	ix.mu.Unlock()
	if d != nil {
		<-d
	}
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
//  1. Atomically claims the running slot (fast, under the lock) and returns.
//  2. Runs the expensive enumeration + pending filter in the background.
//  3. Starts the sweep, or releases the slot if enumeration fails.
//
// The running slot is claimed BEFORE enumeration on purpose: list() +
// DoneOrActiveFileIDs can take tens of seconds on a large databank. If the slot
// were only claimed afterwards (as it once was) the start call would block the
// HTTP response for that whole window, and every click fired meanwhile would
// pass the pre-IO check, run its own full enumeration, and only then race on a
// post-IO re-check — returning a delayed 409 per click and stacking a
// "stop previous index?" prompt in the UI for each. Claiming up front makes
// concurrent starts fail fast with ErrAlreadyRunning and no wasted enumeration.
func (ix *Indexer) startScoped(list func() ([]PdfFile, error)) error {
	return ix.start(list, false)
}

// engineError reports a failed extractor init (nil while compiling or fine).
func (ix *Indexer) engineError() error {
	if ie, ok := ix.extract.(initErrorer); ok {
		return ie.InitError()
	}
	return nil
}

// start is startScoped with the busy case made explicit: rerunIfBusy records
// a follow-up sweep instead of only reporting ErrAlreadyRunning.
func (ix *Indexer) start(list func() ([]PdfFile, error), rerunIfBusy bool) error {
	if err := ix.engineError(); err != nil {
		return fmt.Errorf("%w: %v", ErrEngineUnavailable, err)
	}
	ix.mu.Lock()
	if ix.running {
		if rerunIfBusy {
			ix.rerun = true
			ix.mu.Unlock()
			return nil
		}
		ix.mu.Unlock()
		return ErrAlreadyRunning
	}
	ctx, cancel := context.WithCancel(context.Background())
	ix.cancel = cancel
	ix.running = true
	done := make(chan struct{})
	ix.done = done
	// Total is unknown until enumeration completes; Progress reports Total=0
	// (Running=true) during the enumeration window, then the real count.
	ix.prog = Progress{Running: true, StartedAt: time.Now().Unix()}
	ix.mu.Unlock()

	go func() {
		// Single cleanup point for BOTH exit paths (enumeration failure and
		// normal sweep completion): settle Running=false and close `done` so
		// StopAndWait unblocks. Keeping this in one deferred place is what lets
		// sweep() no longer touch the running/cancel bookkeeping.
		defer func() {
			// A follow-up sweep runs when one was requested meanwhile, or
			// when ids are still in the priority lane (they arrived after the
			// workers had left) — unless the sweep was stopped on purpose.
			ix.mu.Lock()
			again := ctx.Err() == nil && (ix.rerun || len(ix.priority) > 0)
			ix.rerun = false
			ix.prog.Running = false
			ix.running = false
			ix.cancel = nil
			ix.done = nil
			ix.mu.Unlock()
			cancel()
			if err := ix.store.Checkpoint(); err != nil {
				log.Printf("pdfindex: checkpoint after sweep: %v", err)
			}
			close(done)
			if again {
				go func() {
					if err := ix.RequestRun(); err != nil {
						log.Printf("pdfindex: follow-up sweep: %v", err)
					}
				}()
			}
		}()
		pending, err := ix.enumeratePending(list)
		if err != nil {
			// Enumeration failed (rare DB error): the deferred cleanup releases
			// the slot so the next start can run. Surfaced via logs.
			log.Printf("pdfindex: enumeration failed, aborting sweep: %v", err)
			cancel()
			return
		}
		ix.mu.Lock()
		ix.prog.Total = int64(len(pending))
		ix.mu.Unlock()
		log.Printf("pdfindex: sweep started — %d file(s) pending", len(pending))
		ix.sweep(ctx, pending)
		p := ix.Progress()
		how := "ended"
		if ctx.Err() != nil {
			how = "stopped"
		}
		log.Printf("pdfindex: sweep %s — %d/%d done, %d error(s)", how, p.Done, p.Total, p.Errors)
	}()
	return nil
}

// enumeratePending lists candidate PDFs and filters out those already done or
// actively claimed, so Progress.Total reflects only genuinely pending work.
func (ix *Indexer) enumeratePending(list func() ([]PdfFile, error)) ([]PdfFile, error) {
	files, err := list()
	if err != nil {
		return nil, err
	}
	skip, err := ix.store.DoneOrActiveFileIDs()
	if err != nil {
		return nil, err
	}
	pending := make([]PdfFile, 0, len(files))
	for _, f := range files {
		if !skip[f.ID] {
			pending = append(pending, f)
		}
	}
	return pending, nil
}

func (ix *Indexer) sweep(ctx context.Context, files []PdfFile) {
	bulk := make(chan PdfFile)
	byID := make(map[int64]PdfFile, len(files))
	for _, f := range files {
		byID[f.ID] = f
	}
	// Priority ids normally come from this sweep's own list; anything else
	// (a row inserted after enumeration, or a scoped sweep that never listed
	// it) is resolved against the Source so Submit/PriorityIndex still work
	// mid-sweep instead of being dropped on the floor.
	resolve := func(id int64) (PdfFile, bool) {
		if f, ok := byID[id]; ok {
			return f, true
		}
		f, ok, err := ix.src.Lookup(id)
		if err != nil {
			log.Printf("pdfindex: lookup file_id=%d: %v", id, err)
			return PdfFile{}, false
		}
		return f, ok
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
					if f, ok := resolve(id); ok {
						ix.process(ctx, f)
					}
					continue
				default:
				}
				// Then block on either priority, bulk work, or cancellation.
				select {
				case <-ctx.Done():
					return
				case id := <-ix.priority:
					if f, ok := resolve(id); ok {
						ix.process(ctx, f)
					}
				case f, ok := <-bulk:
					if !ok {
						return
					}
					ix.process(ctx, f)
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
	// Running/cancel/done bookkeeping is settled by startScoped's deferred
	// cleanup once this returns — see startScoped.
}

func (ix *Indexer) process(ctx context.Context, f PdfFile) {
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

	// Count this worker as actively extracting (live thread-count for the UI).
	ix.active.Add(1)
	defer ix.active.Add(-1)

	// Heartbeat: a large document may extract for up to the engine's maximum
	// (20 min), past the watchdog's reclaim age; without it the watchdog would
	// hand a live job back to 'pending' and a second worker would extract it
	// again.
	stopBeat := make(chan struct{})
	defer close(stopBeat)
	go func() {
		t := time.NewTicker(ix.heartbeat)
		defer t.Stop()
		for {
			select {
			case <-stopBeat:
				return
			case <-t.C:
				_ = ix.store.Heartbeat(f.ID)
			}
		}
	}()

	data, err := ix.src.ReadFile(f.Path)
	if err != nil {
		log.Printf("pdfindex: FAIL read file_id=%d path=%q: %v", f.ID, f.Path, err)
		ix.fail(f.ID, "read: "+err.Error())
		return
	}
	// Logged before the extraction, not only on failure: if this file takes
	// the process down, this is the last line in docker logs.
	log.Printf("pdfindex: extracting file_id=%d size=%d path=%q", f.ID, len(data), f.Path)
	var rawPages []string
	if ce, ok := ix.extract.(contextExtractor); ok {
		rawPages, err = ce.ExtractFileContext(ctx, data)
	} else {
		rawPages, err = ix.extract.ExtractFile(data)
	}
	if ctx.Err() != nil && errors.Is(err, ctx.Err()) {
		// The sweep was stopped under this file: it is not this file's
		// failure, so it goes back to 'pending' without the attempt.
		log.Printf("pdfindex: stopped during file_id=%d, back to pending", f.ID)
		_ = ix.store.Release(f.ID)
		return
	}
	note := ""
	var partial *PartialError
	if errors.As(err, &partial) {
		// Stopped by its deadline part-way: index what was read and say so.
		// A sweep never retries it (it is 'indexed'); "Re-index" does.
		log.Printf("pdfindex: PARTIAL file_id=%d path=%q: %v", f.ID, f.Path, err)
		note = "partial: " + err.Error()
		err = nil
	}
	if err != nil {
		log.Printf("pdfindex: FAIL extract file_id=%d path=%q size=%d: %v", f.ID, f.Path, len(data), err)
		if isPermanentOpenError(err) {
			// Not a PDF pdfium can read, or password-protected: the same
			// bytes fail the same way every time, so no sweep retries it
			// (a changed file does — MarkPending resets the count).
			ix.failPermanently(f.ID, "extract: "+err.Error())
		} else {
			ix.fail(f.ID, "extract: "+err.Error())
		}
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
	if _, err := ix.store.FinalizeWithNote(f.ID, note); err != nil {
		log.Printf("pdfindex: FAIL finalize file_id=%d path=%q: %v", f.ID, f.Path, err)
	}
}

// isPermanentOpenError recognises pdfium's FPDF_GetLastError codes that depend
// only on the file's bytes: 3 = format (not a PDF, or damaged), 4 = password.
// On the NAS ~90 of ~100 failures were these, retried at every boot.
func isPermanentOpenError(err error) bool {
	s := err.Error()
	return strings.Contains(s, "open (") &&
		(strings.Contains(s, "incorrect format") || strings.Contains(s, "invalid password") ||
			strings.Contains(s, "password required"))
}

func (ix *Indexer) failPermanently(fileID int64, msg string) {
	ix.mu.Lock()
	ix.prog.Errors++
	ix.mu.Unlock()
	_ = ix.store.FailPermanently(fileID, msg)
}

func (ix *Indexer) fail(fileID int64, msg string) {
	ix.mu.Lock()
	ix.prog.Errors++
	ix.mu.Unlock()
	_ = ix.store.Fail(fileID, msg)
}

// defaultHeartbeat refreshes attempted_at of a file being extracted; it must
// stay well under the watchdog's reclaim age (600 s in main.go).
const defaultHeartbeat = time.Minute

// StartWatchdog runs a ticker that reclaims 'indexing' rows whose last
// heartbeat (attempted_at) is older than maxAgeSeconds, flipping them back to
// 'pending' (or to 'failed' once they have been claimed MaxAttempts times).
// onReclaim, when non-nil, is called with the count so the caller can start a
// sweep — a reclaimed row reached nothing on its own before. Close the
// returned channel to stop the watchdog.
func (ix *Indexer) StartWatchdog(interval time.Duration, maxAgeSeconds int64, onReclaim func(n int64)) chan struct{} {
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
					if onReclaim != nil {
						onReclaim(n)
					}
				}
			}
		}
	}()
	return stop
}
