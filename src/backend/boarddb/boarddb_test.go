package boarddb

import (
	"database/sql"
	"path/filepath"
	"testing"

	_ "modernc.org/sqlite"
)

// schemaDDL mirrors the v2 schema produced by scripts/migrate-boarddb-v2.py
// (final table names after the _v2 rename step). Only the columns queried by
// the Go resolver/hierarchy/stats code are reproduced.
const schemaDDL = `
CREATE TABLE colors (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    hex TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE brands (
    uuid TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    notes TEXT
);
CREATE TABLE families (
    uuid TEXT PRIMARY KEY,
    brand_uuid TEXT NOT NULL,
    name TEXT NOT NULL,
    notes TEXT
);
CREATE TABLE models (
    uuid TEXT PRIMARY KEY,
    family_uuid TEXT NOT NULL,
    model_number TEXT NOT NULL,
    display_name TEXT,
    notes TEXT
);
CREATE TABLE boards (
    uuid TEXT PRIMARY KEY,
    model_uuid TEXT NOT NULL,
    board_number TEXT NOT NULL,
    board_name TEXT,
    odm TEXT,
    board_number_type TEXT,
    source TEXT,
    source_url TEXT,
    notes TEXT
);
CREATE TABLE board_aliases (
    uuid TEXT PRIMARY KEY,
    board_uuid TEXT NOT NULL,
    alias TEXT NOT NULL,
    alias_type TEXT
);
CREATE TABLE model_aliases (
    uuid TEXT PRIMARY KEY,
    model_uuid TEXT NOT NULL,
    alias TEXT NOT NULL,
    alias_type TEXT
);
CREATE TABLE entity_color (
    scope_type TEXT NOT NULL,
    scope_uuid TEXT NOT NULL,
    color_id INTEGER NOT NULL,
    PRIMARY KEY (scope_type, scope_uuid)
);
`

// newTestDB builds a writable boards.db at a temp path, applies the v2 schema,
// seeds a deterministic fixture, then re-opens it through the read-only Open()
// path so tests exercise the exact runtime DSN. Returns nil if Open fails.
//
// Fixture topology (UUIDs are stable strings, not real UUIDs — the resolver
// never validates their form):
//
//	Apple (brand, color=Silver via brand cascade)
//	  └─ MacBook Pro (family)
//	      └─ A2141 (model, alias "MacBookPro16,1")
//	          ├─ 820-01700  (board, ODM Apple, board color=Gold overrides cascade)
//	          └─ 820-01598-A (board, ODM Apple, no own color → inherits Silver)
//	Lenovo (brand)
//	  └─ ThinkPad (family, color=Black via family cascade)
//	      └─ T14 (model)
//	          └─ NM-A251 (board, ODM LCFC, alias "LA-FAKE1")
func newTestDB(t *testing.T) *DB {
	t.Helper()
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "boards.db")

	w, err := sql.Open("sqlite", "file:"+dbPath)
	if err != nil {
		t.Fatalf("open writable db: %v", err)
	}
	if _, err := w.Exec(schemaDDL); err != nil {
		w.Close()
		t.Fatalf("apply schema: %v", err)
	}

	exec := func(q string, args ...any) {
		if _, err := w.Exec(q, args...); err != nil {
			w.Close()
			t.Fatalf("seed %q: %v", q, err)
		}
	}

	// colors
	exec(`INSERT INTO colors (id,name,hex,sort_order) VALUES (1,'Silver','#c0c0c0',1),(2,'Gold','#d4af37',2),(3,'Black','#000000',3)`)

	// Apple branch
	exec(`INSERT INTO brands (uuid,name) VALUES ('br-apple','Apple'),('br-lenovo','Lenovo')`)
	exec(`INSERT INTO families (uuid,brand_uuid,name) VALUES ('fa-mbp','br-apple','MacBook Pro'),('fa-tp','br-lenovo','ThinkPad')`)
	exec(`INSERT INTO models (uuid,family_uuid,model_number,display_name) VALUES ('mo-a2141','fa-mbp','A2141','MacBook Pro 16" 2019'),('mo-t14','fa-tp','T14','ThinkPad T14')`)
	exec(`INSERT INTO boards (uuid,model_uuid,board_number,board_name,odm,board_number_type,source) VALUES
		('bo-01700','mo-a2141','820-01700','Logic Board','Apple','apple_820','seed'),
		('bo-01598','mo-a2141','820-01598-A','Logic Board Rev A','Apple','apple_820','seed'),
		('bo-nm251','mo-t14','NM-A251','Mainboard','LCFC','lenovo_nm','seed')`)
	exec(`INSERT INTO board_aliases (uuid,board_uuid,alias,alias_type) VALUES ('ba-1','bo-nm251','LA-FAKE1','crossref')`)
	exec(`INSERT INTO model_aliases (uuid,model_uuid,alias,alias_type) VALUES ('ma-1','mo-a2141','MacBookPro16,1','marketing')`)

	// color cascade: brand Apple→Silver, family ThinkPad→Black, board 820-01700→Gold override.
	exec(`INSERT INTO entity_color (scope_type,scope_uuid,color_id) VALUES
		('brand','br-apple',1),
		('family','fa-tp',3),
		('board','bo-01700',2)`)

	if err := w.Close(); err != nil {
		t.Fatalf("close writable db: %v", err)
	}

	db := Open(dbPath)
	if db == nil {
		t.Fatalf("Open returned nil for seeded db at %s", dbPath)
	}
	t.Cleanup(db.Close)
	return db
}

