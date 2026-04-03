# Board Database Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate a read-only Board Database (`boards.db`) into the Go backend as an ODM-aware board number resolution engine, enhancing the scanner's metadata extraction from ~1 pattern (Apple 820-XXXXX) to 18 patterns covering all major ODMs.

**Architecture:** New `boarddb` package opens `boards.db` read-only alongside the existing `databank.db`. ODM pattern registry maps regex patterns → board manufacturers. Scanner calls `boarddb.ExtractBoardNumbers()` + `boarddb.Resolve()` during file processing. New API endpoints expose resolution, re-resolve, import, and stats. Schema migration v4 adds `board_manufacturer` and `resolution_status` columns.

**Tech Stack:** Go (net/http, regexp, modernc.org/sqlite), SQLite

**Spec:** `docs/superpowers/specs/2026-04-03-board-database-integration-design.md`

---

## File Map

**Backend (create):**
- `src/backend/boarddb/boarddb.go` — DB connection lifecycle, stats, close
- `src/backend/boarddb/odm.go` — ODM pattern registry (18 compiled regexes + ODM mapping)
- `src/backend/boarddb/matcher.go` — `ExtractBoardNumbers(filename)` applies all patterns
- `src/backend/boarddb/resolve.go` — `Resolve(boardNumber)` queries boards.db
- `src/backend/boarddb/boarddb_test.go` — tests for matcher + resolver
- `src/backend/handlers/boards.go` — HTTP handlers for `/api/boards/*` endpoints

**Backend (modify):**
- `src/backend/main.go` — initialize boarddb, register new routes
- `src/backend/databank/db.go` — schema v4 migration (new columns), update FileRecord struct
- `src/backend/databank/metadata.go` — replace limited regex with boarddb calls
- `src/backend/databank/scanner.go` — pass boarddb to scanner, wire re-resolve
- `src/backend/handlers/databank.go` — add rename endpoint

**Data (copy into Docker):**
- `Board Database/boards.db` — pre-built reference database (252 boards)

---

## Task 1: boarddb Package — Types and DB Connection

**Files:**
- Create: `src/backend/boarddb/boarddb.go`

- [ ] **Step 1: Create boarddb package with types and Open function**

