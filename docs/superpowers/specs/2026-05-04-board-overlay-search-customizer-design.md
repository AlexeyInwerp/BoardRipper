# Board Overlay: Parts/Nets Search Dropdowns + Customizable Toolbar

**Status:** Approved design, plan pending
**Date:** 2026-05-04
**Owner:** RipperDoc

## Summary

Two changes to the BoardViewer panel's floating overlay (today's `board-status-indicators` row):

1. Add **Parts** and **Nets** filter-as-you-type dropdowns plus a "selected component name" label below the row.
2. Make the overlay **customizable** — every button (existing toggles + new dropdowns) is a slot in an ordered list. Settings has a Chrome-toolbar-style customizer where the user drags slots between a **Visible** zone and a **Hidden** pool, and reorders within Visible.

The main app top toolbar (Open / Top / Bottom / rotation / mirror / global search / version badge) is **out of scope** — left untouched. The customizer infrastructure is built so it can be reused for the top toolbar later.

## Motivation

Current state:
- Selecting a component or net by name requires either clicking on the canvas (must already know where it is) or opening the right sidebar's Search tab.
- Settings cannot toggle which overlay buttons are shown — users who never use ghosts or net-lines still see the buttons.

The two dropdowns make canvas selection a one-step typed action. The customizer lets users shape the overlay to their workflow. Both are small UI changes; their combination defines a foundation (slot registry + DnD) we'll reuse for the main top toolbar in a later iteration.

## User flow

**Pick a part by name:**
1. Click `[Parts ▾]` in the overlay.
2. Popover opens with autofocused filter input + scrollable list (natural sort: `R1, R2, R10`).
3. Type a few characters → list filters live (case-insensitive substring).
4. Click a row (or Enter on the highlighted row).
5. Popover closes. Board flips side if needed, pan-zooms to fit the part (capped at 3× fit-to-board zoom). Part is highlighted on canvas. Selected name appears in the label below the overlay row.

**Pick a net by name:** identical, but NC nets are routed to a trailing greyed-out section under a `— No connect —` header.

