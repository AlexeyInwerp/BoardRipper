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

// ErrSignatureMismatch reports that a source served a manifest whose signature
// verified under none of this build's trusted keys — as distinct from the
// source being unreachable. The UI uses this to say "an update exists but this
// build cannot verify it, install manually" WITHOUT echoing anything from the
// unverified body, which is attacker-controlled by definition: its version
// string, notes and important_reason are exactly what a hostile mirror would
// choose. Only the fact of the mismatch crosses the trust boundary.
var ErrSignatureMismatch = errors.New("manifest signature did not verify under any trusted key")

// FetchFromSources walks sources in order; returns the first manifest whose
// signature verifies under pubKeyStr. Errors from individual sources are
// collected and returned only if all sources fail.
func FetchFromSources(sources []string, pubKeyStr string) (*Manifest, error) {
	return FetchFromSourcesMulti(sources, []string{pubKeyStr})
}

// FetchFromSourcesMulti is FetchFromSources against a set of trusted keys:
// a source wins if its signature verifies under any one of them.
func FetchFromSourcesMulti(sources []string, pubKeys []string) (*Manifest, error) {
	if len(sources) == 0 {
		return nil, errors.New("no sources configured")
	}
	client := &http.Client{Timeout: fetchTimeout}
	var errs []string
	sigFailure := false
	for _, base := range sources {
		base = strings.TrimRight(base, "/")
		body, sig, err := fetchManifestPair(client, base)
		if err != nil {
			errs = append(errs, fmt.Sprintf("%s: %v", base, err))
			continue
		}
		if err := VerifyManifestAny(body, sig, pubKeys); err != nil {
			// A manifest WAS served and it did not verify. That is a different
			// situation from an unreachable mirror and is surfaced separately.
			sigFailure = true
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
	if sigFailure {
		return nil, fmt.Errorf("%w; sources: %s", ErrSignatureMismatch, strings.Join(errs, "; "))
	}
	return nil, fmt.Errorf("all sources failed: %s", strings.Join(errs, "; "))
}

func fetchManifestPair(c *http.Client, base string) (body, sig []byte, err error) {
	body, err = httpGet(c, base+"/manifest.json")
	if err != nil {
		return nil, nil, fmt.Errorf("manifest: %w", err)
	}
	sig, err = httpGet(c, base+"/manifest.json.minisig")
	if err != nil {
		return nil, nil, fmt.Errorf("signature: %w", err)
	}
	return body, sig, nil
}

func httpGet(c *http.Client, url string) ([]byte, error) {
	resp, err := c.Get(url)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return io.ReadAll(io.LimitReader(resp.Body, 1<<20)) // 1 MiB cap on manifest
}
