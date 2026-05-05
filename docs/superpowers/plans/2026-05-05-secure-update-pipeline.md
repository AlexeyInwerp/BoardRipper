# Secure Update Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the GitHub-token-gated self-update with a token-free, signature-verified pipeline (GHCR + ripperdoc.de mirrors, offline-signed manifest), and ship the bridge release `vN` that migrates existing installs.

**Architecture:** Updater walks a build-time-baked source list, fetches `manifest.json` + `manifest.json.minisig`, verifies Ed25519 signature against a compiled-in public key, then either pulls by content-addressed digest (GHCR) or downloads + sha256-verifies a tarball (FTP). Per-install secret + same-origin cookie auth on `/api/update/*`. Healthcheck-based rollback. New `release.sh` runs entirely from the maintainer's Mac.

**Tech Stack:** Go (stdlib + `aead.dev/minisign`), React + TypeScript (existing `update-store.ts`), bash (`release.sh`), Docker buildx multi-arch, lftp.

**Spec:** [docs/superpowers/specs/2026-05-05-secure-update-pipeline-design.md](../specs/2026-05-05-secure-update-pipeline-design.md)

---

## File map

**New files:**
- `src/backend/updater/manifest.go` — manifest types, signature verification, replay/expiry checks
- `src/backend/updater/manifest_test.go` — unit tests for the above
- `src/backend/updater/sources.go` — ordered source list walking
- `src/backend/updater/sources_test.go` — fallthrough behaviour tests
- `src/backend/updater/secret.go` — per-install secret generation + load
- `src/backend/updater/secret_test.go`
- `src/backend/handlers/health.go` — `/api/health` endpoint
- `src/backend/handlers/auth.go` — auth middleware + bootstrap cookie endpoint
- `src/backend/handlers/auth_test.go`
- `scripts/release.sh` — full release pipeline (rewrites existing file)
- `scripts/release/manifest.sh` — helper: generate + sign manifest
- `scripts/release/site-artifacts.sh` — helper: changelog/third_party HTML + landing version block
- `docs/RELEASE_RUNBOOK.md` — local setup + per-release procedure
- `.release-counter` — monotonic counter file (committed)

**Modified files:**
- `src/backend/updater/updater.go` — drop GH API path, drop `gitHubToken`, switch `Check()`/`Apply()` to manifest flow
- `src/backend/updater/docker.go` — pull-by-digest, orchestrator pin from manifest
- `src/backend/handlers/update.go` — wrap routes with auth middleware
- `src/backend/main.go` — register `/api/health`, `/api/update/bootstrap`, generate secret on startup
- `src/frontend/src/store/update-store.ts` — bootstrap cookie fetch, plumb `important`/`important_reason`/`notes_url`
- `src/frontend/src/components/UpdateBanner.tsx` (or wherever the banner lives — confirm at task start) — important variant
- `Dockerfile` — new `PUBKEY` + `SOURCES` ARGs, ldflags
- `docker-compose.yml` — drop `GITHUB_TOKEN` env var
- `src/backend/go.mod` — add `aead.dev/minisign`

---

## Phase A — Manifest types & signature verification

### Task A1: Manifest types + minisign dependency

**Files:**
- Create: `src/backend/updater/manifest.go`
- Modify: `src/backend/go.mod`, `src/backend/go.sum`

- [ ] **Step 1: Add minisign dependency**

```bash
cd src/backend && go get aead.dev/minisign@latest && go mod tidy
```

Expected: `go.mod` gets `aead.dev/minisign v0.x.y` line; `go.sum` populated.

- [ ] **Step 2: Create manifest.go with types only (no logic yet)**

```go
// Package updater — manifest types and signature/replay verification.
package updater

import "time"

// Manifest is the signed JSON document fetched from each mirror.
type Manifest struct {
	Version              string         `json:"version"`
	Counter              int64          `json:"counter"`
	ReleasedAt           time.Time      `json:"released_at"`
	NotAfter             time.Time      `json:"not_after"`
	Important            bool           `json:"important"`
	ImportantReason      string         `json:"important_reason,omitempty"`
	NotesURL             string         `json:"notes_url,omitempty"`
	Tarball              ManifestTarball `json:"tarball"`
	Image                ManifestImage  `json:"image"`
	MinSupportedVersion  string         `json:"min_supported_version"`
	OrchestratorImage    string         `json:"orchestrator_image_digest"`
	SourceListNext       []string       `json:"source_list_next,omitempty"`
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
```

- [ ] **Step 3: Verify it compiles**

Run: `cd src/backend && go build ./updater/`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/backend/go.mod src/backend/go.sum src/backend/updater/manifest.go
git commit -m "feat(updater): add Manifest types and minisign dep"
```

### Task A2: Signature verification (TDD)

**Files:**
- Modify: `src/backend/updater/manifest.go`
- Create: `src/backend/updater/manifest_test.go`

- [ ] **Step 1: Write failing test for VerifyManifest**

```go
// manifest_test.go
package updater

import (
	"encoding/base64"
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

	pubB64 := base64.StdEncoding.EncodeToString(pub.Bytes())
	if err := VerifyManifest(manifestBytes, sig, pubB64); err != nil {
		t.Errorf("VerifyManifest rejected valid signature: %v", err)
	}
}

func TestVerifyManifest_RejectsTamperedManifest(t *testing.T) {
	pub, priv, _ := minisign.GenerateKey(nil)
	manifestBytes := []byte(`{"version":"v0.8.0","counter":1}`)
	sig := minisign.Sign(priv, manifestBytes)
	tampered := []byte(`{"version":"v9.9.9","counter":1}`)

	pubB64 := base64.StdEncoding.EncodeToString(pub.Bytes())
	if err := VerifyManifest(tampered, sig, pubB64); err == nil {
		t.Errorf("VerifyManifest accepted tampered manifest")
	}
}

func TestVerifyManifest_RejectsWrongKey(t *testing.T) {
	_, priv, _ := minisign.GenerateKey(nil)
	otherPub, _, _ := minisign.GenerateKey(nil)

	manifestBytes := []byte(`{"version":"v0.8.0","counter":1}`)
	sig := minisign.Sign(priv, manifestBytes)

	otherPubB64 := base64.StdEncoding.EncodeToString(otherPub.Bytes())
	if err := VerifyManifest(manifestBytes, sig, otherPubB64); err == nil {
		t.Errorf("VerifyManifest accepted signature from wrong key")
	}
}
```

- [ ] **Step 2: Run test — expect FAIL with undefined symbol**

Run: `cd src/backend && go test ./updater/ -run VerifyManifest -v`
Expected: build error, `undefined: VerifyManifest`.

- [ ] **Step 3: Implement VerifyManifest in manifest.go**

```go
import (
	"encoding/base64"
	"errors"
	"fmt"

	"aead.dev/minisign"
)

// VerifyManifest checks that sig is a valid minisign signature of manifestBytes
// under pubKeyB64 (base64-encoded raw minisign public key).
func VerifyManifest(manifestBytes, sig []byte, pubKeyB64 string) error {
	keyBytes, err := base64.StdEncoding.DecodeString(pubKeyB64)
	if err != nil {
		return fmt.Errorf("decode pubkey: %w", err)
	}
	var pub minisign.PublicKey
	if err := pub.UnmarshalText(keyBytes); err != nil {
		// Try raw form as fallback
		if err2 := pub.UnmarshalBinary(keyBytes); err2 != nil {
			return fmt.Errorf("parse pubkey: %w / %w", err, err2)
		}
	}
	if !minisign.Verify(pub, manifestBytes, sig) {
		return errors.New("minisign verification failed")
	}
	return nil
}
```

*Note:* if `aead.dev/minisign`'s public-key API differs (the package has evolved), match its current API; the test is the spec.

- [ ] **Step 4: Run tests — expect PASS**

Run: `cd src/backend && go test ./updater/ -run VerifyManifest -v`
Expected: 3 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/backend/updater/manifest.go src/backend/updater/manifest_test.go
git commit -m "feat(updater): manifest signature verification (Ed25519/minisign)"
```

### Task A3: Counter + expiry + min-version validation

**Files:**
- Modify: `src/backend/updater/manifest.go`, `src/backend/updater/manifest_test.go`

- [ ] **Step 1: Write failing tests**

Append to `manifest_test.go`:

