# PDF Donor Manager + Auto-Index on Mark — Design

- **Date:** 2026-06-24
- **Status:** Approved (design); implementation plan to follow
- **Scope:** PDF donors only (the `pdf_donors` membership list). No board-file donors, no per-board bound view.

## Problem

Three gaps in the current PDF "donor" system (the donor pool used by *Search ▸ Donors only*):

1. **Discoverability of the donor list.** A user can mark a PDF as a donor, but the only way to *see and remove* donors in bulk is a hidden mode in the Library PDF-search tab that appears only when `scope=donor` **and** the search box is empty. It is effectively undiscoverable.

2. **"Ensure the donor list is server-side."** Verified during design: the donor list is **already authoritative on the server** — there is no client-side persistence to fix. The frontend holds only an in-memory `Set<number>` synced from the server. This goal is therefore **already satisfied**; this spec records the verification rather than introducing a change.

3. **Marking a donor does not index it.** PDF indexing is triggered only when a PDF is *opened* (the `ensureIndexed` fast-path) or via a manual bulk/priority run. A PDF that is marked as a donor but never opened is never indexed, so *Search ▸ Donors only* silently misses it. Donor membership should **guarantee** the file ends up indexed.

The substantive work is (1) surfacing a manager and (3) making donor membership imply indexing.

## Current state (verified)

Server-side, authoritative:

- **Table** `pdf_donors(file_id PK → files.id ON DELETE CASCADE, added_at)` in `databank.db` — created by `MigratePdfIndexV1` (`src/backend/databank/db.go:1345`). Distinct from the user-editable `files.donor_pool` column.
- **Endpoints** (`src/backend/main.go:170-172`):
  - `GET /api/databank/donors` → `[]DonorEntry{file_id, filename, path, added_at}` (`databank.go:617`, `db.go:1528`).
  - `PUT /api/databank/donors/{id}` → add; validates the file exists and is `type='pdf'` (`databank.go:632`, `db.go:1490`).
  - `DELETE /api/databank/donors/{id}` → remove (`databank.go:660`, `db.go:1501`).
- **`DonorFileIDs()`** helper already exists (`db.go:1509`).

Frontend (`src/frontend/`):

- `databank-store.ts` keeps `_donorIds: Set<number>` (no `localStorage`), `addDonor` / `removeDonor` / `listDonors` / `refreshDonors`, refreshed at startup and after mutations.
- `LibraryPanel.tsx`: per-file `DonorToggle` button; the hidden manage-mode (`scope=donor` + empty query); "Donors only" scope checkbox feeding the FTS search.

Indexing internals (`src/backend/pdfindex/`):

- `Indexer.Run()` (`indexer.go:117`) sweeps **all** pending PDFs via `startScoped(src.ListPDFs)`. `RunFolder(prefix)` (`indexer.go:128`) sweeps a path-prefix subset. Both delegate to `startScoped` (`indexer.go:139`), which enumerates candidates, filters out `DoneOrActiveFileIDs`, and runs one background sweep (single-sweep model guarded by `ix.running`).
- `Enqueue(id)` (`indexer.go:86`) pushes to a 256-slot priority lane. **It is a no-op unless a sweep is running** — the lane is only drained inside `sweep()` (`indexer.go:194,205`), and only for files present in that sweep's `byID` set.
- `PriorityIndex` handler (`handlers/pdfindex.go:120`) is the existing "index this one file" path: `ix.Run(); ix.Enqueue(id)` — i.e. it kicks a **full-library** sweep and bumps the one file to the front.
- Index status lives in `pdfindex.db` (`pdf_index_status.status`: `pending` / `indexing` / `indexed` / `empty` / `failed` / `duplicate`), a **separate** SQLite handle from `databank.db`.
- The indexer is constructed only inside `if pdfIndex != nil` (`main.go:261`), **after** the donor routes are registered (`main.go:170`), and only when the pdfium engine initialises. Precedent for late wiring into an earlier handler: `scanner.SetPdfModifiedHook(...)` (`main.go:271`).

## Goals

- A discoverable donor manager in the Library PDF-search tab: list every donor with filename, path, **index-status badge**, and a remove button — available regardless of the search box state.
- Marking a file as a donor **triggers indexing** of exactly that file (server-side, so any caller benefits).
- A **one-time backfill** indexes existing donors that are not yet indexed.
- Graceful degradation when pdfindex is unavailable.

## Non-goals

- Board-file donors; per-board bound-donor view.
- De-indexing on donor removal (removal leaves the index intact — the file simply exits donor *search scope*).
- Changing the bulk-index policy (`pdf_index_auto_run`) or the open-PDF `ensureIndexed` fast-path.
- A "remove all donors" bulk action (deferred; YAGNI unless requested).

## Design

### Trigger lives on the backend (not the client)

`AddDonor` itself drives indexing. This satisfies the requirement literally ("if marked as a donor, it should be indexed") for **every** caller — the UI, a future MCP tool, a script — not just the one client that happened to do the marking. The rejected alternative (frontend calls `priorityIndex` after `addDonor`) only fires for that one UI client and not for non-UI callers.

### Scoped donor sweep (not a full-library sweep)

The existing `PriorityIndex` kicks `ix.Run()`, sweeping the *entire* library. For donors that is wrong when `pdf_index_auto_run` is off: the user has opted out of indexing everything, yet wants their donors searchable. A new primitive indexes **exactly the donor set**:

- **`Indexer.RunFiles(ids []int64) error`** (`pdfindex/indexer.go`): `startScoped` over a list function that returns `src.ListPDFs()` filtered to `ids`. Inherits all `startScoped` behaviour — filters out already done/active, single background sweep, returns `ErrAlreadyRunning` if a sweep is in progress. Idempotent.

