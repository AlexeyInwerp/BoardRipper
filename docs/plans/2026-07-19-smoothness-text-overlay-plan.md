# Smoothness + Text-Overlay Rendering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the interaction-smoothness and FPS gap identified in
[docs/research/renderer-research-2026-07-19.md](../research/[external]-rendering-audit-2026-07-19.md)
by (1) eliminating pointer-move jank, (2) adopting exponential cursor-anchored
zoom tweening, and (3) moving board text off the PixiJS scene graph onto a
Canvas2D overlay that draws only visible labels.

**Architecture:** Three phases. Phase 0 records a reproducible perf baseline.
Phase 1 is surgical fixes inside `BoardRenderer.ts` plus two new pure modules
(`smooth-zoom.ts`, `trace-grid.ts`). Phase 2 adds a `LabelModel` emitted by
`buildBoardScene` *instead of* ~100k `BitmapText` nodes (gated by a new
`textFastMode` render setting), and a `LabelOverlay` class that draws
visible-only labels onto a DOM canvas layered above the Pixi canvas, redrawn
on viewport movement. **Text fast mode ships OPT-IN (default off, labeled
experimental) and stays opt-in until it has been debugged across many real
installs** — the BitmapText path remains the default renderer and the
SettingsMockup path; no default flip is part of this plan.

**Tech Stack:** TypeScript strict, PixiJS v8 + pixi-viewport v6, vitest
(`npm run test:unit`, node env, `src/**/*.test.ts`), Playwright
(`tests/*.spec.ts`, SwiftShader for PNG proof).

## Global Constraints

- Never call `app.destroy()`; never `BitmapFont.uninstall()` (CLAUDE.md invariants).
- `buildBoardScene()` stays pure — no store reads inside; it may only read its `s: RenderSettings` parameter.
- All new code uses scoped loggers (`log.render.*`, `log.perf.*`) — never `console.log`.
- Commit before deleting/replacing any block > 10 lines; commit at every green milestone.
- Working branch: `feature/smoothness-text-overlay` off `main`. Do not push unless asked.
- Run `npx tsc --noEmit` from `src/frontend/` before every commit (the project has no lint gate; strict TS is the gate).
- Playwright board-render specs need real board samples; the ~100-spec board/PDF cohort fails in default headless (no WebGL) — baseline-diff failure counts instead of expecting 0, and use SwiftShader flags for render-proof specs (see `tests/memory-release.spec.ts` for the flag pattern).
- Frontend dev server: `npm run dev` in `src/frontend/` (port 8082); backend not needed for these tasks.

## Schedule

| Days | Work | Milestone |
|---|---|---|
| 1 | Task 0 — perf baseline harness + numbers | Baseline table committed |
| 2–3 | Task 1 (hover rAF+memo), Task 2 (trace grid), Task 3 (B2 gate) | Idle-interaction jank gone |
| 4–5 | Task 4 — smooth zoom tween + calibration | **Release: smoothness** (`/release` bugfix bump) |
| 6–7 | Task 5 — LabelModel emission in buildBoardScene | Model built, flag off, scene unchanged by default |
| 8–10 | Task 6 (LabelOverlay class) + Task 7 (renderer integration) | Overlay working behind `textFastMode` setting |
| 11 | Task 8 — adaptive motion mode | Pan cost bounded on label-dense boards |
| 12–13 | Task 9 — Playwright + PNG verification | Visual parity proven |
| 14–15 | Task 10 — perf validation vs baseline, docs | **Release: Text fast mode (opt-in, experimental)** |

Total ≈ 3 working weeks. Phase 1 ships alone first — it is user-visible on its
own and de-risks the release cadence.

---

### Task 0: Perf baseline harness

**Files:**
- Create: `src/frontend/tests/perf-probe.spec.ts`
- Create: `docs/research/perf-baseline-2026-07-19.md` (numbers table, filled by hand from the spec output)

**Interfaces:**
- Produces: a repeatable Playwright spec that prints `PERF {json}` lines; Task 10 re-runs it unchanged for the after-comparison.

- [ ] **Step 1: Write the probe spec**

The spec loads a sample board, waits for the scene, then measures ticker FPS
during a scripted continuous pan and a scripted zoom-in at label-visible depth.
`window.__boardRenderer` is exposed in dev builds (BoardRenderer.ts:559-562),
and the Playwright config runs against the dev server.

```ts
// src/frontend/tests/perf-probe.spec.ts
import { test, expect } from '@playwright/test';
import * as path from 'path';

// SwiftShader so PixiJS gets a real (software) WebGL context in headless.
test.use({
  launchOptions: {
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  },
});

const SAMPLE = path.resolve(__dirname, '../../../samples/820-02016/820-02016.bvr');

async function measureFps(page: import('@playwright/test').Page, ms: number): Promise<number> {
  return page.evaluate(async (durationMs) => {
    const r = (window as any).__boardRenderer;
    const ticker = r.app.ticker;
    let frames = 0;
    const onTick = () => { frames++; };
    ticker.add(onTick);
    await new Promise(res => setTimeout(res, durationMs));
    ticker.remove(onTick);
    return frames / (durationMs / 1000);
  }, ms);
}

test('perf probe: pan + zoom FPS with labels visible', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  const input = page.locator('input[type="file"]').first();
  await input.setInputFiles(SAMPLE);
  // Board scene ready: canvas present and renderer exposed
  await page.waitForFunction(() => !!(window as any).__boardRenderer?.board, null, { timeout: 60_000 });
  await page.waitForTimeout(2_000);

  const canvas = page.locator('canvas').first();
  const box = (await canvas.boundingBox())!;
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;

  // Zoom in until pin labels are visible (LoD: fontSize * scale >= labelMinScreenPx)
  for (let i = 0; i < 12; i++) {
    await page.mouse.move(cx, cy);
    await page.mouse.wheel(0, -240);
    await page.waitForTimeout(120);
  }

  // Measure during continuous pan (mouse drag loop)
  const panPromise = (async () => {
    for (let rep = 0; rep < 4; rep++) {
      await page.mouse.move(cx - 200, cy);
      await page.mouse.down();
      for (let i = 0; i <= 20; i++) {
        await page.mouse.move(cx - 200 + i * 20, cy + Math.sin(i / 3) * 60, { steps: 1 });
        await page.waitForTimeout(16);
      }
      await page.mouse.up();
    }
  })();
  const panFps = await measureFps(page, 3_000);
  await panPromise;

  // Measure during wheel zoom bursts
  const zoomPromise = (async () => {
    for (let i = 0; i < 20; i++) {
      await page.mouse.wheel(0, i % 2 ? -180 : 180);
      await page.waitForTimeout(140);
    }
  })();
  const zoomFps = await measureFps(page, 2_500);
  await zoomPromise;

  console.log('PERF ' + JSON.stringify({ panFps: +panFps.toFixed(1), zoomFps: +zoomFps.toFixed(1) }));
  expect(panFps).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run it and record the numbers**

Run: `cd src/frontend && npx playwright test tests/perf-probe.spec.ts 2>&1 | grep PERF`
Expected: one `PERF {"panFps":…,"zoomFps":…}` line (absolute numbers are
machine-dependent; SwiftShader FPS is low — that's fine, we compare
before/after on the same machine).

- [ ] **Step 3: Record the baseline doc**

Create `docs/research/perf-baseline-2026-07-19.md` containing: the PERF line
for `820-02016.bvr`, plus (manually, dev server + real browser) the perf-HUD
readings (Settings ▸ Performance & Debug ▸ perf overlay) on the densest local
sample available (per CLAUDE.md samples: an NM-G611 TVW or LA-H271P if
present in `samples/`) at three depths: fit, mid-zoom-labels-visible, deep
zoom. Note browser + machine.

- [ ] **Step 4: Commit**

```bash
git checkout -b feature/smoothness-text-overlay
git add src/frontend/tests/perf-probe.spec.ts docs/research/perf-baseline-2026-07-19.md
git commit -m "test: perf baseline probe for smoothness work"
```

---

### Task 1: Hover — rAF coalescing, hover-key memo, tooltip measure cache

**Files:**
- Modify: `src/frontend/src/renderer/BoardRenderer.ts` (fields near :387; `boundHover` at :1316-1318 and :1085/:744; `handleHover` at :4885; `showTooltip` at :4955)

**Interfaces:**
- Consumes: existing `handleHover(e: PointerEvent)`, `showTooltip(x, y, info)`.
- Produces: `private hoverKey: string | null` — Task 2's `traceHitTest` change is independent but tested through the same hover path.

- [ ] **Step 1: Coalesce pointermove to one hover per frame**

At the field block (near :387) add:

```ts
  private hoverRafId: number | null = null;
  private lastHoverEvent: PointerEvent | null = null;
  private hoverKey: string | null = null;
  private tooltipSize: { w: number; h: number } | null = null;
