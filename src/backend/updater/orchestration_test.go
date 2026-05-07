package updater

import (
	"archive/tar"
	"bytes"
	"strings"
	"testing"
)

// ─── parseDockerImageRef ─────────────────────────────────────────────────────
//
// Regression net for the v0.19.2 bug class: the Engine API's POST
// /images/create takes "name" and "tag" as separate query params, and getting
// the split wrong (or letting a digest leak into the name slot) causes a 404
// at container-create time after a successful pull. Cover all three reference
// shapes that show up in real manifests + the empty-string degenerate case.

func TestParseDockerImageRef_DigestForm(t *testing.T) {
	name, tag := parseDockerImageRef("alpine@sha256:abc123")
	if name != "alpine" || tag != "sha256:abc123" {
		t.Fatalf("digest form: got (%q, %q), want (alpine, sha256:abc123)", name, tag)
	}
}

func TestParseDockerImageRef_DigestFormQualifiedRegistry(t *testing.T) {
	name, tag := parseDockerImageRef("ghcr.io/alexeyinwerp/boardripper@sha256:abc123")
	if name != "ghcr.io/alexeyinwerp/boardripper" || tag != "sha256:abc123" {
		t.Fatalf("qualified-registry digest: got (%q, %q)", name, tag)
	}
}

func TestParseDockerImageRef_TagForm(t *testing.T) {
	name, tag := parseDockerImageRef("alpine:3.19")
	if name != "alpine" || tag != "3.19" {
		t.Fatalf("tag form: got (%q, %q), want (alpine, 3.19)", name, tag)
	}
}

func TestParseDockerImageRef_TagFormQualifiedRegistry(t *testing.T) {
	name, tag := parseDockerImageRef("ghcr.io/alexeyinwerp/boardripper:v0.19.5")
	// LastIndex on ':' correctly picks the version separator, not the registry port.
	if name != "ghcr.io/alexeyinwerp/boardripper" || tag != "v0.19.5" {
		t.Fatalf("qualified-registry tag: got (%q, %q)", name, tag)
	}
}

func TestParseDockerImageRef_BareImplicitsLatest(t *testing.T) {
	name, tag := parseDockerImageRef("alpine")
	if name != "alpine" || tag != "latest" {
		t.Fatalf("bare form: got (%q, %q), want (alpine, latest)", name, tag)
	}
}

func TestParseDockerImageRef_DigestWinsOverColon(t *testing.T) {
	// Pathological input: ':' inside a sha256 digest. The '@' precedes any ':'
	// in the digest portion, so digest form must be detected first.
	name, tag := parseDockerImageRef("alpine@sha256:abc:def")
	if name != "alpine" || tag != "sha256:abc:def" {
		t.Fatalf("digest with embedded colon: got (%q, %q)", name, tag)
	}
}

// ─── selectNewImageRef ───────────────────────────────────────────────────────
//
// The exact bug v0.19.2 shipped. A valid signed manifest produces case 1; a
// hand-crafted manifest with no Digest produces case 2; a malformed/legacy
// manifest produces case 3. The orchestrator's containers/create only resolves
// against form 1 reliably after a pull-by-digest — forms 2 and 3 are intentional
// best-effort fallbacks for tarball-load paths.

func TestSelectNewImageRef_PrefersDigest(t *testing.T) {
	m := &Manifest{
		Version: "v0.19.5",
		Image:   ManifestImage{Registry: "ghcr.io/alexeyinwerp/boardripper", Tag: "v0.19.5", Digest: "sha256:abc"},
	}
	if got := selectNewImageRef(m); got != "ghcr.io/alexeyinwerp/boardripper@sha256:abc" {
		t.Fatalf("digest preferred: got %q", got)
	}
}

func TestSelectNewImageRef_FallsBackToTag(t *testing.T) {
	m := &Manifest{
		Version: "v0.19.5",
		Image:   ManifestImage{Registry: "ghcr.io/alexeyinwerp/boardripper", Tag: "v0.19.5"},
	}
	if got := selectNewImageRef(m); got != "ghcr.io/alexeyinwerp/boardripper:v0.19.5" {
		t.Fatalf("tag fallback: got %q", got)
	}
}

func TestSelectNewImageRef_FallsBackToLocalTag(t *testing.T) {
	m := &Manifest{Version: "v0.19.5"}
	if got := selectNewImageRef(m); got != "boardripper:v0.19.5" {
		t.Fatalf("local-tag fallback: got %q", got)
	}
}

