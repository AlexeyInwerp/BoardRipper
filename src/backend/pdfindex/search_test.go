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
