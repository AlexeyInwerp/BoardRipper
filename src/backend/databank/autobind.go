package databank

import (
	"context"
	"encoding/json"
	"path"
	"sort"
	"strings"
)

// Automatic board ↔ PDF linking.
//
// A fixed ladder of four rules, tried in order of confidence; the first rule
// that produces a PDF for a board wins. Users switch rules on and off and tune
// the two loose ones, they never reorder them — rule 1 beating rule 4 is not a
// preference.
//
//   1. exact  — same base name (board.brd ↔ board.pdf), any folder.
//   2. number — the board's Apple number (820-NNNNN) appears in the PDF name,
//               any folder.
//   3. fuzzy  — the names share ≥ Min % of their tokens, within Radius.
//   4. lone   — the folder (within Radius) holds exactly one PDF, optionally
//               only when it holds exactly one board too.
//
// Rules 1–2 are hash lookups and may look anywhere in the library. Rules 3–4
// must be bounded by a folder radius: similarity cannot be indexed, and
// "fuzzy × anywhere" is the boards × pdfs loop that made the old matcher take
// hours on a large library. Radius means "the folder this many levels up
// from the board"; a PDF counts when it sits in that folder or up to two
// levels below it (Model/Boardview/x.brd ↔ Model/Schematic/y.pdf is radius 1).
//
// The rule that made a link is stored in bindings.rule so links can be
// reviewed and removed per rule later.

const (
	RuleExact  = "exact"
	RuleNumber = "number"
	RuleFuzzy  = "fuzzy"
	RuleLone   = "lone"
	// RuleLegacy marks auto-bindings made before rules had names.
	RuleLegacy = "legacy"

	// AutoBindRulesKey is the databank config key holding the JSON rules.
	AutoBindRulesKey = "auto_bind_rules"

	// maxRadius bounds rules 3–4; also the depth PDFs are registered under.
	maxRadius = 2
	// sampleLimit caps the per-rule examples in a preview report.
	sampleLimit = 10
)

// FuzzyRule tunes rule 3.
type FuzzyRule struct {
	On     bool `json:"on"`
	Min    int  `json:"min"`    // percent of shared tokens, 1..100
	Radius int  `json:"radius"` // 0 same folder, 1 share a parent, 2 share a grandparent
}

// LoneRule tunes rule 4.
type LoneRule struct {
	On              bool `json:"on"`
	Radius          int  `json:"radius"`
	RequireOneBoard bool `json:"require_one_board"` // the folder must hold exactly one board too
}

// AutoBindRules is the user-editable rule set (Settings ▸ Library).
type AutoBindRules struct {
	Exact  bool      `json:"exact"`
	Number bool      `json:"number"`
	Fuzzy  FuzzyRule `json:"fuzzy"`
	Lone   LoneRule  `json:"lone"`
}

// DefaultAutoBindRules is conservative enough that a first-run tick is not
// regretted: exact + number anywhere, 75 % similar in the same folder, and a
// lone PDF only when it is alone with one board.
func DefaultAutoBindRules() AutoBindRules {
	return AutoBindRules{
		Exact:  true,
		Number: true,
		Fuzzy:  FuzzyRule{On: true, Min: 75, Radius: 0},
		Lone:   LoneRule{On: true, Radius: 0, RequireOneBoard: true},
	}
}

// ParseAutoBindRules reads the JSON stored under AutoBindRulesKey. An empty
// or unreadable value yields the defaults; out-of-range knobs are clamped.
func ParseAutoBindRules(s string) AutoBindRules {
	r := DefaultAutoBindRules()
	if strings.TrimSpace(s) == "" {
		return r
	}
	if err := json.Unmarshal([]byte(s), &r); err != nil {
		return DefaultAutoBindRules()
	}
	return r.Normalized()
}

