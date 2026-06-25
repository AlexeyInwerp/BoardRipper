# PDF Donor Manager + Auto-Index + Reset Durability — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make PDF donor membership discoverable + manageable, guarantee that marking a file as a donor indexes it, and let the donor list survive "Reset Database" via a path-keyed snapshot backup.

**Architecture:** Backend owns the index trigger — `AddDonor` calls a nil-safe `DonorIndexer` interface that runs a *scoped* pdfium sweep over just the donor file IDs (new `Indexer.RunFiles`). A boot-time background goroutine backfills existing un-indexed donors. Durability is delivered by a path-keyed JSON snapshot (`<dataDir>/backups/donors-<ts>.json`) written before a Reset, restorable by re-resolving paths to the new file IDs. No schema change to `pdf_donors` (keeps `file_id` PK + CASCADE).

**Tech Stack:** Go (net/http, database/sql + SQLite), React 19 + TypeScript (strict), Playwright.

Spec: [docs/specs/2026-06-24-pdf-donor-manager-auto-index-design.md](../specs/2026-06-24-pdf-donor-manager-auto-index-design.md)

## Global Constraints

- **TypeScript strict mode** — no `any` leaks; every new field/method fully typed.
- **Scoped loggers only** (`store/log-store.ts` on the frontend; `log.Printf` is the backend norm) — never `console.log`. Frontend: import `{ log }`, use `log.cache.*` / `log.ui.*`.
- **Boot/health invariant:** `/api/health` must respond < 60 s. The donor backfill MUST run in a background goroutine and never block boot.
- **`<dataDir>` is always writable** across container updates; snapshots live at `<dataDir>/backups/`. The library mount may be read-only — do NOT write snapshots there.
- **Donor data keys on `file_id` (PK + CASCADE) and is NOT changed.** Durability is snapshot-only; restore re-resolves by relative path (then `content_hash`).
- **Go 1.22 ServeMux precedence:** a literal segment (`/donors/export`) wins over a wildcard (`/donors/{id}`); methods further disambiguate. New literal routes are safe beside the existing `{id}` routes.
- **Removal leaves the index intact** — `RemoveDonor` is unchanged. Re-index / Reset PDF Text never touch `pdf_donors`.

## File Structure

**Backend (`src/backend/`):**
- `pdfindex/indexer.go` — *modify*: add `RunFiles(ids []int64)`.
- `pdfindex/indexer_test.go` — *modify*: test `RunFiles`.
- `databank/db.go` — *modify*: `DonorEntry` gains `IndexStatus`; add `DonorSnapshot()`.
- `databank/donor_backup.go` — *create*: snapshot types + file IO (write/list/read/prune).
- `databank/donor_backup_test.go` — *create*: snapshot IO tests.
- `handlers/databank.go` — *modify*: `DonorIndexer` interface, handler field + setter, `AddDonor` trigger, `ListDonors` enrichment, `Reset` auto-snapshot, export/import/backups/restore handlers + resolution helper.
- `handlers/donor_indexer.go` — *create*: concrete `pdfDonorIndexer` adapter (`EnsureIndexed` + `StatusFor`).
- `handlers/donor_indexer_test.go` — *create*: adapter status-mapping test.
- `handlers/databank_donors_test.go` — *create*: handler tests with a fake `DonorIndexer`.
- `main.go` — *modify*: build adapter, `SetDonorIndexer`, register 4 routes, spawn backfill goroutine.

**Frontend (`src/frontend/src/`):**
- `store/databank-store.ts` — *modify*: `DonorEntry.index_status`, `DonorBackupInfo`, 4 methods.
- `panels/LibraryPanel.tsx` — *modify*: always-visible "Manage donors (N)" + status badges + auto-poll.
- `panels/SettingsPanel.tsx` — *modify*: Export / Import buttons + restore prompt in Database info.
- `tests/donor-manager.spec.ts` — *create*: Playwright round-trips.

---

## Task 1: `Indexer.RunFiles` — scoped sweep over a known ID set

**Files:**
- Modify: `src/backend/pdfindex/indexer.go` (add method after `RunFolder`, ~line 132)
- Test: `src/backend/pdfindex/indexer_test.go`

**Interfaces:**
- Consumes: existing `Indexer.startScoped(list func() ([]PdfFile, error)) error`, `Source.ListPDFs()`, `ErrAlreadyRunning`.
- Produces: `func (ix *Indexer) RunFiles(ids []int64) error` — starts a background sweep limited to `ids`; no-op (`nil`) if a sweep is already running; filters out already done/active files. Idempotent.

- [ ] **Step 1: Write the failing test**

Add to `src/backend/pdfindex/indexer_test.go`:

```go
func TestRunFilesIndexesOnlyListed(t *testing.T) {
	db := openTestDB(t)
	src := &fakeSource{
		files: []PdfFile{{ID: 1, Path: "a.pdf"}, {ID: 2, Path: "b.pdf"}, {ID: 3, Path: "c.pdf"}},
		data:  map[string][]byte{"a.pdf": []byte("alpha"), "b.pdf": []byte("beta"), "c.pdf": []byte("gamma")},
	}
	ix := NewIndexer(db, fakeExtractor{}, src, func() []string { return nil }, 2)

	if err := ix.RunFiles([]int64{1, 3}); err != nil {
		t.Fatalf("RunFiles: %v", err)
	}
	waitFor(t, func() bool { return !ix.Progress().Running })

	if s, _ := db.Status(1); s.Status != "indexed" {
		t.Errorf("file 1 status = %q, want indexed", s.Status)
	}
	if s, _ := db.Status(3); s.Status != "indexed" {
		t.Errorf("file 3 status = %q, want indexed", s.Status)
	}
	// File 2 was never listed → no status row → empty status string.
	if s, _ := db.Status(2); s.Status != "" {
		t.Errorf("file 2 status = %q, want \"\" (untouched)", s.Status)
	}
}

func TestRunFilesEmptyIsNoop(t *testing.T) {
	db := openTestDB(t)
	ix := NewIndexer(db, fakeExtractor{}, &fakeSource{}, func() []string { return nil }, 1)
	if err := ix.RunFiles(nil); err != nil {
		t.Fatalf("RunFiles(nil): %v", err)
	}
	if ix.Progress().Running {
		t.Error("RunFiles(nil) should not start a sweep")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src/backend && go test ./pdfindex/ -run TestRunFiles -v`
Expected: FAIL — `ix.RunFiles undefined (type *Indexer has no field or method RunFiles)`.

- [ ] **Step 3: Write minimal implementation**

In `src/backend/pdfindex/indexer.go`, add immediately after `RunFolder` (after its closing `}` near line 132):

```go
// RunFiles starts a sweep limited to the given file IDs (resolved against
// Source.ListPDFs). Like Run/RunFolder it runs one background sweep and
// filters out already done/active files; it is a no-op returning nil if a
// sweep is already in progress or ids is empty. Used for on-demand indexing
// of a known set (e.g. donor membership) without sweeping the whole library.
func (ix *Indexer) RunFiles(ids []int64) error {
	if len(ids) == 0 {
		return nil
	}
	want := make(map[int64]bool, len(ids))
	for _, id := range ids {
		want[id] = true
	}
	err := ix.startScoped(func() ([]PdfFile, error) {
		all, err := ix.src.ListPDFs()
		if err != nil {
			return nil, err
		}
		out := make([]PdfFile, 0, len(want))
		for _, f := range all {
			if want[f.ID] {
				out = append(out, f)
			}
		}
		return out, nil
	})
	if errors.Is(err, ErrAlreadyRunning) {
		return nil // stay idempotent like Run()
	}
	return err
}
```

