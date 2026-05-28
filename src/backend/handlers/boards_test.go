package handlers

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"boardripper/boarddb"

	_ "modernc.org/sqlite"
)

// boardsSchemaDDL is the minimal v2 schema (final table names) needed by the
// boarddb resolver/hierarchy/stats queries. Mirrors scripts/migrate-boarddb-v2.py.
const boardsSchemaDDL = `
CREATE TABLE colors (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, hex TEXT, sort_order INTEGER NOT NULL DEFAULT 0);
CREATE TABLE brands (uuid TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, notes TEXT);
CREATE TABLE families (uuid TEXT PRIMARY KEY, brand_uuid TEXT NOT NULL, name TEXT NOT NULL, notes TEXT);
CREATE TABLE models (uuid TEXT PRIMARY KEY, family_uuid TEXT NOT NULL, model_number TEXT NOT NULL, display_name TEXT, notes TEXT);
CREATE TABLE boards (uuid TEXT PRIMARY KEY, model_uuid TEXT NOT NULL, board_number TEXT NOT NULL, board_name TEXT, odm TEXT, board_number_type TEXT, source TEXT, source_url TEXT, notes TEXT);
CREATE TABLE board_aliases (uuid TEXT PRIMARY KEY, board_uuid TEXT NOT NULL, alias TEXT NOT NULL, alias_type TEXT);
CREATE TABLE model_aliases (uuid TEXT PRIMARY KEY, model_uuid TEXT NOT NULL, alias TEXT NOT NULL, alias_type TEXT);
CREATE TABLE entity_color (scope_type TEXT NOT NULL, scope_uuid TEXT NOT NULL, color_id INTEGER NOT NULL, PRIMARY KEY (scope_type, scope_uuid));
`

// newSeededBoardsDB builds a temp boards.db, seeds one Apple board, and opens
// it read-only through boarddb.Open (the runtime path).
func newSeededBoardsDB(t *testing.T) *boarddb.DB {
	t.Helper()
	dbPath := filepath.Join(t.TempDir(), "boards.db")
	w, err := sql.Open("sqlite", "file:"+dbPath)
	if err != nil {
		t.Fatalf("open writable: %v", err)
	}
	if _, err := w.Exec(boardsSchemaDDL); err != nil {
		w.Close()
		t.Fatalf("schema: %v", err)
	}
	stmts := []string{
		`INSERT INTO colors (id,name,hex) VALUES (1,'Silver','#c0c0c0')`,
		`INSERT INTO brands (uuid,name) VALUES ('br-apple','Apple')`,
		`INSERT INTO families (uuid,brand_uuid,name) VALUES ('fa-mbp','br-apple','MacBook Pro')`,
		`INSERT INTO models (uuid,family_uuid,model_number,display_name) VALUES ('mo-a2141','fa-mbp','A2141','MacBook Pro 16')`,
		`INSERT INTO boards (uuid,model_uuid,board_number,odm,board_number_type) VALUES ('bo-1','mo-a2141','820-01700','Apple','apple_820')`,
		`INSERT INTO entity_color (scope_type,scope_uuid,color_id) VALUES ('brand','br-apple',1)`,
	}
	for _, s := range stmts {
		if _, err := w.Exec(s); err != nil {
			w.Close()
			t.Fatalf("seed %q: %v", s, err)
		}
	}
	w.Close()

	db := boarddb.Open(dbPath)
	if db == nil {
		t.Fatalf("boarddb.Open returned nil")
	}
	t.Cleanup(db.Close)
	return db
}

