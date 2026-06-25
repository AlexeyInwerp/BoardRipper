# Session Restore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After a page reload or post-update reload, prompt the user to reopen the boards + PDFs that were open, or discard them.

**Architecture:** A `session-store` continuously mirrors the open set (boards + PDFs) to `localStorage['boardripper-session']` (debounced, via store subscriptions + a `beforeunload` flush). On boot, if the saved session is non-empty, `<SessionRestorePrompt>` (mounted from `App.tsx`) asks **Reopen** / **Discard** — never auto-restoring, so a hang-causing board can't re-hang. Reopen resolves each entry: databank re-fetch (dropped files live in `incoming/`) → `loadFile`/`pdfStore.loadFile`, with the IndexedDB board cache as a board-only fallback (`boardStore.loadFromCache`).

**Tech Stack:** React 19 + TypeScript (strict), Vite, Playwright. Stores extend a shared `Emitter` (`store/emitter.ts`: `subscribe(listener): () => void`, `notify()`).

Spec: [docs/specs/2026-06-25-session-restore-design.md](../specs/2026-06-25-session-restore-design.md)

## Global Constraints

- **TypeScript strict** — no `any`; everything typed.
- **No frontend unit-test runner exists** (Playwright only). Each implementation task is verified with `cd src/frontend && npx tsc --noEmit && npm run build` (both clean); the feature is proven end-to-end by the Playwright spec in the final task. Do NOT invent a vitest harness.
- **Never auto-restore** — the prompt always appears first; nothing loads until the user chooses. This is the load-bearing safety property (reload-because-it-hung).
- **Scoped loggers only** (`store/log-store.ts` → `log.ui.*` / `log.cache.*`); never `console.log`.
- **One localStorage key:** `boardripper-session`. No backend changes. No board/PDF view-state restore, no PDF re-binding (out of scope per spec).
- **Capture is best-effort and continuous** (debounced ~500 ms on store changes + a `beforeunload` flush) so a hard hang/crash still leaves a record.

## File Structure

**Frontend (`src/frontend/src/`):**
- `store/session-store.ts` — *create*: owns `boardripper-session`; capture/persist (subscribe + debounce + `beforeunload`), `readSession`, `clearSession`, `restoreSession`, `initSessionStore`.
- `components/SessionRestorePrompt.tsx` — *create*: the boot modal (Reopen / Discard).
- `store/board-store.ts` — *modify*: add `openBoardEntries()`; add `loadFromCache(...)` (extract `makeTab` + `applyCachedBoard` from `loadFile`).
- `store/pdf-store.ts` — *modify*: add `openPdfEntries()`.
- `store/databank-store.ts` — *modify*: add `findFileByName(...)`.
- `App.tsx` — *modify*: mount `<SessionRestorePrompt/>`.
- `main.tsx` — *modify*: call `initSessionStore()` at boot.
- `tests/session-restore.spec.ts` — *create*: Playwright e2e.

---

## Task 1: Capture getters on board-store + pdf-store

**Files:**
- Modify: `src/frontend/src/store/board-store.ts` (near the getters, after `get activeTab()` ~line 538)
- Modify: `src/frontend/src/store/pdf-store.ts` (near the doc getters ~line 540)

**Interfaces:**
- Produces:
  - `boardStore.openBoardEntries(): { fileName: string; fileSize: number; fileLastModified: number; active: boolean }[]`
  - `pdfStore.openPdfEntries(): { fileName: string; fileSize: number; fileLastModified: number; fileId?: number }[]`

- [ ] **Step 1: Add `openBoardEntries` to board-store**

In `board-store.ts`, after `get activeTab(): BoardTab | null { … }`:

