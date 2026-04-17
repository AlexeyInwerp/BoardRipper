# Donor Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a right-click "find component on donor board" submenu that auto-selects the matching refdes on the target tab, built on a shared `cross-target-search` module that also backs the existing global toolbar search.

**Architecture:** New pure-TS module `src/frontend/src/store/cross-target-search.ts` exposes `countInBoardTab`, `countInPdf`, `findInBoardTab`, `findInPdf`. `findInBoardTab` composes `boardStore.switchTab` + `boardStore.focusPart` (existing method that handles exact-refdes lookup, side flip, selection, and viewport focus-request) + `openBoardSearch`. `GlobalSearch` (Toolbar) is refactored to consume this module. `ContextMenu` grows a new "Board" section whose structure mirrors the existing "PDF" section 1:1.

**Tech Stack:** React 19, TypeScript strict, Vite 7, PixiJS v8 (not touched), Playwright for E2E.

**Spec:** [docs/superpowers/specs/2026-04-17-donor-search-design.md](../specs/2026-04-17-donor-search-design.md)

---

## Notes for the implementing engineer

- The project has **no Vitest/Jest** — all tests are Playwright E2E under `src/frontend/tests/`. Tasks that introduce logic rely on (a) `tsc -b` build success for type correctness, (b) manual smoke in dev server for UI changes, and (c) one Playwright spec at the end for integration coverage. TDD shape is adapted to this reality: tests are written before the UI wiring they exercise, but behind the module primitives that they call.
- `boardStore.focusPart(name: string)` at [src/frontend/src/store/board-store.ts:1021-1044](../../src/frontend/src/store/board-store.ts#L1021-L1044) is the workhorse: case-insensitive exact-equality refdes lookup, auto-flips to the correct side, sets `_focusRequest`, and `BoardRenderer` consumes the focus request to recenter the viewport. Do not reimplement any of this.
- `openBoardSearch(query, tabId?)` at [src/frontend/src/panels/BoardViewerPanel.tsx:16-24](../../src/frontend/src/panels/BoardViewerPanel.tsx#L16-L24) switches the tab (idempotent, guarded in `board-store.ts:548`), sets the sidebar search query, and opens the search sidebar.
- `pdfStore.countTextMatches(fileName, lowercasedTerm)` already exists and is what `GlobalSearch.runSearch` uses today — we just rename/delegate.
- Dev-only `window` hooks follow the established pattern at [src/frontend/src/store/pdf-store.ts:1466-1469](../../src/frontend/src/store/pdf-store.ts#L1466-L1469):
  ```ts
  if (typeof window !== 'undefined' && import.meta.env.DEV) {
    (window as any).__pdfStore = pdfStore;
  }
  ```
- Dev server: run `npm run dev` inside `src/frontend/` — port 5173 by default (Vite), proxied/opened from the project-root `docker-compose.yml` in production but direct for dev.
- Build: `cd src/frontend && npm run build` (runs `tsc -b` then `vite build`).
- Playwright: `cd src/frontend && npm run test -- donor-search` runs only the new spec.

---

## File Structure

| File | Role |
| --- | --- |
| `src/frontend/src/store/cross-target-search.ts` | **New.** Pure functions — `countInBoardTab`, `countInPdf`, `findInBoardTab`, `findInPdf`. No React, no UI. |
| `src/frontend/src/store/board-store.ts` | **Modified tail.** Expose `boardStore` on `window.__boardStore` in DEV mode (test hook). |
| `src/frontend/src/store/context-menu-store.ts` | **Modified tail.** Expose `contextMenuStore` on `window.__contextMenuStore` in DEV mode. |
| `src/frontend/src/components/ContextMenu.tsx` | **Modified.** Add new "Board" section after the PDF section with 0/1/N other-tab handling and match-count badges. |
| `src/frontend/src/components/Toolbar.tsx` | **Modified.** `GlobalSearch.runSearch` delegates to `cross-target-search`. No user-visible change except that clicking a board row with an exact refdes match now auto-selects. |
| `src/frontend/tests/donor-search.spec.ts` | **New.** Playwright spec covering context-menu donor submenu, count badges, zero-count disabled state, and the global-search auto-select refactor. |

---

## Task 1: Create `cross-target-search` module with count primitives

**Files:**
- Create: `src/frontend/src/store/cross-target-search.ts`

- [ ] **Step 1: Create the new module with count functions**

Write `src/frontend/src/store/cross-target-search.ts`:

```ts
/**
 * Cross-target search — shared primitives for "find term X in target Y"
 * used by both the toolbar global search and the right-click context menu.
 *
 * Single source of truth so the right-click path and the dropdown path
 * are guaranteed to behave identically.
 */
import { boardStore } from './board-store';
import { pdfStore } from './pdf-store';

/**
 * Count substring (case-insensitive) matches of `term` across the given
 * board tab's parts and net names. Returns 0 if tab not found or not loaded.
 *
 * Matches the legacy scan in Toolbar.GlobalSearch so the global dropdown's
 * counts are preserved byte-for-byte.
 */
export function countInBoardTab(term: string, tabId: number): number {
  const t = term.trim().toLowerCase();
  if (!t) return 0;
  const tab = boardStore.getTab(tabId);
  if (!tab?.board) return 0;

  let count = 0;
  for (const p of tab.board.parts) {
    if (p.name.toLowerCase().includes(t)) count++;
  }
  for (const [name] of tab.board.nets) {
    if (name.toLowerCase().includes(t)) count++;
  }
  return count;
}

/**
 * Count substring matches of `term` in the given PDF's extracted text.
 * Delegates to the existing pdfStore helper.
 */
export function countInPdf(term: string, fileName: string): number {
  const t = term.trim().toLowerCase();
  if (!t) return 0;
  return pdfStore.countTextMatches(fileName, t);
}
```

- [ ] **Step 2: Verify TypeScript build succeeds**

Run:
```
cd src/frontend && npm run build
```
Expected: `tsc -b` and `vite build` both succeed. No type errors. No new warnings.

- [ ] **Step 3: Commit**

```
git add src/frontend/src/store/cross-target-search.ts
git commit -m "feat(search): add cross-target count primitives

countInBoardTab / countInPdf consolidate the substring scans that
Toolbar.GlobalSearch does inline today. Used by both the dropdown
and (upcoming) the right-click donor submenu so both UIs report
identical counts.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Add `findInBoardTab` and `findInPdf` action primitives

**Files:**
- Modify: `src/frontend/src/store/cross-target-search.ts`

- [ ] **Step 1: Add the two new imports**

Open `src/frontend/src/store/cross-target-search.ts`. In the imports block at the top of the file (next to the existing `boardStore` and `pdfStore` imports), add:

```ts
import { fileInputRefs } from './file-inputs';
import { openBoardSearch } from '../panels/BoardViewerPanel';
```

- [ ] **Step 2: Append the two action functions**

Append to the end of the same file (after `countInPdf`):

```ts
/**
 * Switch to the given board tab, auto-select the part whose refdes equals
 * `term` (case-insensitive exact match) if one exists, and open the Board
 * Search panel with the query populated.
 *
 * The auto-select uses boardStore.focusPart() which also auto-flips the
 * board to the correct side and sets a focus request consumed by
 * BoardRenderer to recenter the viewport.
 *
 * The "count" (which the UI shows as a badge) is substring-based and can
 * exceed 1 (e.g. "R1" matches "R1", "R10", "R100") — but the auto-select
 * is strict equality, so no silent mis-selection.
 */
export function findInBoardTab(term: string, tabId: number): void {
  const t = term.trim();
  if (!t) return;
  boardStore.switchTab(tabId);
  boardStore.focusPart(t);       // no-op if the donor lacks an exact-match refdes
  openBoardSearch(t, tabId);     // opens sidebar search with the query
}

/**
 * Switch the active PDF to `fileName`, set the PDF search query, and focus
 * the PDF search input. Lifted verbatim from the inline body that
 * GlobalSearch.runSearch used to carry.
 */
export function findInPdf(term: string, fileName: string): void {
  const t = term.trim();
  if (!t) return;
  pdfStore.switchTo(fileName);
  pdfStore.searchText(t);
  setTimeout(() => {
    if (fileInputRefs.pdfSearch) {
      fileInputRefs.pdfSearch.value = t;
      fileInputRefs.pdfSearch.focus();
    }
  }, 50);
}
```

- [ ] **Step 3: Verify build**

```
cd src/frontend && npm run build
```
Expected: success. No type errors.

- [ ] **Step 4: Commit**

```
git add src/frontend/src/store/cross-target-search.ts
git commit -m "feat(search): add findInBoardTab / findInPdf actions

findInBoardTab composes switchTab + focusPart (exact-match auto-select
with side-flip + viewport recenter) + openBoardSearch. findInPdf is
a straight lift of the current inline PDF dropdown handler.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Expose test hooks on `window` (DEV-only)

**Files:**
- Modify: `src/frontend/src/store/board-store.ts` (append after `export const boardStore = ...`)
- Modify: `src/frontend/src/store/context-menu-store.ts` (append after `export const contextMenuStore = ...`)

- [ ] **Step 1: Append DEV-only hook to board-store.ts**

Open `src/frontend/src/store/board-store.ts`, scroll to the bottom (after the final `export const boardStore = new BoardStore();` line — find it by grepping). Append:

```ts
// Expose for integration tests (Playwright) — DEV builds only
if (typeof window !== 'undefined' && import.meta.env.DEV) {
  (window as { __boardStore?: typeof boardStore }).__boardStore = boardStore;
}
```

- [ ] **Step 2: Append DEV-only hook to context-menu-store.ts**

Open `src/frontend/src/store/context-menu-store.ts`, append after `export const contextMenuStore = new ContextMenuStore();`:

```ts
// Expose for integration tests (Playwright) — DEV builds only
if (typeof window !== 'undefined' && import.meta.env.DEV) {
  (window as { __contextMenuStore?: typeof contextMenuStore }).__contextMenuStore = contextMenuStore;
}
```

- [ ] **Step 3: Verify build**

```
cd src/frontend && npm run build
```
Expected: success. The DEV guards compile to unreachable code in production builds (Vite strips via dead-code elimination).

- [ ] **Step 4: Commit**

```
git add src/frontend/src/store/board-store.ts src/frontend/src/store/context-menu-store.ts
git commit -m "test: expose boardStore + contextMenuStore on window in DEV

Matches the existing pattern in pdf-store.ts:1466-1469. Needed by the
upcoming donor-search Playwright spec to open the context menu without
relying on brittle PixiJS canvas hit-test coordinates.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Refactor `GlobalSearch.runSearch` to use `cross-target-search`

**Files:**
- Modify: `src/frontend/src/components/Toolbar.tsx` (the `runSearch` body inside `GlobalSearch`, currently at lines 151-213)

- [ ] **Step 1: Add the import**

At the top of `src/frontend/src/components/Toolbar.tsx`, add alongside the other imports:

```ts
import { countInBoardTab, countInPdf, findInBoardTab, findInPdf } from '../store/cross-target-search';
```

- [ ] **Step 2: Replace the board tab scan + action**

Locate the board loop inside `runSearch`, currently:

```ts
// Board tabs: count matching parts + nets per tab
for (const tab of boardStore.tabs) {
  if (!tab.board) continue;
  let count = 0;
  for (const p of tab.board.parts) {
    if (p.name.toLowerCase().includes(ql)) count++;
  }
  for (const [name] of tab.board.nets) {
    if (name.toLowerCase().includes(ql)) count++;
  }
  const label = tab.fileName.replace(/\.[^.]+$/, '');
  items.push({
    label, count, group: 'Board',
    action: () => { openBoardSearch(q, tab.id); },
  });
}
```

Replace with:

```ts
// Board tabs: count matching parts + nets per tab
for (const tab of boardStore.tabs) {
  if (!tab.board) continue;
  const count = countInBoardTab(ql, tab.id);
  const label = tab.fileName.replace(/\.[^.]+$/, '');
  items.push({
    label, count, group: 'Board',
    action: () => { findInBoardTab(q, tab.id); },
  });
}
```

Note: `countInBoardTab` already lowercases internally, so passing `ql` (already lowercased) or the raw `q` both work; passing `ql` matches the legacy code path exactly. The `action` now goes through `findInBoardTab` which adds the exact-refdes auto-select on top of `openBoardSearch`.

- [ ] **Step 3: Replace the PDF scan + action**

Locate the PDF loop, currently:

```ts
// PDF tabs: count matches per open document
for (const fileName of pdfStore.loadedFileNames) {
  const count = pdfStore.countTextMatches(fileName, ql);
  const label = fileName.replace(/\.[^.]+$/, '');
  items.push({
    label, count, group: 'PDF',
    action: () => {
      pdfStore.switchTo(fileName);
      pdfStore.searchText(q);
      setTimeout(() => {
        if (fileInputRefs.pdfSearch) {
          fileInputRefs.pdfSearch.value = q;
          fileInputRefs.pdfSearch.focus();
        }
      }, 50);
    },
  });
}
```

Replace with:

```ts
// PDF tabs: count matches per open document
for (const fileName of pdfStore.loadedFileNames) {
  const count = countInPdf(ql, fileName);
  const label = fileName.replace(/\.[^.]+$/, '');
  items.push({
    label, count, group: 'PDF',
    action: () => { findInPdf(q, fileName); },
  });
}
```

- [ ] **Step 4: Remove now-unused imports**

If after the replacement `openBoardSearch` is no longer directly referenced in `Toolbar.tsx`, remove the `import { openBoardSearch } from '../panels/BoardViewerPanel';` line. Same for `pdfStore` and `fileInputRefs` — check each import and delete any that no longer have a live reference. (The Library row still uses `databankStore` etc., so only Toolbar-local imports that became orphaned should be removed.) `tsc -b` will flag unused imports if ESLint rule is on; run `npm run lint` after to confirm.

- [ ] **Step 5: Verify build + lint**

```
cd src/frontend && npm run build && npm run lint
```
Expected: both succeed. No type errors. No ESLint errors for `Toolbar.tsx`.

- [ ] **Step 6: Manual smoke test**

Start dev server:
```
cd src/frontend && npm run dev
```
In the browser:
1. Open two board samples (`samples/820-02016.bvr` and `samples/820-02935-05.brd`, for example).
2. Type a refdes from one board into the global search.
3. Confirm the dropdown shows both boards with match counts, exactly as before.
4. Click the row for the other board → confirm tab switches and (new behavior) the part is highlighted and viewport recenters if the refdes is an exact match.

Stop the dev server.

- [ ] **Step 7: Commit**

```
git add src/frontend/src/components/Toolbar.tsx
git commit -m "refactor(search): route global search through cross-target-search

GlobalSearch.runSearch now delegates count and action logic to the
shared cross-target-search module. User-visible behavior is unchanged
except that clicking a board row with an exact refdes match now
auto-selects the part (via findInBoardTab → focusPart) in addition
to opening the sidebar search — a strict improvement consistent with
the incoming donor-search flow.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Add "Board" section to `ContextMenu`

**Files:**
- Modify: `src/frontend/src/components/ContextMenu.tsx`

- [ ] **Step 1: Add imports and derive the other-tabs list**

At the top of `src/frontend/src/components/ContextMenu.tsx`, add:

```ts
import { findInBoardTab, countInBoardTab } from '../store/cross-target-search';
```

Inside the `ContextMenu` component, after the line `const boundPdfNames = activeTab?.pdfFileNames ?? [];`, add:

```ts
// Other board tabs (for donor-search submenu). Only include tabs with a
// loaded board — donor rows won't render until the target is ready.
const otherBoardTabs = boardStore.tabs.filter(
  t => t.id !== boardStore.activeTabId && t.board !== null,
);
```

- [ ] **Step 2: Add a helper to strip board file extension (parallel to shortPdfName)**

Near the existing `shortPdfName` helper (top of file, outside component), add:

```ts
/** Strip extension for shorter display labels */
function shortBoardName(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, '');
}
```

- [ ] **Step 3: Add the doBoardSearch helper inside the component**

Right after the existing `doSearch` helper (for PDFs) inside `ContextMenu`, add:

```ts
const doBoardSearch = (e: React.MouseEvent, tabId: number, query: string) => {
  e.stopPropagation();
  findInBoardTab(query, tabId);
  contextMenuStore.hide();
};
```

- [ ] **Step 4: Add a render helper for per-board submenu items**

Below the existing `renderSubmenuItems` (for PDFs), add two new helpers. The "flat" helper is used when exactly one other board is open; the submenu helper is used for the N-other-boards case:

```ts
/** Flat items for the single-other-board case */
const renderBoardFlatItems = (tabId: number, boardLabel: string) => (
  <>
    <div
      className="context-menu-item"
      onClick={(e) => doBoardSearch(e, tabId, state.componentName)}
    >
      Search &apos;{state.componentName}&apos; in {boardLabel}
    </div>
    {netName && (
      <div
        className="context-menu-item"
        onClick={(e) => doBoardSearch(e, tabId, netName)}
      >
        Search net &apos;{netName}&apos; in {boardLabel}
      </div>
    )}
  </>
);

/** Submenu items for a single other board (multi-board case).
 *  Each row is suffixed with a match count; zero-count rows are disabled. */
const renderBoardSubmenuItems = (tabId: number) => {
  const partCount = countInBoardTab(state.componentName, tabId);
  const netCount = netName ? countInBoardTab(netName, tabId) : 0;
  return (
    <>
      <div
        className={`context-menu-item context-submenu-item${partCount === 0 ? ' disabled' : ''}`}
        onClick={partCount === 0 ? undefined : (e) => doBoardSearch(e, tabId, state.componentName)}
      >
        {state.componentName} ({partCount})
      </div>
      {netName && (
        <div
          className={`context-menu-item context-submenu-item${netCount === 0 ? ' disabled' : ''}`}
          onClick={netCount === 0 ? undefined : (e) => doBoardSearch(e, tabId, netName)}
        >
          net {netName} ({netCount})
        </div>
      )}
    </>
  );
};
```

- [ ] **Step 5: Render the Board section after the PDF section**

In the JSX return, the existing PDF block ends with `</>`. Immediately after that PDF block (still inside the outer `<div className="context-menu">`), add:

```tsx
{otherBoardTabs.length > 0 && (
  <>
    <div className="context-menu-separator" />
    {otherBoardTabs.length === 1 ? (
      renderBoardFlatItems(otherBoardTabs[0].id, shortBoardName(otherBoardTabs[0].fileName))
    ) : (
      <>
        {/* Quick search: component name in first other board tab */}
        <div
          className="context-menu-item"
          onClick={(e) => doBoardSearch(e, otherBoardTabs[0].id, state.componentName)}
        >
          Search &apos;{state.componentName}&apos; in Board
        </div>
        <div className="context-menu-separator" />
        {/* Per-board submenus with all query options */}
        {otherBoardTabs.map(tab => (
          <div
            key={`board-${tab.id}`}
            className="context-menu-submenu-trigger"
            onMouseEnter={() => setOpenSubmenu(`board-${tab.id}`)}
            onMouseLeave={() => setOpenSubmenu(null)}
          >
            <div className="context-menu-item context-menu-has-submenu">
              {shortBoardName(tab.fileName)}
              <span className="context-submenu-arrow">▸</span>
            </div>
            {openSubmenu === `board-${tab.id}` && (
              <div className="context-submenu">
                {renderBoardSubmenuItems(tab.id)}
              </div>
            )}
          </div>
        ))}
      </>
    )}
  </>
)}
```

Note the submenu key prefix `board-` — this is important because PDF submenus keyed on raw `name` and board submenus keyed on `board-${tab.id}` must never collide (a PDF named `board-3.pdf` would otherwise shadow a board tab id 3).

- [ ] **Step 6: Verify build + lint**

```
cd src/frontend && npm run build && npm run lint
```
Expected: both succeed.

- [ ] **Step 7: Manual smoke test**

Start dev server, open two boards. Right-click a component on the active board.

1. Confirm the existing PDF section still renders unchanged.
2. Confirm a separator followed by a "Board" section now appears.
3. Confirm the submenu for the other board shows the refdes with a count (e.g. `UF400 (1)`).
4. Click the entry → confirm the donor tab becomes active, the part is highlighted, viewport recenters.
5. Open a third tab that doesn't contain the refdes → confirm its submenu shows `(0)` and the row is greyed out and not clickable.
6. Close all but one board tab → confirm the Board section disappears entirely (no placeholder).

- [ ] **Step 8: Commit**

```
git add src/frontend/src/components/ContextMenu.tsx
git commit -m "feat(context-menu): add donor-search Board section

Right-click a component → submenu lists other open board tabs with
per-query match counts. Clicking jumps to the donor tab, auto-selects
the refdes (via findInBoardTab), and opens the sidebar search. Zero-
count rows are disabled, mirroring the global search's '0' badge.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Playwright E2E — `donor-search.spec.ts`

**Files:**
- Create: `src/frontend/tests/donor-search.spec.ts`

- [ ] **Step 1: Write the spec**

Create `src/frontend/tests/donor-search.spec.ts`:

```ts
/**
 * Donor search — verifies the right-click "find on other board" submenu
 * and the global-search auto-select refactor.
 *
 * Uses dev-only window hooks (window.__boardStore, window.__contextMenuStore)
 * to avoid canvas-coordinate fragility against the PixiJS renderer.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SAMPLES = path.resolve(__dirname, '../../../samples');
const BOARD_A = path.join(SAMPLES, '820-02016.bvr');
const BOARD_B = path.join(SAMPLES, '820-02935-05.brd');

/** Wait for two boards to be loaded into tabs and return their ids + a
 *  refdes that exists on board A. */
async function loadTwoBoardsAndPickRefdes(page: import('@playwright/test').Page) {
  await page.goto('/');

  await page.getByTestId('file-input').setInputFiles(BOARD_A);
  await expect(page.locator('.dv-tab', { hasText: '820-02016.bvr' })).toBeVisible({ timeout: 15000 });

  await page.getByTestId('file-input').setInputFiles(BOARD_B);
  await expect(page.locator('.dv-tab', { hasText: '820-02935-05.brd' })).toBeVisible({ timeout: 15000 });

  // Switch active tab to board A (so right-clicks originate there)
  const tabsInfo = await page.evaluate(() => {
    const bs: any = (window as any).__boardStore;
    const tabs = bs.tabs.map((t: any) => ({ id: t.id, fileName: t.fileName }));
    const a = tabs.find((t: any) => t.fileName.includes('820-02016'));
    bs.switchTab(a.id);
    // Pick the first part name on A
    const tabA = bs.tabs.find((t: any) => t.id === a.id);
    const firstPart = tabA.board.parts[0].name as string;
    return { tabs, firstPart };
  });

  return tabsInfo;
}

test('donor submenu renders and jumps to donor board with auto-select', async ({ page }) => {
  const { tabs, firstPart } = await loadTwoBoardsAndPickRefdes(page);
  const boardA = tabs.find(t => t.fileName.includes('820-02016'))!;
  const boardB = tabs.find(t => t.fileName.includes('820-02935-05'))!;

  // Open the context menu programmatically over the first refdes on A
  await page.evaluate(({ refdes }) => {
    const cms: any = (window as any).__contextMenuStore;
    cms.show(200, 200, refdes, null, null);
  }, { refdes: firstPart });

  // The context menu should be visible
  const menu = page.locator('.context-menu');
  await expect(menu).toBeVisible();

  // With exactly one other board tab, the Board section renders flat items
  // (no submenu). Look for the "in <boardB short name>" entry.
  const entry = menu.locator('.context-menu-item', {
    hasText: `Search '${firstPart}' in 820-02935-05`,
  });
  await expect(entry).toBeVisible();

  await entry.click();

  // Assert donor tab is now active + selection updated (if B has the refdes,
  // focusPart selects it; if not, selection is unchanged but tab still switches)
  const afterClick = await page.evaluate(() => {
    const bs: any = (window as any).__boardStore;
    return {
      activeTabId: bs.activeTabId,
      selectionPartIndex: bs.activeTab?.selection?.partIndex ?? null,
      activeFileName: bs.activeTab?.fileName ?? null,
    };
  });
  expect(afterClick.activeTabId).toBe(boardB.id);
  expect(afterClick.activeFileName).toContain('820-02935-05');
  // Don't assert a specific partIndex — the two boards may not share refdes.
  // The auto-select is a best-effort; the tab switch + search-panel open
  // are the contract we guarantee.
});

test('zero-count donor row is disabled', async ({ page }) => {
  const { tabs, firstPart } = await loadTwoBoardsAndPickRefdes(page);

  // Pick a refdes that definitely doesn't exist on either board.
  const missingRefdes = '__DONOR_MISS__ZZZZ';

  // Open a third board to trigger the submenu (N > 1) branch.
  // Re-load board B under a different mechanism: we can't easily load three
  // distinct samples here, so we assert the single-other-tab branch on the
  // missing refdes instead — entry should still render but clicking should
  // safely result in activeTabId changing (our donor submenu never renders
  // a disabled flat item, only disabled submenu items). For count-disabled
  // coverage we fall back to the N>1 branch below.

  void firstPart;
  // For a genuine 0-count disabled row we need two other tabs. Open board A again.
  await page.getByTestId('file-input').setInputFiles(BOARD_A);
  await expect(page.locator('.dv-tab', { hasText: '820-02016.bvr' }).nth(1)).toBeVisible({ timeout: 15000 });

  // Show context menu with the missing refdes
  await page.evaluate(({ refdes }) => {
    const cms: any = (window as any).__contextMenuStore;
    cms.show(200, 200, refdes, null, null);
  }, { refdes: missingRefdes });

  const menu = page.locator('.context-menu');
  await expect(menu).toBeVisible();

  // Hover a submenu trigger for a non-active board tab — pick the first
  // trigger after the quick-search row.
  const trigger = menu.locator('.context-menu-submenu-trigger').first();
  await trigger.hover();

  // Submenu appears with `missingRefdes (0)` and .disabled class
  const zeroItem = menu.locator(`.context-submenu .context-submenu-item`, {
    hasText: `${missingRefdes} (0)`,
  });
  await expect(zeroItem).toBeVisible();
  await expect(zeroItem).toHaveClass(/disabled/);

  // Clicking a disabled item must not switch tabs
  const before = await page.evaluate(() => (window as any).__boardStore.activeTabId);
  await zeroItem.click({ force: true });
  const after = await page.evaluate(() => (window as any).__boardStore.activeTabId);
  expect(after).toBe(before);
});

test('global search auto-selects exact refdes on click', async ({ page }) => {
  const { tabs, firstPart } = await loadTwoBoardsAndPickRefdes(page);
  const boardA = tabs.find(t => t.fileName.includes('820-02016'))!;

  // Switch to board B so that clicking the A row in the dropdown requires a tab switch.
  const boardB = tabs.find(t => t.fileName.includes('820-02935-05'))!;
  await page.evaluate((id) => (window as any).__boardStore.switchTab(id), boardB.id);

  // Type the refdes into the global search
  const search = page.getByTestId('search-input');
  await search.click();
  await search.fill(firstPart);

  // Wait for dropdown + click the Board A row
  const dropdown = page.locator('.toolbar-search-dropdown');
  await expect(dropdown).toBeVisible();
  const boardARow = dropdown.locator('.toolbar-search-option', {
    hasText: '820-02016',
  });
  await boardARow.click();

  // Assert A is now active + exact-match refdes is selected
  const result = await page.evaluate((expectedName) => {
    const bs: any = (window as any).__boardStore;
    const tab = bs.activeTab;
    const sel = tab?.selection?.partIndex;
    const selName = (sel != null) ? tab.board.parts[sel].name : null;
    return {
      activeFileName: tab?.fileName ?? null,
      selectionName: selName,
      expectedName,
    };
  }, firstPart);

  expect(result.activeFileName).toContain('820-02016');
  // focusPart uses toUpperCase equality — refdes names are typically upper,
  // but guard with a case-insensitive compare.
  expect(result.selectionName?.toUpperCase()).toBe(result.expectedName.toUpperCase());
  void boardA;
});
```

- [ ] **Step 2: Run the spec**

Playwright auto-starts Vite on port 5174 via `webServer` in `playwright.config.ts` — no manual dev server needed.

Run:
```
cd src/frontend && npx playwright test tests/donor-search.spec.ts --reporter=list
```

Expected: all three tests pass.

- [ ] **Step 3: If a test fails, debug systematically**

- If the context menu doesn't appear: verify the DEV hook exposed `__contextMenuStore` (Task 3). Open dev server and inspect `window.__contextMenuStore` in the browser console.
- If the Board section doesn't render: verify the `otherBoardTabs.length > 0` branch in `ContextMenu.tsx` and that both boards have their `board` field populated (parser completed) before the menu is shown. Use `window.__boardStore.tabs.map(t => ({id: t.id, loaded: !!t.board}))` in the console.
- If the third-tab zero-count test fails because loading the same `.bvr` twice creates only one tab (the store may de-dupe): inspect `boardStore.tabs.length` after the second load. If deduped, either switch the second file to a different sample or skip the 3-tab assertion and instead cover it by spinning up a short in-memory test via `boardStore.loadFiles` with a synthetic empty board. The spec-level assertion is "zero-count submenu row is disabled"; any path that produces it is acceptable.
- If the global-search test can't find the dropdown row: inspect `.toolbar-search-dropdown` HTML. The `hasText` selector may need adjustment if the group tag span interferes.

- [ ] **Step 4: Commit**

```
git add src/frontend/tests/donor-search.spec.ts
git commit -m "test(donor-search): add Playwright E2E coverage

Three scenarios: donor submenu renders + jumps to donor tab, zero-count
submenu row is disabled, global-search dropdown auto-selects exact-match
refdes on click.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Full regression pass

- [ ] **Step 1: Run the full Playwright suite**

```
cd src/frontend && npm run test
```

Expected: all existing tests still pass, plus the three new donor-search tests.

- [ ] **Step 2: If any existing test fails, investigate regressions**

Likely suspects if something breaks:
- `pdf-search.spec.ts` or any global-search spec: the `GlobalSearch` refactor may have altered behavior. Re-check Task 4 — counts should be numerically identical; actions should be functionally equivalent except for the auto-select upgrade.
- Any spec that right-clicks a component: the new Board section shifts menu item positions. If a spec clicks by index, it needs to be updated (prefer `hasText` selectors — check the failing spec's selectors).

Fix regressions inline with small commits; do not disable tests.

- [ ] **Step 3: Final commit if anything was adjusted**

If regressions required changes:
```
git add <changed files>
git commit -m "fix: adjust regression caused by donor-search refactor

<specific description>

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

If nothing needed adjusting, skip this step.

---

## Out of scope (reminders, not tasks)

- **PDF-to-PDF donor submenu.** The `findInPdf` primitive is in place; adding the right-click entry-point on PDF panels is a follow-up spec.
- **Pin-level selection on donor.** The donor submenu offers component refdes and net name only.
- **Fuzzy / Levenshtein matching.** Explicit non-goal per spec.

## Verification checklist (run before handing off)

- [ ] `cd src/frontend && npm run build` — succeeds
- [ ] `cd src/frontend && npm run lint` — clean
- [ ] `cd src/frontend && npm run test` — all specs green (including new donor-search.spec.ts)
- [ ] Manual: open two boards, right-click a component, confirm the Board section submenu renders, matches count, and jumps+selects on click
- [ ] Manual: global search with a refdes → click donor row → confirm new auto-select behavior
- [ ] No changes to production bundle size beyond the new module — the DEV-only `window` hooks are dead-code-eliminated in prod
