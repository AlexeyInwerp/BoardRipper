# Donor Search UI Follow-up — Grouped PDFs, Collapse Threshold, Shared Scope Badge

**Status:** Approved design, pending implementation plan
**Date:** 2026-04-18
**Follows:** [2026-04-17-donor-search-design.md](./2026-04-17-donor-search-design.md) — current component right-click menu already has a "Board" section. This follow-up expands the PDF section and tightens the visual language.
**Scope:** Component right-click (`ContextMenu.tsx`) UI changes and a small shared-badge component refactor. No parser, renderer, or backend changes. Same `cross-target-search` primitives; no new store surface.

## Problem

Three gaps in the current right-click menu:

1. **PDFs are binding-gated.** Only PDFs bound to the active board appear. An unbound PDF (or one bound to another board) is invisible from the right-click, even though the global toolbar search lists them all. This defeats donor lookup on PDFs — the case where the user opens a second PDF specifically as a donor reference.
2. **No collapse when many donors are open.** When 3+ other boards are open, each gets its own top-level submenu trigger. Menus grow tall and lose the quick-scan property. Same will happen to PDFs once they're ungated.
3. **Scope is implicit.** Per-item submenu triggers show only a file name — you can't tell at a glance whether it's a board or a PDF. The global toolbar search already solves this with colored letter badges ("B" / "P" / "L"); the right-click menu should mirror them for visual conformance.

## Solution

### 1. PDF section split: "Bound" and "Other"

Today the PDF section uses `activeTab.pdfFileNames`. Split into two groups, rendered top-to-bottom:

- **Bound PDFs** — `activeTab.pdfFileNames` (unchanged — preserves muscle memory that "these PDFs belong to this board").
- **Other PDFs** — every open PDF *not* in the bound set. This includes both unbound PDFs and PDFs bound to other boards. A PDF in this group is a legitimate donor surface.

`pdfStore.loadedFileNames` gives us the full set; subtract the bound set.

If "Other PDFs" is empty, the section is omitted — no placeholder.

### 2. Per-group threshold collapse (N > 2)

Applied independently to three groups: **bound PDFs**, **other PDFs**, and **other boards**.

Within a group:

- **1 item** → flat items (search query variants rendered inline — current behavior for the 1-other-board and 1-bound-PDF cases).
- **2 items** → per-item submenu triggers rendered at top level (current N>1 behavior).
- **≥3 items** → the whole group collapses under a single **umbrella trigger**. Hovering the umbrella reveals a submenu containing the per-item submenu triggers — two-level nesting.

Umbrella labels: `Other Boards ▸`, `Other PDFs ▸`, `Bound PDFs ▸`. Each shows a scope badge (see §3).

Rationale for the ≤2 threshold: the two dominant workflows are "donor on screen" (1 other of a kind) and "two candidate donors" (2 other) — both should stay one hover deep. Three or more signals "I have a crowded workspace and want the menu compact."

Per-group independence: adding a third board doesn't change whether the PDF groups collapse. Each group reasons about its own size only.

### 3. Shared `SearchScopeBadge`

New component at [src/frontend/src/components/SearchScopeBadge.tsx](../../src/frontend/src/components/SearchScopeBadge.tsx):

```ts
export type SearchScope = 'board' | 'pdf' | 'library';

const BADGES: Record<SearchScope, { label: string }> = {
  board:   { label: 'B' },
  pdf:     { label: 'P' },
  library: { label: 'L' },
};

export function SearchScopeBadge({ scope }: { scope: SearchScope }) {
  return (
    <span className={`toolbar-search-tag toolbar-search-tag-${scope}`}>
      {BADGES[scope].label}
    </span>
  );
}
```

CSS stays untouched — the existing `.toolbar-search-tag`, `.toolbar-search-tag-board`, `.toolbar-search-tag-pdf`, `.toolbar-search-tag-library` rules already define color/shape.