```typescript
  /** Identity of every open board tab, for session persistence. fileSize /
   *  lastModified come from the in-memory File when present, else from the
   *  cacheKey (`${fileName}:${size}:${lastModified}`). */
  openBoardEntries(): { fileName: string; fileSize: number; fileLastModified: number; active: boolean }[] {
    return this._tabs.map(t => {
      const f = this._openFiles.get(t.fileName);
      let size = f?.size ?? 0;
      let modified = f?.lastModified ?? 0;
      if ((!size || !modified) && t.cacheKey) {
        const lastColon = t.cacheKey.lastIndexOf(':');
        const prevColon = t.cacheKey.lastIndexOf(':', lastColon - 1);
        if (lastColon > 0 && prevColon > 0) {
          size = size || Number(t.cacheKey.slice(prevColon + 1, lastColon)) || 0;
          modified = modified || Number(t.cacheKey.slice(lastColon + 1)) || 0;
        }
      }
      return { fileName: t.fileName, fileSize: size, fileLastModified: modified, active: t.id === this._activeTabId };
    });
  }
```

- [ ] **Step 2: Add `openPdfEntries` to pdf-store**

In `pdf-store.ts`, near the `getDoc*` getters:

```typescript
  /** Identity of every open PDF document, for session persistence. */
  openPdfEntries(): { fileName: string; fileSize: number; fileLastModified: number; fileId?: number }[] {
    return [...this._documents.values()].map(d => ({
      fileName: d.fileName,
      fileSize: d.fileSize,
      fileLastModified: d.fileLastModified,
      fileId: d.fileId,
    }));
  }
```

- [ ] **Step 3: Verify build**

Run: `cd src/frontend && npx tsc --noEmit && npm run build`
Expected: clean (no type errors).

- [ ] **Step 4: Commit**

```bash
git add src/frontend/src/store/board-store.ts src/frontend/src/store/pdf-store.ts
git commit -m "feat(session): capture getters openBoardEntries/openPdfEntries"
```

---

## Task 2: `databankStore.findFileByName`

**Files:**
- Modify: `src/frontend/src/store/databank-store.ts` (near `fileById` ~line 337)

**Interfaces:**
- Consumes: `this._files: DatabankFile[]` (already private state; `get files()` exposes it). `DatabankFile` has `{ id, path, filename, file_type, size, mod_time, … }`.
- Produces: `databankStore.findFileByName(fileName: string, fileSize?: number): DatabankFile | null`

- [ ] **Step 1: Add the resolver**

In `databank-store.ts`, after `fileById(id: number): DatabankFile | undefined { … }`:

```typescript
  /** Find a loaded databank file by exact filename, disambiguating same-name
   *  files by size when provided. Used by session restore to resolve a file
   *  (incl. a dropped one now living under incoming/) back to a fetchable entry. */
  findFileByName(fileName: string, fileSize?: number): DatabankFile | null {
    const matches = this._files.filter(f => f.filename === fileName);
    if (matches.length === 0) return null;
    if (fileSize != null) {
      const exact = matches.find(f => f.size === fileSize);
      if (exact) return exact;
    }
    return matches[0];
  }
```

- [ ] **Step 2: Verify build**