// Normalized clamps the numeric knobs into their valid ranges.
func (r AutoBindRules) Normalized() AutoBindRules {
	if r.Fuzzy.Min < 1 {
		r.Fuzzy.Min = 1
	}
	if r.Fuzzy.Min > 100 {
		r.Fuzzy.Min = 100
	}
	r.Fuzzy.Radius = clampRadius(r.Fuzzy.Radius)
	r.Lone.Radius = clampRadius(r.Lone.Radius)
	return r
}

func clampRadius(n int) int {
	if n < 0 {
		return 0
	}
	if n > maxRadius {
		return maxRadius
	}
	return n
}

// AutoBindCandidate is one proposed link.
type AutoBindCandidate struct {
	BoardID   int64    `json:"board_id"`
	PdfID     int64    `json:"pdf_id"`
	Rule      string   `json:"rule"`
	Score     int      `json:"score"` // 100 exact, 80 number, similarity % for fuzzy, 0 lone
	BoardName string   `json:"board_name"`
	BoardPath string   `json:"board_path"`
	PdfName   string   `json:"pdf_name"`
	PdfPath   string   `json:"pdf_path"`
	Shared    []string `json:"shared,omitempty"` // fuzzy: the tokens both names carry
}

// AutoBindReport is what a preview returns and what a run logs.
type AutoBindReport struct {
	Rules    AutoBindRules                  `json:"rules"`
	Boards   int                            `json:"boards"`   // unbound boards considered
	Pdfs     int                            `json:"pdfs"`     // non-junk PDFs considered
	Total    int                            `json:"total"`    // links the ladder would make
	Counts   map[string]int                 `json:"counts"`   // per rule
	Samples  map[string][]AutoBindCandidate `json:"samples"`  // per rule, up to sampleLimit
	Inserted int                            `json:"inserted"` // run only: rows actually written
	Existing map[string]int                 `json:"existing"` // auto-bindings already in the DB, per rule
}

// pdfIndex is the per-run lookup structure. Built once from the PDF list.
type pdfIndex struct {
	byBase    map[string][]*FileRecord // lower-cased base name
	byNumber  map[string][]*FileRecord // every 820-NNNNN in the name
	bySubtree map[string][]*FileRecord // dir, parent, grandparent → PDFs beneath
}

func buildPdfIndex(pdfs []FileRecord) *pdfIndex {
	ix := &pdfIndex{
		byBase:    make(map[string][]*FileRecord),
		byNumber:  make(map[string][]*FileRecord),
		bySubtree: make(map[string][]*FileRecord),
	}
	for i := range pdfs {
		p := &pdfs[i]
		base := baseNameLower(p.Filename)
		ix.byBase[base] = append(ix.byBase[base], p)
		for _, m := range appleBoardRe.FindAllStringSubmatch(p.Filename, -1) {
			n := strings.ToLower(m[1])
			ix.byNumber[n] = append(ix.byNumber[n], p)
		}
		dir := path.Dir(p.Path)
		for lvl := 0; lvl <= maxRadius; lvl++ {
			ix.bySubtree[dir] = append(ix.bySubtree[dir], p)
			if dir == "." || dir == "/" || dir == "" {
				break
			}
			dir = path.Dir(dir)
		}
	}
	return ix
}

