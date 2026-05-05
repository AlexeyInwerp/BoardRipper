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
// signature verifies under pubKeyStr. Errors from individual sources are
// collected and returned only if all sources fail.
func FetchFromSources(sources []string, pubKeyStr string) (*Manifest, error) {
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
		if err := VerifyManifest(body, sig, pubKeyStr); err != nil {
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
