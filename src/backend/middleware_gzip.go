package main

import (
	"bufio"
	"compress/gzip"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
)

// gzipPool reuses gzip writers to avoid per-request allocation.
var gzipPool = sync.Pool{
	New: func() any { return gzip.NewWriter(io.Discard) },
}

// gzipResponseWriter is a response writer that gzips the body if the client
// accepts gzip and the content type is compressible. It falls back to the
// underlying writer transparently when compression would be wrong (upstream
// already-encoded payload, tiny body, non-compressible type).
//
// It also forwards Flush() and Hijack() so streaming handlers (Server-Sent
// Events at /api/update/progress, NDJSON at /api/databank/search/stream) keep
// working: without a Flush() method the handler's w.(http.Flusher) assertion
// would fail and the stream would error or buffer indefinitely. Streaming
// content types are never gzipped (see isCompressible), so Flush just forwards
// to the underlying writer, but we still flush the gzip.Writer first in case a
// compressible response is being incrementally flushed.
type gzipResponseWriter struct {
	http.ResponseWriter
	gz            *gzip.Writer
	headerWritten bool
	useGzip       bool
}

func (g *gzipResponseWriter) WriteHeader(status int) {
	if g.headerWritten {
		return
	}
	g.headerWritten = true

	h := g.ResponseWriter.Header()
	ct := h.Get("Content-Type")
	// Skip already-encoded responses and any response that has explicitly
	// opted out of transformation (e.g. SSE/NDJSON streams set
	// Cache-Control: no-transform).
	if h.Get("Content-Encoding") != "" {
		g.useGzip = false
	} else if hasNoTransform(h.Get("Cache-Control")) {
		g.useGzip = false
	} else if isCompressible(ct) {
		h.Set("Content-Encoding", "gzip")
		h.Del("Content-Length") // length changes after compression
		h.Add("Vary", "Accept-Encoding")
		g.useGzip = true
	}
	g.ResponseWriter.WriteHeader(status)
}

func (g *gzipResponseWriter) Write(b []byte) (int, error) {
	if !g.headerWritten {
		g.WriteHeader(http.StatusOK)
	}
	if g.useGzip {
		return g.gz.Write(b)
	}
	return g.ResponseWriter.Write(b)
}

// Flush forwards a flush through the gzip layer (if active) to the underlying
// writer. Required so streaming handlers' w.(http.Flusher) assertion succeeds.
func (g *gzipResponseWriter) Flush() {
	if g.useGzip {
		// Flush compressed bytes buffered in the gzip.Writer to the
		// underlying ResponseWriter before flushing the socket.
		_ = g.gz.Flush()
	}
	if f, ok := g.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// Hijack delegates to the underlying writer when it supports hijacking
// (WebSocket upgrades and similar). Returns http.ErrNotSupported otherwise.
func (g *gzipResponseWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	if hj, ok := g.ResponseWriter.(http.Hijacker); ok {
		return hj.Hijack()
	}
	return nil, nil, http.ErrNotSupported
}

// hasNoTransform reports whether a Cache-Control header carries the
// no-transform directive (case-insensitive), which forbids gzip.
func hasNoTransform(cacheControl string) bool {
	if cacheControl == "" {
		return false
	}
	for _, part := range strings.Split(cacheControl, ",") {
		if strings.EqualFold(strings.TrimSpace(part), "no-transform") {
			return true
		}
	}
	return false
}

func isCompressible(contentType string) bool {
	ct := strings.ToLower(contentType)
	if ct == "" {
		return false
	}
	// Streaming response types must never be gzipped: buffering inside the
	// gzip.Writer breaks the incremental-flush contract that SSE and NDJSON
	// clients depend on (and historically caused HTTP 500 on /api/update/progress
	// because the handler's Flusher assertion failed against the wrapper).
	if strings.HasPrefix(ct, "text/event-stream") {
		return false
	}
	if strings.HasPrefix(ct, "application/x-ndjson") {
		return false
	}
	if strings.HasPrefix(ct, "application/json") {
		return true
	}
	if strings.HasPrefix(ct, "text/") {
		return true
	}
	if strings.HasPrefix(ct, "application/javascript") {
		return true
	}
	if strings.HasPrefix(ct, "application/xml") {
		return true
	}
	return false
}

// gzipMiddleware wraps an http.Handler with gzip compression when the client
// advertises Accept-Encoding: gzip.
func gzipMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
			next.ServeHTTP(w, r)
			return
		}

		gz := gzipPool.Get().(*gzip.Writer)
		gz.Reset(w)
		defer func() {
			_ = gz.Close()
			gzipPool.Put(gz)
		}()

		grw := &gzipResponseWriter{ResponseWriter: w, gz: gz}
		next.ServeHTTP(grw, r)
	})
}
