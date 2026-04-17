# Donor Search — Cross-Target Lookup from Context Menu

**Status:** Approved design, pending implementation plan
**Date:** 2026-04-17
**Scope:** Board-to-board donor search via right-click context menu, unified with existing global search. PDF-to-PDF donor search is a follow-up spec that reuses the same foundation.

## Problem

When two almost-identical boards are open (e.g. a working unit and a donor), the user frequently needs to look up a component on the donor while working on the primary board. Today this requires:

1. Clicking the donor tab to switch
2. Manually retyping the refdes into the search panel or global search
3. Clicking back to the working tab

The global search at the top of the screen already does cross-board + cross-PDF find, but it requires typing the refdes again — information the user already has under their cursor via right-click.

## Solution

Add a "Board" section to the existing component right-click context menu that mirrors the existing "PDF" section: list every other open board tab, show a match count per tab, and click-to-jump.

The critical conformance constraint: **the right-click action MUST be behaviorally equivalent to typing the refdes into the global search and clicking the same tab's row.** One underlying action, two entry points.

When the term is an **exact refdes match** in the target board, the action additionally auto-selects that component, auto-flips to the correct side, and recenters the viewport — a small upgrade that benefits both the right-click path and the global-search path. (Board refdes are unique by format convention, so "exact match" is unambiguous by construction.)

## Architecture

### New module: `src/frontend/src/store/cross-target-search.ts`

Pure TypeScript functions — no React, no UI. Single source of truth for "find term X in target Y" across the app.

```ts
// Counts — used by menus and the global search dropdown for badges
export function countInBoardTab(term: string, tabId: number): number;
export function countInPdf(term: string, fileName: string): number;

// Jump actions — switch target, apply query, maybe auto-select (boards only)
export function findInBoardTab(term: string, tabId: number): void;
export function findInPdf(term: string, fileName: string): void;
```

#### `countInBoardTab(term, tabId)`

