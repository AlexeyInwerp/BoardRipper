# HDR Focus Glow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Spend HDR display headroom on the single element the user just navigated to — the current search hit, the PDF-lookup target, the selected part — so it is unmistakable among thousands of SDR-white neighbours on a dense board.

**Architecture:** A pre-baked PQ-encoded HDR image (AVIF, CICP 9/16/0) on a DOM overlay `<div>` layered above the PixiJS canvas, positioned in screen space from the same world matrix the existing Canvas2D label overlay uses. The glow holds steadily on whatever the user last navigated to — a "super-selection" — and the ordinary SDR highlight is untouched underneath it. Nothing about the Pixi render path changes; HDR is strictly additive.

**Tech Stack:** TypeScript, PixiJS v8.17, vitest (unit), Playwright (E2E), `avifenc` (libavif, maintainer-side asset generation only).

## Global Constraints

- **Spec:** `docs/specs/2026-08-04-hdr-focus-glow-design.md`. Read it before starting.
- **The SDR highlight is never modified.** HDR is purely additive on top. Every task that touches `renderSelection()` must leave existing draw calls byte-identical.
- **Settings are global**, not per-tab: `renderSettingsStore.globalSettings`, edited via `updateGlobal`. Follow `textFastMode` (`SettingsPanel.tsx:2432`), not the per-board draft settings.
- **Defaults:** `hdrFocusGlow = false` (opt-in, labelled `(experimental)`), `hdrGlowIntensity` on a 1–10 scale where 10 is brightest; default set from the user's rung pick on the probe.
- **Steady, not a pulse.** The glow holds while the target is focused (user revision, 2026-08-04). No envelope, no clock, no animation.
- **Alpha is unusable.** Opacity compositing flattens HDR to SDR (probe finding 3). Never vary the glow with `opacity`, `filter: brightness()`, or any alpha. Brightness varies ONLY by swapping to a sprite baked at a different peak luminance.
- **Glow scope:** focus target only — never net members, never all search hits.
- **Assets:** `hdr-glow-<0..23>.avif`, a 24-rung ladder 4000 → 200 nits. Rung 0 brightest. Committed; `avifenc` is a maintainer tool.
- **Logging:** scoped loggers from `store/log-store.ts` only, never `console.log`. Use `log.render.*`. No logging in per-frame paths.
- **Asset format is AVIF, not PNG.** Safari does not map PNG `cICP` to EDR (see spec Background). PNG would silently degrade to SDR on Safari, which is half the target audience.
- **`avifenc` is a maintainer tool, not a build step.** It is not present in CI or the Docker image. The generated `.avif` is committed to the repo.
- **Task 1 gate: PASSED** (2026-08-04, real HDR hardware). The PQ sprite keeps its headroom over a WebGL canvas. Opacity does not survive compositing, hence the alpha constraint above.

---

### Task 1: HDR asset generation + feasibility probe

This task answers the question the entire design rests on. Do not proceed past it without a visual result from the user on real HDR hardware.

**Files:**
- Create: `src/frontend/src/renderer/pq.ts`
- Create: `src/frontend/src/renderer/pq.test.ts`
- Create: `scripts/make-hdr-glow.ts`
- Create: `src/frontend/public/hdr-glow.avif` (generated, committed)
- Create: `src/frontend/public/hdr-probe.html`

**Interfaces:**
- Consumes: nothing.
- Produces: `pqEncode(nits: number) => number` (0–1 PQ signal) from `src/frontend/src/renderer/pq.ts`; the asset at runtime path `/hdr-glow.avif`.

**Why the module lives in `src/` and the script is `.ts`:** `vitest.config.ts` has `include: ['src/**/*.test.ts']`, so a test under `scripts/` or named `.mjs` is silently never collected — Step 2 would "fail" for the wrong reason and Step 4 would "pass" without running anything. The generator stays runnable as a plain script because Node 25 strips TypeScript types natively (`node scripts/make-hdr-glow.ts`); keep `pq.ts` free of enums and namespaces so type-stripping applies.

- [ ] **Step 1: Write the failing test for the PQ transfer function**

Create `src/frontend/src/renderer/pq.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { pqEncode } from './pq';

describe('pqEncode', () => {
  it('maps 0 nits to signal 0', () => {
    expect(pqEncode(0)).toBe(0);
  });

  it('maps the PQ peak (10000 nits) to signal 1', () => {
    expect(pqEncode(10000)).toBeCloseTo(1, 6);
  });

  // SDR reference white. The exact value falls near 0.5065; the loose bound
  // catches a broken formula (wrong m1/m2/c-constants land far outside this)
  // without being brittle about the last decimal.
  it('maps SDR reference white (100 nits) to roughly half signal', () => {
    const v = pqEncode(100);
    expect(v).toBeGreaterThan(0.49);
    expect(v).toBeLessThan(0.52);
  });

  it('is monotonically increasing', () => {
    let prev = -1;
    for (const nits of [0, 1, 10, 100, 203, 600, 1000, 4000, 10000]) {
      const v = pqEncode(nits);
      expect(v).toBeGreaterThan(prev);
      prev = v;
    }
  });

  it('clamps above the PQ peak instead of exceeding 1', () => {
    expect(pqEncode(50000)).toBeCloseTo(1, 6);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd src/frontend && npx vitest run src/renderer/pq.test.ts`
Expected: FAIL — cannot resolve `./pq`.

- [ ] **Step 3: Implement the PQ encoder**

Create `src/frontend/src/renderer/pq.ts`. Constants are the SMPTE ST 2084 values verbatim — do not "simplify" them:

