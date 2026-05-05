package updater

import (
	"testing"

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
