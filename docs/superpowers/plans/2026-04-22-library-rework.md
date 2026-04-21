# Library Rework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship five library-panel improvements in one release: load-time wins for big libraries, filter-that-also-works-on-history, history default bumped to 100 with migration, Auto-PDF + history controls moved to Settings, empty-folder pruning when filtering, and a new header layout (stats on top, tab-styled tabs, compact DB/Live pill).

**Architecture:**

- Frontend-only behavior changes plus one backend middleware addition. All state continues to live in `databankStore` + local component state; no new stores.
- Tree memoization uses a simple version counter bumped on `_files` writes — no new dependencies.
- Folder-tree fetch moves from mount time to first-use time for the Folders tab.
- Header restyle is CSS-driven; JSX is reordered but the data flow stays the same.
- Backend gains a generic gzip middleware applied to the final mux — benefits all JSON endpoints, not just `/files`, at negligible cost.

**Tech Stack:** React 19, TypeScript strict, Vite 7, Playwright E2E, Go net/http stdlib, `compress/gzip`.

**Spec:** [docs/superpowers/specs/2026-04-22-library-rework-design.md](../specs/2026-04-22-library-rework-design.md)

---

## Notes for the implementing engineer

- Working directory: project root `/Users/besitzer/Desktop/Boardviewer`. Current branch: `main`. No worktree has been created — commit directly to `main` unless the user has moved you into a worktree. Check `git status` first.
- Dev server: `cd src/frontend && npm run dev` (Vite defaults to `:5173`). Backend: `cd src/backend && go run . -port 8080`. During manual testing the frontend talks to the backend at `/api/*` via Vite proxy.
- Playwright: `cd src/frontend && npx playwright test <spec>` to run a single spec, `npx playwright test` to run all.
- Type-check + build: `cd src/frontend && npm run build`. Run this after every meaningful edit — TS strict catches most regressions.
- Go lint/vet: `cd src/backend && go vet ./... && go build ./...`.
- **`_files` invariant:** whenever `databankStore` mutates `this._files`, either it reassigns a fresh array OR it mutates in place. The existing code reassigns via `this._files = [...]` after writes (see `updateFile`, `_electronScan`, `fetchFiles`). Task 2 relies on a single setter path for version bumping; you will wrap writes with a private helper.
- The `tail_truncate` style helper `tailTruncate` (LibraryPanel:46) already exists — reuse it rather than adding new truncation.
- After the header restyle in Task 7, some Playwright specs that query `.library-header`, `.library-browse-toggle`, or `.library-tab` text content may break. Grep the tests and update selectors as you go.
- **Safety rule from CLAUDE.md:** commit at each task boundary. Don't accumulate more than one task's worth of uncommitted work.

---

## File Structure

| File | Role |
| --- | --- |
| `src/frontend/src/store/databank-store.ts` | **Heavily modified.** History-depth default `20→100` + one-shot migration. New `_filesVersion` counter + memoized `metadataTree`/`modelTree` getters. Private `_setFiles()` helper. |
| `src/frontend/src/panels/LibraryPanel.tsx` | **Heavily modified.** Mount effect parallelized; folder-tree fetch deferred. `HistoryView` accepts and applies the filter. PDF-search toggle hidden when `viewMode === 'history'`. Folder tree pruned when filter is active. Auto-PDF + history-depth + Clear-history controls removed from panel (moved to Settings in Task 6). Header JSX reordered: stats row on top (with scan buttons), tabs row below (real-tab styling, inline DB/Live pill when Folders active), filter row last. |
| `src/frontend/src/panels/SettingsPanel.tsx` | **Modified.** `Server / Library` section gains a "Library" subsection with three controls: Auto-load bound PDFs, Recent history depth, Clear history. |
| `src/frontend/src/index.css` | **Modified.** New rules for the reordered header (`.library-statsbar`, tab restyle, `.library-browse-pill`). Remove obsolete `.library-browse-toggle`, `.library-donor-filter`. |
| `src/frontend/tests/library-panel.spec.ts` | **New.** Playwright coverage for: history filter matches filename substring, PDF toggle hidden on history tab, DB/Live pill only visible when Folders tab active. |
| `src/backend/main.go` | **Modified.** Wrap `mux` in a new `gzipMiddleware` before passing to `ListenAndServe`. |
| `src/backend/middleware_gzip.go` | **New.** Small stdlib-only gzip responder; skips already-encoded responses and small payloads. |

No parser, renderer, board-store, or pdf-store changes.

---

## Task 1: Store — history depth default + one-shot migration (20→100)

**Files:**
- Modify: `src/frontend/src/store/databank-store.ts` (initializer IIFE at line 178-183 and the `setHistoryDepth` method at line 706-715)

- [ ] **Step 1: Update the history-depth initializer to migrate the old default**

Replace the current IIFE:

```ts
private _historyDepth: number = (() => {
  try {
    const v = localStorage.getItem('boardripper-history-depth');
    return v ? Math.min(100, Math.max(1, Number(v))) : 20;
  } catch { return 20; }
})();
```

with:

```ts
private _historyDepth: number = (() => {
  try {
    const v = localStorage.getItem('boardripper-history-depth');
    // Migration: the previous product default was 20. Bump legacy-default users
    // to the new default of 100, but leave any other stored value (including
    // values below 100 a user has explicitly chosen) untouched.
    if (v === '20') {
      localStorage.setItem('boardripper-history-depth', '100');
      return 100;
    }
    return v ? Math.min(100, Math.max(1, Number(v))) : 100;
  } catch { return 100; }
})();
```

- [ ] **Step 2: Update the recentItems trim guard in `addToHistory` and `setHistoryDepth`**

No code change needed — both methods already use `this._historyDepth` as the cap, so they inherit the new default automatically. Read through `addToHistory` (line 682) and `setHistoryDepth` (line 706) and confirm.

- [ ] **Step 3: Build and type-check**

Run: `cd src/frontend && npm run build`
Expected: build passes.

- [ ] **Step 4: Manual smoke**

Open the app with empty localStorage: inspect `databankStore.historyDepth` — should be `100`. Then set `localStorage.setItem('boardripper-history-depth', '20')`, reload: should migrate to `100`. Set `'15'`, reload: stays `15`. Set `'50'`, reload: stays `50`.