Run: `cd src/frontend && npx tsc --noEmit && npm run build`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/frontend/src/store/databank-store.ts
git commit -m "feat(session): databankStore.findFileByName resolver"
```

---

## Task 3: `boardStore.loadFromCache` (extract `makeTab` + `applyCachedBoard`)

The existing `loadFile` creates a `BoardTab` from a template and, on a cache hit, applies the cached `BoardData`. To open a board from the cache **without an original `File`** (the Electron-drop / upload-failed / file-deleted fallback), extract two private helpers and reuse them. This avoids duplicating the tab template or the cache-application block.

**Files:**
- Modify: `src/frontend/src/store/board-store.ts` (`loadFile` ~lines 760–866; add helpers + `loadFromCache`)

**Interfaces:**
- Consumes: `boardCache.get(fileName, fileSize, lastModified)`, `boardCache.makeCacheKey(...)`, existing free functions used by the cache-hit block (`flagMechanicalParts`, `invalidateDerivedBoard`, `applyBoardFilters`, `flipAxisForRotation`, `getFormat`, `createLayerStates`), `this.autoRotation`, `this.autoBindBoard`, `this.onTabCreated`, `loadViewPrefs`, `nextTabId`.
- Produces: `boardStore.loadFromCache(fileName: string, fileSize: number, lastModified: number): Promise<boolean>` — opens a tab from the IndexedDB cache; returns `false` if there is no usable cache entry.

- [ ] **Step 1: Extract `makeTab` — the tab template + register**

In `board-store.ts`, add a private method (place it just above `loadFile`). Copy the tab object literal **verbatim** from `loadFile` (the `const tab: BoardTab = { … }` block, currently lines ~764–806), substituting `file.name` → `fileName`:

```typescript
  /** Build a fresh BoardTab with default view state, register it as the active
   *  tab, and notify. Shared by loadFile and loadFromCache. */
  private makeTab(fileName: string): BoardTab {
    const id = nextTabId++;
    const vp = loadViewPrefs();
    const tab: BoardTab = {
      id,
      fileName,
      board: null,
      selection: { ...emptySelection, adjacentNets: new Set<string>() },
      showTop: true,
      showBottom: false,
      butterfly: false,
      searchQuery: '',
      rotation: 0,
      mirrorX: false,
      mirrorY: false,
      flipAxis: 'x',
      netLineMode: vp.netLineMode,
      connectionHighlight: false,
      dimMode: vp.dimMode,
      showHoverInfo: vp.showHoverInfo,
      followPdf: vp.followPdf,
      showTraces: true,
      showComponents: true,
      showVias: false,
      showSilkscreen: true,
      showPads: true,
      showCopperDrops: false,
      showSurfaces: false,
      showPins: true,
      showOutlines: true,
      showLabels: true,
      ghostMode: 'ghosts',
      layerStates: [],
      selectedLayerIndex: null,
      fixatedLayerIndex: null,
      pdfFileNames: [],
      cacheKey: '',
      hideGhosts: false,
      swappedGhostPairs: new Set<string>(),
      showBomAlternates: false,
      bomClusterSelections: new Map<string, string>(),
      partOverrides: new Map(),
      foldMode: 'suggested',
      selectedBoardIndex: null,
      searchSelectionActive: false,
    };
    this._tabs.push(tab);
    this._activeTabId = id;
    this.notify();
    return tab;
  }
```

Then in `loadFile`, **replace** the inline `const id = nextTabId++; const vp = loadViewPrefs(); const tab: BoardTab = { … }; this._tabs.push(tab); this._activeTabId = id; this.notify();` block (lines ~762–810) with:

```typescript
      const tab = this.makeTab(file.name);
      const id = tab.id;
```

(Keep everything after it — the `try { … }`, `loadProgressStore.start`, `this._openFiles.set`, the cache `get`, etc. — unchanged for now.)

- [ ] **Step 2: Extract `applyCachedBoard` — the cache-hit application**

Add a private method. Copy the cache-hit body **verbatim** from `loadFile` (currently lines ~822–857: from `flagMechanicalParts(cached.parts);` through `this.autoBindBoard(file.name);`), substituting `file.name`→`fileName`, `file.size`→`fileSize`, `file.lastModified`→`lastModified`, and **dropping** the `void this.applySavedViewPrefs(tab, file);` line (it needs a `File`; loadFile keeps it in its own caller):

```typescript
  /** Apply a cached BoardData onto a freshly-made tab (rotation, sides, layers,
   *  filters, parser-note toasts, auto-bind). Shared by loadFile's cache-hit
   *  path and loadFromCache. Does NOT touch _openFiles or applySavedViewPrefs. */
  private applyCachedBoard(tab: BoardTab, cached: BoardData, fileName: string, fileSize: number, lastModified: number): void {
    flagMechanicalParts(cached.parts);
    tab.board = cached;
    invalidateDerivedBoard(tab);
    applyBoardFilters(tab);
    tab.cacheKey = boardCache.makeCacheKey(fileName, fileSize, lastModified);
    tab.rotation = this.autoRotation(cached);
    tab.flipAxis = flipAxisForRotation(tab.rotation);
    if (cached.flipAxis) tab.flipAxis = cached.flipAxis;
    const cachedFmt = getFormat(cached.format);
    const wantsBottomOnOpen = cachedFmt?.swapSides || cached.primarySide === 'bottom';
    if (wantsBottomOnOpen) {
      tab.showTop = false;
      tab.showBottom = true;
    }
    if (cached.layerNames) tab.layerStates = createLayerStates(cached.layerNames);
    const vp = loadViewPrefs();
    if (vp.defaultButterfly && !(cached.layerNames && cached.layerNames.length > 0)) {
      tab.butterfly = true;
      tab.showTop = true;
      tab.showBottom = true;
    }
    if (cached.parserNotes) {
      for (const note of cached.parserNotes) this.addToast(note, 'info');
    }
    this.autoBindBoard(fileName);
  }