```go
package boarddb

import (
	"database/sql"
	"fmt"
	"log"
	"os"
	"sync"

	_ "modernc.org/sqlite"
)

// BoardMatch is the result of resolving a board number against the reference DB.
type BoardMatch struct {
	BoardNumber  string   `json:"board_number"`
	Brand        string   `json:"brand"`
	Model        string   `json:"model"`
	ModelNumber  string   `json:"model_number,omitempty"`
	BoardName    string   `json:"board_name,omitempty"`
	ODM          string   `json:"odm"`
	Type         string   `json:"board_number_type,omitempty"`
	Aliases      []string `json:"aliases,omitempty"`
	ModelAliases []string `json:"model_aliases,omitempty"`
	Source       string   `json:"source,omitempty"`
}

// ExtractedNumber is a board number found in a filename by the regex matcher.
type ExtractedNumber struct {
	Number string `json:"number"` // e.g. "LA-K371P"
	ODM    string `json:"odm"`    // e.g. "Compal"
	Type   string `json:"type"`   // e.g. "compal_la"
}

// DB is a read-only handle to the boards.db reference database.
type DB struct {
	reader *sql.DB
	mu     sync.RWMutex // protects reader during import/swap
}

// Open opens boards.db at the given path in read-only mode.
// Returns nil (not error) if the file does not exist — feature is disabled.
func Open(dbPath string) *DB {
	if _, err := os.Stat(dbPath); os.IsNotExist(err) {
		log.Printf("[boarddb] %s not found — board resolution disabled", dbPath)
		return nil
	}
	dsn := fmt.Sprintf("file:%s?mode=ro&_journal_mode=WAL", dbPath)
	reader, err := sql.Open("sqlite", dsn)
	if err != nil {
		log.Printf("[boarddb] failed to open %s: %v", dbPath, err)
		return nil
	}
	reader.SetMaxOpenConns(2)
	// Quick validation
	var count int
	if err := reader.QueryRow("SELECT count(*) FROM boards").Scan(&count); err != nil {
		log.Printf("[boarddb] invalid boards.db schema: %v", err)
		reader.Close()
		return nil
	}
	log.Printf("[boarddb] loaded %d boards from %s", count, dbPath)
	return &DB{reader: reader}
}

// Available returns true if the board database is loaded and usable.
func (db *DB) Available() bool {
	return db != nil && db.reader != nil
}

// Close closes the database connection.
func (db *DB) Close() {
	if db != nil && db.reader != nil {
		db.reader.Close()
	}
}

// Stats returns board count grouped by brand.
type BoardStats struct {
	Total       int            `json:"total"`
	ByBrand     map[string]int `json:"by_brand"`
	ByODM       map[string]int `json:"by_odm"`
	AliasCount  int            `json:"alias_count"`
}

func (db *DB) Stats() BoardStats {
	if !db.Available() {
		return BoardStats{}
	}
	db.mu.RLock()
	defer db.mu.RUnlock()

	s := BoardStats{ByBrand: map[string]int{}, ByODM: map[string]int{}}
	db.reader.QueryRow("SELECT count(*) FROM boards").Scan(&s.Total)
	db.reader.QueryRow("SELECT count(*) FROM board_aliases").Scan(&s.AliasCount)

	rows, _ := db.reader.Query("SELECT brand, count(*) FROM boards GROUP BY brand")
	if rows != nil {
		defer rows.Close()
		for rows.Next() {
			var brand string
			var cnt int
			rows.Scan(&brand, &cnt)
			s.ByBrand[brand] = cnt
		}
	}
	rows2, _ := db.reader.Query("SELECT odm, count(*) FROM boards WHERE odm IS NOT NULL GROUP BY odm")
	if rows2 != nil {
		defer rows2.Close()
		for rows2.Next() {
			var odm string
			var cnt int
			rows2.Scan(&odm, &cnt)
			s.ByODM[odm] = cnt
		}
	}
	return s
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd src/backend && go build ./boarddb/`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/backend/boarddb/boarddb.go
git commit -m "feat(boarddb): add boarddb package with types, Open, Stats"
```

---

## Task 2: ODM Pattern Registry

**Files:**
- Create: `src/backend/boarddb/odm.go`

- [ ] **Step 1: Create ODM pattern registry with all 18 patterns**

```go
package boarddb

import "regexp"

// ODMPattern maps a compiled regex to the ODM (board manufacturer) that uses it.
type ODMPattern struct {
	ODM      string
	Type     string
	Pattern  *regexp.Regexp
	Priority int
}