**Customize the overlay (Settings → Board overlay):**
1. Live preview of the overlay row labelled "Visible".
2. Empty drop zone below labelled "Hidden".
3. Drag a chip from Visible down to Hidden → it disappears from the overlay.
4. Drag from Hidden back up to Visible at any insertion point → it returns at that position.
5. Drag within Visible → reorders slots.
6. `↺ Reset to defaults` link reverts layout to the canonical default (matches today's UI exactly).

## Data model

Three new fields on `renderSettingsStore` (already localStorage-backed via existing persistence path):

```ts
type OverlaySlotId =
  | 'pdfFollow' | 'scrollMode' | 'fitBoard'
  | 'hoverInfo' | 'netDim' | 'netLines' | 'ghosts'
  | 'partsDropdown' | 'netsDropdown'
  | 'sep1' | 'sep2';

interface OverlaySlot { id: OverlaySlotId; visible: boolean }

// New persisted fields
overlayLayout: OverlaySlot[];
overlaySelectedNameVisible: boolean;
overlayPartsOnSelect: 'highlight' | 'panIfOffscreen' | 'panZoomFit';
overlayNetsOnSelect:  'highlight' | 'panIfOffscreen' | 'panZoomFit';
```

**Default layout** (must reproduce today's UI exactly, including the visual gap between the existing two button groups):

```
[ pdfFollow, scrollMode, fitBoard,  sep1,
  hoverInfo, netDim, netLines, ghosts,  sep2,
  partsDropdown, netsDropdown ]
```

- `sep1` = the existing gap between today's two button groups (cosmetic spacer).
- `sep2` = a new gap separating toggle buttons from the search dropdowns.
- v1 forbids creating new separator slots (the two hardcoded ones suffice).

**Other defaults:**
- `overlaySelectedNameVisible: true`
- `overlayPartsOnSelect: 'panZoomFit'`
- `overlayNetsOnSelect: 'panZoomFit'`

## Overlay rendering

Replace the hand-written button JSX in `BoardViewerPanel.tsx`'s `board-status-indicators` block with a registry-driven walker:

```tsx
<div className="board-overlay-row">
  {overlayLayout
    .filter(s => s.visible)
    .map(s => <Fragment key={s.id}>{overlaySlotRenderers[s.id](ctx)}</Fragment>)}
</div>
{overlaySelectedNameVisible && <SelectedNameLabel tab={thisTab} />}
```

Each slot's existing JSX (`onClick`, `className`, icon, tooltip) is lifted into its own small component file under `src/frontend/src/components/overlay/slots/` — purely a code-move so the registry has clean handles. The registry maps slot IDs to render functions:

```ts
const overlaySlotRenderers: Record<OverlaySlotId, (ctx: SlotCtx) => React.ReactNode> = {
  pdfFollow:     (ctx) => <PdfFollowButton  ctx={ctx} />,
  scrollMode:    (ctx) => <ScrollModeButton ctx={ctx} />,
  fitBoard:      (ctx) => <FitBoardButton   ctx={ctx} />,
  hoverInfo:     (ctx) => <HoverInfoButton  ctx={ctx} />,
  netDim:        (ctx) => <NetDimButton     ctx={ctx} />,
  netLines:      (ctx) => <NetLinesButton   ctx={ctx} />,
  ghosts:        (ctx) => <GhostsButton     ctx={ctx} />,
  sep1:          ()    => <div className="overlay-sep" aria-hidden />,
  sep2:          ()    => <div className="overlay-sep" aria-hidden />,
  partsDropdown: (ctx) => <PartsDropdown    ctx={ctx} />,
  netsDropdown:  (ctx) => <NetsDropdown     ctx={ctx} />,
};

type SlotCtx = {
  thisTab: BoardTab;
  rendererRef: React.RefObject<BoardRenderer | null>;
  bareAction: 'pan' | 'zoom';
  linkedPdfsCount: number;
};
```

The visual gap between today's two button groups now flows from `sep1`/`sep2` rendering as a small horizontal spacer (e.g. `width: 12px`), not from JSX structure.

## Parts and Nets dropdowns

Both follow the same pattern: a small overlay button → click opens a popover with a search input on top of a virtualized-but-capped row list.

### Component shape

`<PartsDropdown ctx={ctx} />` and `<NetsDropdown ctx={ctx} />`:

- Button label: `Parts ▾` / `Nets ▾` (icon optional). The button label is generic — it does **not** reflect the current canvas selection (the selected-name label below covers that).
- Popover: 280px wide × max 400px tall. Anchored under the button. Closes on outside click, Esc, or row select.
- Filter input at top: autofocuses on open. Filter is case-insensitive substring. Clears when popover reopens (fresh search each time).
- List: rows below the input. Click → select. Hover → highlight row. ↑/↓ → move highlight. Enter → select highlighted row.

### Sort order

Natural sort (`R1, R2, R10` not `R1, R10, R2`). Implemented with a small comparator that splits each name into alpha/digit chunks and compares pairwise. Memoized per-board.

### NC-net handling

Nets list is partitioned into `{ normal: NetEntry[], nc: NetEntry[] }` during the per-board memoization step using the existing `isNcNet(name.toUpperCase(), renderSettings.ncNetPatterns)` matcher. Filter applies to both. Render order is `normal` items, then a header row (`— No connect —`, faint), then `nc` items styled with reduced opacity. NC nets stay clickable.

### What "select" does

Both dropdowns delegate the actual selection to an existing `boardStore` action, then run the on-select camera move:

```ts
function selectPartFromDropdown(partName: string) {
  const mode = renderSettingsStore.settings.overlayPartsOnSelect;
  if (mode === 'panZoomFit') {
    boardStore.focusPart(partName);            // existing — auto-flip, fit, highlight
  } else if (mode === 'panIfOffscreen') {
    const idx = findPartIdx(partName);
    boardStore.selectPart(idx);
    rendererRef.current?.panToPartIfOffscreen(idx);  // new helper
  } else {
    boardStore.selectPart(findPartIdx(partName));
  }
}

function selectNetFromDropdown(netName: string) {
  const mode = renderSettingsStore.settings.overlayNetsOnSelect;
  if (mode === 'panZoomFit') {
    boardStore.focusNet(netName);              // existing — fit-to-pin-bbox + highlight
  } else if (mode === 'panIfOffscreen') {
    boardStore.highlightNet(netName);
    rendererRef.current?.panToNetIfOffscreen(netName);  // new helper
  } else {
    boardStore.highlightNet(netName);
  }
}
```

This guarantees `panZoomFit` mode is byte-identical to the PDF search lookup behavior (which calls `findInBoardTab` → `focusPart` for parts; `focusNet` is the analogous net path).

### Performance

- **Pre-computed indexes per board.** A new helper `getOverlayIndex(board)` returns:
  ```ts
  { parts: { name, nameLower }[]; netsNormal: { name, nameLower }[]; netsNc: { name, nameLower }[] }
  ```
  All three arrays are **already natural-sorted and lowercased at memoization time** — filter is a single substring scan with no per-keystroke sort or `.toLowerCase()` cost. Memoized via a `WeakMap<BoardData, OverlayIndex>` so it's recomputed only when the board reference changes. NC partitioning runs once per board too, using the current `renderSettings.ncNetPatterns`; if those patterns change, the index for affected boards is invalidated (one-line listener on `renderSettingsStore`).
- **Filter is synchronous, O(n) substring scan.** Measured at <2ms for 10k items in Chrome.
- **Cap displayed rows to 500** with a footer `… and N more — refine your search` if exceeded. Avoids 10k DOM nodes; in practice, typing one character collapses the list well below the cap.
- **Popover only mounts when open.** The list isn't materialized until first click of the dropdown button.
- **No new dependency** (no `react-window` etc.).

### Zoom cap on `panZoomFit`

When applying a fit-zoom (whether via `focusPart`, `focusNet`, or future direct callers), clamp the resulting viewport scale to **at most 3× the fit-to-board scale**. For tiny components (a 0402 resistor) the natural fit would zoom to >50× and erase context; capping at 3× keeps surrounding board visible.

Implementation: add the clamp to `BoardRenderer`'s `_focusRequest` consumer, where the bounds-to-scale conversion happens. Single comparison: `targetScale = Math.min(naturalFitScale, 3 * fitToBoardScale)`. Affects all callers of `focusPart` / `focusNet`, including the existing PDF search lookup — desired, since that flow has the same "tiny component zooms too far" pitfall.

### `panIfOffscreen` helper

New `BoardRenderer` methods (≈30 LOC each):

```ts
panToPartIfOffscreen(partIndex: number): void
// Get part bbox from existing computePartRenderBounds.
// If any part of the bbox lies outside the visible viewport rect (with a
// small inset margin), translate the camera to center the bbox without
// changing scale. Otherwise no-op.

panToNetIfOffscreen(netName: string): void
// Same idea: gather pin coords for the net, compute bbox, pan-only if
// none of the pins are visible.
```

## Selected-name label

A small text line below the overlay row, rendered when:

```ts
overlaySelectedNameVisible && (selectedPart || selectedPin || highlightedNet)
```

Format (priority order):

| State            | Text                                        |
|------------------|---------------------------------------------|
| `selectedPin`    | `U21 · pin 3 → PP3V3_S0_REG`                |
| `selectedPart`   | `U21`                                       |
| `highlightedNet` | `PP3V3_S0_REG`                              |

Visual styling matches the existing overlay button label styling (same font weight, color, semi-transparent background) — picked up from the same CSS variables as `board-netlines-toggle`. Left-aligned, no border.

The StatusBar at the bottom of the app keeps showing the same info (canonical detail readout). The overlay label is a near-the-cursor glance; both can coexist.

## Settings UI: the customizer

A new collapsible section in `SettingsPanel.tsx` titled **"Board overlay"**, registered like the existing sections (with its own `SectionId`, `sectionRef`, persisted-open-state).

### 1 · Live customizer (Visible / Hidden)

Two stacked drop targets. Both render slot chips that look exactly like the live overlay buttons (same icon, same active/inactive coloring), but with no underlying click action — clicking a chip in the customizer is a no-op; only DnD does anything.

```
Visible (drag to reorder, drag down to hide)
┌──────────────────────────────────────────────────────────────┐
│ [⇶] [✋] [⌖] | [💬] [◐] [⤳] [👻] | [Parts ▾] [Nets ▾]      │
└──────────────────────────────────────────────────────────────┘

Hidden (drag up to restore)
┌──────────────────────────────────────────────────────────────┐
│  (empty)                                                      │
└──────────────────────────────────────────────────────────────┘
```

**Interaction model — drag-only (no click-to-toggle):**
- Drag a chip within Visible → reorders.
- Drag a chip from Visible into Hidden → that slot's `visible` flips to `false`.
- Drag a chip from Hidden into Visible at an insertion point → flips back to `visible: true`, position determined by drop point.
- Insertion-point indicator: a thin vertical highlight bar between chips, shown via `dragenter`/`dragleave` on per-gap dropzone elements.

**DnD library:** native HTML5 drag-and-drop API. No new dependency. ~80 LOC for the dropzone components and reorder logic. Tooltip on chips reads `"Drag to reorder · drag down to hide"`.

**Edge cases:**
- Hidden zone must always be visible (even when empty) so the user has a target to drop into. Empty state shows a faint placeholder: `"Drag a button here to hide it"`.
- Visible zone is allowed to be empty — user may hide everything. The Settings panel (reachable from the main top toolbar, which stays untouched) remains accessible, and the Reset link can restore the default layout.
- Separators (`sep1`, `sep2`) are draggable just like buttons. Hidden separators just don't render.

**Reset link:** `↺ Reset to defaults` at the bottom of the customizer. Resets **all four** new fields: `overlayLayout` → `DEFAULT_OVERLAY_LAYOUT`, `overlaySelectedNameVisible` → `true`, `overlayPartsOnSelect` → `'panZoomFit'`, `overlayNetsOnSelect` → `'panZoomFit'`. The other Settings sections (label sizes, NC patterns, etc.) are not touched.

### 2 · Selected-name label visibility

A single labeled checkbox below the customizer:

```
[✓] Show selected component name below overlay
```

Bound to `overlaySelectedNameVisible`.

### 3 · On-select behavior

Two segmented controls:

```
When you pick a part:    ( Just highlight | Pan if off-screen | Pan & zoom to fit )
When you pick a net:     ( Just highlight | Pan if off-screen | Pan & zoom to fit )
```

Bound to `overlayPartsOnSelect` and `overlayNetsOnSelect`. Defaults: both `panZoomFit`.

## Persistence & migration

The four new fields ride the existing `renderSettingsStore` localStorage persistence path — no separate storage key.

### Reconciliation on load

```ts
const KNOWN_SLOTS = new Set<OverlaySlotId>([
  'pdfFollow','scrollMode','fitBoard',
  'hoverInfo','netDim','netLines','ghosts',
  'partsDropdown','netsDropdown',
  'sep1','sep2',
]);

function reconcileOverlayLayout(saved: OverlaySlot[] | undefined): OverlaySlot[] {
  const seen = new Set<OverlaySlotId>();
  const out: OverlaySlot[] = [];

  // Keep saved order; drop unknown slot ids (handles future renames cleanly)
  for (const s of saved ?? []) {
    if (KNOWN_SLOTS.has(s.id) && !seen.has(s.id)) {
      out.push({ id: s.id, visible: !!s.visible });
      seen.add(s.id);
    }
  }

  // Append any default slot the user hasn't seen yet (handles upgrade paths
  // where we add new buttons after the user's layout was saved).
  for (const id of DEFAULT_OVERLAY_LAYOUT.map(s => s.id)) {
    if (!seen.has(id)) out.push({ id, visible: true });
  }

  return out;
}
```

### First-run

Missing saved value → write `DEFAULT_OVERLAY_LAYOUT` and the three default scalar values. The user sees today's UI byte-for-byte.

### Future schema changes

If we ever rename a slot (e.g. `'fitBoard'` → `'zoomToFit'`), the rename is added to a one-time migration map inside `reconcileOverlayLayout`. No version bump needed; the function is idempotent.

## Files touched

**New:**
- `src/frontend/src/components/overlay/slot-renderers.tsx` — registry of slot ID → render function.
- `src/frontend/src/components/overlay/slots/PdfFollowButton.tsx` (and 6 more — one per existing button, code-moved verbatim).
- `src/frontend/src/components/overlay/slots/PartsDropdown.tsx`, `NetsDropdown.tsx`, `SelectedNameLabel.tsx`.
- `src/frontend/src/components/overlay/dropdown-popover.tsx` — shared popover scaffold (input + list + keyboard nav).
- `src/frontend/src/components/overlay/get-overlay-index.ts` — memoized parts/nets pre-compute.
- `src/frontend/src/panels/settings/OverlayCustomizer.tsx` — DnD customizer + visibility checkbox + on-select segmented controls.

**Modified:**
- `src/frontend/src/panels/BoardViewerPanel.tsx` — replace the inline `board-status-indicators` JSX with the registry walker.
- `src/frontend/src/store/render-settings.ts` — add the four new fields, default values, reconcile-on-load.
- `src/frontend/src/renderer/BoardRenderer.ts` — add `panToPartIfOffscreen`, `panToNetIfOffscreen`, and the 3× zoom cap in the `_focusRequest` consumer.
- `src/frontend/src/panels/SettingsPanel.tsx` — register the new "Board overlay" section.
- One CSS file (likely `src/frontend/src/index.css` or a new `overlay.css`) — `.overlay-sep`, `.overlay-customizer-*`, dropdown popover styles.

## Out of scope

- Customizing the main app top toolbar (Open, Top/Bottom, rotation, mirror, traces, global search, version badge). The slot-registry + DnD code is built so it can be reused for that toolbar later, but it stays untouched in this iteration.
- Renaming or merging existing button labels.
- Per-board overlay layout (the layout is global / per-user, not per-tab).
- Adding extra separator slots (only `sep1` and `sep2` exist; user can hide them but not create more).

## Testing

- **Unit:** `reconcileOverlayLayout` — empty saved, partial saved, unknown slots, default-extension on upgrade.
- **Unit:** natural-sort comparator (`R1, R2, R10`) and NC partition (`isNcNet` matching).
- **Component (Playwright or Vitest):** dropdown filter behavior — substring match, NC nets at end and greyed, cap at 500 rows shows footer.
- **E2E (Playwright):** open a sample board, click Parts, type a refdes prefix, click a row → verify part is selected on canvas and viewport recenters with zoom ≤ 3× fit-to-board.
- **E2E:** open Settings → Board overlay, drag the Ghosts chip to Hidden → close Settings → verify Ghosts button no longer appears in overlay; reopen Settings, drag back, verify it returns.
- **E2E (regression):** loading a build with no saved overlay layout shows today's UI exactly (button count, order, gaps).