```

Replace the `boundHover` assignment at :1316:

```ts
    this.boundHover = (e: PointerEvent) => {
      this.lastHoverEvent = e;
      if (this.hoverRafId !== null) return;           // already scheduled this frame
      this.hoverRafId = requestAnimationFrame(() => {
        this.hoverRafId = null;
        if (this.lastHoverEvent) this.handleHover(this.lastHoverEvent);
      });
    };
```

In `destroy()` (:5490) and `pause()` teardown paths, cancel the pending frame:

```ts
    if (this.hoverRafId !== null) { cancelAnimationFrame(this.hoverRafId); this.hoverRafId = null; }
```

- [ ] **Step 2: Skip content rewrites when the hover target is unchanged**

In `handleHover`, after `const hit = this.hitTest(world);` build a key and
early-out. The pin-hit branch (:4907) becomes:

```ts
    if (hit && hit.pinIndex >= 0) {
      const part = this.board.parts[hit.partIndex];
      const pin = part?.pins[hit.pinIndex];
      if (pin && part) {
        const key = `p${hit.partIndex}:${hit.pinIndex}`;
        if (key === this.hoverKey) {
          this.repositionTooltip(e.offsetX, e.offsetY);   // content unchanged — move only
          return;
        }
        this.hoverKey = key;
        // …existing showTooltip + setHoverNet call, unchanged…
```

Same pattern for the trace branch (`key = \`t${traceHit.traceIndex}\``) and
the miss path (`this.hoverKey = null;` before `hideTooltip()`).
`hideTooltip()` must also set `this.hoverKey = null` and
`this.tooltipSize = null` so a re-entry re-renders.

- [ ] **Step 3: Cache tooltip measurement; measure only on content change**

In `showTooltip` (:5003-5018), the current code writes `left/top='0'` then
reads `offsetWidth/offsetHeight` — a forced reflow per call. Replace the
measurement block: measure once after a content rewrite, cache, and add
`repositionTooltip`:

```ts
    el.style.display = 'block';
    const tw0 = el.offsetWidth;      // single measure after content change
    const th0 = el.offsetHeight;
    this.tooltipSize = { w: tw0, h: th0 };
    this.repositionTooltip(x, y);
  }

  /** Position the tooltip using the cached size — no layout reads. */
  private repositionTooltip(x: number, y: number) {
    const el = this.tooltipEl;
    const size = this.tooltipSize;
    if (!el || !size) return;
    const { w: tw, h: th } = size;
    const offset = 14;
    const cw = this.containerEl.clientWidth;
    const ch = this.containerEl.clientHeight;
    const left = Math.max(2, Math.min(x - tw / 2, cw - tw - 2));
    let top = y - th - offset;
    if (top < 2) top = y + offset;
    top = Math.max(2, Math.min(top, ch - th - 2));
    el.style.left = left + 'px';
    el.style.top = top + 'px';
  }
```

(The `left='0'/top='0'` pre-measure dance is deleted — measuring after
`display='block'` with final content gives the same numbers.
`containerEl.clientWidth/Height` are reads, but no write precedes them in
this path, so no forced synchronous layout.)

- [ ] **Step 4: Typecheck + manual verification**

Run: `cd src/frontend && npx tsc --noEmit`
Expected: clean.
Then `npm run dev`, load `samples/820-02016.bvr`, move the mouse across a
dense pin field with DevTools ▸ Performance recording: no per-move layout
(purple) blocks; tooltip still follows the cursor and updates on target
change; hover in ambient-dim mode still punches through (`setHoverNet` path
unchanged).

- [ ] **Step 5: Run affected Playwright specs**

Run: `npx playwright test tests/boardripper.spec.ts tests/context-menu-quick-actions.spec.ts 2>&1 | tail -5`
Expected: same pass/fail count as on `main` (headless WebGL caveat applies).

- [ ] **Step 6: Commit**

```bash
git add src/frontend/src/renderer/BoardRenderer.ts
git commit -m "perf(render): rAF-coalesced hover with target memo and cached tooltip measurement (audit A1)"
```

---

### Task 2: Trace spatial grid for `traceHitTest`

**Files:**
- Create: `src/frontend/src/renderer/trace-grid.ts`
- Create: `src/frontend/src/renderer/trace-grid.test.ts`
- Modify: `src/frontend/src/renderer/BoardRenderer.ts` (`traceHitTest` at :4835-4881; a `traceGridCache` field near the other caches at ~:504)

**Interfaces:**
- Produces: `buildTraceGrid(traces, cellSize) => TraceGrid`, `queryTraceGrid(grid, x, y, tol) => number[]` — consumed only by `traceHitTest`.

- [ ] **Step 1: Write the failing unit test**

```ts
// src/frontend/src/renderer/trace-grid.test.ts
import { describe, it, expect } from 'vitest';
import { buildTraceGrid, queryTraceGrid } from './trace-grid';

const seg = (x1: number, y1: number, x2: number, y2: number, width = 2) =>
  ({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, width });

describe('trace-grid', () => {
  it('returns candidates only near the segment', () => {
    const traces = [seg(0, 0, 100, 0), seg(0, 500, 100, 500)];
    const grid = buildTraceGrid(traces, 50);
    expect(queryTraceGrid(grid, 50, 2, 5)).toContain(0);
    expect(queryTraceGrid(grid, 50, 2, 5)).not.toContain(1);
    expect(queryTraceGrid(grid, 50, 498, 5)).toContain(1);
  });

  it('covers cells along a diagonal segment, not just endpoints', () => {
    const grid = buildTraceGrid([seg(0, 0, 400, 400)], 50);
    expect(queryTraceGrid(grid, 200, 205, 10)).toContain(0);
  });

  it('widens the query by tolerance + max half-width', () => {
    const grid = buildTraceGrid([seg(0, 100, 300, 100, 40)], 50);
    // point 30 units above the centerline: reachable because halfW(20)+tol(15)=35
    expect(queryTraceGrid(grid, 150, 70, 15)).toContain(0);
  });

  it('handles empty input', () => {
    const grid = buildTraceGrid([], 50);
    expect(queryTraceGrid(grid, 0, 0, 5)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd src/frontend && npx vitest run src/renderer/trace-grid.test.ts`
Expected: FAIL — cannot resolve `./trace-grid`.

- [ ] **Step 3: Implement the module**

```ts
// src/frontend/src/renderer/trace-grid.ts
/** Spatial hash for trace segments — parallels the part hitGrid
 *  (BoardRenderer.buildHitGrid) so hover misses stop scanning every trace
 *  (audit finding A2). Pure module: unit-tested in trace-grid.test.ts. */

export interface SegmentLike {
  start: { x: number; y: number };
  end: { x: number; y: number };
  width?: number;
}

export interface TraceGrid {
  cells: Map<string, number[]>;
  cellSize: number;
  /** Largest half-width across all segments — added to the query radius so a
   *  point inside a fat trace whose centerline is in a neighbouring cell is
   *  still found. */
  maxHalfWidth: number;
}

export function buildTraceGrid(traces: readonly SegmentLike[], cellSize: number): TraceGrid {
  const cells = new Map<string, number[]>();
  let maxHalfWidth = 0;
  for (let i = 0; i < traces.length; i++) {
    const t = traces[i];
    const halfW = (t.width || 1) / 2;
    if (halfW > maxHalfWidth) maxHalfWidth = halfW;
    const minX = Math.min(t.start.x, t.end.x) - halfW;
    const maxX = Math.max(t.start.x, t.end.x) + halfW;
    const minY = Math.min(t.start.y, t.end.y) - halfW;
    const maxY = Math.max(t.start.y, t.end.y) + halfW;
    const x0 = Math.floor(minX / cellSize), x1 = Math.floor(maxX / cellSize);
    const y0 = Math.floor(minY / cellSize), y1 = Math.floor(maxY / cellSize);
    for (let gx = x0; gx <= x1; gx++) {
      for (let gy = y0; gy <= y1; gy++) {
        const key = `${gx},${gy}`;
        let cell = cells.get(key);
        if (!cell) { cell = []; cells.set(key, cell); }
        cell.push(i);
      }
    }
  }
  return { cells, cellSize, maxHalfWidth };
}

/** Candidate segment indices within `tol` of (x, y). Deduplicated. */
export function queryTraceGrid(grid: TraceGrid, x: number, y: number, tol: number): number[] {
  const reach = tol + grid.maxHalfWidth;
  const x0 = Math.floor((x - reach) / grid.cellSize), x1 = Math.floor((x + reach) / grid.cellSize);
  const y0 = Math.floor((y - reach) / grid.cellSize), y1 = Math.floor((y + reach) / grid.cellSize);
  const seen = new Set<number>();
  for (let gx = x0; gx <= x1; gx++) {
    for (let gy = y0; gy <= y1; gy++) {
      const cell = grid.cells.get(`${gx},${gy}`);
      if (cell) for (const i of cell) seen.add(i);
    }
  }
  return Array.from(seen);
}
```

Note: segments are inserted by bounding box, which over-covers long diagonals'
corner cells — harmless (distance test filters) and keeps insertion simple.

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run src/renderer/trace-grid.test.ts`
Expected: 4 passed.

- [ ] **Step 5: Wire into `traceHitTest` with a per-board WeakMap cache**

In `BoardRenderer.ts`, add near the other caches (~:504):

```ts
  /** Lazy per-board trace spatial hash (audit A2). WeakMap so derived boards
   *  (fold/filter toggles) don't pin — see finding C1 for why not Map. */
  private traceGridCache = new WeakMap<BoardData, TraceGrid>();
```

with imports `import { buildTraceGrid, queryTraceGrid, type TraceGrid } from './trace-grid';`

In `traceHitTest` (:4835), replace the `for (let i = 0; i < this.board.traces.length; i++)` loop's index source:

```ts
    let grid = this.traceGridCache.get(this.board);
    if (!grid) {
      const b = this.board.bounds;
      const cellSize = Math.max(b.maxX - b.minX, b.maxY - b.minY, 1) / 50;
      grid = buildTraceGrid(this.board.traces, cellSize);
      this.traceGridCache.set(this.board, grid);
    }
    const candidates = queryTraceGrid(grid, local.x, local.y, pointerTol);

    let bestDist = Infinity;
    let bestIdx = -1;
    for (const i of candidates) {
      const t = this.board.traces[i];
      // …loop body unchanged from here (layer-visibility skip, distance test)…
```

- [ ] **Step 6: Typecheck + behavioral check**

Run: `npx tsc --noEmit`
Expected: clean.
Manual: load a TVW/Allegro sample with traces, hover a trace → tooltip shows
`trace · <layer>` exactly as before; hover empty space near a trace within
~8 px → still hits (tolerance preserved via `maxHalfWidth` + `tol` reach).

- [ ] **Step 7: Commit**

```bash
git add src/frontend/src/renderer/trace-grid.ts src/frontend/src/renderer/trace-grid.test.ts src/frontend/src/renderer/BoardRenderer.ts
git commit -m "perf(render): spatial hash for trace hover hit-testing (audit A2)"
```

---

### Task 3: Gate `rebuildLabelCounts` behind the perf overlay (B2)

**Files:**
- Modify: `src/frontend/src/renderer/BoardRenderer.ts` (:1660; perf-overlay live-sync at :3012-3020)

- [ ] **Step 1: Gate the call**

At :1660 change

```ts
    if (changed) this.rebuildLabelCounts(scene);
```

to

```ts
    if (changed && this.perfVisible) this.rebuildLabelCounts(scene);
```

- [ ] **Step 2: Refresh counts when the overlay turns on**

In `onSettingsUpdate` (:3012-3020), the `perfVisible` live-sync block — add an
else branch so opening the overlay starts from correct counts:

```ts
      if (this.perfVisible !== cur.showPerfOverlay) {
        this.perfVisible = cur.showPerfOverlay;
        if (!this.perfVisible && this.perfOverlayEl) {
          // …existing hide/reset block unchanged…
        } else if (this.perfVisible && this.activeScene) {
          this.rebuildLabelCounts(this.activeScene);
        }
      }
```

- [ ] **Step 3: Typecheck, verify, commit**

Run: `npx tsc --noEmit` → clean. Manual: toggle perf overlay on → label
counts populated; zoom across a LoD threshold with overlay off → no
`rebuildLabelCounts` hit (breakpoint or temporary `log.perf` line, removed
before commit).

```bash
git add src/frontend/src/renderer/BoardRenderer.ts
git commit -m "perf(render): skip label-count rebuild while perf overlay is closed (audit B2)"
```

---

### Task 4: Exponential cursor-anchored zoom tween

**Files:**
- Create: `src/frontend/src/renderer/smooth-zoom.ts`
- Create: `src/frontend/src/renderer/smooth-zoom.test.ts`
- Modify: `src/frontend/src/renderer/BoardRenderer.ts` (`zoomAtScreen` :2888; `installShiftWheelHandler` :2846-2880; `onTick` :571; keyboard zoom :5484; drag-zoom call :2953)
- Modify: `src/frontend/src/store/render-settings.ts` (new `smoothZoom: boolean`, default `true`)

**Interfaces:**
- Produces: `stepExpApproach(current, target, dtMs, rate) => number` (pure);
  `BoardRenderer.zoomAtScreen(screenX, screenY, rawDelta, smooth?: boolean, divisor?: number)`.
- `RenderSettings.smoothZoom: boolean` — read live at wheel/tick time. Add
  `'smoothZoom',` to the `INTERACTION_ONLY` set at :3027-3030 so toggling it
  never triggers a scene rebuild.

- [ ] **Step 1: Write the failing unit test**

```ts
// src/frontend/src/renderer/smooth-zoom.test.ts
import { describe, it, expect } from 'vitest';
import { stepExpApproach, ZOOM_TWEEN_RATE } from './smooth-zoom';

describe('stepExpApproach', () => {
  it('moves toward the target and converges', () => {
    let v = 1;
    for (let i = 0; i < 200; i++) v = stepExpApproach(v, 2, 16.7, ZOOM_TWEEN_RATE);
    expect(v).toBeCloseTo(2, 5);
  });

  it('is frame-rate independent: two 8ms steps ≈ one 16ms step', () => {
    const one = stepExpApproach(1, 2, 16, ZOOM_TWEEN_RATE);
    const two = stepExpApproach(stepExpApproach(1, 2, 8, ZOOM_TWEEN_RATE), 2, 8, ZOOM_TWEEN_RATE);
    expect(Math.abs(one - two)).toBeLessThan(1e-9);
  });

  it('snaps exactly onto the target within epsilon', () => {
    expect(stepExpApproach(1.99999, 2, 16, ZOOM_TWEEN_RATE)).toBe(2);
  });

  it('never overshoots', () => {
    expect(stepExpApproach(1, 2, 10_000, ZOOM_TWEEN_RATE)).toBeLessThanOrEqual(2);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/renderer/smooth-zoom.test.ts`
Expected: FAIL — cannot resolve `./smooth-zoom`.

- [ ] **Step 3: Implement the pure module**

```ts
// src/frontend/src/renderer/smooth-zoom.ts
/** Frame-rate-independent exponential approach used for wheel-zoom tweening.
 *  value' = value + (target − value) · (1 − e^(−dt·rate)); snaps within a
 *  relative epsilon so animations terminate exactly. Rate 18/s ≈ 60 ms to
 *  90% — matches the [external viewer] feel documented in
 *  docs/research/renderer-research-2026-07-19.md §1.6. */

export const ZOOM_TWEEN_RATE = 18;

export function stepExpApproach(current: number, target: number, dtMs: number, rate: number): number {
  const delta = target - current;
  const eps = Math.max(Math.abs(current) * 5e-4, 1e-6);
  if (Math.abs(delta) <= eps) return target;
  const k = 1 - Math.exp(-(dtMs / 1000) * rate);
  const next = current + delta * k;
  // A huge dt (tab was backgrounded) must not overshoot past the target.
  return delta > 0 ? Math.min(next, target) : Math.max(next, target);
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run src/renderer/smooth-zoom.test.ts`
Expected: 4 passed.

- [ ] **Step 5: Add the setting**

In `src/frontend/src/store/render-settings.ts`, next to `wheelSmooth`
(interface :268, defaults :550):

```ts
  /** Animated exponential wheel zoom (cursor-anchored tween). Off = legacy
   *  instant/pixi-viewport zoom. */
  smoothZoom: boolean;
```
```ts
  smoothZoom: true,
```

In `BoardRenderer.ts` add `'smoothZoom',` to the `INTERACTION_ONLY` set
(:3027-3030) so toggling it never triggers a scene rebuild.

- [ ] **Step 6: Add tween state + tick step to BoardRenderer**

Fields (near `zoomAnim`):

```ts
  /** Active wheel-zoom tween — exponential approach toward targetScale with
   *  the world point under the cursor pinned to its screen position. */
  private zoomTween: {
    targetScale: number;
    anchorScreenX: number; anchorScreenY: number;
    anchorWorldX: number; anchorWorldY: number;
  } | null = null;
```

In `onTick` (:571), insert BEFORE the `if (this.zoomAnim)` block:

```ts
    // Wheel-zoom tween (exponential, cursor-anchored) — see smooth-zoom.ts.
    if (this.zoomTween) {
      const t = this.zoomTween;
      const cur = Math.abs(this.viewport.scale.x);
      const next = stepExpApproach(cur, t.targetScale, ticker.deltaMS, ZOOM_TWEEN_RATE);
      this.viewport.scale.set(next, next);
      // Re-pin the anchored world point to its captured screen position.
      const sp = this.viewport.toScreen(t.anchorWorldX, t.anchorWorldY);
      this.viewport.x += t.anchorScreenX - sp.x;
      this.viewport.y += t.anchorScreenY - sp.y;
      this.needsRender = true;
      this.netLinesDirty = true;
      this.viewport.emit('moved', { viewport: this.viewport, type: 'animate' });
      if (next === t.targetScale) this.zoomTween = null;
    }
```

with imports `import { stepExpApproach, ZOOM_TWEEN_RATE } from './smooth-zoom';`.
(The scale-comparison block at :597-602 then fires `onZoomFrame()`
automatically — text-hide-during-zoom and net-line settle behavior come for
free. `pause()`/`destroy()` must clear `this.zoomTween = null` alongside
their existing zoomAnim handling; starting a programmatic `zoomAnim` must set
`this.zoomTween = null` and vice versa — find the `zoomAnim = {` assignment
site and add the clear there.)

- [ ] **Step 7: Route zoom entry points through the tween**

Change `zoomAtScreen` (:2888):

```ts
  private zoomAtScreen(screenX: number, screenY: number, rawDelta: number, smooth = false, divisor = 500): void {
    const factor = Math.pow(2, (1 + 0.3) * (-rawDelta / divisor));
    if (smooth && renderSettingsStore.settings.smoothZoom) {
      const base = this.zoomTween?.targetScale ?? Math.abs(this.viewport.scale.x);
      const world = this.viewport.toWorld(screenX, screenY);
      this.zoomTween = {
        targetScale: Math.max(0.001, Math.min(10, base * factor)),
        anchorScreenX: screenX, anchorScreenY: screenY,
        anchorWorldX: world.x, anchorWorldY: world.y,
      };
      this.zoomAnim = null;
      this.needsRender = true;
      return;
    }
    // …existing instant path unchanged (before/after toWorld + clamp)…
  }
```

Call-site updates:
- `installShiftWheelHandler` (:2865): `this.zoomAtScreen(e.offsetX, e.offsetY, raw, true)` — shift/safety-net zoom keeps divisor 500 (the documented slow speed).
- Keyboard zoom (:5484): `this.zoomAtScreen(cx, cy, rawDelta, true)`.
- Drag-zoom (:2953): unchanged (`smooth` defaults false — continuous gestures must track the pointer 1:1).
- NEW plain-wheel branch in `installShiftWheelHandler`, after the existing `else if (e.shiftKey && !s.twoFingerPan)` branch and before the final `else return;`:

```ts
      } else if (!e.shiftKey && !s.twoFingerPan && s.smoothZoom) {
        // Plain mouse-wheel zoom: intercept before pixi-viewport's frame-count
        // smoothing and run it through the exponential tween instead.
        this.zoomAtScreen(e.offsetX, e.offsetY, e.deltaY, true, WHEEL_DIVISOR);
      } else {
```

with a module-level `const WHEEL_DIVISOR = 350;` (calibrated next step).
Ctrl/Meta events still pass through untouched at :2853 — trackpad pinch stays
direct-proportional (CLAUDE.md: the two-speed + pinch behavior is deliberate).

- [ ] **Step 8: Calibrate WHEEL_DIVISOR against the old feel**

On `main` (git stash the work or use a second checkout), in the dev console:
`__boardRenderer.viewport.scale.x` before/after exactly one wheel notch
(deltaY = ±100 or ±120 depending on mouse) at rest. Compute
`ratio = after/before`. Then pick
`WHEEL_DIVISOR = (1.3 * Math.log(2) * 100) / Math.log(ratio)` (from
`ratio = 2^(1.3·100/divisor)`), rounded to the nearest 10. Update the
constant and note the measured ratio in a comment. Expected ballpark:
ratio ≈ 1.2–1.35 → divisor ≈ 300–490.

- [ ] **Step 9: Typecheck + unit + manual feel check**

Run: `npx tsc --noEmit && npx vitest run`
Expected: clean, all unit tests pass.
Manual (`npm run dev`): wheel zoom glides and lands under the cursor; rapid
multi-notch scroll composes into one accelerating glide (no stepping); shift
= slow glide; ctrl+wheel / trackpad pinch unchanged (direct); Settings ▸
`smoothZoom` off → exact legacy behavior; drag-zoom unchanged; keyboard zoom
glides; deceleration inertia after drag still works (tween and decelerate
never run simultaneously — decelerate acts on position, tween on scale, and
`emit('moved')` does not feed decelerate).

- [ ] **Step 10: Run the drag/zoom spec cohort**

Run: `npx playwright test tests/drag-to-zoom.spec.ts 2>&1 | tail -3`
Expected: same result as `main` baseline.

- [ ] **Step 11: Commit + cut the smoothness release**

```bash
git add src/frontend/src/renderer/smooth-zoom.ts src/frontend/src/renderer/smooth-zoom.test.ts \
        src/frontend/src/renderer/BoardRenderer.ts src/frontend/src/store/render-settings.ts
git commit -m "feat(render): exponential cursor-anchored wheel-zoom tween ([external] audit)"
```

Then (maintainer action): merge Phase 1 to `main` and cut a release via the
`/release` skill (bugfix bump per versioning convention).

---

### Task 5: LabelModel emission in `buildBoardScene`

**Files:**
- Create: `src/frontend/src/renderer/label-model.ts`
- Modify: `src/frontend/src/renderer/board-scene.ts` (part-label site :1675-1686; the deferred-text flush sites — search `deferredCircleNumTexts` / `deferredCircleNetTexts` / `deferredTwoPinNetTexts` and the pin-number/pin-net `BitmapText` creation sites in the flush functions around :1786-1828; `BoardSceneGraph` interface :284)
- Modify: `src/frontend/src/store/render-settings.ts` (new `textFastMode: boolean`, default `false` for now)
- Modify: `src/frontend/src/panels/SettingsMockup.tsx` (force-off override)

**Interfaces:**
- Produces:

```ts
// label-model.ts
export type LabelKind = 'part' | 'pinNum' | 'pinNet' | 'circleNum' | 'circleNet' | 'twoPinNet' | 'diode';
export interface LabelRecord {
  x: number; y: number;          // board/scene coords (same space BitmapText.x/y used)
  text: string;
  fontSize: number;              // same pre-quantization size the BitmapText would get
  color: number;                 // 0xRRGGBB
  kind: LabelKind;
  partIndex: number;             // -1 for labels with no owning part (via labels excluded from v1)
  anchorX: number; anchorY: number; // fraction of text box at (x,y) — matches BitmapText.anchor
}
export interface LabelModel { top: LabelRecord[]; bottom: LabelRecord[]; }
```

- `BoardSceneGraph.labelModel: LabelModel | null` — `null` when `s.textFastMode` is false.
- `RenderSettings.textFastMode: boolean`.
- Rule when `s.textFastMode === true`: every site that would create a part/pin/circle/two-pin-net/diode `BitmapText` pushes a `LabelRecord` instead and does NOT construct the BitmapText. Via labels (`viaLabels`) stay BitmapText in v1 (small count, layer-mode only).

- [ ] **Step 1: Add the types file and the setting**

Create `label-model.ts` with the exact interfaces above plus:

```ts
/** Sort in place so the overlay can batch ctx.font changes: kind, then
 *  fontSize descending (big labels first also gives painter's-order priority
 *  when a draw budget truncates). */
export function sortLabelModel(m: LabelModel): void {
  const cmp = (a: LabelRecord, b: LabelRecord) =>
    a.kind === b.kind ? b.fontSize - a.fontSize : a.kind.localeCompare(b.kind);
  m.top.sort(cmp);
  m.bottom.sort(cmp);
}
```

In `render-settings.ts` (next to `labelMinScreenPx` :120 / :486):

```ts
  /** Draw board text on a Canvas2D overlay instead of scene BitmapText.
   *  See docs/research/renderer-research-2026-07-19.md. */
  textFastMode: boolean;
```
```ts
  textFastMode: false,
```

(NOT in `INTERACTION_ONLY` — flipping it must trigger the scene rebuild path,
which it does by default.)

- [ ] **Step 2: Write the failing unit test for model emission**

`buildBoardScene` imports PixiJS, which vitest (node env) can load — follow
whatever pattern `src/renderer/hit-test-ranking.test.ts` uses to import
renderer code; if PixiJS import fails in node, test via a minimal fixture
board through a thin wrapper: extract the record-push decision into
`label-model.ts` as

```ts
export function pushLabel(model: LabelModel | null, side: 'top' | 'bottom', rec: LabelRecord): boolean {
  if (!model) return false;         // caller creates BitmapText as before
  (side === 'top' ? model.top : model.bottom).push(rec);
  return true;
}
```

and unit-test `pushLabel` + `sortLabelModel` directly:

```ts
// src/frontend/src/renderer/label-model.test.ts
import { describe, it, expect } from 'vitest';
import { pushLabel, sortLabelModel, type LabelModel } from './label-model';

describe('label-model', () => {
  it('pushLabel returns false with no model (BitmapText path)', () => {
    expect(pushLabel(null, 'top', { x: 0, y: 0, text: 'R1', fontSize: 8, color: 0xffffff, kind: 'part', partIndex: 0 })).toBe(false);
  });
  it('pushLabel routes by side and returns true', () => {
    const m: LabelModel = { top: [], bottom: [] };
    expect(pushLabel(m, 'bottom', { x: 1, y: 2, text: '5', fontSize: 4, color: 0xcccccc, kind: 'pinNum', partIndex: 3 })).toBe(true);
    expect(m.bottom).toHaveLength(1);
    expect(m.top).toHaveLength(0);
  });
  it('sortLabelModel groups by kind then size desc', () => {
    const m: LabelModel = {
      top: [
        { x: 0, y: 0, text: 'a', fontSize: 4, color: 0, kind: 'pinNum', partIndex: 0 },
        { x: 0, y: 0, text: 'b', fontSize: 9, color: 0, kind: 'part', partIndex: 1 },
        { x: 0, y: 0, text: 'c', fontSize: 8, color: 0, kind: 'pinNum', partIndex: 0 },
      ], bottom: [],
    };
    sortLabelModel(m);
    expect(m.top.map(r => r.text)).toEqual(['b', 'a', 'c']);
  });
});
```

Run: `npx vitest run src/renderer/label-model.test.ts` → FAIL (module missing) → implement → PASS.

- [ ] **Step 3: Thread the model through `buildBoardScene`**

At the top of `buildBoardScene` (:628, after locals are set up):

```ts
  const labelModel: LabelModel | null = s.textFastMode ? { top: [], bottom: [] } : null;
```

Part-label site (:1675-1686) — wrap the BitmapText construction:

```ts
        if (!pushLabel(labelModel, isBottom ? 'bottom' : 'top', {
          x: eb.px + eb.pw / 2, y: eb.py + eb.ph / 2,
          text: part.name, fontSize, color: labelColor, kind: 'part', partIndex: pi,
        })) {
          const label = new BitmapText({
            text:  part.name,
            style: { fontSize, fill: labelColor, fontFamily },
          });
          label.anchor.set(0.5, 0.5);
          label.x = eb.px + eb.pw / 2;
          label.y = eb.py + eb.ph / 2;
          partContainer.addChild(label);
          labels.push(label);
          (isBottom ? bottomLabels : topLabels).push(label);
          partLabelByIndex.set(pi, label);
        }
```

Then apply the same wrap at every other label BitmapText construction site.
Enumerate them by running `grep -n "new BitmapText" board-scene.ts` — for
each hit EXCEPT via labels (`viaLabels` push sites), wrap with `pushLabel`
using: the same x/y the BitmapText gets (note: deferred records carry their
x/y already — use those), the same fontSize/color, the correct `kind`
(`pinNum` for pin numbers, `pinNet` for pin net names, `circleNum`/`circleNet`
for the Group A texts, `twoPinNet` for Group B, `diode` for diode-value
labels), the owning `partIndex` (the deferred record structs carry the part
index or are pushed within the part loop — extend the deferred record structs
with `partIndex: number` where missing), and the side from the flush target
(`topGrid`→top etc.). The 2-pin net-label background wrapper Graphics
(rounded rect behind the text) is part of the label look — when the model is
active, skip creating the wrapper too, and let the overlay draw the backing
rect (Task 6 draws a rect behind `twoPinNet` records).

After the flush/bucketing phase, before the return (:2061):

```ts
  if (labelModel) sortLabelModel(labelModel);
```

Add `labelModel` to the `BoardSceneGraph` interface (:284) and the return
object (:2061):

```ts
  /** Canvas2D-overlay label records — non-null only when s.textFastMode.
   *  When set, part/pin/circle/two-pin/diode BitmapTexts were NOT created and
   *  the corresponding arrays/groups above are empty. */
  labelModel: LabelModel | null;
```

- [ ] **Step 4: Force the mockup onto the BitmapText path**

In `SettingsMockup.tsx`, find the `buildBoardScene(` call and spread-override
the settings argument: `{ ...s, textFastMode: false }` (the mockup has no
overlay canvas; shared-scene invariant preserved).

- [ ] **Step 4b: User-facing toggles in Settings ▸ Performance & Debug**

In the Settings panel component (find the section rendering the
`showPerfOverlay` checkbox — `grep -rn "showPerfOverlay" src/panels/`), add
two checkboxes following the exact same row pattern:
- "Text fast mode (experimental)" → `textFastMode` (help text: "Draw board
  text on a 2D overlay instead of in-scene text objects — faster on dense
  boards. Experimental: report rendering glitches.").
- "Smooth wheel zoom" → `smoothZoom` (Task 4's setting; add it here in the
  same edit; help text: "Animated cursor-anchored zoom").

- [ ] **Step 5: Typecheck + behavioral parity check**

Run: `npx tsc --noEmit && npx vitest run`
Expected: clean.
Manual: with `textFastMode` still default-false, load a board — identical to
before (screenshot compare vs `main` at one viewport). Then flip the setting
in Settings → board rebuilds with NO text anywhere (overlay comes in Task 7);
`applyLabelVisibility` no-ops on empty groups without errors; selection,
dim, flips all still work text-less.

- [ ] **Step 6: Commit**

```bash
git add src/frontend/src/renderer/label-model.ts src/frontend/src/renderer/label-model.test.ts \
        src/frontend/src/renderer/board-scene.ts src/frontend/src/store/render-settings.ts \
        src/frontend/src/panels/SettingsMockup.tsx
git commit -m "feat(render): emit LabelModel from buildBoardScene behind textFastMode setting"
```

---

### Task 6: `LabelOverlay` — canvas layer + visible-label selection

**Files:**
- Create: `src/frontend/src/renderer/label-overlay.ts`
- Create: `src/frontend/src/renderer/label-overlay.test.ts`

**Interfaces:**
- Consumes: `LabelModel`, `LabelRecord`, `LabelKind` from `./label-model`.
- Produces (consumed by Task 7):

```ts
export interface OverlayViewState {
  topMatrix: { a: number; b: number; c: number; d: number; tx: number; ty: number };    // scene.topLabelLayer.worldTransform
  bottomMatrix: { a: number; b: number; c: number; d: number; tx: number; ty: number }; // scene.bottomLabelLayer.worldTransform (butterflyRoot chain included automatically)
  scale: number;               // |viewport.scale.x|
  width: number; height: number;   // CSS px
  showTop: boolean; showBottom: boolean;
  selectedPartIndex: number | null;
  dimActive: boolean;          // ambient dim / search dim engaged
  litParts: ReadonlySet<number> | null;  // parts NOT dimmed when dimActive (null = only selection lit)
}
export interface OverlayThresholds { labelMinScreenPx: number; circleLabelMinScreenPx: number; twoPinLabelMinScreenPx: number; labelZoomHide: number; }
export function selectVisibleLabels(records: readonly LabelRecord[], m: OverlayViewState['topMatrix'], view: OverlayViewState, th: OverlayThresholds): LabelRecord[];
export class LabelOverlay {
  constructor(container: HTMLElement);
  readonly lastDrawMs: number;                    // EMA, for Task 8's adaptive mode
  readonly lastCounts: { visible: number; total: number };
  draw(model: LabelModel, view: OverlayViewState, th: OverlayThresholds): void;
  clear(): void;
  resize(): void;                                 // re-reads container size + devicePixelRatio
  setCssTransform(t: string): void;               // Task 8; '' resets
  destroy(): void;                                // removes the canvas from the DOM
}
```

- [ ] **Step 1: Write the failing test for `selectVisibleLabels`**

```ts
// src/frontend/src/renderer/label-overlay.test.ts
import { describe, it, expect } from 'vitest';
import { selectVisibleLabels, type OverlayViewState, type OverlayThresholds } from './label-overlay';
import type { LabelRecord } from './label-model';

const ident = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };
const view = (scale: number): OverlayViewState => ({
  topMatrix: ident, bottomMatrix: ident, scale, width: 800, height: 600,
  showTop: true, showBottom: true, selectedPartIndex: null, dimActive: false, litParts: null,
});
const th: OverlayThresholds = { labelMinScreenPx: 3, circleLabelMinScreenPx: 3, twoPinLabelMinScreenPx: 6, labelZoomHide: 0 };
const rec = (x: number, y: number, fontSize: number, kind: LabelRecord['kind'] = 'part'): LabelRecord =>
  ({ x, y, text: 'X', fontSize, color: 0xffffff, kind, partIndex: 0, anchorX: 0.5, anchorY: 0.5 });

describe('selectVisibleLabels', () => {
  it('culls off-screen records', () => {
    const out = selectVisibleLabels([rec(400, 300, 10), rec(5000, 300, 10)], ident, view(1), th);
    expect(out).toHaveLength(1);
  });
  it('culls below the per-kind min screen px', () => {
    // part: 10px*0.2=2 < 3 hidden; 10px*0.5=5 >= 3 visible
    expect(selectVisibleLabels([rec(400, 300, 10)], ident, view(0.2), th)).toHaveLength(0);
    expect(selectVisibleLabels([rec(400, 300, 10)], ident, view(0.5), th)).toHaveLength(1);
  });
  it('twoPinNet uses its own threshold', () => {
    // 10px*0.5=5 < 6 → hidden for twoPinNet, visible for part
    expect(selectVisibleLabels([rec(400, 300, 10, 'twoPinNet')], ident, view(0.5), th)).toHaveLength(0);
  });
  it('selected part bypasses LoD', () => {
    const v = { ...view(0.1), selectedPartIndex: 0 };
    expect(selectVisibleLabels([rec(400, 300, 10)], ident, v, th)).toHaveLength(1);
  });
  it('labelZoomHide hides everything below the zoom floor', () => {
    const out = selectVisibleLabels([rec(400, 300, 100)], ident, view(0.5), { ...th, labelZoomHide: 1 });
    expect(out).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/renderer/label-overlay.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```ts
// src/frontend/src/renderer/label-overlay.ts
/** Canvas2D board-text overlay — draws only on-screen, LoD-passing labels
 *  each redraw instead of keeping ~100k BitmapText nodes in the Pixi scene.
 *  Architecture: docs/research/renderer-research-2026-07-19.md §1.5.
 *  Pure selection logic is exported for unit tests; the class owns the
 *  canvas. Text draws upright in screen space (counter-flip machinery not
 *  needed); positions transform through the per-side label-layer world
 *  matrices so rotate/mirror/butterfly work unchanged. */
import type { LabelModel, LabelRecord } from './label-model';
import { log } from '../store/log-store';

export interface OverlayViewState {
  topMatrix: { a: number; b: number; c: number; d: number; tx: number; ty: number };
  bottomMatrix: { a: number; b: number; c: number; d: number; tx: number; ty: number };
  scale: number;
  width: number; height: number;
  showTop: boolean; showBottom: boolean;
  selectedPartIndex: number | null;
  dimActive: boolean;
  litParts: ReadonlySet<number> | null;
}
export interface OverlayThresholds {
  labelMinScreenPx: number;
  circleLabelMinScreenPx: number;
  twoPinLabelMinScreenPx: number;
  labelZoomHide: number;
}

const OFFSCREEN_MARGIN = 40;      // px — keep labels whose center is just off-edge
const DIM_ALPHA = 0.22;           // parity-tuned vs netDimGfx look in Task 9
const SELECTED_MIN_PX = 11;       // floor so the selected part's text is always readable

function minPxFor(kind: LabelRecord['kind'], th: OverlayThresholds): number {
  switch (kind) {
    case 'circleNum': case 'circleNet': return th.circleLabelMinScreenPx;
    case 'twoPinNet': return th.twoPinLabelMinScreenPx;
    default: return th.labelMinScreenPx;
  }
}

export function selectVisibleLabels(
  records: readonly LabelRecord[],
  m: OverlayViewState['topMatrix'],
  view: OverlayViewState,
  th: OverlayThresholds,
): LabelRecord[] {
  const out: LabelRecord[] = [];
  const zoomHidden = th.labelZoomHide > 0 && view.scale < th.labelZoomHide;
  for (const r of records) {
    const selected = view.selectedPartIndex !== null && r.partIndex === view.selectedPartIndex;
    if (!selected) {
      if (zoomHidden) continue;
      if (r.fontSize * view.scale < minPxFor(r.kind, th)) continue;
    }
    const sx = m.a * r.x + m.c * r.y + m.tx;
    const sy = m.b * r.x + m.d * r.y + m.ty;
    if (sx < -OFFSCREEN_MARGIN || sx > view.width + OFFSCREEN_MARGIN ||
        sy < -OFFSCREEN_MARGIN || sy > view.height + OFFSCREEN_MARGIN) continue;
    out.push(r);
  }
  return out;
}

export class LabelOverlay {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private container: HTMLElement;
  private colorCache = new Map<number, string>();
  lastDrawMs = 0;
  lastCounts = { visible: 0, total: 0 };

  constructor(container: HTMLElement) {
    this.container = container;
    this.canvas = document.createElement('canvas');
    Object.assign(this.canvas.style, {
      position: 'absolute', inset: '0', pointerEvents: 'none', zIndex: '2',
      transformOrigin: '0 0',
    } as CSSStyleDeclaration);
    container.appendChild(this.canvas);
    // NOT alpha:false — persistent canvas, per the PDF-canvas rules in CLAUDE.md.
    this.ctx = this.canvas.getContext('2d')!;
    this.resize();
  }

  resize(): void {
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const w = this.container.clientWidth, h = this.container.clientHeight;
    const bw = Math.max(1, Math.floor(w * dpr)), bh = Math.max(1, Math.floor(h * dpr));
    if (this.canvas.width !== bw || this.canvas.height !== bh) {
      this.canvas.width = bw; this.canvas.height = bh;
      this.canvas.style.width = w + 'px'; this.canvas.style.height = h + 'px';
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private css(color: number): string {
    let s = this.colorCache.get(color);
    if (!s) { s = '#' + color.toString(16).padStart(6, '0'); this.colorCache.set(color, s); }
    return s;
  }

  clear(): void {
    this.ctx.clearRect(0, 0, this.container.clientWidth, this.container.clientHeight);
    this.lastCounts = { visible: 0, total: 0 };
  }

  setCssTransform(t: string): void { this.canvas.style.transform = t; }

  draw(model: LabelModel, view: OverlayViewState, th: OverlayThresholds): void {
    const t0 = performance.now();
    this.setCssTransform('');
    const ctx = this.ctx;
    ctx.clearRect(0, 0, view.width, view.height);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // Cull ONCE per side, then iterate the three paint passes over the
    // pre-culled arrays (painter's order: dimmed → lit → selected-on-top).
    const sides: Array<[LabelRecord[], OverlayViewState['topMatrix']]> = [];
    if (view.showTop) sides.push([selectVisibleLabels(model.top, view.topMatrix, view, th), view.topMatrix]);
    if (view.showBottom) sides.push([selectVisibleLabels(model.bottom, view.bottomMatrix, view, th), view.bottomMatrix]);
    let visible = 0;
    for (const pass of ['dim', 'lit', 'selected'] as const) {
      for (const [vis, m] of sides) {
        let lastFontPx = -1;
        for (const r of vis) {
          const isSel = view.selectedPartIndex !== null && r.partIndex === view.selectedPartIndex;
          const isLit = !view.dimActive || isSel || (view.litParts?.has(r.partIndex) ?? false);
          const want = pass === 'selected' ? isSel : pass === 'lit' ? (isLit && !isSel) : !isLit;
          if (!want) continue;
          visible += 1;
          let px = r.fontSize * view.scale;
          if (isSel) px = Math.max(px, SELECTED_MIN_PX);
          const fontPx = Math.round(px * 4) / 4;          // quantize to limit ctx.font churn
          if (fontPx !== lastFontPx) { ctx.font = `${fontPx}px monospace`; lastFontPx = fontPx; }
          const sx0 = m.a * r.x + m.c * r.y + m.tx;
          const sy0 = m.b * r.x + m.d * r.y + m.ty;
          // Anchor compensation: ctx draws centered (textAlign/baseline middle),
          // records carry BitmapText anchors — shift so the anchored point of
          // the text box lands on (sx0, sy0). Width via measureText; height ≈ fontPx.
          const aw = (0.5 - r.anchorX) * ctx.measureText(r.text).width;
          const ah = (0.5 - r.anchorY) * fontPx;
          const sx = sx0 + aw;
          const sy = sy0 + ah;
          ctx.globalAlpha = pass === 'dim' ? DIM_ALPHA : 1;
          if (r.kind === 'twoPinNet') {                   // backing rect (replaces the Graphics wrapper)
            const tw = ctx.measureText(r.text).width + fontPx * 0.6;
            ctx.fillStyle = 'rgba(0,0,0,0.55)';
            ctx.fillRect(sx - tw / 2, sy - fontPx * 0.65, tw, fontPx * 1.3);
          }
          ctx.fillStyle = this.css(r.color);
          ctx.fillText(r.text, sx, sy);
        }
      }
    }
    ctx.globalAlpha = 1;
    this.lastCounts = { visible, total: model.top.length + model.bottom.length };
    const ms = performance.now() - t0;
    this.lastDrawMs = this.lastDrawMs === 0 ? ms : this.lastDrawMs * 0.8 + ms * 0.2;
    if (ms > 12) log.perf.log(`label overlay draw ${ms.toFixed(1)}ms visible=${visible}`);
  }

  destroy(): void { this.canvas.remove(); }
}
```


- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run src/renderer/label-overlay.test.ts`
Expected: 5 passed. Also `npx tsc --noEmit` clean.

- [ ] **Step 5: Commit**

```bash
git add src/frontend/src/renderer/label-overlay.ts src/frontend/src/renderer/label-overlay.test.ts
git commit -m "feat(render): LabelOverlay canvas layer with visible-only label selection"
```

---

### Task 7: BoardRenderer integration

**Files:**
- Modify: `src/frontend/src/renderer/BoardRenderer.ts`
  - overlay lifecycle: canvas mount next to tooltip creation; `destroy()` :5490; `teardownForReinit`/reinit path (canvas listeners at :744/:1085 show the pattern)
  - redraw triggers: `'moved'` handlers :995-1008 and :1167-1180; `onTick` :571; `renderSelection` (search `private renderSelection`); `resizeObserver` callback :1395; scene activation (search `activateScene`)
  - perf HUD counts: `rebuildLabelCounts` :1664 / `flushPerfOverlay` :1505-1516

**Interfaces:**
- Consumes: `LabelOverlay`, `OverlayViewState`, `OverlayThresholds` (Task 6); `scene.labelModel` (Task 5).
- Produces: `private textFastMode: LabelOverlay | null`, `private overlayDirty: boolean` — Task 8 extends `syncLabelOverlay`.

- [ ] **Step 1: Lifecycle**

Fields:

```ts
  private textFastMode: LabelOverlay | null = null;
  private overlayDirty = false;
```

Create lazily in a helper (called from `onTick` when needed, so both init and
reinit paths are covered without touching each):

```ts
  private ensureLabelOverlay(): LabelOverlay | null {
    if (!renderSettingsStore.settings.textFastMode) {
      if (this.textFastMode) { this.textFastMode.destroy(); this.textFastMode = null; }
      return null;
    }
    if (!this.textFastMode) {
      this.textFastMode = new LabelOverlay(this.containerEl);
      this.overlayDirty = true;
    }
    return this.textFastMode;
  }
```

`destroy()` (:5490): `this.textFastMode?.destroy(); this.textFastMode = null;`
`resizeObserver` callback (:1395): add `this.textFastMode?.resize(); this.overlayDirty = true;`
(`containerEl` must be `position: relative/absolute` — it already positions
the tooltip; verify computed style and set `position: relative` on the
overlay-mount if it is `static`. The tooltip must stay above the overlay:
give `tooltipEl.style.zIndex = '10'` where the tooltip is created if it has
no z-index.)

- [ ] **Step 2: Dirty triggers + tick draw**

In BOTH `'moved'` handlers (:995-1008, :1167-1180) add `this.overlayDirty = true;`.
In `renderSelection` (start of method) add `this.overlayDirty = true;`.
In scene activation (where `this.activeScene` is assigned on tab/board/fold
switch — search `activeScene =`) add `this.overlayDirty = true;`.
In `onSettingsUpdate`, after the rebuild-decision block, add
`this.overlayDirty = true;` (cheap; covers threshold changes).

In `onTick`, after the render block (:640-650), add:

```ts
    // Canvas2D label overlay — redraw when the view or selection changed.
    const overlay = this.ensureLabelOverlay();
    if (overlay && this.overlayDirty && this.activeScene?.labelModel) {
      this.overlayDirty = false;
      this.syncLabelOverlay(overlay, this.activeScene);
    } else if (overlay && !this.activeScene?.labelModel) {
      overlay.clear();   // overlay setting on, but scene built pre-toggle → rebuild pending
    }
```

- [ ] **Step 3: Implement `syncLabelOverlay`**

```ts
  private syncLabelOverlay(overlay: LabelOverlay, scene: BoardSceneGraph): void {
    const s = renderSettingsStore.settings;
    const model = scene.labelModel!;
    const wtTop = scene.topLabelLayer.worldTransform;
    const wtBot = scene.bottomLabelLayer.worldTransform;
    const dm = boardStore.dimMode;
    const dimActive = s.ambientDim && (dm === 'dim' ||
      (dm !== 'off' && (s.searchAutoDim ?? true) && boardStore.searchSelectionActive));
    overlay.draw(model, {
      topMatrix: { a: wtTop.a, b: wtTop.b, c: wtTop.c, d: wtTop.d, tx: wtTop.tx, ty: wtTop.ty },
      bottomMatrix: { a: wtBot.a, b: wtBot.b, c: wtBot.c, d: wtBot.d, tx: wtBot.tx, ty: wtBot.ty },
      scale: Math.abs(this.viewport.scale.x),
      width: this.containerEl.clientWidth, height: this.containerEl.clientHeight,
      showTop: boardStore.showTop, showBottom: boardStore.showBottom,
      selectedPartIndex: boardStore.selection.partIndex,
      dimActive,
      litParts: dimActive ? this.currentLitPartSet() : null,
    }, {
      labelMinScreenPx: s.labelMinScreenPx,
      circleLabelMinScreenPx: s.circleLabelMinScreenPx,
      twoPinLabelMinScreenPx: s.twoPinLabelMinScreenPx,
      labelZoomHide: s.labelZoomHide,
    });
  }
```

`currentLitPartSet()`: the set of part indices that the ambient-dim overlay
leaves lit — `renderSelection` already computes which parts/pins punch
through the dim (`netDimGfx` holes). Extract that part-index set into a field
`private litPartIndices: Set<number> | null` populated inside
`renderSelection` where the punch-through list is built (search `netDimGfx`
usage in `renderSelection`), and return it here. If the extraction is
non-obvious at implementation time, v1 fallback: `litParts: null` (only the
selected part stays lit) — visually stricter than the Pixi path but coherent;
note it in the commit message and revisit in Task 9's parity pass.

IMPORTANT ordering note: `worldTransform` is updated by Pixi during
`app.render()`. The tick handler draws the overlay AFTER the render block, so
matrices are current for this frame. When `needsRender` was false but
`overlayDirty` was set (e.g. selection change without scene change),
transforms are unchanged from the last render — also correct.

- [ ] **Step 4: Perf HUD counts from the overlay**

In `flushPerfOverlay` (:1505-1516), when `this.textFastMode` is non-null and
the active scene has a model, source the label counts from
`this.textFastMode.lastCounts` instead of `this.labelCounts`.

- [ ] **Step 5: Typecheck + full manual pass**

Run: `npx tsc --noEmit && npx vitest run` → clean.
Manual (`npm run dev`, flip Settings ▸ `textFastMode` ON):
1. Labels appear, crisp at every zoom (no atlas quantization steps).
2. Pan/zoom: labels track exactly (no lag/offset vs pads) — including after
   rotate (Q/E), mirror, and butterfly mode. If offsets appear in butterfly,
   the transform parent is wrong — verify against `topLabelLayer` /
   `bottomLabelLayer` world transforms per side (bottom side in butterfly is
   under `butterflyRoot`; `bottomLabelLayer.worldTransform` includes that
   chain automatically since it is its descendant).
3. LoD parity: zoom out → small labels disappear at ~the same depth as the
   BitmapText path (same thresholds).
4. Selection: selected part's labels always visible, on top, full alpha.
5. Ambient dim: non-lit labels dim to match the board dim visually.
6. Side toggle (top/bottom off) hides that side's labels.
7. Toggle `textFastMode` off → BitmapText path returns identically.

- [ ] **Step 6: Commit**

```bash
git add src/frontend/src/renderer/BoardRenderer.ts
git commit -m "feat(render): wire LabelOverlay into BoardRenderer draw/selection/dim cycle"
```

---

### Task 8: Adaptive motion mode (bounded pan cost)

**Files:**
- Modify: `src/frontend/src/renderer/BoardRenderer.ts` (`syncLabelOverlay` call site in `onTick`)
- Modify: `src/frontend/src/renderer/label-overlay.ts` (already has `setCssTransform`/`lastDrawMs`)

**Interfaces:**
- Consumes: `LabelOverlay.lastDrawMs`, `LabelOverlay.setCssTransform`, `viewportMovingUntil` (existing field, set in the `'moved'` handlers).

- [ ] **Step 1: Record the drawn view, cheap-transform between draws**

Add a field: `private overlayDrawnView: { x: number; y: number; scale: number } | null = null;`
Set it inside the tick-draw branch right after `syncLabelOverlay`:

```ts
      this.overlayDrawnView = { x: this.viewport.x, y: this.viewport.y, scale: Math.abs(this.viewport.scale.x) };
```

Replace the tick-draw condition with the adaptive version:

```ts
    const overlay = this.ensureLabelOverlay();
    if (overlay && this.activeScene?.labelModel) {
      const moving = performance.now() < this.viewportMovingUntil;
      const heavy = overlay.lastDrawMs > 6;
      const butterfly = !!(boardStore.butterfly && this.activeScene.butterflyRoot);
      if (this.overlayDirty && (!moving || !heavy || butterfly || !this.overlayDrawnView)) {
        this.overlayDirty = false;
        this.syncLabelOverlay(overlay, this.activeScene);
        this.overlayDrawnView = { x: this.viewport.x, y: this.viewport.y, scale: Math.abs(this.viewport.scale.x) };
      } else if (this.overlayDirty && this.overlayDrawnView) {
        // Heavy + moving: transform the last-drawn bitmap instead of redrawing.
        // Redraw happens when movement settles (viewportMovingUntil expires —
        // the next tick with moving=false takes the full-draw branch).
        const d = this.overlayDrawnView;
        const k = Math.abs(this.viewport.scale.x) / d.scale;
        const dx = this.viewport.x - d.x * k;
        const dy = this.viewport.y - d.y * k;
        overlay.setCssTransform(`translate(${dx}px, ${dy}px) scale(${k})`);
        // overlayDirty stays true → settle redraw
      }
    } else if (overlay) {
      overlay.clear();
    }
```

(Derivation of dx/dy: a scene point p maps to screen `viewport.pos + p·scale`;
the drawn bitmap has it at `d.pos + p·d.scale`. Composite CSS
`translate(t)·scale(k)` maps bitmap pixel q → `t + q·k`, so requiring
`t + (d.pos + p·d.scale)·k = viewport.pos + p·scale` gives
`k = scale/d.scale`, `t = viewport.pos − d.pos·k`. `draw()` already resets
the CSS transform to `''` at entry.)

Note: butterfly is excluded (two sides move under different transforms — a
single CSS transform can't represent it), so butterfly always full-draws.

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit` → clean.
Manual on the densest sample: zoom to a depth with thousands of visible pin
labels, pan hard — motion stays fluid; text may scale slightly during the
gesture and snaps crisp ≤ 100 ms after release (`viewportMovingUntil`
window). With a light board (draw < 6 ms) panning redraws crisp every frame
(no CSS mode engaged). No drift: after any pan/zoom sequence, labels sit
exactly on their pads once settled.

- [ ] **Step 3: Commit**

```bash
git add src/frontend/src/renderer/BoardRenderer.ts src/frontend/src/renderer/label-overlay.ts
git commit -m "perf(render): adaptive CSS-transform motion mode for label overlay"
```

---

### Task 9: Playwright + PNG verification

**Files:**
- Create: `src/frontend/tests/label-overlay.spec.ts`
- Verify: `src/frontend/tests/memory-release.spec.ts` still green

- [ ] **Step 1: Write the spec**

```ts
// src/frontend/tests/label-overlay.spec.ts
import { test, expect } from '@playwright/test';
import * as path from 'path';

test.use({
  launchOptions: {
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  },
});

const SAMPLE = path.resolve(__dirname, '../../../samples/820-02016/820-02016.bvr');

async function loadBoard(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.locator('input[type="file"]').first().setInputFiles(SAMPLE);
  await page.waitForFunction(() => !!(window as any).__boardRenderer?.board, null, { timeout: 60_000 });
  await page.waitForTimeout(2_000);
}

// Same settings-toggle mechanism tests/drag-to-zoom.spec.ts:42-48 uses:
// dynamic-import the store module inside the page and applyGlobal a patch.
async function setOverlay(page: import('@playwright/test').Page, on: boolean) {
  await page.evaluate(async (v) => {
    const mod = await import('/src/store/render-settings.ts');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store = (mod as any).renderSettingsStore;
    store.applyGlobal({ ...store.globalSnapshot(), textFastMode: v });
  }, on);
}

test('overlay on/off visual parity at label depth', async ({ page }) => {
  test.setTimeout(180_000);
  await loadBoard(page);
  const canvas = page.locator('canvas').first();
  const box = (await canvas.boundingBox())!;
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  for (let i = 0; i < 10; i++) { await page.mouse.move(cx, cy); await page.mouse.wheel(0, -240); await page.waitForTimeout(120); }
  await page.waitForTimeout(1_000);

  await page.screenshot({ path: 'test-results/labels-bitmaptext.png' });
  await setOverlay(page, true);
  await page.waitForTimeout(2_500);            // rebuild + overlay draw
  await page.screenshot({ path: 'test-results/labels-overlay.png' });

  // Overlay canvas exists and board canvas still renders
  expect(await page.locator('canvas').count()).toBeGreaterThanOrEqual(2);
});
```

(Board loading in both this spec and Task 0's follows the `openBoard` helper
pattern in `tests/drag-to-zoom.spec.ts` / `tests/boardripper.spec.ts` —
`page.goto('/')` + `setInputFiles` on the file input; reuse it verbatim if a
shared helper exists.)

- [ ] **Step 2: Run + LOOK at the PNGs**

Run: `npx playwright test tests/label-overlay.spec.ts`
Then open both PNGs (per project practice: show screenshots as clickable
links, and actually look): `test-results/labels-bitmaptext.png` vs
`test-results/labels-overlay.png`. Acceptance: same labels present at the
same positions; overlay text may be crisper; two-pin net labels keep their
dark backing; no missing/extra label classes. Fix parity gaps (DIM_ALPHA,
backing-rect size, thresholds) before proceeding.

- [ ] **Step 3: Regression cohort**

Run: `npx playwright test tests/memory-release.spec.ts tests/boardripper.spec.ts 2>&1 | tail -5`
Expected: same results as `main` baseline (memory-release must stay green —
the overlay canvas is removed in `destroy()`; the WeakRef probe must still
collect).

- [ ] **Step 4: Commit**

```bash
git add src/frontend/tests/label-overlay.spec.ts src/frontend/src/panels/  # settings UI hookup if touched
git commit -m "test: label overlay visual parity + lifecycle specs"
```

---

### Task 10: Perf validation + docs (mode STAYS opt-in)

**Files:**
- Modify: `docs/research/perf-baseline-2026-07-19.md` (after-numbers)
- Modify: `CLAUDE.md` (one bullet in Key Architectural Decisions)

Per user decision (2026-07-19): Text fast mode ships opt-in (default OFF,
labeled experimental) and is debugged across real installs for an extended
period before any default change is even discussed. There is NO default
flip in this plan. Graduation to default is a separate future decision with
its own validation.

- [ ] **Step 1: Re-run the Task 0 probe on this branch**

Run: `cd src/frontend && npx playwright test tests/perf-probe.spec.ts 2>&1 | grep PERF`
Record the numbers next to the baseline in
`docs/research/perf-baseline-2026-07-19.md` (same machine!). Acceptance
gates: `panFps` and `zoomFps` ≥ baseline with `textFastMode` OFF (the default
path must not regress), and with `textFastMode` ON (drive the setting in the
spec via the applyGlobal pattern) `panFps` at label depth ≥ 1.3× baseline.
Also record `buildScene` ms from the dev console (`log.perf`) with the mode
on vs off on the densest sample — expect a large drop (no BitmapText
construction).

- [ ] **Step 2: Document**

Add to CLAUDE.md ▸ Key Architectural Decisions (one bullet): **Text fast
mode (experimental, opt-in, default off)** — board text renders on a
Canvas2D overlay (`renderer/label-overlay.ts`) driven by a `LabelModel`
emitted by `buildBoardScene` when `textFastMode` is on; BitmapText remains
the default path and the SettingsMockup path; adaptive CSS-transform mode
bounds pan cost; via labels still BitmapText; do not flip the default
without an explicit graduation decision after extended field debugging.
Reference the audit doc.

- [ ] **Step 3: Final full check + commit**

Run: `npx tsc --noEmit && npx vitest run && npx playwright test tests/label-overlay.spec.ts tests/memory-release.spec.ts 2>&1 | tail -5`
Expected: clean/green (modulo the known headless cohort).

```bash
git add -A
git commit -m "feat(render): Text fast mode — opt-in Canvas2D label overlay (experimental)"
```

Maintainer: merge, `/release` (mode announced as experimental opt-in).

---

## Explicitly deferred (do NOT do in this plan)

- Via labels + debug vertex labels to the overlay (small counts; follow-up).
- Graduating Text fast mode to default — only after extended multi-install field debugging, as a separate decision.\n- Deleting the BitmapText path / atlas machinery (only after graduation).
- Raising `labelMinScreenPx` default from 3 (user-visible density change — separate discussion; the audit notes [external] uses ~12 px gates).
- D1 (inactive-tab rebuild deferral), C2 (scene-cache LRU), instanced pins (Phase 1 of the acceleration plan) — separate plans.
- Elevated-label badge redesign; `blendMode: 'difference'` read-under-text.

## Risks

- **Butterfly/flip transform mismatch** → mitigated by using per-side label-layer world transforms + explicit manual checks (Task 7 Step 5.2).
- **fillText cost on pathological boards** → bounded by Task 8's adaptive mode; measured gate in Task 10.
- **Dim-parity** (`litParts`) extraction from `renderSelection` may be fiddly → sanctioned v1 fallback documented in Task 7 Step 3.
- **Playwright text assertions impossible on canvas** → PNG + human LOOK per project practice; structural assertions kept minimal.