// odmPatterns is the registry of all known board number patterns,
// ordered by specificity (most distinctive first).
var odmPatterns = []ODMPattern{
	{ODM: "Apple", Type: "apple_820", Pattern: regexp.MustCompile(`\b820-\d{4,5}(?:-[A-Z])?\b`)},
	{ODM: "Apple", Type: "apple_661", Pattern: regexp.MustCompile(`\b661-\d{5}\b`)},
	{ODM: "LCFC", Type: "lenovo_nm", Pattern: regexp.MustCompile(`(?i)\bNM-[A-Z]\d{3,4}\b`)},
	{ODM: "Compal", Type: "compal_la", Pattern: regexp.MustCompile(`(?i)\bLA-[A-Z]?\d{3,4}[A-Z]?\b`)},
	{ODM: "Quanta", Type: "quanta_da0", Pattern: regexp.MustCompile(`(?i)\bDA[0A-Z][A-Z0-9]{2,8}MB[0-9A-Z]{2,5}\b`)},
	{ODM: "ASUS", Type: "asus_60nb", Pattern: regexp.MustCompile(`(?i)\b60N[BR][A-Z0-9]{4}-MB[A-Z0-9]{4,5}\b`)},
	{ODM: "Wistron", Type: "wistron_448", Pattern: regexp.MustCompile(`\b448\.\d{2}[A-Z]\d{2}\.\d{3,4}\b`)},
	{ODM: "Inventec", Type: "inventec_6050a", Pattern: regexp.MustCompile(`\b6050A\d{7,10}\b`)},
	{ODM: "Acer", Type: "acer_mb", Pattern: regexp.MustCompile(`\bMB\.[A-Z0-9]{5}\.\d{3}\b`)},
	{ODM: "Lenovo", Type: "lenovo_fru_new", Pattern: regexp.MustCompile(`\b5B\d{2}[A-Z]\d{5}\b`)},
	{ODM: "Lenovo", Type: "lenovo_fru_old", Pattern: regexp.MustCompile(`\b\d{2}X\d{4,5}\b`)},
	{ODM: "MSI", Type: "msi_ms", Pattern: regexp.MustCompile(`(?i)\bMS-\d{4,5}\b`)},
	{ODM: "Sony", Type: "sony_mbx", Pattern: regexp.MustCompile(`(?i)\bMBX-\d{2,3}\b`)},
	{ODM: "Samsung", Type: "samsung_ba", Pattern: regexp.MustCompile(`\bBA4[12]-\d{5}\b`)},
	{ODM: "Razer", Type: "razer_rz", Pattern: regexp.MustCompile(`(?i)\bRZ09-\d{4}\b`)},
	{ODM: "Clevo", Type: "clevo", Pattern: regexp.MustCompile(`(?i)\bN[HPB]\d{2}[A-Z]{2,4}\b`)},
	{ODM: "HP", Type: "hp_spare", Pattern: regexp.MustCompile(`\b[A-Z]?\d{5,6}-\d{3}\b`)},
	{ODM: "Wistron", Type: "wistron_numeric", Pattern: regexp.MustCompile(`\b\d{4,5}-\d[A-Z]?\b`)},
}

