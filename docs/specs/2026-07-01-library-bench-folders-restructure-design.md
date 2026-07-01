# Library / Bench / Folders restructure — design

**Date:** 2026-07-01
**Status:** Approved (brainstorm), pending spec review
**Area:** Frontend `LibraryPanel` + `databank-store` + `worklist-store`; Backend `databank/scanner.go` + handler

## Overview

Three related changes to the Library sidebar panel:

1. **Search above stats** — move the filter input above the stats block and make it
   more visible.
2. **"Bench" tab** — rename the current "Donor boards" tab to **Bench** and give it an
   extensible variant switcher: **Donor boards** (inline, unchanged), **Worklists**
   (new placeholder — a catalog of all locally-stored worklists), **Device DB**
   (launcher for the existing Database Editor panel). Built data-driven so more
   variants can be appended later.
3. **Folders = DB only, per-branch rescan** — remove the DB/Live pill and the live
   filesystem browser; the Folders tab always shows the indexed DB tree. Add a
   per-branch **update** button (next to the existing "idx" button) that runs a
   filesystem rescan scoped to that folder subtree.

Everything is additive/localized; no data migrations.

## Goals

- Filter input sits above the stats block and is easier to spot.
- The Bench tab consolidates repair-bench tools behind one extensible switcher.
- Folder browsing has a single, non-confusing source (the DB tree) plus a way to
  refresh any branch from disk on demand.

## Non-goals

- No new worklist features. "Worklists" is a **read-only placeholder** listing what
  is already stored locally; the interactive worklist stays in its own Dockview panel.
- No shared/remote worklist database yet (future; see Future work).
- No change to PDF text indexing. The existing "idx" button keeps its meaning
  (re-index PDF text via `/api/pdfindex/index-folder`); the new button is separate.

---

## Part 1 — Library: search above stats, more visible

### Current state
`LibraryPanel.tsx` render order (`return` at ~L809):
tabs row → `{statsBar}` (~L888) → search filter (~L891-914, hidden on PDF/Bench tabs).
The stats bar was deliberately pinned under the tabs so its position is identical on
every tab. `.library-search-input` only turns accent-colored on focus
(`index.css` ~L5261-5274; `border-color: var(--accent)` on focus).

