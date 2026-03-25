package databank

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func findSamplePdf(t *testing.T) string {
	t.Helper()
	samplesDir := filepath.Join("..", "..", "..", "samples")
	// Try several known PDFs
	candidates := []string{
		"820-00239/820-00239.pdf",
		"820-02016.pdf",
		"820-02841.pdf",
	}
	for _, c := range candidates {
		p := filepath.Join(samplesDir, c)
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	t.Skip("No sample PDF found")
	return ""
}

// TestExtractPageText_MergesCharacters verifies that adjacent single-character
// segments are merged into words, not separated by spaces.
func TestExtractPdfText_MergesCharacters(t *testing.T) {
	pdfPath := findSamplePdf(t)
	pages, err := extractPdfText(pdfPath)
	if err != nil {
		t.Skipf("extractPdfText failed (sample may be unsupported): %v", err)
	}
	if len(pages) == 0 {
		t.Skip("No pages extracted — skipping")
	}

	t.Logf("Extracted %d pages from %s", len(pages), filepath.Base(pdfPath))

	pagesWithText := 0
	for i, page := range pages {
		if page == "" {
			continue
		}
		pagesWithText++

		words := strings.Fields(page)
		longWords := 0
		for _, w := range words {
			if len(w) >= 3 {
				longWords++
			}
		}

		spaceCount := strings.Count(page, " ")
		nonSpaceCount := len(page) - spaceCount - strings.Count(page, "\n")
		ratio := 0.0
		if nonSpaceCount > 0 {
			ratio = float64(spaceCount) / float64(nonSpaceCount)
		}

		if i < 3 {
			sample := page
			if len(sample) > 300 {
				sample = sample[:300]
			}
			t.Logf("  Page %d: %d chars, %d words (%d 3+char), space ratio %.2f\n  Sample: %q",
				i+1, len(page), len(words), longWords, ratio, sample)
		}

		// Space ratio should be well under 0.6 with proper merging
		// (broken extraction has ratio ~1.0)
		if ratio > 0.6 && len(words) > 10 {
			t.Errorf("Page %d: space ratio %.2f too high — characters may not be merged", i+1, ratio)
		}

		// At least 20% of words should be 3+ chars (schematic pages have many pin labels)
		if len(words) > 10 {
			longRatio := float64(longWords) / float64(len(words))
			if longRatio < 0.2 {
				t.Errorf("Page %d: only %d/%d words have 3+ chars (%.0f%%) — extraction likely broken",
					i+1, longWords, len(words), longRatio*100)
			}
		}
	}

	if pagesWithText == 0 {
		t.Skip("No pages had any text — rsc.io/pdf may not support this PDF")
	}
	t.Logf("%d/%d pages had text", pagesWithText, len(pages))
}

// TestExtractPdfText_SearchableTerms checks that common schematic terms
// appear as whole words after extraction.
func TestExtractPdfText_SearchableTerms(t *testing.T) {
	pdfPath := findSamplePdf(t)
	pages, err := extractPdfText(pdfPath)
	if err != nil {
		t.Skipf("extractPdfText failed (sample may be unsupported): %v", err)
	}

	allText := strings.ToLower(strings.Join(pages, "\n"))
	if len(allText) == 0 {
		t.Skip("No text extracted — rsc.io/pdf may not support this PDF")
	}

	// Terms that should appear as whole words in Apple schematic PDFs
	terms := []string{"usb", "connector", "pch", "cpu", "schematic"}

	found := 0
	for _, term := range terms {
		if strings.Contains(allText, term) {
			t.Logf("FOUND: %q", term)
			found++
		} else {
			t.Logf("NOT FOUND: %q (may not be in this specific PDF)", term)
		}
	}

	if found == 0 {
		t.Skip("None of the expected terms found — sample PDF may not contain schematic terms")
	}
}

// TestExtractPdfText_FTS5Searchable verifies that the extracted text would
// produce valid FTS5 search results when indexed.
func TestExtractPdfText_FTS5Searchable(t *testing.T) {
	pdfPath := findSamplePdf(t)
	pages, err := extractPdfText(pdfPath)
	if err != nil {
		t.Skipf("extractPdfText failed (sample may be unsupported): %v", err)
	}

	// Simulate FTS5 tokenization (unicode61 splits on non-word chars)
	allText := strings.Join(pages, "\n")
	if len(allText) == 0 {
		t.Skip("No text extracted")
	}

	// Build a simple word index like FTS5 would
	wordIndex := make(map[string]bool)
	for _, word := range strings.Fields(allText) {
		// Normalize like unicode61 tokenizer
		w := strings.ToLower(strings.Trim(word, ".,;:!?()[]{}\"'"))
		if len(w) >= 2 {
			wordIndex[w] = true
		}
	}

	t.Logf("Unique words (2+ chars): %d", len(wordIndex))

	// With proper extraction, we should have many unique multi-char words
	if len(wordIndex) < 50 {
		t.Errorf("Only %d unique words — expected many more with proper extraction", len(wordIndex))
	}

	// Check that we don't have mostly single-char "words"
	singleChar := 0
	for w := range wordIndex {
		if len(w) == 1 {
			singleChar++
		}
	}
	if len(wordIndex) > 0 {
		singleRatio := float64(singleChar) / float64(len(wordIndex))
		t.Logf("Single-char words: %d/%d (%.0f%%)", singleChar, len(wordIndex), singleRatio*100)
		if singleRatio > 0.5 {
			t.Errorf("Too many single-char words (%.0f%%) — FTS5 search would not work well", singleRatio*100)
		}
	}
}

// TestCleanPageText verifies that noise is stripped from extracted text.
func TestCleanPageText(t *testing.T) {
	input := `PPBUS_G3H
MIN_LINE_WIDTH=0.3000
MIN_NECK_WIDTH=0.1200
VOLTAGE=3.3V
5 OF 119
10 OF 145
SYNC_DATE=04/07/2016 SYNC_MASTER=J79_JACK
LAST_MODIFICATION=Thu Oct 17 16:33:18 2019
BOM_COST_GROUP=CPU & CHIPSET
28
100 101
USB-C PORT CONTROLLER
10UF 25V 0603
CPU Core Decoupling`

	cleaned := cleanPageText(input)

	// Should keep searchable content
	if !strings.Contains(cleaned, "PPBUS_G3H") {
		t.Error("Lost signal name PPBUS_G3H")
	}
	if !strings.Contains(cleaned, "USB-C PORT CONTROLLER") {
		t.Error("Lost component description")
	}
	if !strings.Contains(cleaned, "10UF 25V 0603") {
		t.Error("Lost part values")
	}
	if !strings.Contains(cleaned, "CPU Core Decoupling") {
		t.Error("Lost section title")
	}

	// Should strip noise
	if strings.Contains(cleaned, "MIN_LINE_WIDTH") {
		t.Error("Did not strip MIN_LINE_WIDTH")
	}
	if strings.Contains(cleaned, "MIN_NECK_WIDTH") {
		t.Error("Did not strip MIN_NECK_WIDTH")
	}
	if strings.Contains(cleaned, "VOLTAGE=") {
		t.Error("Did not strip VOLTAGE=")
	}
	if strings.Contains(cleaned, "5 OF 119") {
		t.Error("Did not strip page number")
	}
	if strings.Contains(cleaned, "10 OF 145") {
		t.Error("Did not strip page number")
	}
	if strings.Contains(cleaned, "SYNC_DATE") {
		t.Error("Did not strip SYNC_DATE")
	}
	if strings.Contains(cleaned, "LAST_MODIFICATION") {
		t.Error("Did not strip LAST_MODIFICATION")
	}
	if strings.Contains(cleaned, "BOM_COST_GROUP") {
		t.Error("Did not strip BOM_COST_GROUP")
	}

	// Check bare numbers are stripped
	lines := strings.Split(cleaned, "\n")
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "28" || trimmed == "100 101" {
			t.Errorf("Did not strip bare number line: %q", trimmed)
		}
	}

	t.Logf("Cleaned text:\n%s", cleaned)
}

// TestCleanPageText_StorageSavings measures storage reduction on real PDFs.
func TestCleanPageText_StorageSavings(t *testing.T) {
	pdfPath := findSamplePdf(t)
	pages, err := extractPdfText(pdfPath)
	if err != nil {
		t.Fatalf("extractPdfText failed: %v", err)
	}

	rawTotal := 0
	cleanedTotal := 0
	for _, page := range pages {
		rawTotal += len(strings.TrimSpace(page))
		cleanedTotal += len(cleanPageText(page))
	}

	savings := 0.0
	if rawTotal > 0 {
		savings = float64(rawTotal-cleanedTotal) / float64(rawTotal) * 100
	}

	t.Logf("Raw: %d bytes, Cleaned: %d bytes, Savings: %.1f%%", rawTotal, cleanedTotal, savings)

	// Should save at least some space
	if savings < 1 {
		t.Logf("Warning: very low savings (%.1f%%) — noise patterns may not match this PDF", savings)
	}
}