// ODMForType returns the ODM name for a given board_number_type string.
func ODMForType(boardType string) string {
	for _, p := range odmPatterns {
		if p.Type == boardType {
			return p.ODM
		}
	}
	return ""
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd src/backend && go build ./boarddb/`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/backend/boarddb/odm.go
git commit -m "feat(boarddb): ODM pattern registry with 18 board number patterns"
```

---

## Task 3: Board Number Matcher

**Files:**
- Create: `src/backend/boarddb/matcher.go`
- Create: `src/backend/boarddb/boarddb_test.go`

- [ ] **Step 1: Write tests for ExtractBoardNumbers**

```go
package boarddb

import "testing"

func TestExtractBoardNumbers(t *testing.T) {
	tests := []struct {
		filename string
		want     []ExtractedNumber
	}{
		{"820-02016-A.brd", []ExtractedNumber{{Number: "820-02016-A", ODM: "Apple", Type: "apple_820"}}},
		{"random_junk_820-02016.brd", []ExtractedNumber{{Number: "820-02016", ODM: "Apple", Type: "apple_820"}}},
		{"NM-B741 Ariel-SVT.tvw", []ExtractedNumber{{Number: "NM-B741", ODM: "LCFC", Type: "lenovo_nm"}}},
		{"Compal LA-C881P boardview", []ExtractedNumber{{Number: "LA-C881P", ODM: "Compal", Type: "compal_la"}}},
		{"DA0NJJMBAG0.cad", []ExtractedNumber{{Number: "DA0NJJMBAG0", ODM: "Quanta", Type: "quanta_da0"}}},
		{"60NR02T0-MB7010 r1.3.fz", []ExtractedNumber{{Number: "60NR02T0-MB7010", ODM: "ASUS", Type: "asus_60nb"}}},
		{"MS-17G11.pdf", []ExtractedNumber{{Number: "MS-17G11", ODM: "MSI", Type: "msi_ms"}}},
		{"no_board_here.pdf", nil},
	}
	for _, tt := range tests {
		t.Run(tt.filename, func(t *testing.T) {
			got := ExtractBoardNumbers(tt.filename)
			if len(got) != len(tt.want) {
				t.Fatalf("ExtractBoardNumbers(%q) = %d results, want %d", tt.filename, len(got), len(tt.want))
			}
			for i, g := range got {
				if g.Number != tt.want[i].Number || g.ODM != tt.want[i].ODM || g.Type != tt.want[i].Type {
					t.Errorf("result[%d] = %+v, want %+v", i, g, tt.want[i])
				}
			}
		})
	}
}
```

- [ ] **Step 2: Run tests — expect FAIL (function not defined)**

Run: `cd src/backend && go test ./boarddb/ -run TestExtract -v`
Expected: compilation error, `ExtractBoardNumbers` undefined

- [ ] **Step 3: Implement ExtractBoardNumbers**

```go
package boarddb

import "strings"

// ExtractBoardNumbers applies all ODM regex patterns against a filename
// and returns all matched board numbers with their ODM classification.
// Results are ordered by pattern priority (most distinctive first).
func ExtractBoardNumbers(filename string) []ExtractedNumber {
	var results []ExtractedNumber
	seen := map[string]bool{}

	for _, odm := range odmPatterns {
		matches := odm.Pattern.FindAllString(filename, -1)
		for _, m := range matches {
			upper := strings.ToUpper(m)
			if seen[upper] {
				continue
			}
			seen[upper] = true
			results = append(results, ExtractedNumber{
				Number: upper,
				ODM:    odm.ODM,
				Type:   odm.Type,
			})
		}
	}
	return results
}
```

- [ ] **Step 4: Run tests — expect PASS**

Run: `cd src/backend && go test ./boarddb/ -run TestExtract -v`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add src/backend/boarddb/matcher.go src/backend/boarddb/boarddb_test.go
git commit -m "feat(boarddb): ExtractBoardNumbers matcher with tests"
```

---

## Task 4: Board Number Resolver

**Files:**
- Create: `src/backend/boarddb/resolve.go`
- Modify: `src/backend/boarddb/boarddb_test.go`

- [ ] **Step 1: Write test for Resolve (requires real boards.db)**

Add to `boarddb_test.go`:

```go
import (
	"os"
	"path/filepath"
	"testing"
)

func testDB(t *testing.T) *DB {
	t.Helper()
	// Use the real boards.db from the project root
	root := filepath.Join("..", "..", "Board Database", "boards.db")
	if _, err := os.Stat(root); os.IsNotExist(err) {
		t.Skip("boards.db not found — skipping resolver tests")
	}
	db := Open(root)
	if db == nil {
		t.Fatal("failed to open boards.db")
	}
	t.Cleanup(func() { db.Close() })
	return db
}

func TestResolve(t *testing.T) {
	db := testDB(t)
	tests := []struct {
		query     string
		wantBrand string
		wantODM   string
	}{
		{"820-02016-A", "Apple", "Apple"},
		{"820-02016", "Apple", "Apple"},      // partial match
		{"LA-C881P", "Dell", "Compal"},
		{"NM-B741", "Lenovo", "LCFC"},
		{"NONEXISTENT-999", "", ""},           // no match
	}
	for _, tt := range tests {
		t.Run(tt.query, func(t *testing.T) {
			match := db.Resolve(tt.query)
			if tt.wantBrand == "" {
				if match != nil {
					t.Fatalf("Resolve(%q) = %+v, want nil", tt.query, match)
				}
				return
			}
			if match == nil {
				t.Fatalf("Resolve(%q) = nil, want brand=%s", tt.query, tt.wantBrand)
			}
			if match.Brand != tt.wantBrand {
				t.Errorf("brand = %q, want %q", match.Brand, tt.wantBrand)
			}
			if match.ODM != tt.wantODM {
				t.Errorf("odm = %q, want %q", match.ODM, tt.wantODM)
			}
		})
	}
}
```

- [ ] **Step 2: Run test — expect FAIL**

Run: `cd src/backend && go test ./boarddb/ -run TestResolve -v`
Expected: `Resolve` undefined

- [ ] **Step 3: Implement Resolve**

```go
package boarddb

import "strings"

// Resolve looks up a board number in the reference database.
// Checks: exact match → prefix match (820-02016 → 820-02016-A) → alias match.
// Returns nil if not found.
func (db *DB) Resolve(boardNumber string) *BoardMatch {
	if !db.Available() {
		return nil
	}
	db.mu.RLock()
	defer db.mu.RUnlock()

	upper := strings.ToUpper(boardNumber)

	// 1. Exact match
	m := db.queryBoard("SELECT id, brand, model, model_number, board_number, board_name, odm, board_number_type, source FROM boards WHERE upper(board_number) = ?", upper)
	if m != nil {
		return m
	}

	// 2. Prefix match (820-02016 matches 820-02016-A)
	m = db.queryBoard("SELECT id, brand, model, model_number, board_number, board_name, odm, board_number_type, source FROM boards WHERE board_number LIKE ? LIMIT 1", upper+"-%")
	if m != nil {
		return m
	}

	// 3. Alias match
	var boardID int64
	err := db.reader.QueryRow("SELECT board_id FROM board_aliases WHERE upper(alias_number) = ? LIMIT 1", upper).Scan(&boardID)
	if err != nil {
		return nil
	}
	return db.queryBoard("SELECT id, brand, model, model_number, board_number, board_name, odm, board_number_type, source FROM boards WHERE id = ?", boardID)
}

func (db *DB) queryBoard(query string, args ...any) *BoardMatch {
	var id int64
	m := &BoardMatch{}
	var modelNum, boardName, odm, boardType, source *string
	err := db.reader.QueryRow(query, args...).Scan(
		&id, &m.Brand, &m.Model, &modelNum, &m.BoardNumber, &boardName, &odm, &boardType, &source,
	)
	if err != nil {
		return nil
	}
	if modelNum != nil { m.ModelNumber = *modelNum }
	if boardName != nil { m.BoardName = *boardName }
	if odm != nil { m.ODM = *odm }
	if boardType != nil { m.Type = *boardType }
	if source != nil { m.Source = *source }

	// Load aliases
	rows, _ := db.reader.Query("SELECT alias_number FROM board_aliases WHERE board_id = ?", id)
	if rows != nil {
		defer rows.Close()
		for rows.Next() {
			var a string
			rows.Scan(&a)
			m.Aliases = append(m.Aliases, a)
		}
	}

	// Load model aliases
	rows2, _ := db.reader.Query("SELECT model_name FROM model_aliases WHERE board_id = ?", id)
	if rows2 != nil {
		defer rows2.Close()
		for rows2.Next() {
			var a string
			rows2.Scan(&a)
			m.ModelAliases = append(m.ModelAliases, a)
		}
	}
	return m
}
```

- [ ] **Step 4: Run tests — expect PASS**

Run: `cd src/backend && go test ./boarddb/ -run TestResolve -v`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add src/backend/boarddb/resolve.go src/backend/boarddb/boarddb_test.go
git commit -m "feat(boarddb): Resolve() queries boards.db with exact, prefix, and alias matching"
```

---

## Task 5: Schema Migration v4

**Files:**
- Modify: `src/backend/databank/db.go`

- [ ] **Step 1: Bump schema version and add migrateV4**

In `db.go`, change `schemaVersion = 3` to `schemaVersion = 4`.

In `migrate()`, add case for v4 after v3:

```go
case 3:
    if err := db.migrateV4(); err != nil {
        return fmt.Errorf("migrate v4: %w", err)
    }
    fallthrough
```

Add the migration function:

```go
func (db *DB) migrateV4() error {
	_, err := db.writer.Exec(`
		ALTER TABLE files ADD COLUMN board_manufacturer TEXT;
		ALTER TABLE files ADD COLUMN resolution_status TEXT NOT NULL DEFAULT 'unresolved';
	`)
	if err != nil {
		return err
	}
	_, err = db.writer.Exec(`
		CREATE INDEX IF NOT EXISTS idx_files_resolution ON files(resolution_status);
		CREATE INDEX IF NOT EXISTS idx_files_board_mfg ON files(board_manufacturer);
	`)
	return err
}
```

- [ ] **Step 2: Update FileRecord struct**

Add two new fields to `FileRecord`:

```go
BoardManufacturer string // ODM: "Compal", "Quanta", etc.
ResolutionStatus  string // "resolved", "pattern_matched", "unresolved"
```

- [ ] **Step 3: Update InsertFileTx to include new columns**

Add `board_manufacturer` and `resolution_status` to the INSERT statement and values.

- [ ] **Step 4: Update query methods to read new columns**

Update `AllFilePaths()`, `ListFiles()`, `GetFileByID()` to SELECT the new columns.

- [ ] **Step 5: Verify compilation and existing tests pass**

Run: `cd src/backend && go build ./... && go test ./databank/ -v`
Expected: PASS (migration will auto-run on next DB open)

- [ ] **Step 6: Commit**

```bash
git add src/backend/databank/db.go
git commit -m "feat(databank): schema v4 migration — board_manufacturer + resolution_status columns"
```

---

## Task 6: Enhanced Metadata Extraction

**Files:**
- Modify: `src/backend/databank/metadata.go`
- Modify: `src/backend/databank/scanner.go`

- [ ] **Step 1: Add boarddb dependency to Scanner**

In `scanner.go`, add `boardDB *boarddb.DB` field to `Scanner` struct. Update `NewScanner` to accept and store it.

- [ ] **Step 2: Replace ExtractMetadata with boarddb-powered version**

In `metadata.go`, add a new function that uses boarddb:

```go
func ExtractMetadataWithBoardDB(relPath string, bdb *boarddb.DB) Metadata {
	filename := filepath.Base(relPath)
	meta := Metadata{}

	// Use boarddb matcher for all patterns
	if bdb != nil && bdb.Available() {
		extracted := boarddb.ExtractBoardNumbers(filename)
		if len(extracted) == 0 {
			// Try directory components too
			extracted = boarddb.ExtractBoardNumbers(relPath)
		}
		if len(extracted) > 0 {
			best := extracted[0]
			meta.BoardNumber = best.Number
			meta.BoardManufacturer = best.ODM
			meta.ResolutionStatus = "pattern_matched"

			// Try to resolve against the DB
			match := bdb.Resolve(best.Number)
			if match != nil {
				meta.BoardNumber = match.BoardNumber // canonical
				meta.Manufacturer = match.Brand
				meta.Model = match.Model
				meta.BoardManufacturer = match.ODM
				meta.ResolutionStatus = "resolved"
			}
			return meta
		}
	}

	// Fallback to existing keyword-based extraction
	return ExtractMetadata(relPath)
}
```

Add `BoardManufacturer` and `ResolutionStatus` fields to the `Metadata` struct.

- [ ] **Step 3: Update scanWorker to use ExtractMetadataWithBoardDB**

In `scanner.go`, change the metadata extraction call from:
```go
meta := ExtractMetadata(df.relPath)
```
to:
```go
meta := ExtractMetadataWithBoardDB(df.relPath, s.boardDB)
```

And populate the new FileRecord fields:
```go
BoardManufacturer: meta.BoardManufacturer,
ResolutionStatus:  meta.ResolutionStatus,
```

- [ ] **Step 4: Verify compilation**

Run: `cd src/backend && go build ./...`
Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add src/backend/databank/metadata.go src/backend/databank/scanner.go
git commit -m "feat(databank): wire boarddb into scanner for ODM-aware metadata extraction"
```

---

## Task 7: API Endpoints — Boards

**Files:**
- Create: `src/backend/handlers/boards.go`
- Modify: `src/backend/main.go`

- [ ] **Step 1: Create boards handler**

```go
package handlers

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"

	"boardripper/boarddb"
	"boardripper/databank"
)