```

Then in `loadFile`'s cache-hit branch, **replace** that same body (the `flagMechanicalParts(...)` … `this.autoBindBoard(file.name);` span, but NOT the `applySavedViewPrefs`, `onTabCreated`, `notify`, `return` lines) with:

```typescript
          this.applyCachedBoard(tab, cached, file.name, file.size, file.lastModified);
          void this.applySavedViewPrefs(tab, file);
```

(Leave the surrounding `loadProgressStore.*`, `this.onTabCreated?.(id, file.name);`, `this.notify();`, `return;` lines in place.)

- [ ] **Step 3: Add `loadFromCache`**

Add the public method (place it just after `loadFile`):

```typescript
  /** Open a board tab directly from the IndexedDB cache, without an original
   *  File — used by session restore when a dropped board never reached the
   *  databank (Electron / upload failed / file removed). Re-parse is unavailable
   *  for such a tab until the user drags the file in again. Returns false if the
   *  cache has no current entry (parser-version checked). */
  async loadFromCache(fileName: string, fileSize: number, lastModified: number): Promise<boolean> {
    if (this._tabs.some(t => t.fileName === fileName)) return true; // already open
    const cached = await boardCache.get(fileName, fileSize, lastModified);
    if (!cached) return false;
    const tab = this.makeTab(fileName);
    this.applyCachedBoard(tab, cached, fileName, fileSize, lastModified);
    this.onTabCreated?.(tab.id, fileName);
    this.notify();
    return true;
  }
```

- [ ] **Step 4: Verify build**

Run: `cd src/frontend && npx tsc --noEmit && npm run build`
Expected: clean. (If `loadViewPrefs`, `emptySelection`, or any free function is reported undefined, it means the extraction moved a reference out of scope — they are module-level in `board-store.ts`, so confirm the helpers are methods on the same class.)

- [ ] **Step 5: Commit**

```bash
git add src/frontend/src/store/board-store.ts
git commit -m "feat(session): boardStore.loadFromCache (extract makeTab + applyCachedBoard)"
```

---

## Task 4: `session-store` — types + continuous capture/persist

**Files:**
- Create: `src/frontend/src/store/session-store.ts`

**Interfaces:**
- Consumes: `boardStore.openBoardEntries()`, `pdfStore.openPdfEntries()` (Task 1); `boardStore.subscribe`, `pdfStore.subscribe` (Emitter).
- Produces:
  - `interface SessionEntry { kind: 'board' | 'pdf'; fileName: string; fileSize: number; fileLastModified: number; fileId?: number; active?: boolean }`
  - `interface SavedSession { version: 1; savedAt: number; entries: SessionEntry[] }`
  - `readSession(): SavedSession | null`
  - `clearSession(): void`
  - `captureNow(): void` (exported for the `beforeunload` flush + tests)
  - `initSessionStore(): void` — wire subscriptions + `beforeunload` (idempotent)

- [ ] **Step 1: Create the store (capture half)**

Create `src/frontend/src/store/session-store.ts`:

```typescript
import { boardStore } from './board-store';
import { pdfStore } from './pdf-store';
import { log } from './log-store';

const SESSION_KEY = 'boardripper-session';
const DEBOUNCE_MS = 500;

export interface SessionEntry {
  kind: 'board' | 'pdf';
  fileName: string;
  fileSize: number;
  fileLastModified: number;
  fileId?: number;
  active?: boolean;
}
export interface SavedSession {
  version: 1;
  savedAt: number;
  entries: SessionEntry[];
}

