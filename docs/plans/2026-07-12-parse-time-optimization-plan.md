# Parse-Time Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut first-open board parse latency and eliminate main-thread freezes during parse, without changing any parser's output.

**Architecture:** Instrument first (Task 1), then three output-preserving kernel optimizations verified by parity tests against the current implementations (Tasks 2–4), then unblock the renderer handoff from the IndexedDB cache write (Task 5), then move the whole parse pipeline into a module Web Worker with an inline fallback (Task 6). Task 7 is a measurement gate that decides whether a WASM crypto-kernel follow-up plan is warranted. Background: `docs/research/wasm-webgpu-acceleration-plan.md` §1.3/§2.

**Tech Stack:** TypeScript (strict), Vite 7 module workers, vitest (`npm run test:unit`, node env, `src/**/*.test.ts`), Playwright for E2E.

## Global Constraints

- **Parser output must be byte/structure-identical.** None of these tasks may change `BoardData` content (Task 3 changes only the ORDER of `ghosts[]`, made deterministic by an explicit sort). If any parity test reveals an output difference, stop and fix the optimization — do NOT bump `PARSER_VERSION` to paper over it.
- TypeScript strict mode; no `any` in new code except where noted for worker message plumbing.
- Logging via scoped loggers from `store/log-store.ts` (`log.parser.*`, `log.perf.*`, `log.cache.*`) — never raw `console.log`. No logging in per-pin/per-byte hot loops.
- Commit after every task (project safety rule). Never delete >10 lines without the prior state committed.
- The headless Playwright board-render cohort (~100 specs) fails without WebGL — pre-existing, do not attribute to this work. Baseline-diff failure counts instead.
- Sample files for manual verification live in `samples/` (large FZ/XZZ/Allegro: see `samples/BROKEN/fixed/ToTest/Camp.brd` 380 MB, `samples/TVW/HY568_NMD711R20_View.tvw` 35 MB).

---

### Task 1: Parse-stage instrumentation

**Files:**
- Modify: `src/frontend/src/parsers/fz-parser.ts` (~line 408 and ~446/465)
- Modify: `src/frontend/src/parsers/xzz-parser.ts` (~lines 364, 439)
- Modify: `src/frontend/src/store/board-store.ts` (~lines 954-958, 979-980)

**Interfaces:**
- Consumes: existing `log` object from `store/log-store.ts`.
- Produces: `log.perf` lines with stable prefixes other tasks and Task 7 grep for: `FZ rc6Decrypt:`, `FZ inflate:`, `XZZ clusterSegments:`, `post-parse:`, `cache put:`.

- [ ] **Step 1: Add RC6 + inflate timing to the FZ parser**

In `src/frontend/src/parsers/fz-parser.ts`, ensure the log import exists at the top (add if absent):

```ts
import { log } from '../store/log-store';
```

At the `rc6Decrypt` call site (~line 408), wrap:

```ts
    const tDec = performance.now();
    rc6Decrypt(data, key);
    log.perf.log(`FZ rc6Decrypt: ${(performance.now() - tDec).toFixed(0)}ms for ${data.length.toLocaleString()} bytes`);
```

At each of the two inflate call sites (~lines 446 and 465), wrap the existing `inflate(...)` / `inflateRaw(...)` call:

```ts
    const tInf = performance.now();
    const inflated = inflate(payload);           // keep whichever call is already there
    log.perf.log(`FZ inflate: ${(performance.now() - tInf).toFixed(0)}ms → ${inflated.length.toLocaleString()} bytes`);
```

(Adjust the variable names to match the existing code at each site — only the timing lines are new.)

- [ ] **Step 2: Add clusterSegments timing to the XZZ parser**

In `src/frontend/src/parsers/xzz-parser.ts`, at both call sites (~lines 364 and 439), wrap:

```ts
  const tCluster = performance.now();
  const groups = clusterSegments(segments);
  log.perf.log(`XZZ clusterSegments: ${(performance.now() - tCluster).toFixed(0)}ms for ${segments.length} segments → ${groups.length} groups`);
```

- [ ] **Step 3: Add post-parse and cache-write timing to board-store**

In `src/frontend/src/store/board-store.ts`, around lines 954-958, bracket the post-parse block:

```ts
        loadProgressStore.setPhase('Post-process', 'Mechanical-part detection, derived-view, filters');
        const tPost = performance.now();
        flagMechanicalParts(board.parts);
        tab.board = board;
        invalidateDerivedBoard(tab);
        applyBoardFilters(tab);
        log.perf.log(`post-parse: ${(performance.now() - tPost).toFixed(0)}ms (flagMechanical + derive + filters)`);
```

At line ~980, bracket the cache write (Task 5 will restructure this line; keep the timing when it does):

```ts
        const tCache = performance.now();
        await boardCache.put(file.name, file.size, file.lastModified, board);
        log.perf.log(`cache put: ${(performance.now() - tCache).toFixed(0)}ms`);
```

- [ ] **Step 4: Typecheck + unit tests**

Run: `cd src/frontend && npx tsc -b && npm run test:unit`
Expected: both pass (no new test coverage needed — logging only).

- [ ] **Step 5: Manual baseline capture**

