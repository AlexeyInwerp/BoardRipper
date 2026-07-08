package handlers

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"syscall"
	"time"
)

// readDeadline is the per-request budget for fully reading a file off disk
// before we give up and ask the client to retry. Calibrated to be generous
// for cloud placeholders (Google Drive / OneDrive can take 10–20s for a
// medium PDF on a fresh download) but short enough that browsers don't
// silently drop the request on default fetch timeouts.
const readDeadline = 30 * time.Second

// maxFileBytes caps how much we'll read into memory before bailing. Set
// well above the largest realistic boardview/PDF. If exceeded, we 413
// rather than risk OOM the backend.
const maxFileBytes = 512 * 1024 * 1024 // 512 MiB

// streamThreshold: files larger than this are STREAMED (probe + io.Copy with a
// fixed buffer) instead of buffered whole in memory. Below it the eager path
// runs unchanged, preserving the full cloud-placeholder semantics — and their
// test coverage — for the small boardview files and typical PDFs that make up
// the overwhelming majority of requests. Only genuinely large PDFs take the
// streaming path, where the per-request heap saving is largest. Streaming can't
// turn a mid-file partial-materialization into a clean 503 (headers ship before
// the body), but the up-front probe still catches the common "not materialized
// at all" placeholder case before any header is sent; a rare mid-stream stall
// surfaces as a truncated download (Content-Length mismatch) the client retries.
const streamThreshold = 32 * 1024 * 1024 // 32 MiB

// streamProbeBytes is read up-front (within the deadline) on the streaming path
// to detect placeholders / immediate read errors before committing to a 200.
const streamProbeBytes = 128 * 1024

// streamBufBytes is the fixed copy buffer for the streaming body — bounds
// per-request memory to this instead of the whole file.
const streamBufBytes = 64 * 1024

// streamThresholdForTest lets tests exercise the streaming path with small
// fixtures. Production reads the const; tests reassign this within a scope.
var streamThresholdForTest int64 = streamThreshold

// retryAfterShortRead is the Retry-After header value when a partial read
// suggests cloud-sync glitched (file size mismatch). Short retry — the
// kernel may already have the bytes by the time the next request lands.
const retryAfterShortRead = "5"

// retryAfterDeadline is the Retry-After when we hit the read deadline.
// Longer retry — kernel is likely still downloading; give it time.
const retryAfterDeadline = "10"

// retryAfterPlaceholder is the Retry-After when we detect a cloud-storage
// placeholder via EDEADLK. Long retry — the user typically has to manually
// materialize the file on the host (Finder → "Keep on this device" for
// Google Drive / iCloud, equivalent for OneDrive).
const retryAfterPlaceholder = "60"

// cloudErrorHeader is the response-header name carrying a stable
// machine-readable code identifying which branch produced the response.
// Frontend logs and toasts switch on this rather than parsing free-form
// bodies. Codes are documented at the call sites that set them.
const cloudErrorHeader = "X-Boardripper-Cloud-Error"

// readDeadlineForTest allows tests to override readDeadline. Production
// code reads the var; tests reassign it within a test scope.
var readDeadlineForTest = readDeadline

// fileOpener is a test seam: production code uses os.Open; tests inject
// a controllable opener that can simulate short reads, blocking reads,
// or open errors.
type fileOpener func(path string) (io.ReadCloser, os.FileInfo, error)

// defaultOpener stat()s + os.Open()s the path. Returned ReadCloser MUST
// be closed by the caller.
func defaultOpener(path string) (io.ReadCloser, os.FileInfo, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, nil, err
	}
	if info.IsDir() {
		return nil, info, &os.PathError{Op: "open", Path: path, Err: os.ErrInvalid}
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, info, err
	}
	return f, info, nil
}

// errnoName returns a short human-readable name for the syscall.Errno
// embedded in err (or the empty string if there isn't one). Used purely
// for diagnostic logging / response-header tagging — NEVER for gating
// behavior. Cross-platform: errno numbers differ between Linux and
// macOS, so we look up the symbolic name via the syscall package.
func errnoName(err error) string {
	var errno syscall.Errno
	if !errors.As(err, &errno) {
		return ""
	}
	return errno.Error()
}

// blocksOrUnknown returns "<n>" or "?" for diagnostic formatting. A zero
// blocks value alongside size>0 is the cloud-placeholder signal on every
// platform we care about; we log it so we can correlate failures to
// placeholders without needing a separate probe.
func blocksOrUnknown(info os.FileInfo) string {
	if b, ok := statBlocks(info); ok {
		return strconv.FormatInt(b, 10)
	}
	return "?"
}

