package databank

import (
	"context"
	"testing"
)

func rec(id int64, p, typ string) FileRecord {
	base := p
	if i := lastSlash(p); i >= 0 {
		base = p[i+1:]
	}
	return FileRecord{ID: id, Path: p, Filename: base, FileType: typ}
}

func lastSlash(s string) int {
	for i := len(s) - 1; i >= 0; i-- {
		if s[i] == '/' {
			return i
		}
	}
	return -1
}

func byBoard(c []AutoBindCandidate) map[int64]AutoBindCandidate {
	m := make(map[int64]AutoBindCandidate)
	for _, x := range c {
		m[x.BoardID] = x
	}
	return m
}

func TestAutoBind_Ladder(t *testing.T) {
	boards := []FileRecord{
		rec(1, "Apple/A1/820-00165-A.brd", "board"),     // exact, same folder wins over remote copy
		rec(2, "Apple/A2/820-00281.bvr", "board"),       // number rule, PDF elsewhere
		rec(3, "Lenovo/T480/NM-B501 rev1.tvw", "board"), // fuzzy 75 % same folder
		rec(4, "Dell/E7470/board.brd", "board"),         // lone: one board, one pdf
		rec(5, "HP/dump/x1.brd", "board"),               // lone blocked: two boards in folder
		rec(6, "HP/dump/x2.brd", "board"),
		rec(7, "Asus/X550/Boardview/X550CC.fz", "board"), // fuzzy needs radius 1 (sibling folder)
		rec(8, "Misc/nothing.brd", "board"),              // no match at all
		rec(9, "Apple/A3/820-99999.brd", "board"),        // already bound → skipped
	}
	pdfs := []FileRecord{
		rec(101, "Archive/820-00165-A.pdf", "pdf"),
		rec(102, "Apple/A1/820-00165-A.pdf", "pdf"),
		rec(103, "Schematics/Apple/MacBook 820-00281 schematic.pdf", "pdf"),
		rec(104, "Lenovo/T480/NM-B501 schematic rev1.pdf", "pdf"),
		rec(105, "Lenovo/T480/1.pdf", "pdf"), // junk name, must be ignored everywhere
		rec(106, "Dell/E7470/service manual.pdf", "pdf"),
		rec(107, "HP/dump/random.pdf", "pdf"),
		rec(108, "Asus/X550/Schematic/X550CC rev2.pdf", "pdf"),
		rec(109, "Apple/A3/820-99999.pdf", "pdf"),
	}
	bound := map[int64]bool{9: true}

	cands, rep := MatchAutoBind(boards, pdfs, bound, DefaultAutoBindRules())
	got := byBoard(cands)

	if rep.Boards != 8 {
		t.Errorf("boards considered = %d, want 8 (bound board skipped)", rep.Boards)
	}
	if rep.Pdfs != 8 {
		t.Errorf("pdfs considered = %d, want 8 (junk dropped)", rep.Pdfs)
	}
	if c := got[1]; c.Rule != RuleExact || c.PdfID != 102 {
		t.Errorf("board 1: got %+v, want exact → same-folder pdf 102", c)
	}
	if c := got[2]; c.Rule != RuleNumber || c.PdfID != 103 {
		t.Errorf("board 2: got %+v, want number → 103", c)
	}
	if c := got[3]; c.Rule != RuleFuzzy || c.PdfID != 104 || c.Score < 75 {
		t.Errorf("board 3: got %+v, want fuzzy → 104 at ≥75", c)
	}
	if c := got[4]; c.Rule != RuleLone || c.PdfID != 106 {
		t.Errorf("board 4: got %+v, want lone → 106", c)
	}
	if _, ok := got[5]; ok {
		t.Errorf("board 5 must not bind: two boards share the folder with one pdf")
	}
	if _, ok := got[7]; ok {
		t.Errorf("board 7 must not bind at radius 0: pdf sits in a sibling folder")
	}
	if _, ok := got[8]; ok {
		t.Errorf("board 8 must not bind")
	}
	if _, ok := got[9]; ok {
		t.Errorf("board 9 is already bound and must be skipped")
	}
}

func TestAutoBind_RadiusAndGuards(t *testing.T) {
	boards := []FileRecord{
		rec(7, "Asus/X550/Boardview/X550CC.fz", "board"),
		rec(5, "HP/dump/x1.brd", "board"),
		rec(6, "HP/dump/x2.brd", "board"),
	}
	pdfs := []FileRecord{
		rec(108, "Asus/X550/Schematic/X550CC rev2.pdf", "pdf"),
		rec(107, "HP/dump/random.pdf", "pdf"),
	}
	rules := DefaultAutoBindRules()
	rules.Fuzzy.Radius = 1
	rules.Lone.RequireOneBoard = false
	got := byBoard(first(MatchAutoBind(boards, pdfs, nil, rules)))
	if c := got[7]; c.Rule != RuleFuzzy || c.PdfID != 108 {
		t.Errorf("radius 1: board 7 got %+v, want fuzzy → 108 via shared parent", c)
	}
	if got[5].PdfID != 107 || got[6].PdfID != 107 || got[5].Rule != RuleLone {
		t.Errorf("lone without the one-board guard must link both boards to 107: %+v %+v", got[5], got[6])
	}

	// Every rule off → nothing.
	off := AutoBindRules{}
	if c := first(MatchAutoBind(boards, pdfs, nil, off)); len(c) != 0 {
		t.Errorf("all rules off: got %d links, want 0", len(c))
	}
}