```typescript
/** SMPTE ST 2084 (PQ) inverse EOTF: absolute luminance in nits -> 0..1 signal.
 *  Used to bake the HDR glow sprite. PQ is absolute: signal 1.0 always means
 *  10000 cd/m2 regardless of the display, which is what lets a value ride up
 *  into the panel's headroom above SDR white (~100-203 nits). */
const M1 = 2610 / 16384;        // 0.1593017578125
const M2 = (2523 / 4096) * 128; // 78.84375
const C1 = 3424 / 4096;         // 0.8359375
const C2 = (2413 / 4096) * 32;  // 18.8515625
const C3 = (2392 / 4096) * 32;  // 18.6875

export function pqEncode(nits: number): number {
  const Y = Math.min(Math.max(nits, 0), 10000) / 10000;
  if (Y === 0) return 0;
  const Ym = Math.pow(Y, M1);
  return Math.pow((C1 + C2 * Ym) / (1 + C3 * Ym), M2);
}
```

- [ ] **Step 4: Run the test and make sure it passes**

Run: `cd src/frontend && npx vitest run src/renderer/pq.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Write the asset generator**

Create `scripts/make-hdr-glow.ts`. It writes a 16-bit PNG (Node has no PNG encoder built in, so this writes the minimal PNG by hand via `zlib`), then shells out to `avifenc`.

```typescript
/** Bakes the HDR focus-glow sprite: a radial white gradient whose centre sits
 *  at PEAK_NITS and falls to black at the edge, PQ-encoded and tagged
 *  CICP 9/16/0 (BT.2020 primaries / PQ transfer / identity matrix).
 *
 *  MAINTAINER TOOL — not part of any build. avifenc is not in CI or the Docker
 *  image; the generated .avif is committed. Re-run only when changing the
 *  gradient shape or peak.
 *
 *  Usage:  node scripts/make-hdr-glow.ts     (Node 25 strips the types natively)
 *  Needs:  brew install libavif
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pqEncode } from '../src/frontend/src/renderer/pq.ts';

const SIZE = 256;
const PEAK_NITS = 4000;   // centre luminance; real output is capped by display headroom
const OUT = 'src/frontend/public/hdr-glow.avif';
const TMP = 'src/frontend/public/.hdr-glow-src.png';

function crc32(buf: Buffer): number {
  let c: number;
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

// --- build 16-bit RGB raster: PQ-encoded radial falloff ---
const raw = Buffer.alloc(SIZE * (1 + SIZE * 6)); // per row: filter byte + 3ch * 2B
let p = 0;
const r = SIZE / 2;
for (let y = 0; y < SIZE; y++) {
  raw[p++] = 0; // filter: none
  for (let x = 0; x < SIZE; x++) {
    const dx = x - r + 0.5, dy = y - r + 0.5;
    const d = Math.min(1, Math.sqrt(dx * dx + dy * dy) / r);
    // smoothstep falloff — same easing family as the existing dark halo
    const t = 1 - d;
    const falloff = t <= 0 ? 0 : t * t * (3 - 2 * t);
    const v = Math.round(pqEncode(PEAK_NITS * falloff) * 65535);
    for (let c = 0; c < 3; c++) { raw.writeUInt16BE(v, p); p += 2; }
  }
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 16;  // bit depth
ihdr[9] = 2;   // colour type: truecolour RGB
writeFileSync(TMP, Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0)),
]));

// --- encode to AVIF with PQ CICP ---
// 9  = BT.2020 primaries
// 16 = SMPTE ST 2084 (PQ) transfer
// 0  = identity matrix (RGB, no YUV conversion loss on a synthetic gradient)
execFileSync('avifenc', [
  '--cicp', '9/16/0',
  '--range', 'full',
  '--depth', '10',
  '--yuv', '444',
  '--speed', '0',
  TMP, OUT,
], { stdio: 'inherit' });
unlinkSync(TMP);
console.log(`wrote ${OUT} (peak ${PEAK_NITS} nits)`);
```

- [ ] **Step 6: Generate the asset and verify it carries PQ metadata**

Run:
```bash
cd /Users/besitzer/Desktop/Boardviewer
node scripts/make-hdr-glow.ts
avifdec --info src/frontend/public/hdr-glow.avif 2>&1 | head -20
```
Expected: the info dump reports transfer characteristics **16** (PQ) and primaries **9**. If it reports 1/13 (sRGB), the `--cicp` flag did not take and the asset is SDR — fix before continuing.

- [ ] **Step 7: Write the probe page**

Create `src/frontend/public/hdr-probe.html`. Swatches 3 and 4 are the gate.

```html
<!doctype html>
<meta charset="utf-8">
<title>BoardRipper — HDR probe</title>
<style>
  body { background:#000; color:#ccc; font:13px ui-monospace,monospace; padding:24px; }
  #caps { margin-bottom:20px; line-height:1.7; }
  .row { display:flex; gap:16px; flex-wrap:wrap; }
  figure { margin:0; width:200px; }
  .box { width:200px; height:200px; position:relative; background:#000; overflow:hidden; }
  .glow { position:absolute; inset:0; background:url(/hdr-glow.avif) center/contain no-repeat;
          dynamic-range-limit:no-limit; }
  figcaption { padding-top:8px; color:#888; }
  b { color:#fff; }
</style>
<h2>HDR probe</h2>
<div id="caps">…</div>
<div class="row">
  <figure><div class="box" style="background:#fff"></div>
    <figcaption>1. Plain white div<br>SDR reference</figcaption></figure>

  <figure><div class="box"><div class="glow"></div></div>
    <figcaption>2. PQ image, standalone<br><b>must out-glow #1</b></figcaption></figure>

  <figure><div class="box"><canvas id="c" width="200" height="200"></canvas>
      <div class="glow"></div></div>
    <figcaption>3. Over a WebGL canvas<br><b>GATE — must match #2</b></figcaption></figure>

  <figure><div class="box"><canvas id="c2" width="200" height="200"></canvas>
      <div class="glow" style="opacity:.6"></div></div>
    <figcaption>4. Over canvas, opacity .6<br><b>GATE — must still glow</b></figcaption></figure>

  <figure><div class="box"><canvas id="gpu" width="200" height="200"></canvas></div>
    <figcaption>5. WebGPU extended<br>reference (Chromium only)</figcaption></figure>
</div>
<script type="module">
const mq = matchMedia('(dynamic-range: high)');
document.getElementById('caps').innerHTML = [
  `dynamic-range: high .... <b>${mq.matches}</b>`,
  `color-gamut: p3 ........ <b>${matchMedia('(color-gamut: p3)').matches}</b>`,
  `dynamic-range-limit .... <b>${CSS.supports('dynamic-range-limit', 'no-limit')}</b>`,
  `devicePixelRatio ....... <b>${devicePixelRatio}</b>`,
  `webgpu ................. <b>${!!navigator.gpu}</b>`,
].join('<br>');

// Dark grey fill so the canvases are visibly present under the glow layers.
for (const id of ['c', 'c2']) {
  const gl = document.getElementById(id).getContext('webgl2');
  if (gl) { gl.clearColor(0.12, 0.12, 0.14, 1); gl.clear(gl.COLOR_BUFFER_BIT); }
}

// Swatch 5: WebGPU extended-range reference square.
if (navigator.gpu) {
  const adapter = await navigator.gpu.requestAdapter();
  const device = await adapter.requestDevice();
  const ctx = document.getElementById('gpu').getContext('webgpu');
  ctx.configure({
    device, format: 'rgba16float', alphaMode: 'opaque',
    toneMapping: { mode: 'extended' },
  });
  const enc = device.createCommandEncoder();
  enc.beginRenderPass({ colorAttachments: [{
    view: ctx.getCurrentTexture().createView(),
    clearValue: { r: 4, g: 4, b: 4, a: 1 },   // 4x SDR white
    loadOp: 'clear', storeOp: 'store',
  }] }).end();
  device.queue.submit([enc.finish()]);
}
</script>
```

- [ ] **Step 8: Commit**

```bash
git add src/frontend/src/renderer/pq.ts src/frontend/src/renderer/pq.test.ts \
        scripts/make-hdr-glow.ts \
        src/frontend/public/hdr-glow.avif src/frontend/public/hdr-probe.html
git commit -m "feat(hdr): PQ glow asset generator + feasibility probe page"
```

- [ ] **Step 9: STOP — hand the probe to the user**

Start the dev server and hand over the URL. Do **not** continue to Task 2 on your own judgement.

Run: `cd src/frontend && npm run dev`
Then tell the user to open `http://localhost:8082/hdr-probe.html` **on an HDR display** and report:
- Does swatch 2 visibly out-glow swatch 1?
- **Do swatches 3 and 4 match swatch 2, or do they fall back to swatch 1's brightness?**

If 3 or 4 flatten, the design is invalid. Report that and stop.

---

### Task 2: Extract `focusHaloGeometry` (pure, no behaviour change)

**Files:**
- Create: `src/frontend/src/renderer/focus-halo.ts`
- Create: `src/frontend/src/renderer/focus-halo.test.ts`
- Modify: `src/frontend/src/renderer/BoardRenderer.ts:3740-3752` (inside `updateHalo`)

**Interfaces:**
- Consumes: nothing.
- Produces: `focusHaloGeometry(bounds: HaloBounds): { x: number; y: number; size: number }` where `HaloBounds = { minX: number; maxX: number; minY: number; maxY: number }`. All values in mils (world units). Task 5 calls this.

- [ ] **Step 1: Write the failing test**

Create `src/frontend/src/renderer/focus-halo.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { focusHaloGeometry } from './focus-halo';

describe('focusHaloGeometry', () => {
  it('centres on the bounds centroid', () => {
    const g = focusHaloGeometry({ minX: 100, maxX: 300, minY: 50, maxY: 150 });
    expect(g.x).toBe(200);
    expect(g.y).toBe(100);
  });

  it('applies the 1500 mil floor to tiny passives', () => {
    // an 0402 is ~40x20 mils — far under the floor
    const g = focusHaloGeometry({ minX: 0, maxX: 40, minY: 0, maxY: 20 });
    expect(g.size).toBe(1500);
  });

  it('grows additively (not multiplicatively) for large parts', () => {
    // 2000 mil BGA -> 2000 + 800 padding, NOT a multiple of 2000
    const g = focusHaloGeometry({ minX: 0, maxX: 2000, minY: 0, maxY: 2000 });
    expect(g.size).toBe(2800);
  });

  it('sizes from the longer axis', () => {
    const g = focusHaloGeometry({ minX: 0, maxX: 3000, minY: 0, maxY: 100 });
    expect(g.size).toBe(3800);
  });

  it('never returns a zero size for degenerate bounds', () => {
    const g = focusHaloGeometry({ minX: 5, maxX: 5, minY: 5, maxY: 5 });
    expect(g.size).toBe(1500);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd src/frontend && npx vitest run src/renderer/focus-halo.test.ts`
Expected: FAIL — cannot resolve `./focus-halo`.

- [ ] **Step 3: Write the implementation**

Create `src/frontend/src/renderer/focus-halo.ts`. The constants and the `Math.max(bw, bh, 1)` guard are lifted verbatim from `updateHalo` — do not re-tune them here, this task is a pure extraction.

```typescript
/** Shared focus-target geometry for the two halos that mark the selected part:
 *  the dark spotlight sprite in the Pixi scene (`BoardRenderer.updateHalo`) and
 *  the HDR glow on the DOM overlay (`HdrGlowOverlay`). Both consume this so
 *  they cannot drift apart.
 *
 *  Growth is ADDITIVE, not multiplicative: the floor keeps the halo imposing on
 *  0402-class passives, and the fixed padding stops a large BGA from scaling the
 *  halo out into the next county. All units are mils. */
