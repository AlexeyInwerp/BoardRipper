package contribdb

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Snapshot-pull operational bounds. Numbers mirror the updater's: a hard cap
// keeps a malicious mirror from OOMing the container by streaming forever,
// and the manifest's own size_bytes is the inner authority.
const (
	snapshotDownloadTimeout    = 10 * time.Minute
	snapshotFallbackMaxAsset   = 256 << 20 // 256 MiB sanity cap
	snapshotCounterFile        = "snapshot.counter"
	snapshotAttemptCap         = 0 // never give up on snapshot retries
)

// readSnapshotCounter reads <dataDir>/contribdb/snapshot.counter, returning
// 0 when the file is missing or unreadable. The counter is persisted
// separately from the manifest so a corrupt manifest doesn't erase the
// replay-defence baseline.
func readSnapshotCounter(dataDir string) (int64, error) {
	p := filepath.Join(dataDir, subdir, snapshotCounterFile)
	b, err := os.ReadFile(p)
	if err != nil {
		return 0, err
	}
	v, err := strconv.ParseInt(strings.TrimSpace(string(b)), 10, 64)
	if err != nil {
		return 0, err
	}
	return v, nil
}

func writeSnapshotCounter(dataDir string, counter int64) error {
	p := filepath.Join(dataDir, subdir, snapshotCounterFile)
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, []byte(strconv.FormatInt(counter, 10)), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, p)
}

// PullSnapshot fetches /v1/snapshots/latest, verifies the manifest's
// signature + counter + freshness, downloads the tarball, sha256-verifies
// it, atomically replaces <dataDir>/contribdb/snapshot.db, then hot-swaps
// the running boarddb handle if the new counter beats the currently-open
// one. Single-flight gate protects against concurrent calls; subsequent
// callers are dropped (return nil with a no-op log) — same idiom as obd.
func (s *Service) PullSnapshot(ctx context.Context) error {
	if !s.Enabled() {
		return errors.New("contribdb: disabled")
	}

	s.pullingMu.Lock()
	if s.pulling {
		s.pullingMu.Unlock()
		// Drop-guard: a concurrent call is already pulling; the caller
		// gets a no-op success.
		return nil
	}
	s.pulling = true
	s.pullingMu.Unlock()
	defer func() {
		s.pullingMu.Lock()
		s.pulling = false
		s.pullingMu.Unlock()
	}()

	now := time.Now().UTC()

	// Capture errors back into the status struct.
	finalize := func(err error) error {
		s.mu.Lock()
		s.lastSyncAt = now
		if err != nil {
			s.lastSyncErr = err.Error()
		} else {
			s.lastSyncErr = ""
		}
		s.mu.Unlock()
		return err
	}

	// 1. Fetch manifest.
	manifestBytes, err := s.fetchSnapshotManifest(ctx)
	if err != nil {
		s.recordError("pull", "manifest fetch: "+err.Error())
		return finalize(err)
	}

	var m SnapshotManifest
	if err := json.Unmarshal(manifestBytes, &m); err != nil {
		s.recordError("pull", "manifest decode: "+err.Error())
		return finalize(fmt.Errorf("manifest decode: %w", err))
	}

	// 2. Verify signature against the compiled-in pubkey.
	if s.cfg.SnapshotPubKey != "" {
		if err := VerifyManifestSignature(manifestBytes, m.Signature, s.cfg.SnapshotPubKey); err != nil {
			s.recordError("pull", "signature verify: "+err.Error())
			return finalize(err)
		}
	}

	// 3. Validate counter / freshness / etc.
	s.mu.RLock()
	localCtr := s.snapshotCounter
	s.mu.RUnlock()
	if err := ValidateManifest(&m, localCtr); err != nil {
		// Counter "not greater than installed" is an info-level outcome
		// (we're already at this snapshot); don't pollute the error ring.
		if strings.Contains(err.Error(), "counter not greater than installed") {
			return finalize(nil)
		}
		s.recordError("pull", "validate: "+err.Error())
		return finalize(err)
	}

	// 4. Download tarball.
	tarball, err := s.fetchTarball(ctx, m.TarballURL, m.SizeBytes)
	if err != nil {
		s.recordError("pull", "tarball fetch: "+err.Error())
		return finalize(err)
	}

	// 5. Verify sha256.
	if err := VerifyTarballSHA256(tarball, m.TarballSHA256); err != nil {
		s.recordError("pull", "tarball sha256: "+err.Error())
		return finalize(err)
	}

	// 6. Extract boards.db from the tarball into a temp file.
	tmpPath := filepath.Join(s.cfg.DataDir, subdir, "snapshot.db.partial")
	if err := extractBoardsDB(tarball, tmpPath); err != nil {
		s.recordError("pull", "extract: "+err.Error())
		return finalize(err)
	}

	// 7. Atomic swap into place.
	finalPath := filepath.Join(s.cfg.DataDir, subdir, snapshotFilename)
	if err := os.Rename(tmpPath, finalPath); err != nil {
		_ = os.Remove(tmpPath)
		s.recordError("pull", "rename: "+err.Error())
		return finalize(fmt.Errorf("rename: %w", err))
	}

	// 8. Persist counter and update in-memory state.
	if err := writeSnapshotCounter(s.cfg.DataDir, m.Counter); err != nil {
		s.recordError("pull", "persist counter: "+err.Error())
		// Non-fatal — the file is in place; we'll just re-pull on next boot.
	}
	s.mu.Lock()
	s.snapshotCounter = m.Counter
	s.mu.Unlock()

	// 9. Hot-swap the running boarddb handle so the next Resolve()
	// reads the new data without a restart.
	if s.bdb != nil && s.bdb.Available() {
		if err := s.bdb.Reopen(finalPath); err != nil {
			s.recordError("pull", "boarddb reopen: "+err.Error())
			// Don't fail the pull — the snapshot is on disk for next boot.
		}
	}

	return finalize(nil)
}