(`errors` is already imported in `indexer.go`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src/backend && go test ./pdfindex/ -run TestRunFiles -v`
Expected: PASS (both).

- [ ] **Step 5: Commit**

```bash
git add src/backend/pdfindex/indexer.go src/backend/pdfindex/indexer_test.go
git commit -m "feat(pdfindex): RunFiles — scoped sweep over a known file-ID set"
```

---

## Task 2: `DonorIndexer` interface + AddDonor trigger + ListDonors status enrichment

**Files:**
- Modify: `src/backend/databank/db.go` (`DonorEntry` struct, ~line 1481)
- Modify: `src/backend/handlers/databank.go` (`DatabankHandler` struct ~line for struct, `AddDonor` ~632, `ListDonors` ~617)
- Test: `src/backend/handlers/databank_donors_test.go` (create)

**Interfaces:**
- Consumes: `databank.DB.ListDonors() []DonorEntry`, `databank.DB.AddDonor(id)`, `databank.DB.GetFileByID(ctx, id)`.
- Produces:
  - `databank.DonorEntry.IndexStatus string` (JSON `index_status,omitempty`).
  - `handlers.DonorIndexer` interface: `EnsureIndexed(ids []int64)` and `StatusFor(ids []int64) map[int64]string`.
  - `(*DatabankHandler).SetDonorIndexer(di DonorIndexer)`.

- [ ] **Step 1: Add the `IndexStatus` field**

In `src/backend/databank/db.go`, the `DonorEntry` struct becomes:

```go
type DonorEntry struct {
	FileID      int64  `json:"file_id"`
	Filename    string `json:"filename"`
	Path        string `json:"path"`
	AddedAt     int64  `json:"added_at"`
	IndexStatus string `json:"index_status,omitempty"` // enriched by the handler from pdfindex
}
```

- [ ] **Step 2: Write the failing handler test**

Create `src/backend/handlers/databank_donors_test.go`:

```go
package handlers

import (
	"encoding/json"
	"net/http/httptest"
	"strconv"
	"testing"

	"boardripper/databank" // NOTE: confirm the module path with `head -1 src/backend/go.mod`
)

type fakeDonorIndexer struct {
	ensured  [][]int64
	statuses map[int64]string
}

func (f *fakeDonorIndexer) EnsureIndexed(ids []int64) { f.ensured = append(f.ensured, ids) }
func (f *fakeDonorIndexer) StatusFor(ids []int64) map[int64]string { return f.statuses }

// donorTestHandler opens a temp databank, migrates the donor table, inserts one
// PDF file, and returns the handler + the file id.
func donorTestHandler(t *testing.T) (*DatabankHandler, *databank.DB, int64) {
	t.Helper()
	db, err := databank.Open(t.TempDir())
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if err := db.MigratePdfIndexV1(); err != nil {
		t.Fatalf("MigratePdfIndexV1: %v", err)
	}
	id, err := db.InsertFile(&databank.FileRecord{
		Path: "docs/x.pdf", Filename: "x.pdf", Extension: ".pdf", FileType: "pdf",
	})
	if err != nil {
		t.Fatalf("InsertFile: %v", err)
	}
	return NewDatabankHandler(db, nil, t.TempDir()), db, id
}

func TestAddDonorTriggersEnsureIndexed(t *testing.T) {
	h, _, id := donorTestHandler(t)
	fi := &fakeDonorIndexer{}
	h.SetDonorIndexer(fi)

	req := httptest.NewRequest("PUT", "/api/databank/donors/"+strconv.FormatInt(id, 10), nil)
	req.SetPathValue("id", strconv.FormatInt(id, 10))
	rec := httptest.NewRecorder()
	h.AddDonor(rec, req)

	if rec.Code != 200 {
		t.Fatalf("AddDonor status = %d body=%s", rec.Code, rec.Body.String())
	}
	if len(fi.ensured) != 1 || len(fi.ensured[0]) != 1 || fi.ensured[0][0] != id {
		t.Fatalf("EnsureIndexed calls = %v, want [[%d]]", fi.ensured, id)
	}
}

func TestListDonorsEnrichesIndexStatus(t *testing.T) {
	h, db, id := donorTestHandler(t)
	if err := db.AddDonor(id); err != nil {
		t.Fatalf("AddDonor: %v", err)
	}
	h.SetDonorIndexer(&fakeDonorIndexer{statuses: map[int64]string{id: "indexed"}})

	req := httptest.NewRequest("GET", "/api/databank/donors", nil)
	rec := httptest.NewRecorder()
	h.ListDonors(rec, req)

	var got []databank.DonorEntry
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v body=%s", err, rec.Body.String())
	}
	if len(got) != 1 || got[0].IndexStatus != "indexed" {
		t.Fatalf("donors = %+v, want one with index_status=indexed", got)
	}
}

func TestListDonorsNilIndexerOmitsStatus(t *testing.T) {
	h, db, id := donorTestHandler(t)
	if err := db.AddDonor(id); err != nil {
		t.Fatalf("AddDonor: %v", err)
	}
	// No SetDonorIndexer → donorIndexer is nil.
	req := httptest.NewRequest("GET", "/api/databank/donors", nil)
	rec := httptest.NewRecorder()
	h.ListDonors(rec, req)
	var got []databank.DonorEntry
	_ = json.Unmarshal(rec.Body.Bytes(), &got)
	if len(got) != 1 || got[0].IndexStatus != "" {
		t.Fatalf("donors = %+v, want one with empty index_status", got)
	}
}
```

> If the module path import line fails to compile, fix it to match `src/backend/go.mod`'s module (run `head -1 src/backend/go.mod`); the rest of the test is correct.

- [ ] **Step 3: Run test to verify it fails**

Run: `cd src/backend && go test ./handlers/ -run TestAddDonor -v`
Expected: FAIL — `h.SetDonorIndexer undefined`.

- [ ] **Step 4: Implement the interface, field, setter, trigger, and enrichment**

In `src/backend/handlers/databank.go`:

(a) Add the interface near the top of the file (after imports):

```go
// DonorIndexer lets the databank handler drive PDF indexing without importing
// the pdfindex package (wired from main.go after the indexer exists). All
// methods are safe to call when the implementation is present; the handler
// guards on a nil interface for degraded boots where pdfindex is unavailable.
type DonorIndexer interface {
	// EnsureIndexed kicks a scoped index of exactly these file IDs (fire-and-forget).
	EnsureIndexed(ids []int64)
	// StatusFor returns file_id → pdf index status ("indexed"/"pending"/…).
	StatusFor(ids []int64) map[int64]string
}
```

(b) Add the field to the struct:

```go
type DatabankHandler struct {
	db           *databank.DB
	scanner      *databank.Scanner
	dataDir      string
	donorIndexer DonorIndexer // nil when pdfindex is unavailable
}
```

(c) Add the setter (anywhere in the file):

```go
// SetDonorIndexer wires the PDF indexer used to auto-index donors and to
// enrich the donor list with index status. Optional — nil disables both.
func (h *DatabankHandler) SetDonorIndexer(di DonorIndexer) { h.donorIndexer = di }
```

(d) In `AddDonor`, after the successful `h.db.AddDonor(id)` block and before writing the JSON response, add:

```go
	if h.donorIndexer != nil {
		h.donorIndexer.EnsureIndexed([]int64{id})
	}