func TestResolveExactPrefixRevisionAlias(t *testing.T) {
	db := newTestDB(t)

	tests := []struct {
		name      string
		query     string
		wantBoard string // expected resolved board_number, "" = expect nil
		wantBrand string
		wantColor string // expected resolved color name via cascade
	}{
		{"exact", "820-01700", "820-01700", "Apple", "Gold"},                      // board-level color override
		{"exact lowercase", "820-01700", "820-01700", "Apple", "Gold"},            // case-insensitive
		{"prefix match", "820-01598", "820-01598-A", "Apple", "Silver"},           // prefix → revisioned board; inherits brand Silver
		{"apple revision strip", "820-01598-Z", "820-01598-A", "Apple", "Silver"}, // strip -Z then prefix
		{"lcfc no-hyphen normalize", "NMA251", "NM-A251", "Lenovo", "Black"},      // NMA251 → NM-A251; family Black
		{"board alias", "LA-FAKE1", "NM-A251", "Lenovo", "Black"},                 // alias → NM-A251
		{"miss", "DOES-NOT-EXIST", "", "", ""},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			m := db.Resolve(tc.query)
			if tc.wantBoard == "" {
				if m != nil {
					t.Fatalf("expected nil match, got %+v", m)
				}
				return
			}
			if m == nil {
				t.Fatalf("expected match for %q, got nil", tc.query)
			}
			if m.BoardNumber != tc.wantBoard {
				t.Errorf("board_number = %q, want %q", m.BoardNumber, tc.wantBoard)
			}
			if m.Brand != tc.wantBrand {
				t.Errorf("brand = %q, want %q", m.Brand, tc.wantBrand)
			}
			if m.Color != tc.wantColor {
				t.Errorf("color = %q, want %q (cascade)", m.Color, tc.wantColor)
			}
		})
	}
}

func TestResolveCaseInsensitive(t *testing.T) {
	db := newTestDB(t)
	for _, q := range []string{"nm-a251", "Nm-A251", "  NM-A251  "} {
		m := db.Resolve(q)
		if m == nil || m.BoardNumber != "NM-A251" {
			t.Errorf("Resolve(%q) failed to match NM-A251: %+v", q, m)
		}
	}
	if db.Resolve("") != nil {
		t.Errorf("empty query must resolve to nil")
	}
}

func TestResolveAliasesPopulated(t *testing.T) {
	db := newTestDB(t)
	m := db.Resolve("A2141-not-a-board") // miss, but ensure no panic
	if m != nil {
		t.Fatalf("expected miss")
	}
	m = db.Resolve("820-01700")
	if m == nil {
		t.Fatalf("expected match")
	}
	// model alias should surface
	found := false
	for _, a := range m.ModelAliases {
		if a == "MacBookPro16,1" {
			found = true
		}
	}
	if !found {
		t.Errorf("model alias MacBookPro16,1 missing from %+v", m.ModelAliases)
	}
}

func TestResolveByAlias(t *testing.T) {
	db := newTestDB(t)
	m := db.ResolveByAlias("la-fake1")
	if m == nil || m.BoardNumber != "NM-A251" {
		t.Fatalf("ResolveByAlias(la-fake1) = %+v, want NM-A251", m)
	}
	if db.ResolveByAlias("nope") != nil {
		t.Errorf("unknown alias must be nil")
	}
}

func TestResolveFilename(t *testing.T) {
	db := newTestDB(t)
	extracted, m := db.ResolveFilename("Apple MacBook Pro 820-01700-B logic board.brd")
	if len(extracted) == 0 {
		t.Fatalf("expected at least one extracted number")
	}
	if m == nil || m.BoardNumber != "820-01700" {
		t.Fatalf("ResolveFilename match = %+v, want 820-01700", m)
	}

	// Filename with no recognizable board number → extracted empty, match nil.
	ex2, m2 := db.ResolveFilename("random_notes.txt")
	if m2 != nil {
		t.Errorf("expected nil match for unrecognized filename, got %+v", m2)
	}
	_ = ex2
}

func TestStats(t *testing.T) {
	db := newTestDB(t)
	s := db.Stats()
	if s.Total != 3 {
		t.Errorf("total boards = %d, want 3", s.Total)
	}
	if s.ByBrand["Apple"] != 2 {
		t.Errorf("Apple board count = %d, want 2", s.ByBrand["Apple"])
	}
	if s.ByBrand["Lenovo"] != 1 {
		t.Errorf("Lenovo board count = %d, want 1", s.ByBrand["Lenovo"])
	}
	if s.ByODM["Apple"] != 2 {
		t.Errorf("Apple ODM count = %d, want 2", s.ByODM["Apple"])
	}
	if s.ByODM["LCFC"] != 1 {
		t.Errorf("LCFC ODM count = %d, want 1", s.ByODM["LCFC"])
	}
	if s.AliasCount != 1 {
		t.Errorf("alias count = %d, want 1", s.AliasCount)
	}
}