func TestBoardsResolveHit(t *testing.T) {
	h := NewBoardsHandler(newSeededBoardsDB(t))
	req := httptest.NewRequest("GET", "/api/boards/resolve?q=820-01700", nil)
	w := httptest.NewRecorder()
	h.Resolve(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("code = %d, body = %s", w.Code, w.Body.String())
	}
	var resp struct {
		Extracted []boarddb.ExtractedNumber `json:"extracted"`
		Match     *boarddb.BoardMatch       `json:"match"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v (body=%s)", err, w.Body.String())
	}
	if resp.Match == nil {
		t.Fatalf("expected match, got nil (body=%s)", w.Body.String())
	}
	if resp.Match.BoardNumber != "820-01700" {
		t.Errorf("board_number = %q, want 820-01700", resp.Match.BoardNumber)
	}
	if resp.Match.Brand != "Apple" {
		t.Errorf("brand = %q, want Apple", resp.Match.Brand)
	}
	if resp.Match.Color != "Silver" {
		t.Errorf("color = %q, want Silver (brand cascade)", resp.Match.Color)
	}
}

func TestBoardsResolveMiss(t *testing.T) {
	h := NewBoardsHandler(newSeededBoardsDB(t))
	req := httptest.NewRequest("GET", "/api/boards/resolve?q=ZZZ-NOPE", nil)
	w := httptest.NewRecorder()
	h.Resolve(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("code = %d", w.Code)
	}
	var resp struct {
		Match *boarddb.BoardMatch `json:"match"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if resp.Match != nil {
		t.Errorf("expected nil match for unknown board, got %+v", resp.Match)
	}
}

func TestBoardsResolveMissingParam(t *testing.T) {
	h := NewBoardsHandler(newSeededBoardsDB(t))
	req := httptest.NewRequest("GET", "/api/boards/resolve", nil)
	w := httptest.NewRecorder()
	h.Resolve(w, req)
	if w.Code != http.StatusBadRequest {
		t.Errorf("missing q should be 400, got %d", w.Code)
	}
}

func TestBoardsHierarchy(t *testing.T) {
	h := NewBoardsHandler(newSeededBoardsDB(t))
	req := httptest.NewRequest("GET", "/api/boards/hierarchy", nil)
	w := httptest.NewRecorder()
	h.Hierarchy(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("code = %d", w.Code)
	}
	var resp struct {
		Available bool                      `json:"available"`
		Brands    []*boarddb.HierarchyBrand `json:"brands"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v (body=%s)", err, w.Body.String())
	}
	if !resp.Available {
		t.Fatalf("expected available=true")
	}
	if len(resp.Brands) != 1 || resp.Brands[0].Name != "Apple" {
		t.Fatalf("expected 1 Apple brand, got %+v", resp.Brands)
	}
}

func TestBoardsStats(t *testing.T) {
	h := NewBoardsHandler(newSeededBoardsDB(t))
	req := httptest.NewRequest("GET", "/api/boards/stats", nil)
	w := httptest.NewRecorder()
	h.Stats(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("code = %d", w.Code)
	}
	var resp struct {
		Available bool `json:"available"`
		Stats     struct {
			Total   int            `json:"total"`
			ByBrand map[string]int `json:"by_brand"`
			ByODM   map[string]int `json:"by_odm"`
		} `json:"stats"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if !resp.Available || resp.Stats.Total != 1 {
		t.Fatalf("stats = %+v", resp)
	}
	if resp.Stats.ByBrand["Apple"] != 1 || resp.Stats.ByODM["Apple"] != 1 {
		t.Errorf("brand/ODM counts wrong: %+v", resp.Stats)
	}
}

// TestBoardsHandlerNilDB verifies the handlers degrade gracefully when the
// board database is unavailable (nil handle) — they must report available=false
// rather than panic.
func TestBoardsHandlerNilDB(t *testing.T) {
	h := NewBoardsHandler(nil)

	// Resolve with q still returns 200 and an empty match.
	req := httptest.NewRequest("GET", "/api/boards/resolve?q=820-01700", nil)
	w := httptest.NewRecorder()
	h.Resolve(w, req)
	if w.Code != http.StatusOK {
		t.Errorf("resolve nil-db code = %d", w.Code)
	}

	for _, tc := range []struct {
		name string
		fn   func(http.ResponseWriter, *http.Request)
		path string
	}{
		{"hierarchy", h.Hierarchy, "/api/boards/hierarchy"},
		{"stats", h.Stats, "/api/boards/stats"},
	} {
		req := httptest.NewRequest("GET", tc.path, nil)
		w := httptest.NewRecorder()
		tc.fn(w, req)
		if w.Code != http.StatusOK {
			t.Errorf("%s nil-db code = %d", tc.name, w.Code)
		}
		var resp map[string]any
		if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
			t.Errorf("%s unmarshal: %v", tc.name, err)
			continue
		}
		if resp["available"] != false {
			t.Errorf("%s nil-db should report available=false, got %v", tc.name, resp["available"])
		}
	}
}