```go
import "time"

func TestValidateManifest_RejectsStaleCounter(t *testing.T) {
	m := &Manifest{
		Version: "v0.8.0", Counter: 5,
		NotAfter: time.Now().Add(24 * time.Hour),
		MinSupportedVersion: "v0.8.0",
	}
	err := ValidateManifest(m, /*installedCounter*/ 5, /*installedVersion*/ "v0.8.0")
	if err == nil {
		t.Errorf("expected error for counter <= installed")
	}
}

func TestValidateManifest_RejectsExpired(t *testing.T) {
	m := &Manifest{
		Version: "v0.8.0", Counter: 6,
		NotAfter: time.Now().Add(-1 * time.Hour),
		MinSupportedVersion: "v0.8.0",
	}
	err := ValidateManifest(m, 5, "v0.8.0")
	if err == nil {
		t.Errorf("expected error for expired manifest")
	}
}

func TestValidateManifest_RejectsBelowMinSupported(t *testing.T) {
	m := &Manifest{
		Version: "v0.9.0", Counter: 6,
		NotAfter: time.Now().Add(24 * time.Hour),
		MinSupportedVersion: "v0.9.0",
	}
	err := ValidateManifest(m, 5, /*installed*/ "v0.7.0")
	if err == nil {
		t.Errorf("expected error when installed < min_supported_version")
	}
}

func TestValidateManifest_AcceptsValid(t *testing.T) {
	m := &Manifest{
		Version: "v0.8.0", Counter: 6,
		NotAfter: time.Now().Add(24 * time.Hour),
		MinSupportedVersion: "v0.7.0",
	}
	if err := ValidateManifest(m, 5, "v0.7.0"); err != nil {
		t.Errorf("unexpected error: %v", err)
	}
}

func TestValidateManifest_AcceptsAnyCounterOnFirstInstall(t *testing.T) {
	m := &Manifest{
		Version: "v0.8.0", Counter: 1,
		NotAfter: time.Now().Add(24 * time.Hour),
		MinSupportedVersion: "v0.7.0",
	}
	if err := ValidateManifest(m, /*installed*/ 0, "v0.7.0"); err != nil {
		t.Errorf("first install should accept any counter, got: %v", err)
	}
}
```

- [ ] **Step 2: Run — expect FAIL (undefined ValidateManifest)**

Run: `cd src/backend && go test ./updater/ -run ValidateManifest -v`

- [ ] **Step 3: Implement ValidateManifest**

Append to `manifest.go`:

```go
// ValidateManifest checks counter monotonicity, expiry, and min_supported_version.
// installedCounter==0 means "first install" — counter check is skipped.
func ValidateManifest(m *Manifest, installedCounter int64, installedVersion string) error {
	if time.Now().After(m.NotAfter) {
		return fmt.Errorf("manifest expired: not_after=%s", m.NotAfter.Format(time.RFC3339))
	}
	if installedCounter > 0 && m.Counter <= installedCounter {
		return fmt.Errorf("manifest counter not greater than installed (got %d, have %d)", m.Counter, installedCounter)
	}
	if !versionGTE(installedVersion, m.MinSupportedVersion) {
		return fmt.Errorf("installed version %s below min_supported_version %s — manual update required", installedVersion, m.MinSupportedVersion)
	}
	return nil
}

// versionGTE returns true if a >= b. Reuses the existing parseVersion in updater.go.
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
```

- [ ] **Step 4: Run tests — expect PASS**

Run: `cd src/backend && go test ./updater/ -v`
Expected: all PASS including the new validation tests.

- [ ] **Step 5: Commit**

```bash
git add src/backend/updater/manifest.go src/backend/updater/manifest_test.go
git commit -m "feat(updater): manifest replay/expiry/min-version validation"
```

### Task A4: Tarball sha256 verification

**Files:**
- Modify: `src/backend/updater/manifest.go`, `src/backend/updater/manifest_test.go`

- [ ] **Step 1: Write failing test**

```go
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
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement**

```go
import (
	"crypto/sha256"
	"encoding/hex"
)

func VerifyTarballSHA256(data []byte, expectedHex string) error {
	h := sha256.Sum256(data)
	got := hex.EncodeToString(h[:])
	if got != expectedHex {
		return fmt.Errorf("sha256 mismatch: got %s, want %s", got, expectedHex)
	}
	return nil
}
```

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add -p src/backend/updater/
git commit -m "feat(updater): tarball sha256 verification"
```

---

## Phase B — Source list walking

### Task B1: Source list walker (TDD with httptest)

**Files:**
- Create: `src/backend/updater/sources.go`, `src/backend/updater/sources_test.go`

- [ ] **Step 1: Write failing test**

```go
// sources_test.go
package updater

import (
	"encoding/base64"
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
	if err != nil { t.Fatal(err) }
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
	pubB64 := base64.StdEncoding.EncodeToString(pub.Bytes())

	good := newSignedManifestServer(t, &Manifest{
		Version: "v0.8.0", Counter: 5,
		NotAfter: time.Now().Add(time.Hour),
		MinSupportedVersion: "v0.7.0",
	}, priv)
	defer good.Close()

	dead := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(503)
	}))
	defer dead.Close()

	got, err := FetchFromSources([]string{dead.URL, good.URL}, pubB64)
	if err != nil { t.Fatalf("expected success, got: %v", err) }
	if got.Version != "v0.8.0" { t.Errorf("got version %s, want v0.8.0", got.Version) }
}

func TestFetchFromSources_FallsThroughTamperedFirst(t *testing.T) {
	pub, priv, _ := minisign.GenerateKey(nil)
	pubB64 := base64.StdEncoding.EncodeToString(pub.Bytes())

	// tampered: sig is valid for body A, but body B is served
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
		NotAfter: time.Now().Add(time.Hour),
		MinSupportedVersion: "v0.7.0",
	}, priv)
	defer good.Close()

	got, err := FetchFromSources([]string{tampered.URL, good.URL}, pubB64)
	if err != nil { t.Fatalf("expected fallthrough success, got: %v", err) }
	if got.Version != "v0.8.0" { t.Errorf("got tampered manifest accepted: %s", got.Version) }
}

func TestFetchFromSources_AllFail(t *testing.T) {
	pub, _, _ := minisign.GenerateKey(nil)
	pubB64 := base64.StdEncoding.EncodeToString(pub.Bytes())
	dead := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(404)
	}))
	defer dead.Close()
	_, err := FetchFromSources([]string{dead.URL, dead.URL}, pubB64)
	if err == nil { t.Errorf("expected error when all sources fail") }
}
```

- [ ] **Step 2: Run — expect FAIL (undefined FetchFromSources)**

Run: `cd src/backend && go test ./updater/ -run FetchFromSources -v`

- [ ] **Step 3: Implement sources.go**

```go
package updater

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

const fetchTimeout = 30 * time.Second

// FetchFromSources walks sources in order; returns the first manifest whose
// signature verifies under pubKeyB64. Errors from individual sources are
// collected and returned only if all sources fail.
func FetchFromSources(sources []string, pubKeyB64 string) (*Manifest, error) {
	if len(sources) == 0 {
		return nil, errors.New("no sources configured")
	}
	client := &http.Client{Timeout: fetchTimeout}
	var errs []string
	for _, base := range sources {
		base = strings.TrimRight(base, "/")
		body, sig, err := fetchManifestPair(client, base)
		if err != nil {
			errs = append(errs, fmt.Sprintf("%s: %v", base, err))
			continue
		}
		if err := VerifyManifest(body, sig, pubKeyB64); err != nil {
			errs = append(errs, fmt.Sprintf("%s: signature: %v", base, err))
			continue
		}
		var m Manifest
		if err := json.Unmarshal(body, &m); err != nil {
			errs = append(errs, fmt.Sprintf("%s: parse: %v", base, err))
			continue
		}
		return &m, nil
	}
	return nil, fmt.Errorf("all sources failed: %s", strings.Join(errs, "; "))
}

func fetchManifestPair(c *http.Client, base string) (body, sig []byte, err error) {
	body, err = httpGet(c, base+"/manifest.json")
	if err != nil { return nil, nil, fmt.Errorf("manifest: %w", err) }
	sig, err = httpGet(c, base+"/manifest.json.minisig")
	if err != nil { return nil, nil, fmt.Errorf("signature: %w", err) }
	return body, sig, nil
}

func httpGet(c *http.Client, url string) ([]byte, error) {
	resp, err := c.Get(url)
	if err != nil { return nil, err }
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return io.ReadAll(io.LimitReader(resp.Body, 1<<20)) // 1 MiB cap on manifest
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `cd src/backend && go test ./updater/ -v`

- [ ] **Step 5: Commit**

```bash
git add src/backend/updater/sources.go src/backend/updater/sources_test.go
git commit -m "feat(updater): source list walker with first-valid-wins"
```

---

## Phase C — Build args & ldflags

### Task C1: Dockerfile build args

**Files:**
- Modify: `Dockerfile`

- [ ] **Step 1: Read current Dockerfile**

Run: `cat /Users/besitzer/Desktop/Boardviewer/Dockerfile`

- [ ] **Step 2: Add ARGs and extend ldflags**

Locate the Go build stage (look for `go build` and `-ldflags`). Modify so the build args are:

```dockerfile
ARG APP_VERSION=dev
ARG PUBKEY=""
ARG SOURCES="https://ghcr.io/alexeyinwerp/boardripper,https://ripperdoc.de/boardripper"

RUN go build -trimpath -ldflags="\
    -s -w \
    -X boardripper/updater.Version=${APP_VERSION} \
    -X boardripper/updater.PubKey=${PUBKEY} \
    -X boardripper/updater.SourceList=${SOURCES}" \
    -o /server ./