type BoardsHandler struct {
	bdb     *boarddb.DB
	db      *databank.DB
	scanner *databank.Scanner
	dataDir string
	dbPath  string
}

func NewBoardsHandler(bdb *boarddb.DB, db *databank.DB, scanner *databank.Scanner, dataDir string) *BoardsHandler {
	return &BoardsHandler{
		bdb:     bdb,
		db:      db,
		scanner: scanner,
		dataDir: dataDir,
		dbPath:  filepath.Join(dataDir, "boards.db"),
	}
}

// Resolve handles GET /api/boards/resolve?q=NM-A251
func (h *BoardsHandler) Resolve(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query().Get("q")
	if q == "" {
		http.Error(w, "missing q parameter", http.StatusBadRequest)
		return
	}

	// First extract board numbers from the query string
	extracted := boarddb.ExtractBoardNumbers(q)

	var result struct {
		Extracted []boarddb.ExtractedNumber `json:"extracted"`
		Match     *boarddb.BoardMatch       `json:"match"`
	}
	result.Extracted = extracted

	if h.bdb != nil && h.bdb.Available() {
		// Try resolving the raw query first
		result.Match = h.bdb.Resolve(q)
		// If no match, try each extracted number
		if result.Match == nil {
			for _, e := range extracted {
				result.Match = h.bdb.Resolve(e.Number)
				if result.Match != nil {
					break
				}
			}
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(result)
}

// Stats handles GET /api/boards/stats
func (h *BoardsHandler) Stats(w http.ResponseWriter, r *http.Request) {
	if h.bdb == nil || !h.bdb.Available() {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"available": false})
		return
	}
	stats := h.bdb.Stats()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"available": true, "stats": stats})
}

