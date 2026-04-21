# Library panel rework — design

Date: 2026-04-22

## Goals

1. Reduce Library panel page-load time on big libraries.
2. Make the filter work on the History view.
3. Bump default history depth from 20 → 100 and migrate existing users (when at the old default).
4. Move Auto-PDF toggle, history depth control, and Clear-history button to Settings → Server / Library.
5. When filter is active, hide folders/groups that contain no matching files.
6. Redesign the header: stats row on top with scan buttons, tabs below (true-tab styling, not buttons), DB ⇄ Live as a small pill toggle inline in the tab row when Folders is active.

Non-goals:

- No changes to scanning, Live browser contents, file-detail pane, binding UI, or preview thumbnail pipeline.
- No changes to Electron-mode-specific flows beyond the header restyle.
- No virtualization of file lists in this release.

---

## 1. Load-time optimization

### Findings from current code

- [LibraryPanel.tsx:86-95](../../../src/frontend/src/panels/LibraryPanel.tsx#L86-L95) fires `loadConfig → fetchFiles → fetchTree → checkScanStatus` sequentially on mount. `fetchFiles` and `fetchTree` are independent and can run in parallel.
- [useDatabank.ts:43-44](../../../src/frontend/src/hooks/useDatabank.ts#L43-L44) reads `databankStore.metadataTree` and `databankStore.modelTree` in the snapshot builder. Both are O(N log N) getters that run on **every** store notify — including scan-polling ticks (every 500 ms) and selection changes — even when the active view is History, which never uses them. `createStoreHook` caches the snapshot per notify, so the cost is per-notify, not per-render, but it still dominates during scans on large libraries.
- `/api/databank/tree` duplicates information already present in `/api/databank/files`. The client can build the folder tree from files it already has.
- No virtualization on tree views; each expanded tree emits one DOM node per file.

### Changes

**P1 — Parallelize mount fetches.**

In `LibraryPanel` effect: `await loadConfig()` first (needed for backend-unavailable detection and library path), then `Promise.all([fetchFiles(), checkScanStatus()])`. Defer `fetchTree()` (see P2). Keep Electron branch unchanged.

**P2 — Defer folder tree fetch.**

- Remove `fetchTree()` from the mount effect.
- Add a `useEffect` in LibraryPanel that calls `fetchTree()` the first time `viewMode === 'folders' && browseMode === 'database'` becomes true and `_folderTree` is still null.
- Alternative considered and rejected: build the folder tree client-side from `files[]`. Rejected because the backend tree currently includes directory names with no matching files but potentially other structural signals; deferring is safer and sufficient.

**P3 — Memoize metadata and model trees.**

Replace the two getters with a `private _filesVersion = 0` counter bumped in every mutation to `_files`, plus `_metadataTreeCache`/`_modelTreeCache` fields keyed on the current `_filesVersion`. Getters return the cached value when the version matches.

Effect: notifies that don't touch `_files` (scan polling, selection, searchQuery, browse result, etc.) return the exact same tree reference — no recomputation.

**P5 — Verify gzip on `/api/databank/files`.**

Check `src/backend/handlers/databank.go` and the router wiring. If the endpoint is not gzipped, wrap it in a gzip middleware. Keep the change minimal; skip if already present.

### Deferred

- **P4 — Virtualization.** Not in scope for this release. Revisit if P1/P2/P3/P5 do not resolve perceived lag for the largest libraries in the field.

### Measurement

Before and after timings for page load with the largest library available locally. Log `performance.now()` deltas around `fetchFiles` and the first useful paint (tabs + stats visible). Acceptance: measurable improvement; no regression on small libraries.

---

## 2. Filter works on History

[HistoryView](../../../src/frontend/src/panels/LibraryPanel.tsx#L650) currently ignores `localSearch`. Fix:

- Pass `filterFile` / `searchFilter` into `HistoryView`.
- Filter predicate for a `RecentItem`:
  - Empty filter → show all.
  - Otherwise: substring match (case-insensitive) against `fileName` and `path`.
  - If a `DatabankFile` with the same path is in `files`, also match `board_number`, `manufacturer`, `model` (same fields the metadata/model views filter on).
- The existing "PDF search" toggle is **hidden** when `viewMode === 'history'`. On the History tab, the search input is a pure substring filter. When the user leaves History, the PDF toggle reappears and behaves as today.

---

## 3. History defaults + migration + moving controls to Settings

### Defaults

- Change [databank-store.ts:178-183](../../../src/frontend/src/store/databank-store.ts#L178-L183) default from `20` to `100`.
- Keep the clamp `Math.min(100, Math.max(1, ...))`.

### Migration (variant b)

On `DatabankStore` construction, if the persisted `boardripper-history-depth` value is exactly `'20'` (the prior default, meaning the user never changed it), rewrite it to `100` in localStorage and use `100` as the initial value. Any other numeric value — including below 100, above 100, or custom — is left alone.

```ts
const stored = localStorage.getItem('boardripper-history-depth');
if (stored === '20') {
  localStorage.setItem('boardripper-history-depth', '100');
  return 100;
}
return stored ? Math.min(100, Math.max(1, Number(stored))) : 100;
```

### Move controls to Settings

Append three controls to the existing *Server / Library* `CollapsibleSection` in [SettingsPanel.tsx:1438-1443](../../../src/frontend/src/panels/SettingsPanel.tsx#L1438-L1443), under a new subsection label **"Library"**:

- **Auto-load bound PDFs** — checkbox bound to `autoPdf`.
- **Recent history depth** — number input (1–100) bound to `historyDepth`.
- **Clear history** — button. Disabled when `recentItems.length === 0`.

Remove the `library-history-controls` div (the depth input + Clear button) from `HistoryView`. Remove the Auto-PDF `<label>` from the Library header. The store methods (`setAutoPdf`, `setHistoryDepth`, `clearHistory`) stay as they are — only the UI moves.

---

## 4. Filter hides empty directories

### Folders view

Add a pre-pass before rendering:

```ts
function pruneEmpty(node: FolderNode, filter: (f: DatabankFile) => boolean): FolderNode | null {
  const files = (node.files ?? []).filter(filter);
  const children = (node.children ?? [])
    .map(c => pruneEmpty(c, filter))
    .filter((c): c is FolderNode => c !== null);
  if (files.length === 0 && children.length === 0) return null;
  return { ...node, files, children };
}
```

`FolderView` calls `pruneEmpty(tree, filterFile)` only when the search filter is non-empty; when the filter is empty, the tree passes through unchanged (so empty folders remain visible in the unfiltered browsing state).

### Metadata / Model views

Already prune groups with zero files after filtering. Verify this is consistent across both levels of nesting (manufacturer → board number, model line → variant). No functional change expected.

### Scope

Database views only: folders, metadata, model. Live browser and history are not affected.

---

## 5. Header redesign

### New structure (top → bottom)

```
┌────────────────────────────────────────────────────────┐
│  {boards}/{PDFs}, scan summary…        [fs] [pdf]      │  ← stats bar + scan buttons
├────────────────────────────────────────────────────────┤
│  History  Board#  Model  Folders          [DB|Live]    │  ← tabs (DB|Live only shown if Folders active)
├────────────────────────────────────────────────────────┤
│  [ filter input…                            ] [x]      │  ← search row (PDF toggle visible except in History)
├────────────────────────────────────────────────────────┤
│  list…                                                 │
└────────────────────────────────────────────────────────┘
```

### Changes

- **Move the stats row to the top**, above the tabs. Scan buttons live on its right side. When scanning is active, scan buttons are replaced with **Stop** (same slot). Indexing progress text goes on the left of the stats row — same as today, just hoisted.
- **Tabs styled as real tabs**: no box background, `border-bottom: 2px solid transparent` default, active = `border-bottom-color: var(--accent)` and `color: var(--text-primary)`, hover tints the text only. Tabs sit flush with the top of the list area. Keep icons for History and Folders, text for Board# and Model.
- **DB ⇄ Live** becomes a small 2-state pill toggle rendered inline in the tab row, right-aligned, visible only when `viewMode === 'folders'`. Visual spec: ~64 px total width, segmented, active segment filled with `var(--accent)`. Replaces the current `library-browse-toggle` row entirely.
- **Auto PDF** is removed from the header (now lives in Settings, §3).
- **Filter row** stays where it is. The PDF-search checkbox is hidden when `viewMode === 'history'` (§2).

### CSS

New/updated classes in [index.css](../../../src/frontend/src/index.css):

- `.library-header` → now hosts the stats + scan buttons; rename existing rules accordingly (or add `.library-statsbar` and retire `.library-header`'s old role).
- `.library-tabs-row` → new container for tabs + DB/Live pill.
- `.library-tab` → restyle to tab look: transparent background, bottom-border indicator, no border sides/top.
- `.library-browse-pill` → new 2-state pill toggle. Compact.

Remove `.library-browse-toggle` (the old second row).

### Tests / verification

- Playwright: switch between all four tabs, verify active-tab styling and that the DB|Live pill is only rendered when Folders is active.
- Manual: run a scan, confirm stats-bar indexing text renders and Stop button replaces scan icons in the right slot.

---

## Risks and open questions

- **Gzip check (P5)** may turn up no work if already present. That's fine; skip without adding a middleware.
- **Header restyle** may touch existing Playwright selectors. Expect to update selectors for `.library-tab` and remove any tests referencing `.library-browse-toggle`.
- **Migration (variant b)** is a one-shot read on store construction; it runs once per browser session, no schema versioning. If a user has exactly `20` as a deliberate custom value, they will be bumped to 100 — deemed acceptable because 20 was the product default.

## File touch list

- `src/frontend/src/panels/LibraryPanel.tsx` — header/tabs restyle, HistoryView filter, lazy tree fetch, folder-tree pruning.
- `src/frontend/src/store/databank-store.ts` — default 100, migration, memoized metadata/model trees, `_filesVersion`.
- `src/frontend/src/hooks/useDatabank.ts` — no behavior change; snapshot now returns stable tree references.
- `src/frontend/src/panels/SettingsPanel.tsx` — Library subsection (auto-pdf, history depth, clear history).
- `src/frontend/src/index.css` — header restyle, tab restyle, browse pill, remove `.library-browse-toggle`.
- `src/backend/handlers/databank.go` or router wiring — gzip check only if missing.

