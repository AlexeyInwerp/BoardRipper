package pdfindex

import (
	"context"
	"fmt"
	"log"
	"strings"
	"sync/atomic"
	"time"

	"github.com/klippa-app/go-pdfium"
	"github.com/klippa-app/go-pdfium/requests"
	"github.com/klippa-app/go-pdfium/webassembly"
	"github.com/tetratelabs/wazero"
)

// wasmMemoryLimitPages caps each pdfium/wazero worker's WebAssembly linear
// memory. wazero pages are 64 KiB, so 8192 pages = 512 MiB. This bounds the
// worst case: wazero linear memory only ever GROWS and is freed solely when the
// module instance is closed, so without a cap a single huge/complex PDF could
// grow a worker toward wazero's 4 GiB default and permanently pin that RSS. With
// the cap, an over-budget page fails extraction (memory.Grow returns -1 →
// caught by extract's recover) instead of OOM-killing the container.
const wasmMemoryLimitPages uint32 = 8192 // 512 MiB per worker

// Engine is a pooled pdfium-via-wazero text extractor. The pool is the
// parallelism mechanism (wazero instances are not goroutine-safe).
type Engine struct {
	pool pdfium.Pool
	// perFileTimeout is the budget for opening a document and counting its
	// pages, and the base of the per-file deadline once the count is known.
	perFileTimeout time.Duration
	// perPage is added to the deadline for every page of the document, and
	// maxFileTimeout caps the sum. A flat two minutes killed every dense
	// schematic past page ~400 on a NAS, at every boot, and threw away the
	// pages already read (2026-10-14 review, I2).
	perPage        time.Duration
	maxFileTimeout time.Duration
	// ready closes once the pool exists (or init failed — see initErr). The
	// wasm compile behind webassembly.Init takes ~10 s on a NAS; NewEngineAsync
	// runs it off the boot path so the HTTP server can listen immediately.
	ready   chan struct{}
	initErr error
}

const (
	defaultPerFileTimeout = 2 * time.Minute
	defaultPerPage        = time.Second
	defaultMaxFileTimeout = 20 * time.Minute
)

// PartialError reports an extraction stopped by its deadline after some pages
// were read. ExtractFile returns it together with the pages it has (entries
// past Reached are empty), so the caller can index what there is.
type PartialError struct {
	Reached int // pages read before the stop (1-based count)
	Total   int
	After   time.Duration
}

func (e *PartialError) Error() string {
	return fmt.Sprintf("timed out after %v at page %d of %d", e.After.Round(time.Second), e.Reached, e.Total)
}

// NewEngine initialises a pdfium/wazero pool with up to maxTotal concurrent
// instances. minIdle is set to 1 so the first instance is compiled eagerly.
func NewEngine(maxTotal int) (*Engine, error) {
	if maxTotal < 1 {
		maxTotal = 1
	}
	pool, err := webassembly.Init(webassembly.Config{
		MinIdle: 1,
		// MaxIdle:1 (was maxTotal) so idle workers ABOVE one are destroyed when
		// returned to the pool, freeing their wasm linear memory. Previously every
		// worker lived for the whole process lifetime, so one burst of concurrent
		// indexing permanently raised the RSS floor by POOL_MAX × per-worker
		// high-water mark. Now a burst's extra workers are reclaimed once idle;
		// one worker stays warm (MinIdle) to avoid cold-start on the next PDF.
		MaxIdle:  1,
		MaxTotal: maxTotal,
		RuntimeConfig: wazero.NewRuntimeConfig().
			WithCloseOnContextDone(true).
			WithMemoryLimitPages(wasmMemoryLimitPages),
	})
	if err != nil {
		return nil, fmt.Errorf("pdfium init: %w", err)
	}
	ready := make(chan struct{})
	close(ready)
	return &Engine{pool: pool, perFileTimeout: defaultPerFileTimeout, perPage: defaultPerPage,
		maxFileTimeout: defaultMaxFileTimeout, ready: ready}, nil
}