```

- [ ] **Step 3: Verify a local build still works (without keys, should still produce a binary)**

```bash
cd /Users/besitzer/Desktop/Boardviewer && \
docker build -t boardripper-test:local . 2>&1 | tail -20
```

Expected: build succeeds. `PUBKEY` empty for now (keys come later).

- [ ] **Step 4: Commit**

```bash
git add Dockerfile
git commit -m "build(docker): add PUBKEY + SOURCES build args, extend ldflags"
```

### Task C2: Wire build-time variables in updater.go

**Files:**
- Modify: `src/backend/updater/updater.go`

- [ ] **Step 1: Replace hardcoded RepoOwner/RepoName with new build vars**

Replace lines 19-24 (Build-time variables block):

```go
// Build-time variables injected via -ldflags.
var (
	Version    = "dev"
	PubKey     = "" // base64-encoded minisign public key
	SourceList = "" // comma-separated mirror base URLs
)

// Sources returns the parsed source list.
func Sources() []string {
	if SourceList == "" {
		return nil
	}
	parts := []string{}
	for _, s := range splitCSV(SourceList) {
		s = strings.TrimSpace(s)
		if s != "" { parts = append(parts, s) }
	}
	return parts
}

func splitCSV(s string) []string {
	out := []string{}
	cur := ""
	for _, r := range s {
		if r == ',' {
			out = append(out, cur)
			cur = ""
		} else {
			cur += string(r)
		}
	}
	if cur != "" { out = append(out, cur) }
	return out
}
```

Delete the `gitHubToken()` function (lines 26-29).

- [ ] **Step 2: Compile-check**

```bash
cd src/backend && go build ./updater/
```

Will fail because `gitHubToken` and `RepoOwner`/`RepoName` are still referenced inside `updater.go`. That's fine — Phase D rewrites those callers.

For now, comment out or `// TODO`-tag the broken functions to keep the package buildable. Specifically `fetchLatestRelease` and any reference to `RepoOwner`/`RepoName`/`gitHubToken` — replace their bodies with `panic("phase D")` placeholders.

- [ ] **Step 3: Commit (broken intermediate state, OK because rewrite continues in Phase D)**

```bash
git add src/backend/updater/updater.go
git commit -m "refactor(updater): replace GH constants with PubKey + SourceList ldflags"
```

---

## Phase D — Updater rewrite

### Task D1: Counter persistence

**Files:**
- Modify: `src/backend/updater/updater.go`

- [ ] **Step 1: Add helpers for reading/writing the installed-counter file**

Append to `updater.go`:

```go
import "strconv"

func (u *Updater) installedCounterPath() string {
	return filepath.Join(u.dataDir, ".update-counter")
}

func (u *Updater) readInstalledCounter() int64 {
	b, err := os.ReadFile(u.installedCounterPath())
	if err != nil { return 0 }
	n, _ := strconv.ParseInt(strings.TrimSpace(string(b)), 10, 64)
	return n
}

func (u *Updater) writeInstalledCounter(n int64) error {
	return os.WriteFile(u.installedCounterPath(), []byte(strconv.FormatInt(n, 10)), 0o644)
}
```

- [ ] **Step 2: Compile-check**

```bash
cd src/backend && go build ./updater/
```

- [ ] **Step 3: Commit**

```bash
git add src/backend/updater/updater.go
git commit -m "feat(updater): persist installed manifest counter to data dir"
```

### Task D2: Rewrite Check() to use signed manifest

**Files:**
- Modify: `src/backend/updater/updater.go`

- [ ] **Step 1: Replace Check() body**

Locate `func (u *Updater) Check()` (line ~123). Replace its body:

```go
func (u *Updater) Check() (*UpdateState, error) {
	if PubKey == "" {
		u.mu.Lock()
		u.state.Error = "updater not configured: PubKey is empty (built without -ldflags)"
		u.mu.Unlock()
		return &u.state, errors.New(u.state.Error)
	}
	srcs := Sources()
	if len(srcs) == 0 {
		u.mu.Lock()
		u.state.Error = "updater not configured: SourceList is empty"
		u.mu.Unlock()
		return &u.state, errors.New(u.state.Error)
	}
	m, err := FetchFromSources(srcs, PubKey)
	now := time.Now()
	u.mu.Lock()
	defer u.mu.Unlock()
	u.state.CheckedAt = &now
	if err != nil {
		u.state.Error = err.Error()
		u.state.HasUpdate = false
		return &u.state, err
	}
	if err := ValidateManifest(m, u.readInstalledCounter(), Version); err != nil {
		u.state.Error = err.Error()
		u.state.HasUpdate = false
		return &u.state, err
	}
	u.state.Error = ""
	u.state.LatestVersion = m.Version
	u.state.HasUpdate = m.Counter > u.readInstalledCounter() && m.Version != Version
	u.state.Manifest = m
	return &u.state, nil
}
```

- [ ] **Step 2: Add `Manifest *Manifest` field to UpdateState** (replace `ReleaseInfo *ReleaseInfo`)

```go
type UpdateState struct {
	CurrentVersion string     `json:"current_version"`
	LatestVersion  string     `json:"latest_version,omitempty"`
	HasUpdate      bool       `json:"has_update"`
	CheckedAt      *time.Time `json:"checked_at,omitempty"`
	Manifest       *Manifest  `json:"manifest,omitempty"`
	Error          string     `json:"error,omitempty"`
	DockerAvail    bool       `json:"docker_available"`
}
```

Delete the `ReleaseInfo` struct (lines 32-44) — no longer used.

- [ ] **Step 3: Delete the now-orphan fetchLatestRelease and downloadAsset GH-API helpers**

Delete `func fetchLatestRelease()` and the parts of `downloadAsset` that used the GH token (the URL becomes a plain HTTPS URL from the manifest, no auth header).

Keep `downloadAsset(url, dest string) error` but simplify to plain GET, no token header.

- [ ] **Step 4: Compile**

```bash
cd src/backend && go build ./...
```

Expected: passes. Some handler code may reference `state.ReleaseInfo` — fix those references to use `state.Manifest` instead. (The frontend will be updated in Phase G.)

- [ ] **Step 5: Commit**

```bash
git add src/backend/updater/updater.go src/backend/handlers/update.go
git commit -m "feat(updater): Check() uses signed manifest from source list"
```

### Task D3: Rewrite Apply() — pull-by-digest path

**Files:**
- Modify: `src/backend/updater/updater.go`, `src/backend/updater/docker.go`

- [ ] **Step 1: Add a `dockerPullByDigest` helper in docker.go**

```go
// dockerPullByDigest pulls registry@digest via the Docker socket. It only
// succeeds if the daemon can reach the registry and the digest matches.
func (u *Updater) dockerPullByDigest(registry, digest string) error {
	ref := registry + "@" + digest
	u.logProgress("Pulling "+ref, "info")
	body, err := dockerSockPOST(fmt.Sprintf("/images/create?fromImage=%s&tag=%s", registry, digest), nil)
	if err != nil { return fmt.Errorf("pull: %w", err) }
	if err := drainPullProgress(body, u); err != nil {
		return fmt.Errorf("pull stream: %w", err)
	}
	return nil
}
```

