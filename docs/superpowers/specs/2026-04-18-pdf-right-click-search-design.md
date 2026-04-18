# PDF Right-Click Search Menu

**Status:** Approved design, pending implementation plan
**Date:** 2026-04-18
**Follows:** [2026-04-17-donor-search-design.md](./2026-04-17-donor-search-design.md) and [2026-04-18-donor-search-ui-followup-design.md](./2026-04-18-donor-search-ui-followup-design.md) — those established `cross-target-search` primitives, the shared `renderDonorGroup` helper, and the `SearchScopeBadge` component. This spec mirrors the component-right-click menu in the PDF viewer, reusing those parts.

## Problem

Right-clicking a component on the board opens a donor-search context menu (boards + PDFs). Right-clicking text in a PDF opens nothing — `handleContextMenu` in [PdfViewerPanel.tsx:2492](../../src/frontend/src/panels/PdfViewerPanel.tsx#L2492) just calls `e.preventDefault()` and stops. A user reading a schematic can't pivot to "find this refdes on the board" or "search this net in another schematic" without manual copy-paste into the global search.

## Solution

Give the PDF viewer a right-click menu that mirrors the component menu's structure: three donor groups (Bound Boards / Other Boards / Other PDFs), same helper, same badges, same click actions. The menu is driven by a **pdf.js text item under the cursor** — the store carries the item's `str` as the query.

## Architecture

### Text identification

PDF pages render to `<canvas>`. No HTML text layer means no browser text selection. pdf.js exposes text content via `page.getTextContent()`; `pdfStore` already captures these as `PdfTextItem[]` per page (see [pdf-store.ts:105-116](../../src/frontend/src/store/pdf-store.ts#L105-L116)) and exposes `getTextItemsForPage(pageIndex)` / `getDocTextItemsForPage(fileName, pageIndex)`.

On right-click:

1. Convert `event.clientX/Y` → page-local (PDF-space) coordinates using the panel's current zoom and pan, plus the page's rendered viewport scale.
2. Walk the text items for the clicked page, pick the one whose bounding box contains the point. Tie-breaker if multiple overlap: smallest bbox wins (more specific).
3. If found → open the shared context menu in PDF mode with `query = item.str`.
4. If no item under cursor → open the context menu with a single disabled row `"No text at this point"`. Keeps the gesture discoverable.

The coordinate transform is local to the panel. A new helper `pickTextItemAt(event, pageIndex)` lives in `PdfViewerPanel.tsx` (or a small sibling file if it grows). It composes existing panel state (`zoomRef`, `panRef`, per-page scale from the tier manager).

The text-item bbox in PDF space is derived from the item's `transform` matrix:

- Anchor: `(transform[4], transform[5])` — baseline-left corner.
- Width: the `width` property (already in page-space units).
- Height: derived via `pdfFontSize(transform)` (exported from pdf-store).
- pdf.js y-axis points up; invert for screen-space comparison.

If the current page is ambiguous (two pages visible in adjacent-pages mode), use the page whose rendered rect contains the cursor.

### Store extension

`contextMenuStore` currently carries board-specific fields. Extend with a discriminator so one component renders both modes:

```ts
export interface ContextMenuState {
  visible: boolean;
  screenX: number;
  screenY: number;
  source: 'board' | 'pdf';
  // Board mode
  componentName: string;
  pinId: string | null;
  netName: string | null;
  // PDF mode
  query: string;
  /** PDF the click originated in — used to exclude it from "Other PDFs" */
  originPdfFileName: string;
}
```

Two show methods:

```ts
showBoard(x, y, componentName, pinId, netName): void;
showPdf(x, y, query, originPdfFileName): void;
```

The existing `show(...)` call from [BoardRenderer.ts:3499](../../src/frontend/src/renderer/BoardRenderer.ts#L3499) becomes `showBoard(...)`. No other callers today.

### Menu groups (PDF mode)

All three groups go through the existing `renderDonorGroup<T>` helper from the UI follow-up spec. They follow the same 0/1/2/≥3 rules (hidden / flat / inline submenu triggers / umbrella).

1. **Bound Boards** — `boardStore.tabs.filter(t => t.pdfFileNames.includes(originPdfFileName))`. Usually 1 entry (the 820-code-matched board). Scope: `'board'`. Quick-search label: `Board`. Umbrella label: `Bound Boards`.
2. **Other Boards** — remaining open boards not in the bound set. Scope: `'board'`. Quick-search label: `Other Boards`. Umbrella label: `Other Boards`.
3. **Other PDFs** — `pdfStore.loadedFileNames.filter(n => n !== originPdfFileName)`. Scope: `'pdf'`. Quick-search label: `Other PDFs`. Umbrella label: `Other PDFs`.

If all three groups are empty (one board open, one PDF open, no bindings) the menu shows only a disabled `"Nowhere to search"` row.

### Render-switch in ContextMenu

`ContextMenu.tsx` today renders board mode. The PDF mode shares the chrome (outer `<div>`, positioning, escape-to-close logic) but needs different group derivations and flat-item text. Split the renders with a branch on `state.source`:

```tsx
return (
  <div className="context-menu" ref={menuRef} style={...} onClick={...}>
    {state.source === 'board'
      ? <BoardContextMenuBody state={state} ... />
      : <PdfContextMenuBody state={state} ... />}
  </div>
);
```

`BoardContextMenuBody` wraps today's body unchanged. `PdfContextMenuBody` is new — three `renderDonorGroup` calls plus the "Nowhere to search" fallback. Both bodies consume the same `openSubmenu` / `setOpenSubmenu` state and `componentName`/`query` plumbing via props.

Flat-item text for the PDF mode:

- Board entries: `Search '<query>' in <boardName>` (1-item group) or `Search '<query>' in Board` (2+ quick-row).
- PDF entries: `Search '<query>' in <pdfShortName>` (1-item group) or `Search '<query>' in Other PDFs` (2+ quick-row).

Flat items deliberately omit the `[B]` / `[P]` badges — the word "Board" or "PDF" in the text carries the scope, matching the board menu's convention.

### Click actions

Zero new action primitives. The existing `cross-target-search` functions are used unmodified:

- Bound / Other boards rows → `findInBoardTab(query, tabId)` — tab switch + `focusPart` (exact-match auto-select with side flip + recenter) + sidebar search open. Identical to the board-menu path.
- Other PDFs rows → `findInPdf(query, fileName)` — PDF switch + search-text + focus search input. Identical to the board-menu path and the global search dropdown path.

## Data Flow

```
User right-clicks text "UF400" in PDF A, page 3
  └→ PdfViewerPanel.handleContextMenu(event)
       ├→ preventDefault()
       ├→ pickTextItemAt(event, 3) → { item: { str: "UF400", ... }, found: true }
       └→ contextMenuStore.showPdf(clientX, clientY, "UF400", "pdfA.pdf")

ContextMenu renders (source === 'pdf')
  ├→ Group 1: Bound Boards [boardStore.tabs for which pdfFileNames contains "pdfA.pdf"]
  ├→ Group 2: Other Boards [open boards not in bound set]
  └→ Group 3: Other PDFs [loadedFileNames minus "pdfA.pdf"]

User clicks "in 820-02016"
  └→ findInBoardTab("UF400", tabId)
       ├→ boardStore.switchTab(tabId)
       ├→ boardStore.focusPart("UF400")  // selects UF400, flips side, recenters
       └→ openBoardSearch("UF400", tabId)
```

## Error / Edge Cases

- **Right-click with no PDF loaded:** `handleContextMenu` early-returns (no file, no page) — menu does not open.
- **Right-click in empty area (no text item):** menu opens with only the disabled `"No text at this point"` row. User sees the gesture works and can retry on text. No silent failure.
- **Text item with empty `str`:** filtered out during hit-test (treat as absent).
- **Text item whose `str` has leading/trailing whitespace:** trimmed before storing as `query`. Empty-after-trim items are treated as absent.
- **Right-click on a page whose text content hasn't been extracted yet:** `getTextItemsForPage(pageIdx)` may return `[]` until extraction completes. In that case the hit-test misses and the "no text" branch fires. Acceptable — rare, transient.
- **Cursor exactly on a boundary between two items:** smallest-bbox tiebreaker handles it deterministically. No user-visible issue.
- **PDF has no adjacent page rendered:** single visible page — the cursor is unambiguously on one page.
- **Two pages visible (adjacent-pages mode):** determine which page's rendered rect contains the cursor; use that page's text items.
- **PDF right-click triggers while a board right-click menu is already open:** `contextMenuStore.show*` replaces state unconditionally, so the board menu is closed and the PDF menu opens at the new coords. Existing one-menu-at-a-time behavior preserved.
- **Board menu opens while a PDF right-click menu is already open:** symmetric, same behavior.

## Testing

Add three tests to `donor-search.spec.ts` (keeps all PDF/board context-menu coverage in one file):

1. **PDF menu with Bound Boards + Other PDFs.** Open a board and two PDFs — one bound to the board, the other loaded but unbound. Call `__contextMenuStore.showPdf(x, y, "UF400", boundPdf)` directly (skip the coord hit-test; that's covered in test 3). Assert:
   - A row like `Search 'UF400' in <boardShortName>` appears (Bound Boards flat case, 1 item).
   - A row like `Search 'UF400' in <otherPdfShortName>` appears (Other PDFs flat case, 1 item).

2. **Board entry from PDF menu jumps + auto-selects.** Open two distinct boards + one PDF bound to the first. From the first board, pick a real refdes that exists on the second board too (or accept that `focusPart` no-ops when the refdes doesn't match — in which case assert only the tab switch and search-panel open). Open PDF menu via the hook; click the "Other Boards" entry; assert `boardStore.activeTabId` is the donor board's id.

3. **Coordinate hit-test picks the right item.** Open a PDF + a board. Wait for text extraction to complete. Fetch a known text item via `__pdfStore.getTextItemsForPage(0)[0]`. Compute the item's screen coordinates using the helper (or test-expose it via `window.__pdfTestHooks`). Dispatch a synthetic `contextmenu` event at those coordinates on the PDF canvas. Assert the menu opens with `state.query === item.str`.

Existing 6 donor-search tests and the full regression suite stay green.

### Dev-only test hook additions

`window.__pdfStore` already exists ([pdf-store.ts:1466-1469](../../src/frontend/src/store/pdf-store.ts#L1466-L1469)). Add a `__contextMenuStore` hook (already added in the first donor-search plan; this spec needs the new `showPdf` method exposed on it, which falls out naturally once `showPdf` exists as a regular store method).

Test 3 needs a way to go from `PdfTextItem.transform` → screen coords inside the panel. Expose via a dev-only hook on the panel, or reconstruct in the test using the same math:

```ts
// In the panel, alongside existing refs:
if (typeof window !== 'undefined' && import.meta.env.DEV) {
  (window as { __pdfPanelCoords?: ... }).__pdfPanelCoords = {
    pageRectForIndex: (pageIdx: number) => { ... },
    pickTextItemAt: (x: number, y: number, pageIdx: number) => { ... },
  };
}
```

Register when the active panel mounts; unregister on unmount. The hook is a thin wrapper over the panel's existing transform math.

## File Impact

| File | Change |
| --- | --- |
| `src/frontend/src/store/context-menu-store.ts` | Extend `ContextMenuState`; add `showBoard` / `showPdf`; keep `show` as an alias (or remove if only called from one place). |
| `src/frontend/src/renderer/BoardRenderer.ts` | One-line change: rename `contextMenuStore.show(...)` → `contextMenuStore.showBoard(...)`. |
| `src/frontend/src/components/ContextMenu.tsx` | Split body into `BoardContextMenuBody` and `PdfContextMenuBody`; route via `state.source`. Reuse `renderDonorGroup`, `SearchScopeBadge`, `findInBoardTab`, `findInPdf`. |
| `src/frontend/src/panels/PdfViewerPanel.tsx` | Flesh out `handleContextMenu`: coordinate inversion + text-item hit-test + `contextMenuStore.showPdf` call. Add DEV hook for tests. |
| `src/frontend/tests/donor-search.spec.ts` | Three new tests. |

No new store surface beyond the `context-menu-store` extension. No changes to `cross-target-search`, `pdf-store`, or `board-store` logic.

## Out of Scope

- **Word-under-cursor tokenization** (option B from brainstorming). Text items are usually already word-granular in real-world schematics. Revisit if users report hitting multi-word items.
- **Structured queries** (chip@pin variants, net syntax). Single-string query only, matching what pdf.js gives us.
- **PDF-to-same-PDF search.** Excluded by design — the user is already on that PDF; looking up the same text in it adds nothing.
- **Keyboard navigation** of the menu.
- **Highlighting** the picked text item visually (e.g. a flash or bbox overlay). Might be nice UX; out of scope for this spec.

## Open Questions

None. All structural choices match the existing component-right-click menu.