func TestHierarchy(t *testing.T) {
	db := newTestDB(t)
	brands := db.Hierarchy()
	if len(brands) != 2 {
		t.Fatalf("expected 2 brands, got %d", len(brands))
	}
	byName := map[string]*HierarchyBrand{}
	for _, b := range brands {
		byName[b.Name] = b
	}
	apple := byName["Apple"]
	if apple == nil {
		t.Fatalf("Apple brand missing")
	}
	if len(apple.Families) != 1 || apple.Families[0].Name != "MacBook Pro" {
		t.Fatalf("Apple families = %+v", apple.Families)
	}
	mbp := apple.Families[0]
	if len(mbp.Models) != 1 || mbp.Models[0].ModelNumber != "A2141" {
		t.Fatalf("MacBook Pro models = %+v", mbp.Models)
	}
	model := mbp.Models[0]
	if len(model.Boards) != 2 {
		t.Errorf("A2141 boards = %d, want 2", len(model.Boards))
	}
	if len(model.Aliases) != 1 || model.Aliases[0].Alias != "MacBookPro16,1" {
		t.Errorf("A2141 model aliases = %+v", model.Aliases)
	}
	// Board alias attached to the LCFC board under Lenovo.
	lenovo := byName["Lenovo"]
	if lenovo == nil {
		t.Fatalf("Lenovo brand missing")
	}
	var sawBoardAlias bool
	for _, fam := range lenovo.Families {
		for _, mo := range fam.Models {
			for _, bd := range mo.Boards {
				for _, al := range bd.Aliases {
					if al.Alias == "LA-FAKE1" {
						sawBoardAlias = true
					}
				}
			}
		}
	}
	if !sawBoardAlias {
		t.Errorf("board alias LA-FAKE1 not attached in hierarchy")
	}
}

// TestExtractBoardNumbers exercises the ODM matcher directly (matcher.go).
func TestExtractBoardNumbers(t *testing.T) {
	tests := []struct {
		name     string
		filename string
		wantNum  string
		wantODM  string
	}{
		{"apple 820", "MacBook 820-01700-B.brd", "820-01700-B", "Apple"},
		{"compal la", "Dell Inspiron LA-K371P rev1.0.bin", "LA-K371P", "Compal"},
		{"lcfc nm", "Lenovo JY575 NM-A251 R10.brd", "NM-A251", "LCFC"},
		{"quanta da", "Quanta_Z8IA_DAZ8IAMBAC0.brd", "DAZ8IAMBAC0", "Quanta"},
		{"msi ms", "MSI MS-1812 mainboard.bin", "MS-1812", "MSI"},
		{"no match", "just_a_readme.txt", "", ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := ExtractBoardNumbers(tc.filename)
			if tc.wantNum == "" {
				if len(got) != 0 {
					t.Fatalf("expected no extraction, got %+v", got)
				}
				return
			}
			if len(got) == 0 {
				t.Fatalf("expected to extract %q, got nothing", tc.wantNum)
			}
			// The first match should be the most specific one.
			found := false
			for _, e := range got {
				if e.Number == tc.wantNum {
					found = true
					if e.ODM != tc.wantODM {
						t.Errorf("ODM for %q = %q, want %q", tc.wantNum, e.ODM, tc.wantODM)
					}
				}
			}
			if !found {
				t.Errorf("expected %q among extracted %+v", tc.wantNum, got)
			}
		})
	}
}

// TestExtractDedupesNumbers verifies the same board number appearing twice in a
// filename is returned once.
func TestExtractDedupesNumbers(t *testing.T) {
	got := ExtractBoardNumbers("820-01700 copy of 820-01700.brd")
	count := 0
	for _, e := range got {
		if e.Number == "820-01700" {
			count++
		}
	}
	if count != 1 {
		t.Errorf("duplicate board number should be deduped, got %d occurrences", count)
	}
}

// TestNilDBSafe verifies all entry points are safe against a nil/unavailable DB.
func TestNilDBSafe(t *testing.T) {
	var db *DB // nil
	if db.Available() {
		t.Errorf("nil DB must not be Available")
	}
	if db.Resolve("820-01700") != nil {
		t.Errorf("nil DB Resolve must be nil")
	}
	if db.ResolveByAlias("x") != nil {
		t.Errorf("nil DB ResolveByAlias must be nil")
	}
	if db.Hierarchy() != nil {
		t.Errorf("nil DB Hierarchy must be nil")
	}
	s := db.Stats()
	if s.Total != 0 {
		t.Errorf("nil DB Stats must be zero, got %+v", s)
	}
	db.Close() // must not panic
}