// MatchAutoBind runs the ladder over every unbound, non-junk pairing and
// returns the links it would make. Pure: reads nothing, writes nothing.
func MatchAutoBind(boards, pdfs []FileRecord, bound map[int64]bool, rules AutoBindRules) ([]AutoBindCandidate, AutoBindReport) {
	rules = rules.Normalized()
	kept := make([]FileRecord, 0, len(pdfs))
	for _, p := range pdfs {
		if !IsLikelyJunkPdfName(p.Filename) {
			kept = append(kept, p)
		}
	}
	ix := buildPdfIndex(kept)

	// Boards per subtree, for the lone rule's "exactly one board" guard.
	boardsBySubtree := make(map[string]int)
	for i := range boards {
		dir := path.Dir(boards[i].Path)
		for lvl := 0; lvl <= maxRadius; lvl++ {
			boardsBySubtree[dir]++
			if dir == "." || dir == "/" || dir == "" {
				break
			}
			dir = path.Dir(dir)
		}
	}

	report := AutoBindReport{
		Rules:   rules,
		Pdfs:    len(kept),
		Counts:  make(map[string]int),
		Samples: make(map[string][]AutoBindCandidate),
	}
	var out []AutoBindCandidate
	for i := range boards {
		b := &boards[i]
		if bound[b.ID] {
			continue
		}
		report.Boards++
		c, ok := matchOne(b, ix, boardsBySubtree, rules)
		if !ok {
			continue
		}
		out = append(out, c)
		report.Counts[c.Rule]++
		if len(report.Samples[c.Rule]) < sampleLimit {
			report.Samples[c.Rule] = append(report.Samples[c.Rule], c)
		}
	}
	report.Total = len(out)
	return out, report
}

func matchOne(b *FileRecord, ix *pdfIndex, boardsBySubtree map[string]int, rules AutoBindRules) (AutoBindCandidate, bool) {
	boardDir := path.Dir(b.Path)
	mk := func(p *FileRecord, rule string, score int, shared []string) AutoBindCandidate {
		return AutoBindCandidate{
			BoardID: b.ID, PdfID: p.ID, Rule: rule, Score: score,
			BoardName: b.Filename, BoardPath: b.Path, PdfName: p.Filename, PdfPath: p.Path,
			Shared: shared,
		}
	}

	// 1. exact
	if rules.Exact {
		if p := nearest(ix.byBase[baseNameLower(b.Filename)], boardDir); p != nil {
			return mk(p, RuleExact, 100, nil), true
		}
	}
	// 2. number
	if rules.Number {
		if m := appleBoardRe.FindStringSubmatch(b.Filename); m != nil {
			if p := nearest(ix.byNumber[strings.ToLower(m[1])], boardDir); p != nil {
				return mk(p, RuleNumber, 80, nil), true
			}
		}
	}
	// 3. fuzzy
	if rules.Fuzzy.On {
		scope := ancestor(boardDir, rules.Fuzzy.Radius)
		var best *FileRecord
		bestSim, bestDist := 0, 0
		var bestShared []string
		for _, p := range ix.bySubtree[scope] {
			sim, shared := nameSimilarity(b.Filename, p.Filename)
			if sim < rules.Fuzzy.Min {
				continue
			}
			d := folderDistance(boardDir, path.Dir(p.Path))
			if best == nil || sim > bestSim || (sim == bestSim && (d < bestDist || (d == bestDist && p.ID < best.ID))) {
				best, bestSim, bestDist, bestShared = p, sim, d, shared
			}
		}
		if best != nil {
			return mk(best, RuleFuzzy, bestSim, bestShared), true
		}
	}
	// 4. lone
	if rules.Lone.On {
		scope := ancestor(boardDir, rules.Lone.Radius)
		if pdfs := ix.bySubtree[scope]; len(pdfs) == 1 {
			if !rules.Lone.RequireOneBoard || boardsBySubtree[scope] == 1 {
				return mk(pdfs[0], RuleLone, 0, nil), true
			}
		}
	}
	return AutoBindCandidate{}, false
}

// nearest picks the candidate closest to the board's folder; ties go to the
// lowest id so runs are deterministic.
func nearest(cands []*FileRecord, boardDir string) *FileRecord {
	var best *FileRecord
	bestDist := 0
	for _, p := range cands {
		d := folderDistance(boardDir, path.Dir(p.Path))
		if best == nil || d < bestDist || (d == bestDist && p.ID < best.ID) {
			best, bestDist = p, d
		}
	}
	return best
}

