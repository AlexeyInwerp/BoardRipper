# OpenBoardData integration — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-board diagnostic-measurement layer sourced from openboarddata.org, displayed in the LibraryPanel detail pane and managed via a new "Library" tab in Settings.

**Architecture:** Backend Go package `obd` handles scraping, parsing, and filesystem caching. Four HTTP endpoints (`/api/obd/index/sync`, `/api/obd/match`, `/api/obd/fetch`, `/api/obd/cache`) expose this to the frontend. A new `obdStore` plus `useObdForBoard` hook drives a new `ObdSection` rendered inside `FileDetailPane`. No `boards.db` schema changes; OBD lives entirely on the filesystem under `<library_root>/.boardripper/openboarddata/`.

**Tech Stack:** Go (net/http stdlib, `httptest` for tests), React 19 + TypeScript, Playwright.

**Spec:** [docs/superpowers/specs/2026-05-01-openboarddata-integration-design.md](../specs/2026-05-01-openboarddata-integration-design.md)

---

## File map

**New backend files:**
- `src/backend/obd/types.go` — shared types (`Index`, `IndexEntry`, `ObdData`, `Match`, `Component`, `Net`)
- `src/backend/obd/parser.go` — `OBDATA_V002` parser
- `src/backend/obd/parser_test.go`
- `src/backend/obd/store.go` — filesystem ops (read/write index, atomic write `<bpath>.txt` + `.parsed.json`, fetched-state, cache delete)
- `src/backend/obd/store_test.go`
- `src/backend/obd/scraper.go` — index sync (HTML walk → `Index`)
- `src/backend/obd/scraper_test.go`
- `src/backend/obd/testdata/sample.obd.txt`
- `src/backend/obd/testdata/sample-index-root.html`
- `src/backend/obd/testdata/sample-index-laptops.html`
- `src/backend/handlers/obd.go` — four HTTP handlers + single-flight gates
- `src/backend/handlers/obd_test.go`

**Modified backend files:**
- `src/backend/main.go` — register routes, instantiate handler

**New frontend files:**
- `src/frontend/src/store/obd-store.ts` — singleton store + `useObdForBoard` hook
- `src/frontend/src/components/ObdSection.tsx` — chips, table, search, multi-variant rendering
- `src/frontend/tests/obd.spec.ts` — Playwright E2E

**Modified frontend files:**
- `src/frontend/src/store/log-store.ts` — add `'obd'` to `LogScope`
- `src/frontend/src/panels/LibraryPanel.tsx` — render `<ObdSection>` inside `FileDetailPane` for `board` files
- `src/frontend/src/panels/SettingsPanel.tsx` — add `'library'` tab + body

---

## Task 1: Backend package skeleton + shared types

**Files:**
- Create: `src/backend/obd/types.go`
- Create: `src/backend/obd/doc.go`

- [ ] **Step 1: Create `src/backend/obd/doc.go`**

```go
// Package obd implements OpenBoardData integration: scraping the openboarddata.org
// index, downloading per-board OBDATA_V002 files, parsing them, and caching the
// results on the filesystem under <library_root>/.boardripper/openboarddata/.
//
// This package never touches boards.db. OBD is a separate, opt-in data layer
// under ODbL share-alike licensing — see
// docs/superpowers/specs/2026-05-01-openboarddata-integration-design.md.
package obd
```

- [ ] **Step 2: Create `src/backend/obd/types.go`**

```go
package obd

// Index is the manifest written by a successful scrape of
// openboarddata.org's category listing pages.
type Index struct {
	SyncedAt   string       `json:"synced_at"`        // RFC3339
	Source     string       `json:"source"`           // "https://openboarddata.org"
	Boards     []IndexEntry `json:"boards"`
}

// IndexEntry is one row of the manifest.
type IndexEntry struct {
	Bpath    string `json:"bpath"`    // e.g. "laptops/apple/820-00045"
	Brand    string `json:"brand"`    // 2nd path segment
	Category string `json:"category"` // 1st path segment
}

// Match is what /api/obd/match returns for one matched bpath. Computed
// at request time — not persisted in index.json.
type Match struct {
	Bpath      string  `json:"bpath"`
	Brand      string  `json:"brand"`
	Category   string  `json:"category"`
	Fetched    bool    `json:"fetched"`
	FetchedAt  *string `json:"fetched_at,omitempty"` // RFC3339, nil when not fetched
}

// ObdData is the parsed OBDATA_V002 payload returned by /api/obd/fetch
// and cached as <bpath>.parsed.json.
type ObdData struct {
	Bpath     string     `json:"bpath"`
	SourceURL string     `json:"source_url"`
	FetchedAt string     `json:"fetched_at"` // RFC3339
	Header    Header     `json:"header"`
	Diagnosis string     `json:"diagnosis"`
	Components []Component `json:"components"`
	Nets      []Net       `json:"nets"`
}

type Header struct {
	Timestamp *string `json:"timestamp"`
	ID        *string `json:"id"`
	Brand     *string `json:"brand"`
	Category  *string `json:"category"`
	Comment   *string `json:"comment"`
}

type Component struct {
	Refdes string            `json:"refdes"`
	Attrs  map[string]string `json:"attrs"`
}

type Net struct {
	Name       string   `json:"name"`
	Qualifier  string   `json:"qualifier"`
	Diode      *string  `json:"diode"`
	Voltage    *string  `json:"voltage"`
	Resistance *string  `json:"resistance"`
	Aliases    []string `json:"aliases"`
	Comments   []string `json:"comments"`
}
```

- [ ] **Step 3: Verify the package compiles**

```bash
cd src/backend && go build ./obd/...
```

Expected: no output, exit 0.

- [ ] **Step 4: Commit**

```bash
git add src/backend/obd/
git commit -m "feat(obd): package skeleton + shared types"
```

---

## Task 2: OBDATA_V002 parser (TDD)

**Files:**
- Create: `src/backend/obd/testdata/sample.obd.txt`
- Create: `src/backend/obd/parser_test.go`
- Create: `src/backend/obd/parser.go`

- [ ] **Step 1: Create the canonical fixture `src/backend/obd/testdata/sample.obd.txt`**

```
OBDATA_V002 https://openboarddata.org
TIMESTAMP 1714521600
BOARDPATH laptops/apple/820-00045
ID demo-id-42
BRAND apple
CATEGORY laptops
COMMENT Test fixture for parser unit tests

DIAGNOSIS_DATA_START
Won't power on: check PP3V3_S0_REG.
If diode reading on AGND_PMIC > 0.05, replace U7000.
DIAGNOSIS_DATA_END

COMPONENTS_DATA_START
### refdes attr_key attr_value (m=misc, p=package, r=rating, v=value, l=flag, s=status)
C1804 m 6.3V
C1804 p 0201
C1804 r 10%
R7000 v 47k
R7000 p 0402
COMPONENTS_DATA_END

NETS_DATA_START
### name/qualifier type value 'comment'   (d=diode r=resistance v=voltage a=alias t=net-comment)
AGND_PMIC/Default d 0.000 ''
PP3V3_S0_REG/Default d 0.450 ''
PP3V3_S0_REG/Default v 3.30 ''
PP3V3_S0_REG/Default r 47k ''
PP3V3_S0_REG/Default a PP3V3_REG ''
PP3V3_S0_REG/Default t 'measure with PMIC enabled'
NETS_DATA_END
```

- [ ] **Step 2: Write `src/backend/obd/parser_test.go`**

```go
package obd

import (
	"os"
	"strings"
	"testing"
)

func loadFixture(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile("testdata/" + name)
	if err != nil {
		t.Fatalf("read fixture %s: %v", name, err)
	}
	return string(b)
}

func TestParse_HappyPath(t *testing.T) {
	data, err := Parse(loadFixture(t, "sample.obd.txt"))
	if err != nil {
		t.Fatalf("Parse returned error: %v", err)
	}

	if data.Header.ID == nil || *data.Header.ID != "demo-id-42" {
		t.Errorf("Header.ID = %v, want demo-id-42", data.Header.ID)
	}
	if data.Header.Brand == nil || *data.Header.Brand != "apple" {
		t.Errorf("Header.Brand = %v, want apple", data.Header.Brand)
	}
	if !strings.Contains(data.Diagnosis, "Won't power on") {
		t.Errorf("Diagnosis missing expected line: %q", data.Diagnosis)
	}

	// C1804 has three attrs.
	var c1804 *Component
	for i := range data.Components {
		if data.Components[i].Refdes == "C1804" {
			c1804 = &data.Components[i]
			break
		}
	}
	if c1804 == nil {
		t.Fatal("C1804 not found in components")
	}
	if got := c1804.Attrs["m"]; got != "6.3V" {
		t.Errorf("C1804 m = %q, want 6.3V", got)
	}
	if got := c1804.Attrs["p"]; got != "0201" {
		t.Errorf("C1804 p = %q, want 0201", got)
	}

	// PP3V3_S0_REG has all three scalars + alias + comment.
	var pp *Net
	for i := range data.Nets {
		if data.Nets[i].Name == "PP3V3_S0_REG" {
			pp = &data.Nets[i]
			break
		}
	}
	if pp == nil {
		t.Fatal("PP3V3_S0_REG not found in nets")
	}
	if pp.Diode == nil || *pp.Diode != "0.450" {
		t.Errorf("Diode = %v, want 0.450", pp.Diode)
	}
	if pp.Voltage == nil || *pp.Voltage != "3.30" {
		t.Errorf("Voltage = %v, want 3.30", pp.Voltage)
	}
	if pp.Resistance == nil || *pp.Resistance != "47k" {
		t.Errorf("Resistance = %v, want 47k", pp.Resistance)
	}
	if len(pp.Aliases) != 1 || pp.Aliases[0] != "PP3V3_REG" {
		t.Errorf("Aliases = %v, want [PP3V3_REG]", pp.Aliases)
	}
	if len(pp.Comments) != 1 {
		t.Errorf("Comments len = %d, want 1", len(pp.Comments))
	}
}

func TestParse_RejectsMissingMagic(t *testing.T) {
	if _, err := Parse("not an OBDATA file\n"); err == nil {
		t.Error("expected error on missing OBDATA_V002 magic, got nil")
	}
}

func TestParse_SkipsCommentsAndBlanks(t *testing.T) {
	src := `OBDATA_V002
BRAND apple

### inline doc comment