// readFileEager reads the file at root/relPath fully into memory and verifies
// byte count matches stat().Size(). Returns the raw bytes or an error.
// Cloud-storage-aware: same short-read / deadline / EDEADLK detection as
// serveFileEager but without any HTTP coupling — suitable for use by internal
// adapters (e.g. pdfindex Source).
func readFileEager(root, relPath string) ([]byte, error) {
	path := filepath.Join(root, relPath)
	rc, info, err := defaultOpener(path)
	if err != nil {
		return nil, err
	}
	if info.IsDir() {
		rc.Close()
		return nil, &os.PathError{Op: "read", Path: path, Err: os.ErrInvalid}
	}
	expectedSize := info.Size()
	if expectedSize > maxFileBytes {
		rc.Close()
		return nil, fmt.Errorf("file too large (%d bytes)", expectedSize)
	}

	type readResult struct {
		data []byte
		err  error
	}
	resultCh := make(chan readResult, 1)
	ctx, cancel := context.WithTimeout(context.Background(), readDeadlineForTest)
	defer cancel()

	go func() {
		defer rc.Close()
		data, err := io.ReadAll(rc)
		resultCh <- readResult{data, err}
	}()

	select {
	case <-ctx.Done():
		return nil, fmt.Errorf("read deadline exceeded for %s (cloud storage materializing?)", path)
	case res := <-resultCh:
		if res.err != nil {
			return nil, res.err
		}
		if int64(len(res.data)) != expectedSize {
			return nil, fmt.Errorf("short read on %s: got %d bytes, expected %d (cloud placeholder?)", path, len(res.data), expectedSize)
		}
		return res.data, nil
	}
}

// ReadFileEager is the exported wrapper other packages (mcpserver wiring) use to
// read a library file fully into memory with the same cloud-placeholder
// semantics as the file-serve handlers.
func ReadFileEager(root, relPath string) ([]byte, error) { return readFileEager(root, relPath) }

// serveFileEager reads the file at path fully into memory, verifies byte
// count matches stat().Size(), and writes the response. Cloud-storage-aware:
// truncated reads or deadline timeouts produce a 503 with Retry-After so the
// frontend can retry under user control.
//
// contentType is the Content-Type header to set; if empty, falls back to
// "application/octet-stream". The caller is responsible for any
// Content-Disposition or other headers BEFORE calling this; serveFileEager
// sets Content-Type, Content-Length, and Last-Modified only.
func serveFileEager(w http.ResponseWriter, r *http.Request, path string, contentType string) {
	serveFileEagerWith(w, r, path, contentType, defaultOpener)
}