// fetchSnapshotManifest GETs /v1/snapshots/latest and returns the raw body.
// Returns up to 1 MiB — anything larger is treated as junk.
func (s *Service) fetchSnapshotManifest(ctx context.Context) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		s.cfg.BaseURL+"/v1/snapshots/latest", nil)
	if err != nil {
		return nil, err
	}
	resp, err := s.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return io.ReadAll(io.LimitReader(resp.Body, 1<<20))
}

// fetchTarball downloads the snapshot tarball. The manifest's size_bytes
// caps the read; the fallback cap defends against malformed manifests.
func (s *Service) fetchTarball(ctx context.Context, url string, sizeBytes int64) ([]byte, error) {
	cap := int64(snapshotFallbackMaxAsset)
	if sizeBytes > 0 && sizeBytes < cap {
		cap = sizeBytes
	}
	dlCtx, cancel := context.WithTimeout(ctx, snapshotDownloadTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(dlCtx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := s.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return nil, fmt.Errorf("HTTP %d from %s", resp.StatusCode, url)
	}
	// Read cap+1 so we can detect "served more than expected".
	body, err := io.ReadAll(io.LimitReader(resp.Body, cap+1))
	if err != nil {
		return nil, err
	}
	if int64(len(body)) > cap {
		return nil, fmt.Errorf("tarball exceeds cap (%d > %d)", len(body), cap)
	}
	return body, nil
}

// extractBoardsDB scans the tar.gz body and extracts the single `boards.db`
// entry to dst. Any other entry is ignored. Symlinks and absolute paths
// are rejected — defence against a hostile-but-signed tarball.
func extractBoardsDB(tarball []byte, dst string) error {
	gz, err := gzip.NewReader(strings.NewReader(string(tarball)))
	if err != nil {
		return fmt.Errorf("gzip: %w", err)
	}
	defer gz.Close()

	tr := tar.NewReader(gz)
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return fmt.Errorf("tar next: %w", err)
		}
		name := filepath.Base(h.Name)
		if h.Typeflag != tar.TypeReg || name != "boards.db" {
			continue
		}
		// Sanitize: reject absolute / traversal paths even though we only
		// honour basename.
		if strings.Contains(h.Name, "..") || strings.HasPrefix(h.Name, "/") {
			return fmt.Errorf("tar: rejected unsafe path %q", h.Name)
		}
		f, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
		if err != nil {
			return fmt.Errorf("open dst: %w", err)
		}
		if _, err := io.Copy(f, tr); err != nil {
			f.Close()
			_ = os.Remove(dst)
			return fmt.Errorf("copy: %w", err)
		}
		if err := f.Sync(); err != nil {
			f.Close()
			_ = os.Remove(dst)
			return fmt.Errorf("sync: %w", err)
		}
		if err := f.Close(); err != nil {
			_ = os.Remove(dst)
			return err
		}
		return nil
	}
	return errors.New("tar: boards.db entry not found")
}