// NewEngineAsync returns immediately and compiles the pdfium pool in the
// background. ExtractFile blocks until the pool is ready and returns the init
// error if it failed, so callers need no readiness check of their own.
func NewEngineAsync(maxTotal int) *Engine {
	e := &Engine{perFileTimeout: defaultPerFileTimeout, perPage: defaultPerPage,
		maxFileTimeout: defaultMaxFileTimeout, ready: make(chan struct{})}
	go func() {
		defer close(e.ready)
		started := time.Now()
		inner, err := NewEngine(maxTotal)
		if err != nil {
			e.initErr = err
			log.Printf("pdfium engine init failed (%v) — backend PDF indexing disabled", err)
			return
		}
		e.pool = inner.pool
		log.Printf("pdfium engine ready in %s", time.Since(started).Round(time.Millisecond))
	}()
	return e
}

// Ready reports whether the pool is usable (false while compiling or after a
// failed init). Err returns the init error, if any, once init finished.
func (e *Engine) Ready() bool {
	select {
	case <-e.ready:
		return e.initErr == nil
	default:
		return false
	}
}

// InitError reports a finished, failed init without waiting: nil while the
// pool is still compiling or once it is up. Lets a sweep refuse to start (and
// say why) instead of reading every PDF in the library only to fail each one.
func (e *Engine) InitError() error {
	select {
	case <-e.ready:
		return e.initErr
	default:
		return nil
	}
}

// Err blocks until init finished and returns its error (nil on success).
func (e *Engine) Err() error {
	<-e.ready
	return e.initErr
}

// Close shuts down all pool workers (waits for a pending init first).
func (e *Engine) Close() error {
	<-e.ready
	if e.pool == nil {
		return nil
	}
	return e.pool.Close()
}

// deadline is the wall-clock budget for a document of the given page count
// (0 = not known yet).
func (e *Engine) deadline(pages int) time.Duration {
	d := e.perFileTimeout + time.Duration(pages)*e.perPage
	if e.maxFileTimeout > 0 && d > e.maxFileTimeout {
		d = e.maxFileTimeout
	}
	return d
}

// ExtractFile returns text per page (slice index = 0-based page number).
// It enforces a wall-clock kill so a hostile/looping PDF can't permanently
// wedge a worker: perFileTimeout to open the document, then that plus perPage
// for every page, capped at maxFileTimeout. When the kill lands after some
// pages were read it returns those pages and a *PartialError; before the
// first page it returns a plain error naming where it stopped.
func (e *Engine) ExtractFile(data []byte) ([]string, error) {
	return e.ExtractFileContext(context.Background(), data)
}

// ExtractFileContext is ExtractFile that also stops when ctx is done: the
// instance is killed and ctx.Err() returned (no partial pages — a stopped
// sweep puts the file back, it is not this file's failure).
func (e *Engine) ExtractFileContext(ctx context.Context, data []byte) ([]string, error) {
	if err := e.Err(); err != nil {
		return nil, fmt.Errorf("pdfium unavailable: %w", err)
	}
	instance, err := e.pool.GetInstance(30 * time.Second)
	if err != nil {
		return nil, fmt.Errorf("get instance: %w", err)
	}

	type result struct {
		pages []string
		err   error
	}
	var st extractState
	st.progress.Store(-1) // -1 = before open
	done := make(chan result, 1)
	go func() {
		p, e2 := extract(instance, data, &st)
		done <- result{p, e2}
	}()

	started := time.Now()
	timer := time.NewTimer(e.deadline(0))
	defer timer.Stop()
	for {
		select {
		case r := <-done:
			instance.Close() //nolint:errcheck — pool handles cleanup
			return r.pages, r.err
		case <-ctx.Done():
			st.killed.Store(true)
			instance.Kill() //nolint:errcheck — best-effort kill
			select {
			case <-done:
			case <-time.After(10 * time.Second):
			}
			return nil, ctx.Err()
		case <-timer.C:
		}
		// The page count may have arrived since the timer was set: extend
		// the deadline to what this document is allowed.
		if total := int(st.total.Load()); total > 0 {
			if rem := e.deadline(total) - time.Since(started); rem > 0 {
				timer.Reset(rem)
				continue
			}
		}
		break
	}

	elapsed := time.Since(started).Round(time.Second)
	st.killed.Store(true)
	instance.Kill() //nolint:errcheck — best-effort kill
	// Every call on a killed instance fails at once and the loop stops on the
	// first one, so the pages read so far come back within moments. Bounded
	// anyway: a call stuck inside wasm is what the kill is for.
	var pages []string
	select {
	case r := <-done:
		pages = r.pages
	case <-time.After(10 * time.Second):
	}
	p, total := int(st.progress.Load()), int(st.total.Load())
	switch {
	case p < 0:
		return nil, fmt.Errorf("timed out after %v during OpenDocument (input size %d bytes)", elapsed, len(data))
	case p == 0:
		return nil, fmt.Errorf("timed out after %v before reaching first page (input size %d bytes)", elapsed, len(data))
	case pages != nil && p > 1:
		// Page p was in progress when the kill landed; p-1 were complete.
		return pages, &PartialError{Reached: p - 1, Total: total, After: elapsed}
	default:
		return nil, fmt.Errorf("timed out after %v while extracting page %d of %d (input size %d bytes)", elapsed, p, total, len(data))
	}
}

