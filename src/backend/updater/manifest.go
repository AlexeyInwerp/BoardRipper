// Package updater — manifest types and signature/replay verification.
package updater

import (
	"time"

	_ "aead.dev/minisign" // used in A2 VerifyManifest
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