(Existing `dockerSockPOST` and stream draining helpers should already be in `docker.go`; reuse them. If not, lift them from the current `dockerLoad` flow — they're standard Docker Engine API JSON-stream consumers.)

- [ ] **Step 2: Rewrite Apply() to choose pull-by-digest first, tarball fallback second**

Replace the body of `func (u *Updater) Apply()`:

```go
func (u *Updater) Apply() error {
	u.mu.Lock()
	if u.updating { u.mu.Unlock(); return errors.New("update already in progress") }
	u.updating = true
	u.progress = nil
	m := u.state.Manifest
	u.mu.Unlock()
	defer func() { u.mu.Lock(); u.updating = false; u.mu.Unlock() }()

	if m == nil {
		return errors.New("no manifest available — call Check() first")
	}
	if !isDockerAvailable() {
		return errors.New("Docker socket not available")
	}

	// 1. Try pull-by-digest from registry; fall back to tarball.
	pulledOK := false
	if m.Image.Registry != "" && m.Image.Digest != "" {
		if err := u.dockerPullByDigest(m.Image.Registry, m.Image.Digest); err != nil {
			u.logProgress("Registry pull failed, falling back to tarball: "+err.Error(), "info")
		} else {
			pulledOK = true
		}
	}
	if !pulledOK {
		if err := u.applyTarball(m); err != nil {
			return fmt.Errorf("tarball apply: %w", err)
		}
	}

	// 2. Persist the new counter BEFORE restarting (so rollback still gets correct state).
	if err := u.writeInstalledCounter(m.Counter); err != nil {
		u.logProgress("warn: counter persist: "+err.Error(), "info")
	}

	// 3. Tag the previous image for rollback (best-effort).
	_ = u.tagPrevious()

	// 4. Restart via orchestrator (uses m.OrchestratorImage as the digest-pinned alpine).
	return u.orchestrateRestart(m)
}

func (u *Updater) applyTarball(m *Manifest) error {
	dest := filepath.Join(u.dataDir, "boardripper-"+m.Version+".tar.gz")
	if err := downloadAsset(m.Tarball.URLPrimary, dest); err != nil {
		return fmt.Errorf("download: %w", err)
	}
	body, err := os.ReadFile(dest)
	if err != nil { return err }
	if err := VerifyTarballSHA256(body, m.Tarball.SHA256); err != nil {
		return err
	}
	if err := u.dockerLoad(dest); err != nil {
		return fmt.Errorf("docker load: %w", err)
	}
	return nil
}
```

- [ ] **Step 3: Stub `tagPrevious()` (real impl in Phase E)**

```go
func (u *Updater) tagPrevious() error {
	// Phase E will tag the running image as boardripper:previous before swap.
	return nil
}
```

- [ ] **Step 4: Update `orchestrateRestart` signature**

Modify [docker.go:258](src/backend/updater/docker.go#L258) to accept `*Manifest` and use `m.OrchestratorImage` instead of hardcoded `alpine:latest`. Search for `alpine:latest` in `docker.go` and replace with the manifest's `OrchestratorImage`.

- [ ] **Step 5: Compile**

```bash
cd src/backend && go build ./...
```

- [ ] **Step 6: Commit**

```bash
git add src/backend/updater/
git commit -m "feat(updater): Apply() uses pull-by-digest with tarball fallback + counter persist"
```

### Task D4: Drop GITHUB_TOKEN from compose

**Files:**
- Modify: `docker-compose.yml`

- [ ] **Step 1: Remove the GITHUB_TOKEN env var**

In [docker-compose.yml:43](docker-compose.yml#L43), delete the `GITHUB_TOKEN=${GITHUB_TOKEN:-}` line. Add a comment near `environment:`:

```yaml
    environment:
      - PORT=8080
      # GITHUB_TOKEN is no longer needed — updates use offline-signed manifests
      # from ripperdoc.de and ghcr.io (see docs/RELEASE_RUNBOOK.md).
```

- [ ] **Step 2: Validate compose**

```bash
docker compose -f /Users/besitzer/Desktop/Boardviewer/docker-compose.yml config 2>&1 | head -30
```

Expected: clean output, no errors.

- [ ] **Step 3: Commit**

```bash
git add docker-compose.yml
git commit -m "chore(compose): drop GITHUB_TOKEN env var"
```

---

## Phase E — Health endpoint & rollback

### Task E1: /api/health endpoint

**Files:**
- Create: `src/backend/handlers/health.go`
- Modify: `src/backend/main.go`

- [ ] **Step 1: Write health.go**

```go
package handlers

import (
	"encoding/json"
	"net/http"
)

// HealthHandler returns 200 once the server has finished startup.
type HealthHandler struct {
	ready func() bool
}

func NewHealthHandler(ready func() bool) *HealthHandler {
	return &HealthHandler{ready: ready}
}

func (h *HealthHandler) Serve(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if h.ready != nil && !h.ready() {
		w.WriteHeader(503)
		json.NewEncoder(w).Encode(map[string]any{"status": "starting"})
		return
	}
	w.WriteHeader(200)
	json.NewEncoder(w).Encode(map[string]any{"status": "ok"})
}
```

- [ ] **Step 2: Register in main.go**

After databank/static-dir setup, before `mux.HandleFunc` lines:

```go
ready := func() bool {
	// Returns true once databank is open and static dir is mountable.
	// Wire to the actual readiness signals already present in main.go.
	return true
}
healthHandler := handlers.NewHealthHandler(ready)
mux.HandleFunc("GET /api/health", healthHandler.Serve)
```

- [ ] **Step 3: Smoke-test by curl after rebuild**

```bash
docker build -t boardripper-test:local /Users/besitzer/Desktop/Boardviewer && \
docker run --rm -d --name br-h -p 18083:8080 boardripper-test:local && sleep 2 && \
curl -sS -w "\n%{http_code}\n" http://localhost:18083/api/health ; \
docker rm -f br-h
```

Expected: `{"status":"ok"}\n200`.

- [ ] **Step 4: Commit**

```bash
git add src/backend/handlers/health.go src/backend/main.go
git commit -m "feat(backend): /api/health endpoint for rollback healthcheck"
```

### Task E2: tagPrevious + rollback on healthcheck fail

**Files:**
- Modify: `src/backend/updater/docker.go`, `src/backend/updater/updater.go`

- [ ] **Step 1: Implement tagPrevious**

In `docker.go`, add:

```go
// tagPrevious tags the currently-running image as boardripper:previous so a
// failed update can be reverted. Best-effort — errors are logged but not fatal.
func (u *Updater) tagPrevious() error {
	curImage, err := u.findSelfImage()
	if err != nil { return err }
	// POST /images/{name}/tag?repo=boardripper&tag=previous
	url := fmt.Sprintf("/images/%s/tag?repo=boardripper&tag=previous", curImage)
	_, err = dockerSockPOST(url, nil)
	return err
}
```

(Implement `findSelfImage()` to read the current container's image via `/containers/{hostname}/json` if it doesn't already exist.)

- [ ] **Step 2: Add health-poll-and-rollback to orchestrateRestart**

Inside the embedded shell script that `orchestrateRestart` runs (search `docker.go` for the heredoc-style script):

After starting the new container, add a health-poll block:

```sh
# Wait up to 60s for /api/health to return 200 from the new container
i=0
while [ $i -lt 30 ]; do
    if wget -q -O - --timeout=2 http://NEW_CONTAINER_IP:8080/api/health 2>/dev/null | grep -q '"status":"ok"'; then
        echo "rollback: health OK"
        # Cleanup: remove the -old container, we're good
        docker rm boardripper-old 2>/dev/null || true
        exit 0
    fi
    sleep 2
    i=$((i + 1))
done
echo "rollback: health check failed, restarting previous"
docker stop boardripper-new
docker rm boardripper-new
docker rename boardripper-old boardripper
docker start boardripper
exit 1
```

Adjust the exact container names to match the existing script's naming. The orchestrator container already mounts `docker.sock`, so it can do all of this.

- [ ] **Step 3: Wire `tagPrevious()` into Apply() before pull**

In `updater.go`, in `Apply()` before the pull step:

```go
if err := u.tagPrevious(); err != nil {
    u.logProgress("warn: tagPrevious failed: "+err.Error()+" (rollback unavailable)", "info")
}
```

(Move from the post-pull location it currently sits in — needs to happen *before* the new image lands so we still have a reference to the old one.)

- [ ] **Step 4: Compile + commit**

```bash
cd src/backend && go build ./...
git add src/backend/updater/
git commit -m "feat(updater): tag previous image + healthcheck-based rollback"
```

---

## Phase F — Per-install secret + auth

### Task F1: Secret generation on first boot

**Files:**
- Create: `src/backend/updater/secret.go`, `src/backend/updater/secret_test.go`

- [ ] **Step 1: Write failing test**

```go
// secret_test.go
package updater

import (
	"os"
	"path/filepath"
	"testing"
)

func TestEnsureSecret_GeneratesIfMissing(t *testing.T) {
	dir := t.TempDir()
	secret, err := EnsureSecret(dir)
	if err != nil { t.Fatalf("EnsureSecret: %v", err) }
	if len(secret) < 32 { t.Errorf("secret too short: %d chars", len(secret)) }
	if _, err := os.Stat(filepath.Join(dir, ".update-secret")); err != nil {
		t.Errorf("secret file not written: %v", err)
	}
}

func TestEnsureSecret_StableAcrossCalls(t *testing.T) {
	dir := t.TempDir()
	a, _ := EnsureSecret(dir)
	b, _ := EnsureSecret(dir)
	if a != b { t.Errorf("secret regenerated unexpectedly") }
}

func TestEnsureSecret_FilePermissions(t *testing.T) {
	dir := t.TempDir()
	_, err := EnsureSecret(dir)
	if err != nil { t.Fatal(err) }
	info, _ := os.Stat(filepath.Join(dir, ".update-secret"))
	if mode := info.Mode().Perm(); mode != 0o600 {
		t.Errorf("expected mode 0600, got %o", mode)
	}
}
```

- [ ] **Step 2: Run — expect FAIL (undefined EnsureSecret)**

- [ ] **Step 3: Implement secret.go**

```go
package updater

import (
	"crypto/rand"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
)

const secretFilename = ".update-secret"

// EnsureSecret returns the install's secret, generating + persisting one if
// none exists. File mode is 0600.
func EnsureSecret(dataDir string) (string, error) {
	p := filepath.Join(dataDir, secretFilename)
	b, err := os.ReadFile(p)
	if err == nil {
		s := strings.TrimSpace(string(b))
		if len(s) >= 32 { return s, nil }
		// fall through to regenerate
	}
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil { return "", err }
	hexS := hex.EncodeToString(buf)
	if err := os.WriteFile(p, []byte(hexS), 0o600); err != nil { return "", err }
	return hexS, nil
}
```

- [ ] **Step 4: Run — expect PASS**

```bash
cd src/backend && go test ./updater/ -run EnsureSecret -v
```

- [ ] **Step 5: Commit**

```bash
git add src/backend/updater/secret.go src/backend/updater/secret_test.go
git commit -m "feat(updater): per-install secret generated on first boot"
```

### Task F2: Auth middleware + bootstrap cookie endpoint

**Files:**
- Create: `src/backend/handlers/auth.go`, `src/backend/handlers/auth_test.go`
- Modify: `src/backend/handlers/update.go`, `src/backend/main.go`

- [ ] **Step 1: Write failing test for middleware**

```go
// auth_test.go
package handlers

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestAuthMiddleware_Rejects401WithoutCredentials(t *testing.T) {
	h := WithUpdateAuth("topsecret", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
	}))
	r := httptest.NewRequest("POST", "/api/update/apply", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 401 { t.Errorf("got %d, want 401", w.Code) }
}

func TestAuthMiddleware_AcceptsHeader(t *testing.T) {
	h := WithUpdateAuth("topsecret", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
	}))
	r := httptest.NewRequest("POST", "/api/update/apply", nil)
	r.Header.Set("X-BoardRipper-Update-Token", "topsecret")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 200 { t.Errorf("got %d, want 200", w.Code) }
}

func TestAuthMiddleware_AcceptsCookie(t *testing.T) {
	h := WithUpdateAuth("topsecret", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
	}))
	r := httptest.NewRequest("POST", "/api/update/apply", nil)
	r.AddCookie(&http.Cookie{Name: "br_update_token", Value: "topsecret"})
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 200 { t.Errorf("got %d, want 200", w.Code) }
}

func TestBootstrapHandler_SetsCookie(t *testing.T) {
	h := NewBootstrapHandler("topsecret")
	r := httptest.NewRequest("GET", "/api/update/bootstrap", nil)
	w := httptest.NewRecorder()
	h.Serve(w, r)
	if w.Code != 204 { t.Errorf("got %d, want 204", w.Code) }
	cookies := w.Result().Cookies()
	found := false
	for _, c := range cookies {
		if c.Name == "br_update_token" && c.Value == "topsecret" && c.HttpOnly && c.SameSite == http.SameSiteStrictMode {
			found = true
		}
	}
	if !found { t.Errorf("bootstrap did not set HttpOnly+SameSite=Strict cookie") }
}
```

- [ ] **Step 2: Run — expect FAIL**

```bash
cd src/backend && go test ./handlers/ -run "Auth|Bootstrap" -v
```

- [ ] **Step 3: Implement auth.go**

```go
package handlers

import (
	"net/http"
)

const updateCookieName = "br_update_token"

// WithUpdateAuth wraps next with auth: passes if either the
// X-BoardRipper-Update-Token header or the br_update_token cookie matches.
func WithUpdateAuth(secret string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-BoardRipper-Update-Token") == secret {
			next.ServeHTTP(w, r); return
		}
		if c, err := r.Cookie(updateCookieName); err == nil && c.Value == secret {
			next.ServeHTTP(w, r); return
		}
		w.WriteHeader(401)
	})
}

// BootstrapHandler sets the br_update_token cookie. Frontend calls this once
// on first UI load; subsequent /api/update/* calls accept the cookie.
type BootstrapHandler struct { secret string }

func NewBootstrapHandler(secret string) *BootstrapHandler { return &BootstrapHandler{secret} }

func (h *BootstrapHandler) Serve(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{
		Name: updateCookieName, Value: h.secret,
		Path: "/api/update/", HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
	})
	w.WriteHeader(204)
}
```

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Wire in main.go**

After loading the secret, wrap the existing `/api/update/*` routes:

```go
secret, err := updater.EnsureSecret(dataDir)
if err != nil { log.Fatal("update secret:", err) }
log.Printf("update auth: per-install secret loaded from %s", filepath.Join(dataDir, ".update-secret"))

bootstrap := handlers.NewBootstrapHandler(secret)
mux.HandleFunc("GET /api/update/bootstrap", bootstrap.Serve)

// Wrap each update route with auth.
mux.Handle("GET /api/update/status", handlers.WithUpdateAuth(secret, http.HandlerFunc(read(updateHandler.Status))))
mux.Handle("POST /api/update/check",  handlers.WithUpdateAuth(secret, http.HandlerFunc(updateHandler.Check)))
mux.Handle("POST /api/update/apply",  handlers.WithUpdateAuth(secret, http.HandlerFunc(updateHandler.Apply)))
mux.Handle("GET /api/update/progress", handlers.WithUpdateAuth(secret, http.HandlerFunc(read(updateHandler.Progress))))
```

(Adjust the `mux.HandleFunc` signatures already present at [main.go:152-155](src/backend/main.go#L152) — they currently use `mux.HandleFunc`; switch to `mux.Handle` for the wrapped versions.)

- [ ] **Step 6: Smoke-test rebuild**

```bash
cd /Users/besitzer/Desktop/Boardviewer && docker build -t br-auth:test . && \
docker run --rm -d --name br-a -p 18084:8080 br-auth:test && sleep 2 && \
echo "--- without auth ---" && curl -sS -o /dev/null -w "%{http_code}\n" -X POST http://localhost:18084/api/update/check && \
echo "--- bootstrap ---" && curl -sS -c /tmp/br-cookie.txt -o /dev/null -w "%{http_code}\n" http://localhost:18084/api/update/bootstrap && \
echo "--- with cookie ---" && curl -sS -b /tmp/br-cookie.txt -o /dev/null -w "%{http_code}\n" -X POST http://localhost:18084/api/update/check ; \
docker rm -f br-a
```

Expected: `401`, `204`, then either `200` or `502` (502 if PUBKEY is empty — that's fine, we're testing auth not update flow).

- [ ] **Step 7: Commit**

```bash
git add src/backend/handlers/auth.go src/backend/handlers/auth_test.go src/backend/handlers/update.go src/backend/main.go
git commit -m "feat(api): per-install token + cookie bootstrap on /api/update/*"
```

---

## Phase G — Frontend

### Task G1: Bootstrap fetch + new manifest fields in store

**Files:**
- Modify: `src/frontend/src/store/update-store.ts`

- [ ] **Step 1: Locate the update store and read it**

Run: `cat /Users/besitzer/Desktop/Boardviewer/src/frontend/src/store/update-store.ts | head -80`

Note where `fetch('/api/update/...')` calls happen.

- [ ] **Step 2: Add a one-shot bootstrap call before any update API call**

Near the top of the file, add:

```typescript
let bootstrapped = false;
async function ensureBootstrap() {
  if (bootstrapped) return;
  try {
    await fetch('/api/update/bootstrap', { credentials: 'same-origin' });
    bootstrapped = true;
  } catch {
    // Will be retried on next call.
  }
}
```

Wrap each `/api/update/*` fetch:

```typescript
async function apiFetch(input: RequestInfo, init?: RequestInit) {
  await ensureBootstrap();
  return fetch(input, { ...init, credentials: 'same-origin' });
}
```

Replace all `fetch('/api/update/...')` calls in this file with `apiFetch(...)`.

- [ ] **Step 3: Replace `releaseInfo` field with `manifest` in the store's state shape**

Find the type `UpdateState` (or similar) and replace the `releaseInfo: ReleaseInfo | null` field with `manifest: Manifest | null`. Define the TS Manifest type matching the Go struct from Task A1.

```typescript
export interface Manifest {
  version: string;
  counter: number;
  released_at: string;
  not_after: string;
  important: boolean;
  important_reason?: string;
  notes_url?: string;
  tarball: { url_primary: string; sha256: string; size_bytes: number };
  image: { registry: string; tag: string; digest: string };
}
```

- [ ] **Step 4: Re-run typecheck**

```bash
cd /Users/besitzer/Desktop/Boardviewer/src/frontend && npm run typecheck 2>&1 | tail -20
```

Expected: no errors. Fix any consumers of `releaseInfo` to use `manifest`.

- [ ] **Step 5: Commit**

```bash
git add src/frontend/src/store/update-store.ts $(grep -lr releaseInfo src/frontend/src/ 2>/dev/null)
git commit -m "feat(ui): bootstrap fetch + Manifest type in update store"
```

### Task G2: UpdateBanner — important variant

**Files:**
- Modify: existing UpdateBanner component (locate via grep)

- [ ] **Step 1: Locate the banner**

```bash
grep -rln "UpdateBanner\|update.*available\|hasUpdate" /Users/besitzer/Desktop/Boardviewer/src/frontend/src/components/ 2>&1 | head
```

Read whatever file holds the JSX for the existing update notification.

- [ ] **Step 2: Add important-variant styling**

In the banner's render function, branch on `manifest?.important`:

```tsx
const variant = manifest?.important ? 'important' : 'normal';
const variantClass = variant === 'important'
  ? 'bg-red-600 text-white'
  : 'bg-blue-600 text-white';

return (
  <div className={`update-banner ${variantClass}`}>
    {variant === 'important' && <span className="font-bold">⚠ Important update</span>}
    {variant !== 'important' && <span>Update available</span>}
    {manifest?.version && <span>: {manifest.version}</span>}
    {manifest?.important_reason && <span className="ml-2 text-sm">— {manifest.important_reason}</span>}
    {manifest?.notes_url && (
      <a href={manifest.notes_url} target="_blank" rel="noreferrer" className="ml-2 underline">
        Release notes
      </a>
    )}
    <button onClick={onApply} className="ml-2 px-2 py-1 bg-white text-black rounded">Update now</button>
  </div>
);
```

(Use whichever class system the project uses — check existing banner code; this example is Tailwind-style.)

- [ ] **Step 3: Visual smoke test**

```bash
cd src/frontend && npm run dev
```

Open browser, manually inject `manifest = { important: true, important_reason: "test", version: "v0.9.0" }` into the store (or just hardcode `important = true` temporarily). Confirm red variant renders.

Then revert the temporary hardcode.

- [ ] **Step 4: Commit**

```bash
git add src/frontend/src/components/...
git commit -m "feat(ui): UpdateBanner gains important variant + release-notes link"
```

---

## Phase H — Build & runtime config

### Task H1: Drop GITHUB_TOKEN references in CLAUDE.md and docs

**Files:**
- Modify: `README.md` (any GITHUB_TOKEN references), `CLAUDE.md` if applicable

- [ ] **Step 1: Search for stale references**

```bash
grep -rn "GITHUB_TOKEN" /Users/besitzer/Desktop/Boardviewer/ --include="*.md" --include="*.yml" --include="*.go" --include="*.sh" 2>&1 | grep -v "node_modules\|/data/" | head -30
```

- [ ] **Step 2: For each match in `.md` files, rewrite the surrounding paragraph** to drop the `GITHUB_TOKEN` requirement and direct readers to `docs/RELEASE_RUNBOOK.md` for maintainer-side flow.

For matches in `.go` files, those should already be gone after Phase D — confirm.

For matches in `.sh` files (`NASdeploy.sh`, `deploy-remote.sh`), leave as-is for now. Phase J cleanup handles those.

- [ ] **Step 3: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: drop GITHUB_TOKEN requirement from end-user docs"
```

---

## Phase I — Release script

### Task I1: scripts/release.sh skeleton + preflight

**Files:**
- Modify: `scripts/release.sh` (REWRITE — the existing file becomes obsolete; do `git mv scripts/release.sh scripts/release.legacy.sh` first if you want to keep history visible, otherwise just overwrite).

- [ ] **Step 1: Stash old release.sh and create new skeleton**

```bash
cd /Users/besitzer/Desktop/Boardviewer && git mv scripts/release.sh scripts/release.legacy.sh
```

Create new `scripts/release.sh`:

```bash
#!/usr/bin/env bash
# BoardRipper release pipeline. Runs entirely on the maintainer's Mac.
# Usage: ./scripts/release.sh v0.8.0 [--important "reason"]
set -euo pipefail

VERSION="${1:-}"
IMPORTANT_FLAG="false"
IMPORTANT_REASON=""
shift || true
while [ $# -gt 0 ]; do
  case "$1" in
    --important) IMPORTANT_FLAG="true"; IMPORTANT_REASON="${2:-}"; shift 2;;
    *) echo "unknown flag: $1" >&2; exit 1;;
  esac
done

if [ -z "$VERSION" ]; then
  echo "usage: $0 v0.X.Y [--important \"reason\"]" >&2
  exit 1
fi
if [[ ! "$VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(\.[a-z0-9.-]+)?$ ]]; then
  echo "version must look like v0.8.0 or v0.8.0.beta1" >&2
  exit 1
fi

# --- Configuration ---
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_DIR="${BOARDRIPPER_RELEASE_CONFIG:-$HOME/.config/boardripper}"
RELEASE_ENV="$CONFIG_DIR/release.env"

if [ ! -f "$RELEASE_ENV" ]; then
  echo "missing $RELEASE_ENV — see docs/RELEASE_RUNBOOK.md" >&2
  exit 1
fi
# shellcheck source=/dev/null
. "$RELEASE_ENV"

: "${FTP_USER:?must be set in release.env}"
: "${FTP_PASSWORD:?must be set in release.env}"
: "${GHCR_TOKEN:?must be set in release.env}"
: "${GHCR_USER:?must be set in release.env}"
: "${MINISIGN_KEY:=$CONFIG_DIR/release.minisign}"
: "${MINISIGN_PUB:=$CONFIG_DIR/release.pub}"

if [ ! -f "$MINISIGN_KEY" ]; then echo "missing $MINISIGN_KEY" >&2; exit 1; fi
if [ ! -f "$MINISIGN_PUB" ]; then echo "missing $MINISIGN_PUB" >&2; exit 1; fi

# --- Preflight ---
for cmd in docker minisign lftp jq sha256sum gzip; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "missing: $cmd" >&2; exit 1; }
done

cd "$REPO_ROOT"
if [ -n "$(git status --porcelain)" ]; then
  echo "git working tree not clean — commit or stash first" >&2
  git status --short
  exit 1
fi

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$CURRENT_BRANCH" != "main" ]; then
  echo "must be on main, currently on $CURRENT_BRANCH" >&2
  exit 1
fi

# --- Counter ---
COUNTER_FILE="$REPO_ROOT/.release-counter"
PREV_COUNTER="$(cat "$COUNTER_FILE" 2>/dev/null || echo 0)"
NEW_COUNTER=$((PREV_COUNTER + 1))

echo ">>> Releasing $VERSION (counter $NEW_COUNTER)"

# Subsequent steps appended in I2..I7.
echo "TODO: build/sign/upload (next tasks)"
exit 0
```

```bash
chmod +x scripts/release.sh
echo 0 > .release-counter
```

- [ ] **Step 2: Smoke-test preflight**

```bash
./scripts/release.sh v9.9.9 2>&1 | head -10
```

Expected: errors out clearly on missing `release.env` (since you haven't set up the runbook yet — that's Phase J).

- [ ] **Step 3: Commit**

```bash
git add scripts/release.sh scripts/release.legacy.sh .release-counter
git commit -m "feat(release): release.sh skeleton with preflight and counter"
```

### Task I2: Image build + push

**Files:**
- Modify: `scripts/release.sh`

- [ ] **Step 1: Append the image-build block** before the `echo "TODO"` placeholder:

```bash
# --- Build & push multi-arch image ---
PUBKEY_B64="$(grep -v '^untrusted' "$MINISIGN_PUB" | tr -d '\n')"
SOURCES_CSV="https://ghcr.io/alexeyinwerp/boardripper,https://ripperdoc.de/boardripper"

echo ">>> Logging into GHCR"
echo "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USER" --password-stdin

echo ">>> Building multi-arch image $VERSION"
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  --build-arg "APP_VERSION=$VERSION" \
  --build-arg "PUBKEY=$PUBKEY_B64" \
  --build-arg "SOURCES=$SOURCES_CSV" \
  -t "ghcr.io/alexeyinwerp/boardripper:$VERSION" \
  -t "ghcr.io/alexeyinwerp/boardripper:latest" \
  --push \
  .

echo ">>> Capturing image digest"
IMAGE_DIGEST="$(docker buildx imagetools inspect ghcr.io/alexeyinwerp/boardripper:$VERSION \
  --raw 2>/dev/null | jq -r '.manifests[0].digest // .config.digest // ""')"
if [ -z "$IMAGE_DIGEST" ] || [ "$IMAGE_DIGEST" = "null" ]; then
  IMAGE_DIGEST="$(docker buildx imagetools inspect ghcr.io/alexeyinwerp/boardripper:$VERSION \
    | grep -E '^Digest:' | head -1 | awk '{print $2}')"
fi
echo "    digest: $IMAGE_DIGEST"

# --- Pin orchestrator image (pinned alpine for in-place restart) ---
ORCHESTRATOR_IMG="alpine:3.19"
docker pull --platform linux/amd64 "$ORCHESTRATOR_IMG" >/dev/null
ORCHESTRATOR_DIGEST="$(docker inspect "$ORCHESTRATOR_IMG" --format '{{index .RepoDigests 0}}' | sed 's|.*@||')"
echo "    orchestrator: $ORCHESTRATOR_DIGEST"
```

- [ ] **Step 2: Run a build dry-run** *(skipped on this task — will be tested end-to-end in I7)*. Just ensure the script is syntactically valid:

```bash
bash -n scripts/release.sh && echo "OK"
```

- [ ] **Step 3: Commit**

```bash
git add scripts/release.sh
git commit -m "feat(release): multi-arch buildx push + digest capture"
```

### Task I3: Tarball build + sha256

**Files:**
- Modify: `scripts/release.sh`

- [ ] **Step 1: Append after the digest-capture block**

```bash
# --- Build tarball from the pushed image ---
mkdir -p out
TARBALL="out/boardripper-$VERSION.tar.gz"

echo ">>> Saving image as tarball"
docker save "ghcr.io/alexeyinwerp/boardripper:$VERSION" | gzip > "$TARBALL"

TARBALL_SHA="$(sha256sum "$TARBALL" | awk '{print $1}')"
TARBALL_SIZE="$(stat -f %z "$TARBALL" 2>/dev/null || stat -c %s "$TARBALL")"
echo "    sha256: $TARBALL_SHA"
echo "    size:   $TARBALL_SIZE bytes"
```

- [ ] **Step 2: Syntax check**

```bash
bash -n scripts/release.sh && echo "OK"
```

- [ ] **Step 3: Commit**

```bash
git add scripts/release.sh
git commit -m "feat(release): build OCI image tarball with sha256"
```

### Task I4: Manifest generation + signing

**Files:**
- Modify: `scripts/release.sh`

- [ ] **Step 1: Append**

```bash
# --- Generate manifest.json ---
RELEASED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
NOT_AFTER="$(date -u -v+90d +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '+90 days' +%Y-%m-%dT%H:%M:%SZ)"

cat > out/manifest.json <<EOF
{
  "version": "$VERSION",
  "counter": $NEW_COUNTER,
  "released_at": "$RELEASED_AT",
  "not_after": "$NOT_AFTER",
  "important": $IMPORTANT_FLAG,
  "important_reason": $(jq -Rn --arg s "$IMPORTANT_REASON" '$s'),
  "notes_url": "https://www.ripperdoc.de/boardripper/changelog.html#$VERSION",
  "tarball": {
    "url_primary": "https://www.ripperdoc.de/boardripper/releases/boardripper-$VERSION.tar.gz",
    "url_mirrors": [],
    "sha256": "$TARBALL_SHA",
    "size_bytes": $TARBALL_SIZE
  },
  "image": {
    "registry": "ghcr.io/alexeyinwerp/boardripper",
    "tag": "$VERSION",
    "digest": "$IMAGE_DIGEST"
  },
  "min_supported_version": "v0.8.0",
  "orchestrator_image_digest": "$ORCHESTRATOR_DIGEST",
  "source_list_next": [
    "https://ghcr.io/alexeyinwerp/boardripper",
    "https://www.ripperdoc.de/boardripper"
  ]
}
EOF

# Validate the JSON before signing.
jq . out/manifest.json >/dev/null

# --- Sign manifest ---
echo ">>> Signing manifest (will prompt for passphrase)"
minisign -S -s "$MINISIGN_KEY" -m out/manifest.json
# Produces out/manifest.json.minisig
```

- [ ] **Step 2: Syntax check**

```bash
bash -n scripts/release.sh && echo "OK"
```

- [ ] **Step 3: Commit**

```bash
git add scripts/release.sh
git commit -m "feat(release): generate + minisign-sign manifest.json"
```

### Task I5: Site artifact templating (changelog, third_party, landing version block)

**Files:**
- Create: `scripts/release/site-artifacts.sh`
- Modify: `scripts/release.sh`

- [ ] **Step 1: Create site-artifacts.sh**

```bash
#!/usr/bin/env bash
# Generates HTML site artifacts from repo markdown files.
# Called from release.sh: VERSION, RELEASED_AT, OUT_DIR set in env.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="${OUT_DIR:-$REPO_ROOT/out}"
mkdir -p "$OUT/site"

# --- Landing page version-block templating ---
LANDING_SRC="$REPO_ROOT/landing/index.html"
LANDING_OUT="$OUT/site/index.html"
RELEASE_DATE="$(echo "$RELEASED_AT" | cut -d'T' -f1)"

awk -v ver="$VERSION" -v date="$RELEASE_DATE" '
  /<!-- BR_VERSION:START -->/ { print; in_block=1;
    print "  <p class=\"tagline\" style=\"margin-top:4px\"><span class=\"small\">Latest release: <b>" ver "</b> &mdash; released " date "</span></p>";
    next }
  /<!-- BR_VERSION:END -->/ { in_block=0; print; next }
  in_block { next }
  { print }
' "$LANDING_SRC" > "$LANDING_OUT"

# --- changelog.html ---
if command -v pandoc >/dev/null 2>&1 && [ -f "$REPO_ROOT/CHANGELOG.md" ]; then
  pandoc -f markdown -t html -s --metadata title="BoardRipper Changelog" \
    "$REPO_ROOT/CHANGELOG.md" -o "$OUT/site/changelog.html"
else
  cat > "$OUT/site/changelog.html" <<'EOF'
<!DOCTYPE html><html><body><h1>BoardRipper changelog</h1>
<p>Changelog will be populated from CHANGELOG.md once it exists.</p></body></html>
EOF
fi

# --- third_party.html ---
if command -v pandoc >/dev/null 2>&1 && [ -f "$REPO_ROOT/THIRD_PARTY.md" ]; then
  pandoc -f markdown -t html -s --metadata title="BoardRipper third-party attributions" \
    "$REPO_ROOT/THIRD_PARTY.md" -o "$OUT/site/third_party.html"
fi

# --- releases/ index page ---
mkdir -p "$OUT/site/releases"
cat > "$OUT/site/releases/index.html" <<EOF
<!DOCTYPE html><html><body><h1>BoardRipper releases</h1>
<p>Latest: <a href="boardripper-$VERSION.tar.gz">$VERSION</a> (released $RELEASE_DATE).</p>
<p>Manifest: <a href="../manifest.json">manifest.json</a> (signed).</p>
<p>For older versions, ask the maintainer.</p></body></html>
EOF

echo ">>> Site artifacts generated under $OUT/site/"
```

```bash
chmod +x scripts/release/site-artifacts.sh
mkdir -p scripts/release && mv scripts/release/site-artifacts.sh scripts/release/site-artifacts.sh
# (the mkdir+mv is a no-op if dir already exists; ensures placement)
```

- [ ] **Step 2: Wire into release.sh**

Append to `release.sh` after the manifest signing block:

```bash
# --- Generate site artifacts ---
export VERSION RELEASED_AT
OUT_DIR="$REPO_ROOT/out" "$REPO_ROOT/scripts/release/site-artifacts.sh"
```

- [ ] **Step 3: Syntax check**

```bash
bash -n scripts/release.sh scripts/release/site-artifacts.sh && echo "OK"
```

- [ ] **Step 4: Commit**

```bash
git add scripts/release.sh scripts/release/site-artifacts.sh
git commit -m "feat(release): site artifact templating (landing + changelog + third_party)"
```

### Task I6: Atomic FTP upload + git tag

**Files:**
- Modify: `scripts/release.sh`

- [ ] **Step 1: Append FTP upload block**

```bash
# --- Upload to FTP atomically ---
echo ">>> Uploading to ftp.ripperdoc.de"

# Stage all artifacts under a single tree mirroring the remote layout.
STAGE="$REPO_ROOT/out/ftp-stage"
rm -rf "$STAGE" && mkdir -p "$STAGE/boardripper/releases"
cp out/site/index.html        "$STAGE/boardripper/index.html"
cp out/site/changelog.html    "$STAGE/boardripper/changelog.html" 2>/dev/null || true
cp out/site/third_party.html  "$STAGE/boardripper/third_party.html" 2>/dev/null || true
cp out/site/releases/index.html "$STAGE/boardripper/releases/index.html"
cp -r landing/screenshots     "$STAGE/boardripper/screenshots"
cp out/manifest.json          "$STAGE/boardripper/manifest.json.new"
cp out/manifest.json.minisig  "$STAGE/boardripper/manifest.json.minisig.new"
cp "$TARBALL"                 "$STAGE/boardripper/releases/boardripper-$VERSION.tar.gz"
cp "$TARBALL"                 "$STAGE/boardripper/releases/latest.tar.gz.new"

lftp -u "$FTP_USER,$FTP_PASSWORD" "ftp.ripperdoc.de" <<EOF
set ftp:ssl-allow no
mirror --reverse --only-newer --verbose \
  "$STAGE/boardripper" "/public_html/boardripper"

# Atomic renames last
cd /public_html/boardripper
mv -f manifest.json.new manifest.json
mv -f manifest.json.minisig.new manifest.json.minisig
cd /public_html/boardripper/releases
mv -f latest.tar.gz.new latest.tar.gz
bye
EOF

echo ">>> FTP upload complete"

# --- Final local commit & tag ---
echo "$NEW_COUNTER" > "$COUNTER_FILE"
git add "$COUNTER_FILE"
git commit -m "release: $VERSION (counter $NEW_COUNTER)"
git tag "$VERSION"
echo ">>> Local tag $VERSION created. Run 'git push origin main $VERSION' when ready."
echo ">>> Verify the live page: curl -I https://www.ripperdoc.de/boardripper/manifest.json"
```

- [ ] **Step 2: Syntax check**

```bash
bash -n scripts/release.sh && echo "OK"
```

- [ ] **Step 3: Commit**

```bash
git add scripts/release.sh
git commit -m "feat(release): atomic FTP upload + git tag"
```

### Task I7: End-to-end dry-run (no real keys yet — uses ephemeral key for smoke test)

**Files:**
- *Creates ephemeral test artifacts; no repo changes committed.*

- [ ] **Step 1: Set up an ephemeral signing key + env file**

```bash
mkdir -p /tmp/br-release-test
minisign -G -p /tmp/br-release-test/release.pub -s /tmp/br-release-test/release.minisign -W
# (-W = empty password, OK for dry-run only)

cat > /tmp/br-release-test/release.env <<EOF
FTP_USER=dummy
FTP_PASSWORD=dummy
GHCR_USER=dummy
GHCR_TOKEN=dummy
MINISIGN_KEY=/tmp/br-release-test/release.minisign
MINISIGN_PUB=/tmp/br-release-test/release.pub
EOF
```

- [ ] **Step 2: Run release.sh with `--dry-run` flag** (add this flag to the script: skips FTP and git operations).

If you haven't yet added `--dry-run`, add it now:

```bash
# At top of release.sh, after argument parse:
DRY_RUN="${DRY_RUN:-false}"
[[ "${1:-}" == "--dry-run" ]] && { DRY_RUN=true; shift; }

# Wrap each side-effect block:
#   if [ "$DRY_RUN" != "true" ]; then ... fi
# Specifically: docker push, FTP upload, git tag, counter persist.
```

Then:

```bash
BOARDRIPPER_RELEASE_CONFIG=/tmp/br-release-test \
DRY_RUN=true \
./scripts/release.sh v0.8.0-test
```

Expected: builds image, generates + signs manifest, generates site artifacts, prints what it would upload.

- [ ] **Step 3: Verify outputs**

```bash
ls /Users/besitzer/Desktop/Boardviewer/out/
jq . /Users/besitzer/Desktop/Boardviewer/out/manifest.json | head
minisign -V -p /tmp/br-release-test/release.pub -m /Users/besitzer/Desktop/Boardviewer/out/manifest.json
```

Expected: `manifest.json`, `manifest.json.minisig`, `boardripper-v0.8.0-test.tar.gz`, `site/`. minisign verify reports OK.

- [ ] **Step 4: Cleanup**

```bash
rm -rf /tmp/br-release-test /Users/besitzer/Desktop/Boardviewer/out
```

- [ ] **Step 5: Commit `--dry-run` flag if added**

```bash
git add scripts/release.sh
git commit -m "feat(release): --dry-run flag for end-to-end testing without push"
```

---

## Phase J — Runbook + cleanup

### Task J1: docs/RELEASE_RUNBOOK.md

**Files:**
- Create: `docs/RELEASE_RUNBOOK.md`

- [ ] **Step 1: Write the runbook**

```markdown
# BoardRipper release runbook

Single-command release pipeline. Runs entirely from the maintainer's Mac.

## One-time setup

### Tools

```bash
brew install minisign lftp jq pandoc docker
docker buildx create --use --name boardripper-multiarch || true
```

### Signing key

```bash
mkdir -p ~/.config/boardripper
minisign -G -p ~/.config/boardripper/release.pub -s ~/.config/boardripper/release.minisign
```

Strong passphrase. Save it to 1Password. **Back up `release.minisign` to a second
encrypted location** (1Password attachment + USB drive). Loss = no future updates
for any existing install.

### release.env

```bash
cat > ~/.config/boardripper/release.env <<EOF
FTP_USER=ftp@ripperdoc.de
FTP_PASSWORD=<from 1Password>
GHCR_USER=alexeyinwerp
GHCR_TOKEN=<github PAT, write:packages scope>
EOF
chmod 600 ~/.config/boardripper/release.env
```

### GHCR

1. github.com → Settings → Developer settings → Personal access tokens → Tokens (classic).
2. Generate new token, scope: `write:packages` + `read:packages`. Save to `release.env`.
3. After your first `release.sh` run, github.com → Profile → Packages → `boardripper` → Package settings → Change visibility → Public.

## Per-release flow

```bash
cd ~/Desktop/Boardviewer
git pull
# (edit CHANGELOG.md with new entry)
./scripts/release.sh v0.8.1
# (or with important flag:)
./scripts/release.sh v0.8.1 --important "Security fix: unauthenticated update endpoint"
```

The script will:

1. Validate working tree is clean and on `main`.
2. Increment `.release-counter`.
3. Build multi-arch image, push to `ghcr.io/alexeyinwerp/boardripper`.
4. Save image as tarball with sha256.
5. Generate manifest.json (filling counter / sha / digest / important).
6. Prompt for minisign passphrase to sign manifest.
7. Render landing-page version block, changelog.html, third_party.html.
8. Upload via lftp to ftp.ripperdoc.de with atomic renames.
9. Commit counter bump and create local git tag.

After the script finishes:

```bash
git push origin main v0.8.1
curl -I https://www.ripperdoc.de/boardripper/manifest.json
curl https://www.ripperdoc.de/boardripper/manifest.json | jq .
minisign -V -p ~/.config/boardripper/release.pub -m <(curl -s https://www.ripperdoc.de/boardripper/manifest.json) -x <(curl -s https://www.ripperdoc.de/boardripper/manifest.json.minisig)
```

## Bridge release (vN, one-time only)

The first release using the new pipeline must also be uploaded to the existing private GitHub releases page so existing token-using clients pick it up via the old code path. After they update once, they're on the new system.

1. Run `./scripts/release.sh v0.8.0` as normal.
2. Take `out/boardripper-v0.8.0.tar.gz` and upload to github.com → Releases → Draft new release for tag `v0.8.0` (existing flow).
3. Release notes: *"This release moves updates to ripperdoc.de + GHCR. You can remove `GITHUB_TOKEN` from your `docker-compose.yml` after this update."*

## Cleanup after vN ships

1. Delete or rename `.github/workflows/release.yml` so accidental tag pushes don't re-trigger old CI.
2. github.com → repo Settings → Secrets and variables → Actions → remove old `GH_TOKEN`/`GITHUB_PAT` secrets.
3. **Rotate the leaked PAT in `deploy.conf`.** github.com → revoke `github_pat_11ADU6R5I0…`. Move what's left of `deploy.conf` to `~/.config/boardripper-deploy/`.

## Recovery

- **Bad release shipped:** the in-container updater auto-rolls-back if `/api/health` fails for 60s. For irreversible damage, cut `vX.Y.Z+1` immediately with the fix.
- **Lost signing key:** no recovery for existing installs. Cut a new key, ship a new bridge release as a **manual** download (no auto-update path will work). Tell users to `docker pull` it.
- **GHCR down:** clients fall through to ripperdoc.de tarball automatically. No action needed.
- **ripperdoc.de down:** clients use GHCR. Restore the FTP host at leisure.
```

- [ ] **Step 2: Commit**

```bash
git add docs/RELEASE_RUNBOOK.md
git commit -m "docs: release runbook + recovery procedures"
```

### Task J2: First real release run (vN bridge)

This task is **operational, not code**. Read the runbook (J1) and execute it once.

- [ ] **Step 1:** Complete J1's "one-time setup" sections.
- [ ] **Step 2:** Add a `CHANGELOG.md` entry for vN.
- [ ] **Step 3:** Run `./scripts/release.sh vN` (replace with concrete version, e.g. `v0.8.0`).
- [ ] **Step 4:** Manually upload `out/boardripper-vN.tar.gz` to the existing GitHub Releases page using the legacy flow (one last time).
- [ ] **Step 5:** Wait 24h, monitor:
    - GHCR access logs for client pulls
    - FTP access logs for `manifest.json` requests
    - Discord / email for "update worked" or "update broke" reports
- [ ] **Step 6:** Confirm at least one existing token-using install successfully migrated by checking that its `/api/update/status` shows the new manifest format.

### Task J3: Post-vN cleanup

- [ ] **Step 1:** `git rm .github/workflows/release.yml` (or rename to `.disabled`).
- [ ] **Step 2:** Revoke the leaked PAT in github.com.
- [ ] **Step 3:** Move `deploy.conf` out of repo tree.
- [ ] **Step 4:** Commit:

```bash
git add -A
git commit -m "chore: retire legacy release pipeline + rotate exposed PAT"
git push origin main
```

---

## Self-review checklist

Run this against the spec before declaring the plan complete:

| Spec section | Plan tasks | Status |
|---|---|---|
| Trust model (manifest signing, key on Mac) | A1–A2, I4 | ✅ |
| Manifest schema | A1, I4 | ✅ |
| Updater changes (build flags, fetch, validate) | C1–C2, A2–A4, B1, D1–D3 | ✅ |
| Auth on /api/update/* | F1–F2 | ✅ |
| Rollback (health + tag-previous) | E1–E2 | ✅ |
| Frontend banner (important variant) | G1–G2 | ✅ |
| release.sh end-to-end | I1–I7 | ✅ |
| Migration release (vN) | J2 | ✅ (operational) |
| Local setup + GitHub checklist | J1 | ✅ |
| Drop GITHUB_TOKEN from compose | D4 | ✅ |
| Pin orchestrator image by digest | D3, I2 | ✅ |
| Replay/freeze protection (counter) | A3, D1, I4 | ✅ |
| Manifest expiry | A3, I4 | ✅ |
| min_supported_version | A3, I4 | ✅ |
| Source list walking + fallthrough | B1 | ✅ |
| Pull-by-digest content addressing | D3 | ✅ |

No gaps detected.
