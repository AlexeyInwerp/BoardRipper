package pdfindex

import (
	"fmt"
	"log"
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
	pool           pdfium.Pool
	perFileTimeout time.Duration
	// ready closes once the pool exists (or init failed — see initErr). The
	// wasm compile behind webassembly.Init takes ~10 s on a NAS; NewEngineAsync
	// runs it off the boot path so the HTTP server can listen immediately.
	ready   chan struct{}
	initErr error
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
	return &Engine{pool: pool, perFileTimeout: 2 * time.Minute, ready: ready}, nil
}

// NewEngineAsync returns immediately and compiles the pdfium pool in the
// background. ExtractFile blocks until the pool is ready and returns the init
// error if it failed, so callers need no readiness check of their own.
func NewEngineAsync(maxTotal int) *Engine {
	e := &Engine{perFileTimeout: 2 * time.Minute, ready: make(chan struct{})}
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

// ExtractFile returns text per page (slice index = 0-based page number).
// It enforces a per-file wall-clock kill so a hostile/looping PDF can't
// permanently wedge a worker. The progress channel reports the last page
// successfully reached before a timeout, so the caller can pin the failure
// to a specific page rather than just "timed out somewhere".
func (e *Engine) ExtractFile(data []byte) ([]string, error) {
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
	var progress atomic.Int32 // last page reached + 1; 0 = before any page
	progress.Store(-1)        // -1 = before open
	done := make(chan result, 1)
	go func() {
		p, e2 := extract(instance, data, &progress)
		done <- result{p, e2}
	}()

	timer := time.NewTimer(e.perFileTimeout)
	defer timer.Stop()
	select {
	case r := <-done:
		instance.Close() //nolint:errcheck — pool handles cleanup
		return r.pages, r.err
	case <-timer.C:
		instance.Kill() //nolint:errcheck — best-effort kill
		switch p := progress.Load(); {
		case p < 0:
			return nil, fmt.Errorf("timed out after %v during OpenDocument (input size %d bytes)", e.perFileTimeout, len(data))
		case p == 0:
			return nil, fmt.Errorf("timed out after %v before reaching first page (input size %d bytes)", e.perFileTimeout, len(data))
		default:
			return nil, fmt.Errorf("timed out after %v while extracting page %d (input size %d bytes)", e.perFileTimeout, p, len(data))
		}
	}
}

// extract performs the actual pdfium calls on a single instance. Recovers from
// panics so a misbehaving PDF can't crash the host process. `progress` is
// updated as we move through pages so the caller's timeout path can attribute
// the failure to a specific page.
func extract(instance pdfium.Pdfium, data []byte, progress *atomic.Int32) (pages []string, err error) {
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
	progress.Store(0)

	pc, err := instance.FPDF_GetPageCount(&requests.FPDF_GetPageCount{Document: doc.Document})
	if err != nil {
		return nil, fmt.Errorf("page count: %w", err)
	}

	pages = make([]string, pc.PageCount)
	for i := 0; i < pc.PageCount; i++ {
		progress.Store(int32(i + 1))
		t, perr := instance.GetPageText(&requests.GetPageText{
			Page: requests.Page{
				ByIndex: &requests.PageByIndex{
					Document: doc.Document,
					Index:    i,
				},
			},
		})
		if perr != nil {
			// Per-page failure: log but continue — pages that do extract
			// still get indexed so a single bad page doesn't waste the rest.
			log.Printf("pdfindex: page %d/%d GetPageText failed: %v", i+1, pc.PageCount, perr)
			continue
		}
		pages[i] = t.Text
	}
	return pages, nil
}