Global search ([Toolbar.tsx:249-251](../../src/frontend/src/components/Toolbar.tsx#L249-L251)) is refactored to render `<SearchScopeBadge scope={group.toLowerCase() as SearchScope} />` instead of the inline `<span>`. Future changes (e.g. swap `"B"` for an icon, add a new scope) are one-file edits.

### 4. Badge placement in context menu

- **Per-item submenu triggers** carry a badge before the file name: `[B] 820-02016 ▸`, `[P] schematic_v2 ▸`.
- **Umbrella triggers** (collapse case) carry a badge before the group label: `[B] Other Boards ▸`, `[P] Other PDFs ▸`, `[P] Bound PDFs ▸`.
- **Flat quick-search items** (e.g. `Search 'UF400' in PDF`, `Search 'UF400' in Board`) are unchanged — the words `PDF` / `Board` already carry the scope.

## Architecture

### File impact

| File | Change |
| --- | --- |
| `src/frontend/src/components/SearchScopeBadge.tsx` | **New.** ~20 LOC shared component. |
| `src/frontend/src/components/Toolbar.tsx` | **Modified.** Replace inline `<span>` badge with `<SearchScopeBadge>`. ~-5 / +2 LOC. |
| `src/frontend/src/components/ContextMenu.tsx` | **Modified.** Split PDF section into bound + other; apply collapse threshold to all three groups; render scope badges on submenu triggers. The 0/1/≥2 branching today only applies to "other boards" — it needs to be generalized and reused. Largest single change in this follow-up. |
| `src/frontend/tests/donor-search.spec.ts` | **Modified.** Add scenarios: "Other PDFs" group renders unbound PDFs; collapse umbrella appears at 3 items; badge renders on submenu triggers. |

No parser, renderer, or backend changes. `cross-target-search` module already has `findInPdf` / `countInPdf` — no new primitives needed.

### Rendering structure (generalized)

Refactor the context-menu JSX so all three donor groups go through one helper. Sketch:

```ts
interface DonorGroup<T> {
  scope: SearchScope;               // 'board' | 'pdf'
  umbrellaLabel: string;            // 'Other Boards' / 'Other PDFs' / 'Bound PDFs'
  items: T[];                       // tabs or pdf file names
  itemKey: (item: T) => string;
  itemLabel: (item: T) => string;
  renderFlat: (item: T) => ReactNode;      // used when group has 1 item
  renderSubmenu: (item: T) => ReactNode;   // per-item submenu contents
}

function renderDonorGroup<T>(g: DonorGroup<T>, openSubmenu: string, setOpenSubmenu: ...): ReactNode;
```

Three calls in the menu body:

1. `renderDonorGroup(boundPdfGroup)` — when `boundPdfNames.length > 0`.
2. `renderDonorGroup(otherPdfGroup)` — when other PDFs exist.
3. `renderDonorGroup(otherBoardGroup)` — when other board tabs exist.

Each render returns either flat items (1), top-level submenu triggers (2), or an umbrella with nested submenu triggers (≥3). No existing behavior regresses because the 0 and 1 cases produce identical DOM.

Collapse key management: the two-level nesting (umbrella → item submenu) needs distinct `openSubmenu` keys per level. Compose as `umbrella:<scope>` and `item:<scope>:<itemKey>`. Only one key of each level open at a time; hovering into the umbrella submenu sets the `umbrella:` key, hovering a per-item row within sets the `item:` key. On leaving the umbrella trigger's outer `div`, both collapse.

### Why one helper instead of three copies

Today `ContextMenu.tsx` has two near-duplicate sections (PDF + Board) and the follow-up adds a third (Other PDFs). Without refactoring, the 0/1/N + collapse logic would need to exist three times. Extracting `renderDonorGroup` collapses duplication and means the next change (e.g. a fourth scope, a new badge style) is localized.

This is a targeted improvement — the file has grown and the menu's branching is getting noisy. Not a refactor-for-refactor's-sake; it pays for itself the moment the third group lands.

## Data Flow

Unchanged from the existing spec. Click handlers still go through:

- Board: `findInBoardTab(query, tabId)` → `switchTab` + `focusPart` + `openBoardSearch`.
- PDF (either group): `findInPdf(query, fileName)` → `switchTo` + `searchText` + focus search input.

The only data-flow addition is the derivation step:

```ts
const allPdfNames: string[] = pdfStore.loadedFileNames;
const boundPdfNames: string[] = activeTab?.pdfFileNames ?? [];
const otherPdfNames: string[] = allPdfNames.filter(n => !boundPdfNames.includes(n));
```

## Error / Edge Cases

- **Active tab has no bound PDF, other PDFs exist.** Bound group skipped entirely (current behavior, except we stop rendering the "none linked" placeholder because the user now has alternatives in "Other PDFs"). If `otherPdfNames.length === 0` too, we keep the existing "in PDF (none linked)" disabled item.
- **PDF in bound list that no longer exists in `pdfStore.loadedFileNames`** (stale reference): filter bound set against `allPdfNames` before display. Defensive; should not happen under normal use.
- **≥3 items collapse umbrella with one zero-count item** (multi-board case): umbrella stays enabled — children still contain clickable non-zero-count options. Within the umbrella, zero-count rows remain disabled just as today. No "whole group is zero" special case — too rare to be worth a dedicated path.
- **Active tab with loaded board, zero other tabs, zero PDFs open**: no PDF section, no board section. Menu shows only the legacy "Search 'X' in PDF (none linked)" disabled row as a single hint. Acceptable fallback.
- **Keyboard navigation** (future concern): two-level submenu nesting should still work with arrow keys; the existing menu doesn't implement keyboard nav today, so this follow-up doesn't either. Out of scope.

## Testing

### Playwright additions to `donor-search.spec.ts`

Three new scenarios, using existing dev-only window hooks:

1. **"Other PDFs" surface**
   - Open a board and two PDFs; bind only one via the existing binding UI (or via `boardStore.addPdfBinding` test hook — add if missing).
   - Right-click a component; assert the menu has a bound-PDF entry for the bound one AND an "Other PDFs" section entry for the unbound one.
   - Click the "Other PDFs" entry; assert `pdfStore.activeFileName === <unboundName>` and the query is populated.

2. **Collapse umbrella at ≥3**
   - Open 1 board + 3 PDFs (none bound) so "Other PDFs" has 3 items.
   - Assert the menu renders a single `Other PDFs ▸` umbrella trigger, not three inline triggers.
   - Hover the umbrella; assert three per-item submenu triggers are revealed inside.
   - Same exercise for board tabs: open 4 boards and assert `Other Boards ▸` umbrella on tab 1.

3. **Scope badge renders on submenu triggers**
   - With 2 other boards + 2 unbound PDFs open, open the menu.
   - Assert board submenu triggers contain an element with class `toolbar-search-tag-board` and text `B`.
   - Assert PDF submenu triggers contain an element with class `toolbar-search-tag-pdf` and text `P`.
   - For the global search: type a query, open dropdown, assert badge elements render the same way (regression guard for the `SearchScopeBadge` refactor).

Existing donor-search tests (3 scenarios) remain and must continue to pass unchanged.

### Manual verification

- Open 3 boards + 4 PDFs with mixed bindings. Right-click on the active board's component:
  - Confirm "Bound PDFs ▸" umbrella if 3+ bound, else flat/per-item.
  - Confirm "Other PDFs" section lists the rest.
  - Confirm "Other Boards ▸" umbrella collapses the 2 others (or umbrella if ≥3).
  - Confirm every submenu trigger shows a `B` or `P` badge.
- Global toolbar search dropdown still shows the same badges (regression).

## Out of Scope

- **Keyboard navigation** of the context menu.
- **PDF right-click menu** (separate feature: "right-click PDF text → search in other PDFs"). The shared `SearchScopeBadge` and the grouping pattern will be reused when that spec is written.
- **Icon-based badges** (replacing "B" / "P" letters with icons). The shared component makes this a trivial follow-up; not in this spec.
- **Library group in the context menu.** The `library` scope exists in `SearchScopeBadge` to stay consistent with global search, but the right-click menu doesn't surface library results (there's no "donor library" workflow). Reserved in the type, not rendered here.

## Open Questions

None. All knobs are fixed: PDFs split into bound/other (answer B), collapse threshold N=2 (items ≤ 2 inline, ≥ 3 collapse), badge component shared across the app, badges only on submenu triggers (not on flat quick-search items whose text already signals scope).