// Import handles POST /api/boards/import (multipart file upload)
func (h *BoardsHandler) Import(w http.ResponseWriter, r *http.Request) {
	file, _, err := r.FormFile("file")
	if err != nil {
		http.Error(w, "missing file", http.StatusBadRequest)
		return
	}
	defer file.Close()

	// Write to temp file, then atomic rename
	tmp := h.dbPath + ".tmp"
	out, err := os.Create(tmp)
	if err != nil {
		http.Error(w, "failed to create temp file", http.StatusInternalServerError)
		return
	}
	if _, err := io.Copy(out, file); err != nil {
		out.Close()
		os.Remove(tmp)
		http.Error(w, "failed to write file", http.StatusInternalServerError)
		return
	}
	out.Close()

	// Validate the uploaded DB
	testDB := boarddb.Open(tmp)
	if testDB == nil {
		os.Remove(tmp)
		http.Error(w, "invalid boards.db — missing required tables", http.StatusBadRequest)
		return
	}
	testDB.Close()

	// Atomic swap
	if err := os.Rename(tmp, h.dbPath); err != nil {
		os.Remove(tmp)
		http.Error(w, "failed to replace boards.db", http.StatusInternalServerError)
		return
	}

	// Reopen
	newDB := boarddb.Open(h.dbPath)
	if newDB != nil {
		h.bdb.Close()
		*h.bdb = *newDB
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

// ReResolve handles POST /api/boards/re-resolve
func (h *BoardsHandler) ReResolve(w http.ResponseWriter, r *http.Request) {
	if h.bdb == nil || !h.bdb.Available() {
		http.Error(w, "board database not available", http.StatusServiceUnavailable)
		return
	}
	// TODO: implement bulk re-resolve — iterate all files, re-run ExtractMetadataWithBoardDB, update
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "not_implemented"})
}
```

- [ ] **Step 2: Register routes in main.go**

After the existing databank handler setup, add:

```go
boardDBPath := filepath.Join(dataDir, "boards.db")
bdb := boarddb.Open(boardDBPath)
defer bdb.Close()

