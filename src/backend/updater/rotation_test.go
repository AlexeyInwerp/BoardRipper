package updater

import (
	"testing"

	"aead.dev/minisign"
)

// The rotation these tests describe: the install trusts {old, new}; the
// release that carries the new-key image is signed with the OLD key, so it
// verifies, installs, and the resulting image trusts only the new key.

func TestVerifyManifestAny_AcceptsEitherTrustedKey(t *testing.T) {
	oldPub, oldPriv, _ := minisign.GenerateKey(nil)
	newPub, newPriv, _ := minisign.GenerateKey(nil)
	trusted := []string{oldPub.String(), newPub.String()}

	body := []byte(`{"version":"v0.36.0","counter":85}`)
	for name, priv := range map[string]minisign.PrivateKey{"old": oldPriv, "new": newPriv} {
		if err := VerifyManifestAny(body, minisign.Sign(priv, body), trusted); err != nil {
			t.Errorf("%s key rejected during overlap window: %v", name, err)
		}
	}
}

func TestVerifyManifestAny_RejectsUntrustedKey(t *testing.T) {
	trustedPub, _, _ := minisign.GenerateKey(nil)
	_, attackerPriv, _ := minisign.GenerateKey(nil)

	body := []byte(`{"version":"v9.9.9","counter":999}`)
	sig := minisign.Sign(attackerPriv, body)
	if err := VerifyManifestAny(body, sig, []string{trustedPub.String()}); err == nil {
		t.Error("accepted a signature from a key that is not compiled in")
	}
}

func TestVerifyManifestAny_RejectsTamperedBodyUnderTrustedKey(t *testing.T) {
	pub, priv, _ := minisign.GenerateKey(nil)
	body := []byte(`{"version":"v0.36.0","counter":85}`)
	sig := minisign.Sign(priv, body)

	tampered := []byte(`{"version":"v0.36.0","counter":9999}`)
	if err := VerifyManifestAny(tampered, sig, []string{pub.String()}); err == nil {
		t.Error("a trusted signer must not imply a trusted body")
	}
}

// Fail closed: no keys compiled in must never mean "accept anything".
func TestVerifyManifestAny_EmptyKeySetFailsClosed(t *testing.T) {
	_, priv, _ := minisign.GenerateKey(nil)
	body := []byte(`{"version":"v0.36.0"}`)
	if err := VerifyManifestAny(body, minisign.Sign(priv, body), nil); err == nil {
		t.Error("empty trusted-key set accepted a signature")
	}
}

func TestTrustedKeys(t *testing.T) {
	origKey, origKeys := PubKey, PubKeys
	t.Cleanup(func() { PubKey, PubKeys = origKey, origKeys })

	for _, tc := range []struct {
		name       string
		key, extra string
		want       int
	}{
		{"unset", "", "", 0},
		{"primary only", "A", "", 1},
		{"primary plus one", "A", "B", 2},
		{"blanks and spacing dropped", "A", " B , ,C ", 3},
		{"duplicates collapsed", "A", "A,B,B", 2},
		{"rotation extras with no primary", "", "B,C", 2},
	} {
		t.Run(tc.name, func(t *testing.T) {
			PubKey, PubKeys = tc.key, tc.extra
			if got := TrustedKeys(); len(got) != tc.want {
				t.Errorf("TrustedKeys() = %v, want %d entries", got, tc.want)
			}
		})
	}
}

func TestTrustedKeys_PrimaryComesFirst(t *testing.T) {
	origKey, origKeys := PubKey, PubKeys
	t.Cleanup(func() { PubKey, PubKeys = origKey, origKeys })

	PubKey, PubKeys = "primary", "extra1,extra2"
	if got := TrustedKeys(); got[0] != "primary" {
		t.Errorf("primary key must be tried first, got %v", got)
	}
}
