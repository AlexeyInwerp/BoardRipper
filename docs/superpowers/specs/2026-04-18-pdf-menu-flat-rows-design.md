# PDF Right-Click Menu — Flat One-Liner Rows

**Status:** Approved design, pending implementation plan
**Date:** 2026-04-18
**Follows:** [2026-04-18-pdf-right-click-search-design.md](./2026-04-18-pdf-right-click-search-design.md) — a UX refinement on top of the just-shipped PDF right-click menu.
**Scope:** `ContextMenu.tsx` (`renderPdfBody` only). Board mode unchanged.

## Problem

The shipped PDF menu uses the same two-level structure as the board menu: a "quick-search" row at the top of each group plus per-donor submenu triggers that reveal a single sub-row on hover. Two problems:

1. The quick-search row reads awkwardly because PDF-mode groups pluralize (`Search 'UN000' in Other Boards`, `Search 'UN000' in Other PDFs`).
2. The submenu reveal is wasted motion — the PDF context only has **one query** (the text under the cursor), so the revealed sub-row is always just the query + count. Hovering in and then clicking is double work; a flat row would be one click.

## Solution

Replace the `renderDonorGroup`-based layout in `renderPdfBody` with a flat list per group. Each donor gets one clickable row carrying the donor name, the query, and the match count.

### Row format

```
[scope-badge] <shortDonorName> — <query> (<count>)
```

Examples with query `UN000`:

- Bound Board (count 1): `[B] 820-02016 — UN000 (1)`
- Other Board (count 0): `[B] 820-01700 — UN000 (0)`
- Other PDF (count 4): `[P] YX60_NMD562 — UN000 (4)`

The " — " separator (em-dash with surrounding spaces) keeps the label readable. Count is always shown, including `(0)`.

### Zero-count rows remain clickable

Click-through is the default — no `disabled` class, no gated `onClick`. Rationale: even when the current term doesn't match, the user often wants to jump to the target PDF or board with the query pre-populated, then tweak the search term once they're there. Gating the click forces them to use the global search as a workaround.

The visual continues to show `(0)` so the user knows the match status up-front — informational, not restrictive.

### Group structure

Three groups in this fixed order:

1. **Bound Boards** — boards whose `pdfFileNames` includes the origin PDF.
2. **Other Boards** — remaining boards.
3. **Other PDFs** — other loaded PDFs.

Each non-empty group renders:

- A separator line above it (`<div class="context-menu-separator" />`)
- A small text header (e.g. `Bound Boards` in a muted style) — needed because we lose the submenu-trigger label that previously named the group implicitly
- The flat list of donor rows

The header uses a new CSS class `.context-menu-group-header` (small, muted, non-interactive):

```css
.context-menu-group-header {
  padding: 2px 12px;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  opacity: 0.55;
  pointer-events: none;
  user-select: none;
}
```

Empty groups are omitted entirely. All three groups empty → the existing `"Nowhere to search"` disabled row is shown.

### What's removed

- The per-group quick-search row (`Search 'UN000' in Other Boards` etc.) — redundant with the donor rows.
- The submenu trigger chrome (hover `▸`, `.context-menu-submenu-trigger` wrapper, `.context-submenu` reveal).
- The ≥3-item umbrella collapse — flat rows are already compact; nesting them inside an umbrella adds clicks without saving space.

### What stays

- The `[B]` / `[P]` scope badges on each row — `<SearchScopeBadge scope={…} />`, same component.
- The `state.query` empty-check → "No text at this point" disabled row.
- The all-empty fallback → "Nowhere to search" disabled row.
- Click handlers are unchanged: board row → `findInBoardTab(query, tabId)`, PDF row → `findInPdf(query, fileName)`.

### Board mode unchanged

The board-mode body still uses `renderDonorGroup`. Reason: board right-clicks offer multiple query variants per donor (component name, chip@pin, net name), so the per-donor submenu reveal is meaningful. Only PDF mode — which has a single query — gets flattened.

The shared `renderDonorGroup` helper remains untouched. PDF mode now simply doesn't use it.

## Implementation notes

- `renderPdfBody` becomes a straightforward `.map()` over the three derived groups, producing the row JSX inline or via a small `renderPdfDonorRow` helper.
- `renderPdfBoardFlat`, `renderPdfPdfFlat`, `renderPdfBoardSubmenu`, `renderPdfPdfSubmenu` — the four helpers added in spec 3 are now unused. Delete them to keep the file honest.
- The submenu state (`openSubmenu` / `setOpenSubmenu`) is still needed for board mode; leave it alone.

## Testing

Update the PDF-right-click tests (3 tests added in plan 3):

1. **Menu lists Bound Boards and Other PDFs** — currently asserts `Search 'UF400' in 820-02016`. Update to `820-02016 — UF400 (<count>)` (allow any count ≥0 via regex).
2. **Board entry jumps to the board tab + auto-selects** — update the click-target locator from the "Search 'X' in Y" pattern to the new `<donor> — <query> (…)` pattern.
3. **Hit-test picks the right text item** — unchanged. Asserts `state.query` and `state.source`, independent of visual format.

Add one new test:

4. **Zero-count PDF row stays clickable** — open a board and a known-unrelated PDF. Right-click via `showPdf` with a refdes that doesn't exist in the PDF. Assert the `Other PDFs` group has a row containing `(0)` with no `disabled` class. Click it; assert `pdfStore.activeFileName` switched to that PDF and the query is in the PDF search input.

## Out of scope

- Board-mode restructuring — separate concern; current submenu structure is load-bearing for multi-variant queries.
- Visual styling of the new `.context-menu-group-header` beyond the minimal CSS rule above (color tweaks can come later in a theme pass).
- Re-ordering groups. Order stays Bound Boards → Other Boards → Other PDFs to match the current spec and the visual sketch the user approved.