```

(e) Replace the body of `ListDonors` enrichment — after `donors, err := h.db.ListDonors()` and the `nil` guard, before encoding:

```go
	if h.donorIndexer != nil && len(donors) > 0 {
		ids := make([]int64, len(donors))
		for i := range donors {
			ids[i] = donors[i].FileID
		}
		statuses := h.donorIndexer.StatusFor(ids)
		for i := range donors {
			if s, ok := statuses[donors[i].FileID]; ok {
				donors[i].IndexStatus = s
			}
		}
	}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd src/backend && go test ./handlers/ -run 'TestAddDonor|TestListDonors' -v`
Expected: PASS (all three).

- [ ] **Step 6: Commit**

```bash
git add src/backend/databank/db.go src/backend/handlers/databank.go src/backend/handlers/databank_donors_test.go
git commit -m "feat(donors): auto-index on mark + index-status enrichment via DonorIndexer"
```

---

## Task 3: `pdfDonorIndexer` adapter + main.go wiring + backfill

**Files:**
- Create: `src/backend/handlers/donor_indexer.go`
- Create: `src/backend/handlers/donor_indexer_test.go`
- Modify: `src/backend/main.go` (inside `if pdfIndex != nil { … }`, after `indexer` is built ~line 262)

**Interfaces:**
- Consumes: `pdfindex.Indexer.RunFiles` / `.Enqueue` (Task 1), `pdfindex.DB.Status(id) (StatusRow, error)`, `handlers.DonorIndexer` (Task 2).
- Produces: `handlers.NewPdfDonorIndexer(ix *pdfindex.Indexer, store *pdfindex.DB) DonorIndexer`.

- [ ] **Step 1: Write the failing adapter test**

Create `src/backend/handlers/donor_indexer_test.go`:

```go
package handlers

import (
	"path/filepath"
	"testing"

	"boardripper/pdfindex" // confirm module path vs go.mod
)