### Decoupling interface (nil-safe injection)

`DatabankHandler` (created at `main.go:148`) must reach the indexer (created at `main.go:261`). Mirror the `SetPdfModifiedHook` pattern with a small interface set after the indexer exists:

```go
// handlers package
type DonorIndexer interface {
    EnsureIndexed(ids []int64)               // RunFiles(ids) + Enqueue each id
    StatusFor(ids []int64) map[int64]string  // file_id → pdf_index_status.status
}

func (h *DatabankHandler) SetDonorIndexer(di DonorIndexer) { h.donorIndexer = di }
```

The adapter is a closure in `main.go` inside `if pdfIndex != nil`, closing over `indexer` and `pdfIndex`:

- `EnsureIndexed(ids)` → `indexer.RunFiles(ids)` (ignore `ErrAlreadyRunning`) then `indexer.Enqueue(id)` for each, so an in-flight sweep also picks them up.
- `StatusFor(ids)` → look up each id in `pdfIndex` status; missing rows map to `pending` (never indexed) vs. `unknown` only when the lookup itself can't run.

When pdfindex is unavailable, `donorIndexer` stays `nil`: donor add/remove still work; status badges render `unknown`; no trigger. No crash.

### Handler changes (`src/backend/handlers/databank.go`)

- **`AddDonor`** — after `db.AddDonor(id)` succeeds and `h.donorIndexer != nil`, call `h.donorIndexer.EnsureIndexed([]int64{id})`. Fire-and-forget (the sweep is already async); the HTTP response stays `{"status":"ok"}`.
- **`RemoveDonor`** — unchanged.
- **`ListDonors`** — enrich each `DonorEntry` with `index_status` (`indexed` / `pending` / `indexing` / `failed` / `empty` / `duplicate` / `unknown`) via one `donorIndexer.StatusFor(ids)` batch call. The merge happens in the handler because `databank.db` and `pdfindex.db` are separate handles (no SQL JOIN). `DonorEntry` gains `IndexStatus string \`json:"index_status,omitempty"\``.

### One-time backfill (`src/backend/main.go`)

Inside `if pdfIndex != nil`, after the indexer is built, a **background goroutine**: `donorIndexer.EnsureIndexed(db.DonorFileIDs())`. Runs **independent of `pdf_index_auto_run`** (the donor guarantee is the whole point) and **non-blocking** so it never threatens the <60s health-check boot invariant. Idempotent — already-indexed donors are filtered by `startScoped`. If a bulk auto-run sweep is already active, `RunFiles` returns `ErrAlreadyRunning` and the per-id `Enqueue` bumps donors within that sweep.

### Frontend changes (`src/frontend/`)

- **Discoverable manager** (`LibraryPanel.tsx`): a persistent **"Manage donors (N)"** control beside the "Donors only" checkbox, opening the donor list regardless of the query box. Each row: filename · path · **index-status badge** · Remove (existing `removeDonor`). While any donor is non-terminal (`pending` / `indexing`), light auto-poll of `GET /api/databank/donors` so the badge advances Pending → Indexing… → Indexed.
- **Type** (`databank-store.ts`): `DonorEntry` gains `index_status?: string`. No other client logic changes — `addDonor` stays as-is; the backend now owns the trigger, and the currently-open PDF remains covered by the existing `ensureIndexed` fast-path.

### Data flow

```
Mark donor (UI / MCP / script)
  → PUT /api/databank/donors/{id}
       → db.AddDonor(id)                    [databank.db: pdf_donors]
       → donorIndexer.EnsureIndexed([id])   [pdfindex: RunFiles([id]) + Enqueue]
            → claim → pdfium extract → FTS5 pages → status=indexed
Boot → background goroutine → EnsureIndexed(DonorFileIDs())   [non-blocking, any auto_run]
View → GET /api/databank/donors → rows + index_status badge (auto-poll while non-terminal)
Remove → DELETE /api/databank/donors/{id}                     [index left intact]
```

## Edge cases

- **Removal leaves the index** — the file exits donor *search scope* only; still findable in "all" scope and via any binding.
- **pdfindex disabled / engine fail** — `donorIndexer == nil`; add/remove work; badge = `unknown`; no trigger.
- **Sweep already running** when marking — `RunFiles` → `ErrAlreadyRunning` (ignored); `Enqueue` bumps the file into the active sweep's priority lane (processed if in scope; otherwise covered by the next mark/backfill).
- **Duplicate PDFs** — unchanged: a non-canonical duplicate is marked `duplicate` and skipped; its hits resolve via the canonical. Badge shows `duplicate`.
- **Backfill vs. boot** — background goroutine; never blocks `/api/health`.

## Testing

Go (`src/backend/`):
- `RunFiles` indexes only the listed IDs (a non-listed pending PDF stays `pending`).
- `AddDonor` invokes `EnsureIndexed` for the new id; `RemoveDonor` does not touch the index.
- `ListDonors` merges `index_status` correctly, including `unknown` when `donorIndexer == nil`.
- Backfill enqueues only un-indexed donors; idempotent on re-run.
- Nil-`donorIndexer` safety across add / remove / list.

Playwright (`src/frontend/tests/`):
- Mark a never-opened PDF as a donor → its badge transitions to `Indexed` → *Donors only* search now returns it.
- Manage list is visible with a query typed in the box.
- Remove deletes the row and drops it from donor-scoped results.

## Rollout

- Backend-only behavioural change is additive; no schema migration (reuses `pdf_donors`, `pdf_index_status`). `DonorEntry` gains one optional JSON field.
- Version bump per project convention at release time (out of scope for this design).
