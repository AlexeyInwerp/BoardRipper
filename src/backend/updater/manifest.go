// Package updater — manifest types and signature/replay verification.
package updater

import (
	"errors"
	"fmt"
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