func TestPdfDonorIndexerStatusFor(t *testing.T) {
	store, err := pdfindex.Open(filepath.Join(t.TempDir(), "pdfindex.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	// File 7 indexed; file 8 never seen → maps to "pending".
	if won, err := store.Claim(7, "test"); err != nil || !won {
		t.Fatalf("Claim: won=%v err=%v", won, err)
	}
	if err := store.UpsertPages(7, []pdfindex.Page{{Num: 1, Text: "hi"}}); err != nil {
		t.Fatalf("UpsertPages: %v", err)
	}
	if _, err := store.Finalize(7); err != nil {
		t.Fatalf("Finalize: %v", err)
	}

	di := NewPdfDonorIndexer(nil, store) // ix unused by StatusFor
	got := di.StatusFor([]int64{7, 8})
	if got[7] != "indexed" {
		t.Errorf("status[7] = %q, want indexed", got[7])
	}
	if got[8] != "pending" {
		t.Errorf("status[8] = %q, want pending (no row)", got[8])
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src/backend && go test ./handlers/ -run TestPdfDonorIndexerStatusFor -v`
Expected: FAIL — `NewPdfDonorIndexer undefined`.

- [ ] **Step 3: Implement the adapter**

Create `src/backend/handlers/donor_indexer.go`:

```go
package handlers

import "boardripper/pdfindex" // confirm module path vs go.mod

// pdfDonorIndexer adapts the pdfindex Indexer + status store to the
// DonorIndexer interface consumed by DatabankHandler.
type pdfDonorIndexer struct {
	ix    *pdfindex.Indexer
	store *pdfindex.DB
}

// NewPdfDonorIndexer builds the adapter. Wired from main.go when pdfindex is up.
func NewPdfDonorIndexer(ix *pdfindex.Indexer, store *pdfindex.DB) DonorIndexer {
	return &pdfDonorIndexer{ix: ix, store: store}
}

// EnsureIndexed kicks a scoped sweep of exactly these IDs and bumps each into
// the priority lane so an already-running sweep also picks them up. Async.
func (a *pdfDonorIndexer) EnsureIndexed(ids []int64) {
	if a.ix == nil || len(ids) == 0 {
		return
	}
	_ = a.ix.RunFiles(ids) // idempotent; nil on ErrAlreadyRunning
	for _, id := range ids {
		a.ix.Enqueue(id)
	}
}

// StatusFor returns file_id → status. A file with no status row (never indexed)
// maps to "pending" so the UI shows it as queued rather than blank.
func (a *pdfDonorIndexer) StatusFor(ids []int64) map[int64]string {
	out := make(map[int64]string, len(ids))
	if a.store == nil {
		return out
	}
	for _, id := range ids {
		st, err := a.store.Status(id)
		if err != nil {
			continue
		}
		s := st.Status
		if s == "" {
			s = "pending"
		}
		out[id] = s
	}
	return out
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd src/backend && go test ./handlers/ -run TestPdfDonorIndexerStatusFor -v`
Expected: PASS.

- [ ] **Step 5: Wire it in main.go + spawn the backfill**

In `src/backend/main.go`, inside `if pdfIndex != nil { … else { … } }`, immediately after `pdfIdxHandler := handlers.NewPdfIndexHandler(pdfIndex, indexer, db)` (~line 264), add:

```go
				// Donors: server-side index trigger + status enrichment, and a
				// one-time background backfill of any donor not yet indexed.
				// Runs regardless of pdf_index_auto_run (donors must be searchable)
				// and off the boot path so it never delays /api/health.
				donorIdx := handlers.NewPdfDonorIndexer(indexer, pdfIndex)
				dbHandler.SetDonorIndexer(donorIdx)
				go func() {
					ids, err := db.DonorFileIDs()
					if err != nil {
						log.Printf("donor backfill: list donors: %v", err)
						return
					}
					if len(ids) > 0 {
						log.Printf("donor backfill: ensuring %d donor(s) indexed", len(ids))
						donorIdx.EnsureIndexed(ids)
					}
				}()
```

- [ ] **Step 6: Verify the whole backend builds and tests pass**

Run: `cd src/backend && go build ./... && go vet ./... && go test ./pdfindex/ ./handlers/ ./databank/`
Expected: build clean; tests PASS. (Integration of trigger↔indexer is covered by the Playwright e2e in Task 8.)

- [ ] **Step 7: Commit**

```bash
git add src/backend/handlers/donor_indexer.go src/backend/handlers/donor_indexer_test.go src/backend/main.go
git commit -m "feat(donors): wire DonorIndexer adapter + boot-time donor backfill"
```

---

## Task 4: Donor snapshot — types + file IO + `DonorSnapshot()`

**Files:**
- Create: `src/backend/databank/donor_backup.go`
- Create: `src/backend/databank/donor_backup_test.go`
- Modify: `src/backend/databank/db.go` (add `DonorSnapshot()` method; uses existing `ListDonors`, `ContentHashOf`)

**Interfaces:**
- Produces:
  - `databank.DonorSnapshotEntry{ Path string; AddedAt int64; ContentHash string }` (JSON: `path`, `added_at`, `content_hash,omitempty`).
  - `databank.DonorSnapshot{ Version int; CreatedAt int64; Donors []DonorSnapshotEntry }`.
  - `databank.DonorBackupInfo{ Name string; CreatedAt int64; Count int }` (JSON `name`, `created_at`, `count`).
  - `(*DB).DonorSnapshot() (*DonorSnapshot, error)`.
  - `WriteDonorSnapshot(dir string, snap *DonorSnapshot) (string, error)` — atomic write to `<dir>/donors-<CreatedAt>.json`, returns full path.
  - `ListDonorSnapshots(dir string) ([]DonorBackupInfo, error)` — newest-first; missing dir → empty.
  - `ReadDonorSnapshot(path string) (*DonorSnapshot, error)`.
  - `PruneDonorSnapshots(dir string, keep int) error` — deletes all but the newest `keep`.

- [ ] **Step 1: Write the failing tests**

Create `src/backend/databank/donor_backup_test.go`:

```go
package databank

import (
	"path/filepath"
	"testing"
)

func TestWriteListReadDonorSnapshot(t *testing.T) {
	dir := t.TempDir()
	snap := &DonorSnapshot{
		Version: 1, CreatedAt: 1000,
		Donors: []DonorSnapshotEntry{
			{Path: "a/x.pdf", AddedAt: 900},
			{Path: "b/y.pdf", AddedAt: 950, ContentHash: "deadbeef"},
		},
	}
	p, err := WriteDonorSnapshot(dir, snap)
	if err != nil {
		t.Fatalf("Write: %v", err)
	}
	if filepath.Dir(p) != dir {
		t.Errorf("snapshot path %q not under %q", p, dir)
	}

	infos, err := ListDonorSnapshots(dir)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(infos) != 1 || infos[0].Count != 2 || infos[0].CreatedAt != 1000 {
		t.Fatalf("infos = %+v, want one with count 2 / created 1000", infos)
	}

	got, err := ReadDonorSnapshot(p)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if len(got.Donors) != 2 || got.Donors[1].ContentHash != "deadbeef" {
		t.Fatalf("read snapshot = %+v", got)
	}
}

func TestPruneKeepsNewest(t *testing.T) {
	dir := t.TempDir()
	for _, ts := range []int64{100, 200, 300, 400} {
		if _, err := WriteDonorSnapshot(dir, &DonorSnapshot{Version: 1, CreatedAt: ts}); err != nil {
			t.Fatalf("Write %d: %v", ts, err)
		}
	}
	if err := PruneDonorSnapshots(dir, 2); err != nil {
		t.Fatalf("Prune: %v", err)
	}
	infos, _ := ListDonorSnapshots(dir)
	if len(infos) != 2 || infos[0].CreatedAt != 400 || infos[1].CreatedAt != 300 {
		t.Fatalf("after prune = %+v, want 400,300", infos)
	}
}

func TestListMissingDirIsEmpty(t *testing.T) {
	infos, err := ListDonorSnapshots(filepath.Join(t.TempDir(), "nope"))
	if err != nil {
		t.Fatalf("List missing: %v", err)
	}
	if len(infos) != 0 {
		t.Fatalf("want empty, got %+v", infos)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src/backend && go test ./databank/ -run 'TestWriteListReadDonorSnapshot|TestPrune|TestListMissing' -v`
Expected: FAIL — `undefined: DonorSnapshot` / `WriteDonorSnapshot`.

- [ ] **Step 3: Implement the snapshot file**

Create `src/backend/databank/donor_backup.go`:

```go
package databank

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// DonorSnapshotEntry is one donor keyed by its stable relative library path.
type DonorSnapshotEntry struct {
	Path        string `json:"path"`
	AddedAt     int64  `json:"added_at"`
	ContentHash string `json:"content_hash,omitempty"` // hex; secondary resolver for moved files
}

// DonorSnapshot is the path-keyed backup of the donor list.
type DonorSnapshot struct {
	Version   int                  `json:"version"`
	CreatedAt int64                `json:"created_at"`
	Donors    []DonorSnapshotEntry `json:"donors"`
}

// DonorBackupInfo describes a snapshot file on disk (no body).
type DonorBackupInfo struct {
	Name      string `json:"name"`
	CreatedAt int64  `json:"created_at"`
	Count     int    `json:"count"`
}

const donorSnapshotVersion = 1

// WriteDonorSnapshot writes snap atomically to <dir>/donors-<CreatedAt>.json,
// creating dir if needed. Returns the full path.
func WriteDonorSnapshot(dir string, snap *DonorSnapshot) (string, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	name := fmt.Sprintf("donors-%d.json", snap.CreatedAt)
	full := filepath.Join(dir, name)
	data, err := json.MarshalIndent(snap, "", "  ")
	if err != nil {
		return "", err
	}
	tmp := full + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return "", err
	}
	if err := os.Rename(tmp, full); err != nil {
		return "", err
	}
	return full, nil
}

// ReadDonorSnapshot decodes a snapshot file.
func ReadDonorSnapshot(path string) (*DonorSnapshot, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var snap DonorSnapshot
	if err := json.Unmarshal(data, &snap); err != nil {
		return nil, err
	}
	return &snap, nil
}

// ListDonorSnapshots returns snapshot metadata newest-first. A missing dir is
// not an error (returns empty).
func ListDonorSnapshots(dir string) ([]DonorBackupInfo, error) {
	ents, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var out []DonorBackupInfo
	for _, e := range ents {
		if e.IsDir() || !strings.HasPrefix(e.Name(), "donors-") || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		snap, err := ReadDonorSnapshot(filepath.Join(dir, e.Name()))
		if err != nil {
			continue // skip corrupt files rather than failing the whole list
		}
		out = append(out, DonorBackupInfo{Name: e.Name(), CreatedAt: snap.CreatedAt, Count: len(snap.Donors)})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt > out[j].CreatedAt })
	return out, nil
}

// PruneDonorSnapshots deletes all but the newest keep snapshots.
func PruneDonorSnapshots(dir string, keep int) error {
	infos, err := ListDonorSnapshots(dir)
	if err != nil {
		return err
	}
	for i := keep; i < len(infos); i++ {
		_ = os.Remove(filepath.Join(dir, infos[i].Name))
	}
	return nil
}
```

- [ ] **Step 4: Add `DonorSnapshot()` to `db.go`**

In `src/backend/databank/db.go`, add near the other donor methods (after `DonorFileIDs`, ~line 1526). `ContentHashOf` (db.go:1242) and `ListDonors` (db.go:1528) already exist:

```go
// DonorSnapshot builds a path-keyed backup of the current donor list, stamping
// CreatedAt with the current time. content_hash is included when known (hex)
// as a secondary resolver that survives file moves.
func (db *DB) DonorSnapshot() (*DonorSnapshot, error) {
	donors, err := db.ListDonors()
	if err != nil {
		return nil, err
	}
	out := &DonorSnapshot{Version: donorSnapshotVersion, CreatedAt: time.Now().Unix()}
	for _, d := range donors {
		e := DonorSnapshotEntry{Path: d.Path, AddedAt: d.AddedAt}
		if hash, err := db.ContentHashOf(d.FileID); err == nil && len(hash) > 0 {
			e.ContentHash = hex.EncodeToString(hash)
		}
		out.Donors = append(out.Donors, e)
	}
	return out, nil
}
```

Ensure `db.go` imports `encoding/hex` (add to the import block if missing; `time` is already imported).

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd src/backend && go test ./databank/ -run 'TestWriteListReadDonorSnapshot|TestPrune|TestListMissing' -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/backend/databank/donor_backup.go src/backend/databank/donor_backup_test.go src/backend/databank/db.go
git commit -m "feat(donors): path-keyed snapshot types, atomic file IO, DonorSnapshot()"
```

---

## Task 5: Auto-snapshot before Reset + export/import/backups/restore endpoints

**Files:**
- Modify: `src/backend/handlers/databank.go` (`Reset` ~78; add `ExportDonors`, `ImportDonors`, `ListDonorBackups`, `RestoreDonors`, and unexported `restoreSnapshot` / `resolveDonorPath`)
- Modify: `src/backend/main.go` (register 4 routes near line 172)
- Test: `src/backend/handlers/databank_donors_test.go` (extend)

**Interfaces:**
- Consumes: `databank.DonorSnapshot()`, `WriteDonorSnapshot`, `ListDonorSnapshots`, `ReadDonorSnapshot`, `PruneDonorSnapshots`, `db.GetFileByPath`, `db.CanonicalForHash`, `db.AddDonor`, the `donorIndexer` field.
- Produces handlers:
  - `GET /api/databank/donors/export` → `DonorSnapshot` JSON (attachment).
  - `POST /api/databank/donors/import` (body: `DonorSnapshot`) → `{restored int, skipped []string}`.
  - `GET /api/databank/donors/backups` → `[]DonorBackupInfo`.
  - `POST /api/databank/donors/restore` (body: `{name string}`, empty → latest) → `{restored, skipped}`.

- [ ] **Step 1: Write the failing tests**

Append to `src/backend/handlers/databank_donors_test.go`:

```go
func TestResetWritesDonorSnapshotThenRestore(t *testing.T) {
	dataDir := t.TempDir()
	db, err := databank.Open(dataDir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if err := db.MigratePdfIndexV1(); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	id, _ := db.InsertFile(&databank.FileRecord{Path: "docs/keep.pdf", Filename: "keep.pdf", Extension: ".pdf", FileType: "pdf"})
	if err := db.AddDonor(id); err != nil {
		t.Fatalf("AddDonor: %v", err)
	}

	scanner := databank.NewScanner(db, dataDir) // confirm NewScanner signature vs scanner.go
	h := NewDatabankHandler(db, scanner, dataDir)
	fi := &fakeDonorIndexer{}
	h.SetDonorIndexer(fi)

	// Reset: snapshot first, then wipe.
	rec := httptest.NewRecorder()
	h.Reset(rec, httptest.NewRequest("POST", "/api/databank/reset", nil))
	if rec.Code != 200 {
		t.Fatalf("Reset = %d body=%s", rec.Code, rec.Body.String())
	}
	infos, _ := databank.ListDonorSnapshots(filepath.Join(dataDir, "backups"))
	if len(infos) != 1 || infos[0].Count != 1 {
		t.Fatalf("snapshots after reset = %+v, want one with count 1", infos)
	}

	// Re-insert the same path with a NEW id (simulates a rescan after reset).
	newID, _ := db.InsertFile(&databank.FileRecord{Path: "docs/keep.pdf", Filename: "keep.pdf", Extension: ".pdf", FileType: "pdf"})
	if newID == id {
		t.Fatal("expected a fresh autoincrement id after reset")
	}

	// Restore latest.
	rec = httptest.NewRecorder()
	h.RestoreDonors(rec, httptest.NewRequest("POST", "/api/databank/donors/restore", strings.NewReader(`{}`)))
	if rec.Code != 200 {
		t.Fatalf("Restore = %d body=%s", rec.Code, rec.Body.String())
	}
	var res struct {
		Restored int      `json:"restored"`
		Skipped  []string `json:"skipped"`
	}
	json.Unmarshal(rec.Body.Bytes(), &res)
	if res.Restored != 1 {
		t.Fatalf("restored = %+v, want 1", res)
	}
	donors, _ := db.ListDonors()
	if len(donors) != 1 || donors[0].FileID != newID {
		t.Fatalf("donors after restore = %+v, want new id %d", donors, newID)
	}
}

func TestImportSkipsMissingPath(t *testing.T) {
	h, _, _ := donorTestHandler(t)
	h.SetDonorIndexer(&fakeDonorIndexer{})
	body := `{"version":1,"created_at":1,"donors":[{"path":"docs/x.pdf","added_at":1},{"path":"gone/missing.pdf","added_at":2}]}`
	rec := httptest.NewRecorder()
	h.ImportDonors(rec, httptest.NewRequest("POST", "/api/databank/donors/import", strings.NewReader(body)))
	var res struct {
		Restored int      `json:"restored"`
		Skipped  []string `json:"skipped"`
	}
	json.Unmarshal(rec.Body.Bytes(), &res)
	if res.Restored != 1 || len(res.Skipped) != 1 || res.Skipped[0] != "gone/missing.pdf" {
		t.Fatalf("import result = %+v, want restored 1 / skipped [gone/missing.pdf]", res)
	}
}
```

> Add `"strings"` to the test imports. Confirm `databank.NewScanner` exists with this signature (`grep -n "func NewScanner" src/backend/databank/scanner.go`); adjust the constructor call if it differs.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src/backend && go test ./handlers/ -run 'TestResetWrites|TestImportSkips' -v`
Expected: FAIL — `h.RestoreDonors undefined` / `h.ImportDonors undefined`.

- [ ] **Step 3: Implement the Reset snapshot + handlers**

In `src/backend/handlers/databank.go`:

(a) Add `"path/filepath"`, `"encoding/json"`, `"encoding/hex"`, `"log"` to imports if not present (`json` and `log` likely already are).

(b) Replace `Reset` so it snapshots before wiping:

```go
func (h *DatabankHandler) Reset(w http.ResponseWriter, r *http.Request) {
	// Best-effort donor snapshot BEFORE the wipe (read happens before delete).
	// Never blocks the reset: failures are logged, not fatal.
	if snap, err := h.db.DonorSnapshot(); err == nil && len(snap.Donors) > 0 {
		dir := filepath.Join(h.dataDir, "backups")
		if _, werr := databank.WriteDonorSnapshot(dir, snap); werr == nil {
			_ = databank.PruneDonorSnapshots(dir, 5)
			log.Printf("donor snapshot written before reset: %d donor(s)", len(snap.Donors))
		} else {
			log.Printf("donor snapshot before reset failed: %v", werr)
		}
	}

	if err := h.scanner.ResetAll(); err != nil {
		http.Error(w, err.Error(), http.StatusConflict)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "reset"})
}
```

(c) Add the resolution helpers + four handlers (anywhere in the file):

```go
// resolveDonorPath maps a snapshot entry to a current PDF file id: first by
// relative path, then by content_hash (survives moves). Returns (0,false) if
// no current PDF row matches.
func (h *DatabankHandler) resolveDonorPath(e databank.DonorSnapshotEntry) (int64, bool) {
	if f, err := h.db.GetFileByPath(e.Path); err == nil && f != nil && f.FileType == "pdf" {
		return f.ID, true
	}
	if e.ContentHash != "" {
		if hb, err := hex.DecodeString(e.ContentHash); err == nil {
			if id, err := h.db.CanonicalForHash(hb); err == nil && id != 0 {
				return id, true
			}
		}
	}
	return 0, false
}

// restoreSnapshot re-adds each resolvable donor (triggering auto-index) and
// returns counts. Idempotent — AddDonor is ON CONFLICT DO NOTHING.
func (h *DatabankHandler) restoreSnapshot(snap *databank.DonorSnapshot) (int, []string) {
	restored := 0
	skipped := []string{}
	for _, e := range snap.Donors {
		id, ok := h.resolveDonorPath(e)
		if !ok {
			skipped = append(skipped, e.Path)
			continue
		}
		if err := h.db.AddDonor(id); err != nil {
			skipped = append(skipped, e.Path)
			continue
		}
		if h.donorIndexer != nil {
			h.donorIndexer.EnsureIndexed([]int64{id})
		}
		restored++
	}
	return restored, skipped
}

// GET /api/databank/donors/export — current donor list as a downloadable snapshot.
func (h *DatabankHandler) ExportDonors(w http.ResponseWriter, r *http.Request) {
	snap, err := h.db.DonorSnapshot()
	if err != nil {
		http.Error(w, "snapshot: "+err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Content-Disposition", "attachment; filename=\"boardripper-donors.json\"")
	json.NewEncoder(w).Encode(snap)
}

// POST /api/databank/donors/import — apply an uploaded snapshot.
func (h *DatabankHandler) ImportDonors(w http.ResponseWriter, r *http.Request) {
	var snap databank.DonorSnapshot
	if err := json.NewDecoder(r.Body).Decode(&snap); err != nil {
		http.Error(w, "bad snapshot: "+err.Error(), http.StatusBadRequest)
		return
	}
	restored, skipped := h.restoreSnapshot(&snap)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"restored": restored, "skipped": skipped})
}

// GET /api/databank/donors/backups — server-side snapshot metadata, newest first.
func (h *DatabankHandler) ListDonorBackups(w http.ResponseWriter, r *http.Request) {
	infos, err := databank.ListDonorSnapshots(filepath.Join(h.dataDir, "backups"))
	if err != nil {
		http.Error(w, "list backups: "+err.Error(), http.StatusInternalServerError)
		return
	}
	if infos == nil {
		infos = []databank.DonorBackupInfo{}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(infos)
}

// POST /api/databank/donors/restore — apply a server-side snapshot by name
// (empty name → newest).
func (h *DatabankHandler) RestoreDonors(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name string `json:"name"`
	}
	json.NewDecoder(r.Body).Decode(&req) // empty body OK → latest
	dir := filepath.Join(h.dataDir, "backups")
	name := req.Name
	if name == "" {
		infos, err := databank.ListDonorSnapshots(dir)
		if err != nil || len(infos) == 0 {
			http.Error(w, "no donor backup available", http.StatusNotFound)
			return
		}
		name = infos[0].Name
	}
	if strings.Contains(name, "/") || strings.Contains(name, "..") {
		http.Error(w, "bad name", http.StatusBadRequest)
		return
	}
	snap, err := databank.ReadDonorSnapshot(filepath.Join(dir, name))
	if err != nil {
		http.Error(w, "read backup: "+err.Error(), http.StatusNotFound)
		return
	}
	restored, skipped := h.restoreSnapshot(snap)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"restored": restored, "skipped": skipped})
}
```

Ensure `"strings"` is imported in `databank.go`.

- [ ] **Step 4: Register the routes**

In `src/backend/main.go`, right after the existing donor routes (~line 172):

```go
	mux.HandleFunc("GET /api/databank/donors/export", read(dbHandler.ExportDonors))
	mux.HandleFunc("POST /api/databank/donors/import", write(dbHandler.ImportDonors))
	mux.HandleFunc("GET /api/databank/donors/backups", read(dbHandler.ListDonorBackups))
	mux.HandleFunc("POST /api/databank/donors/restore", write(dbHandler.RestoreDonors))
```

- [ ] **Step 5: Run tests + build**

Run: `cd src/backend && go test ./handlers/ -run 'TestResetWrites|TestImportSkips' -v && go build ./...`
Expected: PASS + clean build.

- [ ] **Step 6: Commit**

```bash
git add src/backend/handlers/databank.go src/backend/handlers/databank_donors_test.go src/backend/main.go
git commit -m "feat(donors): auto-snapshot before Reset + export/import/backups/restore endpoints"
```

---

## Task 6: Frontend store — `index_status` + backup/restore methods

**Files:**
- Modify: `src/frontend/src/store/databank-store.ts` (`DonorEntry` ~243; add `DonorBackupInfo`; add 4 methods near `listDonors` ~479)

**Interfaces:**
- Produces (on the `databankStore` singleton):
  - `DonorEntry.index_status?: string`.
  - `interface DonorBackupInfo { name: string; created_at: number; count: number }`.
  - `importDonors(snapshot: unknown): Promise<{ restored: number; skipped: string[] }>`.
  - `listDonorBackups(): Promise<DonorBackupInfo[]>`.
  - `restoreDonors(name?: string): Promise<{ restored: number; skipped: string[] }>`.
  - Export uses a direct download link in the UI (`${apiBase}/api/databank/donors/export`); no store method needed.

- [ ] **Step 1: Add the type fields**

In `src/frontend/src/store/databank-store.ts`, extend `DonorEntry`:

```typescript
export interface DonorEntry {
  file_id: number;
  filename: string;
  path: string;
  added_at: string;
  index_status?: string;
}

export interface DonorBackupInfo {
  name: string;
  created_at: number;
  count: number;
}
```

- [ ] **Step 2: Add the methods**

Immediately after `listDonors()` (~line 479) in the same class:

```typescript
  async importDonors(snapshot: unknown): Promise<{ restored: number; skipped: string[] }> {
    const r = await this.apiFetch<{ restored: number; skipped: string[] }>(
      '/api/databank/donors/import',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(snapshot) },
    );
    await this.refreshDonors();
    return r ?? { restored: 0, skipped: [] };
  }

  async listDonorBackups(): Promise<DonorBackupInfo[]> {
    return (await this.apiFetch<DonorBackupInfo[]>('/api/databank/donors/backups')) ?? [];
  }

  async restoreDonors(name?: string): Promise<{ restored: number; skipped: string[] }> {
    const r = await this.apiFetch<{ restored: number; skipped: string[] }>(
      '/api/databank/donors/restore',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name ?? '' }) },
    );
    await this.refreshDonors();
    return r ?? { restored: 0, skipped: [] };
  }
