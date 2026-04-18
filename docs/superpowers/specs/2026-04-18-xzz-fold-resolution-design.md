# XZZ fold resolution UI + raw-layout mode

## Problem

The XZZ `.pcb` format stores every board side-by-side ("unfolded") rather than stacked. A single physical board's top and bottom halves appear as two mirror-image shapes next to each other. The parser's current `findFoldAxis` + mirror logic assumes every 2-component outline is a butterfly fold and collapses the halves. That assumption fails on real files:

- **4-component files** (`iPhone16E MB+SUB`, `iPhoneXS`) — two boards each with top+bottom halves. The heuristic picks *one* fold axis and mirrors incorrectly across unrelated features.
- **2-component files that are actually two boards** (multi-board assemblies, not butterfly) — the heuristic folds them together, mirroring real parts into nonexistent positions.
- **Genuine butterfly files** (`iPhone13Pro AP`, `iPhone16E AP/BB`) — the fold is correct, but the user has no way to verify or override.

The user needs a UI to see what the parser decided and override it when wrong. For the MVP, the only alternative to the auto-fold is "show all sides" — render every outline component at its raw file position, no mirroring. Manual pairing (e.g. "C0↔C1 is board A's top/bottom, C2↔C3 is board B's") is deferred.

## Scope

### In scope

- Parser (XZZ only) keeps enough pre-fold data on `BoardData` to render the raw unfolded layout without reparsing.
- `BoardTab` gains a `foldMode` field (`'suggested' | 'all-sides'`). Default = `'suggested'`.
- A new **Board folding** section appears at the top of the existing Layers tab in `BoardSidebar`. Shows: explanation text, outline-component summary, resolution radio group.
- `board-scene.ts` renders the raw outline and raw part/trace positions when `foldMode === 'all-sides'`. Side-based color distinction is dropped in that mode (all parts render in a neutral color).
- `BoardRenderer.ts` skips the board-side flip transform in `'all-sides'` mode (there is no single "back").
- `board-cache.ts` serializes the new raw fields; `PARSER_VERSION` bumps to 4.

### Out of scope

- Non-XZZ formats. CAD/TVW/Allegro don't share this ambiguity; their `butterflyFoldAxis` is either absent or deterministic from the file.
- Manual component pairing UI. The MVP only offers two presets (suggested vs. all-sides).
- Per-side visibility controls in `'all-sides'` mode (since side attribution is meaningless there).
- Changing `findFoldAxis` detection accuracy. The heuristic stays as-is; the UI compensates for its mistakes.

## Design

### Data model changes

`BoardData` gains three optional fields:

```ts
interface BoardData {
  // ...existing fields...

  /** Pre-fold outline geometry — included whenever the parser considered
   *  folding, regardless of whether it ultimately folded. Same NaN-break
   *  convention as `outline`. Absent for formats with no fold concept. */
  rawOutline?: Point[];

  /** Outline component bboxes from `clusterSegments()`. Displayed in the UI
   *  so the user can see how the parser decomposed the raw outline. Always
   *  in pre-fold coordinates. */
  foldComponents?: Array<{ minX: number; minY: number; maxX: number; maxY: number; segCount: number }>;

  /** Present if a fold was applied. Tells the renderer how to reverse the
   *  fold to get raw positions. */
  foldInfo?: {
    dim: 'x' | 'y';
    axis: number;                // mirror axis in pre-fold coords
    source: string;              // 'outline-components' | 'gap' | ... — for display
    summary: string;             // human-readable "paired C0↔C1 as butterfly"
  };
}
```