/** Build the current open set from the board + PDF stores. */
function snapshot(): SessionEntry[] {
  const boards: SessionEntry[] = boardStore.openBoardEntries().map(b => ({
    kind: 'board',
    fileName: b.fileName,
    fileSize: b.fileSize,
    fileLastModified: b.fileLastModified,
    active: b.active || undefined,
  }));
  const pdfs: SessionEntry[] = pdfStore.openPdfEntries().map(p => ({
    kind: 'pdf',
    fileName: p.fileName,
    fileSize: p.fileSize,
    fileLastModified: p.fileLastModified,
    fileId: p.fileId,
  }));
  return [...boards, ...pdfs];
}

/** Write the current open set to localStorage immediately. */
export function captureNow(): void {
  try {
    const session: SavedSession = { version: 1, savedAt: Date.now(), entries: snapshot() };
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch (e) {
    log.cache?.warn('session: capture failed', e);
  }
}

export function readSession(): SavedSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as SavedSession;
    if (!s || s.version !== 1 || !Array.isArray(s.entries)) return null;
    return s;
  } catch {
    return null;
  }
}

export function clearSession(): void {
  try { localStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
}

let inited = false;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleCapture(): void {
  if (debounceTimer !== null) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => { debounceTimer = null; captureNow(); }, DEBOUNCE_MS);
}

/** Wire continuous capture: subscribe to board + PDF changes (debounced) and
 *  flush on beforeunload. Idempotent. Restore is driven separately by the
 *  SessionRestorePrompt, so initSessionStore does NOT auto-restore. */
export function initSessionStore(): void {
  if (inited) return;
  inited = true;
  boardStore.subscribe(scheduleCapture);
  pdfStore.subscribe(scheduleCapture);
  window.addEventListener('beforeunload', captureNow);
}
```

> Confirm `log.cache` exists (it's used across the stores). If the logger scope differs, use `log.ui`. Confirm the import path `./log-store`.

- [ ] **Step 2: Verify build**

Run: `cd src/frontend && npx tsc --noEmit && npm run build`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/frontend/src/store/session-store.ts
git commit -m "feat(session): session-store capture/persist (debounced subscribe + beforeunload)"
```

---

## Task 5: `session-store` — `restoreSession` resolver

**Files:**
- Modify: `src/frontend/src/store/session-store.ts`

**Interfaces:**
- Consumes: `databankStore.ensureLoaded()`, `databankStore.fileById(id)`, `databankStore.findFileByName(name, size)` (Task 2), `databankStore.fetchFileBuffer(file)`, `boardStore.loadFile(file)`, `boardStore.loadFromCache(name, size, mod)` (Task 3), `boardStore.activateTab`/`setActiveTab`, `boardStore.addToast`, `pdfStore.loadFile(file, fileId?)`.
- Produces: `restoreSession(session: SavedSession): Promise<void>`

- [ ] **Step 1: Confirm the board-tab activation API**

Run: `grep -n "setActiveTab\|activateTab\|set activeTab\|selectTab" src/frontend/src/store/board-store.ts | head`
Use whichever public method focuses a tab by `fileName` or `id`. The code below assumes `boardStore.activateByFileName(fileName: string)`; if it does not exist, focus via the existing API (e.g. find the tab id by `fileName` in `boardStore.tabs` and call the real activate method). Adjust the one call accordingly and note it in your report.

- [ ] **Step 2: Add `restoreSession`**

Append to `session-store.ts` (and add `databankStore` / `boardStore` already imported — add `import { databankStore } from './databank-store';`):