NETS_DATA_START
### docs
A/Default d 0.1 ''
NETS_DATA_END
`
	data, err := Parse(src)
	if err != nil {
		t.Fatalf("Parse error: %v", err)
	}
	if len(data.Nets) != 1 || data.Nets[0].Name != "A" {
		t.Errorf("Expected single net A, got %v", data.Nets)
	}
}

func TestParse_DuplicateAttr_LastWins(t *testing.T) {
	src := `OBDATA_V002
COMPONENTS_DATA_START
C1 m FIRST
C1 m SECOND
COMPONENTS_DATA_END
`
	data, err := Parse(src)
	if err != nil {
		t.Fatalf("Parse error: %v", err)
	}
	if len(data.Components) != 1 || data.Components[0].Attrs["m"] != "SECOND" {
		t.Errorf("Expected last-write-wins, got %v", data.Components)
	}
}

func TestParse_UnknownNetType_Dropped(t *testing.T) {
	src := `OBDATA_V002
NETS_DATA_START
A/Default d 0.1 ''
A/Default x 999 ''
NETS_DATA_END
`
	data, err := Parse(src)
	if err != nil {
		t.Fatalf("Parse error: %v", err)
	}
	if len(data.Nets) != 1 || data.Nets[0].Diode == nil {
		t.Errorf("Expected one net with diode set, got %v", data.Nets)
	}
}
```

- [ ] **Step 3: Run tests to verify they fail (no implementation yet)**

```bash
cd src/backend && go test ./obd/...
```

Expected: FAIL — `Parse` undefined.

- [ ] **Step 4: Implement `src/backend/obd/parser.go`**

```go
package obd

import (
	"errors"
	"log"
	"strings"
)

// Parse reads an OBDATA_V002 text body and returns the parsed payload.
// Returns an error only when the magic line is missing or malformed —
// unknown keys / duplicate writes are tolerated and logged.
func Parse(src string) (*ObdData, error) {
	lines := strings.Split(src, "\n")
	if len(lines) == 0 || !strings.HasPrefix(strings.TrimSpace(lines[0]), "OBDATA_V002") {
		return nil, errors.New("obd: missing OBDATA_V002 magic line")
	}

	out := &ObdData{
		Components: []Component{},
		Nets:       []Net{},
	}
	componentsIdx := map[string]int{} // refdes → index in out.Components
	netsIdx := map[string]int{}        // "name|qualifier" → index in out.Nets

	type section int
	const (
		secNone section = iota
		secDiagnosis
		secComponents
		secNets
	)
	cur := secNone
	var diagnosisBuf []string

	for i, raw := range lines {
		line := strings.TrimRight(raw, "\r")
		trimmed := strings.TrimSpace(line)

		// Skip inline-doc comments and blanks (but keep blanks inside DIAGNOSIS).
		if strings.HasPrefix(trimmed, "###") {
			continue
		}
		if trimmed == "" && cur != secDiagnosis {
			continue
		}

		// Section delimiters.
		switch trimmed {
		case "DIAGNOSIS_DATA_START":
			cur = secDiagnosis
			continue
		case "DIAGNOSIS_DATA_END":
			out.Diagnosis = strings.TrimSpace(strings.Join(diagnosisBuf, "\n"))
			diagnosisBuf = nil
			cur = secNone
			continue
		case "COMPONENTS_DATA_START":
			cur = secComponents
			continue
		case "COMPONENTS_DATA_END":
			cur = secNone
			continue
		case "NETS_DATA_START":
			cur = secNets
			continue
		case "NETS_DATA_END":
			cur = secNone
			continue
		}

		switch cur {
		case secDiagnosis:
			diagnosisBuf = append(diagnosisBuf, line)
		case secComponents:
			parseComponentLine(out, componentsIdx, trimmed, i)
		case secNets:
			parseNetLine(out, netsIdx, trimmed, i)
		case secNone:
			// Header line: "KEY VALUE..."
			parseHeaderLine(out, trimmed, i)
		}
	}

	return out, nil
}

func parseHeaderLine(out *ObdData, line string, lineNum int) {
	// First token is the key; rest is the value (preserve internal spaces).
	sp := strings.IndexByte(line, ' ')
	if sp < 0 {
		return // ignore single-token header lines
	}
	key := line[:sp]
	val := strings.TrimSpace(line[sp+1:])
	switch key {
	case "OBDATA_V002":
		// Magic; the URL after it is informational, ignore.
	case "TIMESTAMP":
		out.Header.Timestamp = &val
	case "BOARDPATH":
		// We set Bpath from the request, not from the file body — but
		// keep it parseable for round-trips.
		if out.Bpath == "" {
			out.Bpath = val
		}
	case "ID":
		out.Header.ID = &val
	case "BRAND":
		out.Header.Brand = &val
	case "CATEGORY":
		out.Header.Category = &val
	case "COMMENT":
		out.Header.Comment = &val
	default:
		log.Printf("[obd] line %d: unknown header key %q dropped", lineNum, key)
	}
}

func parseComponentLine(out *ObdData, idx map[string]int, line string, lineNum int) {
	// "<refdes> <attr_key> <attr_value...>"
	parts := strings.SplitN(line, " ", 3)
	if len(parts) < 3 {
		log.Printf("[obd] line %d: malformed component %q", lineNum, line)
		return
	}
	refdes, key, val := parts[0], parts[1], strings.TrimSpace(parts[2])

	pos, ok := idx[refdes]
	if !ok {
		out.Components = append(out.Components, Component{
			Refdes: refdes,
			Attrs:  map[string]string{},
		})
		pos = len(out.Components) - 1
		idx[refdes] = pos
	}
	if _, dup := out.Components[pos].Attrs[key]; dup {
		log.Printf("[obd] line %d: duplicate attr %s on %s — last write wins", lineNum, key, refdes)
	}
	out.Components[pos].Attrs[key] = val
}

func parseNetLine(out *ObdData, idx map[string]int, line string, lineNum int) {
	// "<name>/<qualifier> <type> <value> '<comment>'"
	parts := strings.SplitN(line, " ", 4)
	if len(parts) < 3 {
		log.Printf("[obd] line %d: malformed net %q", lineNum, line)
		return
	}
	nameQual := parts[0]
	netType := parts[1]
	val := parts[2]

	name, qual := splitNetName(nameQual)
	key := name + "|" + qual
	pos, ok := idx[key]
	if !ok {
		out.Nets = append(out.Nets, Net{Name: name, Qualifier: qual})
		pos = len(out.Nets) - 1
		idx[key] = pos
	}
	n := &out.Nets[pos]

	switch netType {
	case "d":
		v := val
		n.Diode = &v
	case "v":
		v := val
		n.Voltage = &v
	case "r":
		v := val
		n.Resistance = &v
	case "a":
		n.Aliases = append(n.Aliases, val)
	case "t":
		// Comment can have spaces; reuse parts[2] onwards.
		comment := val
		if len(parts) == 4 {
			comment = strings.TrimSpace(val + " " + parts[3])
		}
		comment = strings.Trim(comment, "'")
		n.Comments = append(n.Comments, comment)
	default:
		log.Printf("[obd] line %d: unknown net type %q dropped", lineNum, netType)
	}
}

func splitNetName(s string) (name, qual string) {
	slash := strings.IndexByte(s, '/')
	if slash < 0 {
		return s, ""
	}
	return s[:slash], s[slash+1:]
}
```

- [ ] **Step 5: Run tests — expect PASS**

```bash
cd src/backend && go test ./obd/... -v
```

Expected: all five tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/backend/obd/parser.go src/backend/obd/parser_test.go src/backend/obd/testdata/sample.obd.txt
git commit -m "feat(obd): OBDATA_V002 parser with TDD coverage"
```

---

## Task 3: Filesystem store (TDD)

**Files:**
- Create: `src/backend/obd/store_test.go`
- Create: `src/backend/obd/store.go`

- [ ] **Step 1: Write `src/backend/obd/store_test.go`**

```go
package obd

import (
	"os"
	"path/filepath"
	"testing"
)

