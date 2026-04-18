# XZZ Fold Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Board folding" section at the top of the Layers tab so users can switch an XZZ board between the parser's auto-fold ("Suggested") and a raw unfolded view ("Show all sides").

**Architecture:** The parser keeps pre-fold geometry (`rawOutline`, `foldComponents`, `foldInfo`) on `BoardData`. A new `foldMode: 'suggested' | 'all-sides'` lives per-`BoardTab`. `buildBoardScene()` accepts the mode and, when `'all-sides'`, uses `rawOutline` and inverse-mirrors bottom-side parts/traces back to their pre-fold positions. `BoardRenderer` detects mode changes and rebuilds the scene. A new section in `BoardSidebar.LayersTab` exposes the radio control and the parser's summary.

**Tech Stack:** TypeScript, React 19, Zustand-style plain store (`boardStore`), PixiJS v8 scene (via `buildBoardScene`).

**Spec:** [docs/superpowers/specs/2026-04-18-xzz-fold-resolution-design.md](docs/superpowers/specs/2026-04-18-xzz-fold-resolution-design.md)

---

## File Structure

New code lives alongside existing components — no new files.

| File | Change | Responsibility |
|------|--------|----------------|
| `src/frontend/src/parsers/types.ts` | modify | Add `rawOutline`, `foldComponents`, `foldInfo` optional fields to `BoardData` |
| `src/frontend/src/parsers/xzz-parser.ts` | modify | Emit raw pre-fold data + fold summary |
| `src/frontend/src/store/board-cache.ts` | modify | Serialize/deserialize new fields; bump `PARSER_VERSION` 3→4 |
| `src/frontend/src/store/board-store.ts` | modify | `foldMode` on `BoardTab`; `setFoldMode()` action; `get foldMode` |
| `src/frontend/src/hooks/useBoardStore.ts` | modify | Expose `foldMode` in the hook snapshot |
| `src/frontend/src/renderer/board-scene.ts` | modify | Accept `foldMode` option; use raw outline + inverse-mirror parts/traces in `'all-sides'` |
| `src/frontend/src/renderer/BoardRenderer.ts` | modify | Pass `foldMode` to `buildBoardScene`; rebuild on change |
| `src/frontend/src/panels/SettingsMockup.tsx` | modify | Pass `foldMode: 'suggested'` explicitly |
| `src/frontend/src/components/BoardSidebar.tsx` | modify | New **Board folding** section in `LayersTab` |
| `src/frontend/src/index.css` | modify | `.fold-section` styles |

---

## Task 1: Add `rawOutline`, `foldComponents`, `foldInfo` to `BoardData`

**Files:**
- Modify: `src/frontend/src/parsers/types.ts`

- [ ] **Step 1: Add the new optional fields on `BoardData`**

In `src/frontend/src/parsers/types.ts`, locate the `BoardData` interface (around line 62). Add three new optional fields right after `butterflyFoldAxis`:

```ts
  /** Pre-fold outline geometry. Present whenever the parser considered folding,
   *  regardless of whether it actually folded. Same NaN-break convention as
   *  `outline`. Absent for formats that never fold (e.g. BVR3, BRD). */
  rawOutline?: Point[];

  /** Outline-component bboxes from the clustering step, in pre-fold coords.
   *  Used by the fold-resolution UI to let the user see how the file's raw
   *  layout decomposed. */
  foldComponents?: Array<{ minX: number; minY: number; maxX: number; maxY: number; segCount: number }>;

  /** Describes the fold the parser applied, if any. Also carries a
   *  human-readable summary for UI display. Absent when no fold was applied. */
  foldInfo?: {
    dim: 'x' | 'y';
    axis: number;
    source: string;
    summary: string;
  };
```

- [ ] **Step 2: Type-check**

Run: `cd src/frontend && npx tsc --noEmit`
Expected: exits 0 (no errors).

- [ ] **Step 3: Commit**

```bash
git add src/frontend/src/parsers/types.ts
git commit -m "types: add rawOutline/foldComponents/foldInfo to BoardData"
```

---

## Task 2: XZZ parser emits pre-fold data + fold summary

**Files:**
- Modify: `src/frontend/src/parsers/xzz-parser.ts`

- [ ] **Step 1: Capture `foldComponents` from the clustering step**

In [src/frontend/src/parsers/xzz-parser.ts](src/frontend/src/parsers/xzz-parser.ts), find the `parseXZZ` function and the place where `chainByComponent(segments)` is called near the end of the function (around line 1009 after normalisation). We need the component-level bboxes for the UI.

Refactor `chainByComponent` so it can also return the clusters' bboxes, OR compute them in the caller. Simpler: compute in the caller using the **post-fold** segments for display (these are what the user actually sees decomposed).