```typescript
import { databankStore } from './databank-store';

/** Reopen every entry in a saved session, then focus the previously-active
 *  board. Resolves databank-first (dropped files live under incoming/), with
 *  the IndexedDB board cache as a board-only fallback. Collects unavailable
 *  files into one summary toast. Never called automatically — the restore
 *  prompt invokes it on the user's explicit Reopen. */
export async function restoreSession(session: SavedSession): Promise<void> {
  await databankStore.ensureLoaded();
  const unavailable: string[] = [];
  let activeBoardName: string | null = null;

  for (const e of session.entries) {
    try {
      const dbFile =
        (e.fileId != null ? databankStore.fileById(e.fileId) : undefined) ??
        databankStore.findFileByName(e.fileName, e.fileSize) ??
        null;

      if (e.kind === 'board') {
        if (dbFile && dbFile.file_type === 'board') {
          const file = await databankStore.fetchFileBuffer(dbFile);
          await boardStore.loadFile(file);
        } else if (!(await boardStore.loadFromCache(e.fileName, e.fileSize, e.fileLastModified))) {
          unavailable.push(e.fileName);
          continue;
        }
        if (e.active) activeBoardName = e.fileName;
      } else {
        // pdf
        if (dbFile && dbFile.file_type === 'pdf') {
          const file = await databankStore.fetchFileBuffer(dbFile);
          await pdfStore.loadFile(file, dbFile.id);
        } else {
          unavailable.push(e.fileName); // local-drop PDF with no databank entry → no binary cache
        }
      }
    } catch (err) {
      log.ui?.warn(`session restore: ${e.fileName} failed`, err);
      unavailable.push(e.fileName);
    }
  }

  if (activeBoardName) {
    const tab = boardStore.tabs.find(t => t.fileName === activeBoardName);
    if (tab) boardStore.activateByFileName(activeBoardName); // ← per Step 1, use the real activate API
  }

  const restored = session.entries.length - unavailable.length;
  if (restored > 0 && unavailable.length === 0) {
    boardStore.addToast(`Reopened ${restored} item${restored > 1 ? 's' : ''} from your last session`, 'info');
  } else if (unavailable.length > 0) {
    boardStore.addToast(
      `Reopened ${restored} · ${unavailable.length} unavailable (re-drop): ${unavailable.slice(0, 3).join(', ')}${unavailable.length > 3 ? '…' : ''}`,
      'error',
    );
  }
}
```

> The `boardStore.activateByFileName(...)` call is a placeholder for the real activation API resolved in Step 1 — replace it with the actual method (and remove the unused `tab` lookup if the real API takes an id).

- [ ] **Step 3: Verify build**

Run: `cd src/frontend && npx tsc --noEmit && npm run build`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/frontend/src/store/session-store.ts
git commit -m "feat(session): restoreSession resolver (databank → loadFile, cache fallback, active tab)"
```

---

## Task 6: `SessionRestorePrompt` component + App/main wiring

**Files:**
- Create: `src/frontend/src/components/SessionRestorePrompt.tsx`
- Modify: `src/frontend/src/App.tsx` (mount the prompt beside the other overlays ~line 350–354)
- Modify: `src/frontend/src/main.tsx` (call `initSessionStore()` at boot)

**Interfaces:**
- Consumes: `readSession`, `clearSession`, `restoreSession`, `initSessionStore` (Tasks 4–5).
- Produces: `<SessionRestorePrompt />` (default-rendered; self-suppresses when no session).

- [ ] **Step 1: Create the component**

Create `src/frontend/src/components/SessionRestorePrompt.tsx`:

```tsx
import { useState } from 'react';
import { readSession, clearSession, restoreSession, type SavedSession } from '../store/session-store';

/** Boot prompt: if a previous session's boards/PDFs were open, ask whether to
 *  reopen or discard. Never auto-restores — so a board that hung the app last
 *  time can't re-hang on load (the user discards first). */