// serveFileEagerWith is the testable variant: caller provides the opener.
func serveFileEagerWith(w http.ResponseWriter, r *http.Request, path string, contentType string, open fileOpener) {
	start := time.Now()
	rc, info, err := open(path)
	if err != nil {
		if os.IsNotExist(err) {
			w.Header().Set(cloudErrorHeader, "not-found")
			http.Error(w, "File not found", http.StatusNotFound)
			return
		}
		w.Header().Set(cloudErrorHeader, "open-failed:"+errnoName(err))
		log.Printf("serveFileEager: open %s failed: errno=%q err=%v", path, errnoName(err), err)
		http.Error(w, "Internal error", http.StatusInternalServerError)
		return
	}
	if info.IsDir() {
		rc.Close()
		w.Header().Set(cloudErrorHeader, "is-dir")
		http.Error(w, "Not a file", http.StatusBadRequest)
		return
	}
	expectedSize := info.Size()
	blocks := blocksOrUnknown(info)
	if expectedSize > maxFileBytes {
		rc.Close()
		w.Header().Set(cloudErrorHeader, "too-large")
		log.Printf("serveFileEager: %s exceeds maxFileBytes (%d > %d)", path, expectedSize, maxFileBytes)
		http.Error(w, "File too large", http.StatusRequestEntityTooLarge)
		return
	}

	// Large files: stream with a fixed buffer instead of buffering the whole
	// file in memory (a per-request multi-hundred-MB heap spike under concurrent
	// opens). The eager path below still handles everything ≤ streamThreshold.
	if expectedSize > streamThresholdForTest {
		serveFileStreaming(w, r, path, contentType, rc, info, expectedSize, blocks, start)
		return
	}

	// Read with a hard deadline. We use a goroutine + select rather than
	// SetReadDeadline because os.File on regular files doesn't honor
	// SetReadDeadline.
	type readResult struct {
		data []byte
		err  error
	}
	resultCh := make(chan readResult, 1)
	ctx, cancel := context.WithTimeout(r.Context(), readDeadlineForTest)
	defer cancel()

	go func() {
		defer rc.Close()
		// io.ReadAll blocks until EOF. On cloud placeholders this drives
		// the kernel-side download. On error io.ReadAll still returns the
		// bytes-so-far, which we surface as bytes_read in diagnostics.
		data, err := io.ReadAll(rc)
		resultCh <- readResult{data, err}
	}()

	select {
	case <-ctx.Done():
		// The read goroutine is still blocked in the syscall. We can't
		// interrupt it from here on a regular file, so we leak it until
		// the kernel returns. defer rc.Close() in the goroutine reaps the
		// FD then.
		elapsed := time.Since(start)
		w.Header().Set(cloudErrorHeader, "deadline")
		log.Printf("serveFileEager: read deadline (%s) hit on %s — likely cloud-storage materialization in progress; size=%d blocks=%s elapsed=%s", readDeadlineForTest, path, expectedSize, blocks, elapsed)
		w.Header().Set("Retry-After", retryAfterDeadline)
		http.Error(w, "File is materializing from cloud storage; retry shortly", http.StatusServiceUnavailable)
		return
	case res := <-resultCh:
		elapsed := time.Since(start)
		if res.err != nil {
			errno := errnoName(res.err)
			// EDEADLK on read = Docker FUSE bridge can't drive host-side
			// materialization of a cloud placeholder. Native macOS reads
			// would have blocked and succeeded, but inside a Docker
			// container the read deadlocks. Return a clear "materialize
			// on host first" message instead of a generic Read error.
			if errors.Is(res.err, syscall.EDEADLK) {
				w.Header().Set(cloudErrorHeader, "edeadlk")
				log.Printf("serveFileEager: %s read EDEADLK — cloud placeholder unreachable through container bind-mount; size=%d blocks=%s bytes_read=%d elapsed=%s", path, expectedSize, blocks, len(res.data), elapsed)
				w.Header().Set("Retry-After", retryAfterPlaceholder)
				http.Error(w, "Cloud-storage placeholder: file not yet materialized on host. Open it on the host (Finder → right-click → 'Keep on this device' for Google Drive/iCloud, equivalent for OneDrive) or sync your library to a fully-local directory.", http.StatusServiceUnavailable)
				return
			}
			// Other read failures: tag with the errno so the frontend can
			// see what the kernel actually returned. Status stays 500 (no
			// auto-retry) — broadening the retry set is a follow-up once
			// we know which errnos are retry-worthy.
			w.Header().Set(cloudErrorHeader, "read-error:"+errno)
			log.Printf("serveFileEager: read %s failed: errno=%q err=%v size=%d blocks=%s bytes_read=%d elapsed=%s", path, errno, res.err, expectedSize, blocks, len(res.data), elapsed)
			http.Error(w, "Read error", http.StatusInternalServerError)
			return
		}
		if int64(len(res.data)) != expectedSize {
			w.Header().Set(cloudErrorHeader, "short-read")
			log.Printf("serveFileEager: short read on %s: got %d bytes, expected %d size=%d blocks=%s elapsed=%s (cloud placeholder?)", path, len(res.data), expectedSize, expectedSize, blocks, elapsed)
			w.Header().Set("Retry-After", retryAfterShortRead)
			http.Error(w, "File partially available; retry shortly", http.StatusServiceUnavailable)
			return
		}
		// Success path.
		ct := contentType
		if ct == "" {
			ct = "application/octet-stream"
		}
		w.Header().Set("Content-Type", ct)
		w.Header().Set("Content-Length", strconv.FormatInt(expectedSize, 10))
		w.Header().Set("Last-Modified", info.ModTime().UTC().Format(http.TimeFormat))
		w.WriteHeader(http.StatusOK)
		if _, err := w.Write(res.data); err != nil {
			log.Printf("serveFileEager: write to client failed: %v", err)
		}
	}
}

