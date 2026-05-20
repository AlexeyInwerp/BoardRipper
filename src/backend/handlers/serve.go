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