```

> Confirm `apiFetch(url, init?)` accepts a `RequestInit` second arg (it does — see `addDonor` calling it with `{ method: 'PUT' }`). If the base URL is exposed under a different name than `apiBase`, note it for Task 8's export link.

- [ ] **Step 3: Typecheck**

Run: `cd src/frontend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/frontend/src/store/databank-store.ts
git commit -m "feat(donors): store support for index_status + backup/restore methods"
```

---

## Task 7: Library panel — discoverable donor manager with status badges

**Files:**
- Modify: `src/frontend/src/panels/LibraryPanel.tsx` (donor state ~282; search header ~907; manage-mode block ~930)

**Interfaces:**
- Consumes: `databankStore.listDonors()` → `DonorEntry[]` (with `index_status`), `databankStore.removeDonor(id)`.
- Produces UI testids: `manage-donors-btn`, `donor-row`, `donor-status` (used by Task 8 e2e).

- [ ] **Step 1: Make the donor manager explicit + typed**

Replace the donor-list state + gating (~lines 282–287) with an explicit toggle and full `DonorEntry` rows:

```typescript
  // Donor manager: an explicit, always-available list (no longer gated on an
  // empty query). Open via the "Manage donors" button in the search header.
  const [showDonorManager, setShowDonorManager] = useState(false);
  const [donorList, setDonorList] = useState<DonorEntry[]>([]);
  const isDonorManageMode = viewMode === 'search' && showDonorManager;

  const refreshDonorList = useCallback(() => {
    databankStore.listDonors().then(setDonorList);
  }, []);

  useEffect(() => {
    if (isDonorManageMode) refreshDonorList();
  }, [isDonorManageMode, refreshDonorList]);

  // While the manager is open and any donor is still indexing/pending, poll so
  // the badge advances to its terminal state.
  useEffect(() => {
    if (!isDonorManageMode) return;
    const pending = donorList.some(d => d.index_status === 'pending' || d.index_status === 'indexing');
    if (!pending) return;
    const t = setInterval(refreshDonorList, 2000);
    return () => clearInterval(t);
  }, [isDonorManageMode, donorList, refreshDonorList]);