// serveFileStreaming serves a large file without buffering it whole in memory.
// It first reads a probe chunk (within the deadline) so the common cloud-error
// cases — EDEADLK, immediate short/EOF, deadline — are detected and answered
// with the same 503/500 + cloud-error codes as the eager path BEFORE any header
// is sent. Once the probe succeeds it commits to a 200 and streams the body with
// a fixed buffer. Takes ownership of rc (closes it).
func serveFileStreaming(w http.ResponseWriter, r *http.Request, path, contentType string, rc io.ReadCloser, info os.FileInfo, expectedSize int64, blocks string, start time.Time) {
	defer rc.Close()

	// Probe the head of the file under the read deadline. os.File ignores
	// SetReadDeadline on regular files, so use the goroutine + select pattern
	// the eager path uses. Cap the probe to the file size so a complete file
	// smaller than streamProbeBytes doesn't read short (io.ReadFull only returns
	// nil when it fills the whole slice) — keeps the logic correct and testable
	// regardless of the threshold/probe relationship.
	probeLen := int64(streamProbeBytes)
	if expectedSize < probeLen {
		probeLen = expectedSize
	}
	probe := make([]byte, probeLen)
	type probeResult struct {
		n   int
		err error
	}
	ch := make(chan probeResult, 1)
	ctx, cancel := context.WithTimeout(r.Context(), readDeadlineForTest)
	defer cancel()
	go func() {
		n, err := io.ReadFull(rc, probe)
		ch <- probeResult{n, err}
	}()

	var n int
	select {
	case <-ctx.Done():
		elapsed := time.Since(start)
		w.Header().Set(cloudErrorHeader, "deadline")
		log.Printf("serveFileStreaming: read deadline (%s) hit on %s — likely cloud-storage materialization in progress; size=%d blocks=%s elapsed=%s", readDeadlineForTest, path, expectedSize, blocks, elapsed)
		w.Header().Set("Retry-After", retryAfterDeadline)
		http.Error(w, "File is materializing from cloud storage; retry shortly", http.StatusServiceUnavailable)
		return
	case pr := <-ch:
		elapsed := time.Since(start)
		// File ended within the probe though stat said it's large → short read
		// (cloud placeholder only partially materialized).
		if pr.err == io.EOF || pr.err == io.ErrUnexpectedEOF {
			w.Header().Set(cloudErrorHeader, "short-read")
			log.Printf("serveFileStreaming: short read on %s: got %d bytes in probe, expected %d size=%d blocks=%s elapsed=%s (cloud placeholder?)", path, pr.n, expectedSize, expectedSize, blocks, elapsed)
			w.Header().Set("Retry-After", retryAfterShortRead)
			http.Error(w, "File partially available; retry shortly", http.StatusServiceUnavailable)
			return
		}
		if pr.err != nil {
			errno := errnoName(pr.err)
			if errors.Is(pr.err, syscall.EDEADLK) {
				w.Header().Set(cloudErrorHeader, "edeadlk")
				log.Printf("serveFileStreaming: %s read EDEADLK — cloud placeholder unreachable through container bind-mount; size=%d blocks=%s elapsed=%s", path, expectedSize, blocks, elapsed)
				w.Header().Set("Retry-After", retryAfterPlaceholder)
				http.Error(w, "Cloud-storage placeholder: file not yet materialized on host. Open it on the host (Finder → right-click → 'Keep on this device' for Google Drive/iCloud, equivalent for OneDrive) or sync your library to a fully-local directory.", http.StatusServiceUnavailable)
				return
			}
			w.Header().Set(cloudErrorHeader, "read-error:"+errno)
			log.Printf("serveFileStreaming: read %s failed: errno=%q err=%v size=%d blocks=%s elapsed=%s", path, errno, pr.err, expectedSize, blocks, elapsed)
			http.Error(w, "Read error", http.StatusInternalServerError)
			return
		}
		n = pr.n
	}

	// Probe succeeded — commit to a 200 and stream the rest. From here a
	// mid-stream failure can't become a clean 503 (headers are sent); it
	// surfaces as a truncated body vs the declared Content-Length, which the
	// client detects and retries.
	ct := contentType
	if ct == "" {
		ct = "application/octet-stream"
	}
	w.Header().Set("Content-Type", ct)
	w.Header().Set("Content-Length", strconv.FormatInt(expectedSize, 10))
	w.Header().Set("Last-Modified", info.ModTime().UTC().Format(http.TimeFormat))
	w.WriteHeader(http.StatusOK)

	written, werr := w.Write(probe[:n])
	if werr != nil {
		log.Printf("serveFileStreaming: write probe to client failed: %v", werr)
		return
	}
	buf := make([]byte, streamBufBytes)
	copied, cerr := io.CopyBuffer(w, rc, buf)
	total := int64(written) + copied
	if cerr != nil {
		log.Printf("serveFileStreaming: %s stream failed after %d/%d bytes: %v", path, total, expectedSize, cerr)
		return
	}
	if total != expectedSize {
		log.Printf("serveFileStreaming: short stream on %s: sent %d, expected %d blocks=%s (cloud placeholder mid-file?)", path, total, expectedSize, blocks)
	}
}