export function SessionRestorePrompt() {
  // Read once at mount: a non-empty saved session means we should ask.
  const [session, setSession] = useState<SavedSession | null>(() => {
    const s = readSession();
    return s && s.entries.length > 0 ? s : null;
  });
  const [busy, setBusy] = useState(false);

  if (!session) return null;

  const boards = session.entries.filter(e => e.kind === 'board').length;
  const pdfs = session.entries.filter(e => e.kind === 'pdf').length;
  const parts = [
    boards > 0 ? `${boards} board${boards > 1 ? 's' : ''}` : '',
    pdfs > 0 ? `${pdfs} PDF${pdfs > 1 ? 's' : ''}` : '',
  ].filter(Boolean).join(' and ');

  const onReopen = async () => {
    setBusy(true);
    try { await restoreSession(session); } finally { setSession(null); }
  };
  const onDiscard = () => { clearSession(); setSession(null); };

  return (
    <div className="session-restore-backdrop" role="dialog" aria-modal="true" data-testid="session-restore-prompt">
      <div className="session-restore-card">
        <div className="session-restore-title">Reopen your last session?</div>
        <div className="session-restore-body">{parts} were open.</div>
        <div className="session-restore-actions">
          <button className="session-restore-btn" data-testid="session-discard" onClick={onDiscard} disabled={busy}>
            Discard
          </button>
          <button className="session-restore-btn primary" data-testid="session-reopen" onClick={onReopen} disabled={busy}>
            {busy ? 'Reopening…' : 'Reopen'}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add minimal styles**

Append to `src/frontend/src/index.css` (reuse existing CSS vars; ≤ ~20 lines):

```css
.session-restore-backdrop { position: fixed; inset: 0; z-index: 10001; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,0.5); }
.session-restore-card { background: var(--bg-secondary); border: 1px solid var(--border); border-radius: 8px; padding: 18px 20px; min-width: 320px; box-shadow: 0 8px 32px rgba(0,0,0,0.5); }
.session-restore-title { font-weight: 600; font-size: 15px; margin-bottom: 6px; }
.session-restore-body { color: var(--text-secondary); font-size: 13px; margin-bottom: 14px; }
.session-restore-actions { display: flex; justify-content: flex-end; gap: 8px; }
.session-restore-btn { cursor: pointer; padding: 5px 14px; border: 1px solid var(--border); border-radius: 5px; background: var(--bg-primary); color: inherit; font-size: 13px; }
.session-restore-btn.primary { background: var(--accent); color: var(--accent-fg); border-color: var(--accent); }
.session-restore-btn:disabled { opacity: 0.6; cursor: default; }
```

> Match the CSS variables actually used in `index.css` (grep for `--accent-fg` / `--bg-primary`; substitute if a name differs).

- [ ] **Step 3: Mount in App.tsx**

In `App.tsx`, add the import near the other component imports and render the prompt beside `<WelcomeSetup />` (~line 354):

```tsx
import { SessionRestorePrompt } from './components/SessionRestorePrompt';
```
```tsx
      <WelcomeSetup />
      <SessionRestorePrompt />
```

- [ ] **Step 4: Init capture at boot (main.tsx)**

In `main.tsx`, after `startMcpBridgeIfEnabled();`:

```tsx
import { initSessionStore } from './store/session-store';
// …
initSessionStore();
```

- [ ] **Step 5: Verify build**

Run: `cd src/frontend && npx tsc --noEmit && npm run build`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/frontend/src/components/SessionRestorePrompt.tsx src/frontend/src/index.css src/frontend/src/App.tsx src/frontend/src/main.tsx
git commit -m "feat(session): SessionRestorePrompt modal + boot wiring"
```

---

## Task 7: Playwright e2e

**Files:**
- Create: `src/frontend/tests/session-restore.spec.ts`

**Interfaces:** consumes testids `session-restore-prompt`, `session-reopen`, `session-discard`.

- [ ] **Step 1: Identify the board/PDF open helper**

Run: `grep -rln "loadFiles\|setInputFiles\|fixtures\|openBoard\|\\.brd'\|\\.bvr'" src/frontend/tests/ | head`
Read the closest spec that opens a board (e.g. via the toolbar file input / drag-drop) and, if present, a PDF. Reuse its helper. Note the helper + a real fixture path for Step 2.

- [ ] **Step 2: Write the spec**

Create `src/frontend/tests/session-restore.spec.ts`. Replace `openBoardFixture` with the real helper from Step 1; the assertions are the contract:

```typescript
import { test, expect } from '@playwright/test';
// import { openBoardFixture } from './helpers'; // ← from Step 1

test('reload offers to reopen the previous session; Reopen restores the board', async ({ page }) => {
  await page.goto('/');
  // 1. Open a board (use the Step-1 helper / a real fixture under tests/fixtures).
  //    await openBoardFixture(page, 'tests/fixtures/<some>.bvr');
  // Give the debounced session capture (500ms) time to persist.
  await page.waitForTimeout(900);

  // 2. Reload — the prompt should appear with a geometry-checked modal.
  await page.reload();
  const prompt = page.getByTestId('session-restore-prompt');
  await expect(prompt).toBeVisible();
  const box = await prompt.boundingBox();
  expect(box).not.toBeNull();
  const vp = page.viewportSize()!;
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(vp.width + 1);

  // 3. Reopen → the board is back (a board tab is present).
  await page.getByTestId('session-reopen').click();
  await expect(page.getByTestId('session-restore-prompt')).toHaveCount(0);
  // Assert the board tab / canvas is present (use the selector the board-open helper asserts on).
});

test('Discard clears the session and reopens nothing', async ({ page }) => {
  await page.goto('/');
  // open a board, wait for capture, reload (as above)
  await page.waitForTimeout(900);
  await page.reload();
  await page.getByTestId('session-discard').click();
  await expect(page.getByTestId('session-restore-prompt')).toHaveCount(0);
  // Reload again — no prompt, because the session was cleared.
  await page.reload();
  await expect(page.getByTestId('session-restore-prompt')).toHaveCount(0);
});
```

> If the harness can't open a board without a live backend (databank), scope the spec to what's provable in Vite-only mode (the prompt's presence given a pre-seeded `localStorage['boardripper-session']` via `page.addInitScript`) and gate the full round-trip behind backend availability, documenting the gap in a top-of-file comment — do not fake a pass. The board-open round-trip can also be validated on the dev instance.

- [ ] **Step 3: Run the spec**

Run: `cd src/frontend && npx playwright test tests/session-restore.spec.ts`
Expected: PASS (or PASS with documented backend-gated skips). Headless Chromium's "No available adapters" WebGL warning is expected and unrelated.

- [ ] **Step 4: Commit**

```bash
git add src/frontend/tests/session-restore.spec.ts
git commit -m "test(session): e2e reload→reopen and reload→discard"
```

---

## Self-Review

**1. Spec coverage**

| Spec requirement | Task |
|---|---|
| Continuous persistence of open boards + PDFs | 4 (subscribe + debounce + beforeunload) |
| Capture identity (name/size/mod/fileId/active) | 1 (getters) + 4 (snapshot) |
| Restore: databank re-fetch (incl. incoming/) | 2 (findFileByName) + 5 (resolver) |
| Restore: IndexedDB board cache fallback | 3 (loadFromCache) + 5 |
| PDFs restore (databank/incoming); local-drop PDF unavailable | 5 |
| Prompt Reopen/Discard, never auto-restore | 6 (SessionRestorePrompt) |
| Re-focus the active board | 5 (active-tab activation) |
| Same flow for update + manual reload | implicit — capture is reload-cause-agnostic; prompt mounts on any boot (6) |
| Hang-safety (prompt before any load) | 6 (modal gates restore behind explicit click) |
| Unavailable files reported | 5 (summary toast) |
| Frontend-only, one localStorage key, no view-state/rebind | Global Constraints; Tasks 4–6 |

**2. Placeholder scan** — Two flagged confirm-and-adjust points (not silent gaps): the board-tab **activation API** (Task 5 Step 1 resolves the real method) and the Playwright **board-open helper + fixture** (Task 7 Step 1). Both are explicit verification steps. All code blocks are complete.

**3. Type consistency** — `SessionEntry`/`SavedSession` shapes identical across Tasks 4–6. `openBoardEntries()`/`openPdfEntries()` return types match `snapshot()`'s consumption (Task 1 ↔ 4). `loadFromCache(fileName, fileSize, lastModified): Promise<boolean>` consistent (Task 3 ↔ 5). `findFileByName(fileName, fileSize?)` consistent (Task 2 ↔ 5). `restoreSession(session: SavedSession)` consistent (Task 5 ↔ 6).

**4. Risk note** — Task 3 refactors the critical `loadFile` (extract `makeTab` + `applyCachedBoard`). It is the highest-risk task; the verbatim-copy instructions + `tsc`/`build` + the Task 7 e2e are the guard. If it proves unsafe, the databank restore path (Tasks 1–2, 4–6) still works for the common web case — `loadFromCache` is the only consumer of the extraction, so it could be deferred without blocking the rest.
