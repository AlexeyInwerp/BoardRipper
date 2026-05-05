package updater

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"aead.dev/minisign"
)

// helper: serve a manifest at /manifest.json and signature at /manifest.json.minisig
func newSignedManifestServer(t *testing.T, m *Manifest, priv minisign.PrivateKey) *httptest.Server {
	t.Helper()
	body, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	sig := minisign.Sign(priv, body)
	mux := http.NewServeMux()
	mux.HandleFunc("/manifest.json", func(w http.ResponseWriter, r *http.Request) {
		w.Write(body)
	})
	mux.HandleFunc("/manifest.json.minisig", func(w http.ResponseWriter, r *http.Request) {
		w.Write(sig)
	})
	return httptest.NewServer(mux)
}

func TestFetchFromSources_FirstValidWins(t *testing.T) {
	pub, priv, _ := minisign.GenerateKey(nil)
	pubStr := pub.String()

	good := newSignedManifestServer(t, &Manifest{
		Version: "v0.8.0", Counter: 5,
		NotAfter:            time.Now().Add(time.Hour),
		MinSupportedVersion: "v0.7.0",
	}, priv)
	defer good.Close()

	dead := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(503)
	}))
	defer dead.Close()

	got, err := FetchFromSources([]string{dead.URL, good.URL}, pubStr)
	if err != nil {
		t.Fatalf("expected success, got: %v", err)
	}
	if got.Version != "v0.8.0" {
		t.Errorf("got version %s, want v0.8.0", got.Version)
	}
}

func TestFetchFromSources_FallsThroughTamperedFirst(t *testing.T) {
	pub, priv, _ := minisign.GenerateKey(nil)
	pubStr := pub.String()

	bodyB := []byte(`{"version":"evil","counter":99}`)
	bodyA := []byte(`{"version":"v0.8.0","counter":5}`)
	sigA := minisign.Sign(priv, bodyA)
	tampered := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/manifest.json" {
			w.Write(bodyB)
		} else {
			w.Write(sigA)
		}
	}))
	defer tampered.Close()

	good := newSignedManifestServer(t, &Manifest{
		Version: "v0.8.0", Counter: 5,
		NotAfter:            time.Now().Add(time.Hour),
		MinSupportedVersion: "v0.7.0",
	}, priv)
	defer good.Close()

	got, err := FetchFromSources([]string{tampered.URL, good.URL}, pubStr)
	if err != nil {
		t.Fatalf("expected fallthrough success, got: %v", err)
	}
	if got.Version != "v0.8.0" {
		t.Errorf("got tampered manifest accepted: %s", got.Version)
	}
}

func TestFetchFromSources_AllFail(t *testing.T) {
	pub, _, _ := minisign.GenerateKey(nil)
	pubStr := pub.String()
	dead := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(404)
	}))
	defer dead.Close()
	_, err := FetchFromSources([]string{dead.URL, dead.URL}, pubStr)
	if err == nil {
		t.Errorf("expected error when all sources fail")
	}
}
