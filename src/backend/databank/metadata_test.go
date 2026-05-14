package databank

import "testing"

func TestMatchScore_RegressionShortNameSubstring(t *testing.T) {
	// "1.pdf" / "4.pdf" used to score 50 against every board whose name
	// contained a digit anywhere (the substring check had no length guard).
	// Both must score 0 so the auto-binder never picks them.
	cases := []struct {
		board, pdf string
	}{
		{"NM-E231 Boardview.tvw", "1.pdf"},
		{"NM-E231 Boardview.tvw", "4.pdf"},
		{"820-02016.bvr", "1.pdf"},
		{"820-02016.bvr", "01.pdf"},
		{"abc123.brd", "1.pdf"},
	}
	for _, tc := range cases {
		if got := MatchScore(tc.board, tc.pdf); got != 0 {
			t.Errorf("MatchScore(%q, %q) = %d, want 0", tc.board, tc.pdf, got)
		}
	}
}

func TestMatchScore_LegitMatchesPreserved(t *testing.T) {
	cases := []struct {
		name              string
		board, pdf string
		want       int
	}{
		{"exact base", "820-02016.bvr", "820-02016.pdf", 100},
		{"apple board number in pdf name", "820-02016.bvr", "01_820-02016_1st_schematic.pdf", 80},
		{"substring with both ≥ 4 alnum", "A2338_T668.brd", "T668.pdf", 50},
	}
	for _, tc := range cases {
		if got := MatchScore(tc.board, tc.pdf); got != tc.want {
			t.Errorf("%s: MatchScore(%q, %q) = %d, want %d", tc.name, tc.board, tc.pdf, got, tc.want)
		}
	}
}

func TestIsLikelyJunkPdfName(t *testing.T) {
	junk := []string{
		"1.pdf", "4.pdf", "01.pdf", "ab.pdf",
		"1234.pdf", "20240101.pdf",
		".pdf", "  .pdf",
	}
	for _, n := range junk {
		if !IsLikelyJunkPdfName(n) {
			t.Errorf("IsLikelyJunkPdfName(%q) = false, want true", n)
		}
	}
	ok := []string{
		"820-02016.pdf",
		"schematic.pdf",
		"NM-E231.pdf",
		"Location map.pdf",
		"sch.pdf", // 3 alnum, mixed — passes the gate; will only match boards that actually substring "sch"
	}
	for _, n := range ok {
		if IsLikelyJunkPdfName(n) {
			t.Errorf("IsLikelyJunkPdfName(%q) = true, want false", n)
		}
	}
}