export interface HaloBounds { minX: number; maxX: number; minY: number; maxY: number }

const MIN_DIAMETER = 1500; // mils — ~38 mm
const PART_PADDING = 800;  // mils added to the part's longest dimension

export function focusHaloGeometry(b: HaloBounds): { x: number; y: number; size: number } {
  const partMaxDim = Math.max(b.maxX - b.minX, b.maxY - b.minY, 1);
  return {
    x: (b.minX + b.maxX) / 2,
    y: (b.minY + b.maxY) / 2,
    size: Math.max(MIN_DIAMETER, partMaxDim + PART_PADDING),
  };
}
```

- [ ] **Step 4: Run the test and make sure it passes**

Run: `cd src/frontend && npx vitest run src/renderer/focus-halo.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Rewrite `updateHalo` to consume it**

In `BoardRenderer.ts`, add to the imports near line 33:

```typescript
import { focusHaloGeometry } from './focus-halo';
```

Then replace the block at `BoardRenderer.ts:3740-3752` (from `const MIN_SPOTLIGHT_DIAMETER = 1500;` through `this._haloSprite.visible = true;`) with:

```typescript
    const g = focusHaloGeometry(part.bounds);
    this._haloSprite.width  = g.size;
    this._haloSprite.height = g.size;
    this._haloSprite.x = g.x;
    this._haloSprite.y = g.y;
    this._haloSprite.visible = true;
```

