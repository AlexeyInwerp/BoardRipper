package pdfindex

import (
	"fmt"
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
// permanently wedge a worker.
func (e *Engine) ExtractFile(data []byte) ([]string, error) {
	instance, err := e.pool.GetInstance(30 * time.Second)
	if err != nil {
		return nil, fmt.Errorf("get instance: %w", err)
	}

	type result struct {
		pages []string
		err   error
	}
	done := make(chan result, 1)
	go func() {
		p, e2 := extract(instance, data)
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
		return nil, fmt.Errorf("extraction timed out after %v", e.perFileTimeout)
	}
}

// extract performs the actual pdfium calls on a single instance. Recovers from
// panics so a misbehaving PDF can't crash the host process.
func extract(instance pdfium.Pdfium, data []byte) (pages []string, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("pdfium panic: %v", r)
		}
	}()

	doc, err := instance.OpenDocument(&requests.OpenDocument{File: &data})
	if err != nil {
		return nil, fmt.Errorf("open: %w", err)
	}
	defer instance.FPDF_CloseDocument(&requests.FPDF_CloseDocument{Document: doc.Document}) //nolint:errcheck

	pc, err := instance.FPDF_GetPageCount(&requests.FPDF_GetPageCount{Document: doc.Document})
	if err != nil {
		return nil, fmt.Errorf("page count: %w", err)
	}

	pages = make([]string, pc.PageCount)
	for i := 0; i < pc.PageCount; i++ {
		t, perr := instance.GetPageText(&requests.GetPageText{
			Page: requests.Page{
				ByIndex: &requests.PageByIndex{
					Document: doc.Document,
					Index:    i,
				},
			},
		})
		if perr != nil {
			continue
		}
		pages[i] = t.Text
	}
	return pages, nil
}
