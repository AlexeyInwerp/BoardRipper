# PDF Right-Click Search Menu Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Right-click text in the PDF viewer opens the shared context menu with the text-item string as the query; menu lists "Bound Boards", "Other Boards", and "Other PDFs" donor groups using the existing `renderDonorGroup` helper.

**Architecture:** Extend `contextMenuStore` with a `source: 'board' | 'pdf'` discriminator and a PDF-specific `query` field. Split `ContextMenu` body into `BoardContextMenuBody` / `PdfContextMenuBody` and switch on `source`. In the PDF panel, flesh out `handleContextMenu` to hit-test the cursor against pdf.js text items using the existing `textItemRect` helper, then call `contextMenuStore.showPdf(...)`.

**Tech Stack:** React 19, TypeScript strict, pdf.js (already in), Vite 7, Playwright E2E.

**Spec:** [docs/superpowers/specs/2026-04-18-pdf-right-click-search-design.md](../specs/2026-04-18-pdf-right-click-search-design.md)

---

## Notes for the implementing engineer

- Continue on the current branch `feature/donor-search` in worktree `.worktrees/donor-search/`. The two prior plans (donor-search + UI follow-up) are already landed — `cross-target-search`, `SearchScopeBadge`, and `renderDonorGroup` are all in place.
- `PdfViewerPanel.tsx` is large (2900+ lines) but the relevant pieces are:
  - `containerRef` / `wrapperRef` / `canvasRef` at lines 561-564.
  - `zoomRef` / `panRef` at 590-591.
  - `scaleRef.current` — baseScale (CSS px per PDF unit) — set at 988, 1128, 1264.
  - `viewportTransformRef.current` — pdf.js `unscaledViewport.transform` — set at 991.
  - `textItemRect(transform, width, vpT, scale)` at line 366 — returns canvas-space axis-aligned rect. Canvas-space == CSS-space in the wrapper because the wrapper holds the page at its CSS size.
  - `handleContextMenu` at line 2492 — today just `e.preventDefault()`.
  - `pdfStore.getTextItemsForPage(pageIdx)` at [pdf-store.ts:1124](../../src/frontend/src/store/pdf-store.ts#L1124) — returns `PdfTextItem[]` for the active doc.
  - `pdfStore.getDocCurrentPage(fileName)` returns the 1-based current page.
  - `pdfStore.activeFileName` — the currently-viewed PDF (may be null).
- Run Playwright: `cd .worktrees/donor-search/src/frontend && npx playwright test`. Build: `npm run build`. Lint: `npm run lint`.
- `CLAUDE.md` notes: no raw `console.log` — use scoped loggers (`log.pdf.*`, `log.ui.*`). Stick to that convention for anything user-logged; the hit-test itself shouldn't log in hot paths.

---

## File Structure

| File | Role |
| --- | --- |
| `src/frontend/src/store/context-menu-store.ts` | **Modified.** Extend state with `source: 'board' \| 'pdf'`, `query`, `originPdfFileName`. Add `showBoard(...)` and `showPdf(...)` methods. Remove the old `show(...)` (one caller). |
| `src/frontend/src/renderer/BoardRenderer.ts` | **Modified (1 line).** `contextMenuStore.show(...)` → `contextMenuStore.showBoard(...)`. |
| `src/frontend/src/components/ContextMenu.tsx` | **Refactored.** Extract `BoardContextMenuBody` (existing body) and add new `PdfContextMenuBody`; route via `state.source`. |
| `src/frontend/src/panels/PdfViewerPanel.tsx` | **Modified.** `handleContextMenu` fleshed out with hit-test + store call. Small dev-only test hook added. |
| `src/frontend/tests/donor-search.spec.ts` | **Modified.** Three new tests (PDF menu renders, clicking board entry jumps + selects, hit-test picks right item). |

---

## Task 1: Extend `contextMenuStore` with `source` + PDF fields

**Files:**
- Modify: `src/frontend/src/store/context-menu-store.ts`

- [ ] **Step 1: Replace the whole file with the extended version**

Write `src/frontend/src/store/context-menu-store.ts`:

```ts
import { Emitter } from './emitter';

export interface ContextMenuState {
  visible: boolean;
  screenX: number;
  screenY: number;
  /** Discriminator — board component right-click or PDF text right-click */
  source: 'board' | 'pdf';
  // Board-mode fields
  componentName: string;
  /** Set when right-clicking a specific pin — enables chip+pin PDF search */
  pinId: string | null;
  /** Net name of the right-clicked pin */
  netName: string | null;
  // PDF-mode fields
  /** Text-item string under the cursor when the menu opened */
  query: string;
  /** PDF filename the click originated in — used to exclude it from "Other PDFs" */
  originPdfFileName: string;
}

const emptyState: ContextMenuState = {
  visible: false,
  screenX: 0,
  screenY: 0,
  source: 'board',
  componentName: '',
  pinId: null,
  netName: null,
  query: '',
  originPdfFileName: '',
};

class ContextMenuStore extends Emitter {
  private _state: ContextMenuState = { ...emptyState };

  get state(): ContextMenuState {
    return this._state;
  }

  showBoard(
    screenX: number,
    screenY: number,
    componentName: string,
    pinId: string | null = null,
    netName: string | null = null,
  ) {
    this._state = {
      ...emptyState,
      visible: true,
      screenX,
      screenY,
      source: 'board',
      componentName,
      pinId,
      netName,
    };
    this.notify();
  }

  showPdf(
    screenX: number,
    screenY: number,
    query: string,
    originPdfFileName: string,
  ) {
    this._state = {
      ...emptyState,
      visible: true,
      screenX,
      screenY,
      source: 'pdf',
      query,
      originPdfFileName,
    };
    this.notify();
  }

  hide() {
    if (!this._state.visible) return;
    this._state = { ...this._state, visible: false };
    this.notify();
  }
}

export const contextMenuStore = new ContextMenuStore();

// Expose for integration tests (Playwright) — DEV builds only
if (typeof window !== 'undefined' && import.meta.env.DEV) {
  (window as { __contextMenuStore?: typeof contextMenuStore }).__contextMenuStore = contextMenuStore;
}
```

- [ ] **Step 2: Update the single board call site**

In `src/frontend/src/renderer/BoardRenderer.ts` around line 3499, change:

```ts
contextMenuStore.show(e.clientX, e.clientY, part.name, pinId, netName);
```

to:

```ts
contextMenuStore.showBoard(e.clientX, e.clientY, part.name, pinId, netName);
```

- [ ] **Step 3: Update all `state.componentName` consumers in `ContextMenu.tsx` — no-op for now**

`ContextMenu.tsx` reads `state.componentName` / `state.pinId` / `state.netName` in the existing (board) body. Those fields still exist on the state. The new fields (`source`, `query`, `originPdfFileName`) aren't consumed yet — Task 2 adds the branch. This step is just a mental note, no code change.

- [ ] **Step 4: Verify build**

```
npm run build 2>&1 | tail -3
```

Expected: success. The type system will catch any missed `show` → `showBoard` call sites.

- [ ] **Step 5: Run existing donor-search spec**

```
npx playwright test tests/donor-search.spec.ts --reporter=list
```

Expected: 6/6 green. The tests use `__contextMenuStore.show(...)` — which doesn't exist anymore. Update those 3 call sites to `.showBoard(...)` for compatibility:

Grep the test file for `cms.show(`:

```
grep -n "cms.show\|__contextMenuStore" tests/donor-search.spec.ts
```

Each call like `cms.show(200, 200, refdes, null, null)` becomes `cms.showBoard(200, 200, refdes, null, null)`. The TypeScript cast of the hook also updates — find blocks like:

```ts
const cms = (window as unknown as {
  __contextMenuStore: { show: (x: number, y: number, name: string, pinId: string | null, net: string | null) => void };
}).__contextMenuStore;
```

Change the type to:

```ts
const cms = (window as unknown as {
  __contextMenuStore: { showBoard: (x: number, y: number, name: string, pinId: string | null, net: string | null) => void };
}).__contextMenuStore;
```

And the call site to `cms.showBoard(...)`.

Re-run the spec — expected: 6/6 green.

- [ ] **Step 6: Commit**

```
git add src/frontend/src/store/context-menu-store.ts src/frontend/src/renderer/BoardRenderer.ts src/frontend/tests/donor-search.spec.ts
git commit -m "refactor(context-menu): add 'source' discriminator + showPdf method

Prepare for the PDF right-click menu. State carries source='board'|'pdf'
plus the PDF-specific query/originPdfFileName. showBoard/showPdf are
the two entry points; the singular show() is gone (1 caller) —
BoardRenderer now calls showBoard, tests updated.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Split `ContextMenu` body into board/pdf renderers

**Files:**
- Modify: `src/frontend/src/components/ContextMenu.tsx`

This is a refactor-only step for the board side (preserves current behavior) plus a placeholder PDF renderer that shows just the disabled "no text" row. Task 3 fills in the PDF body.

- [ ] **Step 1: Add a `findInPdf` import**

At the top of `src/frontend/src/components/ContextMenu.tsx`, change:

```ts
import { findInBoardTab, countInBoardTab } from '../store/cross-target-search';
```

to:

```ts
import { findInBoardTab, countInBoardTab, findInPdf } from '../store/cross-target-search';
```

- [ ] **Step 2: Wrap the existing body + add branch**

At the bottom of the `ContextMenu` component, the return statement currently opens a `<div className="context-menu" ...>` and renders the entire body inline. Replace that body with a branch on `state.source`. Read the file and locate the return:

```
grep -n "className=\"context-menu\"" src/components/ContextMenu.tsx
```

The current structure is roughly:

```tsx
return (
  <div className="context-menu" ref={menuRef} style={...} onClick={...}>
    {/* the three groups: bound PDFs, other PDFs, other boards */}
  </div>
);
```

Refactor to:

```tsx
return (
  <div className="context-menu" ref={menuRef} style={{ left: state.screenX, top: state.screenY }} onClick={(e) => e.stopPropagation()}>
    {state.source === 'board'
      ? renderBoardBody()
      : renderPdfBody()}
  </div>
);
```

Where `renderBoardBody()` is a closure (or inline const) containing the current JSX body unchanged. Add it above the `return`:

```tsx
const renderBoardBody = () => (
  <>
    {boundOpen.length === 0 && otherPdfNames.length === 0 && (
      <div className="context-menu-item disabled">
        Search &apos;{state.componentName}&apos; in PDF (none linked)
      </div>
    )}
    {/* … existing renderDonorGroup calls for bound PDFs, other PDFs, other boards — move them inside here verbatim … */}
  </>
);

const renderPdfBody = () => (
  <div className="context-menu-item disabled">
    No text at this point
  </div>
);
```

Move all three existing `renderDonorGroup(...)` calls (bound PDFs, other PDFs, other boards) and the "(none linked)" disabled row inside `renderBoardBody`. Nothing else changes.

- [ ] **Step 3: Verify build**

```
npm run build 2>&1 | tail -3
```

Expected: success.

- [ ] **Step 4: Run existing spec**

```
npx playwright test tests/donor-search.spec.ts --reporter=list
```

Expected: 6/6 green. The board body is unchanged in behavior; the PDF body is unused at this point (no caller invokes `showPdf` yet).

- [ ] **Step 5: Commit**

```
git add src/frontend/src/components/ContextMenu.tsx
git commit -m "refactor(context-menu): split body into board/pdf renderers

Route by state.source. Board body is identical to before; PDF body
is a placeholder disabled row. Task 3 fills in the PDF body; Task 4
wires the right-click from PdfViewerPanel.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Implement `PdfContextMenuBody`

**Files:**
- Modify: `src/frontend/src/components/ContextMenu.tsx`

- [ ] **Step 1: Compute PDF-mode derivations and render helpers**

Inside the `ContextMenu` component, alongside the existing board-mode derivations, add (guard by `state.source === 'pdf'` when the compute is expensive; here all are O(tabs + pdfs) which is cheap so compute unconditionally — avoids React lint complaints about conditional hooks/derivations):

```tsx
// PDF-mode derivations — meaningful only when state.source === 'pdf'
const originPdf = state.originPdfFileName;
const boundBoardTabs = boardStore.tabs.filter(
  t => t.board !== null && t.pdfFileNames.includes(originPdf),
);
const otherBoardsForPdf = boardStore.tabs.filter(
  t => t.board !== null && !t.pdfFileNames.includes(originPdf),
);
const otherPdfsForPdf = pdfStore.loadedFileNames.filter(n => n !== originPdf);

const doPdfBoardSearch = (e: React.MouseEvent, tabId: number) => {
  e.stopPropagation();
  findInBoardTab(state.query, tabId);
  contextMenuStore.hide();
};

const doPdfPdfSearch = (e: React.MouseEvent, fileName: string) => {
  e.stopPropagation();
  findInPdf(state.query, fileName);
  contextMenuStore.hide();
};

// For the 1-item flat case of PDF-mode groups, produce plain rows:
const renderPdfBoardFlat = (tab: { id: number; fileName: string }) => (
  <div
    className="context-menu-item"
    onClick={(e) => doPdfBoardSearch(e, tab.id)}
  >
    Search &apos;{state.query}&apos; in {shortBoardName(tab.fileName)}
  </div>
);

const renderPdfPdfFlat = (name: string) => (
  <div
    className="context-menu-item"
    onClick={(e) => doPdfPdfSearch(e, name)}
  >
    Search &apos;{state.query}&apos; in {shortPdfName(name)}
  </div>
);

// For 2+ cases, submenu items: a single "the query" row per item.
const renderPdfBoardSubmenu = (tab: { id: number; fileName: string }) => {
  const count = countInBoardTab(state.query, tab.id);
  return (
    <div
      className={`context-menu-item context-submenu-item${count === 0 ? ' disabled' : ''}`}
      onClick={count === 0 ? undefined : (e) => doPdfBoardSearch(e, tab.id)}
    >
      {state.query} ({count})
    </div>
  );
};

const renderPdfPdfSubmenu = (name: string) => (
  <div
    className="context-menu-item context-submenu-item"
    onClick={(e) => doPdfPdfSearch(e, name)}
  >
    {state.query}
  </div>
);
```

- [ ] **Step 2: Replace the placeholder `renderPdfBody` with the real body**

```tsx
const renderPdfBody = () => {
  // No text under cursor → disabled hint
  if (!state.query) {
    return <div className="context-menu-item disabled">No text at this point</div>;
  }

  const nothingToSearch =
    boundBoardTabs.length === 0 &&
    otherBoardsForPdf.length === 0 &&
    otherPdfsForPdf.length === 0;

  if (nothingToSearch) {
    return <div className="context-menu-item disabled">Nowhere to search</div>;
  }

  return (
    <>
      {renderDonorGroup(
        {
          scope: 'board',
          keyPrefix: 'pdf-bound-boards',
          quickSearchLabel: 'Board',
          umbrellaLabel: 'Bound Boards',
          items: boundBoardTabs,
          itemKey: (tab) => String(tab.id),
          itemLabel: (tab) => shortBoardName(tab.fileName),
          onQuickSearch: (tab) => {
            findInBoardTab(state.query, tab.id);
            contextMenuStore.hide();
          },
          renderSubmenu: (tab) => renderPdfBoardSubmenu(tab),
          renderFlatItems: (tab) => renderPdfBoardFlat(tab),
        },
        openSubmenu,
        setOpenSubmenu,
        state.query,
      )}
      {renderDonorGroup(
        {
          scope: 'board',
          keyPrefix: 'pdf-other-boards',
          quickSearchLabel: 'Other Boards',
          umbrellaLabel: 'Other Boards',
          items: otherBoardsForPdf,
          itemKey: (tab) => String(tab.id),
          itemLabel: (tab) => shortBoardName(tab.fileName),
          onQuickSearch: (tab) => {
            findInBoardTab(state.query, tab.id);
            contextMenuStore.hide();
          },
          renderSubmenu: (tab) => renderPdfBoardSubmenu(tab),
          renderFlatItems: (tab) => renderPdfBoardFlat(tab),
        },
        openSubmenu,
        setOpenSubmenu,
        state.query,
      )}
      {renderDonorGroup(
        {
          scope: 'pdf',
          keyPrefix: 'pdf-other-pdfs',
          quickSearchLabel: 'Other PDFs',
          umbrellaLabel: 'Other PDFs',
          items: otherPdfsForPdf,
          itemKey: (name) => name,
          itemLabel: (name) => shortPdfName(name),
          onQuickSearch: (name) => {
            findInPdf(state.query, name);
            contextMenuStore.hide();
          },
          renderSubmenu: (name) => renderPdfPdfSubmenu(name),
          renderFlatItems: (name) => renderPdfPdfFlat(name),
        },
        openSubmenu,
        setOpenSubmenu,
        state.query,
      )}
    </>
  );
};
```

- [ ] **Step 3: Verify build + lint**

```
npm run build && npm run lint 2>&1 | grep -iE "error|ContextMenu" | head -10
```

Expected: no new errors.

- [ ] **Step 4: Existing spec still green**

```
npx playwright test tests/donor-search.spec.ts --reporter=list
```

Expected: 6/6 green. The PDF body is only exercised by `showPdf` which still has no caller.

- [ ] **Step 5: Commit**

```
git add src/components/ContextMenu.tsx
git commit -m "feat(context-menu): implement PDF-mode body

Three donor groups (Bound Boards, Other Boards, Other PDFs) routed
through the shared renderDonorGroup helper. Reuses findInBoardTab +
findInPdf from cross-target-search — no new action primitives.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: PDF panel — hit-test + menu trigger

**Files:**
- Modify: `src/frontend/src/panels/PdfViewerPanel.tsx`

- [ ] **Step 1: Add the import**

Near the other imports in `src/frontend/src/panels/PdfViewerPanel.tsx`, add:

```ts
import { contextMenuStore } from '../store/context-menu-store';
```

- [ ] **Step 2: Replace `handleContextMenu` with the hit-test version**

Current (around line 2492):

```ts
const handleContextMenu = useCallback((e: React.MouseEvent) => {
  e.preventDefault();
}, []);
```

Replace with:

```ts
const handleContextMenu = useCallback((e: React.MouseEvent) => {
  e.preventDefault();

  const container = containerRef.current;
  if (!container) return;
  const rect = container.getBoundingClientRect();
  const zoom = zoomRef.current;
  const pan = panRef.current;
  // Screen → CSS-space point on the wrapper (page is sized cssW × cssH in CSS units)
  const cssX = (e.clientX - rect.left - pan.x) / zoom;
  const cssY = (e.clientY - rect.top - pan.y) / zoom;

  const baseScale = scaleRef.current;
  const vpT = viewportTransformRef.current;
  if (baseScale <= 0 || !vpT) {
    contextMenuStore.showPdf(e.clientX, e.clientY, '', pdfFileName);
    return;
  }

  const curPage = pdfStore.getDocCurrentPage(pdfFileName);
  const pageIdx = curPage - 1;
  const items = pdfStore.getDocTextItemsForPage(pdfFileName, pageIdx);

  // Walk items, find the smallest bbox containing (cssX, cssY)
  let bestStr = '';
  let bestArea = Infinity;
  for (const item of items) {
    const r = textItemRect(item.transform, item.width, vpT, baseScale);
    if (cssX >= r.x && cssX <= r.x + r.w && cssY >= r.y && cssY <= r.y + r.h) {
      const area = r.w * r.h;
      if (area < bestArea) {
        bestArea = area;
        bestStr = item.str.trim();
      }
    }
  }

  contextMenuStore.showPdf(e.clientX, e.clientY, bestStr, pdfFileName);
}, [pdfFileName]);
```

The existing bookmark right-click handler at line 2767 (`handleBookmarkRightClick`) remains unchanged — it stops propagation before this handler sees the event.

- [ ] **Step 3: Add a DEV-only test hook for coord-based testing**

Below the existing `useEffect` blocks in the component (anywhere after `handleContextMenu` is defined), add:

```tsx
// Expose a test hook so Playwright can verify the hit-test without
// reconstructing the coord math.
useEffect(() => {
  if (!import.meta.env.DEV) return;
  const target = (window as { __pdfPanelTestHooks?: Record<string, unknown> });
  target.__pdfPanelTestHooks = {
    ...target.__pdfPanelTestHooks,
    [pdfFileName]: {
      getContainerRect: () => containerRef.current?.getBoundingClientRect(),
      getZoom: () => zoomRef.current,
      getPan: () => ({ ...panRef.current }),
      getBaseScale: () => scaleRef.current,
      getViewportTransform: () => viewportTransformRef.current,
      pickTextItemAt: (clientX: number, clientY: number) => {
        const container = containerRef.current;
        if (!container) return null;
        const rect = container.getBoundingClientRect();
        const zoom = zoomRef.current;
        const pan = panRef.current;
        const cssX = (clientX - rect.left - pan.x) / zoom;
        const cssY = (clientY - rect.top - pan.y) / zoom;
        const baseScale = scaleRef.current;
        const vpT = viewportTransformRef.current;
        if (baseScale <= 0 || !vpT) return null;
        const curPage = pdfStore.getDocCurrentPage(pdfFileName);
        const items = pdfStore.getDocTextItemsForPage(pdfFileName, curPage - 1);
        let best: { str: string; area: number } | null = null;
        for (const item of items) {
          const r = textItemRect(item.transform, item.width, vpT, baseScale);
          if (clientX >= rect.left + pan.x + r.x * zoom
              && clientX <= rect.left + pan.x + (r.x + r.w) * zoom
              && clientY >= rect.top + pan.y + r.y * zoom
              && clientY <= rect.top + pan.y + (r.y + r.h) * zoom) {
            const area = r.w * r.h;
            if (!best || area < best.area) best = { str: item.str, area };
          }
        }
        return best ? { str: best.str } : null;
      },
      /** Compute screen coords of the first non-empty text item's center — for tests */
      firstItemScreenCenter: () => {
        const container = containerRef.current;
        if (!container) return null;
        const rect = container.getBoundingClientRect();
        const zoom = zoomRef.current;
        const pan = panRef.current;
        const baseScale = scaleRef.current;
        const vpT = viewportTransformRef.current;
        if (baseScale <= 0 || !vpT) return null;
        const curPage = pdfStore.getDocCurrentPage(pdfFileName);
        const items = pdfStore.getDocTextItemsForPage(pdfFileName, curPage - 1);
        for (const item of items) {
          if (!item.str.trim()) continue;
          const r = textItemRect(item.transform, item.width, vpT, baseScale);
          const cx = rect.left + pan.x + (r.x + r.w / 2) * zoom;
          const cy = rect.top + pan.y + (r.y + r.h / 2) * zoom;
          return { clientX: cx, clientY: cy, str: item.str };
        }
        return null;
      },
    },
  };
  return () => {
    if (target.__pdfPanelTestHooks) {
      const hooks = target.__pdfPanelTestHooks as Record<string, unknown>;
      delete hooks[pdfFileName];
    }
  };
}, [pdfFileName]);
```

- [ ] **Step 4: Verify build + lint**

```
npm run build 2>&1 | tail -3 && npm run lint 2>&1 | grep -i error | head -5
```

Expected: success. Lint may warn about `any` usage on the window cast — acceptable, matches the pattern used elsewhere (`pdf-store.ts:1468`).

- [ ] **Step 5: Existing spec still green**

```
npx playwright test tests/donor-search.spec.ts --reporter=list
```

Expected: 6/6 green. The PDF panel changes don't affect board tests.

- [ ] **Step 6: Manual smoke test**

Open the dev server at http://localhost:5180 (or start it: `npx vite --port 5180 --strictPort`). Open a PDF. Right-click text in the PDF. Confirm:
- A menu opens at the click location.
- If text was under the cursor, the menu contains rows referencing open boards and other PDFs with the clicked text as the query.
- If no text was under the cursor (e.g. empty margin), the menu shows a single disabled "No text at this point" row.

Close browser.

- [ ] **Step 7: Commit**

```
git add src/panels/PdfViewerPanel.tsx
git commit -m "feat(pdf): right-click opens donor-search context menu

handleContextMenu now hit-tests the cursor against pdf.js text items
via the existing textItemRect helper, then calls contextMenuStore.showPdf
with the item string as the query. A DEV-only test hook exposes the
hit-test + coord math for Playwright coverage.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Playwright — three PDF right-click tests

**Files:**
- Modify: `src/frontend/tests/donor-search.spec.ts`

- [ ] **Step 1: Append the three tests**

At the end of `src/frontend/tests/donor-search.spec.ts`, append:

```ts
test('PDF right-click menu lists Bound Boards and Other PDFs', async ({ page }) => {
  await page.goto('/');

  // Load one board + two PDFs. The 820-02016.pdf auto-binds to the board.
  await page.getByTestId('file-input').setInputFiles(BOARD_A);
  await expect(page.locator('.dv-tab', { hasText: '820-02016.bvr' })).toBeVisible({ timeout: 15000 });

  await page.getByTestId('pdf-input').setInputFiles(path.join(SAMPLES, '820-02016.pdf'));
  await expect(page.locator('.dv-tab', { hasText: '820-02016.pdf' })).toBeVisible({ timeout: 10000 });

  await page.getByTestId('pdf-input').setInputFiles(path.join(SAMPLES, '820-02935 051-08286 Rev 5.0.3.pdf'));
  await expect(page.locator('.dv-tab', { hasText: /820-02935 051-08286/ })).toBeVisible({ timeout: 10000 });

  await page.waitForFunction(() => {
    const ps = (window as unknown as { __pdfStore?: { loadedFileNames: string[] } }).__pdfStore;
    return !!ps && ps.loadedFileNames.length >= 2;
  }, null, { timeout: 15000 });

  // Switch active PDF to the bound one (simulates user viewing it)
  await page.evaluate(() => {
    const ps = (window as unknown as {
      __pdfStore: { switchTo: (name: string) => void; loadedFileNames: string[] };
    }).__pdfStore;
    const bound = ps.loadedFileNames.find(n => n.includes('820-02016'));
    if (bound) ps.switchTo(bound);
  });

  // Show the PDF menu with a known query, bypassing the canvas hit-test
  await page.evaluate(() => {
    const cms = (window as unknown as {
      __contextMenuStore: { showPdf: (x: number, y: number, q: string, origin: string) => void };
    }).__contextMenuStore;
    const ps = (window as unknown as {
      __pdfStore: { loadedFileNames: string[] };
    }).__pdfStore;
    const bound = ps.loadedFileNames.find(n => n.includes('820-02016'))!;
    cms.showPdf(200, 200, 'UF400', bound);
  });

  const menu = page.locator('.context-menu');
  await expect(menu).toBeVisible();

  // Bound Boards flat case (1 item): "Search 'UF400' in 820-02016"
  await expect(menu.locator('.context-menu-item', {
    hasText: `Search 'UF400' in 820-02016`,
  })).toBeVisible();

  // Other PDFs flat case (1 item): "Search 'UF400' in 820-02935 051-08286 …"
  await expect(menu.locator('.context-menu-item', {
    hasText: /Search 'UF400' in 820-02935 051-08286/,
  })).toBeVisible();
});

test('PDF menu board entry jumps to the board tab', async ({ page }) => {
  await page.goto('/');

  await page.getByTestId('file-input').setInputFiles(BOARD_A);
  await expect(page.locator('.dv-tab', { hasText: '820-02016.bvr' })).toBeVisible({ timeout: 15000 });

  await page.getByTestId('file-input').setInputFiles(BOARD_B);
  await expect(page.locator('.dv-tab', { hasText: '820-02935-05.brd' })).toBeVisible({ timeout: 15000 });

  await page.getByTestId('pdf-input').setInputFiles(path.join(SAMPLES, '820-02016.pdf'));
  await expect(page.locator('.dv-tab', { hasText: '820-02016.pdf' })).toBeVisible({ timeout: 10000 });

  await page.waitForFunction(() => {
    const bs = (window as unknown as { __boardStore?: { tabs: { board: unknown }[] } }).__boardStore;
    const ps = (window as unknown as { __pdfStore?: { loadedFileNames: string[] } }).__pdfStore;
    return !!bs && !!ps && bs.tabs.length >= 2 && ps.loadedFileNames.length >= 1 && bs.tabs.every(t => t.board !== null);
  }, null, { timeout: 15000 });

  // Pick the first part name from BOARD_A so it's a known refdes
  const info = await page.evaluate(() => {
    const bs = (window as unknown as {
      __boardStore: {
        tabs: { id: number; fileName: string; board: { parts: { name: string }[] } | null }[];
      };
    }).__boardStore;
    const ps = (window as unknown as {
      __pdfStore: { loadedFileNames: string[] };
    }).__pdfStore;
    const a = bs.tabs.find(t => t.fileName.includes('820-02016'))!;
    return {
      boardAId: a.id,
      firstPart: a.board!.parts[0].name,
      pdfName: ps.loadedFileNames.find(n => n.includes('820-02016'))!,
    };
  });

  // Open PDF menu with the known refdes as the query
  await page.evaluate(({ query, origin }) => {
    const cms = (window as unknown as {
      __contextMenuStore: { showPdf: (x: number, y: number, q: string, origin: string) => void };
    }).__contextMenuStore;
    cms.showPdf(200, 200, query, origin);
  }, { query: info.firstPart, origin: info.pdfName });

  const menu = page.locator('.context-menu');
  await expect(menu).toBeVisible();

  // Click the bound board entry (flat 1-item case)
  const entry = menu.locator('.context-menu-item', {
    hasText: `Search '${info.firstPart}' in 820-02016`,
  });
  await expect(entry).toBeVisible();
  await entry.click();

  // Board A should now be active, the refdes selected
  const after = await page.evaluate(() => {
    const bs = (window as unknown as {
      __boardStore: {
        activeTabId: number | null;
        activeTab: { fileName: string; selection: { partIndex: number | null }; board: { parts: { name: string }[] } | null } | null;
      };
    }).__boardStore;
    const tab = bs.activeTab;
    const sel = tab?.selection?.partIndex ?? null;
    return {
      activeTabId: bs.activeTabId,
      activeFileName: tab?.fileName ?? null,
      selectionName: (sel != null && tab?.board) ? tab.board.parts[sel].name : null,
    };
  });

  expect(after.activeTabId).toBe(info.boardAId);
  expect(after.activeFileName).toContain('820-02016');
  expect(after.selectionName?.toUpperCase()).toBe(info.firstPart.toUpperCase());
});

test('PDF hit-test picks the text item under the cursor', async ({ page }) => {
  await page.goto('/');

  await page.getByTestId('file-input').setInputFiles(BOARD_A);
  await expect(page.locator('.dv-tab', { hasText: '820-02016.bvr' })).toBeVisible({ timeout: 15000 });

  await page.getByTestId('pdf-input').setInputFiles(path.join(SAMPLES, '820-02016.pdf'));
  await expect(page.locator('.dv-tab', { hasText: '820-02016.pdf' })).toBeVisible({ timeout: 10000 });

  // Wait for the PDF to finish extracting text
  await page.waitForFunction(() => {
    const ps = (window as unknown as {
      __pdfStore?: {
        loadedFileNames: string[];
        getDocTextItemsForPage?: (n: string, p: number) => unknown[];
      };
    }).__pdfStore;
    if (!ps) return false;
    const name = ps.loadedFileNames[0];
    if (!name) return false;
    const items = ps.getDocTextItemsForPage ? ps.getDocTextItemsForPage(name, 0) : [];
    return Array.isArray(items) && items.length > 0;
  }, null, { timeout: 30000 });

  // Wait until the panel's test hook is registered
  const pdfName = await page.evaluate(() => {
    const ps = (window as unknown as { __pdfStore: { loadedFileNames: string[] } }).__pdfStore;
    return ps.loadedFileNames[0];
  });

  await page.waitForFunction((name) => {
    const hooks = (window as unknown as {
      __pdfPanelTestHooks?: Record<string, { firstItemScreenCenter?: () => unknown }>;
    }).__pdfPanelTestHooks;
    return !!hooks && !!hooks[name] && typeof hooks[name].firstItemScreenCenter === 'function';
  }, pdfName, { timeout: 15000 });

  // Find a text item's screen center + dispatch contextmenu there
  const target = await page.evaluate((name) => {
    const hooks = (window as unknown as {
      __pdfPanelTestHooks: Record<string, { firstItemScreenCenter: () => { clientX: number; clientY: number; str: string } | null }>;
    }).__pdfPanelTestHooks;
    return hooks[name].firstItemScreenCenter();
  }, pdfName);

  expect(target).not.toBeNull();
  const { clientX, clientY, str } = target!;

  const canvas = page.locator('canvas').first();
  await canvas.dispatchEvent('contextmenu', { clientX, clientY, bubbles: true });

  const menu = page.locator('.context-menu');
  await expect(menu).toBeVisible({ timeout: 3000 });

  // Store should now carry the picked text as query
  const query = await page.evaluate(() => {
    const cms = (window as unknown as {
      __contextMenuStore: { state: { query: string; source: string } };
    }).__contextMenuStore;
    return { query: cms.state.query, source: cms.state.source };
  });
  expect(query.source).toBe('pdf');
  expect(query.query).toBe(str.trim());
});
```

- [ ] **Step 2: Run the spec**

```
npx playwright test tests/donor-search.spec.ts --reporter=list
```

Expected: all 9 tests pass (6 existing + 3 new). The third test may flake on slow CI — if so, bump the `waitForFunction` timeout to 30000ms.

- [ ] **Step 3: If a test fails**

- First test: inspect `__contextMenuStore.state` after `showPdf` — confirm `source === 'pdf'`, `query === 'UF400'`, `originPdfFileName` matches. If bound boards don't appear, verify the auto-bind happened (`boardStore.tabs[0].pdfFileNames` should include the 820-02016.pdf).
- Second test: if `selectionName` is null, the donor board may not share the `firstPart` refdes with the active one; that's fine for the "tab switch" check but the test asserts selection equality on the *same* board (the active bound board). `findInBoardTab` runs `focusPart` on that same board, so a literal match should happen. If it doesn't, check whether `focusPart` was actually called — the `openBoardSearch` hook must also exist for the active tab.
- Third test: if `menu` never becomes visible, the synthetic `contextmenu` event may not bubble. Ensure the panel is mounted (`.dv-tab` visible) and `dispatchEvent('contextmenu', { clientX, clientY, bubbles: true })` was called on an element that is a descendant of `containerRef`. Try dispatching on `document.elementFromPoint(clientX, clientY)` instead.

- [ ] **Step 4: Commit**

```
git add src/frontend/tests/donor-search.spec.ts
git commit -m "test(pdf-context-menu): three scenarios covering PDF right-click

1. Menu lists Bound Boards + Other PDFs from the right-clicked PDF.
2. Clicking a board entry jumps to that board tab and auto-selects.
3. Coordinate hit-test picks the correct text item via the panel's
   DEV test hook.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Full regression pass

- [ ] **Step 1: Ensure CWD is the worktree's frontend dir**

```
cd /Users/besitzer/Desktop/Boardviewer/.worktrees/donor-search/src/frontend
pwd
```

Must print `/Users/besitzer/Desktop/Boardviewer/.worktrees/donor-search/src/frontend`.

- [ ] **Step 2: Run the full suite**

```
npx playwright test --reporter=list
```

Expected: 34 passed / 10 skipped / 0 failed (baseline 31 passed from the last pass + 3 new PDF right-click tests).

- [ ] **Step 3: Fix regressions inline if any**

Likely suspects after this plan:
- Tests that drive the board context menu via the old `show(...)` method name — already updated in Task 1 Step 5, but verify with `grep -n "cms.show\b" tests/donor-search.spec.ts` (word boundary).
- Any spec that matches menu text by index (`nth(N)`) — the refactor preserves DOM shape for existing cases, but if a test used an overly positional selector, adjust it.

- [ ] **Step 4: Final commit if anything adjusted**

```
git add <changed files>
git commit -m "fix: adjust regression from PDF right-click plan

<specific description>

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Verification checklist

- [ ] `npm run build` — succeeds
- [ ] `npm run lint` — no new errors
- [ ] `npx playwright test tests/donor-search.spec.ts` — 9/9 green
- [ ] `npx playwright test` — full suite green
- [ ] Manual: open a PDF, right-click text → menu opens with query + correct groups
- [ ] Manual: right-click empty PDF space → disabled "No text at this point" row
- [ ] Manual: from the PDF menu, click a board entry → board tab becomes active + refdes selected
- [ ] Manual: from the PDF menu, click an Other-PDFs entry → other PDF becomes active with query populated
- [ ] `git log` shows 5 new commits on top of the prior UI follow-up completion