Run `npm run dev` (frontend on :8082), open in Chromium:
1. The largest local `.fz` sample, 2. the largest `.xzz`/`.pcb` (XZZ) sample, 3. `samples/TVW/HY568_NMD711R20_View.tvw`, 4. one big Allegro (`samples/allegroBRD/Acer_TravelMate_TMP214_41_..._BoardView.brd`, 43 MB).

For each: open the Debug panel, filter scope `perf`, and record `FZ rc6Decrypt` / `FZ inflate` / `XZZ clusterSegments` / `post-parse` / `cache put` plus the existing `Parsed OK in Xms` line into the table in Task 7. **Delete the IndexedDB cache between runs** (DevTools ▸ Application ▸ IndexedDB ▸ `boardripper-cache` ▸ delete) — a cache hit skips parse entirely.

- [ ] **Step 6: Commit**

```bash
git add src/frontend/src/parsers/fz-parser.ts src/frontend/src/parsers/xzz-parser.ts src/frontend/src/store/board-store.ts
git commit -m "perf(parse): instrument decrypt/inflate/cluster/post-parse/cache stages"
```

---

### Task 2: clusterSegments — spatial hash instead of all-pairs (XZZ)

O(n²) with 4 × `Math.hypot` per pair today (`xzz-parser.ts:206-228`). Replace with an endpoint spatial hash (cell size = eps) + squared-distance compare. Output grouping must be identical.

**Files:**
- Modify: `src/frontend/src/parsers/xzz-parser.ts:206-236`
- Test: `src/frontend/src/parsers/xzz-cluster.test.ts` (new)

**Interfaces:**
- Consumes: nothing new.
- Produces: `export function clusterSegments(segments: Segment[], eps?: number): number[][]` and `export interface Segment { p1: Point; p2: Point }` (both currently module-private — exported for the test; call sites unchanged).

- [ ] **Step 1: Export `Segment` and `clusterSegments`, write the failing parity test**

