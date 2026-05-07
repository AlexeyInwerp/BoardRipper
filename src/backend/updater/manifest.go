// Package updater — manifest types and signature/replay verification.
package updater

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"aead.dev/minisign"
)

// Manifest is the signed JSON document fetched from each mirror.
type Manifest struct {
	Version             string          `json:"version"`
	Counter             int64           `json:"counter"`
	ReleasedAt          time.Time       `json:"released_at"`
	NotAfter            time.Time       `json:"not_after"`
	Important           bool            `json:"important"`
	ImportantReason     string          `json:"important_reason,omitempty"`
	NotesURL            string          `json:"notes_url,omitempty"`
	Tarball             ManifestTarball `json:"tarball"`
	Image               ManifestImage   `json:"image"`
	MinSupportedVersion string          `json:"min_supported_version"`
	OrchestratorImage   string          `json:"orchestrator_image_digest"`
	SourceListNext      []string        `json:"source_list_next,omitempty"`
}

type ManifestTarball struct {
	URLPrimary string   `json:"url_primary"`
	URLMirrors []string `json:"url_mirrors"`
	SHA256     string   `json:"sha256"`
	SizeBytes  int64    `json:"size_bytes"`
}

type ManifestImage struct {
	Registry string `json:"registry"`
	Tag      string `json:"tag"`
	Digest   string `json:"digest"`
}

// Freshness bounds for `released_at`. Without these, a compromised mirror could
// serve any signed-but-stale manifest from anywhere in the 90-day `not_after`
// window and downgrade or freeze a fresh install (the counter check skips when
// installedCounter==0). The bounds also defeat clock-skew abuse on the future
// side. 30 days is wide enough not to bite normal release cadence and tight
// enough to reject quarter-year-old replays.
const (
	releasedAtFutureSlack = 24 * time.Hour
	releasedAtMaxAge      = 30 * 24 * time.Hour
)

// ValidateManifest checks expiry, freshness, counter monotonicity, and
// min_supported_version. installedCounter==0 means "first install" — counter
// check is skipped, but the freshness bounds still bite (a fresh install must
// not be onboarded onto a stale signed manifest).
func ValidateManifest(m *Manifest, installedCounter int64, installedVersion string) error {
	now := time.Now()
	if now.After(m.NotAfter) {
		return fmt.Errorf("manifest expired: not_after=%s", m.NotAfter.Format(time.RFC3339))
	}
	if m.ReleasedAt.IsZero() {
		return errors.New("manifest missing released_at")
	}
	if m.ReleasedAt.After(now.Add(releasedAtFutureSlack)) {
		return fmt.Errorf("manifest released_at is in the future: %s", m.ReleasedAt.Format(time.RFC3339))
	}
	if now.Sub(m.ReleasedAt) > releasedAtMaxAge {
		return fmt.Errorf("manifest stale: released_at=%s older than %s", m.ReleasedAt.Format(time.RFC3339), releasedAtMaxAge)
	}
	if installedCounter > 0 && m.Counter <= installedCounter {
		return fmt.Errorf("manifest counter not greater than installed (got %d, have %d)", m.Counter, installedCounter)
	}
	if !versionGTE(installedVersion, m.MinSupportedVersion) {
		return fmt.Errorf("installed version %s below min_supported_version %s — manual update required", installedVersion, m.MinSupportedVersion)
	}
	return nil
}

// versionGTE returns true if a >= b. Reuses parseVersion from updater.go.
func versionGTE(a, b string) bool {
	pa, pb := parseVersion(a), parseVersion(b)
	for i := 0; i < len(pa) || i < len(pb); i++ {
		var ai, bi int
		if i < len(pa) {
			ai = pa[i]
		}
		if i < len(pb) {
			bi = pb[i]
		}
		if ai != bi {
			return ai > bi
		}
	}
	return true
}

// VerifyManifest checks that sig is a valid minisign signature of manifestBytes
// under pubKeyStr (the base64 key string as produced by PublicKey.String()).
func VerifyManifest(manifestBytes, sig []byte, pubKeyStr string) error {
	var pub minisign.PublicKey
	if err := pub.UnmarshalText([]byte(pubKeyStr)); err != nil {
		return fmt.Errorf("parse pubkey: %w", err)
	}
	if !minisign.Verify(pub, manifestBytes, sig) {
		return errors.New("minisign verification failed")
	}
	return nil
}

// VerifyTarballSHA256 checks that the SHA256 hash of data matches expectedHex.
func VerifyTarballSHA256(data []byte, expectedHex string) error {
	h := sha256.Sum256(data)
	got := hex.EncodeToString(h[:])
	want := strings.ToLower(strings.TrimSpace(expectedHex))
	if got != want {
		return fmt.Errorf("sha256 mismatch: got %s, want %s", got, want)
	}
	return nil
}