boardsHandler := handlers.NewBoardsHandler(bdb, db, scanner, dataDir)
mux.HandleFunc("GET /api/boards/resolve", boardsHandler.Resolve)
mux.HandleFunc("GET /api/boards/stats", boardsHandler.Stats)
mux.HandleFunc("POST /api/boards/import", boardsHandler.Import)
mux.HandleFunc("POST /api/boards/re-resolve", boardsHandler.ReResolve)
```

Also pass `bdb` to `NewScanner` (requires updating the constructor).

- [ ] **Step 3: Verify compilation**

Run: `cd src/backend && go build ./...`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add src/backend/handlers/boards.go src/backend/main.go
git commit -m "feat: /api/boards/* endpoints — resolve, stats, import, re-resolve"
```

---

## Task 8: Dockerfile — Bundle boards.db

**Files:**
- Modify: `Dockerfile`

- [ ] **Step 1: Copy boards.db into the Docker image**

In the Dockerfile, after copying the Go binary, add:

```dockerfile
COPY "Board Database/boards.db" /data/boards.db
```

This ensures the pre-built reference DB is available at the default path.

- [ ] **Step 2: Verify Docker build**

Run: `docker build -t boardripper:boarddb-test .`
Expected: successful build

- [ ] **Step 3: Commit**