In `xzz-parser.ts` change `interface Segment` → `export interface Segment` and `function clusterSegments` → `export function clusterSegments`. Create `src/frontend/src/parsers/xzz-cluster.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { clusterSegments, type Segment } from './xzz-parser';

/** Reference: verbatim copy of the pre-optimization all-pairs implementation. */
function clusterSegmentsNaive(segments: Segment[], eps = 1.0): number[][] {
  const n = segments.length;
  if (n === 0) return [];
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  function find(i: number): number {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  }
  function union(a: number, b: number) {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }
  for (let i = 0; i < n; i++) {
    const si = segments[i];
    for (let j = i + 1; j < n; j++) {
      const sj = segments[j];
      if (Math.hypot(si.p1.x - sj.p1.x, si.p1.y - sj.p1.y) < eps ||
          Math.hypot(si.p1.x - sj.p2.x, si.p1.y - sj.p2.y) < eps ||
          Math.hypot(si.p2.x - sj.p1.x, si.p2.y - sj.p1.y) < eps ||
          Math.hypot(si.p2.x - sj.p2.x, si.p2.y - sj.p2.y) < eps) union(i, j);
    }
  }
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    let g = groups.get(r);
    if (!g) { g = []; groups.set(r, g); }
    g.push(i);
  }
  return [...groups.values()];
}

/** Canonicalize: sort members within groups, then groups by first member. */
function canon(groups: number[][]): number[][] {
  return groups.map(g => [...g].sort((a, b) => a - b)).sort((a, b) => a[0] - b[0]);
}

/** Deterministic PRNG (mulberry32). */
function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seg(x1: number, y1: number, x2: number, y2: number): Segment {
  return { p1: { x: x1, y: y1 }, p2: { x: x2, y: y2 } };
}

describe('clusterSegments', () => {
  it('groups a connected chain and isolates a distant segment', () => {
    const segs = [seg(0, 0, 10, 0), seg(10, 0.5, 20, 0), seg(100, 100, 110, 100)];
    expect(canon(clusterSegments(segs))).toEqual([[0, 1], [2]]);
  });

  it('treats distance exactly eps as NOT connected (strict <)', () => {
    const segs = [seg(0, 0, 10, 0), seg(11.0, 0, 20, 0)]; // gap exactly 1.0
    expect(canon(clusterSegments(segs, 1.0))).toEqual([[0], [1]]);
  });

  it('handles negative coordinates across cell boundaries', () => {
    const segs = [seg(-0.4, -0.4, -10, -10), seg(0.4, 0.4, 10, 10)]; // endpoints 1.13 apart… tune: use 0.3
    const close = [seg(-0.3, 0, -10, -10), seg(0.3, 0, 10, 10)];      // 0.6 apart → connected
    expect(canon(clusterSegments(close))).toEqual([[0, 1]]);
    expect(canon(clusterSegments(segs)).length).toBe(2);
  });

  it('matches the all-pairs reference on 500 random segments (three seeds)', () => {
    for (const seedVal of [1, 42, 20260712]) {
      const r = rng(seedVal);
      const segs: Segment[] = [];
      for (let i = 0; i < 500; i++) {
        const x = r() * 80, y = r() * 80;
        segs.push(seg(x, y, x + r() * 4 - 2, y + r() * 4 - 2));
      }
      expect(canon(clusterSegments(segs))).toEqual(canon(clusterSegmentsNaive(segs)));
    }
  });

  it('returns [] on empty input', () => {
    expect(clusterSegments([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test — expect PASS (it currently tests the naive impl against itself)**

Run: `cd src/frontend && npx vitest run src/parsers/xzz-cluster.test.ts`
Expected: PASS. (The parity test's value is pinning behavior BEFORE the rewrite; the failing state comes if the rewrite diverges.)

- [ ] **Step 3: Replace the implementation**

In `xzz-parser.ts`, replace the body of `clusterSegments` (keep `find`/`union` and the group-collection tail exactly as-is):

```ts
export function clusterSegments(segments: Segment[], eps = 1.0): number[][] {
  const n = segments.length;
  if (n === 0) return [];
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  function find(i: number): number {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  }
  function union(a: number, b: number) {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }

  // Spatial hash over endpoints with cell size = eps: two endpoints closer
  // than eps differ by < eps per axis, so they land in the same or an
  // adjacent cell — a 3×3 neighborhood scan finds every qualifying pair.
  // Hash collisions across distant cells are harmless: the exact squared-
  // distance check below rejects them. Replaces the all-pairs scan
  // (4 × Math.hypot per pair, O(n²)) with O(n · local density).
  const epsSq = eps * eps;
  const inv = 1 / eps;
  const xs = new Float64Array(n * 2);
  const ys = new Float64Array(n * 2);
  for (let i = 0; i < n; i++) {
    const s = segments[i];
    xs[i * 2] = s.p1.x;     ys[i * 2] = s.p1.y;
    xs[i * 2 + 1] = s.p2.x; ys[i * 2 + 1] = s.p2.y;
  }
  const keyOf = (cx: number, cy: number) => (Math.imul(cx, 0x9E3779B1) ^ cy) | 0;
  const cells = new Map<number, number[]>();
  for (let e = 0; e < n * 2; e++) {
    const k = keyOf(Math.floor(xs[e] * inv), Math.floor(ys[e] * inv));
    let list = cells.get(k);
    if (!list) { list = []; cells.set(k, list); }
    list.push(e);
  }
  for (let e = 0; e < n * 2; e++) {
    const cx = Math.floor(xs[e] * inv), cy = Math.floor(ys[e] * inv);
    const segE = e >> 1;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const list = cells.get(keyOf(cx + dx, cy + dy));
        if (!list) continue;
        for (const o of list) {
          const segO = o >> 1;
          if (segO <= segE) continue; // each segment pair once; skip self
          const ddx = xs[e] - xs[o], ddy = ys[e] - ys[o];
          if (ddx * ddx + ddy * ddy < epsSq) union(segE, segO);
        }
      }
    }
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    let g = groups.get(r);
    if (!g) { g = []; groups.set(r, g); }
    g.push(i);
  }
  return [...groups.values()];
}
```

- [ ] **Step 4: Run the parity test against the new implementation**

Run: `cd src/frontend && npx vitest run src/parsers/xzz-cluster.test.ts`
Expected: PASS (all 5 tests). If the random-parity test fails, the rewrite has a real behavioral divergence — fix the rewrite, never the reference.

- [ ] **Step 5: End-to-end check on a real XZZ board**

Open the largest XZZ sample in dev; confirm the outline renders identically (screenshot before/after if in doubt) and the Debug panel's `XZZ clusterSegments:` timing dropped.

- [ ] **Step 6: Commit**

```bash
git add src/frontend/src/parsers/xzz-parser.ts src/frontend/src/parsers/xzz-cluster.test.ts
git commit -m "perf(xzz): clusterSegments O(n²) all-pairs → endpoint spatial hash"
```

---

### Task 3: detectGhostComponents — X-sweep prefilter

All-pairs bbox scan per side today (`types.ts:748-757`); runs at parse time for CAD/Mentor/TVW-revision boards. Sort by `bounds.minX` and break the inner loop at the first non-overlapping X — O(n log n + k).

**Files:**
- Modify: `src/frontend/src/parsers/types.ts:748-793` (inside `detectGhostComponents`)
- Test: `src/frontend/src/parsers/ghost-detect.test.ts` (new)

**Interfaces:**
- Consumes: `detectGhostComponents(parts: Part[]): GhostComponent[]` (already exported), `Part`/`Pin` types from `./types`.
- Produces: same signature; `ghosts[]` now sorted by `(partIndex, dominatorIndex)` (content unchanged, order deterministic).

- [ ] **Step 1: Write the failing ordering + parity test**

Create `src/frontend/src/parsers/ghost-detect.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { detectGhostComponents, type Part, type Pin } from './types';

/** Minimal Part builder: rectangular part with one pin per given net at the box corners. */
function makePart(name: string, x0: number, y0: number, x1: number, y1: number, nets: string[], side: 'top' | 'bottom' = 'top'): Part {
  const pins: Pin[] = nets.map((net, i) => ({
    name: String(i + 1),
    net,
    x: i % 2 === 0 ? x0 : x1,
    y: i % 2 === 0 ? y0 : y1,
    side,
  } as unknown as Pin));
  return {
    name,
    side,
    origin: { x: (x0 + x1) / 2, y: (y0 + y1) / 2 },
    bounds: { minX: x0, minY: y0, maxX: x1, maxY: y1 },
    pins,
  } as unknown as Part;
}