func first(c []AutoBindCandidate, _ AutoBindReport) []AutoBindCandidate { return c }

func TestNameSimilarity(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{
		{"820-00165-A.brd", "820-00165-A-schematic.pdf", 100}, // containment
		{"NM-B501 rev1.tvw", "NM-B501 schematic rev1.pdf", 100},
		{"X550CC.fz", "X550CC rev2.pdf", 100},
		{"LA-E991P r1.brd", "LA-E992P r1.pdf", 0}, // different board, "r1" is too short to count — no tokens shared
		{"foo.brd", "bar.pdf", 0},
	}
	for _, c := range cases {
		got, _ := nameSimilarity(c.a, c.b)
		if got != c.want {
			t.Errorf("nameSimilarity(%q,%q) = %d, want %d", c.a, c.b, got, c.want)
		}
	}
}

func TestParseAutoBindRules(t *testing.T) {
	if r := ParseAutoBindRules(""); r != DefaultAutoBindRules() {
		t.Errorf("empty → defaults, got %+v", r)
	}
	if r := ParseAutoBindRules("not json"); r != DefaultAutoBindRules() {
		t.Errorf("garbage → defaults, got %+v", r)
	}
	r := ParseAutoBindRules(`{"exact":true,"number":false,"fuzzy":{"on":true,"min":500,"radius":9},"lone":{"on":false}}`)
	if r.Number || r.Fuzzy.Min != 100 || r.Fuzzy.Radius != maxRadius || r.Lone.On {
		t.Errorf("clamping/parsing wrong: %+v", r)
	}
}

func TestAutoBind_WritesAndDeletesByRule(t *testing.T) {
	dir := t.TempDir()
	db, err := Open(dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer db.Close()

	b1, _ := db.InsertFile(&FileRecord{Path: "A/820-00165-A.brd", Filename: "820-00165-A.brd", Extension: ".brd", FileType: "board", Size: 1, ModTime: 1})
	b2, _ := db.InsertFile(&FileRecord{Path: "B/only.brd", Filename: "only.brd", Extension: ".brd", FileType: "board", Size: 1, ModTime: 1})
	p1, _ := db.InsertFile(&FileRecord{Path: "A/820-00165-A.pdf", Filename: "820-00165-A.pdf", Extension: ".pdf", FileType: "pdf", Size: 1, ModTime: 1})
	p2, _ := db.InsertFile(&FileRecord{Path: "B/manual.pdf", Filename: "manual.pdf", Extension: ".pdf", FileType: "pdf", Size: 1, ModTime: 1})

	ctx := context.Background()
	rep, err := db.AutoBind(ctx, DefaultAutoBindRules(), true)
	if err != nil {
		t.Fatalf("preview: %v", err)
	}
	if rep.Total != 2 || rep.Inserted != 0 {
		t.Fatalf("preview: total=%d inserted=%d, want 2/0", rep.Total, rep.Inserted)
	}
	if n, _ := db.GetBindingsForBoard(ctx, b1); len(n) != 0 {
		t.Fatalf("preview must not write")
	}

	rep, err = db.AutoBind(ctx, DefaultAutoBindRules(), false)
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if rep.Inserted != 2 || rep.Existing[RuleExact] != 1 || rep.Existing[RuleLone] != 1 {
		t.Fatalf("run: inserted=%d existing=%v", rep.Inserted, rep.Existing)
	}
	got, _ := db.GetBindingsForBoard(ctx, b1)
	if len(got) != 1 || got[0].PdfFileID != p1 || got[0].Rule != RuleExact || !got[0].AutoMatched {
		t.Fatalf("b1 binding: %+v", got)
	}
	got, _ = db.GetBindingsForBoard(ctx, b2)
	if len(got) != 1 || got[0].PdfFileID != p2 || got[0].Rule != RuleLone {
		t.Fatalf("b2 binding: %+v", got)
	}

	// Second run is idempotent (boards now bound).
	rep, _ = db.AutoBind(ctx, DefaultAutoBindRules(), false)
	if rep.Total != 0 || rep.Inserted != 0 {
		t.Fatalf("rerun must find nothing: %+v", rep)
	}

	// A manual link survives a by-rule delete; the lone link goes.
	if _, err := db.InsertBinding(b1, p2, false, "datasheet", false); err != nil {
		t.Fatal(err)
	}
	n, err := db.DeleteAutoBindingsByRule(RuleLone)
	if err != nil || n != 1 {
		t.Fatalf("delete lone: n=%d err=%v", n, err)
	}
	if got, _ := db.GetBindingsForBoard(ctx, b2); len(got) != 0 {
		t.Fatalf("lone link must be gone")
	}
	if got, _ := db.GetBindingsForBoard(ctx, b1); len(got) != 2 {
		t.Fatalf("b1 keeps exact + manual, got %d", len(got))
	}
	n, _ = db.DeleteAutoBindingsByRule("*")
	if n != 1 {
		t.Fatalf("delete all auto: n=%d, want 1 (manual kept)", n)
	}
}
