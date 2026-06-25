package updater

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"aead.dev/minisign"
)

func TestVerifyManifest_AcceptsValidSignature(t *testing.T) {
	pub, priv, err := minisign.GenerateKey(nil)
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	manifestBytes := []byte(`{"version":"v0.8.0","counter":1}`)
	sig := minisign.Sign(priv, manifestBytes)

	pubStr := pub.String()
	if err := VerifyManifest(manifestBytes, sig, pubStr); err != nil {
		t.Errorf("VerifyManifest rejected valid signature: %v", err)
	}
}

func TestVerifyManifest_RejectsTamperedManifest(t *testing.T) {
	pub, priv, _ := minisign.GenerateKey(nil)
	manifestBytes := []byte(`{"version":"v0.8.0","counter":1}`)
	sig := minisign.Sign(priv, manifestBytes)
	tampered := []byte(`{"version":"v9.9.9","counter":1}`)

	pubStr := pub.String()
	if err := VerifyManifest(tampered, sig, pubStr); err == nil {
		t.Errorf("VerifyManifest accepted tampered manifest")
	}
}

func TestVerifyManifest_RejectsWrongKey(t *testing.T) {
	_, priv, _ := minisign.GenerateKey(nil)
	otherPub, _, _ := minisign.GenerateKey(nil)

	manifestBytes := []byte(`{"version":"v0.8.0","counter":1}`)
	sig := minisign.Sign(priv, manifestBytes)

	otherPubStr := otherPub.String()
	if err := VerifyManifest(manifestBytes, sig, otherPubStr); err == nil {
		t.Errorf("VerifyManifest accepted signature from wrong key")
	}
}

// freshManifest builds a Manifest with all freshness fields set to "now"
// values so individual tests can override exactly the field under test.
func freshManifest(version string, counter int64) *Manifest {
	return &Manifest{
		Version:             version,
		Counter:             counter,
		ReleasedAt:          time.Now(),
		NotAfter:            time.Now().Add(24 * time.Hour),
		MinSupportedVersion: version,
	}
}

func TestValidateManifest_RejectsStaleCounter(t *testing.T) {
	m := freshManifest("v0.8.0", 5)
	err := ValidateManifest(m, /*installedCounter*/ 5, /*installedVersion*/ "v0.8.0")
	if err == nil {
		t.Errorf("expected error for counter <= installed")
	}
}

func TestValidateManifest_RejectsExpired(t *testing.T) {
	m := freshManifest("v0.8.0", 6)
	m.NotAfter = time.Now().Add(-1 * time.Hour)
	err := ValidateManifest(m, 5, "v0.8.0")
	if err == nil {
		t.Errorf("expected error for expired manifest")
	}
}

func TestValidateManifest_RejectsBelowMinSupported(t *testing.T) {
	m := freshManifest("v0.9.0", 6)
	m.MinSupportedVersion = "v0.9.0"
	err := ValidateManifest(m, 5, /*installed*/ "v0.7.0")
	if err == nil {
		t.Errorf("expected error when installed < min_supported_version")
	}
}

func TestValidateManifest_AcceptsValid(t *testing.T) {
	m := freshManifest("v0.8.0", 6)
	m.MinSupportedVersion = "v0.7.0"
	if err := ValidateManifest(m, 5, "v0.7.0"); err != nil {
		t.Errorf("unexpected error: %v", err)
	}
}

func TestValidateManifest_AcceptsAnyCounterOnFirstInstall(t *testing.T) {
	m := freshManifest("v0.8.0", 1)
	m.MinSupportedVersion = "v0.7.0"
	if err := ValidateManifest(m, /*installed*/ 0, "v0.7.0"); err != nil {
		t.Errorf("first install should accept any counter, got: %v", err)
	}
}

func TestValidateManifest_RejectsMissingReleasedAt(t *testing.T) {
	m := freshManifest("v0.8.0", 6)
	m.ReleasedAt = time.Time{} // zero value
	err := ValidateManifest(m, 5, "v0.8.0")
	if err == nil {
		t.Errorf("expected error for missing released_at")
	}
}

func TestValidateManifest_RejectsStaleReleasedAt(t *testing.T) {
	m := freshManifest("v0.8.0", 6)
	m.ReleasedAt = time.Now().Add(-(releasedAtMaxAge + 1*time.Hour))
	err := ValidateManifest(m, /*installed*/ 0, "v0.8.0")
	if err == nil {
		t.Errorf("expected error for stale released_at on first-install replay")
	}
}

func TestValidateManifest_RejectsFutureReleasedAt(t *testing.T) {
	m := freshManifest("v0.8.0", 6)
	m.ReleasedAt = time.Now().Add(releasedAtFutureSlack + 1*time.Hour)
	err := ValidateManifest(m, 5, "v0.8.0")
	if err == nil {
		t.Errorf("expected error for far-future released_at")
	}
}

func TestValidateManifest_AcceptsReleasedAtWithinFutureSlack(t *testing.T) {
	m := freshManifest("v0.8.0", 6)
	// 1 hour in the future — within the 24h tolerance for clock skew.
	m.ReleasedAt = time.Now().Add(1 * time.Hour)
	if err := ValidateManifest(m, 5, "v0.8.0"); err != nil {
		t.Errorf("expected within-slack future released_at to validate, got: %v", err)
	}
}

func TestVerifyTarballSHA256_AcceptsMatch(t *testing.T) {
	data := []byte("hello world")
	// echo -n "hello world" | sha256sum
	sum := "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
	if err := VerifyTarballSHA256(data, sum); err != nil {
		t.Errorf("expected match, got: %v", err)
	}
}

func TestVerifyTarballSHA256_RejectsMismatch(t *testing.T) {
	data := []byte("hello world")
	wrong := "0000000000000000000000000000000000000000000000000000000000000000"
	if err := VerifyTarballSHA256(data, wrong); err == nil {
		t.Errorf("expected error for mismatched sha256")
	}
}

func TestVerifyTarballSHA256_AcceptsUppercaseExpected(t *testing.T) {
	data := []byte("hello world")
	sum := "B94D27B9934D3E08A52E52D7DA7DABFAC484EFE37A5380EE9088F7ACE2EFCDE9"
	if err := VerifyTarballSHA256(data, sum); err != nil {
		t.Errorf("expected uppercase to be normalized, got: %v", err)
	}
}

func TestManifest_NotesRoundTripsAndIsSigned(t *testing.T) {
	pub, priv, err := minisign.GenerateKey(nil)
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	m := freshManifest("v0.8.0", 1)
	m.Notes = "## v0.8.0\n\n### Features\n- Something new"

	manifestBytes, err := json.Marshal(m)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	// notes must be present in the serialized JSON that gets signed.
	if !strings.Contains(string(manifestBytes), `"notes":"## v0.8.0`) {
		t.Fatalf("serialized manifest missing notes field: %s", manifestBytes)
	}

	// Round-trips back into the struct.
	var back Manifest
	if err := json.Unmarshal(manifestBytes, &back); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if back.Notes != m.Notes {
		t.Errorf("notes round-trip mismatch: got %q want %q", back.Notes, m.Notes)
	}

	// The signature covers the bytes that include notes.
	sig := minisign.Sign(priv, manifestBytes)
	if err := VerifyManifest(manifestBytes, sig, pub.String()); err != nil {
		t.Errorf("VerifyManifest rejected a notes-bearing manifest: %v", err)
	}
}
