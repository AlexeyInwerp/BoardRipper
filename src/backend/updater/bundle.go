// Bundle-mode update: a single .brupdate / .tar archive dropped onto the UI
// containing the signed manifest, its signature, and the OCI image tarball.
// Same trust envelope as the network path — the manifest signature is the
// only thing that matters; the bundle file itself is untrusted bytes until
// VerifyManifest passes. Useful as a recovery path when the in-binary
// orchestrator can't reach GHCR / ripperdoc.de, or when the maintainer
// wants to ship an update via USB stick to an air-gapped install.

package updater

import (
	"archive/tar"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// BundleEntry names the three required members of an update bundle.
const (
	bundleManifest    = "manifest.json"
	bundleSignature   = "manifest.json.minisig"
	bundleTarballGlob = "boardripper-" // tarball name starts with this
)

// extractedBundle holds the three pieces parsed out of a bundle archive.
type extractedBundle struct {
	manifestBytes  []byte
	signatureBytes []byte
	tarballName    string
	tarballBytes   []byte
}

// extractBundle reads the bundle tar archive and returns its three required
// members. Strips any leading "./" from member names so bundles created with
// either bsdtar or gnu tar parse the same way.
func extractBundle(r io.Reader) (*extractedBundle, error) {
	tr := tar.NewReader(r)
	out := &extractedBundle{}
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("read bundle: %w", err)
		}
		name := strings.TrimPrefix(hdr.Name, "./")
		// Reject anything that tries to escape — bundle members must be flat.
		if strings.Contains(name, "/") || strings.Contains(name, "..") {
			continue
		}
		// 50 MiB per-member ceiling; the OCI tarball is the largest piece and
		// rarely exceeds 30 MiB.
		buf := bytes.NewBuffer(nil)
		if _, err := io.CopyN(buf, tr, 50<<20); err != nil && err != io.EOF {
			return nil, fmt.Errorf("read %q: %w", name, err)
		}
		switch {
		case name == bundleManifest:
			out.manifestBytes = buf.Bytes()
		case name == bundleSignature:
			out.signatureBytes = buf.Bytes()
		case strings.HasPrefix(name, bundleTarballGlob) && strings.HasSuffix(name, ".tar.gz"):
			out.tarballName = name
			out.tarballBytes = buf.Bytes()
		}
	}
	if len(out.manifestBytes) == 0 {
		return nil, errors.New("bundle missing manifest.json")
	}
	if len(out.signatureBytes) == 0 {
		return nil, errors.New("bundle missing manifest.json.minisig")
	}
	if len(out.tarballBytes) == 0 {
		return nil, errors.New("bundle missing boardripper-*.tar.gz")
	}
	return out, nil
}