describe('detectGhostComponents', () => {
  it('flags an overlapping smaller part whose nets are a subset of the bigger part', () => {
    const dom = makePart('U1', 0, 0, 100, 100, ['SIG_A', 'SIG_B', 'GND']);
    const ghost = makePart('U1_GHOST', 10, 10, 60, 60, ['SIG_A', 'GND']);
    const far = makePart('U2', 500, 500, 600, 600, ['SIG_C', 'GND']);
    const ghosts = detectGhostComponents([dom, ghost, far]);
    expect(ghosts).toHaveLength(1);
    expect(ghosts[0].partName).toBe('U1_GHOST');
    expect(ghosts[0].dominatorName).toBe('U1');
  });

  it('does not flag parts on opposite sides', () => {
    const a = makePart('T1', 0, 0, 100, 100, ['SIG_A', 'SIG_B'], 'top');
    const b = makePart('B1', 10, 10, 60, 60, ['SIG_A'], 'bottom');
    expect(detectGhostComponents([a, b])).toHaveLength(0);
  });

  it('returns ghosts sorted by (partIndex, dominatorIndex) regardless of input order', () => {
    // Two independent ghost pairs, placed so a naive scan would find them
    // in a different order than partIndex order.
    const domB = makePart('UB', 200, 0, 300, 100, ['SIG_X', 'SIG_Y', 'GND']);   // index 0
    const ghostB = makePart('UB_G', 210, 10, 260, 60, ['SIG_X', 'GND']);        // index 1
    const domA = makePart('UA', 0, 0, 100, 100, ['SIG_P', 'SIG_Q', 'GND']);     // index 2
    const ghostA = makePart('UA_G', 10, 10, 60, 60, ['SIG_P', 'GND']);          // index 3
    const ghosts = detectGhostComponents([domB, ghostB, domA, ghostA]);
    expect(ghosts.map(g => g.partIndex)).toEqual([...ghosts.map(g => g.partIndex)].sort((a, b) => a - b));
    expect(ghosts).toHaveLength(2);
  });

  it('scales: 2000 non-overlapping parts complete in bounded time', () => {
    const parts: Part[] = [];
    for (let i = 0; i < 2000; i++) {
      parts.push(makePart(`P${i}`, i * 200, 0, i * 200 + 100, 100, ['SIG_' + i, 'GND']));
    }
    const t0 = performance.now();
    expect(detectGhostComponents(parts)).toHaveLength(0);
    expect(performance.now() - t0).toBeLessThan(500); // all-pairs would do 2M polygon-guard iterations
  });
});
```

- [ ] **Step 2: Run — expect the sort-order test to FAIL (or pass incidentally) and the rest to PASS**

Run: `cd src/frontend && npx vitest run src/parsers/ghost-detect.test.ts`
Expected: functional tests PASS against the current implementation (they pin behavior). If `makePart` trips a helper (`computePartHullPolygon` expects ≥3 pins for OBB — our fixtures use 2–3 pins → AABB path), adjust fixtures, not the implementation.

- [ ] **Step 3: Implement the sweep**

In `types.ts`, replace the pair loop inside `detectGhostComponents` (lines 748-757 head; body of the pair stays identical):

```ts
  for (const side of [topIdx, botIdx]) {
    // X-sweep: with the side's parts sorted by bounds.minX, every bbox-overlap
    // partner of `a` lies before the first part whose minX >= a.maxX — the
    // inner loop breaks there instead of scanning all pairs (O(n²) → O(n log n + k)).
    const sorted = [...side].sort((x, y) => parts[x].bounds.minX - parts[y].bounds.minX);
    for (let i = 0; i < sorted.length; i++) {
      const ai = sorted[i];
      const a = parts[ai];
      const aBB = a.bounds;
      const aNets = netSets[ai];
      for (let j = i + 1; j < sorted.length; j++) {
        const bi = sorted[j];
        const b = parts[bi];
        if (b.bounds.minX >= aBB.maxX) break;
        if (!bboxOverlap(aBB, b.bounds)) continue;
        // ... existing pair body from here on, UNCHANGED (polygonsOverlap,
        // dominator/ghost selection, isSubset, hasSignal, flagged, push) ...
      }
    }
  }
  // Deterministic output order independent of sweep order.
  ghosts.sort((g1, g2) => g1.partIndex - g2.partIndex || g1.dominatorIndex - g2.dominatorIndex);
  return ghosts;
```

Note: the pair body references `a`, `b`, `ai`, `bi`, `aBB`, `aNets` — the names are preserved above so the body needs zero edits.

- [ ] **Step 4: Run the tests**

Run: `cd src/frontend && npx vitest run src/parsers/ghost-detect.test.ts && npm run test:unit`
Expected: all PASS, including the 2000-part timing bound.

- [ ] **Step 5: Real-board check**

Open a CAD sample with known ghosts (see `bom-clusters.spec.ts` fixtures for candidates) — ghost count in the UI must be unchanged.

- [ ] **Step 6: Commit**

```bash
git add src/frontend/src/parsers/types.ts src/frontend/src/parsers/ghost-detect.test.ts
git commit -m "perf(parse): detectGhostComponents all-pairs → X-sweep prefilter, deterministic order"
```

---

### Task 4: RC6 rolling-window registers (FZ)

The per-byte 16-element `ibuf` shuffle + 4 × `readU32LE` (`fz-parser.ts:121-128`) is ~25 avoidable array ops per byte. Keep the window as four rolling uint32s. Output must be byte-identical — parity-tested against a verbatim copy of the current code.

**Files:**
- Modify: `src/frontend/src/parsers/fz-parser.ts:91-130`
- Test: `src/frontend/src/parsers/fz-rc6.test.ts` (new)

**Interfaces:**
- Consumes: `rotl32` (fz-parser.ts:32), `RC6_ROUNDS`.
- Produces: `export function rc6Decrypt(data: Uint8Array, key: Uint32Array): void` (exported for the test; call site at :408 unchanged).

- [ ] **Step 1: Export `rc6Decrypt`, write the parity test**

Change `function rc6Decrypt` → `export function rc6Decrypt`. Create `src/frontend/src/parsers/fz-rc6.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { rc6Decrypt } from './fz-parser';