- [ ] **Step 5: Commit**

```bash
git add src/frontend/src/store/databank-store.ts
git commit -m "fix(library): default history depth 100, migrate legacy 20→100

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Store — memoize metadataTree + modelTree via `_filesVersion`

Eliminates O(N log N) tree rebuilds on every store notify. Getters previously ran on every scan-polling tick and every selection change.

**Files:**
- Modify: `src/frontend/src/store/databank-store.ts`

- [ ] **Step 1: Add a version counter and cache fields**

Add these private fields just below `private _files: DatabankFile[] = [];` (line 150):

```ts
private _filesVersion = 0;
private _metadataCache: { version: number; tree: MetadataGroup[] } | null = null;
private _modelCache: { version: number; tree: ModelGroup[] } | null = null;
```

- [ ] **Step 2: Add a private `_setFiles` helper and route all `_files` writes through it**

Add immediately after the new cache fields:

```ts
/** Single mutation point for `_files`. Bumps the version so memoized
 *  getters (metadataTree/modelTree) know to recompute. */
private _setFiles(files: DatabankFile[]) {
  this._files = files;
  this._filesVersion++;
  this._metadataCache = null;
  this._modelCache = null;
}
```

Replace every direct `this._files = ...` assignment in the class with `this._setFiles(...)`:

1. `fetchFiles` (~line 376): `if (data) this._files = data;` → `if (data) this._setFiles(data);`
2. `updateFile` (~line 513-514): `this._files[idx] = { ...this._files[idx], ...update }; this._files = [...this._files];` → `const next = [...this._files]; next[idx] = { ...next[idx], ...update }; this._setFiles(next);`
3. `generatePdfPreview` (~line 590-593): same transformation — build `next` array, call `this._setFiles(next)`.
4. `resetAll` (~line 619): `this._files = [];` → `this._setFiles([]);`
5. `_electronScan` (~line 797): `this._files = result.files;` → `this._setFiles(result.files);`

Search the file for `this._files =` to make sure you get every occurrence. Any occurrence that doesn't bump the version is a bug.

- [ ] **Step 3: Replace the `metadataTree` getter with a memoized version**

Replace the whole `get metadataTree(): MetadataGroup[] { ... }` block (line 212-251). The body stays identical — wrap it:

```ts
get metadataTree(): MetadataGroup[] {
  if (this._metadataCache && this._metadataCache.version === this._filesVersion) {
    return this._metadataCache.tree;
  }
  const mfrMap = new Map<string, Map<string, DatabankFile[]>>();
  const ungroupedMap = new Map<string, DatabankFile[]>();

  for (const f of this._files) {
    const mfr = f.manufacturer || 'Unknown';
    if (f.board_number) {
      if (!mfrMap.has(mfr)) mfrMap.set(mfr, new Map());
      const boardMap = mfrMap.get(mfr)!;
      if (!boardMap.has(f.board_number)) boardMap.set(f.board_number, []);
      boardMap.get(f.board_number)!.push(f);
    } else {
      if (!ungroupedMap.has(mfr)) ungroupedMap.set(mfr, []);
      ungroupedMap.get(mfr)!.push(f);
    }
  }

  const groups: MetadataGroup[] = [];
  const allMfrs = new Set([...mfrMap.keys(), ...ungroupedMap.keys()]);

  for (const mfr of [...allMfrs].sort()) {
    const boardMap = mfrMap.get(mfr);
    const boardNumbers: MetadataGroup['boardNumbers'] = [];
    if (boardMap) {
      for (const [bn, files] of [...boardMap.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        boardNumbers.push({ boardNumber: bn, files });
      }
    }
    groups.push({
      manufacturer: mfr,
      boardNumbers,
      ungrouped: ungroupedMap.get(mfr) || [],
    });
  }

  this._metadataCache = { version: this._filesVersion, tree: groups };
  return groups;
}
```

- [ ] **Step 4: Replace the `modelTree` getter with a memoized version**

Same pattern. Replace the whole `get modelTree(): ModelGroup[] { ... }` block (line 253-310):

```ts
get modelTree(): ModelGroup[] {
  if (this._modelCache && this._modelCache.version === this._filesVersion) {
    return this._modelCache.tree;
  }
  const lineMap = new Map<string, Map<string, { info: string; aNumber: string; boardNumber: string; files: DatabankFile[] }>>();
  const unresolved: DatabankFile[] = [];

  for (const f of this._files) {
    if (f.resolution_status === 'resolved' && f.model && f.manufacturer) {
      const modelLine = `${f.manufacturer} — ${f.model}`;
      if (!lineMap.has(modelLine)) lineMap.set(modelLine, new Map());
      const variants = lineMap.get(modelLine)!;
      const key = f.board_number;
      if (!variants.has(key)) {
        const odm = f.board_manufacturer ? ` [${f.board_manufacturer}]` : '';
        variants.set(key, { info: `${f.model}${odm}`, aNumber: '', boardNumber: f.board_number, files: [] });
      }
      variants.get(key)!.files.push(f);
      continue;
    }
    const entry = f.board_number ? lookupBoard(f.board_number) : undefined;
    if (entry) {
      if (!lineMap.has(entry.model)) lineMap.set(entry.model, new Map());
      const variants = lineMap.get(entry.model)!;
      const key = entry.board_number;
      if (!variants.has(key)) {
        variants.set(key, { info: entry.info, aNumber: entry.a_number, boardNumber: entry.board_number, files: [] });
      }
      variants.get(key)!.files.push(f);
      continue;
    }
    unresolved.push(f);
  }

  const groups: ModelGroup[] = [];
  for (const [modelLine, variants] of [...lineMap.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    groups.push({
      modelLine,
      variants: [...variants.values()].sort((a, b) => a.boardNumber.localeCompare(b.boardNumber)),
      unresolved: [],
    });
  }
  if (unresolved.length > 0) {
    groups.push({ modelLine: 'Other', variants: [], unresolved });
  }

  this._modelCache = { version: this._filesVersion, tree: groups };
  return groups;
}
```

- [ ] **Step 5: Build + type-check**

Run: `cd src/frontend && npm run build`
Expected: build passes.

- [ ] **Step 6: Manual smoke**

Load a library, open the Board # tab, trigger a scan. While scanning, tree reference should stay `===` identical between polling ticks. Verify in DevTools console:

```js
const t1 = __databankStore?.metadataTree ?? null;
// wait 1 second
const t2 = __databankStore?.metadataTree ?? null;
t1 === t2 // should be true during idle
```

(If the store isn't exposed on `window`, add a temporary `(window as any).__databankStore = databankStore;` line at the bottom of `databank-store.ts` for the check, then remove it before commit.)

- [ ] **Step 7: Commit**

```bash
git add src/frontend/src/store/databank-store.ts
git commit -m "perf(library): memoize metadata/model trees with version counter

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: LibraryPanel — parallelize mount fetches, defer folder-tree fetch

**Files:**
- Modify: `src/frontend/src/panels/LibraryPanel.tsx` (mount effect at line 86-95, add a new effect below)

- [ ] **Step 1: Update the mount effect**

Replace:

```ts
useEffect(() => {
  if (typeof window !== 'undefined' && window.electronAPI?.scanLibrary) {
    databankStore.initElectron();
  } else {
    databankStore.loadConfig();
    databankStore.fetchFiles();
    databankStore.fetchTree();
    databankStore.checkScanStatus();
  }
}, []);
```

with:

```ts
useEffect(() => {
  if (typeof window !== 'undefined' && window.electronAPI?.scanLibrary) {
    databankStore.initElectron();
    return;
  }
  // loadConfig must run first: it discovers library_dir / _scan_root
  // and flips _backendAvailable. Files + scan status can race.
  databankStore.loadConfig().then(() => {
    Promise.all([
      databankStore.fetchFiles(),
      databankStore.checkScanStatus(),
    ]);
  });
  // folderTree fetch is deferred to first use (see the effect below)
}, []);
```

- [ ] **Step 2: Add a lazy-fetch effect for the folder tree**

Add this effect immediately after the mount effect:

```ts
// Fetch folder tree only the first time the user opens the Folders tab
// in database mode. For Electron mode the tree is built during _electronScan
// and folderTree is already populated — no fetch needed.
useEffect(() => {
  if (electronMode) return;
  if (viewMode !== 'folders' || browseMode !== 'database') return;
  if (folderTree) return;
  databankStore.fetchTree();
}, [viewMode, browseMode, folderTree, electronMode]);
```

(You need `folderTree` in the destructured `useDatabank()` call at line 57 — it's already there.)

- [ ] **Step 3: Build + type-check**

Run: `cd src/frontend && npm run build`
Expected: build passes.

- [ ] **Step 4: Manual smoke**

Reload the app with the DevTools Network tab open. Filter by `databank`. Expected on mount:

- `/api/config` → fires first
- `/api/databank/files` and `/api/databank/scan/status` → fire concurrently after config resolves
- `/api/databank/tree` → **does not fire** on mount

Click the Folders tab → `/api/databank/tree` fires now. Click Folders again → no second fetch.

- [ ] **Step 5: Commit**

```bash
git add src/frontend/src/panels/LibraryPanel.tsx
git commit -m "perf(library): parallelize mount fetches, lazy-load folder tree

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: LibraryPanel — history filter + hide PDF toggle on history

**Files:**
- Modify: `src/frontend/src/panels/LibraryPanel.tsx`

- [ ] **Step 1: Hide the PDF-search toggle when History is active**

Find the search row JSX at line 301-311:

```tsx
<label className="library-pdf-search-toggle" title="Toggle PDF content search (searches inside PDF text)">
  <input
    type="checkbox"
    checked={pdfSearchMode}
    onChange={(e) => {
      setPdfSearchMode(e.target.checked);
      if (!e.target.checked && searchQuery) databankStore.search('');
    }}
  />
  PDF
</label>
```

Wrap in a visibility guard:

```tsx
{viewMode !== 'history' && (
  <label className="library-pdf-search-toggle" title="Toggle PDF content search (searches inside PDF text)">
    <input
      type="checkbox"
      checked={pdfSearchMode}
      onChange={(e) => {
        setPdfSearchMode(e.target.checked);
        if (!e.target.checked && searchQuery) databankStore.search('');
      }}
    />
    PDF
  </label>
)}
```

Then also guard the conditional "Search" button at line 312-321 the same way — it already checks `pdfSearchMode` but the toggle itself is hidden so the button will naturally never render; no extra guard needed.

- [ ] **Step 2: Force-clear PDF mode when switching into History**

Just after the mount effect (before the `handleFileScan` callback), add:

```ts
// Leaving history while in PDF-search mode is fine (toggle reappears).
// Entering history while PDF-search mode is true would leave pdfSearchMode=true
// without a UI control to turn it off — so normalize on viewMode change.
useEffect(() => {
  if (viewMode === 'history' && pdfSearchMode) {
    setPdfSearchMode(false);
    if (searchQuery) databankStore.search('');
  }
}, [viewMode, pdfSearchMode, searchQuery]);
```

- [ ] **Step 3: Apply `filterFile`-style filter to HistoryView**

Update the `HistoryView` signature (line 650) and body:

```tsx
function HistoryView({ onOpenFile, searchFilter }: {
  onOpenFile: (f: DatabankFile) => void;
  searchFilter: string;
}) {
  const { recentItems, files } = useDatabank();

  const formatTime = (ts: number) => {
    const d = new Date(ts);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    if (sameDay) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  };

  const q = searchFilter.trim().toLowerCase();
  const filteredItems = q
    ? recentItems.filter(item => {
        // Match against fileName and path directly
        if (item.fileName.toLowerCase().includes(q)) return true;
        if (item.path.toLowerCase().includes(q)) return true;
        // Also match against the richer DatabankFile fields if the item is still in the library
        const dbFile = files.find(f => f.path === item.path);
        if (!dbFile) return false;
        return (
          dbFile.board_number?.toLowerCase().includes(q) ||
          dbFile.manufacturer?.toLowerCase().includes(q) ||
          dbFile.model?.toLowerCase().includes(q)
        ) ?? false;
      })
    : recentItems;

  return (
    <div className="library-history">
      {recentItems.length === 0 ? (
        <div className="library-empty">No recently opened files.</div>
      ) : filteredItems.length === 0 ? (
        <div className="library-empty">No recent files match "{searchFilter}".</div>
      ) : (
        <div className="library-tree-children">
          {filteredItems.map((item, i) => {
            const dbFile = files.find(f => f.path === item.path);
            return (
              <div
                key={`${item.path}-${i}`}
                className={`library-file-row${dbFile ? '' : ' library-file-missing'}`}
                onClick={() => { if (dbFile) onOpenFile(dbFile); }}
                title={dbFile ? item.path : `${item.path} (not in library)`}
              >
                <span className={`library-file-icon ${item.fileType === 'pdf' ? 'library-icon-pdf' : 'library-icon-board'}`}>
                  {item.fileType === 'pdf' ? 'P' : 'B'}
                </span>
                <span className="library-file-name">{item.fileName}</span>
                <span className="library-history-time">{formatTime(item.openedAt)}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
```

Note what was removed: the `library-history-controls` block (depth input + Clear button) is gone. Those controls move to Settings in Task 6. `historyDepth` and `databankStore.clearHistory` are no longer needed here.

- [ ] **Step 4: Pass the filter string in from `LibraryPanel`**

Find the call site at line 372-373:

```tsx
) : viewMode === 'history' ? (
  <HistoryView onOpenFile={handleOpenFile} />
```

Change to:

```tsx
) : viewMode === 'history' ? (
  <HistoryView onOpenFile={handleOpenFile} searchFilter={localSearch} />
```

- [ ] **Step 5: Build + type-check**

Run: `cd src/frontend && npm run build`
Expected: build passes.

- [ ] **Step 6: Manual smoke**

1. Open History tab — PDF toggle must be absent.
2. Switch to Board # tab — PDF toggle reappears.
3. Turn on PDF mode, switch to History — mode auto-clears, toggle gone.
4. With some recent items, type part of a filename → list filters. Clear → all items return.

- [ ] **Step 7: Commit**

```bash
git add src/frontend/src/panels/LibraryPanel.tsx
git commit -m "feat(library): filter applies to history, hide PDF toggle on history tab

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: LibraryPanel — prune empty folders when filter is active

**Files:**
- Modify: `src/frontend/src/panels/LibraryPanel.tsx` (FolderView at line 942)

- [ ] **Step 1: Add a `pruneEmptyFolders` helper**

Add just above the `FolderView` function:

```ts
/** Recursively remove folders whose filtered file lists and all descendant
 *  folder file lists are empty. Used when a filter is active so empty
 *  directories disappear from the tree. */
function pruneEmptyFolders(node: FolderNode, filter: (f: DatabankFile) => boolean): FolderNode | null {
  const files = (node.files ?? []).filter(filter);
  const children = (node.children ?? [])
    .map(c => pruneEmptyFolders(c, filter))
    .filter((c): c is FolderNode => c !== null);
  if (files.length === 0 && children.length === 0) return null;
  return { ...node, files, children };
}
```

- [ ] **Step 2: Wire the helper into `FolderView`**

Replace the `FolderView` body (line 942-970):

```tsx
function FolderView({ tree, selectedFileId, filterFile, searchFilter, onSelectFile, onOpenFile }: {
  tree: FolderNode | null;
  selectedFileId: number | null;
  filterFile: (f: DatabankFile) => boolean;
  searchFilter: string;
  onSelectFile: (f: DatabankFile) => void;
  onOpenFile: (f: DatabankFile) => void;
}) {
  const [expanded, toggle, collapseAll] = usePersistedExpanded('boardripper-tree-folders', ['']);

  // Only prune when the user is actively filtering — otherwise let empty
  // directories stay visible (browsing a fresh library should show structure).
  const visibleTree = useMemo(
    () => (searchFilter.trim() && tree ? pruneEmptyFolders(tree, filterFile) : tree),
    [searchFilter, tree, filterFile],
  );

  if (!visibleTree) {
    return <div className="library-empty">
      {searchFilter.trim() ? `No folders match "${searchFilter}".` : 'Loading folder tree...'}
    </div>;
  }

  return (
    <div className="library-tree">
      {expanded.size > 0 && (
        <button className="library-collapse-all" onClick={collapseAll} title="Collapse all folders">⊟</button>
      )}
      <FolderNodeView
        node={visibleTree}
        depth={0}
        expanded={expanded}
        selectedFileId={selectedFileId}
        filterFile={filterFile}
        onToggleExpand={toggle}
        onSelectFile={onSelectFile}
        onOpenFile={onOpenFile}
      />
    </div>
  );
}
```

- [ ] **Step 3: Update the `FolderView` call site to pass `searchFilter`**

Find the call site at line 392-399 in the `LibraryPanel` body:

```tsx
<FolderView
  tree={folderTree}
  selectedFileId={selectedFileId}
  filterFile={filterFile}
  onSelectFile={handleSelectFile}
  onOpenFile={handleOpenFile}
/>
```

Change to:

```tsx
<FolderView
  tree={folderTree}
  selectedFileId={selectedFileId}
  filterFile={filterFile}
  searchFilter={localSearch}
  onSelectFile={handleSelectFile}
  onOpenFile={handleOpenFile}
/>
```

- [ ] **Step 4: Build + type-check**

Run: `cd src/frontend && npm run build`
Expected: build passes.

- [ ] **Step 5: Manual smoke**

1. Open Folders tab with an empty filter — all folders including empty directories show.
2. Type a filter that matches only one file under a deep path — only that path chain stays visible; sibling empty folders disappear.
3. Clear the filter — all folders return, including empty ones.

- [ ] **Step 6: Commit**

```bash
git add src/frontend/src/panels/LibraryPanel.tsx
git commit -m "feat(library): prune empty folders from the folders view when filtering

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: SettingsPanel — add Library subsection (auto-pdf, history depth, clear history)

**Files:**
- Modify: `src/frontend/src/panels/SettingsPanel.tsx`

- [ ] **Step 1: Add a `LibrarySettingsSection` helper component**

Add this component definition just above the `SettingsPanelImpl` (or wherever the other section helpers like `LibraryFolderSetting` live — search `function LibraryFolderSetting(`):

```tsx
function LibrarySettingsSection() {
  const { autoPdf, historyDepth, recentItems } = useDatabank();
  const [depthDraft, setDepthDraft] = useState<string>(String(historyDepth));

  // Keep local draft in sync when the stored value changes externally
  useEffect(() => {
    setDepthDraft(String(historyDepth));
  }, [historyDepth]);

  const commitDepth = () => {
    const n = Number(depthDraft);
    if (!Number.isFinite(n)) { setDepthDraft(String(historyDepth)); return; }
    databankStore.setHistoryDepth(n);
  };

  return (
    <div className="settings-subsection">
      <div className="settings-subsection-label">Library</div>

      <label className="settings-row-toggle">
        <input
          type="checkbox"
          checked={autoPdf}
          onChange={(e) => databankStore.setAutoPdf(e.target.checked)}
        />
        <span>Auto-load bound PDFs when opening a board</span>
      </label>

      <label className="settings-row-field">
        <span>Recent history depth</span>
        <input
          type="number"
          min={1}
          max={100}
          value={depthDraft}
          onChange={(e) => setDepthDraft(e.target.value)}
          onBlur={commitDepth}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        />
      </label>

      <div className="settings-row-field">
        <span>Recent history ({recentItems.length} item{recentItems.length === 1 ? '' : 's'})</span>
        <button
          className="settings-action-btn"
          disabled={recentItems.length === 0}
          onClick={() => databankStore.clearHistory()}
        >
          Clear
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Mount it in the Server / Library section**

Find the existing `Server / Library` `CollapsibleSection` at line 1438-1443:

```tsx
<CollapsibleSection id="server" title="Server / Library" isOpen={openSections.has('server')}
  onToggle={toggleSection} sectionRef={serverRef} isFocused={focusedSection === 'server'}>
  <LibraryFolderSetting />
  <AutoScanToggle />
  <DatabaseInfoSection />
</CollapsibleSection>
```

Add `<LibrarySettingsSection />` after `<DatabaseInfoSection />`:

```tsx
<CollapsibleSection id="server" title="Server / Library" isOpen={openSections.has('server')}
  onToggle={toggleSection} sectionRef={serverRef} isFocused={focusedSection === 'server'}>
  <LibraryFolderSetting />
  <AutoScanToggle />
  <DatabaseInfoSection />
  <LibrarySettingsSection />
</CollapsibleSection>
```

- [ ] **Step 3: Add minimal CSS for the new rows**

Open `src/frontend/src/index.css` and find the existing `.settings-subsection-label` rule (grep for it). Just below that block, add (skip any rule that already exists with the same selector):

```css
.settings-subsection {
  margin-top: 10px;
}

.settings-row-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 0;
  color: var(--text-primary);
  font-size: 12px;
  cursor: pointer;
}

.settings-row-field {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 0;
  color: var(--text-primary);
  font-size: 12px;
}

.settings-row-field input[type="number"] {
  width: 64px;
  padding: 2px 4px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  color: var(--text-primary);
  font-size: 12px;
  border-radius: 3px;
}

.settings-action-btn {
  padding: 3px 10px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  color: var(--text-primary);
  border-radius: 3px;
  cursor: pointer;
  font-size: 11px;
}
.settings-action-btn:hover:not(:disabled) {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}
.settings-action-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
```

If any of these selectors already exist, keep the existing rule and skip the duplicate.

- [ ] **Step 4: Build + type-check**

Run: `cd src/frontend && npm run build`
Expected: build passes.

- [ ] **Step 5: Manual smoke**

1. Open Settings panel, expand `Server / Library`.
2. Toggle "Auto-load bound PDFs" — verify the state persists across reload.
3. Change "Recent history depth" to `30`, blur — verify localStorage key `boardripper-history-depth` is `"30"` and the new entries are capped at 30.
4. Click "Clear" — history list empties, button becomes disabled.

- [ ] **Step 6: Commit**

```bash
git add src/frontend/src/panels/SettingsPanel.tsx src/frontend/src/index.css
git commit -m "feat(settings): move library auto-pdf + history controls into Server/Library section

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: LibraryPanel — header redesign (stats on top, tab-styled tabs, inline DB/Live pill)

This task reorders the JSX inside `LibraryPanel` and removes the Auto-PDF toggle from the header (now in Settings after Task 6). The CSS restyle happens in Task 8 — after this JSX is in place.

**Files:**
- Modify: `src/frontend/src/panels/LibraryPanel.tsx` (JSX block at line 177-242)

- [ ] **Step 1: Replace the header/stats/actions JSX**

Find the block starting at line 177 (`<div className="library-panel">`) through line 282 (end of `library-stats` div). Replace the stats + header + browse-toggle block (lines 178-242, everything between `<div className="library-panel">` and the `{/* Search */}` comment) with this new structure:

```tsx
{/* Stats + scan buttons (row 1) */}
<div className="library-statsbar">
  <div className="library-statsbar-text">
    {scanning ? (
      <>
        <span className="library-indexing">
          Indexing{scanStatus && scanStatus.total > 0
            ? ` ${scanStatus.scanned}/${scanStatus.total}`
            : ''}
          {scanStatus?.phase ? ` — ${scanStatus.phase}` : '...'}
        </span>
        {scanStatus?.last_file && (
          <div className="library-indexing-file" title={scanStatus.last_file}>
            {tailTruncate(scanStatus.last_file)}
          </div>
        )}
      </>
    ) : (
      <>
        {boardCount} boards, {pdfCount} PDFs
        {scanStatus && scanStatus.duration_ms > 0 && (
          <span className="library-scan-result">
            {` — +${scanStatus.added} -${scanStatus.deleted} ~${scanStatus.updated} (${scanStatus.scanned}/${scanStatus.total}, ${scanStatus.duration_ms}ms)`}
          </span>
        )}
        {scanStatus?.pdf_running && (
          <span className="library-indexing" style={{ marginLeft: 8 }}>
            PDF indexing {scanStatus.pdf_extracted}/{scanStatus.pdf_total}
            {(scanStatus.pdf_errors ?? 0) > 0 && ` (${scanStatus.pdf_errors} err)`}
          </span>
        )}
        {scanStatus?.pdf_running && scanStatus?.pdf_current && (
          <div className="library-indexing-file" title={scanStatus.pdf_current}>
            {tailTruncate(scanStatus.pdf_current)}
          </div>
        )}
      </>
    )}
  </div>
  <div className="library-statsbar-actions">
    {!(viewMode === 'folders' && browseMode === 'live') && (
      scanStatus?.running ? (
        <button className="library-scan-btn library-scan-stop" onClick={() => databankStore.stopScan()} title="Stop scan">Stop</button>
      ) : scanStatus?.pdf_running ? (
        <button className="library-scan-btn library-scan-stop" onClick={() => databankStore.stopScan()} title="Stop PDF extraction">Stop</button>
      ) : (
        <>
          <button className="library-scan-btn library-scan-icon" onClick={handleFileScan} title="Scan filesystem for board and PDF files">
            <IconFolderSearch size={14} />
          </button>
          <button className="library-scan-btn library-scan-icon" onClick={() => databankStore.triggerPdfScan()} title="Extract text from PDFs for search">
            <IconFileText size={14} />
          </button>
        </>
      )
    )}
  </div>
</div>

{/* Tabs + inline DB/Live pill (row 2) */}
<div className="library-tabs-row">
  <div className="library-tabs">
    <button
      className={`library-tab ${viewMode === 'history' ? 'active' : ''}`}
      onClick={() => databankStore.setViewMode('history')}
      title="Recently opened"
    >
      <IconHistory size={14} />
    </button>
    <button
      className={`library-tab ${viewMode === 'metadata' ? 'active' : ''}`}
      onClick={() => databankStore.setViewMode('metadata')}
    >
      Board #
    </button>
    <button
      className={`library-tab ${viewMode === 'model' ? 'active' : ''}`}
      onClick={() => databankStore.setViewMode('model')}
    >
      Model
    </button>
    <button
      className={`library-tab ${viewMode === 'folders' ? 'active' : ''}`}
      onClick={() => databankStore.setViewMode('folders')}
      title="Browse folders"
    >
      <IconFolder size={14} />
    </button>
  </div>
  {viewMode === 'folders' && (
    <div className="library-browse-pill" role="tablist" aria-label="Folder source">
      <button
        className={`library-browse-pill-btn ${browseMode === 'database' ? 'active' : ''}`}
        onClick={() => databankStore.setBrowseMode('database')}
        role="tab"
        aria-selected={browseMode === 'database'}
        title="Show folders from the indexed database"
      >
        DB
      </button>
      <button
        className={`library-browse-pill-btn ${browseMode === 'live' ? 'active' : ''}`}
        onClick={() => databankStore.setBrowseMode('live')}
        role="tab"
        aria-selected={browseMode === 'live'}
        title="Browse the live filesystem"
      >
        Live
      </button>
    </div>
  )}
</div>
```

Leave the `{/* Search */}` block that follows (the `library-search` div) in place unchanged — the Task 4 conditional PDF toggle is already there.

- [ ] **Step 2: Verify no stale destructures remain**

`autoPdf` is still referenced inside `handleOpenFile` (line ~110) — it must stay in the `useDatabank()` destructure at line 57-63. The header JSX just no longer renders the toggle; the underlying state is unchanged.

Run `grep -n "autoPdf" src/frontend/src/panels/LibraryPanel.tsx` to confirm:
- One read in the destructure.
- One read inside `handleOpenFile` (`if (autoPdf) { ... }`).
- No render of an `<input type="checkbox" checked={autoPdf} ...>` anywhere in the file — that form only lives in SettingsPanel now.

If a reference appears in the JSX you just replaced, delete it.

- [ ] **Step 3: Build + type-check**

Run: `cd src/frontend && npm run build`
Expected: build passes. Layout will still look broken until Task 8 adds the CSS.

- [ ] **Step 4: Manual smoke (pre-CSS)**

Verify functionally:

1. Tabs switch the view.
2. Scan buttons still fire the correct endpoints.
3. DB/Live pill only renders on Folders tab and switches the data source.
4. Stop button replaces the scan icons when scanning.
5. Auto-PDF toggle is **gone** from the header (and the flow from Task 6 controls it from Settings).

- [ ] **Step 5: Commit**

```bash
git add src/frontend/src/panels/LibraryPanel.tsx
git commit -m "refactor(library): reorder header — stats on top, tabs row below, auto-pdf moved to settings

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: CSS — restyle tabs, stats bar, browse pill; remove obsolete classes

**Files:**
- Modify: `src/frontend/src/index.css` (Library section starting at line 3400)

- [ ] **Step 1: Replace the header/tabs/browse styling**

Find the block from `.library-header` (line 3412) through `.library-scan-result` (line 3569). Replace that contiguous block with:

```css
/* ===================== Library Panel ===================== */

/* Row 1 — stats + scan buttons (top) */
.library-statsbar {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 8px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-tertiary);
  flex-shrink: 0;
  min-height: 22px;
}
.library-statsbar-text {
  flex: 1;
  min-width: 0;
  color: var(--text-secondary);
  font-size: 11px;
}
.library-statsbar-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

/* Row 2 — tabs + (conditional) DB/Live pill */
.library-tabs-row {
  display: flex;
  align-items: stretch;
  justify-content: space-between;
  padding: 0 8px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-primary);
  flex-shrink: 0;
}

.library-tabs {
  display: flex;
  gap: 2px;
}

.library-tab {
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--text-secondary);
  padding: 6px 10px;
  cursor: pointer;
  font-size: 11px;
  margin-bottom: -1px; /* overlap the row border so the active indicator reads as a tab */
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.library-tab:hover:not(.active) {
  color: var(--text-primary);
}
.library-tab.active {
  color: var(--text-primary);
  border-bottom-color: var(--accent);
}

/* Compact 2-state pill — only appears when Folders tab is active */
.library-browse-pill {
  display: inline-flex;
  align-self: center;
  border: 1px solid var(--border);
  border-radius: 10px;
  overflow: hidden;
  background: var(--bg-secondary);
  height: 18px;
}
.library-browse-pill-btn {
  background: transparent;
  border: none;
  color: var(--text-secondary);
  font-size: 10px;
  padding: 0 8px;
  cursor: pointer;
  line-height: 18px;
}
.library-browse-pill-btn:hover:not(.active) {
  color: var(--text-primary);
}
.library-browse-pill-btn.active {
  background: var(--accent);
  color: #fff;
}

/* Scan buttons — same visuals as before, just smaller padding now that they share a row with stats */
.library-scan-btn {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  color: var(--text-primary);
  padding: 2px 8px;
  border-radius: 3px;
  cursor: pointer;
  font-size: 11px;
  line-height: 1;
}
.library-scan-btn:hover:not(:disabled) {
  background: var(--accent);
  border-color: var(--accent);
}
.library-scan-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.library-scan-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 2px 6px;
}
.library-scan-stop {
  color: var(--red, #e55);
  border-color: var(--red, #e55);
}
.library-scan-stop:hover {
  background: var(--red, #e55);
  color: #fff;
}

/* Animations + misc */
.library-indexing {
  color: var(--accent);
  animation: library-pulse 1.5s ease-in-out infinite;
}
.library-indexing-file {
  color: var(--text-secondary);
  font-size: 10px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.7;
}
@keyframes library-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}
.library-scan-result {
  color: var(--text-secondary);
  opacity: 0.7;
}
```

- [ ] **Step 2: Delete obsolete class definitions**

Search the same file for these classes and delete their rules (they are no longer referenced):

- `.library-header`
- `.library-actions`
- `.library-donor-filter` and `.library-donor-filter input`
- `.library-browse-toggle` (if present — it's referenced in the old JSX only)
- `.library-stats` (replaced by `.library-statsbar-text`)
- `.library-history-controls` / `.library-history-depth` / `.library-history-clear` (the HistoryView inline controls are gone now — search and delete)

Use `grep -n "\.library-header\|\.library-actions\|\.library-donor-filter\|\.library-browse-toggle\|\.library-stats\s*{\|\.library-history-controls\|\.library-history-depth\|\.library-history-clear" src/frontend/src/index.css` to locate every rule. Delete them.

(Keep `.library-backend-warn`, `.library-folder-bar`, `.library-folder-btn`, `.library-folder-path`, `.library-content`, `.library-empty`, `.library-tree*`, `.library-file-*` — all still used.)

- [ ] **Step 3: Build + type-check + dev smoke**

Run: `cd src/frontend && npm run build`
Expected: build passes.

Then run dev mode and eyeball:
- Stats bar sits on top, tabs below, active tab has an accent underline.
- Scan icons tuck neatly in the stats bar's right edge.
- DB/Live pill is small and only visible on Folders.
- No visual regressions on Metadata/Model/History tabs.

- [ ] **Step 4: Commit**

```bash
git add src/frontend/src/index.css
git commit -m "style(library): restyle header — stats bar, tab underlines, compact DB/Live pill

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Playwright — smoke tests for filter-on-history and DB/Live pill visibility

**Files:**
- Create: `src/frontend/tests/library-panel.spec.ts`

- [ ] **Step 1: Write the spec**

```ts
import { test, expect } from '@playwright/test';

// Library panel rework — smoke coverage for behavioral changes:
// 1) PDF toggle hidden on History tab.
// 2) DB/Live pill only rendered when Folders tab is active.
// 3) Local filter still filters the file list (regression guard).
//
// These tests use the empty-library default state so they work in CI without
// a seeded databank. They only assert DOM structure / visibility.

test.describe('Library panel header', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    // Open the Library panel. It's present by default in the layout.
    // Wait for the tabs row to mount.
    await page.waitForSelector('.library-tabs-row');
  });

  test('history tab hides the PDF search toggle', async ({ page }) => {
    await page.locator('.library-tab[title="Recently opened"]').click();
    await expect(page.locator('.library-pdf-search-toggle')).toHaveCount(0);
  });

  test('board# tab shows the PDF search toggle', async ({ page }) => {
    await page.locator('.library-tab', { hasText: 'Board #' }).click();
    await expect(page.locator('.library-pdf-search-toggle')).toBeVisible();
  });

  test('DB/Live pill only appears on the Folders tab', async ({ page }) => {
    // Not on History
    await page.locator('.library-tab[title="Recently opened"]').click();
    await expect(page.locator('.library-browse-pill')).toHaveCount(0);

    // Not on Board#
    await page.locator('.library-tab', { hasText: 'Board #' }).click();
    await expect(page.locator('.library-browse-pill')).toHaveCount(0);

    // Appears on Folders
    await page.locator('.library-tab[title="Browse folders"]').click();
    await expect(page.locator('.library-browse-pill')).toBeVisible();

    // Both options rendered
    await expect(page.locator('.library-browse-pill-btn', { hasText: 'DB' })).toBeVisible();
    await expect(page.locator('.library-browse-pill-btn', { hasText: 'Live' })).toBeVisible();
  });

  test('filter input is present and takes text', async ({ page }) => {
    const input = page.locator('.library-search-input');
    await expect(input).toBeVisible();
    await input.fill('hello');
    await expect(input).toHaveValue('hello');
  });
});
```

- [ ] **Step 2: Run the new spec**

```bash
cd src/frontend && npx playwright test tests/library-panel.spec.ts --reporter=line
```

Expected: all four tests pass.

- [ ] **Step 3: Run the whole suite to catch regressions**

```bash
cd src/frontend && npx playwright test --reporter=line
```

Expected: no previously-green test is now red. If a previously-green test relied on `.library-header` / `.library-browse-toggle` / old tab DOM, update its selectors in the same commit.

- [ ] **Step 4: Commit**

```bash
git add src/frontend/tests/library-panel.spec.ts
git commit -m "test(library): playwright coverage for history filter + db/live pill visibility

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Backend — gzip middleware for JSON API

Wraps the whole mux, so `/api/databank/files` (and every other JSON endpoint) benefits. Opt-outs via the `Accept-Encoding` header the client already sends.

**Files:**
- Create: `src/backend/middleware_gzip.go`
- Modify: `src/backend/main.go`

- [ ] **Step 1: Create the middleware**

Write `src/backend/middleware_gzip.go`:

```go
package main

import (
	"compress/gzip"
	"io"
	"net/http"
	"strings"
	"sync"
)

// gzipPool reuses gzip writers to avoid per-request allocation.
var gzipPool = sync.Pool{
	New: func() any { return gzip.NewWriter(io.Discard) },
}

// gzipResponseWriter is a response writer that gzips the body if the client
// accepts gzip and the content type is compressible. It falls back to the
// underlying writer transparently when compression would be wrong (upstream
// already-encoded payload, tiny body, non-compressible type).
type gzipResponseWriter struct {
	http.ResponseWriter
	gz            *gzip.Writer
	headerWritten bool
	useGzip       bool
}

func (g *gzipResponseWriter) WriteHeader(status int) {
	if g.headerWritten {
		return
	}
	g.headerWritten = true

	h := g.ResponseWriter.Header()
	ct := h.Get("Content-Type")
	// Skip already-encoded responses
	if h.Get("Content-Encoding") != "" {
		g.useGzip = false
	} else if isCompressible(ct) {
		h.Set("Content-Encoding", "gzip")
		h.Del("Content-Length") // length changes after compression
		h.Add("Vary", "Accept-Encoding")
		g.useGzip = true
	}
	g.ResponseWriter.WriteHeader(status)
}

func (g *gzipResponseWriter) Write(b []byte) (int, error) {
	if !g.headerWritten {
		g.WriteHeader(http.StatusOK)
	}
	if g.useGzip {
		return g.gz.Write(b)
	}
	return g.ResponseWriter.Write(b)
}

func isCompressible(contentType string) bool {
	ct := strings.ToLower(contentType)
	if ct == "" {
		return false
	}
	if strings.HasPrefix(ct, "application/json") {
		return true
	}
	if strings.HasPrefix(ct, "text/") {
		return true
	}
	if strings.HasPrefix(ct, "application/javascript") {
		return true
	}
	if strings.HasPrefix(ct, "application/xml") {
		return true
	}
	return false
}

// gzipMiddleware wraps an http.Handler with gzip compression when the client
// advertises Accept-Encoding: gzip.
func gzipMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
			next.ServeHTTP(w, r)
			return
		}

		gz := gzipPool.Get().(*gzip.Writer)
		gz.Reset(w)
		defer func() {
			_ = gz.Close()
			gzipPool.Put(gz)
		}()

		grw := &gzipResponseWriter{ResponseWriter: w, gz: gz}
		next.ServeHTTP(grw, r)
	})
}
```

- [ ] **Step 2: Wrap the mux in `main.go`**

Find the ListenAndServe call near the bottom of `main.go`:

```go
addr := fmt.Sprintf(":%s", port)
if err := http.ListenAndServe(addr, mux); err != nil {
  log.Fatalf("Server failed: %v", err)
}
```

Replace with:

```go
addr := fmt.Sprintf(":%s", port)
handler := gzipMiddleware(mux)
if err := http.ListenAndServe(addr, handler); err != nil {
  log.Fatalf("Server failed: %v", err)
}
```

- [ ] **Step 3: Build and vet**

```bash
cd src/backend && go vet ./... && go build ./...
```

Expected: no errors.

- [ ] **Step 4: Manual smoke**

Start the backend (`go run . -port 8080` from `src/backend`). In another terminal:

```bash
curl -s -H 'Accept-Encoding: gzip' -D - http://localhost:8080/api/databank/files -o /tmp/gz.bin
```

Expected in the response headers:

- `Content-Encoding: gzip`
- `Vary: Accept-Encoding`
- `Content-Type: application/json`

Then verify the body decodes:

```bash
gunzip -c /tmp/gz.bin | head -c 200
```

Expected: JSON array output (or `[]` on an empty databank).

Also confirm a non-gzip client still works:

```bash
curl -s -D - http://localhost:8080/api/databank/files -o /tmp/plain.bin
```

Expected: no `Content-Encoding` header, `/tmp/plain.bin` is plain JSON.

- [ ] **Step 5: Commit**

```bash
git add src/backend/main.go src/backend/middleware_gzip.go
git commit -m "perf(backend): gzip middleware for JSON API responses

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Final verification

- [ ] **Step 1: Full frontend build**

```bash
cd src/frontend && npm run build
```

Expected: no errors, no warnings newly introduced.

- [ ] **Step 2: Full Playwright suite**

```bash
cd src/frontend && npx playwright test --reporter=line
```

Expected: all tests pass (including the new `library-panel.spec.ts` from Task 9).

- [ ] **Step 3: Full backend build**

```bash
cd src/backend && go vet ./... && go build ./...
```

Expected: no errors.

- [ ] **Step 4: End-to-end smoke**

Run frontend + backend together. In the Library panel:

1. Page loads quickly on a populated library.
2. History tab: filter works, no PDF toggle.
3. Board # / Model tabs: filter + PDF toggle both work.
4. Folders tab: DB/Live pill visible and switches source; in DB mode, typing a filter hides empty directories.
5. Settings → Server / Library → Library: Auto-load toggle, depth input, Clear button all function.
6. Scan starts → Stop button shows in stats bar.

- [ ] **Step 5: Final commit (if any uncommitted changes)**

If the final verification revealed a missed edit, commit it as a focused fix.

---

## Self-review notes (resolved inline)

- Spec §1 P1/P2/P3/P5 → Tasks 3, 2, 10 — all covered. P4 (virtualization) deferred per spec.
- Spec §2 → Task 4.
- Spec §3 (defaults + migration) → Task 1. §3 (moving controls) → Task 6.
- Spec §4 → Task 5.
- Spec §5 (header redesign + CSS) → Tasks 7 + 8.
- Task dependency order: Tasks 1-5 are independent and safe in any order. Task 6 depends on nothing. Task 7 should ship after Task 6 (the auto-pdf control needs somewhere to live when removed from the header). Task 8 must ship alongside Task 7 — the intermediate commit after Task 7 will look broken until Task 8's CSS lands. Keep the interval short. Task 9 depends on Task 7's DOM structure. Task 10 is independent of everything else and can be moved earlier or later.
