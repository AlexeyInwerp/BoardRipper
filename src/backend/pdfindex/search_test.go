package pdfindex

import (
	"strings"
	"testing"
)

func TestSearchPages(t *testing.T) {
	db := openTestDB(t)
	db.Claim(1, "pdfium")
	db.UpsertPages(1, []Page{{1, "STM32 usb connector"}, {2, "power rail"}})
	db.Finalize(1)
	db.Claim(2, "pdfium")
	db.UpsertPages(2, []Page{{1, "usb hub only"}})
	db.Finalize(2)

	hits, err := db.SearchPages("usb", nil, 100)
	if err != nil {
		t.Fatalf("SearchPages: %v", err)
	}
	if len(hits) != 2 {
		t.Errorf("want 2 hits for 'usb', got %d", len(hits))
	}

	if len(hits) > 0 && !strings.Contains(hits[0].Snippet, "<b>") {
		t.Errorf("snippet should contain <b> highlight, got %q", hits[0].Snippet)
	}

	hits2, _ := db.SearchPages("usb", []int64{2}, 100)
	if len(hits2) != 1 || hits2[0].FileID != 2 {
		t.Errorf("donor-scoped want [file 2], got %+v", hits2)
	}
}

// A partial part number must match longer variants via prefix matching:
// searching "AOZ5332" must find the token "AOZ5332QI".
func TestSearchPrefixMatchesPartNumberVariants(t *testing.T) {
	db := openTestDB(t)
	db.Claim(1, "pdfium")
	db.UpsertPages(1, []Page{{1, "buck regulator AOZ5332QI 3A"}})
	db.Finalize(1)
	db.Claim(2, "pdfium")
	db.UpsertPages(2, []Page{{1, "buck regulator AOZ5332DI 5A"}})
	db.Finalize(2)

	full, _ := db.SearchPages("AOZ5332QI", nil, 100)
	if len(full) != 1 {
		t.Errorf("exact 'AOZ5332QI' want 1, got %d", len(full))
	}
	// The partial query must match BOTH variants (more results, not fewer).
	partial, _ := db.SearchPages("AOZ5332", nil, 100)
	if len(partial) != 2 {
		t.Errorf("prefix 'AOZ5332' should match both QI and DI variants, want 2, got %d", len(partial))
	}
}