### Change
- Swap the render order to **tabs → search filter → `{statsBar}`**.
- Add a leading `IconSearch` glyph inside the field.
- Give `.library-search-input` an accent-tinted resting border (a subtle accent mix,
  not a fill) plus a clear focus ring on focus. No color fills, no decorative styling —
  purely to make the field findable (respects the project's "no decorative UI" rule).

### Consequence (accepted)
On tabs that show the filter, the stats line now sits one row lower than the tab row.
This is the direct result of the requested order and is consistent within those tabs.
On PDF/Bench (no filter) the stats bar remains directly under the tabs.

### Files
- `src/frontend/src/panels/LibraryPanel.tsx` (reorder blocks; add icon)
- `src/frontend/src/index.css` (`.library-search`, `.library-search-input`; keep new
  CSS minimal, reuse existing tokens)

---

## Part 2 — "Bench" tab (renamed, extensible variant switcher)

### Current state
- Tab labeled **"Donor boards"**, `viewMode === 'bench'` (`LibraryPanel.tsx` ~L844-850,
  `data-testid="bench-tab"`). Content = inline donor list + backup import/export
  (~L942-1021).
- `ViewMode = 'history' | 'metadata' | 'folders' | 'model' | 'search' | 'bench'`
  (`databank-store.ts` L202).
- Device DB = `DatabaseEditorPanel`, opened from Settings ▸ Library via
  `openDatabaseEditor()` (adds Dockview panel `id: 'database-editor'`,
  `component: 'databaseEditor'`). Registered in `App.tsx`.
- Worklists = per-board records in IndexedDB `boardripper-worklist` → object store
  `boards` (keyPath `key`). Each record `BoardWorklistes` holds `worklistes: Worklist[]`
  (multiple per board) + `fileName` + `updatedAt`. The store hydrates one board at a
  time (`get(key)`); there is no "list all" method yet.

### Change

**Rename** the tab label "Donor boards" → **"Bench"**. `viewMode` stays `'bench'`
(no store/type change); keep `data-testid="bench-tab"`.

**Add a variant switcher** inside the Bench content area — a compact segmented pill row
styled like the existing `.library-browse-pill`. Data-driven from a module-level array
so future variants just append:

```ts
type BenchViewId = 'donors' | 'worklists' | 'devicedb';
interface BenchViewDef { id: BenchViewId; label: string; kind: 'inline' | 'launch'; }
const BENCH_VIEWS: BenchViewDef[] = [
  { id: 'donors',    label: 'Donor boards', kind: 'inline' },
  { id: 'worklists', label: 'Worklists',    kind: 'inline' },
  { id: 'devicedb',  label: 'Device DB',    kind: 'launch' },
];
```

Selected variant persisted as `benchView` in `databank-store` (mirrors `browseMode`:
private field + getter + `setBenchView`, `useSyncExternalStore`-friendly). Default
`'donors'`.

**Variant behavior:**
- **Donor boards** (`inline`) — existing donor list/backups, unchanged. Just wrapped so
  it renders when `benchView === 'donors'`.
- **Worklists** (`inline`, **placeholder**) — a read-only catalog of every worklist
  stored locally. New method `worklistStore.listAllStored(): Promise<BoardWorklistes[]>`
  using `objectStore('boards').getAll()`. Rendered flattened: for each stored board
  record, one row per worklist showing **board file name · worklist name · part/net
  counts · last-updated** (from `updatedAt`). Empty state: "No worklists stored yet."
  A one-line caption notes this is the seed of a future shared-knowledge database. No
  editing, no board-switching in this iteration.
- **Device DB** (`launch`) — selecting the variant opens or focuses the existing
  `database-editor` Dockview panel. Extract the current `openDatabaseEditor()` body
  from `SettingsPanel.tsx` into a shared `ensureDatabaseEditorPanel()` helper in
  `store/dockview-api.ts` (alongside the existing `ensureBoardPanel`/`ensurePdfPanel`,
  which use the global `getDockviewApi()` accessor; `LibraryPanel` already imports from
  this module). Both Settings and Bench call the shared helper. The Bench content area
  shows a one-line affordance ("Open Device Database ↗") that re-opens/focuses the panel
  if the user closed it. The Editor keeps its full-size two-pane layout.

### Files
- `src/frontend/src/panels/LibraryPanel.tsx` (tab label; switcher; variant routing)
- `src/frontend/src/store/databank-store.ts` (`benchView` state + setter)
- `src/frontend/src/store/worklist-store.ts` (`listAllStored()`)
- `src/frontend/src/store/dockview-api.ts` (`ensureDatabaseEditorPanel()` helper)
- `src/frontend/src/panels/SettingsPanel.tsx` (call the shared helper instead of its
  local `openDatabaseEditor`)

---

## Part 3 — Folders: DB-only + per-branch rescan button

### Current state
- Folders tab shows a DB/Live pill (`LibraryPanel.tsx` ~L859-880) switching
  `browseMode: 'database' | 'live'` (`databank-store.ts` L385/443/1729).
  - **DB** → `FolderView` (~L2505-2570) from `GET /api/databank/tree` (precomputed,
    cheap). Per-folder "idx" button (class `.library-live-index-btn`, ~L2606) →
    `handleIndexFolder` → `POST /api/pdfindex/index-folder`.
  - **Live** → `LiveBrowser` (~L1176-1317) from `GET /api/databank/browse?path=…`
    (`Scanner.BrowseDir`, one `os.ReadDir` per directory; not persisted to DB).
- Backend full scan: `Scanner.Scan()`/`scanWorker` `filepath.Walk(scanRoot)`
  (`scanner.go` L307/321/353), reconciles deletions across the whole DB, then rebuilds
  the folder tree (`BuildFolderTree`, L855). Scan state is a **singleton**
  (`s.status`, `ScanAsync`/`StopScan`/`Status`).

### Change

**Remove Live.** Delete the DB/Live pill; the Folders tab always renders `FolderView`
(DB tree). Remove the `browseMode`/`LiveBrowser` code path and the now-dead
`LiveBrowser` component (commit before deleting, per repo safety rule). Keep or drop
the `browseMode` store field depending on remaining consumers — remove if unused.

**Per-branch update button.** In `FolderNodeView`, add a second small button next to
"idx" (same visual weight; a refresh/↻ glyph). On click it runs a **subtree rescan**:

- **Frontend:** `databankStore.scanFolder(path)` → `POST /api/databank/scan/folder`
  with `{ path }` (library-relative). While it runs, show a spinner on that branch and
  disable other branch-update buttons + the full scan (singleton constraint). On
  completion, refresh the folder tree (re-fetch `/api/databank/tree`) so the DB view
  reflects added/removed/updated files.
- **Backend:** new handler `POST /api/databank/scan/folder` and
  `Scanner.ScanFolderAsync(relPath)`:
  - Validate/sandbox `relPath` under `scanRoot` (reuse the same path-sandbox guard as
    `BrowseDir`).
  - `filepath.Walk(filepath.Join(scanRoot, relPath))`, upserting each supported file
    (reuse the per-file logic from `scanWorker`/`IndexFile` + `UpdateFileScan`).
  - Reconcile deletions **scoped to the prefix**: only remove DB `files` whose `path`
    is under `relPath/` and were not seen this walk (a `WHERE path LIKE ?||'/%'`-bounded
    pass, not a full-table sweep).
  - Reuse the singleton scan status so existing progress UI (`scanStatus`) and
    `StopScan` work unchanged; set `ActiveOp` accordingly.
  - Rebuild the folder tree after finishing.

### Performance analysis (the "how bad is it" question)
- Cost is proportional to the number of files **under the clicked branch**: a handful
  of `stat`s for a small folder (effectively instant); only as expensive as a full scan
  if the user clicks the library-root branch — which is no worse than the existing full
  scan.
- Deletion reconciliation is prefix-bounded (`path LIKE 'relPath/%'`), so it does not
  scan the whole `files` table.
- Scans are singleton, so per-branch updates serialize; the UI disables concurrent
  triggers and shows per-branch busy state. No new concurrency model needed.

### Files
- `src/frontend/src/panels/LibraryPanel.tsx` (remove pill; remove `LiveBrowser` usage;
  add branch button + busy state)
- delete `LiveBrowser` component (after commit)
- `src/frontend/src/store/databank-store.ts` (`scanFolder`; remove `browseMode`/`browse`
  if unused)
- `src/backend/databank/scanner.go` (`ScanFolderAsync` + prefix-scoped delete reconcile)
- `src/backend/handlers/…` (register `POST /api/databank/scan/folder`)

---

## Testing

- **Part 1:** Playwright — assert DOM order (search input precedes `.library-statsbar`)
  on a filter-bearing tab; assert the search input renders the icon and is visible.
- **Part 2:** Playwright — Bench tab label reads "Bench"; switcher shows the three
  variants; selecting "Worklists" lists seeded worklists (seed IndexedDB via
  `addInitScript`, like `session-restore.spec.ts`); selecting "Device DB" opens the
  `database-editor` panel. Unit-test `worklistStore.listAllStored()` returns all
  seeded records.
- **Part 3:** Go test for `ScanFolderAsync` — seed a temp library subtree, add/remove/
  modify a file, assert only that subtree's rows change and out-of-subtree rows are
  untouched. Playwright — the branch button appears next to "idx" and disables during a
  run.

## Risks / tradeoffs

- Stats-line vertical position shifts between filter and non-filter tabs (Part 1,
  accepted).
- Removing Live loses ad-hoc "see the raw filesystem" browsing; the per-branch rescan
  covers the real need (pull fresh files into the DB view).
- Extracting `openDatabaseEditor()` touches `SettingsPanel.tsx`; keep it a pure move to
  avoid behavior drift.

## Future work (out of scope)

- Shared/remote worklist "knowledge" database; the Worklists variant graduates from a
  local catalog to a synced, browsable meta-DB.
- Clicking a worklist row to switch to that board / load that worklist.
- Additional `BENCH_VIEWS` entries (e.g. Bindings, Dedup) via the same switcher.
