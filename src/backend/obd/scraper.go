package obd

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"
)

const (
	defaultUserAgent   = "BoardRipper/dev (+https://boardripper.app)"
	defaultDropGuard   = 0.5 // reject if new index drops below 50% of prior
	defaultHTTPTimeout = 30 * time.Second
	maxResponseBytes   = 8 << 20 // 8 MiB cap per upstream response
)

// Scraper fetches openboarddata.org's root page (which contains the entire
// board catalog as a single HTML table) and downloads per-board OBDATA files.
//
// The site has no per-category listing endpoint; the root page is the index.
type Scraper struct {
	BaseURL      string // e.g. "https://openboarddata.org"
	UserAgent    string
	RequestDelay time.Duration
	HTTPClient   *http.Client
}

// NewScraper returns a configured scraper.
func NewScraper(baseURL string) *Scraper {
	return &Scraper{
		BaseURL:      strings.TrimRight(baseURL, "/"),
		UserAgent:    defaultUserAgent,
		RequestDelay: 250 * time.Millisecond,
		HTTPClient:   &http.Client{Timeout: defaultHTTPTimeout},
	}
}

// SyncIndex fetches the root page once and extracts every bpath from its
// catalog table. There is no category walk — the whole index lives on a
// single page.
func (s *Scraper) SyncIndex() (*Index, error) {
	rootHTML, err := s.get(s.BaseURL + "/")
	if err != nil {
		return nil, fmt.Errorf("scrape root: %w", err)
	}

	bpaths := extractBpaths(rootHTML)
	entries := make([]IndexEntry, 0, len(bpaths))
	for _, bp := range bpaths {
		seg := strings.Split(bp, "/")
		if len(seg) < 3 {
			continue
		}
		entries = append(entries, IndexEntry{
			Bpath:    bp,
			Category: seg[0],
			Brand:    seg[1],
		})
	}

	return &Index{
		SyncedAt: time.Now().UTC().Format(time.RFC3339),
		Source:   s.BaseURL,
		Boards:   entries,
	}, nil
}

// SyncIndexWithGuard runs SyncIndex and rejects the result when the new
// board count drops below defaultDropGuard fraction of prior. prev may
// be nil — in which case the guard is a no-op.
func (s *Scraper) SyncIndexWithGuard(prev *Index) (*Index, error) {
	idx, err := s.SyncIndex()
	if err != nil {
		return nil, err
	}
	if prev != nil && len(prev.Boards) > 0 {
		ratio := float64(len(idx.Boards)) / float64(len(prev.Boards))
		if ratio < defaultDropGuard {
			return nil, fmt.Errorf("scrape: drop guard tripped (new %d / prev %d = %.2f)",
				len(idx.Boards), len(prev.Boards), ratio)
		}
	}
	return idx, nil
}

// FetchBoard downloads the OBDATA_V002 body for one bpath. Returns the
// raw text. The magic line (`OBDATA_V002 …`) appears as the second
// physical line, inside the `HEADER_DATA_START`/`HEADER_DATA_END`
// block; we only require that the magic appears within the first 500
// bytes — anything else is treated as an HTML error page or junk.
func (s *Scraper) FetchBoard(bpath string) (string, error) {
	if err := validateBpath(bpath); err != nil {
		return "", err
	}
	body, err := s.get(fmt.Sprintf("%s/?a=generate&bpath=%s", s.BaseURL, bpath))
	if err != nil {
		return "", err
	}
	head := body
	if len(head) > 500 {
		head = head[:500]
	}
	if !strings.Contains(head, "OBDATA_V002") {
		return "", errors.New("upstream response missing OBDATA_V002 magic in first 500 bytes")
	}
	return body, nil
}

func (s *Scraper) get(u string) (string, error) {
	req, err := http.NewRequest(http.MethodGet, u, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", s.UserAgent)
	resp, err := s.HTTPClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return "", fmt.Errorf("HTTP %d from %s", resp.StatusCode, u)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes))
	if err != nil {
		return "", err
	}
	return string(body), nil
}

// extractBpaths pulls "bpath" query params from anchors in the root
// catalog page. The real openboarddata.org markup looks like
//
//	<a href=?a=showboardsolutions&bpath=laptops/apple/820-00045>...</a>
//
// — note the unquoted href and the lack of HTML escaping. The character
// class `[^"&\s>]+` stops the bpath capture at the closing `>` of the
// anchor tag.
var bpathRE = regexp.MustCompile(`a=showboardsolutions(?:&|&amp;)bpath=([^"&\s>]+)`)

func extractBpaths(html string) []string {
	matches := bpathRE.FindAllStringSubmatch(html, -1)
	seen := map[string]struct{}{}
	out := make([]string, 0, len(matches))
	for _, m := range matches {
		bp := strings.ReplaceAll(m[1], "%2F", "/")
		if _, ok := seen[bp]; ok {
			continue
		}
		seen[bp] = struct{}{}
		out = append(out, bp)
	}
	return out
}