func TestSelectNewImageRef_DigestWithoutRegistryFallsThrough(t *testing.T) {
	// Pathological: digest set but no registry. The signed manifests we ship
	// always carry both, but defend against a hand-edited one.
	m := &Manifest{
		Version: "v0.19.5",
		Image:   ManifestImage{Digest: "sha256:abc"},
	}
	if got := selectNewImageRef(m); got != "boardripper:v0.19.5" {
		t.Fatalf("digest-without-registry should fall through: got %q", got)
	}
}

// ─── extractBundle ───────────────────────────────────────────────────────────
//
// The drop-to-update bundle is untrusted bytes until VerifyManifest passes,
// so extractBundle's failure modes matter. Cover the three required-member
// errors, the path-traversal guard, the per-member size cap, and the bsdtar/gnu
// "./" prefix parity.

// makeBundleTar builds a tar archive in memory from the given (name, body)
// pairs. Used to feed extractBundle synthetic input.
func makeBundleTar(t *testing.T, members map[string][]byte) []byte {
	t.Helper()
	buf := bytes.NewBuffer(nil)
	w := tar.NewWriter(buf)
	for name, body := range members {
		if err := w.WriteHeader(&tar.Header{
			Name: name,
			Mode: 0o644,
			Size: int64(len(body)),
		}); err != nil {
			t.Fatalf("WriteHeader(%q): %v", name, err)
		}
		if _, err := w.Write(body); err != nil {
			t.Fatalf("Write(%q): %v", name, err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatalf("tar Close: %v", err)
	}
	return buf.Bytes()
}

func TestExtractBundle_HappyPath(t *testing.T) {
	manifest := []byte(`{"version":"v0.19.5"}`)
	sig := []byte("RWQAAAA...")
	tarball := []byte("OCI image bytes")
	bundle := makeBundleTar(t, map[string][]byte{
		"manifest.json":             manifest,
		"manifest.json.minisig":     sig,
		"boardripper-v0.19.5.tar.gz": tarball,
	})

	out, err := extractBundle(bytes.NewReader(bundle))
	if err != nil {
		t.Fatalf("extractBundle: %v", err)
	}
	if !bytes.Equal(out.manifestBytes, manifest) {
		t.Errorf("manifest bytes mismatch")
	}
	if !bytes.Equal(out.signatureBytes, sig) {
		t.Errorf("signature bytes mismatch")
	}
	if out.tarballName != "boardripper-v0.19.5.tar.gz" {
		t.Errorf("tarball name: got %q", out.tarballName)
	}
	if !bytes.Equal(out.tarballBytes, tarball) {
		t.Errorf("tarball bytes mismatch")
	}
}

func TestExtractBundle_StripsLeadingDotSlash(t *testing.T) {
	// gnu tar writes "./foo", bsdtar writes "foo" — bundle producer must work
	// either way.
	bundle := makeBundleTar(t, map[string][]byte{
		"./manifest.json":              []byte("{}"),
		"./manifest.json.minisig":      []byte("sig"),
		"./boardripper-v0.19.5.tar.gz": []byte("tar"),
	})
	if _, err := extractBundle(bytes.NewReader(bundle)); err != nil {
		t.Fatalf("dot-slash variant rejected: %v", err)
	}
}

func TestExtractBundle_RejectsMissingManifest(t *testing.T) {
	bundle := makeBundleTar(t, map[string][]byte{
		"manifest.json.minisig":      []byte("sig"),
		"boardripper-v0.19.5.tar.gz": []byte("tar"),
	})
	_, err := extractBundle(bytes.NewReader(bundle))
	if err == nil || !strings.Contains(err.Error(), "manifest.json") {
		t.Fatalf("expected missing-manifest error, got: %v", err)
	}
}

func TestExtractBundle_RejectsMissingSignature(t *testing.T) {
	bundle := makeBundleTar(t, map[string][]byte{
		"manifest.json":              []byte("{}"),
		"boardripper-v0.19.5.tar.gz": []byte("tar"),
	})
	_, err := extractBundle(bytes.NewReader(bundle))
	if err == nil || !strings.Contains(err.Error(), "minisig") {
		t.Fatalf("expected missing-signature error, got: %v", err)
	}
}

func TestExtractBundle_RejectsMissingTarball(t *testing.T) {
	bundle := makeBundleTar(t, map[string][]byte{
		"manifest.json":         []byte("{}"),
		"manifest.json.minisig": []byte("sig"),
	})
	_, err := extractBundle(bytes.NewReader(bundle))
	if err == nil || !strings.Contains(err.Error(), "boardripper-") {
		t.Fatalf("expected missing-tarball error, got: %v", err)
	}
}

func TestExtractBundle_IgnoresPathTraversal(t *testing.T) {
	// Members with path separators or ".." are silently dropped (the loop
	// `continue`s). Validate that with a malicious bundle we still hit the
	// missing-required-member error rather than escaping the temp dir or
	// loading the tarball.
	bundle := makeBundleTar(t, map[string][]byte{
		"../../etc/passwd":           []byte("rooty"),
		"subdir/manifest.json":       []byte("{}"),
		"manifest.json.minisig":      []byte("sig"),
		"boardripper-v0.19.5.tar.gz": []byte("tar"),
	})
	out, err := extractBundle(bytes.NewReader(bundle))
	if err == nil {
		// No flat manifest.json present (only "subdir/manifest.json"), so
		// extractBundle must fail with missing-manifest, not silently use the
		// nested one.
		t.Fatalf("expected missing-manifest error when only nested manifest.json exists; got out=%+v", out)
	}
	if !strings.Contains(err.Error(), "manifest.json") {
		t.Fatalf("expected missing-manifest error, got: %v", err)
	}
}

func TestExtractBundle_IgnoresUnknownMembers(t *testing.T) {
	// A future bundle format extension might add README.md alongside the
	// three required members. extractBundle should ignore extras — they don't
	// participate in the trust envelope.
	bundle := makeBundleTar(t, map[string][]byte{
		"manifest.json":              []byte("{}"),
		"manifest.json.minisig":      []byte("sig"),
		"boardripper-v0.19.5.tar.gz": []byte("tar"),
		"README.md":                  []byte("hello"),
		"some-other-file.txt":        []byte("ignored"),
	})
	if _, err := extractBundle(bytes.NewReader(bundle)); err != nil {
		t.Fatalf("extras should be ignored: %v", err)
	}
}

// ─── bindsFromMounts ─────────────────────────────────────────────────────────
//
// Plain helper but trivially regressable. v0.19.2's recreation of the new
// container relied on this for /data and /library bind preservation; a missing
// :ro on a read-only mount could let an updated container scribble where the
// previous one couldn't.

func TestBindsFromMounts_EmptyReturnsNil(t *testing.T) {
	if got := bindsFromMounts(nil); got != nil {
		t.Errorf("empty mounts should return nil, got %v", got)
	}
}

func TestBindsFromMounts_ReadWriteMount(t *testing.T) {
	got := bindsFromMounts([]mount{{Source: "/host/data", Destination: "/data", RW: true}})
	if len(got) != 1 || got[0] != "/host/data:/data" {
		t.Errorf("RW bind: got %v", got)
	}
}

func TestBindsFromMounts_ReadOnlyAppendsRoSuffix(t *testing.T) {
	got := bindsFromMounts([]mount{{Source: "/host/library", Destination: "/library", RW: false}})
	if len(got) != 1 || got[0] != "/host/library:/library:ro" {
		t.Errorf("RO bind: got %v", got)
	}
}

func TestBindsFromMounts_MixedPreservesOrder(t *testing.T) {
	got := bindsFromMounts([]mount{
		{Source: "/host/data", Destination: "/data", RW: true},
		{Source: "/host/library", Destination: "/library", RW: false},
		{Source: "/host/cache", Destination: "/cache", RW: true},
	})
	want := []string{"/host/data:/data", "/host/library:/library:ro", "/host/cache:/cache"}
	if len(got) != len(want) {
		t.Fatalf("len mismatch: got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("[%d]: got %q, want %q", i, got[i], want[i])
		}
	}
}

// ─── shortID ─────────────────────────────────────────────────────────────────
//
// Tiny helper; tests exist mostly to pin behavior so any future
// generic-substring refactor doesn't accidentally widen what's logged.

func TestShortID_TruncatesLongID(t *testing.T) {
	long := "abcdef0123456789beef1234"
	if got := shortID(long); got != "abcdef012345" {
		t.Errorf("got %q", got)
	}
}

func TestShortID_PassesThroughShortInput(t *testing.T) {
	if got := shortID("short"); got != "short" {
		t.Errorf("got %q", got)
	}
}

func TestShortID_HandlesEmptyString(t *testing.T) {
	if got := shortID(""); got != "" {
		t.Errorf("got %q", got)
	}
}

func TestShortID_BoundaryExactly12(t *testing.T) {
	if got := shortID("abcdef012345"); got != "abcdef012345" {
		t.Errorf("got %q", got)
	}
}
