package contribdb

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"aead.dev/minisign"
)

// SnapshotManifest is the signed JSON document fetched from
// /v1/snapshots/latest. Schema mirrors updater.Manifest with snapshot-
// specific fields. The trust envelope is intentionally parallel to the
// update pipeline's so the same maintainer discipline applies.
type SnapshotManifest struct {
	Version             int       `json:"version"`
	Counter             int64     `json:"counter"`
	ReleasedAt          time.Time `json:"released_at"`
	NotAfter            time.Time `json:"not_after"`
	MinSupportedVersion string    `json:"min_supported_version,omitempty"`
	TarballURL          string    `json:"tarball_url"`
	TarballSHA256       string    `json:"tarball_sha256"`
	SizeBytes           int64     `json:"size_bytes"`
	// Signature is a base64 minisign signature over the manifest bytes
	// with the signature field zeroed. Stripped before verify; see
	// manifestBytesForSig.
	Signature string `json:"signature,omitempty"`
}

// Freshness bounds, mirroring updater/manifest.go. Without these, a
// compromised mirror could replay any signed-but-stale manifest.
const (
	snapReleasedAtFutureSlack = 24 * time.Hour
	snapReleasedAtMaxAge      = 30 * 24 * time.Hour
)

// ValidateManifest enforces freshness, counter monotonicity, and expiry on
// the snapshot manifest. installedCounter==0 means "no snapshot pulled
// yet" — counter monotonicity is skipped (the freshness window still
// binds).
func ValidateManifest(m *SnapshotManifest, installedCounter int64) error {
	now := time.Now()
	if now.After(m.NotAfter) {
		return fmt.Errorf("manifest expired: not_after=%s", m.NotAfter.Format(time.RFC3339))
	}
	if m.ReleasedAt.IsZero() {
		return errors.New("manifest missing released_at")
	}
	if m.ReleasedAt.After(now.Add(snapReleasedAtFutureSlack)) {
		return fmt.Errorf("manifest released_at is in the future: %s", m.ReleasedAt.Format(time.RFC3339))
	}
	if now.Sub(m.ReleasedAt) > snapReleasedAtMaxAge {
		return fmt.Errorf("manifest stale: released_at=%s older than %s",
			m.ReleasedAt.Format(time.RFC3339), snapReleasedAtMaxAge)
	}
	if installedCounter > 0 && m.Counter <= installedCounter {
		return fmt.Errorf("manifest counter not greater than installed (got %d, have %d)",
			m.Counter, installedCounter)
	}
	if m.TarballURL == "" || m.TarballSHA256 == "" {
		return errors.New("manifest missing tarball_url or tarball_sha256")
	}
	return nil
}

// VerifyManifestSignature checks the manifest signature against the
// configured Ed25519 (minisign) pubkey. manifestBytes is the raw JSON
// payload as fetched from the server, and sigBase64 is the manifest's
// `signature` field (base64-encoded minisign blob).
func VerifyManifestSignature(manifestBytes []byte, sigBase64 string, pubKeyStr string) error {
	if pubKeyStr == "" {
		return errors.New("snapshot pubkey not configured (built without -ldflags DBPubKey)")
	}
	var pub minisign.PublicKey
	if err := pub.UnmarshalText([]byte(pubKeyStr)); err != nil {
		return fmt.Errorf("parse pubkey: %w", err)
	}
	if sigBase64 == "" {
		return errors.New("manifest missing signature")
	}
	// minisign signatures are produced over the JSON bytes with the
	// `signature` field stripped — same convention as the updater. We
	// just hand both to the library and let it Verify.
	sig := []byte(sigBase64)
	if !minisign.Verify(pub, manifestBytes, sig) {
		return errors.New("minisign verification failed")
	}
	return nil
}

// VerifyTarballSHA256 checks that the hex-encoded sha256 of `data` matches
// `expectedHex`. Hex comparison is case-insensitive and trim-tolerant.
func VerifyTarballSHA256(data []byte, expectedHex string) error {
	h := sha256.Sum256(data)
	got := hex.EncodeToString(h[:])
	want := strings.ToLower(strings.TrimSpace(expectedHex))
	if got != want {
		return fmt.Errorf("sha256 mismatch: got %s, want %s", got, want)
	}
	return nil
}