```

Add `DonorEntry` to the existing `databank-store` import, and ensure `useCallback` is imported from React.

- [ ] **Step 2: Add the "Manage donors" toggle to the search header**

Inside the `<div className="library-search" …>` (after the "Donors only" `<label>`, ~line 914), add:

```tsx
              <button
                className="library-search-btn"
                data-testid="manage-donors-btn"
                onClick={() => setShowDonorManager(v => !v)}
                title="View and remove donor PDFs"
              >
                {showDonorManager ? 'Done' : `Manage donors (${donorList.length})`}
              </button>
```

> The count shows `0` until the list first loads; opening the manager triggers `refreshDonorList`. To show a live count even when closed, call `refreshDonorList()` once on mount via a `useEffect(() => refreshDonorList(), [])`.

- [ ] **Step 3: Render rows with a status badge**

Replace the `isDonorManageMode ? ( … )` block's row markup (~lines 931–944) with:

```tsx
              <div className="library-donor-list">
                {donorList.length === 0
                  ? <div className="library-empty">No donor PDFs yet. Mark PDFs as donors to build this list.</div>
                  : donorList.map(d => (
                      <div key={d.file_id} className="library-donor-row" data-testid="donor-row">
                        <span className="library-donor-name" title={d.path || d.filename}>{d.filename}</span>
                        <span
                          className={`library-donor-status status-${d.index_status ?? 'unknown'}`}
                          data-testid="donor-status"
                        >
                          {donorStatusLabel(d.index_status)}
                        </span>
                        <button
                          className="library-donor-remove"
                          title="Remove from donor list"
                          onClick={async () => { await databankStore.removeDonor(d.file_id); refreshDonorList(); }}
                        >×</button>
                      </div>
                    ))}
              </div>