Substring match (case-insensitive, matches today's global search behavior in `Toolbar.tsx:161-166`):

```
count = parts[i].name matches + nets[name] matches
```

Returns 0 if tab has no board loaded.

#### `countInPdf(term, fileName)`

Direct delegation: `pdfStore.countTextMatches(fileName, term.toLowerCase())`. Already exists.

#### `findInBoardTab(term, tabId)`

1. Trim and early-return on empty term.
2. `boardStore.switchTab(tabId)` — sets the donor tab active.
3. `boardStore.focusPart(term)` — existing store method (`board-store.ts:1021-1044`) that does case-insensitive exact equality lookup against `board.parts[i].name`, selects the part, auto-flips to the correct side if needed, and sets a focus request consumed by `BoardRenderer` to recenter the viewport. No-op if the term doesn't match any refdes.
4. `openBoardSearch(term, tabId)` — populate the Board Search panel with the query. Always runs, matching the current behavior when a user clicks a board row in the global search dropdown.

Substring-vs-exact distinction: the dropdown **count** is substring-based (so `R1` counts as matching `R1`, `R10`, `R100` — useful for the user to see scope). The auto-select uses **exact equality**, so `R1` only selects a part literally named `R1`. This avoids silent mis-selection when the term is a prefix of multiple refdes.

#### `findInPdf(term, fileName)`

Lift-and-move the existing PDF handler body from `Toolbar.tsx:180-189` verbatim:

```ts
pdfStore.switchTo(fileName);
pdfStore.searchText(term);
setTimeout(() => {
  if (fileInputRefs.pdfSearch) {
    fileInputRefs.pdfSearch.value = term;
    fileInputRefs.pdfSearch.focus();
  }
}, 50);
```

No behavior change.

### GlobalSearch refactor

In `Toolbar.tsx:127-262`:

- Replace inline board `count` scan (lines 161-166) with `countInBoardTab(term, tab.id)`.
- Replace inline PDF `count` call (line 176) with `countInPdf(term, fileName)` (trivial rename).
- Replace inline board `action` body (line 170) with `() => findInBoardTab(q, tab.id)`.
- Replace inline PDF `action` body (lines 180-189) with `() => findInPdf(q, fileName)`.
- Library row is **not** touched — it isn't a "target" in the donor-search sense and stays inline.

User-visible behavior of the global search is unchanged **except** that exact refdes matches now auto-select the part and recenter the viewport when clicked. This is a strict improvement and is consistent with the donor-search requirement.

### Context menu extension

In `src/frontend/src/components/ContextMenu.tsx`, add a new "Board" section after the existing PDF section. It follows the PDF section's structure 1:1.

State needed: `otherBoardTabs = boardStore.tabs.filter(t => t.id !== boardStore.activeTabId && t.board !== null)`.

**0 other tabs:** section not rendered. No "none open" placeholder — would always be visible on a single-board session and adds nothing.

**1 other tab:** flat items identical in shape to `renderFlatItems` for PDF:

- `Search 'UF400' in <boardName>`
- `Search net 'PP_VCC' in <boardName>` (when right-clicked on a pin with a net)

Each calls `findInBoardTab(query, otherTab.id)`.

**N other tabs:** structure identical to the multi-PDF case:

- Quick-search row at the top: `Search 'UF400' in Board` → defaults to the first other tab (same pattern as PDF quick-search on `boundPdfNames[0]`).
- Per-tab submenu triggers, each row suffixed with a match count: `UF400 (3)`, `UF400 (0)`.
- Zero-count rows render with `.context-menu-item.disabled` — honest signal that the term doesn't exist on that donor, visually matching the global search dropdown's `0` badge.

Match counts are computed at menu render time via `countInBoardTab`. Cost: O(parts + nets) per other tab, well under 1 ms for typical 3k-part boards.

### Pin-variant handling

The existing PDF menu offers a `F11@UF400` chip-pin query (see `ContextMenu.tsx:95`). This is a PDF text-search idiom — it has no analog for board data. The board-donor submenu therefore offers only:

1. Component name (`UF400`)
2. Net name (`PP_VCC`) — when the right-click originated on a pin with a net

Pin-level selection on the donor board (e.g. "find pin F11 of UF400 on donor") is a future extension. Not in scope.

## Data Flow

### Right-click path

```
User right-clicks part UF400 on Board A (active)
  └→ contextMenuStore.show(x, y, 'UF400', pinId?, netName?)
  └→ ContextMenu renders: PDF section (existing) + Board section (new)
  └→ User clicks "UF400 (3)" under Board B's submenu
  └→ findInBoardTab('UF400', boardB.id)
       ├→ boardStore.switchTab(boardB.id)
       ├→ boardStore.focusPart('UF400')
       │     ├→ finds part by exact case-insensitive name
       │     ├→ auto-flips to correct side if needed
       │     ├→ sets selection + focus request
       │     └→ BoardRenderer consumes focus request → viewport recenters
       └→ openBoardSearch('UF400', boardB.id)  // panel opens, pre-populated
```

### Global-search path (after refactor)

```
User types 'UF400' in global search
  └→ runSearch enumerates tabs + PDFs, calling countInBoardTab / countInPdf
  └→ Dropdown shows each tab + each PDF with count
  └→ User clicks Board B's row
  └→ findInBoardTab('UF400', boardB.id)   // SAME function as right-click
       └→ (identical downstream behavior)
```

### PDF-donor path (future follow-up spec)

Same pattern, implemented symmetrically:

```
User right-clicks text in PDF A
  └→ pdf context menu shows "Search '<text>' in <other PDF>"
  └→ findInPdf(text, otherPdfFileName)   // SAME function as global search
```

## Error / Edge Cases

- **Ambiguous substring match** (e.g. `R1` has count ≥ 2 because it appears in `R1`, `R10`, `R100`): count is substring-based, but `focusPart` uses exact equality — it either finds a literal `R1` and selects it, or no-ops. Search panel always opens with the query so the user can pick from substring results. No silent mis-selection.
- **Term not present in donor**: count is 0, row is disabled, click is impossible. No toast needed — consistent with how global search communicates zero matches.
- **Donor tab's board hasn't loaded yet** (`tab.board === null`): excluded from `otherBoardTabs` filter. Donor rows appear only once the board is ready.
- **Active tab with no board**: PDF section still renders as today; Board section renders if other tabs have boards loaded. (The right-click that opens this menu requires a selected part, which requires a loaded board — so this state is rare but the filter handles it safely.)
- **Case sensitivity**: substring count uses `toLowerCase()` on both sides (matches `Toolbar.tsx:152`); exact-unique auto-select uses `toLowerCase()` on both sides. Consistent throughout.
- **Whitespace**: `term.trim()` at the entry of `findInBoardTab` / `findInPdf`. Zero-trimmed terms are no-ops.

## Testing

### Playwright E2E — `src/frontend/tests/donor-search.spec.ts`

One new spec covering the donor workflow:

1. Load two different board fixtures into two tabs (reuse existing test fixtures).
2. Switch to tab A, right-click a known part (e.g. a refdes that exists in both).
3. Assert the context menu shows a "Board" section with tab B's entry.
4. Click the entry that searches in B.
5. Assert: active tab is now B, the part is selected (`boardStore.activeTab.selection.partIndex` matches), and the search panel shows the query.
6. Add a third tab C whose board does not contain that refdes.
7. Reopen the right-click menu on A, hover B's and C's submenus — assert C's query row has count `(0)` and carries the `disabled` class.

### Unit test — `src/frontend/src/store/cross-target-search.test.ts`

Small unit test against in-memory `BoardData` fixtures:

- `findInBoardTab` with exact-match term → asserts `switchTab` and `focusPart` called, selection moves to the expected part.
- `findInBoardTab` with substring-only term (`R1` when no literal `R1` exists, only `R10`/`R100`) → asserts `focusPart` runs but selection is unchanged; `openBoardSearch` still called.
- `findInBoardTab` with missing term → asserts `switchTab` still called, selection unchanged, `openBoardSearch` still called with the term.
- `countInBoardTab` numeric correctness for parts-only, nets-only, and mixed matches.

### Manual verification

- Open two BVR3 samples, right-click a part on one, confirm the new "Board" submenu.
- Click "Search in <donor>" → active tab switches, part highlights, viewport recenters.
- Open the global search, type the same refdes — confirm behavior is identical after the refactor (dropdown still shows boards/PDFs/library with counts, clicking a board row auto-selects when exact-unique).

## File Impact

| File | Change |
| --- | --- |
| `src/frontend/src/store/cross-target-search.ts` | New. ~60 LOC. |
| `src/frontend/src/store/cross-target-search.test.ts` | New. Unit tests. |
| `src/frontend/src/components/ContextMenu.tsx` | Add Board section. ~80 LOC delta. |
| `src/frontend/src/components/Toolbar.tsx` | Replace inline scans/actions in `runSearch` with calls into `cross-target-search`. ~-30 / +10 LOC. |
| `src/frontend/src/panels/BoardViewerPanel.tsx` | Minor — `openBoardSearch` may need an optional flag if any caller wants to skip the auto-select upgrade. (Defer: decide during implementation; current call sites look fine with the upgrade unconditional.) |
| `src/frontend/tests/donor-search.spec.ts` | New Playwright spec. |

No parser changes, no renderer changes, no backend changes.

## Out of Scope (for this spec)

- **PDF-to-PDF donor search from right-click.** Design is ready to support it — `findInPdf` already exists — but the PDF context menu is a separate component and gets its own spec. This spec's file impact is limited to the board/component right-click menu.
- **Pin-level selection on donor** (e.g. "find pin F11 of UF400 on donor board"). Future extension.
- **Fuzzy refdes matching** (Levenshtein, prefix-strip, etc.) — the user confirmed exact-match only for now. API leaves room to add later without breaking callers.
- **Side-by-side sync mode** (continuous selection/pan mirroring across tabs). Different feature; not this spec.
- **Cmd+K universal palette.** Different UX; not this spec.

## Open Questions

None at spec time. All design decisions are resolved; items that could vary (auto-select threshold, ambiguous handling, zero-count visual) are specified explicitly above.