func TestStore_AtomicWriteAndRead(t *testing.T) {
	dir := t.TempDir()
	s := NewStore(dir)

	idx := &Index{
		SyncedAt: "2026-05-01T12:00:00Z",
		Source:   "https://openboarddata.org",
		Boards:   []IndexEntry{{Bpath: "laptops/apple/820-00045", Brand: "apple", Category: "laptops"}},
	}
	if err := s.WriteIndex(idx); err != nil {
		t.Fatalf("WriteIndex: %v", err)
	}

	// File exists; tmp does not.
	if _, err := os.Stat(filepath.Join(dir, "index.json")); err != nil {
		t.Errorf("index.json missing: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "index.json.tmp")); !os.IsNotExist(err) {
		t.Errorf("tmp file should be gone, stat err = %v", err)
	}

	got, err := s.ReadIndex()
	if err != nil {
		t.Fatalf("ReadIndex: %v", err)
	}
	if len(got.Boards) != 1 || got.Boards[0].Bpath != "laptops/apple/820-00045" {
		t.Errorf("ReadIndex returned %v", got)
	}
}

func TestStore_ReadIndex_NoFile(t *testing.T) {
	s := NewStore(t.TempDir())
	idx, err := s.ReadIndex()
	if err != nil {
		t.Fatalf("ReadIndex on missing file should not error: %v", err)
	}
	if idx != nil {
		t.Errorf("ReadIndex on missing file should return nil, got %v", idx)
	}
}

func TestStore_WriteBoard_AtomicAndFetched(t *testing.T) {
	dir := t.TempDir()
	s := NewStore(dir)

	bpath := "laptops/apple/820-00045"
	raw := "OBDATA_V002\nBRAND apple\n"
	parsed := &ObdData{Bpath: bpath}

	if fetched, _ := s.IsFetched(bpath); fetched {
		t.Error("IsFetched should be false before write")
	}

	if err := s.WriteBoard(bpath, raw, parsed); err != nil {
		t.Fatalf("WriteBoard: %v", err)
	}

	fetched, fetchedAt := s.IsFetched(bpath)
	if !fetched || fetchedAt == nil {
		t.Errorf("IsFetched after WriteBoard = (%v, %v), want (true, <ts>)", fetched, fetchedAt)
	}

	// Subdir was created.
	if _, err := os.Stat(filepath.Join(dir, "laptops", "apple", "820-00045.txt")); err != nil {
		t.Errorf(".txt missing: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "laptops", "apple", "820-00045.parsed.json")); err != nil {
		t.Errorf(".parsed.json missing: %v", err)
	}
}

func TestStore_DeleteCache(t *testing.T) {
	dir := t.TempDir()
	s := NewStore(dir)
	if err := s.WriteBoard("a/b/c", "OBDATA_V002\n", &ObdData{}); err != nil {
		t.Fatalf("WriteBoard: %v", err)
	}
	if err := s.DeleteCache(); err != nil {
		t.Fatalf("DeleteCache: %v", err)
	}
	// Root dir is recreated empty.
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("ReadDir: %v", err)
	}
	if len(entries) != 0 {
		t.Errorf("DeleteCache should leave dir empty, got %v", entries)
	}
}

func TestStore_ValidatesBpath(t *testing.T) {
	s := NewStore(t.TempDir())
	bad := []string{"../escape", "/abs/path", "a/../b", "a/b/", "", "..", "a//b"}
	for _, b := range bad {
		if err := s.WriteBoard(b, "OBDATA_V002", &ObdData{}); err == nil {
			t.Errorf("WriteBoard(%q) should reject invalid bpath", b)
		}
	}
}
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
cd src/backend && go test ./obd/... -run Store -v
```

Expected: FAIL — `NewStore` undefined.

- [ ] **Step 3: Implement `src/backend/obd/store.go`**

```go
package obd

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Store wraps the OBD on-disk cache rooted at <library_root>/.boardripper/openboarddata/.
type Store struct {
	root string
}

// NewStore returns a store rooted at the given absolute directory.
// The directory is created on first write; reads from a missing dir
// return zero values, not errors.
func NewStore(root string) *Store {
	return &Store{root: root}
}

// Root exposes the on-disk root for the cache-delete handler.
func (s *Store) Root() string { return s.root }

func (s *Store) indexPath() string { return filepath.Join(s.root, "index.json") }

// WriteIndex serializes idx to root/index.json via tmp+rename.
func (s *Store) WriteIndex(idx *Index) error {
	if err := os.MkdirAll(s.root, 0o755); err != nil {
		return err
	}
	tmp := s.indexPath() + ".tmp"
	body, err := json.MarshalIndent(idx, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(tmp, body, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, s.indexPath())
}

// ReadIndex reads root/index.json. Returns (nil, nil) when the file is missing.
func (s *Store) ReadIndex() (*Index, error) {
	body, err := os.ReadFile(s.indexPath())
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var idx Index
	if err := json.Unmarshal(body, &idx); err != nil {
		return nil, fmt.Errorf("decode index.json: %w", err)
	}
	return &idx, nil
}

// validateBpath rejects bpaths that would escape the cache root or are otherwise malformed.
func validateBpath(bpath string) error {
	if bpath == "" {
		return errors.New("bpath: empty")
	}
	if strings.HasPrefix(bpath, "/") || strings.HasPrefix(bpath, "..") {
		return errors.New("bpath: must be relative")
	}
	if strings.Contains(bpath, "//") || strings.HasSuffix(bpath, "/") {
		return errors.New("bpath: malformed")
	}
	for _, seg := range strings.Split(bpath, "/") {
		if seg == "." || seg == ".." || seg == "" {
			return errors.New("bpath: contains forbidden segment")
		}
	}
	return nil
}

func (s *Store) bpathPaths(bpath string) (txt, parsed string) {
	base := filepath.Join(s.root, filepath.FromSlash(bpath))
	return base + ".txt", base + ".parsed.json"
}

// IsFetched reports whether <bpath>.txt exists on disk and (if so) its
// modification time as RFC3339.
func (s *Store) IsFetched(bpath string) (bool, *string) {
	if err := validateBpath(bpath); err != nil {
		return false, nil
	}
	txt, _ := s.bpathPaths(bpath)
	st, err := os.Stat(txt)
	if err != nil {
		return false, nil
	}
	t := st.ModTime().UTC().Format(time.RFC3339)
	return true, &t
}

// WriteBoard atomically writes both the raw text and the parsed JSON.
// Both files use tmp+rename. Parent directories are created as needed.
func (s *Store) WriteBoard(bpath, raw string, parsed *ObdData) error {
	if err := validateBpath(bpath); err != nil {
		return err
	}
	txtPath, parsedPath := s.bpathPaths(bpath)
	if err := os.MkdirAll(filepath.Dir(txtPath), 0o755); err != nil {
		return err
	}

	if err := writeAtomic(txtPath, []byte(raw)); err != nil {
		return err
	}
	body, err := json.MarshalIndent(parsed, "", "  ")
	if err != nil {
		return err
	}
	return writeAtomic(parsedPath, body)
}

// ReadParsed loads the cached parsed payload for the given bpath, or
// (nil, nil) when missing.
func (s *Store) ReadParsed(bpath string) (*ObdData, error) {
	if err := validateBpath(bpath); err != nil {
		return nil, err
	}
	_, parsedPath := s.bpathPaths(bpath)
	body, err := os.ReadFile(parsedPath)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var d ObdData
	if err := json.Unmarshal(body, &d); err != nil {
		return nil, fmt.Errorf("decode %s: %w", parsedPath, err)
	}
	return &d, nil
}

// DeleteCache removes the entire cache directory and recreates it empty.
func (s *Store) DeleteCache() error {
	if err := os.RemoveAll(s.root); err != nil {
		return err
	}
	return os.MkdirAll(s.root, 0o755)
}

func writeAtomic(path string, body []byte) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, body, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
cd src/backend && go test ./obd/... -v
```

Expected: all parser + store tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/backend/obd/store.go src/backend/obd/store_test.go
git commit -m "feat(obd): filesystem cache with atomic writes + bpath sandboxing"
```

---

## Task 4: Index scraper (TDD with httptest)

**Files:**
- Create: `src/backend/obd/testdata/sample-index-root.html`
- Create: `src/backend/obd/testdata/sample-index-laptops.html`
- Create: `src/backend/obd/scraper_test.go`
- Create: `src/backend/obd/scraper.go`

- [ ] **Step 1: Create root index fixture `src/backend/obd/testdata/sample-index-root.html`**

```html
<!doctype html><html><body>
<h1>OpenBoardData</h1>
<ul>
  <li><a href="?a=showboards&category=consoles">Consoles</a></li>
  <li><a href="?a=showboards&category=desktops">Desktops</a></li>
  <li><a href="?a=showboards&category=laptops">Laptops</a></li>
  <li><a href="?a=showboards&category=phones">Phones</a></li>
</ul>
</body></html>
```

- [ ] **Step 2: Create laptops listing fixture `src/backend/obd/testdata/sample-index-laptops.html`**

```html
<!doctype html><html><body>
<h1>Laptops</h1>
<ul>
  <li><a href="?a=showboardsolutions&bpath=laptops/apple/820-00045">820-00045</a></li>
  <li><a href="?a=showboardsolutions&bpath=laptops/apple/820-00165">820-00165</a></li>
  <li><a href="?a=showboardsolutions&bpath=laptops/apple/iP7P_intel">iP7P_intel</a></li>
  <li><a href="?a=showboardsolutions&bpath=laptops/apple/iP7P_qualcomm">iP7P_qualcomm</a></li>
</ul>
</body></html>
```

- [ ] **Step 3: Write `src/backend/obd/scraper_test.go`**

```go
package obd

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
)

func newFixtureServer(t *testing.T) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Query().Get("a") {
		case "":
			body, _ := os.ReadFile("testdata/sample-index-root.html")
			w.Write(body)
		case "showboards":
			cat := r.URL.Query().Get("category")
			if cat != "laptops" {
				// Other categories return an empty list.
				w.Write([]byte("<html><body>empty</body></html>"))
				return
			}
			body, _ := os.ReadFile("testdata/sample-index-laptops.html")
			w.Write(body)
		case "generate":
			body, _ := os.ReadFile("testdata/sample.obd.txt")
			w.Write(body)
		default:
			http.NotFound(w, r)
		}
	})
	return httptest.NewServer(mux)
}

func TestScraper_BuildsIndex(t *testing.T) {
	srv := newFixtureServer(t)
	defer srv.Close()

	sc := NewScraper(srv.URL)
	sc.RequestDelay = 0 // speed up tests
	idx, err := sc.SyncIndex()
	if err != nil {
		t.Fatalf("SyncIndex: %v", err)
	}
	if len(idx.Boards) != 4 {
		t.Errorf("Boards len = %d, want 4 — got %v", len(idx.Boards), idx.Boards)
	}
	for _, b := range idx.Boards {
		if b.Brand != "apple" {
			t.Errorf("entry %v: brand = %q, want apple", b, b.Brand)
		}
		if b.Category != "laptops" {
			t.Errorf("entry %v: category = %q, want laptops", b, b.Category)
		}
	}
}

func TestScraper_DropGuard(t *testing.T) {
	srv := newFixtureServer(t)
	defer srv.Close()

	prev := &Index{Boards: make([]IndexEntry, 100)} // 100 prior boards
	sc := NewScraper(srv.URL)
	sc.RequestDelay = 0
	if _, err := sc.SyncIndexWithGuard(prev); err == nil || !strings.Contains(err.Error(), "drop guard") {
		t.Errorf("expected drop-guard error, got %v", err)
	}
}

func TestScraper_FetchBoard(t *testing.T) {
	srv := newFixtureServer(t)
	defer srv.Close()
	sc := NewScraper(srv.URL)

	raw, err := sc.FetchBoard("laptops/apple/820-00045")
	if err != nil {
		t.Fatalf("FetchBoard: %v", err)
	}
	if !strings.HasPrefix(raw, "OBDATA_V002") {
		t.Errorf("body does not start with magic: %q", raw[:min(40, len(raw))])
	}
}

func TestScraper_FetchBoard_RejectsNonMagic(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte("<html>404 page disguised as 200</html>"))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	sc := NewScraper(srv.URL)
	if _, err := sc.FetchBoard("laptops/apple/820-00045"); err == nil {
		t.Error("expected magic-line rejection, got nil")
	}
}

func TestScraper_BpathExtraction(t *testing.T) {
	html := `<a href="?a=showboardsolutions&bpath=laptops/apple/820-00045">x</a>
	         <a href="?a=showboardsolutions&amp;bpath=laptops/apple/820-00165">y</a>
	         <a href="?a=other">z</a>`
	got := extractBpaths(html)
	if len(got) != 2 {
		t.Errorf("extractBpaths: %v", got)
	}
}

// min available since Go 1.21; provide for older toolchains.
func min(a, b int) int { if a < b { return a }; return b }

// Compile-time check that url package is used (for future expansion).
var _ = url.URL{}
```

- [ ] **Step 4: Run tests — expect FAIL**

```bash
cd src/backend && go test ./obd/... -run Scraper -v
```

Expected: FAIL — `NewScraper`, `SyncIndex`, `SyncIndexWithGuard`, `FetchBoard`, `extractBpaths` undefined.

- [ ] **Step 5: Implement `src/backend/obd/scraper.go`**

```go
package obd

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"
)

const (
	defaultUserAgent  = "BoardRipper/dev (+https://boardripper.app)"
	defaultMaxPages   = 50
	defaultDropGuard  = 0.5  // reject if new index drops below 50% of prior
	defaultHTTPTimeout = 30 * time.Second
)

// Scraper walks openboarddata.org's category index pages and downloads per-board files.
type Scraper struct {
	BaseURL      string        // e.g. "https://openboarddata.org"
	UserAgent    string
	RequestDelay time.Duration
	HTTPClient   *http.Client
	MaxPages     int
}

// NewScraper returns a configured scraper.
func NewScraper(baseURL string) *Scraper {
	return &Scraper{
		BaseURL:      strings.TrimRight(baseURL, "/"),
		UserAgent:    defaultUserAgent,
		RequestDelay: 250 * time.Millisecond,
		HTTPClient:   &http.Client{Timeout: defaultHTTPTimeout},
		MaxPages:     defaultMaxPages,
	}
}

var fallbackCategories = []string{"consoles", "desktops", "laptops", "phones"}

// SyncIndex walks every category and returns an in-memory Index.
func (s *Scraper) SyncIndex() (*Index, error) {
	pagesWalked := 0

	rootHTML, err := s.get(s.BaseURL + "/")
	pagesWalked++
	if err != nil {
		return nil, fmt.Errorf("scrape root: %w", err)
	}
	cats := extractCategories(rootHTML)
	if len(cats) == 0 {
		cats = fallbackCategories
	}

	var entries []IndexEntry
	for _, cat := range cats {
		if pagesWalked >= s.MaxPages {
			return nil, fmt.Errorf("scrape: hard cap of %d pages exceeded", s.MaxPages)
		}
		s.sleep()
		listHTML, err := s.get(fmt.Sprintf("%s/?a=showboards&category=%s", s.BaseURL, cat))
		pagesWalked++
		if err != nil {
			// Per-category failure is non-fatal — log and continue.
			continue
		}
		for _, bp := range extractBpaths(listHTML) {
			seg := strings.Split(bp, "/")
			if len(seg) < 3 {
				continue
			}
			entries = append(entries, IndexEntry{
				Bpath:    bp,
				Category: seg[0],
				Brand:    seg[1],
			})
		}
	}

	return &Index{
		SyncedAt: time.Now().UTC().Format(time.RFC3339),
		Source:   s.BaseURL,
		Boards:   entries,
	}, nil
}

// SyncIndexWithGuard runs SyncIndex and rejects the result when the new
// board count drops below defaultDropGuard fraction of prior. prev may
// be nil — in which case the guard is a no-op.
func (s *Scraper) SyncIndexWithGuard(prev *Index) (*Index, error) {
	idx, err := s.SyncIndex()
	if err != nil {
		return nil, err
	}
	if prev != nil && len(prev.Boards) > 0 {
		ratio := float64(len(idx.Boards)) / float64(len(prev.Boards))
		if ratio < defaultDropGuard {
			return nil, fmt.Errorf("scrape: drop guard tripped (new %d / prev %d = %.2f)",
				len(idx.Boards), len(prev.Boards), ratio)
		}
	}
	return idx, nil
}

// FetchBoard downloads the OBDATA_V002 body for one bpath. Returns the
// raw text. Rejects responses that don't start with the magic line.
func (s *Scraper) FetchBoard(bpath string) (string, error) {
	if err := validateBpath(bpath); err != nil {
		return "", err
	}
	body, err := s.get(fmt.Sprintf("%s/?a=generate&bpath=%s", s.BaseURL, bpath))
	if err != nil {
		return "", err
	}
	if !strings.HasPrefix(strings.TrimSpace(body), "OBDATA_V002") {
		return "", errors.New("upstream response does not start with OBDATA_V002 magic")
	}
	return body, nil
}

func (s *Scraper) sleep() {
	if s.RequestDelay > 0 {
		time.Sleep(s.RequestDelay)
	}
}

func (s *Scraper) get(u string) (string, error) {
	req, err := http.NewRequest(http.MethodGet, u, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", s.UserAgent)
	resp, err := s.HTTPClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return "", fmt.Errorf("HTTP %d from %s", resp.StatusCode, u)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}
	return string(body), nil
}

// extractCategories pulls "category" query params from anchors whose
// href contains "a=showboards&category=...".
var categoryRE = regexp.MustCompile(`a=showboards(?:&|&amp;)category=([a-z]+)`)

func extractCategories(html string) []string {
	matches := categoryRE.FindAllStringSubmatch(html, -1)
	seen := map[string]struct{}{}
	var out []string
	for _, m := range matches {
		if _, ok := seen[m[1]]; ok {
			continue
		}
		seen[m[1]] = struct{}{}
		out = append(out, m[1])
	}
	return out
}

// extractBpaths pulls "bpath" query params from anchors whose href
// contains "a=showboardsolutions&bpath=...". The bpath is URL-encoded
// in the source but our fixture uses literal slashes — handle both.
var bpathRE = regexp.MustCompile(`a=showboardsolutions(?:&|&amp;)bpath=([^"&\s]+)`)

func extractBpaths(html string) []string {
	matches := bpathRE.FindAllStringSubmatch(html, -1)
	seen := map[string]struct{}{}
	var out []string
	for _, m := range matches {
		bp := strings.ReplaceAll(m[1], "%2F", "/")
		if _, ok := seen[bp]; ok {
			continue
		}
		seen[bp] = struct{}{}
		out = append(out, bp)
	}
	return out
}
```

- [ ] **Step 6: Run tests — expect PASS**

```bash
cd src/backend && go test ./obd/... -v
```

Expected: all parser + store + scraper tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/backend/obd/scraper.go src/backend/obd/scraper_test.go src/backend/obd/testdata/sample-index-root.html src/backend/obd/testdata/sample-index-laptops.html
git commit -m "feat(obd): index scraper with drop guard + bpath extraction"
```

---

## Task 5: HTTP handlers + integration tests

**Files:**
- Create: `src/backend/handlers/obd.go`
- Create: `src/backend/handlers/obd_test.go`

- [ ] **Step 1: Write `src/backend/handlers/obd.go`**

```go
package handlers

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync"
	"time"

	"boardripper/obd"
)

// ObdHandler serves /api/obd/* endpoints.
type ObdHandler struct {
	store    *obd.Store
	scraper  *obd.Scraper

	// indexSyncing single-flights /api/obd/index/sync.
	indexSyncing  bool
	indexSyncMu   sync.Mutex

	// fetchInflight single-flights /api/obd/fetch per bpath. Each entry
	// is a channel that closes when the fetch completes.
	fetchInflight map[string]chan struct{}
	fetchMu       sync.Mutex
}

// NewObdHandler wires a handler against the given store and scraper.
// If store is nil, all endpoints return 503 — used when the library
// has no library_root configured.
func NewObdHandler(store *obd.Store, scraper *obd.Scraper) *ObdHandler {
	return &ObdHandler{
		store:         store,
		scraper:       scraper,
		fetchInflight: make(map[string]chan struct{}),
	}
}

func (h *ObdHandler) requireLibrary(w http.ResponseWriter) bool {
	if h.store == nil {
		http.Error(w, "library_dir not configured", http.StatusServiceUnavailable)
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

// IndexSync runs a synchronous scrape and writes index.json. Single-flight.
func (h *ObdHandler) IndexSync(w http.ResponseWriter, r *http.Request) {
	if !h.requireLibrary(w) {
		return
	}
	h.indexSyncMu.Lock()
	if h.indexSyncing {
		h.indexSyncMu.Unlock()
		http.Error(w, "sync already in progress", http.StatusConflict)
		return
	}
	h.indexSyncing = true
	h.indexSyncMu.Unlock()
	defer func() {
		h.indexSyncMu.Lock()
		h.indexSyncing = false
		h.indexSyncMu.Unlock()
	}()

	prev, _ := h.store.ReadIndex() // nil on first sync — guard tolerates this
	idx, err := h.scraper.SyncIndexWithGuard(prev)
	if err != nil {
		http.Error(w, "scrape failed: "+err.Error(), http.StatusBadGateway)
		return
	}
	if err := h.store.WriteIndex(idx); err != nil {
		http.Error(w, "write index.json: "+err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]any{
		"synced_at":   idx.SyncedAt,
		"board_count": len(idx.Boards),
	})
}

// IndexStatus is included in every Match response so the frontend can
// know whether index.json exists and when it was last synced without a
// separate round trip.
type IndexStatus struct {
	Synced     bool   `json:"synced"`
	SyncedAt   string `json:"synced_at,omitempty"`
	BoardCount int    `json:"board_count"`
}

// Match returns matching index entries for a board's board_number.
// The Index field is always populated so the frontend can refresh
// index status by calling this endpoint with empty board_number.
func (h *ObdHandler) Match(w http.ResponseWriter, r *http.Request) {
	if !h.requireLibrary(w) {
		return
	}
	bn := normalizeForMatch(r.URL.Query().Get("board_number"))
	out := struct {
		Matches []obd.Match `json:"matches"`
		Index   IndexStatus `json:"index"`
	}{Matches: []obd.Match{}}

	idx, err := h.store.ReadIndex()
	if err == nil && idx != nil {
		out.Index = IndexStatus{Synced: true, SyncedAt: idx.SyncedAt, BoardCount: len(idx.Boards)}
	}

	if bn == "" || idx == nil {
		writeJSON(w, out)
		return
	}
	for _, e := range idx.Boards {
		leaf := e.Bpath
		if i := strings.LastIndex(leaf, "/"); i >= 0 {
			leaf = leaf[i+1:]
		}
		if !strings.Contains(normalizeForMatch(leaf), bn) {
			continue
		}
		fetched, fetchedAt := h.store.IsFetched(e.Bpath)
		out.Matches = append(out.Matches, obd.Match{
			Bpath:     e.Bpath,
			Brand:     e.Brand,
			Category:  e.Category,
			Fetched:   fetched,
			FetchedAt: fetchedAt,
		})
	}
	writeJSON(w, out)
}

// normalizeForMatch lowercases and strips spaces and dashes.
func normalizeForMatch(s string) string {
	s = strings.ToLower(s)
	s = strings.ReplaceAll(s, " ", "")
	s = strings.ReplaceAll(s, "-", "")
	return s
}

// Fetch downloads and parses one bpath. Single-flight per bpath.
func (h *ObdHandler) Fetch(w http.ResponseWriter, r *http.Request) {
	if !h.requireLibrary(w) {
		return
	}
	bpath := r.URL.Query().Get("bpath")
	if bpath == "" {
		http.Error(w, "bpath query param required", http.StatusBadRequest)
		return
	}
	idx, err := h.store.ReadIndex()
	if err != nil || idx == nil {
		http.Error(w, "no index synced; sync first", http.StatusBadRequest)
		return
	}
	known := false
	for _, e := range idx.Boards {
		if e.Bpath == bpath {
			known = true
			break
		}
	}
	if !known {
		http.Error(w, "bpath not in index", http.StatusBadRequest)
		return
	}

	// Single-flight per bpath.
	h.fetchMu.Lock()
	ch, inflight := h.fetchInflight[bpath]
	if !inflight {
		ch = make(chan struct{})
		h.fetchInflight[bpath] = ch
	}
	h.fetchMu.Unlock()

	if inflight {
		<-ch
		// Re-read the cache the leader wrote. If the leader failed,
		// the cache may still be empty; report through ReadParsed.
		parsed, perr := h.store.ReadParsed(bpath)
		if perr != nil || parsed == nil {
			http.Error(w, "concurrent fetch failed", http.StatusBadGateway)
			return
		}
		writeJSON(w, parsed)
		return
	}

	// We're the leader.
	defer func() {
		h.fetchMu.Lock()
		delete(h.fetchInflight, bpath)
		close(ch)
		h.fetchMu.Unlock()
	}()

	raw, err := h.scraper.FetchBoard(bpath)
	if err != nil {
		http.Error(w, "fetch upstream: "+err.Error(), http.StatusBadGateway)
		return
	}
	parsed, err := obd.Parse(raw)
	if err != nil {
		http.Error(w, "parse: "+err.Error(), http.StatusBadGateway)
		return
	}
	parsed.Bpath = bpath
	parsed.SourceURL = h.scraper.BaseURL + "/?a=showboardsolutions&bpath=" + bpath
	parsed.FetchedAt = time.Now().UTC().Format(time.RFC3339)

	if err := h.store.WriteBoard(bpath, raw, parsed); err != nil {
		http.Error(w, "write cache: "+err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, parsed)
}

// CacheDelete wipes the entire OBD cache.
func (h *ObdHandler) CacheDelete(w http.ResponseWriter, r *http.Request) {
	if !h.requireLibrary(w) {
		return
	}
	if err := h.store.DeleteCache(); err != nil {
		http.Error(w, "delete cache: "+err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]string{"status": "ok"})
}

// Compile-time guard: errors import used elsewhere in package.
var _ = errors.New
```

- [ ] **Step 2: Write `src/backend/handlers/obd_test.go`**

```go
package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"

	"boardripper/obd"
)

func newTestHandler(t *testing.T) (*ObdHandler, *obd.Store, *httptest.Server) {
	t.Helper()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Query().Get("a") {
		case "":
			b, _ := os.ReadFile("../obd/testdata/sample-index-root.html")
			w.Write(b)
		case "showboards":
			if r.URL.Query().Get("category") == "laptops" {
				b, _ := os.ReadFile("../obd/testdata/sample-index-laptops.html")
				w.Write(b)
				return
			}
			w.Write([]byte("empty"))
		case "generate":
			b, _ := os.ReadFile("../obd/testdata/sample.obd.txt")
			w.Write(b)
		default:
			http.NotFound(w, r)
		}
	}))
	store := obd.NewStore(t.TempDir())
	sc := obd.NewScraper(upstream.URL)
	sc.RequestDelay = 0
	return NewObdHandler(store, sc), store, upstream
}

func TestMatch_NoIndex(t *testing.T) {
	h, _, srv := newTestHandler(t)
	defer srv.Close()
	req := httptest.NewRequest("GET", "/api/obd/match?board_number=820-00045", nil)
	w := httptest.NewRecorder()
	h.Match(w, req)

	var out struct {
		Matches []obd.Match `json:"matches"`
	}
	json.NewDecoder(w.Body).Decode(&out)
	if len(out.Matches) != 0 {
		t.Errorf("expected no matches without index, got %v", out.Matches)
	}
}

func TestIndexSyncThenMatch(t *testing.T) {
	h, _, srv := newTestHandler(t)
	defer srv.Close()

	w := httptest.NewRecorder()
	h.IndexSync(w, httptest.NewRequest("POST", "/api/obd/index/sync", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("IndexSync code = %d, body = %q", w.Code, w.Body.String())
	}

	// Single-variant match.
	w = httptest.NewRecorder()
	h.Match(w, httptest.NewRequest("GET", "/api/obd/match?board_number=820-00045", nil))
	var single struct {
		Matches []obd.Match `json:"matches"`
		Index   IndexStatus `json:"index"`
	}
	json.NewDecoder(w.Body).Decode(&single)
	if len(single.Matches) != 1 || single.Matches[0].Fetched {
		t.Errorf("single match: %v", single.Matches)
	}
	if !single.Index.Synced || single.Index.BoardCount != 4 {
		t.Errorf("Index status = %+v", single.Index)
	}

	// Multi-variant match.
	w = httptest.NewRecorder()
	h.Match(w, httptest.NewRequest("GET", "/api/obd/match?board_number=iP7P", nil))
	var multi struct {
		Matches []obd.Match `json:"matches"`
		Index   IndexStatus `json:"index"`
	}
	json.NewDecoder(w.Body).Decode(&multi)
	if len(multi.Matches) != 2 {
		t.Errorf("multi match expected 2, got %v", multi.Matches)
	}

	// Empty board_number probe — should still return synced index status.
	w = httptest.NewRecorder()
	h.Match(w, httptest.NewRequest("GET", "/api/obd/match?board_number=", nil))
	var probe struct {
		Matches []obd.Match `json:"matches"`
		Index   IndexStatus `json:"index"`
	}
	json.NewDecoder(w.Body).Decode(&probe)
	if !probe.Index.Synced || len(probe.Matches) != 0 {
		t.Errorf("probe response = %+v / %v", probe.Index, probe.Matches)
	}
}

func TestFetch_RejectsUnknownBpath(t *testing.T) {
	h, _, srv := newTestHandler(t)
	defer srv.Close()

	// Sync first so index exists, then ask for an unknown bpath.
	wRec := httptest.NewRecorder()
	h.IndexSync(wRec, httptest.NewRequest("POST", "/api/obd/index/sync", nil))

	w := httptest.NewRecorder()
	h.Fetch(w, httptest.NewRequest("POST", "/api/obd/fetch?bpath=pwned/../../etc/passwd", nil))
	if w.Code != http.StatusBadRequest {
		t.Errorf("Fetch unknown bpath: code = %d, body = %q", w.Code, w.Body.String())
	}
}

func TestFetch_HappyPath(t *testing.T) {
	h, _, srv := newTestHandler(t)
	defer srv.Close()

	wRec := httptest.NewRecorder()
	h.IndexSync(wRec, httptest.NewRequest("POST", "/api/obd/index/sync", nil))

	w := httptest.NewRecorder()
	h.Fetch(w, httptest.NewRequest("POST", "/api/obd/fetch?bpath=laptops/apple/820-00045", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("Fetch: code = %d, body = %q", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "PP3V3_S0_REG") {
		t.Errorf("response missing expected net: %q", w.Body.String())
	}
}

func TestFetch_RejectsNonMagic(t *testing.T) {
	store := obd.NewStore(t.TempDir())

	// Pre-seed an index so the bpath is recognized.
	idx := &obd.Index{
		Source:   "x",
		SyncedAt: "2026-05-01T00:00:00Z",
		Boards:   []obd.IndexEntry{{Bpath: "laptops/apple/820-00045", Brand: "apple", Category: "laptops"}},
	}
	if err := store.WriteIndex(idx); err != nil {
		t.Fatalf("seed index: %v", err)
	}

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte("<html>not OBDATA</html>"))
	}))
	defer upstream.Close()

	h := NewObdHandler(store, obd.NewScraper(upstream.URL))
	w := httptest.NewRecorder()
	h.Fetch(w, httptest.NewRequest("POST", "/api/obd/fetch?bpath=laptops/apple/820-00045", nil))
	if w.Code != http.StatusBadGateway {
		t.Errorf("expected 502 on non-magic body, got %d", w.Code)
	}
}

func TestFetch_SingleFlight(t *testing.T) {
	h, _, srv := newTestHandler(t)
	defer srv.Close()
	wRec := httptest.NewRecorder()
	h.IndexSync(wRec, httptest.NewRequest("POST", "/api/obd/index/sync", nil))

	var wg sync.WaitGroup
	codes := make([]int, 5)
	for i := 0; i < 5; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			w := httptest.NewRecorder()
			h.Fetch(w, httptest.NewRequest("POST", "/api/obd/fetch?bpath=laptops/apple/820-00045", nil))
			codes[i] = w.Code
		}(i)
	}
	wg.Wait()
	for i, c := range codes {
		if c != http.StatusOK {
			t.Errorf("concurrent fetch %d code = %d", i, c)
		}
	}
}

func TestIndexSync_ConcurrentReturns409(t *testing.T) {
	h, _, srv := newTestHandler(t)
	defer srv.Close()

	// Force a slow scraper by pointing at a server that hangs.
	hang := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		select {} // block forever
	}))
	defer hang.Close()
	h.scraper = obd.NewScraper(hang.URL)

	go h.IndexSync(httptest.NewRecorder(), httptest.NewRequest("POST", "/api/obd/index/sync", nil))

	// Give the goroutine a moment to take the lock.
	for i := 0; i < 100; i++ {
		h.indexSyncMu.Lock()
		busy := h.indexSyncing
		h.indexSyncMu.Unlock()
		if busy {
			break
		}
	}

	w := httptest.NewRecorder()
	h.IndexSync(w, httptest.NewRequest("POST", "/api/obd/index/sync", nil))
	if w.Code != http.StatusConflict {
		t.Errorf("second sync code = %d, want 409", w.Code)
	}
}

func TestCacheDelete(t *testing.T) {
	h, store, srv := newTestHandler(t)
	defer srv.Close()
	wRec := httptest.NewRecorder()
	h.IndexSync(wRec, httptest.NewRequest("POST", "/api/obd/index/sync", nil))
	h.Fetch(httptest.NewRecorder(), httptest.NewRequest("POST", "/api/obd/fetch?bpath=laptops/apple/820-00045", nil))

	w := httptest.NewRecorder()
	h.CacheDelete(w, httptest.NewRequest("DELETE", "/api/obd/cache", nil))
	if w.Code != http.StatusOK {
		t.Errorf("CacheDelete code = %d, body = %q", w.Code, w.Body.String())
	}
	idx, _ := store.ReadIndex()
	if idx != nil {
		t.Error("index.json should be gone after CacheDelete")
	}
}
```

- [ ] **Step 3: Run tests — expect PASS**

```bash
cd src/backend && go test ./... -v
```

Expected: all parser, store, scraper, handler tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/backend/handlers/obd.go src/backend/handlers/obd_test.go
git commit -m "feat(obd): four HTTP handlers with single-flight + integration tests"
```

---

## Task 6: Wire OBD handler into `main.go`

**Files:**
- Modify: `src/backend/main.go`

- [ ] **Step 1: Add OBD wiring after the Update API routes block (around line 153 in main.go)**

Open `src/backend/main.go`. Locate the block ending with:

```go
mux.HandleFunc("GET /api/update/progress", read(updateHandler.Progress))
```

Immediately after this line, add:

```go
	// OpenBoardData (OBD) API routes — independent filesystem-backed data layer
	// rooted at <library_root>/.boardripper/openboarddata/. The store is nil
	// when no library_dir is configured; the handler returns 503 in that case.
	var obdStore *obd.Store
	if libRoot, _ := db.GetConfig("library_dir"); libRoot != "" {
		obdStore = obd.NewStore(filepath.Join(libRoot, ".boardripper", "openboarddata"))
	} else if libraryDir != "" {
		obdStore = obd.NewStore(filepath.Join(libraryDir, ".boardripper", "openboarddata"))
	}
	obdScraper := obd.NewScraper("https://openboarddata.org")
	obdHandler := handlers.NewObdHandler(obdStore, obdScraper)
	mux.HandleFunc("POST /api/obd/index/sync", obdHandler.IndexSync) // long-running — no wrap
	mux.HandleFunc("GET /api/obd/match", read(obdHandler.Match))
	mux.HandleFunc("POST /api/obd/fetch", obdHandler.Fetch)           // 30s upstream timeout — no wrap
	mux.HandleFunc("DELETE /api/obd/cache", write(obdHandler.CacheDelete))
```

- [ ] **Step 2: Add the import for the new package**

In `src/backend/main.go`, locate the import block that lists `"boardripper/boarddb"`. Add an `"boardripper/obd"` line below `"boardripper/databank"`:

```go
import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"boardripper/boarddb"
	"boardripper/databank"
	"boardripper/handlers"
	"boardripper/obd"
	"boardripper/updater"
)
```

- [ ] **Step 3: Build and run the existing test suite**

```bash
cd src/backend && go build ./... && go test ./...
```

Expected: build succeeds, all tests pass.

- [ ] **Step 4: Smoke-test against a running server**

```bash
cd src/backend && DATA_DIR=/tmp/br-obd-smoke LIBRARY_DIR=/tmp/br-obd-smoke-lib PORT=18080 go run . &
sleep 2
curl -s -X GET 'http://localhost:18080/api/obd/match?board_number=820-00045' | head -c 200
curl -s -X DELETE 'http://localhost:18080/api/obd/cache' | head -c 200
kill %1 2>/dev/null || true
```

Expected: the GET returns `{"matches":[]}` (no index synced yet), the DELETE returns `{"status":"ok"}`.

- [ ] **Step 5: Commit**

```bash
git add src/backend/main.go
git commit -m "feat(obd): register /api/obd/* routes in main"
```

---

## Task 7: Frontend `obdStore` + `useObdForBoard` hook

**Files:**
- Modify: `src/frontend/src/store/log-store.ts`
- Create: `src/frontend/src/store/obd-store.ts`

- [ ] **Step 1: Add `'obd'` to `LogScope` in `src/frontend/src/store/log-store.ts`**

Edit `src/frontend/src/store/log-store.ts`:

```ts
export type LogScope = 'parser' | 'render' | 'pdf' | 'scan' | 'ui' | 'cache' | 'perf' | 'update' | 'obd';

export const LOG_SCOPES: readonly LogScope[] = ['parser', 'render', 'pdf', 'scan', 'ui', 'cache', 'perf', 'update', 'obd'] as const;
```

And in the `log` export at the bottom:

```ts
export const log = {
  parser: logStore.createScopedLogger('parser'),
  render: logStore.createScopedLogger('render'),
  pdf:    logStore.createScopedLogger('pdf'),
  scan:   logStore.createScopedLogger('scan'),
  ui:     logStore.createScopedLogger('ui'),
  cache:  logStore.createScopedLogger('cache'),
  perf:   logStore.createScopedLogger('perf'),
  update: logStore.createScopedLogger('update'),
  obd:    logStore.createScopedLogger('obd'),
};
```

- [ ] **Step 2: Create `src/frontend/src/store/obd-store.ts`**

```ts
import { useSyncExternalStore } from 'react';
import { Emitter } from './emitter';
import { log } from './log-store';

// Mirrors the backend Match shape.
export interface ObdMatch {
  bpath: string;
  brand: string;
  category: string;
  fetched: boolean;
  fetched_at?: string | null;
}

// Mirrors the backend ObdData shape.
export interface ObdComponent { refdes: string; attrs: Record<string, string>; }
export interface ObdNet {
  name: string;
  qualifier: string;
  diode: string | null;
  voltage: string | null;
  resistance: string | null;
  aliases: string[];
  comments: string[];
}
export interface ObdHeader {
  timestamp: string | null;
  id: string | null;
  brand: string | null;
  category: string | null;
  comment: string | null;
}
export interface ObdData {
  bpath: string;
  source_url: string;
  fetched_at: string;
  header: ObdHeader;
  diagnosis: string;
  components: ObdComponent[];
  nets: ObdNet[];
}

interface IndexStatus {
  synced: boolean;
  synced_at: string | null;  // null when never synced; string when synced
  board_count: number;
}

class ObdStore extends Emitter {
  private _matchesByBn: Map<string, ObdMatch[]> = new Map();
  private _data: Map<string, ObdData> = new Map();
  private _fetching: Set<string> = new Set();
  private _index: IndexStatus = { synced: false, synced_at: null, board_count: 0 };
  private _syncing = false;
  private _error: string | null = null;
  private _snapshot = this._buildSnapshot();

  getSnapshot() { return this._snapshot; }

  private _buildSnapshot() {
    return {
      matchesByBn: this._matchesByBn,
      data: this._data,
      fetching: this._fetching,
      index: this._index,
      syncing: this._syncing,
      error: this._error,
    };
  }

  private _bump() {
    this._snapshot = this._buildSnapshot();
    this.notify();
  }

  /** Fetch /api/obd/match for one board_number; cached by board_number.
   *  Also updates _index from the response — the backend always returns
   *  index status, so any match call doubles as a status refresh. */
  async loadMatches(boardNumber: string): Promise<ObdMatch[]> {
    if (!boardNumber) return [];
    if (this._matchesByBn.has(boardNumber)) return this._matchesByBn.get(boardNumber)!;
    try {
      const res = await fetch(`/api/obd/match?board_number=${encodeURIComponent(boardNumber)}`);
      if (!res.ok) {
        if (res.status !== 503) log.obd.warn('match failed', res.status);
        this._matchesByBn.set(boardNumber, []);
        this._bump();
        return [];
      }
      const json = await res.json() as { matches: ObdMatch[]; index?: { synced: boolean; synced_at?: string; board_count: number } };
      this._matchesByBn.set(boardNumber, json.matches);
      if (json.index) {
        this._index = {
          synced: json.index.synced,
          synced_at: json.index.synced_at ?? null,
          board_count: json.index.board_count,
        };
      }
      this._bump();
      return json.matches;
    } catch (e) {
      log.obd.error('match fetch error', e);
      this._matchesByBn.set(boardNumber, []);
      this._bump();
      return [];
    }
  }

  /** Probe /api/obd/match with empty board_number to refresh index status. */
  async refreshStatus(): Promise<void> {
    try {
      const res = await fetch('/api/obd/match?board_number=');
      if (!res.ok) return;
      const json = await res.json() as { index?: { synced: boolean; synced_at?: string; board_count: number } };
      if (json.index) {
        this._index = {
          synced: json.index.synced,
          synced_at: json.index.synced_at ?? null,
          board_count: json.index.board_count,
        };
        this._bump();
      }
    } catch (e) {
      log.obd.warn('refreshStatus error', e);
    }
  }

  /** POST /api/obd/fetch?bpath=… — downloads, parses, caches. */
  async fetchBoard(bpath: string): Promise<ObdData | null> {
    if (this._fetching.has(bpath)) return null;
    this._fetching.add(bpath);
    this._bump();
    try {
      const res = await fetch(`/api/obd/fetch?bpath=${encodeURIComponent(bpath)}`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.text();
        log.obd.error('fetch failed', res.status, body);
        this._error = `Fetch failed: ${body || res.statusText}`;
        return null;
      }
      const data = await res.json() as ObdData;
      this._data.set(bpath, data);
      // Mark the corresponding match as fetched in any cached match list.
      for (const list of this._matchesByBn.values()) {
        for (const m of list) {
          if (m.bpath === bpath) { m.fetched = true; m.fetched_at = data.fetched_at; }
        }
      }
      return data;
    } finally {
      this._fetching.delete(bpath);
      this._bump();
    }
  }

  /** POST /api/obd/index/sync — long running, blocks until complete. */
  async syncIndex(): Promise<void> {
    if (this._syncing) return;
    this._syncing = true;
    this._error = null;
    this._bump();
    try {
      const res = await fetch('/api/obd/index/sync', { method: 'POST' });
      if (!res.ok) {
        const body = await res.text();
        this._error = `Sync failed: ${body || res.statusText}`;
        return;
      }
      const json = await res.json() as { synced_at: string; board_count: number };
      this._index = { synced: true, synced_at: json.synced_at, board_count: json.board_count };
      this._matchesByBn.clear(); // invalidate cached matches
    } finally {
      this._syncing = false;
      this._bump();
    }
  }

  /** DELETE /api/obd/cache — wipes everything. */
  async clearCache(): Promise<void> {
    const res = await fetch('/api/obd/cache', { method: 'DELETE' });
    if (!res.ok) {
      this._error = `Clear failed: ${res.statusText}`;
    } else {
      this._matchesByBn.clear();
      this._data.clear();
      this._index = { synced: false, synced_at: null, board_count: 0 };
    }
    this._bump();
  }

}

export const obdStore = new ObdStore();

/** React hook: returns { matches, fetched, fetch, update, isFetching } for one board. */
export function useObdForBoard(boardNumber: string | undefined) {
  const snap = useSyncExternalStore(
    (cb) => obdStore.subscribe(cb),
    () => obdStore.getSnapshot(),
  );
  const matches = boardNumber ? snap.matchesByBn.get(boardNumber) ?? null : null;
  const dataByBpath = snap.data;
  const fetching = snap.fetching;
  return {
    matches,
    dataByBpath,
    fetching,
    syncing: snap.syncing,
    indexSynced: snap.index.synced,
    indexBoardCount: snap.index.board_count,
    indexSyncedAt: snap.index.synced_at,
    error: snap.error,
    loadMatches: () => boardNumber ? obdStore.loadMatches(boardNumber) : Promise.resolve([]),
    fetchBoard: (bpath: string) => obdStore.fetchBoard(bpath),
    syncIndex: () => obdStore.syncIndex(),
    clearCache: () => obdStore.clearCache(),
    refreshStatus: () => obdStore.refreshStatus(),
  };
}
```

- [ ] **Step 3: Type-check the frontend**

```bash
cd src/frontend && npx tsc --noEmit
```

Expected: exit 0, no errors.

- [ ] **Step 4: Commit**

```bash
git add src/frontend/src/store/log-store.ts src/frontend/src/store/obd-store.ts
git commit -m "feat(obd): obdStore + useObdForBoard hook + obd log scope"
```

---

## Task 8: Settings — new "Library" tab

**Files:**
- Modify: `src/frontend/src/panels/SettingsPanel.tsx`

- [ ] **Step 1: Update tab type and ordering**

In `src/frontend/src/panels/SettingsPanel.tsx`, replace the `SettingsTabId` definition + arrays:

Old (line 43-52):

```ts
export type SettingsTabId = 'theme' | 'board' | 'input' | 'system';

const TAB_ORDER: SettingsTabId[] = ['theme', 'board', 'input', 'system'];

const TAB_LABELS: Record<SettingsTabId, string> = {
  theme:  'Theme',
  board:  'Board',
  input:  'Input',
  system: 'System',
};
```

New:

```ts
export type SettingsTabId = 'theme' | 'board' | 'input' | 'library' | 'system';

const TAB_ORDER: SettingsTabId[] = ['theme', 'board', 'input', 'library', 'system'];

const TAB_LABELS: Record<SettingsTabId, string> = {
  theme:   'Theme',
  board:   'Board',
  input:   'Input',
  library: 'Library',
  system:  'System',
};
```

- [ ] **Step 2: Add an `import` for the OBD hook at the top of the file**

Locate the existing import block at the top of `SettingsPanel.tsx`. Add (alphabetically among store imports):

```ts
import { useObdForBoard } from '../store/obd-store';
```

- [ ] **Step 3: Add the Library tab body**

In `SettingsPanel.tsx`, find the line near 1439 where the file renders `{activeTab === 'theme' && (...)}` and the other tab branches. After the `'input'` tab block and before the `'system'` tab block, insert:

```tsx
      {activeTab === 'library' && (
        <LibraryTab />
      )}
```

- [ ] **Step 4: Define the `LibraryTab` component at the bottom of `SettingsPanel.tsx`**

Append before the final `export function SettingsPanel(...)` if any, or at the end of the file:

```tsx
function LibraryTab() {
  const obd = useObdForBoard(undefined);
  const [confirming, setConfirming] = useState(false);

  // Cold-start: when the user opens this tab, refresh the index status
  // from disk so "Last synced: ..." reflects index.json without waiting
  // for the user to view a board first.
  useEffect(() => { obd.refreshStatus(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="settings-tab-body" data-testid="settings-library-tab">
      <div className="settings-section">
        <div className="settings-section-body">
          <h3 style={{ margin: '0 0 8px' }}>OpenBoardData</h3>
          <p style={{ fontSize: 12, color: '#888', lineHeight: 1.4, margin: '0 0 12px' }}>
            Per-net diagnostic measurements (diode / voltage / resistance) and repair notes from{' '}
            <a href="https://openboarddata.org" target="_blank" rel="noopener noreferrer">openboarddata.org</a>.
            Data is community-contributed under the <strong>ODbL 1.0</strong> license. BoardRipper does not bundle this data;
            you fetch it on demand. Re-distribution requires keeping the same license — see{' '}
            <a href="https://opendatacommons.org/licenses/odbl/1-0/" target="_blank" rel="noopener noreferrer">
              the license terms
            </a>.
          </p>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
            <button
              onClick={() => obd.syncIndex()}
              disabled={obd.syncing}
              data-testid="obd-sync-btn"
            >
              {obd.syncing ? 'Syncing…' : 'Sync OBD index'}
            </button>
            <span style={{ fontSize: 12, color: '#888' }}>
              {obd.indexSynced
                ? `Last synced: ${obd.indexSyncedAt} · ${obd.indexBoardCount} boards`
                : 'Never synced'}
            </span>
          </div>
          {obd.error && (
            <div style={{ color: '#c33', fontSize: 12, marginBottom: 8 }}>{obd.error}</div>
          )}

          <div style={{ marginTop: 12 }}>
            {!confirming ? (
              <button onClick={() => setConfirming(true)}>Delete all OBD data</button>
            ) : (
              <span>
                <strong>Are you sure?</strong>{' '}
                <button onClick={async () => { await obd.clearCache(); setConfirming(false); }}>
                  Yes, delete
                </button>{' '}
                <button onClick={() => setConfirming(false)}>Cancel</button>
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Type-check**

```bash
cd src/frontend && npx tsc --noEmit
```

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/frontend/src/panels/SettingsPanel.tsx
git commit -m "feat(obd): Settings 'Library' tab with disclaimer + sync button"
```

---

## Task 9: `ObdSection` component + LibraryPanel integration

**Files:**
- Create: `src/frontend/src/components/ObdSection.tsx`
- Modify: `src/frontend/src/panels/LibraryPanel.tsx`

- [ ] **Step 1: Create `src/frontend/src/components/ObdSection.tsx`**

```tsx
import { useEffect, useMemo, useState } from 'react';
import { useObdForBoard, type ObdData, type ObdNet } from '../store/obd-store';

export function ObdSection({ boardNumber }: { boardNumber: string }) {
  const obd = useObdForBoard(boardNumber);

  useEffect(() => {
    if (boardNumber) obd.loadMatches();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardNumber]);

  if (!obd.indexSynced && (obd.matches === null || obd.matches.length === 0)) {
    // Probe state — until the user syncs in Settings, we render nothing.
    return null;
  }
  if (obd.matches === null) return null; // still loading
  if (obd.matches.length === 0) return null;

  const fetchedDataPerVariant = obd.matches
    .map(m => ({ match: m, data: obd.dataByBpath.get(m.bpath) ?? null }))
    .filter(x => x.data !== null) as Array<{ match: typeof obd.matches[0]; data: ObdData }>;

  // Soft stale warning: if the index is older than 30 days, surface a chip.
  const stale = (() => {
    if (!obd.indexSyncedAt) return false;
    const age = Date.now() - new Date(obd.indexSyncedAt).getTime();
    return age > 30 * 24 * 60 * 60 * 1000;
  })();

  return (
    <div className="library-detail-section" data-testid="obd-section">
      <div className="library-detail-section-header">
        <strong>OpenBoardData</strong>
        {stale && (
          <span data-testid="obd-stale-warning" style={{ marginLeft: 8, fontSize: 10, color: '#c80', padding: '0 4px', border: '1px solid #c80', borderRadius: 6 }}>
            index may be stale — re-sync in Settings
          </span>
        )}
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '4px 0 8px', alignItems: 'center' }}>
        {obd.matches.map(m => {
          const isFetched = m.fetched || obd.dataByBpath.has(m.bpath);
          const isFetching = obd.fetching.has(m.bpath);
          const leaf = m.bpath.slice(m.bpath.lastIndexOf('/') + 1);
          const upstreamUrl = `https://openboarddata.org/?a=showboardsolutions&bpath=${encodeURIComponent(m.bpath)}`;
          return (
            <span key={m.bpath} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <button
                data-testid={`obd-chip-${leaf}`}
                data-fetched={isFetched ? 'true' : 'false'}
                onClick={() => obd.fetchBoard(m.bpath)}
                disabled={isFetching}
                style={{
                  padding: '2px 8px',
                  borderRadius: 12,
                  border: '1px solid #888',
                  background: isFetched ? '#3a5' : 'transparent',
                  color: isFetched ? '#fff' : 'inherit',
                  fontSize: 11,
                  cursor: isFetching ? 'wait' : 'pointer',
                }}
                title={isFetched ? 'Click to update' : 'Click to fetch'}
              >
                {leaf} {isFetching ? '…' : isFetched ? '↻' : '↓'}
              </button>
              <a
                href={upstreamUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={{ fontSize: 10, color: '#888', textDecoration: 'none' }}
                title={`Open ${m.bpath} on openboarddata.org`}
                data-testid={`obd-upstream-${leaf}`}
              >
                ↗
              </a>
            </span>
          );
        })}
      </div>
      {fetchedDataPerVariant.length > 0 && (
        <ObdMeasurementTable variants={fetchedDataPerVariant} />
      )}
    </div>
  );
}

function ObdMeasurementTable({ variants }: {
  variants: Array<{ match: { bpath: string }; data: ObdData }>;
}) {
  const [search, setSearch] = useState('');

  // Build a merged net map: net name → (variantBpath → ObdNet).
  const merged = useMemo(() => {
    const map = new Map<string, Map<string, ObdNet>>();
    for (const v of variants) {
      for (const net of v.data.nets) {
        if (!map.has(net.name)) map.set(net.name, new Map());
        map.get(net.name)!.set(v.match.bpath, net);
      }
    }
    return map;
  }, [variants]);

  const filteredNets = useMemo(() => {
    const q = search.toLowerCase();
    return Array.from(merged.entries())
      .filter(([name]) => !q || name.toLowerCase().includes(q))
      .sort((a, b) => a[0].localeCompare(b[0]));
  }, [merged, search]);

  // Diagnosis: union of all variants' diagnosis text (header per variant).
  const [diagnosisOpen, setDiagnosisOpen] = useState(false);
  const hasDiagnosis = variants.some(v => v.data.diagnosis.trim());

  return (
    <>
      {hasDiagnosis && (
        <div style={{ margin: '4px 0' }}>
          <button onClick={() => setDiagnosisOpen(o => !o)} style={{ fontSize: 11 }}>
            {diagnosisOpen ? '▾' : '▸'} Diagnostic notes
          </button>
          {diagnosisOpen && (
            <div style={{ fontSize: 11, padding: 6, background: '#222', whiteSpace: 'pre-wrap' }}>
              {variants.map(v => v.data.diagnosis.trim() && (
                <div key={v.match.bpath} style={{ marginBottom: 6 }}>
                  <strong>{v.match.bpath.slice(v.match.bpath.lastIndexOf('/') + 1)}:</strong>
                  {'\n'}{v.data.diagnosis}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <input
        type="search"
        placeholder="Filter nets…"
        value={search}
        onChange={e => setSearch(e.target.value)}
        style={{ width: '100%', marginBottom: 4, fontSize: 11 }}
        data-testid="obd-search"
      />

      <div style={{ maxHeight: 300, overflow: 'auto' }}>
        <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse' }} data-testid="obd-table">
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>Net</th>
              {variants.map(v => (
                <th key={v.match.bpath} style={{ textAlign: 'left' }}>
                  {v.match.bpath.slice(v.match.bpath.lastIndexOf('/') + 1)}
                  <div style={{ fontSize: 9, color: '#888' }}>d / V / Ω</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filteredNets.map(([name, byBpath]) => (
              <tr key={name}>
                <td>{name}</td>
                {variants.map(v => {
                  const n = byBpath.get(v.match.bpath);
                  if (!n) return <td key={v.match.bpath}>—</td>;
                  return (
                    <td key={v.match.bpath} title={n.comments.join(' / ')}>
                      {n.diode ?? '—'} / {n.voltage ?? '—'} / {n.resistance ?? '—'}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
```

- [ ] **Step 2: Render `<ObdSection>` inside `FileDetailPane` in `LibraryPanel.tsx`**

Open `src/frontend/src/panels/LibraryPanel.tsx`. Locate the `FileDetailPane` function (around line 736).

Add this import near the top of the file (alongside the other component imports):

```ts
import { ObdSection } from '../components/ObdSection';
```

Inside the JSX returned by `FileDetailPane` (the `<div className="library-detail">` block starting at line 765), add the `<ObdSection>` for board files. Find the line that says `{isBoard && (` or, if there's no such conditional, find the closing tag of the bindings table. Insert just before the closing `</div>` of `<div className="library-detail">`:

```tsx
        {isBoard && detail.board_number && (
          <ObdSection boardNumber={detail.board_number} />
        )}
```

If there's no obvious place, add it as the very last child of the outer `<div className="library-detail">`.

- [ ] **Step 3: Type-check**

```bash
cd src/frontend && npx tsc --noEmit
```

Expected: exit 0.

- [ ] **Step 4: Run the dev server and verify by hand**

```bash
cd src/frontend && npm run dev &
# in another terminal
cd src/backend && DATA_DIR=/tmp/br-obd-smoke LIBRARY_DIR=/tmp/br-obd-smoke-lib PORT=1336 go run .
```

In a browser:
1. Open the Library panel; pick a known Apple board file.
2. Open Settings → Library tab; click "Sync OBD index" (this scrapes openboarddata.org — takes 30-60s).
3. Wait for sync to complete; switch back to Library; the OBD section should show chips for matching boards.
4. Click a chip; the measurement table should populate.

Kill both processes after verifying.

- [ ] **Step 5: Commit**

```bash
git add src/frontend/src/components/ObdSection.tsx src/frontend/src/panels/LibraryPanel.tsx
git commit -m "feat(obd): ObdSection in LibraryPanel detail with multi-variant table"
```

---

## Task 10: Playwright E2E spec

**Files:**
- Create: `src/frontend/tests/obd.spec.ts`

- [ ] **Step 1: Write the spec**

Create `src/frontend/tests/obd.spec.ts`:

```ts
import { test, expect } from '@playwright/test';

const SAMPLE_OBD = `OBDATA_V002 https://openboarddata.org
TIMESTAMP 1714521600
BOARDPATH laptops/apple/820-00045
ID demo
BRAND apple
CATEGORY laptops
COMMENT E2E fixture

NETS_DATA_START
PP3V3_S0_REG/Default d 0.450 ''
PP3V3_S0_REG/Default v 3.30 ''
NETS_DATA_END
`;

test.describe('OpenBoardData integration', () => {
  test('OBD section is hidden when index is not synced', async ({ page }) => {
    // Stub the match endpoint to return no matches.
    await page.route('**/api/obd/match*', (route) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify({ matches: [] }) }),
    );
    await page.goto('/');
    // Navigate to Library and select a board (project-specific UI; adapt
    // selectors to whatever the existing library-panel.spec.ts uses).
    // Then assert ObdSection is absent:
    await expect(page.getByTestId('obd-section')).toHaveCount(0);
  });

  test('OBD chip + table render after fetch', async ({ page }) => {
    await page.route('**/api/obd/match*', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          matches: [{
            bpath: 'laptops/apple/820-00045',
            brand: 'apple',
            category: 'laptops',
            fetched: false,
            fetched_at: null,
          }],
        }),
      }),
    );
    await page.route('**/api/obd/fetch*', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          bpath: 'laptops/apple/820-00045',
          source_url: 'https://openboarddata.org/?a=showboardsolutions&bpath=laptops/apple/820-00045',
          fetched_at: '2026-05-01T12:00:00Z',
          header: { timestamp: null, id: 'demo', brand: 'apple', category: 'laptops', comment: 'E2E fixture' },
          diagnosis: '',
          components: [],
          nets: [
            { name: 'PP3V3_S0_REG', qualifier: 'Default', diode: '0.450', voltage: '3.30', resistance: null, aliases: [], comments: [] },
          ],
        }),
      }),
    );
    await page.goto('/');
    // Navigate, select a 820-* board file (adapt selectors)
    // Click the chip
    await page.getByTestId('obd-chip-820-00045').click();
    // Table renders with the expected net
    await expect(page.getByTestId('obd-table')).toBeVisible();
    await expect(page.getByTestId('obd-table')).toContainText('PP3V3_S0_REG');
    expect(SAMPLE_OBD).toContain('OBDATA_V002');
  });
});
```

- [ ] **Step 2: Run the spec**

```bash
cd src/frontend && npx playwright test tests/obd.spec.ts
```

Expected: both tests pass. If they fail because of project-specific selectors needed to navigate to the Library panel, **read** `src/frontend/tests/library-panel.spec.ts` and **copy the navigation pattern verbatim** before adjusting selectors. Do NOT introduce new test infrastructure.

- [ ] **Step 3: Commit**

```bash
git add src/frontend/tests/obd.spec.ts
git commit -m "test(obd): Playwright spec for OBD section + chip + table"
```

---

## Task 11: Final verification

- [ ] **Step 1: Full backend test run**

```bash
cd src/backend && go test ./...
```

Expected: all tests pass.

- [ ] **Step 2: Full frontend type-check + lint + tests**

```bash
cd src/frontend && npx tsc --noEmit && npx playwright test tests/obd.spec.ts
```

Expected: clean.

- [ ] **Step 3: Smoke test against real openboarddata.org**

Start the backend with a real library directory containing at least one Apple `820-*` board file. In the browser:

1. Settings → Library → Sync OBD index. Verify the sync completes and the status updates.
2. Library → select an Apple board → verify chips appear.
3. Click a chip → verify table populates with real measurements.
4. Verify the same chip now shows the "fetched" visual state.
5. Click "Delete all OBD data" → verify chips disappear and clicking re-fetches.

If any step fails, file an issue with the actual response from openboarddata.org and fix the parser/scraper accordingly. **Do not move forward without this smoke test passing.**

- [ ] **Step 4: Push the branch**

```bash
git push origin HEAD
```

---

## Spec coverage check

| Spec section | Implemented in |
|---|---|
| `index.json` shape | Task 1 (types), Task 4 (writer) |
| `<bpath>.txt` + `<bpath>.parsed.json` cache | Task 3 (store) |
| Backend Go package layout | Tasks 1–5 |
| Four HTTP endpoints | Task 5 |
| Single-flight on sync + per-bpath fetch | Task 5 |
| Drop guard (< 50%) | Task 4 |
| Hard cap (50 pages) | Task 4 |
| User-Agent | Task 4 |
| Atomic writes | Task 3 |
| `OBDATA_V002` parser (header / DIAGNOSIS / COMPONENTS / NETS, multi-variant) | Task 2 |
| `obdStore` + `useObdForBoard` | Task 7 |
| Settings → Library tab + disclaimer + sync button + clear cache | Task 8 |
| `ObdSection` (chips, multi-variant side-by-side table, search, diagnosis) | Task 9 |
| 30-day stale-index soft warning | Task 9 |
| "Open upstream" `↗` link per chip | Task 9 |
| Index status returned by `/api/obd/match` (no separate endpoint) | Task 5 (Match handler) |
| `obdStore.refreshStatus()` for cold-start status probe | Task 7 + Task 8 (LibraryTab useEffect) |
| Decoupling from `boards.db` (no schema changes) | All tasks — verified by inspection |
| Playwright spec | Task 10 |

## Out of scope (deferred per spec)

- Canvas pin-hover tooltip
- `ComponentInfoPanel` enrichment with diode / V / Ω columns
- `board_openboarddata` table population (boards.db v2 follow-up)
- Background / scheduled sync
- ETag-based incremental sync