const RC6_ROUNDS = 20;

function rotl32(val: number, shift: number): number {
  shift &= 31;
  return ((val << shift) | (val >>> (32 - shift))) >>> 0;
}
function readU32LE(buf: Uint8Array, off: number): number {
  return ((buf[off]) | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 0;
}

/** Reference: verbatim copy of the pre-optimization implementation. */
function rc6DecryptReference(data: Uint8Array, key: Uint32Array): void {
  const r = RC6_ROUNDS;
  const ibuf = new Uint8Array(16);
  let A = 0, B = 0, C = 0, D = 0;
  for (let pos = 0; pos < data.length; pos++) {
    B = (B + key[0]) >>> 0;
    D = (D + key[1]) >>> 0;
    for (let i = 1; i <= r; i++) {
      const t = rotl32(Math.imul(B, (2 * B + 1) >>> 0) >>> 0, 5);
      const u = rotl32(Math.imul(D, (2 * D + 1) >>> 0) >>> 0, 5);
      A = (rotl32(A ^ t, u) + key[2 * i]) >>> 0;
      C = (rotl32(C ^ u, t) + key[2 * i + 1]) >>> 0;
      const tmpA = A;
      A = B; B = C; C = D; D = tmpA;
    }
    A = (A + key[2 * r + 2]) >>> 0;
    C = (C + key[2 * r + 3]) >>> 0;
    const encrypted = data[pos];
    data[pos] = (encrypted ^ (A & 0xFF)) & 0xFF;
    for (let j = 0; j < 15; j++) ibuf[j] = ibuf[j + 1];
    ibuf[15] = encrypted;
    A = readU32LE(ibuf, 0);
    B = readU32LE(ibuf, 4);
    C = readU32LE(ibuf, 8);
    D = readU32LE(ibuf, 12);
  }
}

function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0);
  };
}

describe('rc6Decrypt parity', () => {
  it('matches the reference on random data at window-edge sizes', () => {
    for (const size of [0, 1, 15, 16, 17, 31, 33, 1000, 65536]) {
      const r = rng(size + 7);
      const key = new Uint32Array(44);
      for (let i = 0; i < 44; i++) key[i] = r();
      const src = new Uint8Array(size);
      for (let i = 0; i < size; i++) src[i] = r() & 0xFF;
      const a = src.slice(), b = src.slice();
      rc6Decrypt(a, key);
      rc6DecryptReference(b, key);
      expect(a).toEqual(b);
    }
  });
});
```

- [ ] **Step 2: Run — expect PASS (pins current behavior before the rewrite)**

Run: `cd src/frontend && npx vitest run src/parsers/fz-rc6.test.ts`
Expected: PASS.

- [ ] **Step 3: Rewrite the hot loop**

Replace the body of `rc6Decrypt` in `fz-parser.ts`:

```ts
export function rc6Decrypt(data: Uint8Array, key: Uint32Array): void {
  const r = RC6_ROUNDS;
  const k0 = key[0], k1 = key[1];
  const kEnd0 = key[2 * r + 2], kEnd1 = key[2 * r + 3];
  // The 16-byte ciphertext feedback window, held as four rolling LE uint32
  // words (w0 = oldest four bytes). Sliding the window one byte is four
  // shift-merges — replaces the byte-array shuffle + 4 readU32LE per byte.
  let w0 = 0, w1 = 0, w2 = 0, w3 = 0;
  let A = 0, B = 0, C = 0, D = 0;

  for (let pos = 0; pos < data.length; pos++) {
    B = (B + k0) >>> 0;
    D = (D + k1) >>> 0;

    for (let i = 1; i <= r; i++) {
      const t = rotl32(Math.imul(B, (2 * B + 1) >>> 0) >>> 0, 5);
      const u = rotl32(Math.imul(D, (2 * D + 1) >>> 0) >>> 0, 5);
      A = (rotl32(A ^ t, u) + key[2 * i]) >>> 0;
      C = (rotl32(C ^ u, t) + key[2 * i + 1]) >>> 0;
      const tmpA = A;
      A = B; B = C; C = D; D = tmpA;
    }

    A = (A + kEnd0) >>> 0;
    C = (C + kEnd1) >>> 0;

    const encrypted = data[pos];
    data[pos] = (encrypted ^ (A & 0xFF)) & 0xFF;

    w0 = ((w0 >>> 8) | ((w1 & 0xFF) << 24)) >>> 0;
    w1 = ((w1 >>> 8) | ((w2 & 0xFF) << 24)) >>> 0;
    w2 = ((w2 >>> 8) | ((w3 & 0xFF) << 24)) >>> 0;
    w3 = ((w3 >>> 8) | (encrypted << 24)) >>> 0;
    A = w0; B = w1; C = w2; D = w3;
  }
}
```

- [ ] **Step 4: Run the parity test + FZ E2E spec**

Run: `cd src/frontend && npx vitest run src/parsers/fz-rc6.test.ts && npx playwright test tests/fz-parser.spec.ts`
Expected: vitest PASS; the FZ Playwright spec passes at its pre-change baseline.

- [ ] **Step 5: Measure**

Re-open the biggest `.fz` sample (cache cleared) and record the new `FZ rc6Decrypt:` timing in Task 7's table. Expect roughly 15-30% off the baseline (register math replaces ~25 array ops of ~150 total per byte).

- [ ] **Step 6: Commit**

```bash
git add src/frontend/src/parsers/fz-parser.ts src/frontend/src/parsers/fz-rc6.test.ts
git commit -m "perf(fz): RC6 feedback window as rolling u32 registers (parity-tested)"
```

---

### Task 5: Take the IndexedDB cache write off the load critical path

`await boardCache.put(...)` at `board-store.ts:980` blocks the renderer handoff (`onTabCreated` at :1004) on serializing the whole board; a put failure currently aborts the entire load (the catch at :987 removes the tab) even though the board parsed fine.

**Files:**
- Modify: `src/frontend/src/store/board-store.ts:979-980`

**Interfaces:**
- Consumes: `boardCache.put` (unchanged), `log.cache` / `log.perf`.
- Produces: no API change. Load-progress phase `'Writing cache'` disappears; a `pushLog` line replaces it.

- [ ] **Step 1: Make the write fire-and-forget**

Replace lines 979-980 (including Task 1's timing wrapper):

```ts
        // Cache write runs in the background — the renderer handoff below must
        // not wait on IndexedDB serialization (hundreds of ms on big boards),
        // and a failed write must not fail the load (the board is already good).
        loadProgressStore.pushLog('Cache write scheduled (background)');
        const tCache = performance.now();
        void boardCache.put(file.name, file.size, file.lastModified, board)
          .then(() => log.perf.log(`cache put: ${(performance.now() - tCache).toFixed(0)}ms (background)`))
          .catch(e => log.cache.error(`Cache write failed for ${file.name}:`, e));
