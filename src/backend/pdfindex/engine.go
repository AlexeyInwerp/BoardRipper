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

// Engine is a pooled pdfium-via-wazero text extractor. The pool is the
// parallelism mechanism (wazero instances are not goroutine-safe).
type Engine struct {
	pool           pdfium.Pool
	perFileTimeout time.Duration
}

// NewEngine initialises a pdfium/wazero pool with up to maxTotal concurrent
// instances. minIdle is set to 1 so the first instance is compiled eagerly.
func NewEngine(maxTotal int) (*Engine, error) {
	if maxTotal < 1 {
		maxTotal = 1
	}
	pool, err := webassembly.Init(webassembly.Config{
		MinIdle:       1,
		MaxIdle:       maxTotal,
		MaxTotal:      maxTotal,
		RuntimeConfig: wazero.NewRuntimeConfig().WithCloseOnContextDone(true),
	})
	if err != nil {
		return nil, fmt.Errorf("pdfium init: %w", err)
	}
	return &Engine{pool: pool, perFileTimeout: 2 * time.Minute}, nil
}

// Close shuts down all pool workers.
func (e *Engine) Close() error { return e.pool.Close() }

// ExtractFile returns text per page (slice index = 0-based page number).
// It enforces a per-file wall-clock kill so a hostile/looping PDF can't
// permanently wedge a worker. The progress channel reports the last page
// successfully reached before a timeout, so the caller can pin the failure
// to a specific page rather than just "timed out somewhere".
func (e *Engine) ExtractFile(data []byte) ([]string, error) {
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