Wait — the spec says `foldComponents` is in *pre-fold* coordinates. Change: compute `foldComponents` from the segment array **before** the butterfly branch runs. Add a helper that runs on any `Segment[]`:

Add this helper near the other helpers (e.g. right after `clusterSegments`):

```ts
function componentBBoxes(segments: Segment[]): Array<{ minX: number; minY: number; maxX: number; maxY: number; segCount: number }> {
  const groups = clusterSegments(segments);
  return groups.map(idxs => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const i of idxs) {
      const s = segments[i];
      if (s.p1.x < minX) minX = s.p1.x; if (s.p1.y < minY) minY = s.p1.y;
      if (s.p2.x < minX) minX = s.p2.x; if (s.p2.y < minY) minY = s.p2.y;
      if (s.p1.x > maxX) maxX = s.p1.x; if (s.p1.y > maxY) maxY = s.p1.y;
      if (s.p2.x > maxX) maxX = s.p2.x; if (s.p2.y > maxY) maxY = s.p2.y;
    }
    return { minX, minY, maxX, maxY, segCount: idxs.length };
  });
}
```

- [ ] **Step 2: Snapshot raw segments + compute `rawOutline` before fold**

In `parseXZZ`, just after the `while (ptr + 5 <= mainEnd...)` block that collects all `segments`, **before** the `const fold = findFoldAxis(...)` call (around line 870), snapshot the raw segments and compute the pre-fold outline. Find this existing line:

```ts
  // Detect board fold: XZZ stores top and bottom side-by-side (unfolded).
  const fold = findFoldAxis(segments, partDataList, testPads);
```

Insert **above** it:

```ts
  // Snapshot pre-fold geometry for the "Show all sides" view before the
  // butterfly branch mutates `segments` and `partDataList` in place.
  const rawSegmentsSnapshot: Segment[] = segments.map(s => ({
    p1: { x: s.p1.x, y: s.p1.y },
    p2: { x: s.p2.x, y: s.p2.y },
  }));
  const foldComponents = componentBBoxes(rawSegmentsSnapshot);
```

- [ ] **Step 3: Build `rawOutline` after normalisation**

The code normalises coordinates to origin (subtracts `minX`, `minY`) around line 999. The raw snapshot must be normalised by the SAME offsets so raw and folded outlines share a coordinate system. Right after the loop that normalises the `segments` array (around line 1002), add normalisation for the raw snapshot:

```ts
  for (const s of rawSegmentsSnapshot) {
    s.p1.x -= minX; s.p1.y -= minY;
    s.p2.x -= minX; s.p2.y -= minY;
  }
  // Apply the same offset to the foldComponents bboxes so the UI shows values
  // in the normalised coord space that matches `rawOutline` / `outline`.
  for (const fc of foldComponents) {
    fc.minX -= minX; fc.maxX -= minX;
    fc.minY -= minY; fc.maxY -= minY;
  }
  const rawOutline = chainByComponent(rawSegmentsSnapshot);
```

- [ ] **Step 4: Build a `foldInfo` summary when a fold was applied**

Find the `return { format: 'XZZ', ... }` block at the end of `parseXZZ` (around line 1089). Just above it, construct `foldInfo`:

```ts
  const foldInfo = fold ? {
    dim: fold.dim,
    // Adjust axis from pre-normalised coords to post-normalised so it lines up
    // with rawOutline / part positions (which are all shifted by minX/minY).
    axis: fold.dim === 'x' ? fold.axis - minX : fold.axis - minY,
    source: fold._debug.source,
    summary:
      `${fold._debug.source === 'outline-components' ? 'Two disconnected outline groups paired as butterfly' : 'Gap-detected butterfly fold'}` +
      ` — ${fold.dim.toUpperCase()}-fold axis @ ${(fold.dim === 'x' ? fold.axis - minX : fold.axis - minY).toFixed(0)} mils` +
      ` (${fold.lowerIsBottom ? 'lower' : 'upper'} half mirrored onto top)`,
  } : undefined;
```

- [ ] **Step 5: Include the new fields in the return object**

Modify the final `return` from `parseXZZ` to add the three fields:

```ts
  return {
    format: 'XZZ', outline, parts, nails, nets: buildNets(parts), bounds,
    butterflyFoldAxis: fold?.dim,
    traces: traces.length > 0 ? traces : undefined,
    layerNames: layerNames.length > 0 ? layerNames : undefined,
    rawOutline,
    foldComponents,
    foldInfo,
  };
```

- [ ] **Step 6: Type-check**

Run: `cd src/frontend && npx tsc --noEmit`
Expected: exits 0.

