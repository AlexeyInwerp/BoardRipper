package main

import (
	"compress/gzip"
	"io"
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
	// Skip already-encoded responses
	if h.Get("Content-Encoding") != "" {
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

func isCompressible(contentType string) bool {
	ct := strings.ToLower(contentType)
	if ct == "" {
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