- [ ] **Step 6: Verify nothing changed visually**

Run: `cd src/frontend && npx tsc --noEmit && npx vitest run`
Expected: no type errors; all unit tests pass.

This is a pure extraction — the dark spotlight must look **identical**. The existing `tests/halo-rebuild-regression.spec.ts` guards the crash path, not the geometry, so also run it to confirm no regression:

Run: `cd src/frontend && npx playwright test tests/halo-rebuild-regression.spec.ts`
Expected: PASS (or the same result as on `main` — see the pre-existing-failures note in Task 6 Step 6).

- [ ] **Step 7: Commit**

```bash
git add src/frontend/src/renderer/focus-halo.ts \
        src/frontend/src/renderer/focus-halo.test.ts \
        src/frontend/src/renderer/BoardRenderer.ts
git commit -m "refactor(render): extract focusHaloGeometry so both halos share one sizing rule"
```

---

### Task 3: `focusTarget` store field

**Files:**
- Create: `src/frontend/src/store/focus-target.ts`
- Create: `src/frontend/src/store/focus-target.test.ts`
- Modify: `src/frontend/src/store/board-store.ts` — tab state shape, the `focusTarget` getter, and the set/clear sites in `selectPart` (~line 1193), `focusPart` (~line 2043), `focusNet`, and the pin-focus variant (~line 2153)

**Interfaces:**
- Consumes: nothing.
- Produces: `FocusTarget = { partIndex: number; pinIndex: number | null }`; `sameFocusTarget(a, b) => boolean`; `boardStore.focusTarget: FocusTarget | null`. Task 5 reads `boardStore.focusTarget`.

- [ ] **Step 1: Write the failing test**

Create `src/frontend/src/store/focus-target.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { sameFocusTarget } from './focus-target';

describe('sameFocusTarget', () => {
  it('treats two nulls as the same', () => {
    expect(sameFocusTarget(null, null)).toBe(true);
  });

  it('treats null and a target as different', () => {
    expect(sameFocusTarget(null, { partIndex: 1, pinIndex: null })).toBe(false);
    expect(sameFocusTarget({ partIndex: 1, pinIndex: null }, null)).toBe(false);
  });

  it('compares part and pin', () => {
    expect(sameFocusTarget({ partIndex: 1, pinIndex: 2 }, { partIndex: 1, pinIndex: 2 })).toBe(true);
    expect(sameFocusTarget({ partIndex: 1, pinIndex: 2 }, { partIndex: 1, pinIndex: 3 })).toBe(false);
    expect(sameFocusTarget({ partIndex: 1, pinIndex: 2 }, { partIndex: 4, pinIndex: 2 })).toBe(false);
  });

  it('distinguishes a part-level focus from a pin-level one on the same part', () => {
    expect(sameFocusTarget({ partIndex: 1, pinIndex: null }, { partIndex: 1, pinIndex: 0 })).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd src/frontend && npx vitest run src/store/focus-target.test.ts > /tmp/t.log 2>&1; tail -12 /tmp/t.log`
Expected: FAIL — cannot resolve `./focus-target`.