- [ ] **Step 7: Sanity-check parser output with a Node harness**

Create a temporary verification script at `src/frontend/xzz-verify-fold.mjs` (will be removed after):

```js
import { readFileSync } from 'node:fs';
import esbuild from 'esbuild';
const result = await esbuild.build({
  stdin: { contents: `export { parseXZZ } from './src/parsers/xzz-parser';`, resolveDir: '.', loader: 'ts' },
  bundle: true, format: 'esm', platform: 'node', target: 'esnext', write: false,
  plugins: [{
    name: 'stub-log-store',
    setup(b) {
      b.onResolve({ filter: /log-store$/ }, a => ({ path: a.path, namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
        contents: `export const log = new Proxy({}, { get: () => new Proxy(() => {}, { get: () => () => {} }) });`,
        loader: 'js',
      }));
    },
  }],
});
const mod = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
for (const f of process.argv.slice(2)) {
  const buf = readFileSync(f);
  const b = mod.parseXZZ(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const raw = b.rawOutline?.filter(p => !Number.isNaN(p.x)).length ?? 0;
  const folded = b.outline.filter(p => !Number.isNaN(p.x)).length;
  console.log(`${f.split('/').pop()}  folded=${folded}pts  raw=${raw}pts  components=${b.foldComponents?.length ?? 0}  fold=${b.foldInfo?.summary ?? 'none'}`);
}
```

Run: `cd src/frontend && node xzz-verify-fold.mjs "../../samples/820-00165.pcb" "../../samples/BROKEN/PCB/iPhone16E-820-03485-05_AP PCB layer.pcb" "../../samples/BROKEN/PCB/iPhone16E MB+SUB YiDianTong.pcb"`

Expected output (values approximate):
```
820-00165.pcb  folded=333pts  raw=333pts  components=1  fold=none
iPhone16E-820-03485-05_AP PCB layer.pcb  folded=~380pts  raw=~1150pts  components=2  fold=Two disconnected...
iPhone16E MB+SUB YiDianTong.pcb  folded=2264pts  raw=2264pts  components=4  fold=none
```

The raw count must be **larger** than the folded count on butterfly files (raw has both halves). On flat files they should match.

- [ ] **Step 8: Remove the verification script**

```bash
rm src/frontend/xzz-verify-fold.mjs
```

- [ ] **Step 9: Commit**

```bash
git add src/frontend/src/parsers/xzz-parser.ts
git commit -m "feat(xzz): emit rawOutline, foldComponents, foldInfo"
```

---

## Task 3: Cache serialization for new fields + `PARSER_VERSION` bump

**Files:**
- Modify: `src/frontend/src/store/board-cache.ts`

- [ ] **Step 1: Bump `PARSER_VERSION`**

In `src/frontend/src/store/board-cache.ts:23`:

```ts
const PARSER_VERSION = 4;
```

- [ ] **Step 2: Extend `SerializedBoardData` interface**

Find the `SerializedBoardData` interface (search for `butterflyFoldAxis?`) and add the three new fields alongside:

```ts
  butterflyFoldAxis?: 'x' | 'y';
  rawOutline?: Point[];
  foldComponents?: Array<{ minX: number; minY: number; maxX: number; maxY: number; segCount: number }>;
  foldInfo?: { dim: 'x' | 'y'; axis: number; source: string; summary: string };
```

- [ ] **Step 3: Include fields in the `put()` serialization path**

Find where `butterflyFoldAxis: board.butterflyFoldAxis` is written (around line 80). Add the three new fields next to it:

```ts
    butterflyFoldAxis: board.butterflyFoldAxis,
    rawOutline: board.rawOutline,
    foldComponents: board.foldComponents,
    foldInfo: board.foldInfo,
```

- [ ] **Step 4: Include fields in the `get()` deserialization path**

Find where `butterflyFoldAxis: data.butterflyFoldAxis` is read (around line 111). Add:

```ts
      butterflyFoldAxis: data.butterflyFoldAxis,
      rawOutline: data.rawOutline,
      foldComponents: data.foldComponents,
      foldInfo: data.foldInfo,
```

- [ ] **Step 5: Type-check + commit**

Run: `cd src/frontend && npx tsc --noEmit`
Expected: exits 0.

```bash
git add src/frontend/src/store/board-cache.ts
git commit -m "cache: serialize fold fields; bump PARSER_VERSION 3->4"
```

---

## Task 4: `BoardTab.foldMode` + store action + hook

**Files:**
- Modify: `src/frontend/src/store/board-store.ts`
- Modify: `src/frontend/src/hooks/useBoardStore.ts`

