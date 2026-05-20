package pdfindex

import (
	"regexp"
	"strings"
	"unicode"

	"golang.org/x/text/unicode/norm"
)

var (
	noisePatterns  = regexp.MustCompile(`(?i)^(MIN_LINE_WIDTH|MIN_NECK_WIDTH|VOLTAGE|SYNC_DATE|SYNC_MASTER|LAST_MODIFICATION|BOM_COST_GROUP)=`)
	pageNumPattern = regexp.MustCompile(`^\d{1,3} OF \d{1,3}$`)
)

// IsWatermark mirrors the frontend isPdfWatermarkText matching rule:
// case-insensitive, whitespace-stripped substring match against any term.
// The MATCHING RULE is the contract (docs/PDF_VIEWER.md#watermark-lock-step).
func IsWatermark(s string, terms []string) bool {
	if len(terms) == 0 {
		return false
	}
	norm := strings.ToLower(stripSpace(s))
	for _, t := range terms {
		tn := strings.ToLower(stripSpace(t))
		if tn != "" && strings.Contains(norm, tn) {
			return true
		}
	}
	return false
}

func stripSpace(s string) string {
	s = norm.NFKC.String(s)
	var b strings.Builder
	for _, r := range s {
		if !unicode.IsSpace(r) {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// CleanPageText strips noise lines (PCB metadata, page refs, watermark lines)
// to improve FTS5 quality.
func CleanPageText(text string, watermarkTerms []string) string {
	text = strings.TrimSpace(text)
	if text == "" {
		return ""
	}
	var cleaned []string
	lastBlank := false
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			if !lastBlank {
				cleaned = append(cleaned, "")
				lastBlank = true
			}
			continue
		}
		lastBlank = false
		if noisePatterns.MatchString(line) || pageNumPattern.MatchString(line) || isOnlySmallNumbers(line) {
			continue
		}
		if IsWatermark(line, watermarkTerms) {
			continue
		}
		cleaned = append(cleaned, line)
	}
	return strings.TrimSpace(strings.Join(cleaned, "\n"))
}

func isOnlySmallNumbers(s string) bool {
	fields := strings.Fields(s)
	if len(fields) == 0 {
		return false
	}
	for _, f := range fields {
		n, allDigits := 0, true
		for _, r := range f {
			if !unicode.IsDigit(r) {
				allDigits = false
				break
			}
			n = n*10 + int(r-'0')
		}
		if !allDigits || n > 200 {
			return false
		}
	}
	return true
}