`Part` and `Pin` do **not** gain raw-position fields. Instead: at `'all-sides'` render time, each part whose `side === 'bottom'` is reversed in place using `foldInfo.dim` + `foldInfo.axis` before any scene-graph positioning. This is a single `position.x = 2 * axis - position.x` operation (the parser's fold is a pure reflection, trivially invertible). Same for trace endpoints.

### Parser changes ([xzz-parser.ts](src/frontend/src/parsers/xzz-parser.ts))

1. Build the full outline **before** the butterfly branch. Store it as `rawSegments` copy; run `chainByComponent` a second time on that copy to produce `rawOutline`.
2. Record each cluster's bbox into `foldComponents` (use the existing `clusterSegments` output — one additional loop).
3. When a fold is applied, attach `foldInfo = { dim: fold.dim, axis: fold.axis, source, summary }`. `summary` comes from the parser log we already emit.
4. Flat-path: `rawOutline` is still emitted (copy of `outline`); `foldComponents` populated; no `foldInfo`.

Cost: one extra `chainByComponent` call (O(N²) dominated, but outlines are small — ~300 segments is typical). Memory: `rawOutline` is a few KB per board.

### Renderer changes

**[board-scene.ts](src/frontend/src/renderer/board-scene.ts) `buildBoardScene(board, s)`**

Add an extra arg `opts: { foldMode: 'suggested' | 'all-sides' }` passed through from the caller. When `foldMode === 'all-sides'`:

- Use `board.rawOutline` (falls back to `board.outline` if absent).
- For each part with `side === 'bottom'`, compute unfolded origin via the inverse mirror, and lay out pins at their unfolded positions.
- Don't apply the top/bottom color distinction — everything renders in a single neutral shade (use the existing top color).
- Traces: same inverse-mirror if their midpoint is on the "bottom" side.

**[BoardRenderer.ts](src/frontend/src/renderer/BoardRenderer.ts)**

The board-side viewer flip (around lines 1189–1201) is gated on `foldMode === 'suggested'`. In `'all-sides'`, skip the flip transform; the raw layout is shown as-is.

**Rebuild trigger**

`foldMode` change triggers the same "full scene rebuild" path as format-specific visibility settings. Reuse the existing invalidation mechanism in `BoardRenderer`.

### Store changes ([board-store.ts](src/frontend/src/store/board-store.ts))

Add to `BoardTab`:

```ts
foldMode: 'suggested' | 'all-sides';
```

Default = `'suggested'`. New action:

```ts
setFoldMode(mode: 'suggested' | 'all-sides'): void
```

Tabs opened from cache restore `foldMode` from the cached value if present, else default to `'suggested'`.

### Cache changes ([board-cache.ts](src/frontend/src/store/board-cache.ts))

- Serialize `rawOutline`, `foldComponents`, `foldInfo` on the cached entry.
- Bump `PARSER_VERSION: 3 → 4` (new XZZ parser output shape).

### UI ([BoardSidebar.tsx](src/frontend/src/components/BoardSidebar.tsx))

Insert a **Board folding** section at the top of `LayersTab`, visible only when `board.format === 'XZZ'`:

```
Board folding
─────────────
XZZ .pcb files store top and bottom halves side-by-side instead of stacked — a
single board looks like two mirror-image rectangles next to each other. Files
can also hold several boards side-by-side. The parser picks a default; if it
looks wrong, switch to "Show all sides".

Detected outline components: 4
  • C0  660 × 3112 mils
  • C1  660 × 3112 mils
  • C2  660 × 2946 mils
  • C3  660 × 2946 mils

Resolution:
  ⦿ Suggested — paired two components as butterfly (X fold @ 5080 mils)
  ⦾ Show all sides — render every component at its raw position, no mirroring
```

The "Suggested" label's one-line description comes from `board.foldInfo?.summary` (or "no fold applied" when fold wasn't detected). The radio group dispatches `boardStore.setFoldMode(...)`.

Styling reuses existing `.layer-list-*` CSS patterns with a new `.fold-section` wrapper. Components list is rendered as a small muted monospace list.

### Explanation text

One paragraph, ~50 words:

> XZZ `.pcb` files store top and bottom halves side-by-side instead of stacked — a single board looks like two mirror-image rectangles next to each other. Files can also hold several boards side-by-side. The parser picks a default; if it looks wrong, switch to "Show all sides".

### Error handling

- If `board.rawOutline` is absent (e.g. legacy cache pre-bump), "Show all sides" falls back to `board.outline`. The parser always emits `rawOutline` going forward, so this only affects pre-v4 cache entries.
- If `foldComponents` is empty, the "Detected outline components" list renders nothing (gracefully).

## Testing

- **Unit-style (Node harness)**: extend the existing `render-xzz` helper to accept a `--mode all-sides` flag; verify the raw outline of `iPhone16E MB+SUB.pcb` contains 4 components in their file positions (no mirroring).
- **Manual verification** against the 8 `.pcb` samples under `samples/BROKEN/PCB/`:
  - Flat files (`820-00165.pcb`) — both modes render identically.
  - Butterfly files (`iPhone13Pro AP`) — Suggested = one folded view; All-sides = two mirror-image halves visible.
  - Multi-board files (`iPhone16E MB+SUB`, `iPhoneXS`) — Suggested is demonstrably wrong (parts misaligned); All-sides shows all four rectangles with their parts in correct relative positions.

Not adding a Playwright spec for this — the toggle is visual and the sample files aren't in the public samples dir.

## Open questions

None — the user confirmed (a) MVP has only two presets, (b) no side-based colouring in `'all-sides'` mode.

## Deferred

- Manual pairing UI for 4-component files ("C0↔C1 is board A, C2↔C3 is board B"). Revisit when users report that the auto-pairing still picks the wrong pair on a 4-component file.
- `findFoldAxis` accuracy improvements (the heuristic will keep misfiring on multi-board files; the UI workaround is the MVP fix).
- Extending this to non-XZZ formats if they grow fold ambiguities later.