// ancestor walks n levels up from dir, stopping at the library root.
func ancestor(dir string, n int) string {
	for ; n > 0; n-- {
		if dir == "." || dir == "/" || dir == "" {
			return "."
		}
		dir = path.Dir(dir)
	}
	return dir
}

// folderDistance counts the steps between two folders through their common
// ancestor (0 = same folder).
func folderDistance(a, b string) int {
	if a == b {
		return 0
	}
	as, bs := splitDir(a), splitDir(b)
	i := 0
	for i < len(as) && i < len(bs) && as[i] == bs[i] {
		i++
	}
	return (len(as) - i) + (len(bs) - i)
}

func splitDir(d string) []string {
	if d == "." || d == "/" || d == "" {
		return nil
	}
	return strings.Split(strings.Trim(d, "/"), "/")
}

func baseNameLower(filename string) string {
	return strings.ToLower(strings.TrimSuffix(filename, path.Ext(filename)))
}

// nameTokens splits a file name into the tokens similarity is judged on:
// runs of letters/digits of at least three characters, lower-cased, deduped.
func nameTokens(filename string) []string {
	base := baseNameLower(filename)
	var toks []string
	seen := make(map[string]bool)
	var cur strings.Builder
	flush := func() {
		if cur.Len() >= 3 {
			t := cur.String()
			if !seen[t] {
				seen[t] = true
				toks = append(toks, t)
			}
		}
		cur.Reset()
	}
	for _, r := range base {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			cur.WriteRune(r)
		} else {
			flush()
		}
	}
	flush()
	return toks
}

// nameSimilarity is the percentage of the SHORTER name's tokens that the
// other name also carries, so "820-00165-A-schematic" against "820-00165-A"
// reads as 100 % rather than 66 %. A name contained in the other is 100 %.
func nameSimilarity(a, b string) (int, []string) {
	ab, bb := baseNameLower(a), baseNameLower(b)
	if ab == bb {
		return 100, nil
	}
	if alnumCount(ab) >= 4 && alnumCount(bb) >= 4 && (strings.Contains(ab, bb) || strings.Contains(bb, ab)) {
		return 100, nil
	}
	at, bt := nameTokens(a), nameTokens(b)
	if len(at) == 0 || len(bt) == 0 {
		return 0, nil
	}
	set := make(map[string]bool, len(bt))
	for _, t := range bt {
		set[t] = true
	}
	var shared []string
	for _, t := range at {
		if set[t] {
			shared = append(shared, t)
		}
	}
	short := len(at)
	if len(bt) < short {
		short = len(bt)
	}
	sort.Strings(shared)
	return len(shared) * 100 / short, shared
}

// AutoBind loads the rules and file lists, runs the ladder, and — unless
// dryRun — writes the links. The report always carries the DB's current
// per-rule counts so the Settings editor can offer "remove links by rule".
func (db *DB) AutoBind(ctx context.Context, rules AutoBindRules, dryRun bool) (AutoBindReport, error) {
	boards, err := db.ListFiles(ctx, "board", "", false)
	if err != nil {
		return AutoBindReport{}, err
	}
	pdfs, err := db.ListFiles(ctx, "pdf", "", false)
	if err != nil {
		return AutoBindReport{}, err
	}
	bound, err := db.BoundBoardIDs(ctx)
	if err != nil {
		return AutoBindReport{}, err
	}
	cands, report := MatchAutoBind(boards, pdfs, bound, rules)
	if !dryRun && len(cands) > 0 {
		n, err := db.InsertAutoBindings(cands)
		if err != nil {
			return report, err
		}
		report.Inserted = n
	}
	if existing, err := db.AutoBindingCounts(ctx); err == nil {
		report.Existing = existing
	}
	return report, nil
}

// LoadAutoBindRules reads the configured rules (defaults when unset).
func (db *DB) LoadAutoBindRules() AutoBindRules {
	v, _ := db.GetConfig(AutoBindRulesKey)
	return ParseAutoBindRules(v)
}
