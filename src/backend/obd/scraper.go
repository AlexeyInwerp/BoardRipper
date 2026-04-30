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
	defaultUserAgent  = "BoardRipper/dev (+https://boardripper.app)"
	defaultMaxPages   = 50
	defaultDropGuard  = 0.5  // reject if new index drops below 50% of prior
	defaultHTTPTimeout = 30 * time.Second
)

// Scraper walks openboarddata.org's category index pages and downloads per-board files.
type Scraper struct {
	BaseURL      string        // e.g. "https://openboarddata.org"
	UserAgent    string
	RequestDelay time.Duration
	HTTPClient   *http.Client
	MaxPages     int
}

// NewScraper returns a configured scraper.
func NewScraper(baseURL string) *Scraper {
	return &Scraper{
		BaseURL:      strings.TrimRight(baseURL, "/"),
		UserAgent:    defaultUserAgent,
		RequestDelay: 250 * time.Millisecond,
		HTTPClient:   &http.Client{Timeout: defaultHTTPTimeout},
		MaxPages:     defaultMaxPages,
	}
}

var fallbackCategories = []string{"consoles", "desktops", "laptops", "phones"}

// SyncIndex walks every category and returns an in-memory Index.
func (s *Scraper) SyncIndex() (*Index, error) {
	pagesWalked := 0

	rootHTML, err := s.get(s.BaseURL + "/")
	pagesWalked++
	if err != nil {
		return nil, fmt.Errorf("scrape root: %w", err)
	}
	cats := extractCategories(rootHTML)
	if len(cats) == 0 {
		cats = fallbackCategories
	}

	var entries []IndexEntry
	for _, cat := range cats {
		if pagesWalked >= s.MaxPages {
			return nil, fmt.Errorf("scrape: hard cap of %d pages exceeded", s.MaxPages)
		}
		s.sleep()
		listHTML, err := s.get(fmt.Sprintf("%s/?a=showboards&category=%s", s.BaseURL, cat))
		pagesWalked++
		if err != nil {
			// Per-category failure is non-fatal — log and continue.
			continue
		}
		for _, bp := range extractBpaths(listHTML) {
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
// raw text. Rejects responses that don't start with the magic line.
func (s *Scraper) FetchBoard(bpath string) (string, error) {
	if err := validateBpath(bpath); err != nil {
		return "", err
	}
	body, err := s.get(fmt.Sprintf("%s/?a=generate&bpath=%s", s.BaseURL, bpath))
	if err != nil {
		return "", err
	}
	if !strings.HasPrefix(strings.TrimSpace(body), "OBDATA_V002") {
		return "", errors.New("upstream response does not start with OBDATA_V002 magic")
	}
	return body, nil
}

func (s *Scraper) sleep() {
	if s.RequestDelay > 0 {
		time.Sleep(s.RequestDelay)
	}
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
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}
	return string(body), nil
}

// extractCategories pulls "category" query params from anchors whose
// href contains "a=showboards&category=...".
var categoryRE = regexp.MustCompile(`a=showboards(?:&|&amp;)category=([a-z]+)`)

func extractCategories(html string) []string {
	matches := categoryRE.FindAllStringSubmatch(html, -1)
	seen := map[string]struct{}{}
	var out []string
	for _, m := range matches {
		if _, ok := seen[m[1]]; ok {
			continue
		}
		seen[m[1]] = struct{}{}
		out = append(out, m[1])
	}
	return out
}

// extractBpaths pulls "bpath" query params from anchors whose href
// contains "a=showboardsolutions&bpath=...". The bpath is URL-encoded
// in the source but our fixture uses literal slashes — handle both.
var bpathRE = regexp.MustCompile(`a=showboardsolutions(?:&|&amp;)bpath=([^"&\s]+)`)

func extractBpaths(html string) []string {
	matches := bpathRE.FindAllStringSubmatch(html, -1)
	seen := map[string]struct{}{}
	var out []string
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