// ApplyBundle handles a manually-uploaded update bundle. Verifies signature,
// validates manifest, checks tarball sha256, docker-loads the image, persists
// the counter, and runs orchestrateRestart — the same sequence as the
// network-fetched Apply() path. Runs in the background; the caller streams
// progress via the existing /api/update/progress SSE endpoint.
func (u *Updater) ApplyBundle(bundleBytes []byte) error {
	if PubKey == "" {
		return errors.New("updater not configured: PubKey is empty (built without -ldflags)")
	}

	u.mu.Lock()
	if u.updating {
		u.mu.Unlock()
		return errors.New("update already in progress")
	}
	u.updating = true
	u.progress = nil
	u.mu.Unlock()
	defer func() { u.mu.Lock(); u.updating = false; u.mu.Unlock() }()

	u.logProgress(fmt.Sprintf("Bundle received: %d bytes", len(bundleBytes)), "info")

	bundle, err := extractBundle(bytes.NewReader(bundleBytes))
	if err != nil {
		u.logProgress("Bundle extract failed: "+err.Error(), "error")
		return fmt.Errorf("extract: %w", err)
	}
	u.logProgress(fmt.Sprintf("Bundle members: manifest=%dB sig=%dB tarball=%s (%dB)",
		len(bundle.manifestBytes), len(bundle.signatureBytes), bundle.tarballName, len(bundle.tarballBytes)), "info")

	// 1. Verify signature.
	if err := VerifyManifest(bundle.manifestBytes, bundle.signatureBytes, PubKey); err != nil {
		u.logProgress("Signature verification failed: "+err.Error(), "error")
		return fmt.Errorf("signature: %w", err)
	}
	u.logProgress("Signature OK", "info")

	// 2. Parse manifest.
	var m Manifest
	if err := json.Unmarshal(bundle.manifestBytes, &m); err != nil {
		u.logProgress("Manifest parse failed: "+err.Error(), "error")
		return fmt.Errorf("manifest parse: %w", err)
	}

	// 3. Validate counter / expiry / min-version.
	installedCtr := u.readInstalledCounter()
	if err := ValidateManifest(&m, installedCtr, Version); err != nil {
		// Rolled-back-update leniency, identical to Check() (see updater.go):
		// Apply()/ApplyBundle() persist the counter to .update-counter BEFORE the
		// health-gated swap, so a release that rolled back leaves installedCounter
		// == m.Counter while the running binary is still the OLD version. Without
		// this the drop-to-update escape hatch — the last resort when GHCR and
		// ripperdoc.de are both unreachable — could never re-apply a rolled-back
		// release. Only the counter-monotonicity failure is forgiven: re-running
		// ValidateManifest with counter-1 confirms every other gate (expiry /
		// freshness / min_supported_version) still passes.
		if !(m.Counter == installedCtr && m.Version != Version && ValidateManifest(&m, installedCtr-1, Version) == nil) {
			u.logProgress("Manifest validation failed: "+err.Error(), "error")
			return fmt.Errorf("validate: %w", err)
		}
		u.logProgress(fmt.Sprintf("Re-applying rolled-back release %s (counter %d unchanged since the prior attempt)", m.Version, m.Counter), "info")
	}
	u.logProgress(fmt.Sprintf("Manifest OK: %s (counter %d)", m.Version, m.Counter), "info")

	// 4. Verify tarball sha256.
	if err := VerifyTarballSHA256(bundle.tarballBytes, m.Tarball.SHA256); err != nil {
		u.logProgress("Tarball sha256 mismatch: "+err.Error(), "error")
		return fmt.Errorf("sha256: %w", err)
	}
	u.logProgress("Tarball sha256 OK", "info")

	// 5. Docker required from here on.
	if !isDockerAvailable() {
		u.logProgress("Docker socket not available", "error")
		return errors.New("Docker socket not available")
	}

	// 6. Tag previous (best-effort) before swap.
	if err := u.tagPrevious(); err != nil {
		u.logProgress("warn: tagPrevious failed: "+err.Error()+" (rollback unavailable)", "info")
	}

	// 7. Stage tarball + docker load.
	dest := filepath.Join(u.dataDir, "boardripper-"+m.Version+".tar.gz")
	if err := os.WriteFile(dest, bundle.tarballBytes, 0o644); err != nil {
		u.logProgress("Stage tarball failed: "+err.Error(), "error")
		return fmt.Errorf("stage: %w", err)
	}
	if err := u.dockerLoad(dest); err != nil {
		u.logProgress("docker load failed: "+err.Error(), "error")
		return fmt.Errorf("docker load: %w", err)
	}
	u.logProgress("Image loaded into local store", "info")

	// 8. Persist counter BEFORE restart (matches Apply() behavior).
	if err := u.writeInstalledCounter(m.Counter); err != nil {
		u.logProgress("warn: counter persist: "+err.Error(), "info")
	}

	// 9. Update state so the SSE consumer / status endpoint reflect the new manifest.
	u.mu.Lock()
	u.state.Manifest = &m
	u.state.LatestVersion = m.Version
	u.mu.Unlock()

	// 10. Orchestrate restart. After this returns the running container will
	// be replaced; this goroutine is killed mid-flight which is expected.
	return u.orchestrateRestart(&m)
}