// extractState is shared between ExtractFile and the goroutine running
// extract: how far it got, how far it has to go, and whether it was killed.
type extractState struct {
	progress atomic.Int32 // page being read (1-based); 0 = opened; -1 = before open
	total    atomic.Int32 // page count once known
	killed   atomic.Bool
}

// extract performs the actual pdfium calls on a single instance. Recovers from
// panics so a misbehaving PDF can't crash the host process. `st.progress` is
// updated as we move through pages so the caller's timeout path can attribute
// the failure to a specific page.
func extract(instance pdfium.Pdfium, data []byte, st *extractState) (pages []string, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("pdfium panic: %v", r)
		}
	}()

	doc, err := instance.OpenDocument(&requests.OpenDocument{File: &data})
	if err != nil {
		return nil, fmt.Errorf("open (size %d bytes): %w", len(data), err)
	}
	defer instance.FPDF_CloseDocument(&requests.FPDF_CloseDocument{Document: doc.Document}) //nolint:errcheck
	st.progress.Store(0)

	pc, err := instance.FPDF_GetPageCount(&requests.FPDF_GetPageCount{Document: doc.Document})
	if err != nil {
		return nil, fmt.Errorf("page count: %w", err)
	}
	st.total.Store(int32(pc.PageCount))

	pages = make([]string, pc.PageCount)
	failed := 0
	for i := 0; i < pc.PageCount; i++ {
		if st.killed.Load() {
			// The deadline fired. Every further call fails on the closed
			// module; the field log had one "instance is closed" line per
			// remaining page — 3,000 of them for one document.
			return pages, nil
		}
		st.progress.Store(int32(i + 1))
		t, perr := instance.GetPageText(&requests.GetPageText{
			Page: requests.Page{
				ByIndex: &requests.PageByIndex{
					Document: doc.Document,
					Index:    i,
				},
			},
		})
		if perr != nil {
			if st.killed.Load() || isClosedInstance(perr) {
				return pages, nil
			}
			// Per-page failure: continue — pages that do extract still get
			// indexed so a single bad page doesn't waste the rest. Logged
			// once per document, not per page.
			if failed == 0 {
				log.Printf("pdfindex: page %d/%d GetPageText failed: %v", i+1, pc.PageCount, perr)
			}
			failed++
			continue
		}
		pages[i] = t.Text
	}
	if failed > 1 {
		log.Printf("pdfindex: %d of %d pages failed GetPageText", failed, pc.PageCount)
	}
	return pages, nil
}

// isClosedInstance recognises the errors go-pdfium/wazero return once the
// module has been closed under a call (kill, context deadline).
func isClosedInstance(err error) bool {
	s := err.Error()
	return strings.Contains(s, "instance is closed") || strings.Contains(s, "module closed")
}