(The RTK shell hook swallows vitest's stdout; redirect to a file and tail it, or you will see an empty `PASS (0) FAIL (0)`.)

- [ ] **Step 3: Write the implementation**

Create `src/frontend/src/store/focus-target.ts`:

```typescript
/** What the HDR focus glow is currently marking: the element the user navigated
 *  to via search stepping, PDF -> board lookup, or selection stepping.
 *
 *  A steady "super-selection", not an event — it holds for as long as the
 *  target stays selected, so there is no sequence number and no clock. */
export interface FocusTarget {
  partIndex: number;
  /** null when the focus is a whole part rather than one of its pins. */
  pinIndex: number | null;
}

export function sameFocusTarget(a: FocusTarget | null, b: FocusTarget | null): boolean {
  if (a === null || b === null) return a === b;
  return a.partIndex === b.partIndex && a.pinIndex === b.pinIndex;
}
```

- [ ] **Step 4: Run the test and make sure it passes**

Run: `cd src/frontend && npx vitest run src/store/focus-target.test.ts > /tmp/t.log 2>&1; tail -8 /tmp/t.log`
Expected: PASS, 4 tests.

- [ ] **Step 5: Wire it into the board store**

In `board-store.ts`:

1. Import: `import type { FocusTarget } from './focus-target';`
2. Add `focusTarget: FocusTarget | null;` to the per-tab state interface (the one declaring `searchSelectionActive` at line 144), and `focusTarget: null,` to **every** tab-state initialiser — there are two, at lines ~838 and ~1133. Miss one and a fresh tab reads `undefined`.
3. Add a getter beside the `searchSelectionActive` getter (line 646):

```typescript
  get focusTarget(): FocusTarget | null { return this.activeTab?.focusTarget ?? null; }
```

4. Set it at each landing site, using the part index the method already resolved, and the pin index where it has one:

```typescript
      tab.focusTarget = { partIndex: resolvedPartIndex, pinIndex: resolvedPinIndex ?? null };
```

- `selectPart` (~1193) — set it; when the argument is `null` (deselect) set `tab.focusTarget = null` instead.
- `focusPart` (~2043) — search hits and PDF lookup both route through here. `pinIndex: null`.
- `focusNet` — same treatment; use the part index it selects.
- the pin-focus variant (~2153) — pass its real pin index.

5. Clear it wherever the selection is cleared — the same places that already set `searchSelectionActive = false` **and** blank the selection. Do not clear it on a mere `searchSelectionActive` flip: an ordinary canvas click is still a focus target.

- [ ] **Step 6: Verify it compiles and nothing regressed**

Run: `cd src/frontend && (npx tsc --noEmit; npx vitest run) > /tmp/v.log 2>&1; grep -c "error TS" /tmp/v.log; tail -6 /tmp/v.log`
Expected: 0 type errors; all unit tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/frontend/src/store/focus-target.ts \
        src/frontend/src/store/focus-target.test.ts \
        src/frontend/src/store/board-store.ts
git commit -m "feat(store): focusTarget — what the HDR super-selection is marking"
```

---

### Task 4: `HdrGlowOverlay` — capability detection, DOM layer, rung selection

**Files:**
- Create: `src/frontend/src/renderer/hdr-glow-overlay.ts`
- Create: `src/frontend/src/renderer/hdr-glow-overlay.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `isHdrCapable() => boolean`; `onHdrCapabilityChange(cb) => () => void`; `rungForIntensity(intensity: number) => number`; `GLOW_RUNGS`; `class HdrGlowOverlay { constructor(container: HTMLElement); resize(): void; show(cssX: number, cssY: number, cssSize: number, rung: number): void; hide(): void; destroy(): void }`. Task 5 constructs and drives it.

- [ ] **Step 1: Write the failing test**

Create `src/frontend/src/renderer/hdr-glow-overlay.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { rungForIntensity, GLOW_RUNGS } from './hdr-glow-overlay';

describe('rungForIntensity', () => {
  it('maps max intensity to the brightest rung', () => {
    expect(rungForIntensity(10)).toBe(0);
  });

  it('maps min intensity to the dimmest rung', () => {
    expect(rungForIntensity(1)).toBe(GLOW_RUNGS - 1);
  });

  it('is monotonically decreasing in rung as intensity rises', () => {
    let prev = GLOW_RUNGS;
    for (let i = 1; i <= 10; i++) {
      const r = rungForIntensity(i);
      expect(r).toBeLessThanOrEqual(prev);
      prev = r;
    }
  });

  it('never returns a rung outside the baked ladder', () => {
    for (const i of [-5, 0, 1, 5, 10, 99]) {
      const r = rungForIntensity(i);
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThan(GLOW_RUNGS);
    }
  });

  it('returns an integer (rungs are file names, not fractions)', () => {
    expect(Number.isInteger(rungForIntensity(7))).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd src/frontend && npx vitest run src/renderer/hdr-glow-overlay.test.ts > /tmp/t.log 2>&1; tail -12 /tmp/t.log`
Expected: FAIL — cannot resolve `./hdr-glow-overlay`.

- [ ] **Step 3: Write the implementation**

Create `src/frontend/src/renderer/hdr-glow-overlay.ts`:

```typescript
/** HDR focus glow — a DOM layer above the Pixi canvas carrying a PQ-encoded
 *  AVIF sprite, so the element the user navigated to can ride up into the
 *  display's headroom above SDR white. Nothing else on screen can produce that
 *  brightness, which is the whole point.
 *
 *  Why DOM and not the Pixi canvas: WebGL has no shipped HDR path, Canvas2D is
 *  8-bit by spec, and Pixi clamps vertex colours to 8-bit before they reach the
 *  buffer. An HDR *image* is the only route that works in both Chrome and
 *  Safari today. Cost: soft blobs only — no HDR outlines or strokes.
 *
 *  Why brightness is a sprite swap and not an opacity: opacity compositing
 *  flattens HDR back to SDR (measured on the probe — a glow at opacity .6 over
 *  a canvas is exactly as bright as plain white). So the ladder of sprites,
 *  each baked at a different peak luminance, IS the brightness control.
 *  See docs/specs/2026-08-04-hdr-focus-glow-design.md. */

/** Number of baked luminance rungs (hdr-glow-0.avif .. hdr-glow-23.avif),
 *  4000 nits down to 200. Rung 0 is brightest. */
export const GLOW_RUNGS = 24;

/** Map the user-facing 1-10 intensity onto a rung. 10 = brightest = rung 0. */
export function rungForIntensity(intensity: number): number {
  const clamped = Math.min(10, Math.max(1, intensity));
  const rung = Math.round(((10 - clamped) / 9) * (GLOW_RUNGS - 1));
  return Math.min(GLOW_RUNGS - 1, Math.max(0, rung));
}

const HDR_QUERY = '(dynamic-range: high)';

/** True when the browser AND the current display can show content above SDR
 *  white. Dynamic: docking to an SDR monitor, or iOS/macOS Low Power Mode
 *  forcing the panel to SDR, flips this at runtime. */
export function isHdrCapable(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia(HDR_QUERY).matches;
}

/** Subscribe to capability changes. Returns an unsubscribe function. */
export function onHdrCapabilityChange(cb: (capable: boolean) => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};
  const mq = window.matchMedia(HDR_QUERY);
  const handler = (e: MediaQueryListEvent) => cb(e.matches);
  mq.addEventListener('change', handler);
  return () => mq.removeEventListener('change', handler);
}

export class HdrGlowOverlay {
  private el: HTMLDivElement;
  private container: HTMLElement;
  private shownRung = -1;

  constructor(container: HTMLElement) {
    this.container = container;
    const el = document.createElement('div');
    const s = el.style;
    s.position = 'absolute';
    s.left = '0';
    s.top = '0';
    s.pointerEvents = 'none';       // pins under the glow must stay clickable
    s.zIndex = '3';                 // above the label overlay (zIndex 2)
    s.backgroundSize = 'contain';
    s.backgroundRepeat = 'no-repeat';
    s.display = 'none';
    s.willChange = 'transform';
    // Tell the compositor not to tone-map this layer down to SDR.
    s.setProperty('dynamic-range-limit', 'no-limit');
    container.appendChild(el);
    this.el = el;
  }

  /** No-op: the sprite is sized per-show in CSS px, so there is nothing
   *  resolution-dependent to rebuild. Present for lifecycle parity with
   *  LabelOverlay, which BoardRenderer calls uniformly. */
  resize(): void { /* intentionally empty */ }

  /** Place and light the glow. Coordinates are CSS px in the container's space
   *  (the same space LabelOverlay draws in); `cssSize` is the sprite diameter;
   *  `rung` selects the baked luminance. NOTE: no alpha parameter — see the
   *  class comment. */
  show(cssX: number, cssY: number, cssSize: number, rung: number): void {
    const s = this.el.style;
    const half = cssSize / 2;
    s.width = `${cssSize}px`;
    s.height = `${cssSize}px`;
    s.transform = `translate(${cssX - half}px, ${cssY - half}px)`;
    if (rung !== this.shownRung) {
      s.backgroundImage = `url(/hdr-glow-${rung}.avif)`;
      this.shownRung = rung;
    }
    s.display = 'block';
  }

  hide(): void {
    this.el.style.display = 'none';
  }

  destroy(): void {
    this.el.remove();
  }
}
```

- [ ] **Step 4: Run the test and make sure it passes**

Run: `cd src/frontend && npx vitest run src/renderer/hdr-glow-overlay.test.ts > /tmp/t.log 2>&1; tail -8 /tmp/t.log`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/frontend/src/renderer/hdr-glow-overlay.ts \
        src/frontend/src/renderer/hdr-glow-overlay.test.ts
git commit -m "feat(render): HdrGlowOverlay — PQ sprite layer, capability detection, rung selection"
```

---

### Task 5: Wire the overlay into `BoardRenderer`

**Files:**
- Modify: `src/frontend/src/renderer/BoardRenderer.ts` — imports (~line 33), fields (~line 394 beside `textFastMode`), `ensureHdrOverlay()` (beside `ensureLabelOverlay` at line 1845), the tick path (~line 831-860), and `destroy()`

**Interfaces:**
- Consumes: `focusHaloGeometry` (Task 2), `boardStore.focusTarget` (Task 3), `HdrGlowOverlay` / `isHdrCapable` / `rungForIntensity` (Task 4), `renderSettingsStore.settings.hdrFocusGlow` + `.hdrGlowIntensity` (Task 6 — declare them there first if `tsc` complains, the two tasks may be done in either order).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Add imports and fields**

In `BoardRenderer.ts`, beside the `LabelOverlay` import at line 33:

```typescript
import { HdrGlowOverlay, isHdrCapable, rungForIntensity } from './hdr-glow-overlay';
```

Beside the `textFastMode` field (~line 394):

```typescript
  /** HDR focus glow layer — mounted lazily by ensureHdrOverlay() when the
   *  setting is on AND the display can actually show HDR; torn down otherwise. */
  private hdrOverlay: HdrGlowOverlay | null = null;
```

- [ ] **Step 2: Add the lifecycle method**

Immediately after `ensureLabelOverlay()` (which ends at line 1857), add:

```typescript
  /** Mirror of ensureLabelOverlay for the HDR glow layer. Gated on BOTH the
   *  opt-in setting and live display capability, so undocking to an SDR monitor
   *  tears it down on the next frame without any explicit listener. */
  private ensureHdrOverlay(): HdrGlowOverlay | null {
    if (!renderSettingsStore.settings.hdrFocusGlow || !isHdrCapable()) {
      if (this.hdrOverlay) { this.hdrOverlay.destroy(); this.hdrOverlay = null; }
      return null;
    }
    if (!this.hdrOverlay) {
      this.hdrOverlay = new HdrGlowOverlay(this.containerEl);
      log.render.log('HDR focus glow overlay mounted');
    }
    return this.hdrOverlay;
  }

  /** Position the HDR glow on the current focus target. Called from onTick
   *  AFTER app.render(), so worldTransform is current — same ordering
   *  requirement as syncLabelOverlay.
   *
   *  Steady, not animated: this only moves the sprite to track pan/zoom, so it
   *  adds nothing to frames that were already going to run. */
  private syncHdrOverlay(overlay: HdrGlowOverlay, scene: BoardScene): void {
    const target = boardStore.focusTarget;
    if (!target || !this.board) { overlay.hide(); return; }

    const part = this.board.parts[target.partIndex];
    if (!part || !this.isPartVisible(part)) { overlay.hide(); return; }

    // Pin-level focus glows the pin; part-level glows the whole part.
    const pin = target.pinIndex !== null ? part.pins[target.pinIndex] : null;
    const g = pin
      ? focusHaloGeometry({
          minX: pin.position.x, maxX: pin.position.x,
          minY: pin.position.y, maxY: pin.position.y,
        })
      : focusHaloGeometry(part.bounds);

    // World -> screen through the same label-layer matrix the text overlay
    // uses, so rotate / mirror / butterfly are handled for free.
    const wt = (boardStore.butterfly && part.side === 'bottom')
      ? scene.bottomLabelLayer.worldTransform
      : scene.topLabelLayer.worldTransform;
    const cssX = wt.a * g.x + wt.c * g.y + wt.tx;
    const cssY = wt.b * g.x + wt.d * g.y + wt.ty;
    const scale = Math.hypot(wt.a, wt.b);

    const rung = rungForIntensity(renderSettingsStore.settings.hdrGlowIntensity);
    overlay.show(cssX, cssY, g.size * scale, rung);
  }
```

- [ ] **Step 3: Call it from the tick path**

In the tick body, directly after the existing `this.syncLabelOverlay(overlay, this.activeScene);` call (~line 859), add a sibling block. It must be **outside** the `textFastMode` conditional — the HDR glow works with either label mode:

```typescript
      const hdr = this.ensureHdrOverlay();
      if (hdr && this.activeScene) this.syncHdrOverlay(hdr, this.activeScene);
```

- [ ] **Step 4: Tear it down on destroy**

In `destroy()`, beside the existing `textFastMode` teardown:

```typescript
    if (this.hdrOverlay) { this.hdrOverlay.destroy(); this.hdrOverlay = null; }
```

- [ ] **Step 5: Verify it compiles**

Run: `cd src/frontend && npx tsc --noEmit && npx vitest run`
Expected: no type errors; all unit tests pass. If `hdrFocusGlow` / `hdrGlowIntensity` are unknown, do Task 6 Step 1 first.

- [ ] **Step 6: Commit**

```bash
git add src/frontend/src/renderer/BoardRenderer.ts
git commit -m "feat(render): drive the HDR focus glow from the focus target"
```

---

### Task 6: Settings switch + start-page switch

**Files:**
- Modify: `src/frontend/src/store/render-settings.ts` — `RenderSettings` interface (~line 169, beside `netHighlightGrow`) and `DEFAULTS` (~line 556)
- Modify: `src/frontend/src/panels/SettingsPanel.tsx:2360-2381` (Selection & Highlight section)
- Modify: `src/frontend/src/components/home/HomeBackdrop.tsx` (beside `AutoOpenPdfToggle`, ~line 674)
- Create: `src/frontend/tests/hdr-glow-settings.spec.ts`

**Interfaces:**
- Consumes: `isHdrCapable` (Task 4).
- Produces: `RenderSettings.hdrFocusGlow: boolean`, `RenderSettings.hdrGlowIntensity: number`.

- [ ] **Step 1: Add the settings fields**

In `render-settings.ts`, beside `netHighlightAlpha` in the `RenderSettings` interface (~line 170):

```typescript
  /** HDR focus glow — light the just-navigated-to element above SDR white on
   *  an HDR display. Global (a property of the display, not the board).
   *  Experimental: opt-in during the field-debug window. */
  hdrFocusGlow: boolean;
  /** Brightness of the HDR focus glow, 1-10 (10 = brightest). Selects a rung
   *  on the baked luminance ladder — alpha cannot be used, it flattens HDR. */
  hdrGlowIntensity: number;
```

And in `DEFAULTS` (~line 557, beside `netHighlightAlpha: 0.6,`):

```typescript
  hdrFocusGlow: false,
  hdrGlowIntensity: 6,   // provisional — set from the user's rung pick on the probe
```

- [ ] **Step 2: Add the Settings controls**

In `SettingsPanel.tsx`, inside the Selection & Highlight section, after the `Floating Pin Label` toggle at line 2380 and before `</CollapsibleSection>`:

```tsx
        <Toggle label="HDR focus glow (experimental)" value={draft.hdrFocusGlow} field="hdrFocusGlow" onUpdate={updateGlobal}
          title={hdrCapable
            ? "On an HDR display, burn the element you navigated to (search hit, PDF lookup, selected part) brighter than white for as long as it stays selected. Purely additive — the normal highlight is unchanged."
            : "No HDR display detected. This needs an HDR-capable screen in HDR mode; on macOS that is automatic, on Windows it must be enabled system-wide."} />
        <Slider label="HDR Glow Intensity" value={draft.hdrGlowIntensity} min={1} max={10} step={1} field="hdrGlowIntensity" onUpdate={updateGlobal}
          title="How bright the HDR glow burns. Higher = further above SDR white. If the rest of the UI visibly dims while a part is selected, lower this" />
```

`hdrCapable` comes from a `useState` + effect near the top of the settings component, so docking to another monitor updates the hint live:

```tsx
  const [hdrCapable, setHdrCapable] = useState(isHdrCapable);
  useEffect(() => onHdrCapabilityChange(setHdrCapable), []);
```

Import at the top of the file:

```tsx
import { isHdrCapable, onHdrCapabilityChange } from '../renderer/hdr-glow-overlay';
```

Per the spec, the Settings control stays **visible when incapable** — the title explains why. Do not hide it.

- [ ] **Step 3: Add the start-page toggle**

In `HomeBackdrop.tsx`, after `AutoOpenPdfToggle` (ends line 689), add — following that component's exact shape:

```tsx
function useHdrGlow(): boolean {
  return useSyncExternalStore(
    (cb) => renderSettingsStore.subscribe(cb),
    () => renderSettingsStore.globalSettings.hdrFocusGlow,
  );
}

/** Start-page switch for the HDR focus glow. Unlike the Settings control this
 *  one HIDES on a non-HDR display: the home screen is a dashboard of things you
 *  can act on, and a permanently dead row is just noise. */
function HdrGlowToggle() {
  const enabled = useHdrGlow();
  const [capable, setCapable] = useState(isHdrCapable);
  useEffect(() => onHdrCapabilityChange(setCapable), []);
  if (!capable) return null;
  return (
    <label
      className="home-toggle-row"
      title="Burn the element you navigated to brighter than white while it stays selected. Needs an HDR display."
    >
      <span>HDR focus glow (experimental)</span>
      <input
        type="checkbox"
        checked={enabled}
        onChange={(e) => {
          const snap = renderSettingsStore.globalSnapshot();
          snap.hdrFocusGlow = e.target.checked;
          renderSettingsStore.applyGlobal(snap);
        }}
      />
    </label>
  );
}
```

Import `isHdrCapable, onHdrCapabilityChange` from `'../../renderer/hdr-glow-overlay'`, and render `<HdrGlowToggle />` in the same card as `<AutoSwitchToggle />` / `<AutoOpenPdfToggle />`.

- [ ] **Step 4: Write the structural E2E test**

Headless Chromium cannot verify headroom, so assert structure only. Create `src/frontend/tests/hdr-glow-settings.spec.ts`:

```typescript
import { test, expect } from '@playwright/test';

test.describe('HDR focus glow settings', () => {
  test('the Settings toggle exists and defaults to off', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /settings/i }).first().click();
    const row = page.locator('.settings-row', { hasText: 'HDR focus glow' });
    await expect(row).toBeVisible();
    await expect(row.locator('input[type=checkbox]')).not.toBeChecked();
  });

  test('the intensity slider defaults to 3', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /settings/i }).first().click();
    const row = page.locator('.settings-row', { hasText: 'HDR Glow Intensity' });
    await expect(row.locator('input[type=range]')).toHaveValue('3');
  });

  test('no glow layer is mounted while the setting is off', async ({ page }) => {
    await page.goto('/');
    // The overlay div is identified by its background sprite.
    await expect(page.locator('div[style*="hdr-glow-"]')).toHaveCount(0);
  });
});
```

- [ ] **Step 5: Run the new spec**

Run: `cd src/frontend && npx playwright test tests/hdr-glow-settings.spec.ts`
Expected: PASS, 3 tests.

Headless Chromium reports `dynamic-range: standard`, so the start-page toggle is correctly absent there and is deliberately not asserted.

- [ ] **Step 6: Run the full suite and compare against baseline**

Run: `cd src/frontend && npx tsc --noEmit && npx vitest run && npx playwright test`

**A large cohort of board/PDF-render specs (~100) fails headless because there is no WebGL — this is pre-existing and unrelated.** Do not attribute it to this branch. Get the baseline failed count from `main` (`git stash && npx playwright test; git stash pop`) and confirm this branch's count is the same or lower.

- [ ] **Step 7: Commit**

```bash
git add src/frontend/src/store/render-settings.ts \
        src/frontend/src/panels/SettingsPanel.tsx \
        src/frontend/src/components/home/HomeBackdrop.tsx \
        src/frontend/tests/hdr-glow-settings.spec.ts