```

Leave the re-parse paths (:1608, :1638) awaited — they are rare, user-initiated, and their correctness depends on the cache entry being swapped before completion is reported.

- [ ] **Step 2: Typecheck + targeted E2E**

Run: `cd src/frontend && npx tsc -b && npx playwright test tests/ci-smoke.spec.ts`
Expected: pass at baseline.

- [ ] **Step 3: Verify ordering by log**

Open a large board (cache cleared). In the Debug panel confirm the scene-build phase starts (`Building scene` progress) before `cache put: …ms (background)` lands. Reload the app, open the same file — confirm `Cache hit:` still appears (the background write completed and persisted).

- [ ] **Step 4: Commit**

```bash
git add src/frontend/src/store/board-store.ts
git commit -m "perf(load): IndexedDB cache write off the critical path, non-fatal on failure"
```

---

### Task 6: Parse in a module Web Worker (with inline fallback)

Everything from `file.arrayBuffer()` to `BoardData` runs on the main thread today; a 380 MB Allegro parse freezes the tab for its whole duration. Move `parseBoardFile` into a Vite module worker. The FZ key must be injected (workers have no localStorage — `fz-format.ts:37` reads `getFzKey()` whose store falls back safely to `null` in a worker); `FZKeyError` must round-trip so the key dialog keeps working; parser log lines are forwarded so the Debug panel stays useful.

**Files:**
- Create: `src/frontend/src/parsers/parse-worker.ts`
- Create: `src/frontend/src/parsers/parse-in-worker.ts`
- Modify: `src/frontend/src/store/board-store.ts` (:922, :930, :1600, :1631)
- Test: `src/frontend/tests/parse-worker.spec.ts` (new)

**Interfaces:**
- Consumes: `parseBoardFile(buffer, fileName): Promise<BoardData>` from `parsers/index.ts`; `fzKeyStore.key: Uint32Array | null` (public field, `fz-key-store.ts:125`); `FZKeyError` from `fz-parser.ts`; `logStore.subscribe(cb): () => void` + `logStore.getSnapshot(): LogEntry[]` (`log-store.ts`).
- Produces: `parseBoardFileInWorker(buffer: ArrayBuffer, fileName: string): Promise<BoardData>` — drop-in replacement for `parseBoardFile` at the four board-store call sites. **The input buffer is transferred (detached) on the worker path** — callers must not reuse it (the FZ retry re-reads the File).

- [ ] **Step 1: Write the worker entry**

Create `src/frontend/src/parsers/parse-worker.ts`:

```ts
/// <reference lib="webworker" />
// Module worker that runs the full parse pipeline off the main thread.
// The worker gets its own instances of every store module it imports; the
// two that matter are handled explicitly: fz-key-store (key injected per
// request — no localStorage here) and log-store (entries forwarded so the
// main thread's Debug panel still shows parser output).
import { parseBoardFile } from './index';
import { FZKeyError } from './fz-parser';
import { fzKeyStore } from '../store/fz-key-store';
import { logStore, type LogLevel, type LogScope } from '../store/log-store';

export interface ParseWorkerRequest {
  id: number;
  buffer: ArrayBuffer;
  fileName: string;
  fzKey: Uint32Array | null;
}