```bash
git add Dockerfile
git commit -m "feat: bundle boards.db in Docker image at /data/boards.db"
```

---

## Task 9: File Rename Endpoint

**Files:**
- Modify: `src/backend/handlers/databank.go`
- Modify: `src/backend/databank/db.go`

- [ ] **Step 1: Add RenameFile method to databank DB**

In `db.go`:

```go
func (db *DB) RenameFile(id int64, newFilename string, scanRoot string) error {
	db.mu.Lock()
	defer db.mu.Unlock()

	var oldPath string
	err := db.reader.QueryRow("SELECT path FROM files WHERE id = ?", id).Scan(&oldPath)
	if err != nil {
		return fmt.Errorf("file not found: %w", err)
	}

	dir := filepath.Dir(oldPath)
	newPath := filepath.Join(dir, newFilename)

	// Rename on disk
	oldFull := filepath.Join(scanRoot, oldPath)
	newFull := filepath.Join(scanRoot, newPath)
	if err := os.Rename(oldFull, newFull); err != nil {
		return fmt.Errorf("rename on disk: %w", err)
	}

	// Update DB
	_, err = db.writer.Exec("UPDATE files SET path = ?, filename = ? WHERE id = ?", newPath, newFilename, id)
	return err
}
```

- [ ] **Step 2: Add handler in databank.go**

```go
func (h *DatabankHandler) RenameFile(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		http.Error(w, "invalid id", http.StatusBadRequest)
		return
	}
	var body struct{ Name string `json:"name"` }
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Name == "" {
		http.Error(w, "missing name", http.StatusBadRequest)
		return
	}
	scanRoot := h.scanner.ScanRoot()
	if err := h.db.RenameFile(id, body.Name, scanRoot); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}
```

- [ ] **Step 3: Register route in main.go**

```go
mux.HandleFunc("PATCH /api/databank/files/{id}/rename", dbHandler.RenameFile)
```

- [ ] **Step 4: Commit**

```bash
git add src/backend/handlers/databank.go src/backend/databank/db.go src/backend/main.go
git commit -m "feat: PATCH /api/databank/files/{id}/rename endpoint for canonical renaming"
```

---

## Summary

| Task | Component | Key Deliverable |
|------|-----------|-----------------|
| 1 | boarddb/boarddb.go | Package types, Open(), Stats() |
| 2 | boarddb/odm.go | 18-pattern ODM registry |
| 3 | boarddb/matcher.go | ExtractBoardNumbers() + tests |
| 4 | boarddb/resolve.go | Resolve() with exact/prefix/alias lookup + tests |
| 5 | databank/db.go | Schema v4 migration (board_manufacturer, resolution_status) |
| 6 | databank/metadata.go + scanner.go | Wire boarddb into scanner |
| 7 | handlers/boards.go + main.go | /api/boards/* endpoints |
| 8 | Dockerfile | Bundle boards.db |
| 9 | handlers/databank.go | File rename endpoint |

**Frontend tasks** (resolution indicators, Board Lookup panel, rename UI, Model view expansion) are deferred to a follow-up plan — the backend must be stable first.