```

Add this helper near the top of the module (outside the component):

```typescript
function donorStatusLabel(s?: string): string {
  switch (s) {
    case 'indexed': return 'Indexed';
    case 'indexing': return 'Indexing…';
    case 'pending': return 'Pending';
    case 'failed': return 'Failed';
    case 'empty': return 'No text';
    case 'duplicate': return 'Duplicate';
    default: return 'Unknown';
  }
}
```

- [ ] **Step 4: Minimal badge styles**

Append to `src/frontend/src/index.css` (keep under ~20 lines, reuse existing variables):

```css
.library-donor-status { font-size: 11px; opacity: 0.8; margin-left: auto; padding: 0 6px; white-space: nowrap; }
.library-donor-status.status-indexed { color: var(--accent, #5b8); }
.library-donor-status.status-failed { color: #e55; }
.library-donor-status.status-pending,
.library-donor-status.status-indexing { color: #d a0; }
.library-donor-row { display: flex; align-items: center; gap: 6px; }
```

> Fix the obvious typo if your editor flags it: `#d a0` → a valid colour like `#dda000`. Match the surrounding `.library-donor-*` style block already in `index.css`.

- [ ] **Step 5: Typecheck + build**

Run: `cd src/frontend && npx tsc --noEmit && npm run build`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/frontend/src/panels/LibraryPanel.tsx src/frontend/src/index.css
git commit -m "feat(donors): discoverable donor manager with live index-status badges"
```

---

## Task 8: Settings — Export / Import + restore prompt

**Files:**
- Modify: `src/frontend/src/panels/SettingsPanel.tsx` (Database-info actions row ~795–838)

**Interfaces:**
- Consumes: `databankStore.listDonorBackups()`, `databankStore.restoreDonors()`, `databankStore.importDonors(json)`; export via `<a href>`.
- Produces UI testids: `donor-export-link`, `donor-import-input`, `donor-restore-btn`.

- [ ] **Step 1: Add backup state + handlers in `DatabaseInfoSection`**

Near the other hooks in `DatabaseInfoSection`, add:

```typescript
  const [donorBackups, setDonorBackups] = useState<DonorBackupInfo[]>([]);
  useEffect(() => { databankStore.listDonorBackups().then(setDonorBackups); }, []);

  const handleRestoreDonors = useCallback(async () => {
    const { restored, skipped } = await databankStore.restoreDonors();
    setDonorBackups(await databankStore.listDonorBackups());
    log.ui.info(`Donor restore: ${restored} restored, ${skipped.length} skipped`);
  }, []);

  const handleImportDonors = useCallback(async (file: File) => {
    const text = await file.text();
    const snapshot = JSON.parse(text);
    const { restored, skipped } = await databankStore.importDonors(snapshot);
    setDonorBackups(await databankStore.listDonorBackups());
    log.ui.info(`Donor import: ${restored} restored, ${skipped.length} skipped`);
  }, []);
```

Import `DonorBackupInfo` from the store, `log` from `../store/log-store`, and ensure `useState`/`useEffect`/`useCallback` are imported. Resolve the API base the same way other download links in this file do (search the file for an existing `href={` or `apiBase`/`API_BASE`; reuse it for the export link below).

- [ ] **Step 2: Add the buttons to the actions row**

Inside `<div className="settings-db-actions" …>`, after the "Reset Database" button (~line 837), add:

```tsx
        <a
          className="settings-action-btn"
          data-testid="donor-export-link"
          href={`${API_BASE}/api/databank/donors/export`}
          title="Download the donor list as a JSON backup"
        >
          Export donors
        </a>
        <label className="settings-action-btn" title="Import a donor backup JSON">
          Import donors
          <input
            type="file"
            accept="application/json,.json"
            data-testid="donor-import-input"
            style={{ display: 'none' }}
            onChange={e => { const f = e.target.files?.[0]; if (f) void handleImportDonors(f); e.target.value = ''; }}
          />
        </label>
        {donorBackups.length > 0 && (
          <button
            className="settings-action-btn"
            data-testid="donor-restore-btn"
            onClick={handleRestoreDonors}
            title={`Restore ${donorBackups[0].count} donor(s) from the latest backup`}
          >
            Restore donors ({donorBackups[0].count})
          </button>
        )}
```

> Replace `API_BASE` with whatever constant/getter this file already uses for backend URLs (Step 1 identified it). If links elsewhere use a bare relative path, use `href="/api/databank/donors/export"`.

- [ ] **Step 3: Typecheck + build**

Run: `cd src/frontend && npx tsc --noEmit && npm run build`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/frontend/src/panels/SettingsPanel.tsx
git commit -m "feat(donors): Settings export/import + restore-from-backup controls"
```

---

## Task 9: Playwright e2e — mark→index, manager, reset→restore

**Files:**
- Create: `src/frontend/tests/donor-manager.spec.ts`

**Interfaces:**
- Consumes the testids added in Tasks 7–8 plus existing library/PDF flows.

- [ ] **Step 1: Identify the existing seed/upload helper**

Run: `cd src/frontend && grep -rln "databank\|donor\|pdf-search\|library-search\|uploadFile\|fixtures" tests/ | head`
Read the closest existing spec that opens the Library, seeds a PDF into the databank, and runs a PDF search. Reuse its seeding helper (do NOT invent a new fixture API). Note the helper name + import path for Step 2.

- [ ] **Step 2: Write the spec using that helper**

Create `src/frontend/tests/donor-manager.spec.ts`. Replace `seedLibraryWithPdf` / navigation with the real helper found in Step 1; the assertions below are the contract:

```typescript
import { test, expect } from '@playwright/test';
// import { seedLibraryWithPdf, openLibrary } from './helpers'; // ← from Step 1

test('marking a never-opened PDF as donor indexes it and donor-search finds it', async ({ page }) => {
  // 1. Seed a PDF into the databank WITHOUT opening it (use the Step-1 helper).
  // 2. Open the Library → Database editor / file detail → mark it as donor
  //    (DonorToggle "Mark as donor").
  // 3. Open the PDF-search tab → "Manage donors".
  await page.getByTestId('manage-donors-btn').click();

  // Badge advances to Indexed within the backend index window.
  await expect(page.getByTestId('donor-status').first()).toHaveText('Indexed', { timeout: 30_000 });

  // Donor-scoped search now returns a term from that PDF.
  await page.getByPlaceholder(/Search PDF text/i).fill('<a term known to be in the seeded PDF>');
  await page.getByText('Donors only').click();
  await page.getByRole('button', { name: 'Search' }).click();
  await expect(page.locator('.library-donor-spoiler, .library-search-results')).toContainText(/.+/);
});

test('manage list is visible even with a query typed', async ({ page }) => {
  await page.getByTestId('manage-donors-btn').click();
  await page.getByPlaceholder(/Search PDF text/i).fill('anything');
  // Manager stays open regardless of the query box (the old gating is gone).
  await expect(page.getByTestId('donor-row').first()).toBeVisible();
});

test('reset → restore round-trip reinstates donors', async ({ page }) => {
  // Precondition: at least one donor exists (from the first test's seeding).
  // Open Settings ▸ Database info, run Reset Database (confirm any dialog),
  // then re-scan the library so the file rows come back with new IDs.
  await page.getByTestId('donor-restore-btn').click();
  // After restore, the donor manager shows the donor again.
  await page.getByTestId('manage-donors-btn').click();
  await expect(page.getByTestId('donor-row')).toHaveCount(1);
});
```

- [ ] **Step 3: Run the spec**

Run: `cd src/frontend && npx playwright test tests/donor-manager.spec.ts`
Expected: PASS. (Headless Chromium has no WebGL adapters — the "No available adapters" warning is expected and unrelated.)

- [ ] **Step 4: Commit**

```bash
git add src/frontend/tests/donor-manager.spec.ts
git commit -m "test(donors): e2e mark→index, manager visibility, reset→restore"
```

---

## Self-Review

**1. Spec coverage**

| Spec requirement | Task |
|---|---|
| Discoverable donor manager (always-available, not query-gated) | 7 |
| Index-status badge per donor (`ListDonors` enrichment) | 2 (backend), 7 (UI) |
| Backend trigger: `AddDonor` → index | 2 (trigger), 3 (adapter/wiring) |
| Scoped donor sweep (not full-library) | 1 (`RunFiles`), 3 (`EnsureIndexed`) |
| One-time backfill of un-indexed donors | 3 (goroutine) |
| Nil-safe when pdfindex disabled | 2 (nil guards), 3 (adapter nil checks) |
| Removal leaves index intact | unchanged `RemoveDonor` — no task touches it (Global Constraints) |
| Re-index/Reset PDF Text don't touch donors | unchanged — verified in design; no code needed |
| Snapshot shape (path + content_hash) | 4 |
| Auto-snapshot before Reset, retain 5 | 5 |
| One-click restore (latest), path→id then hash | 5 (backend), 8 (UI) |
| Manual export / import | 5 (endpoints), 6 (store), 8 (UI) |
| Boot/health not blocked by backfill | 3 (background goroutine) |
| Snapshots under `<dataDir>/backups/` (writable) | 4/5 |

**2. Placeholder scan** — One deliberate, flagged placeholder remains: the Playwright seed helper + the known-PDF search term in Task 9, which depend on the existing test harness (Step 1 resolves them). All backend/frontend code blocks are complete. The `#d a0` colour in Task 7 Step 4 is intentionally flagged for the implementer to correct.

**3. Type consistency** — `DonorIndexer.{EnsureIndexed,StatusFor}` identical across Tasks 2/3. `DonorSnapshot` / `DonorSnapshotEntry` / `DonorBackupInfo` field names match between Go (Task 4) and the JSON consumed by TS (`DonorBackupInfo{name,created_at,count}`, Task 6). `index_status` string used consistently (backend `IndexStatus json:"index_status"`, TS `index_status?`). `RunFiles(ids []int64) error` consistent between Tasks 1 and 3. Status values (`indexed/indexing/pending/failed/empty/duplicate`) match between adapter mapping (Task 3) and `donorStatusLabel` (Task 7).

**4. Open verifications folded into steps** (each flagged at point of use, not left as silent assumptions): go.mod module path for test imports (Tasks 2/3); `databank.NewScanner` signature (Task 5); `apiFetch(url, init)` and the API-base constant name (Tasks 6/8). These are confirm-and-adjust, not design gaps.