export type ParseWorkerResponse =
  | { id: number; ok: true; board: unknown }
  | { id: number; ok: false; errName: string; message: string; fzReason?: 'missing' | 'invalid' };

export interface ParseWorkerLogMsg {
  log: { level: LogLevel; scope: LogScope; message: string };
}

const post = (msg: ParseWorkerResponse | ParseWorkerLogMsg, transfer?: Transferable[]) =>
  (self as unknown as { postMessage(m: unknown, t?: Transferable[]): void }).postMessage(msg, transfer);

let lastForwardedLogId = 0;
logStore.subscribe(() => {
  for (const e of logStore.getSnapshot()) {
    if (e.id <= lastForwardedLogId) continue;
    lastForwardedLogId = e.id;
    post({ log: { level: e.level, scope: e.scope, message: e.message } });
  }
});

self.onmessage = async (ev: MessageEvent<ParseWorkerRequest>) => {
  const { id, buffer, fileName, fzKey } = ev.data;
  fzKeyStore.key = fzKey; // worker has no localStorage — inject per request
  try {
    const board = await parseBoardFile(buffer, fileName);
    try {
      post({ id, ok: true, board });
    } catch (cloneErr) {
      // Non-cloneable BoardData (should not happen — it survives IDB) —
      // report so the main side falls back to inline parsing.
      post({ id, ok: false, errName: 'DataCloneError', message: String(cloneErr) });
    }
  } catch (e) {
    post({
      id, ok: false,
      errName: e instanceof Error ? e.name : 'Error',
      message: e instanceof Error ? e.message : String(e),
      ...(e instanceof FZKeyError ? { fzReason: e.reason } : {}),
    });
  }
};
```

- [ ] **Step 2: Write the main-thread wrapper**

Create `src/frontend/src/parsers/parse-in-worker.ts`:

```ts
// Main-thread façade for parse-worker.ts. Falls back to inline parseBoardFile
// when workers are unavailable, when the worker crashes, or when a result
// fails to structured-clone. The input ArrayBuffer is TRANSFERRED to the
// worker (zero-copy) — it is detached afterwards; callers must not reuse it.
import { parseBoardFile } from './index';
import { FZKeyError } from './fz-parser';
import { getFzKey } from '../store/fz-key-store';
import { log } from '../store/log-store';
import type { BoardData } from './types';
import type { ParseWorkerRequest, ParseWorkerResponse, ParseWorkerLogMsg } from './parse-worker';

let worker: Worker | null = null;
let workerBroken = false;
let nextId = 1;
const pending = new Map<number, { resolve: (b: BoardData) => void; reject: (e: unknown) => void }>();

// Scope-checked relay: forwarded entries re-enter the main log store under
// their original scope so Debug-panel filtering keeps working.
function relayLog(m: ParseWorkerLogMsg['log']): void {
  const scoped = (log as Record<string, { log: (s: string) => void; warn: (s: string) => void; error: (s: string) => void }>)[m.scope] ?? log.parser;
  scoped[m.level](m.message);
}

function ensureWorker(): Worker | null {
  if (workerBroken) return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL('./parse-worker.ts', import.meta.url), { type: 'module' });
  } catch (e) {
    log.parser.warn('Parse worker unavailable — parsing inline:', String(e));
    workerBroken = true;
    return null;
  }
  worker.onmessage = (ev: MessageEvent<ParseWorkerResponse | ParseWorkerLogMsg>) => {
    if ('log' in ev.data) { relayLog(ev.data.log); return; }
    const resp = ev.data;
    const p = pending.get(resp.id);
    if (!p) return;
    pending.delete(resp.id);
    if (resp.ok) p.resolve(resp.board as BoardData);
    else if (resp.fzReason) p.reject(new FZKeyError(resp.fzReason));
    else p.reject(Object.assign(new Error(resp.message), { name: resp.errName }));
  };
  worker.onerror = (e) => {
    log.parser.error('Parse worker crashed — falling back to inline parsing:', e.message);
    for (const p of pending.values()) p.reject(Object.assign(new Error('parse worker crashed'), { name: 'WorkerCrash' }));
    pending.clear();
    worker?.terminate();
    worker = null;
    workerBroken = true;
  };
  return worker;
}