git commit -m "feat(settings): HDR focus glow switch in Settings and on the start page"
```

---

### Task 7: Documentation + hand-off for visual verification

**Files:**
- Modify: `CLAUDE.md` (Key Architectural Decisions)
- Modify: `docs/specs/2026-08-04-hdr-focus-glow-design.md` (status line)

- [ ] **Step 1: Add the architecture note**

Append a bullet to **Key Architectural Decisions** in `CLAUDE.md`, matching the density of its neighbours:

```markdown
- **HDR focus glow (experimental, opt-in):** the element you just navigated to — search hit, PDF→board lookup target, burns above SDR white for as long as it stays selected on an HDR display (a steady "super-selection", not a flash). Implemented as a DOM layer (`renderer/hdr-glow-overlay.ts`) above the Pixi canvas carrying a PQ-encoded AVIF sprite (CICP 9/16/0, baked by `scripts/make-hdr-glow.ts` — a maintainer tool, `avifenc` is not in CI or the image; the `.avif` is committed). **Not** the WebGPU `rgba16float` route: WebGL has no shipped HDR path, Canvas2D is 8-bit, Pixi clamps vertex colours to 8-bit and hardcodes `bgra8unorm`, and WebGPU-HDR is Chromium-only. HDR *images* are the only technique honoured by both Chrome and Safari — the cost is soft blobs only, no HDR outlines or strokes. PNG `cICP` was rejected: Safari does not map it to EDR. Gated on `renderSettings.hdrFocusGlow` (global, default off) **and** live `matchMedia('(dynamic-range: high)')`, so undocking to an SDR monitor tears the layer down on the next frame. The SDR highlight is untouched and the glow is purely additive, which is the entire fallback story. Focus target only — never net members, never all search hits, because headroom is a shared budget that collapses under large lit areas. Sizing shares `focusHaloGeometry()` with the dark spotlight so the two cannot drift. Diagnostic: `/hdr-probe.html`. Spec: `docs/specs/2026-08-04-hdr-focus-glow-design.md`.
```

- [ ] **Step 2: Mark the spec implemented**

Change the spec's status line to `**Status:** implemented (pending field verification)`.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md docs/specs/2026-08-04-hdr-focus-glow-design.md
git commit -m "docs: record the HDR focus glow architecture and rejected alternatives"
```