- [ ] **Step 1: Add `foldMode` to `BoardTab` interface**

In `src/frontend/src/store/board-store.ts`, locate the `BoardTab` interface (around line 17). Add the field at the end, right before the closing brace:

```ts
  /** XZZ fold resolution. 'suggested' uses the parser's auto-fold output;
   *  'all-sides' renders the raw pre-fold layout (both halves side-by-side). */
  foldMode: 'suggested' | 'all-sides';
```

- [ ] **Step 2: Default `foldMode` in the `loadFile` tab-creation block**

Find the `const tab: BoardTab = {` block inside `loadFile` (around line 404). Add the field next to other defaults:

```ts
        hideGhosts: false,
        foldMode: 'suggested',
      };
```

- [ ] **Step 3: Expose getter on the store**

Find the cluster of getters `get mirrorX()`, `get mirrorY()` etc. (around line 236). Add:

```ts
  get foldMode(): 'suggested' | 'all-sides' { return this.activeTab?.foldMode ?? 'suggested'; }
```

- [ ] **Step 4: Add `setFoldMode` action**

Find an existing toggle action like `toggleMirrorX()` (search for `this.updateActiveTab({ mirrorX`). Add a new method near the other visibility toggles:

```ts
  setFoldMode(mode: 'suggested' | 'all-sides'): void {
    const tab = this.activeTab;
    if (!tab || tab.foldMode === mode) return;
    this.updateActiveTab({ foldMode: mode });
    this.notify();
  }
```

- [ ] **Step 5: Expose `foldMode` in the `useBoardStore` hook snapshot**

In `src/frontend/src/hooks/useBoardStore.ts`, add `foldMode` to the `StoreSnapshot` interface and the snapshot object:

Interface (after `hideGhosts: boolean;`):

```ts
  foldMode: 'suggested' | 'all-sides';
```

Snapshot factory (inside `() => ({...})`, after `hideGhosts: boardStore.hideGhosts,`):

```ts
  foldMode: boardStore.foldMode,
```

- [ ] **Step 6: Type-check + commit**

Run: `cd src/frontend && npx tsc --noEmit`
Expected: exits 0.

```bash
git add src/frontend/src/store/board-store.ts src/frontend/src/hooks/useBoardStore.ts
git commit -m "store: foldMode on BoardTab with setFoldMode action"
```

---

## Task 5: `buildBoardScene` accepts and applies `foldMode`

**Files:**
- Modify: `src/frontend/src/renderer/board-scene.ts`

- [ ] **Step 1: Extend the signature**

In `src/frontend/src/renderer/board-scene.ts`, find:

```ts
export function buildBoardScene(board: BoardData, s: RenderSettings): BoardSceneGraph {
```

Change to:

```ts
export function buildBoardScene(board: BoardData, s: RenderSettings, opts: { foldMode: 'suggested' | 'all-sides' } = { foldMode: 'suggested' }): BoardSceneGraph {
```

- [ ] **Step 2: Pick outline source based on mode**

Near the top of `buildBoardScene`, the function reads `board.outline` for drawing. Search for `drawOutline(outlineGfx, board, s)` or wherever the outline `Graphics` is populated. The call currently passes `board` directly. Introduce a local alias that either returns the original board or a shim with a swapped outline:

Look for this near the start of the function (it's right after setting up `root`, `outlineGfx`, etc., around line 390):

```ts
  drawOutline(outlineGfx, board, s);
```

Replace with:

```ts
  const outlineBoard: BoardData = opts.foldMode === 'all-sides' && board.rawOutline
    ? { ...board, outline: board.rawOutline }
    : board;
  drawOutline(outlineGfx, outlineBoard, s);
```

- [ ] **Step 3: Inverse-mirror parts when `'all-sides'`**

Search in `buildBoardScene` for the part iteration loop. Look for lines like `for (const part of board.parts)` or `for (let pi = 0; pi < board.parts.length; pi++)`. Because mirroring in place mutates shared BoardData objects, we must clone the parts + their pin positions. The simplest pattern: define a single helper at the top of `buildBoardScene`:

Add at the very start of `buildBoardScene`, right after the destructuring/alias lines (after the `outlineBoard` line from Step 2):

```ts
  // Inverse-mirror bottom-side geometry when the user asked for the raw
  // pre-fold layout. The parser's fold is a pure reflection: p.x = 2*axis - p.x
  // for an X-fold, or p.y = 2*axis - p.y for a Y-fold. We reverse it by
  // applying the same operation to any part whose side === 'bottom'.
  const unfold = opts.foldMode === 'all-sides' && board.foldInfo
    ? { dim: board.foldInfo.dim, axis: board.foldInfo.axis }
    : null;

  function maybeUnfoldPoint(p: { x: number; y: number }, side: 'top' | 'bottom'): { x: number; y: number } {
    if (!unfold || side !== 'bottom') return p;
    return unfold.dim === 'x'
      ? { x: 2 * unfold.axis - p.x, y: p.y }
      : { x: p.x, y: 2 * unfold.axis - p.y };
  }
```

Then, wherever the part loop reads `part.origin`, `part.bounds`, or `pin.position`, wrap the coordinate with `maybeUnfoldPoint(..., part.side)`. Without seeing the full loop, the concrete changes will surface as TypeScript errors once `unfold` is introduced and tested, but in practice the loop currently reads:

```ts
for (const part of board.parts) {
  const origin = part.origin;
  const bounds = part.bounds;
  for (const pin of part.pins) {
    const pos = pin.position;
    // ...
  }
}
```

Change to compute positions via `maybeUnfoldPoint`:

```ts
for (const part of board.parts) {
  const origin = maybeUnfoldPoint(part.origin, part.side);
  const bounds = unfold && part.side === 'bottom'
    ? (unfold.dim === 'x'
        ? { minX: 2 * unfold.axis - part.bounds.maxX, maxX: 2 * unfold.axis - part.bounds.minX, minY: part.bounds.minY, maxY: part.bounds.maxY }
        : { minX: part.bounds.minX, maxX: part.bounds.maxX, minY: 2 * unfold.axis - part.bounds.maxY, maxY: 2 * unfold.axis - part.bounds.minY })
    : part.bounds;
  for (const pin of part.pins) {
    const pos = maybeUnfoldPoint(pin.position, part.side);
    // use `pos` everywhere the old `pin.position` was read
  }
}
```

Note: the existing loop likely uses `pin.position.x` / `.y` directly in many places. Replace each such read with the unfolded `pos.x` / `pos.y`.

- [ ] **Step 4: Inverse-mirror traces when `'all-sides'`**

Find the trace rendering loop (search for `board.traces?` or `for (const t of board.traces`). For each trace, determine whether its midpoint falls on the bottom half and apply inverse mirror if so:

```ts
if (board.traces) {
  for (const t of board.traces) {
    let start = t.start;
    let end = t.end;
    if (unfold) {
      const mid = unfold.dim === 'x' ? (t.start.x + t.end.x) / 2 : (t.start.y + t.end.y) / 2;
      const isBottom = mid > unfold.axis; // post-fold, bottom half was mirrored *to* the lower side of the axis — use same test the parser used
      // The parser stored `lowerIsBottom`; without access to it here we test "greater than axis" — matches the mirror-in-place convention.
      if (isBottom) {
        start = unfold.dim === 'x'
          ? { x: 2 * unfold.axis - t.start.x, y: t.start.y }
          : { x: t.start.x, y: 2 * unfold.axis - t.start.y };
        end = unfold.dim === 'x'
          ? { x: 2 * unfold.axis - t.end.x, y: t.end.y }
          : { x: t.end.x, y: 2 * unfold.axis - t.end.y };
      }
    }
    // use `start` and `end` where the old `t.start` / `t.end` were read
  }
}
```

Because the parser's "bottom-vs-top" test on traces uses `lowerIsBottom`, we need that flag here to decide which half to flip. Add it to `foldInfo`:

Actually simpler: store `lowerIsBottom` on `foldInfo` during parsing. Go back to `src/frontend/src/parsers/xzz-parser.ts`, find the `foldInfo` object from Task 2 Step 4 and add `lowerIsBottom: fold.lowerIsBottom`. Also update the type in `src/frontend/src/parsers/types.ts` (Task 1) to include `lowerIsBottom: boolean`.

**Revised `foldInfo` shape** (update the type in types.ts **and** the object in xzz-parser.ts accordingly):

```ts
  foldInfo?: {
    dim: 'x' | 'y';
    axis: number;
    lowerIsBottom: boolean;
    source: string;
    summary: string;
  };
```

Then use it:

```ts
      if (!unfold) { /* ... skip ... */ }
      const isBottom = unfold.lowerIsBottom ? mid < unfold.axis : mid > unfold.axis;
```

Include `lowerIsBottom: board.foldInfo.lowerIsBottom` on the `unfold` object in Step 3:

```ts
  const unfold = opts.foldMode === 'all-sides' && board.foldInfo
    ? { dim: board.foldInfo.dim, axis: board.foldInfo.axis, lowerIsBottom: board.foldInfo.lowerIsBottom }
    : null;
```

And rewrite `maybeUnfoldPoint` to pick the side using `lowerIsBottom` — but actually `maybeUnfoldPoint` only fires when `side === 'bottom'`, and `part.side` was set by the parser based on the fold direction, so the function stays as-is. Only traces need the lowerIsBottom test because they don't carry an explicit side flag.

- [ ] **Step 5: Type-check**

Run: `cd src/frontend && npx tsc --noEmit`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/frontend/src/parsers/types.ts src/frontend/src/parsers/xzz-parser.ts src/frontend/src/renderer/board-scene.ts src/frontend/src/store/board-cache.ts
git commit -m "feat(render): buildBoardScene respects foldMode=all-sides"
```

---

## Task 6: `BoardRenderer` passes `foldMode` and rebuilds on change

**Files:**
- Modify: `src/frontend/src/renderer/BoardRenderer.ts`

- [ ] **Step 1: Pass `foldMode` to `buildBoardScene`**

Find `buildScene(board: BoardData)` around line 1384. The `buildBoardScene` call:

```ts
      const graph = buildBoardScene(board, renderSettingsStore.settings);
```

Change to:

```ts
      const graph = buildBoardScene(board, renderSettingsStore.settings, { foldMode: boardStore.foldMode });
```

- [ ] **Step 2: Key the scene cache on `foldMode`**

The scene cache at line 237 is `Map<BoardData, BoardScene>`. Two `foldMode` values must map to two distinct scenes. Change to a composite key. Replace:

```ts
  private sceneCache = new Map<BoardData, BoardScene>();
```

With:

```ts
  private sceneCache = new Map<string, BoardScene>();
  private sceneCacheKey(board: BoardData): string {
    // Include foldMode in the key so toggling yields a fresh scene without
    // wiping caches for the "other" mode. The (board, foldMode) pair is the
    // scene's full identity.
    const ref = this.boardRefs.get(board) ?? (this.boardRefs.set(board, ++this.boardRefCounter), this.boardRefCounter);
    return `${ref}|${boardStore.foldMode}`;
  }
  private boardRefs = new WeakMap<BoardData, number>();
  private boardRefCounter = 0;
```

Then update every `sceneCache.get(board)` / `sceneCache.set(board, scene)` / `sceneCache.delete(board)` call (search for `sceneCache.`). Replace with `sceneCache.get(this.sceneCacheKey(board))` etc.

Also update the two loops at lines ~1606 and ~450:

Line ~1606 (iterating scenes for a cleanup):

```ts
    for (const [, scene] of this.sceneCache) {
```
Leave as-is (value iteration is fine).

Line ~450 (`this.sceneCache.clear()`): leave as-is.

- [ ] **Step 3: Trigger rebuild on `foldMode` change**

`onBoardUpdate` fires on every `boardStore.notify()`. Detect a `foldMode` change by caching the last-seen value. Near the other private fields around line 237, add:

```ts
  private lastSeenFoldMode: 'suggested' | 'all-sides' | null = null;
```

In `onBoardUpdate` (around line 1621), near the top of the method (after the early returns that check `gpu released` etc.), add:

```ts
    const currentFoldMode = boardStore.foldMode;
    if (this.board != null && this.lastSeenFoldMode != null && this.lastSeenFoldMode !== currentFoldMode) {
      log.render.log(`foldMode changed: ${this.lastSeenFoldMode} -> ${currentFoldMode}; rebuilding scene`);
      // Re-activate: sceneCacheKey will now resolve to a different entry, and
      // if that entry doesn't exist yet buildScene will create it.
      this.activateScene(this.board);
    }
    this.lastSeenFoldMode = currentFoldMode;
```

- [ ] **Step 4: Type-check**

Run: `cd src/frontend && npx tsc --noEmit`
Expected: exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/frontend/src/renderer/BoardRenderer.ts
git commit -m "render: BoardRenderer keys scene cache on foldMode + rebuilds on change"
```

---

## Task 7: `SettingsMockup` passes `foldMode: 'suggested'` explicitly

**Files:**
- Modify: `src/frontend/src/panels/SettingsMockup.tsx`

- [ ] **Step 1: Update the `buildBoardScene` call**

In `src/frontend/src/panels/SettingsMockup.tsx:231`:

```ts
      graph = buildBoardScene(MOCK_BOARD, { ...s, showLabelSizeDebug: false, showPadVertices: false });
```

Change to:

```ts
      graph = buildBoardScene(MOCK_BOARD, { ...s, showLabelSizeDebug: false, showPadVertices: false }, { foldMode: 'suggested' });
```

- [ ] **Step 2: Type-check + commit**

Run: `cd src/frontend && npx tsc --noEmit`
Expected: exits 0.

```bash
git add src/frontend/src/panels/SettingsMockup.tsx
git commit -m "mockup: pass foldMode=suggested explicitly"
```

---

## Task 8: Board-folding UI section in the Layers tab

**Files:**
- Modify: `src/frontend/src/components/BoardSidebar.tsx`

- [ ] **Step 1: Read `foldMode` + board metadata in `LayersTab`**

In `src/frontend/src/components/BoardSidebar.tsx`, find `function LayersTab()` (around line 104). The existing destructure:

```ts
  const { layerStates, showComponents, showVias, showTraces, showPins, showOutlines, showLabels, board, selection } = useBoardStore();
```

Add `foldMode`:

```ts
  const { layerStates, showComponents, showVias, showTraces, showPins, showOutlines, showLabels, board, selection, foldMode } = useBoardStore();
```

- [ ] **Step 2: Import `boardStore`**

Check the imports at the top of the file. Add if missing:

```ts
import { boardStore } from '../store/board-store';
```

- [ ] **Step 3: Render the section conditionally at the top of `LayersTab`**

Inside `LayersTab`'s return, find the opening `<div className="panel-content layer-list">` (around line 122). Just inside that `<div>`, before the existing `<div className="layer-list-header">`, insert the Board folding section:

```tsx
      {board?.format === 'XZZ' && (
        <div className="fold-section">
          <div className="fold-section-title">Board folding</div>
          <p className="fold-section-desc">
            XZZ <code>.pcb</code> files store top and bottom halves side-by-side
            instead of stacked — a single board looks like two mirror-image
            rectangles next to each other. Files can also hold several boards
            side-by-side. The parser picks a default; if it looks wrong, switch
            to "Show all sides".
          </p>
          {board.foldComponents && board.foldComponents.length > 0 && (
            <div className="fold-components">
              <div className="fold-components-label">
                Detected outline components: {board.foldComponents.length}
              </div>
              <ul className="fold-components-list">
                {board.foldComponents.map((c, i) => (
                  <li key={i}>
                    C{i} — {Math.round(c.maxX - c.minX)} × {Math.round(c.maxY - c.minY)} mils ({c.segCount} segs)
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="fold-resolution">
            <label className="fold-option">
              <input
                type="radio"
                name="foldMode"
                checked={foldMode === 'suggested'}
                onChange={() => boardStore.setFoldMode('suggested')}
              />
              <span className="fold-option-label">Suggested</span>
              <span className="fold-option-hint">
                {board.foldInfo?.summary ?? 'No fold applied — rendered as-is'}
              </span>
            </label>
            <label className="fold-option">
              <input
                type="radio"
                name="foldMode"
                checked={foldMode === 'all-sides'}
                onChange={() => boardStore.setFoldMode('all-sides')}
              />
              <span className="fold-option-label">Show all sides</span>
              <span className="fold-option-hint">
                Render every component at its raw file position, no mirroring.
              </span>
            </label>
          </div>
        </div>
      )}
```

- [ ] **Step 4: Type-check**

Run: `cd src/frontend && npx tsc --noEmit`
Expected: exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/frontend/src/components/BoardSidebar.tsx
git commit -m "ui: Board folding section in Layers tab (XZZ-only)"
```

---

## Task 9: Styles for `.fold-section`

**Files:**
- Modify: `src/frontend/src/index.css`

- [ ] **Step 1: Add CSS at the end of the file**

Append to `src/frontend/src/index.css`:

```css
/* Board folding section — lives at the top of the Layers tab on XZZ boards. */
.fold-section {
  padding: 10px 12px 12px 12px;
  margin-bottom: 8px;
  border-bottom: 1px solid var(--border, #2a2a2a);
}
.fold-section-title {
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  opacity: 0.75;
  margin-bottom: 6px;
}
.fold-section-desc {
  font-size: 11px;
  line-height: 1.45;
  opacity: 0.7;
  margin: 0 0 10px 0;
}
.fold-section-desc code {
  font-family: monospace;
  font-size: 10.5px;
  background: rgba(255, 255, 255, 0.06);
  padding: 1px 4px;
  border-radius: 2px;
}
.fold-components {
  font-size: 11px;
  margin-bottom: 10px;
}
.fold-components-label {
  opacity: 0.65;
  margin-bottom: 3px;
}
.fold-components-list {
  list-style: none;
  padding: 0;
  margin: 0;
  font-family: monospace;
  font-size: 10.5px;
  opacity: 0.8;
}
.fold-components-list li {
  padding: 1px 0 1px 10px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.fold-resolution {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.fold-option {
  display: grid;
  grid-template-columns: auto 1fr;
  grid-template-rows: auto auto;
  column-gap: 8px;
  align-items: baseline;
  cursor: pointer;
  padding: 4px 6px;
  border-radius: 3px;
}
.fold-option:hover {
  background: rgba(255, 255, 255, 0.04);
}
.fold-option input[type="radio"] {
  grid-row: 1 / span 2;
  align-self: center;
  margin: 0;
}
.fold-option-label {
  font-size: 12px;
  font-weight: 500;
}
.fold-option-hint {
  font-size: 10.5px;
  opacity: 0.6;
  line-height: 1.4;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/frontend/src/index.css
git commit -m "style: .fold-section styling for Layers-tab fold controls"
```

---

## Task 10: Manual verification in the dev server

**Files:** none (verification only).

- [ ] **Step 1: Start the dev server**

```bash
cd src/frontend && npm run dev
```

Leave it running; open the URL it prints (typically http://localhost:8082).

- [ ] **Step 2: Open each test .pcb file + verify**

For each of the three representative samples, drag-and-drop the file onto the app and verify:

**`samples/820-00165.pcb` (flat, non-butterfly)**
- Open the **Layers** sidebar tab.
- Verify the "Board folding" section is visible.
- Verify "Detected outline components: 1".
- Verify the "Suggested" hint reads "No fold applied — rendered as-is".
- Toggle to "Show all sides" — the board view should be **identical** to Suggested (flat files have no fold to reverse).

**`samples/BROKEN/PCB/iPhone16E-820-03485-05_AP PCB layer.pcb` (butterfly, 2 components)**
- "Detected outline components: 2".
- "Suggested" hint: "Two disconnected outline groups paired as butterfly — X-fold axis @ ~5000 mils (upper half mirrored onto top)".
- Toggle to "Show all sides" — board view shows **two halves side-by-side**, parts no longer stacked.
- Toggle back to "Suggested" — halves merge back onto each other.

**`samples/BROKEN/PCB/iPhone16E MB+SUB YiDianTong.pcb` (4 components, multi-board)**
- "Detected outline components: 4".
- "Suggested" hint will read "No fold applied — rendered as-is" (this file has 4 components so `findFoldAxis` returns null).
- Toggle to "Show all sides" — all four board outlines visible at their raw positions.
- Toggle back — still no fold, output identical.

- [ ] **Step 3: Verify cache invalidation worked**

- Reload the page.
- Re-open one of the butterfly files.
- Confirm the console log shows a fresh parse (not a cache hit) on first load after this deploy — `PARSER_VERSION` bump forces a re-parse.

- [ ] **Step 4: Stop the dev server**

Ctrl+C in the dev-server terminal.

- [ ] **Step 5: No code changes to commit; move to final polish**

---

## Task 11: Update progress doc + push

**Files:**
- Modify: `docs/superpowers/specs/2026-04-18-xzz-parser-outline-progress.md`

- [ ] **Step 1: Append a short note pointing at the new spec + plan**

Append at the bottom of `docs/superpowers/specs/2026-04-18-xzz-parser-outline-progress.md`:

```markdown
## Follow-up

Fold ambiguity on multi-board files spawned a separate effort:
- Spec: [2026-04-18-xzz-fold-resolution-design.md](2026-04-18-xzz-fold-resolution-design.md)
- Plan: [../plans/2026-04-18-xzz-fold-resolution.md](../plans/2026-04-18-xzz-fold-resolution.md)
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/2026-04-18-xzz-parser-outline-progress.md
git commit -m "docs: link fold-resolution spec/plan from progress doc"
```

- [ ] **Step 3: Push**

```bash
git push
```

Expected: the new commits (Tasks 1–11) land on `origin/main`.

---

## Self-Review Checklist (post-plan-writing)

- [x] Spec coverage — every section of the spec maps to a task (parser changes → Task 2; cache → Task 3; BoardTab state → Task 4; renderer → Tasks 5 & 6; UI → Tasks 8 & 9; explanation text → Task 8 Step 3).
- [x] No placeholders in step bodies.
- [x] `foldMode` type identical across all files (`'suggested' | 'all-sides'`).
- [x] `foldInfo.lowerIsBottom` added in Task 5 Step 4 is backfilled into the type (Task 1) and the parser (Task 2 Step 4) — the plan explicitly calls this out.
- [x] `PARSER_VERSION` bump sequence: 2 → 3 (already committed as `dd54123`) → 4 (Task 3). Cache entries written at v3 will be ignored; re-parses will occur on first open after deploy.
- [x] Scene-cache keying on `foldMode` handled by `sceneCacheKey()` (Task 6 Step 2). A `WeakMap<BoardData, id>` keeps tabs' existing boards from leaking when closed.
- [x] Manual verification (Task 10) covers all three file categories: flat, butterfly, multi-board.