export async function parseBoardFileInWorker(buffer: ArrayBuffer, fileName: string): Promise<BoardData> {
  const w = ensureWorker();
  if (!w) return parseBoardFile(buffer, fileName);
  const id = nextId++;
  const req: ParseWorkerRequest = { id, buffer, fileName, fzKey: getFzKey() };
  try {
    const board = await new Promise<BoardData>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      w.postMessage(req, [buffer]); // transfer — buffer is detached from here
    });
    log.parser.log(`Parsed in worker: ${fileName}`);
    return board;
  } catch (e) {
    if (e instanceof Error && (e.name === 'DataCloneError' || e.name === 'WorkerCrash')) {
      // Buffer was transferred and is gone — the caller must supply bytes
      // again for a retry, so surface a distinct, actionable error.
      log.parser.warn(`Worker parse failed (${e.name}) — caller should retry inline with fresh bytes`);
    }
    throw e;
  }
}
```

- [ ] **Step 3: Switch board-store to the worker path**

In `board-store.ts` add the import and replace the four `parseBoardFile(` call sites (:922, :930, :1600, :1631) with `parseBoardFileInWorker(`. Because the buffer is transferred, the FZ-key retry at :930 must re-read the file:

```ts
        let board;
        try {
          board = await parseBoardFileInWorker(buffer, file.name);
        } catch (e) {
          if (e instanceof FZKeyError) {
            if (e.reason === 'invalid') fzKeyStore.clearKey();
            const ok = await fzKeyStore.ensureFzKey();
            if (!ok) throw e;
            // First buffer was transferred to the worker — read fresh bytes.
            board = await parseBoardFileInWorker(await file.arrayBuffer(), file.name);
          } else if (e instanceof Error && (e.name === 'DataCloneError' || e.name === 'WorkerCrash')) {
            log.parser.warn(`Worker parse failed for ${file.name} — retrying inline`);
            board = await parseBoardFile(await file.arrayBuffer(), file.name);
          } else {
            throw e;
          }
        }
```

Apply the same transferred-buffer rule at :1600/:1631 (both have the `File` at hand — pass `await file.arrayBuffer()` directly into `parseBoardFileInWorker` and re-read on inline fallback).

- [ ] **Step 4: Typecheck + full unit tests**

Run: `cd src/frontend && npx tsc -b && npm run test:unit`
Expected: pass. If `tsc` flags the worker file's `self` typing, confirm `/// <reference lib="webworker" />` is the first line.

- [ ] **Step 5: Write the E2E spec**

Create `src/frontend/tests/parse-worker.spec.ts`:

```ts
import { test, expect } from '@playwright/test';
import * as path from 'path';

// The worker path must (a) actually be used, (b) produce a working board.
// Uses a text-format sample so no decryption key is involved.
test('board parse runs in the worker and the board opens', async ({ page }) => {
  await page.goto('/');
  const consoleLines: string[] = [];
  page.on('console', m => consoleLines.push(m.text()));

  const sample = path.resolve(__dirname, '../../../samples/820-02016/820-02016.bvr');
  const input = page.locator('input[type="file"]').first();
  await input.setInputFiles(sample);

  // Board tab appears and the scene builds (status bar shows part count).
  await expect(page.locator('.dv-default-tab, [data-testid="board-tab"]').first()).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(() => consoleLines.some(l => l.includes('Parsed in worker: 820-02016.bvr')), { timeout: 30_000 })
    .toBe(true);
});
```

(Adjust the sample path/locators to the conventions used by `tests/fz-parser.spec.ts` if they differ — the assertion that matters is the `Parsed in worker:` console line plus a visible board tab.)

- [ ] **Step 6: Run the E2E spec + the format cohort**

Run: `cd src/frontend && npx playwright test tests/parse-worker.spec.ts tests/cross-format.spec.ts tests/fz-parser.spec.ts`
Expected: `parse-worker.spec.ts` green; the other two at their pre-change baseline (compare against a baseline run from before this task — headless WebGL failures are pre-existing).

- [ ] **Step 7: Manual jank check**

Open the 43 MB Allegro sample (cache cleared) in dev. While the progress overlay shows "Parsing", verify the UI stays responsive (e.g. the Debug panel scrolls, hover states react). Before this task the tab froze for the whole parse.

- [ ] **Step 8: Commit**

```bash
git add src/frontend/src/parsers/parse-worker.ts src/frontend/src/parsers/parse-in-worker.ts src/frontend/src/store/board-store.ts src/frontend/tests/parse-worker.spec.ts
git commit -m "perf(parse): run parseBoardFile in a module worker with inline fallback"
```

---

### Task 7: Measurement gate — decide on the WASM kernel follow-up

No code. Fill the table below from the Task-1 logs (cache cleared before every run, same machine, dev build), then apply the decision rule.

**Files:**
- Modify: this file (record results).

- [ ] **Step 1: Record post-optimization timings**

| Sample | Format | Size | `rc6Decrypt`/DES-dominated parse | `clusterSegments` | `post-parse` | total `Parsed OK` | UI frozen? |
|---|---|---|---|---|---|---|---|
| (largest .fz) | FZ | | baseline: ___ ms → after T4: ___ ms | n/a | | | no (T6) |
| (largest .xzz) | XZZ | | ___ ms | baseline: ___ → after T2: ___ | | | no (T6) |
| Acer TMP214 | ALLEGRO | 43 MB | n/a | n/a | | | no (T6) |
| HY568 | TVW | 35 MB | n/a | n/a | after T3: ___ | | no (T6) |

- [ ] **Step 2: Apply the decision rule**

- If `FZ rc6Decrypt` **> 500 ms** on the largest real FZ file after Task 4, OR total XZZ DES-dominated parse **> 500 ms** after Tasks 2/6: write a follow-up plan for a Rust→WASM `rc6_fz`/`des_xzz` kernel pair (~300 lines, MIT/Apache licensed, loaded lazily inside the parse worker, TS implementations retained as parity-tested fallback). Expected 5-15× on the kernels per `docs/research/wasm-webgpu-acceleration-plan.md` §2.
- Otherwise: WASM is not warranted — the worker (Task 6) already removed the user-facing freeze, and the remaining first-open latency is acceptable. Record the numbers and close.

- [ ] **Step 3: Commit the recorded results**

```bash
git add docs/plans/2026-07-12-parse-time-optimization-plan.md
git commit -m "docs(perf): record parse-time results, WASM gate decision"
```