- [ ] **Step 4: Hand off for visual verification**

Automated tests cannot see HDR. Start the dev server and hand the URL to the user — do not screenshot-loop.

Run: `cd src/frontend && npm run dev`

Ask the user to, on an HDR display: enable the toggle (start page or Settings ▸ Selection & Highlight), open a dense board, then run a search and step through hits, do a PDF→board lookup, and click through parts. What to report:

- Does the landed-on element visibly flash brighter than white?
- Does a steady glow sit comfortably, or does the surrounding UI visibly dim under it (macOS re-tone-mapping)? Lower the intensity rung if so.
- Is the default rung right, and does the 1-10 slider span a useful range?
- Over a long session, is it pleasant or tiring?

---

## Self-Review

**Spec coverage.** Overlay layer → Task 4. Asset + PQ encoding → Task 1. Capability gating → Tasks 4 (detection) and 6 (settings). Global-not-per-tab → Task 6 Step 1. Both switch surfaces incl. the hidden-vs-disabled split → Task 6 Steps 2–3. Focus target + trigger sites → Task 3. Shared geometry extraction → Task 2. Screen projection via the label matrix → Task 5. Probe as gate → Task 1. Unit tests → Tasks 1–4; structural E2E → Task 6; manual hand-off → Task 7.

**Deviation from the spec, deliberate:** the spec says PNG; the plan uses **AVIF**, because Safari does not map PNG `cICP` to EDR and Safari is half the chosen audience. The spec's own rationale (cross-browser reach) forces this. Recorded in Task 7's CLAUDE.md bullet.

**Type consistency.** `focusHaloGeometry(HaloBounds) => {x,y,size}` — defined Task 2, consumed Tasks 2 and 5. `FocusTarget{partIndex,pinIndex}`/`sameFocusTarget` — defined Task 3, consumed Task 5. `rungForIntensity`/`GLOW_RUNGS`/`isHdrCapable`/`onHdrCapabilityChange`/`HdrGlowOverlay.show(x,y,size,rung)` — defined Task 4, consumed Tasks 5 and 6. `hdrFocusGlow`/`hdrGlowIntensity` — defined Task 6, consumed Task 5 (noted there as an ordering dependency).

**Known soft spots.** Task 3 Step 5 gives field names and line numbers rather than literal diffs for `board-store.ts`, because the four call sites resolve their part index by different local names; the implementer must read each. Task 5 Step 3's insertion point is described relative to `syncLabelOverlay` rather than quoted, as the surrounding tick body is long.
