import type { BoardData, Part, Pin, Nail, Point, Trace, SilkscreenPath, Pad, DiodeReading, DiodeReferenceChannel } from './types';
import { computeBBox, buildNets } from './types';
import { detectXMirrorByPinDirection } from './mirror-detect';
import { log } from '../store/log-store';

// =====================================================================
// Fast DES (FIPS PUB 46-3) — Number-based, precomputed tables
// Subkeys precomputed with BigInt once at module init; hot path is pure 32-bit ops.
// =====================================================================

const S_BOXES: ReadonlyArray<ReadonlyArray<number>> = [
  [14,4,13,1,2,15,11,8,3,10,6,12,5,9,0,7, 0,15,7,4,14,2,13,1,10,6,12,11,9,5,3,8, 4,1,14,8,13,6,2,11,15,12,9,7,3,10,5,0, 15,12,8,2,4,9,1,7,5,11,3,14,10,0,6,13],
  [15,1,8,14,6,11,3,4,9,7,2,13,12,0,5,10, 3,13,4,7,15,2,8,14,12,0,1,10,6,9,11,5, 0,14,7,11,10,4,13,1,5,8,12,6,9,3,2,15, 13,8,10,1,3,15,4,2,11,6,7,12,0,5,14,9],
  [10,0,9,14,6,3,15,5,1,13,12,7,11,4,2,8, 13,7,0,9,3,4,6,10,2,8,5,14,12,11,15,1, 13,6,4,9,8,15,3,0,11,1,2,12,5,10,14,7, 1,10,13,0,6,9,8,7,4,15,14,3,11,5,2,12],
  [7,13,14,3,0,6,9,10,1,2,8,5,11,12,4,15, 13,8,11,5,6,15,0,3,4,7,2,12,1,10,14,9, 10,6,9,0,12,11,7,13,15,1,3,14,5,2,8,4, 3,15,0,6,10,1,13,8,9,4,5,11,12,7,2,14],
  [2,12,4,1,7,10,11,6,8,5,3,15,13,0,14,9, 14,11,2,12,4,7,13,1,5,0,15,10,3,9,8,6, 4,2,1,11,10,13,7,8,15,9,12,5,6,3,0,14, 11,8,12,7,1,14,2,13,6,15,0,9,10,4,5,3],
  [12,1,10,15,9,2,6,8,0,13,3,4,14,7,5,11, 10,15,4,2,7,12,9,5,6,1,13,14,0,11,3,8, 9,14,15,5,2,8,12,3,7,0,4,10,1,13,11,6, 4,3,2,12,9,5,15,10,11,14,1,7,6,0,8,13],
  [4,11,2,14,15,0,8,13,3,12,9,7,5,10,6,1, 13,0,11,7,4,9,1,10,14,3,5,12,2,15,8,6, 1,4,11,13,12,3,7,14,10,15,6,8,0,5,9,2, 6,11,13,8,1,4,10,7,9,5,0,15,14,2,3,12],
  [13,2,8,4,6,15,11,1,10,9,3,14,5,0,12,7, 1,15,13,8,10,3,7,4,12,5,6,11,0,14,9,2, 7,11,4,1,9,12,14,2,0,6,10,13,15,3,5,8, 2,1,14,7,4,10,8,13,15,12,9,0,3,5,6,11],
];

const P_TABLE = [16,7,20,21,29,12,28,17,1,15,23,26,5,18,31,10,2,8,24,14,32,27,3,9,19,13,30,6,22,11,4,25];

const IP_TABLE = [
  58,50,42,34,26,18,10,2, 60,52,44,36,28,20,12,4, 62,54,46,38,30,22,14,6, 64,56,48,40,32,24,16,8,
  57,49,41,33,25,17, 9,1, 59,51,43,35,27,19,11,3, 61,53,45,37,29,21,13,5, 63,55,47,39,31,23,15,7,
];

const IP_INV_TABLE = [
  40, 8,48,16,56,24,64,32, 39,7,47,15,55,23,63,31, 38,6,46,14,54,22,62,30, 37,5,45,13,53,21,61,29,
  36, 4,44,12,52,20,60,28, 35,3,43,11,51,19,59,27, 34,2,42,10,50,18,58,26, 33,1,41, 9,49,17,57,25,
];

// Key schedule tables
const PC1 = [57,49,41,33,25,17,9,1,58,50,42,34,26,18,10,2,59,51,43,35,27,19,11,3,60,52,44,36,63,55,47,39,31,23,15,7,62,54,46,38,30,22,14,6,61,53,45,37,29,21,13,5,28,20,12,4];
const PC2 = [14,17,11,24,1,5,3,28,15,6,21,10,23,19,12,4,26,8,16,7,27,20,13,2,41,52,31,37,47,55,30,40,51,45,33,48,44,49,39,56,34,53,46,42,50,36,29,32];
const ITER_SHIFT = [1,1,2,2,2,2,2,2,1,2,2,2,2,2,2,1];
const DES_KEY_BIG = 0xdcfc12ac00000000n;

// ---- precomputed tables (populated once at module init) ----

/** SP[sbox][6-bit-input] = 32-bit output after S-box + P permutation */
const SP = new Array<Int32Array>(8);

/** IP byte lookup: IP_HI[byteIdx*256 + byteVal] = hi32 contribution */
const IP_HI  = new Int32Array(8 * 256);
const IP_LO  = new Int32Array(8 * 256);
const FP_HI  = new Int32Array(8 * 256); // IP_INV
const FP_LO  = new Int32Array(8 * 256);

/** Subkeys: [kHi24, kLo24] for each of 16 rounds */
const SUBKEYS_HI = new Int32Array(16);
const SUBKEYS_LO = new Int32Array(16);

function buildPermLookup(
  table: number[], outHi: Int32Array, outLo: Int32Array,
) {
  for (let byteIdx = 0; byteIdx < 8; byteIdx++) {
    for (let val = 0; val < 256; val++) {
      let hi = 0, lo = 0;
      for (let bit = 0; bit < 8; bit++) {
        if ((val >>> (7 - bit)) & 1) {
          const inputFips = byteIdx * 8 + bit + 1; // 1-indexed FIPS bit position
          for (let o = 0; o < 64; o++) {
            if (table[o] === inputFips) {
              if (o < 32) hi |= 1 << (31 - o);
              else        lo |= 1 << (63 - o);
            }
          }
        }
      }
      outHi[byteIdx * 256 + val] = hi;
      outLo[byteIdx * 256 + val] = lo;
    }
  }
}

function applyPerm64(
  hiTbl: Int32Array, loTbl: Int32Array,
  b0: number, b1: number, b2: number, b3: number,
  b4: number, b5: number, b6: number, b7: number,
): [number, number] {
  return [
    (hiTbl[b0] | hiTbl[256+b1] | hiTbl[512+b2] | hiTbl[768+b3] |
     hiTbl[1024+b4] | hiTbl[1280+b5] | hiTbl[1536+b6] | hiTbl[1792+b7]) >>> 0,
    (loTbl[b0] | loTbl[256+b1] | loTbl[512+b2] | loTbl[768+b3] |
     loTbl[1024+b4] | loTbl[1280+b5] | loTbl[1536+b6] | loTbl[1792+b7]) >>> 0,
  ];
}

/** BigInt permutation used only for key schedule (runs once) */
function permBig(v: bigint, tbl: number[], nb: number): bigint {
  let r = 0n;
  for (let i = 0; i < tbl.length; i++) r = (r << 1n) | ((v >> BigInt(nb - tbl[i])) & 1n);
  return r;
}

function init() {
  // Build IP and IP_INV byte lookup tables
  buildPermLookup(IP_TABLE,     IP_HI, IP_LO);
  buildPermLookup(IP_INV_TABLE, FP_HI, FP_LO);

  // Build SP tables (S-box + P permutation combined)
  for (let j = 0; j < 8; j++) {
    SP[j] = new Int32Array(64);
    for (let v = 0; v < 64; v++) {
      const row  = ((v & 0x20) >> 4) | (v & 1);
      const col  = (v >> 1) & 0xF;
      const sval = S_BOXES[j][row * 16 + col];
      // Place 4-bit S output at bits 31..28-j*4 of a 32-bit value, then apply P
      const sOut = (sval << (28 - j * 4)) >>> 0;
      let pOut = 0;
      for (let i = 0; i < 32; i++) {
        // Output FIPS bit (i+1) comes from input FIPS bit P_TABLE[i]
        if ((sOut >>> (32 - P_TABLE[i])) & 1) pOut |= 1 << (31 - i);
      }
      SP[j][v] = pOut;
    }
  }

  // Compute 16 DES subkeys using BigInt (runs once)
  const K56 = permBig(DES_KEY_BIG, PC1, 64);
  let C = K56 >> 28n, D = K56 & 0xFFFFFFFn;
  for (let i = 0; i < 16; i++) {
    const sh = BigInt(ITER_SHIFT[i]);
    C = ((C << sh) | (C >> (28n - sh))) & 0xFFFFFFFn;
    D = ((D << sh) | (D >> (28n - sh))) & 0xFFFFFFFn;
    const subkey = permBig((C << 28n) | D, PC2, 56);
    // Split into hi24 (bits 47-24) and lo24 (bits 23-0)
    SUBKEYS_HI[i] = Number(subkey >> 24n) & 0xFFFFFF;
    SUBKEYS_LO[i] = Number(subkey & 0xFFFFFFn);
  }
}

// --- run at module load ---
init();

/** Decrypt buf[off..off+8] in-place using DES with XZZ byte-reversal convention */
function desDecryptBlock(buf: Uint8Array, off: number): void {
  // XZZ reads bytes as big-endian 64-bit: buf[off] = MSByte
  // Apply IP permutation
  const [L0, R0] = applyPerm64(IP_HI, IP_LO,
    buf[off], buf[off+1], buf[off+2], buf[off+3],
    buf[off+4], buf[off+5], buf[off+6], buf[off+7]);

  let L = L0, R = R0;

  // 16 Feistel rounds (decryption: reverse subkey order)
  for (let i = 0; i < 16; i++) {
    const kHi = SUBKEYS_HI[15 - i];
    const kLo = SUBKEYS_LO[15 - i];

    // E expansion groups XOR subkey, then SP lookup
    const g0 = (((R & 1) << 5) | ((R >>> 27) & 0x1F)) ^ ((kHi >>> 18) & 0x3F);
    const g1 = ((R >>> 23) & 0x3F)                     ^ ((kHi >>> 12) & 0x3F);
    const g2 = ((R >>> 19) & 0x3F)                     ^ ((kHi >>>  6) & 0x3F);
    const g3 = ((R >>> 15) & 0x3F)                     ^ ( kHi         & 0x3F);
    const g4 = ((R >>> 11) & 0x3F)                     ^ ((kLo >>> 18) & 0x3F);
    const g5 = ((R >>>  7) & 0x3F)                     ^ ((kLo >>> 12) & 0x3F);
    const g6 = ((R >>>  3) & 0x3F)                     ^ ((kLo >>>  6) & 0x3F);
    const g7 = (((R & 0x1F) << 1) | ((R >>> 31) & 1))  ^ ( kLo         & 0x3F);

    const f = (SP[0][g0] ^ SP[1][g1] ^ SP[2][g2] ^ SP[3][g3] ^
               SP[4][g4] ^ SP[5][g5] ^ SP[6][g6] ^ SP[7][g7]) >>> 0;

    const newR = (L ^ f) >>> 0;
    L = R;
    R = newR;
  }

  // Apply final permutation (IP_INV) on preoutput = R || L
  const [oHi, oLo] = applyPerm64(FP_HI, FP_LO,
    (R >>> 24) & 0xFF, (R >>> 16) & 0xFF, (R >>> 8) & 0xFF, R & 0xFF,
    (L >>> 24) & 0xFF, (L >>> 16) & 0xFF, (L >>> 8) & 0xFF, L & 0xFF);

  buf[off]   = (oHi >>> 24) & 0xFF;
  buf[off+1] = (oHi >>> 16) & 0xFF;
  buf[off+2] = (oHi >>>  8) & 0xFF;
  buf[off+3] =  oHi          & 0xFF;
  buf[off+4] = (oLo >>> 24) & 0xFF;
  buf[off+5] = (oLo >>> 16) & 0xFF;
  buf[off+6] = (oLo >>>  8) & 0xFF;
  buf[off+7] =  oLo          & 0xFF;
}

/** Return a decrypted copy of buf */
function desDecrypt(buf: Uint8Array): Uint8Array {
  const out = new Uint8Array(buf);
  for (let off = 0; off + 8 <= out.length; off += 8) desDecryptBlock(out, off);
  return out;
}

// =====================================================================
// XZZ PCB File Parser
// =====================================================================

const XZZ_SCALE  = 10000;
const OUTLINE_LAYER = 28;
const SILKSCREEN_LAYER = 17;
const decoder = new TextDecoder('utf-8', { fatal: false });

interface Segment { p1: Point; p2: Point; }

/** Group outline segments into connected components via endpoint-proximity union-find.
 *  Two segments share a component if any endpoint-pair is within `eps` mils. */
function clusterSegments(segments: Segment[], eps = 1.0): number[][] {
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

/** Walk a connected component's segments by endpoint topology instead of
 *  greedy nearest-neighbor. Produces one sub-path per open walk; closed loops
 *  produce one closed chain. `eps` is the endpoint-proximity tolerance used to
 *  decide if two segments share a vertex — must match `clusterSegments()`, or
 *  the walker will emit sub-chains that aren't actually disconnected (closing
 *  them produces stray triangles under `gfx.closePath()`).
 *
 *  The shared `chainSegments()` in `types.ts` picks the globally-nearest unused
 *  segment at each step, which zigzags across the board whenever two unrelated
 *  segments happen to be closer than the true topological neighbor. This
 *  walker only follows segments that *share* the current endpoint (within
 *  `eps` mils), so cross-board jumps are impossible.
 *
 *  Bi-directional walking: every chain is grown from BOTH ends of its seed
 *  segment. This is load-bearing — without it, a seed segment picked from the
 *  middle of a long chain whose neighbor on one side was already consumed by
 *  an earlier walk emits as a 2-point chain and the rest of the linked arc
 *  becomes a sequence of orphan 2-point sub-paths (one per segment). Visible
 *  as scattered stray lines along rounded-corner arcs on iPhone .pcb files.
 */
function chainComponent(segIdxs: number[], segments: Segment[], eps = 1.0): Point[][] {
  // Bucket endpoints on a coarse grid for O(1) lookup, but verify the exact
  // Euclidean distance ≤ eps before accepting a match (a bucket overlaps up
  // to sqrt(2)·cell on the diagonal, so bucket-alone would over-match).
  const cell = eps;
  const keyOf = (x: number, y: number): string =>
    `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
  interface EpEntry { segIdx: number; end: 0 | 1; x: number; y: number; }
  const buckets = new Map<string, EpEntry[]>();
  function addEndpoint(segIdx: number, end: 0 | 1, x: number, y: number) {
    const k = keyOf(x, y);
    let arr = buckets.get(k);
    if (!arr) { arr = []; buckets.set(k, arr); }
    arr.push({ segIdx, end, x, y });
  }
  for (const si of segIdxs) {
    const s = segments[si];
    addEndpoint(si, 0, s.p1.x, s.p1.y);
    addEndpoint(si, 1, s.p2.x, s.p2.y);
  }
  // Find unused segment sharing an endpoint at (x,y) — checks the 9 buckets
  // covering the eps-disk and filters by exact distance.
  function findAdjacent(x: number, y: number, used: Set<number>): EpEntry | null {
    const bx = Math.floor(x / cell), by = Math.floor(y / cell);
    let best: EpEntry | null = null, bestD = eps;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const arr = buckets.get(`${bx + dx},${by + dy}`);
        if (!arr) continue;
        for (const e of arr) {
          if (used.has(e.segIdx)) continue;
          const d = Math.hypot(e.x - x, e.y - y);
          if (d <= bestD) { bestD = d; best = e; }
        }
      }
    }
    return best;
  }
  // Extend a chain by walking from `fromPt` through unused adjacent segments.
  // Appends each new far-endpoint to `out`. Mutates `used` as it goes.
  function walkFrom(fromPt: Point, used: Set<number>, out: Point[]): void {
    let curX = fromPt.x, curY = fromPt.y;
    while (true) {
      const next = findAdjacent(curX, curY, used);
      if (!next) break;
      used.add(next.segIdx);
      const ns = segments[next.segIdx];
      const far = next.end === 0 ? ns.p2 : ns.p1;
      out.push(far);
      curX = far.x; curY = far.y;
    }
  }

  const used = new Set<number>();
  const chains: Point[][] = [];

  // Prioritise seeds whose endpoints include a degree-1 (leaf) vertex so open
  // walks run leaf-to-leaf rather than starting from the middle. Degree counts
  // all endpoints at a location (used + unused); endpoints at an interior of a
  // shared vertex have degree ≥ 2. Tied across the whole component, the rest
  // goes in insertion order.
  function degreeAtBuckets(x: number, y: number): number {
    const bx = Math.floor(x / cell), by = Math.floor(y / cell);
    let n = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const arr = buckets.get(`${bx + dx},${by + dy}`);
        if (!arr) continue;
        for (const e of arr) {
          if (Math.hypot(e.x - x, e.y - y) <= eps) n++;
        }
      }
    }
    return n;
  }
  const degreeOneFirst: number[] = [];
  const rest: number[] = [];
  for (const si of segIdxs) {
    const s = segments[si];
    if (degreeAtBuckets(s.p1.x, s.p1.y) === 1 || degreeAtBuckets(s.p2.x, s.p2.y) === 1) {
      degreeOneFirst.push(si);
    } else {
      rest.push(si);
    }
  }

  for (const startIdx of [...degreeOneFirst, ...rest]) {
    if (used.has(startIdx)) continue;
    used.add(startIdx);
    const s0 = segments[startIdx];
    // Grow from both endpoints. Without this, a start segment whose neighbor
    // on one side was already consumed emits as len-2 and the rest of the
    // adjacent arc sprays out as orphan 2-point chains.
    const forward: Point[] = [];
    const backward: Point[] = [];
    walkFrom(s0.p2, used, forward);
    walkFrom(s0.p1, used, backward);
    const chain: Point[] = [...backward.slice().reverse(), s0.p1, s0.p2, ...forward];
    chains.push(chain);
  }
  return chains;
}

/** Compute per-cluster bounding boxes for UI display of outline components. */
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

/** Pair outline components that share identical bbox dimensions and segment
 *  counts. For each 2-component group, computes a butterfly fold axis midway
 *  between the two bboxes along whichever axis (X or Y) they're separated on.
 *  Components with no pair become singleton groups without a fold.
 *  The heuristic is tuned for XZZ .pcb files that pack multiple physical
 *  boards into one file (iPhone AP+BB, MB+SUB). */
function groupComponentsByGeometry(
  components: Array<{ minX: number; minY: number; maxX: number; maxY: number; segCount: number }>,
): Array<{ components: number[]; fold?: { dim: 'x' | 'y'; axis: number; lowerIsBottom: boolean }; name?: string }> {
  if (components.length === 0) return [];

  // Bucket by (width, height, segCount) triple — string key for map lookup.
  const buckets = new Map<string, number[]>();
  components.forEach((c, i) => {
    const w = Math.round(c.maxX - c.minX);
    const h = Math.round(c.maxY - c.minY);
    const key = `${w}|${h}|${c.segCount}`;
    const arr = buckets.get(key) ?? [];
    arr.push(i);
    buckets.set(key, arr);
  });

  // Emit groups in ascending-first-component order so the UI ordering is stable.
  const seen = new Set<number>();
  const groups: Array<{ components: number[]; fold?: { dim: 'x' | 'y'; axis: number; lowerIsBottom: boolean }; name?: string }> = [];
  for (let i = 0; i < components.length; i++) {
    if (seen.has(i)) continue;
    const c = components[i];
    const w = Math.round(c.maxX - c.minX);
    const h = Math.round(c.maxY - c.minY);
    const key = `${w}|${h}|${c.segCount}`;
    const idxs = buckets.get(key)!;
    for (const k of idxs) seen.add(k);

    // When the bucket has exactly 2 components, compute a butterfly fold axis.
    let fold: { dim: 'x' | 'y'; axis: number; lowerIsBottom: boolean } | undefined;
    if (idxs.length === 2) {
      const [a, b] = idxs.map(k => components[k]);
      const xSep = !((a.minX <= b.maxX) && (b.minX <= a.maxX)); // no X-overlap
      const ySep = !((a.minY <= b.maxY) && (b.minY <= a.maxY));
      if (xSep && !ySep) {
        const [left, right] = a.maxX < b.minX ? [a, b] : [b, a];
        fold = { dim: 'x', axis: (left.maxX + right.minX) / 2, lowerIsBottom: false };
      } else if (ySep && !xSep) {
        const [lower, upper] = a.maxY < b.minY ? [a, b] : [b, a];
        fold = { dim: 'y', axis: (lower.maxY + upper.minY) / 2, lowerIsBottom: false };
      }
      // If the two components overlap on both axes (stacked directly), we
      // can't infer a fold axis — leave `fold` undefined.
    }
    groups.push({ components: idxs, fold });
  }
  return groups;
}

/** Chain segments per connected component; emit NaN pen-ups between components
 *  so the renderer draws each as its own closed sub-path. Without this, a
 *  single greedy chain jumps long distances between unrelated features (board
 *  halves, fiducial clusters), producing "spaghetti" lines across the board. */
function chainByComponent(segments: Segment[]): Point[] {
  if (segments.length === 0) return [];
  const groups = clusterSegments(segments);
  const out: Point[] = [];
  const NAN_BREAK: Point = { x: NaN, y: NaN };
  for (const idxs of groups) {
    const subChains = chainComponent(idxs, segments);
    for (const chain of subChains) {
      if (chain.length < 2) continue;
      if (out.length > 0) out.push(NAN_BREAK);
      out.push(...chain);
    }
  }
  return out;
}

function ru32(d: Uint8Array, o: number): number {
  return ((d[o] | (d[o+1] << 8) | (d[o+2] << 16) | (d[o+3] << 24)) >>> 0);
}

function ri32(d: Uint8Array, o: number): number { return ru32(d, o) | 0; }

function rstr(d: Uint8Array, o: number, n: number): string {
  return decoder.decode(d.subarray(o, o + n)).replace(/\0/g, '').trim();
}

function parseNetBlock(data: Uint8Array): Map<number, string> {
  const dict = new Map<number, string>();
  let ptr = 0;
  while (ptr + 8 <= data.length) {
    const netSize  = ru32(data, ptr); ptr += 4;
    const netIndex = ru32(data, ptr); ptr += 4;
    const nameLen  = netSize - 8;
    if (nameLen < 0 || ptr + nameLen > data.length) break;
    const name = rstr(data, ptr, nameLen);
    ptr += nameLen;
    if (name) dict.set(netIndex, name);
  }
  return dict;
}

interface PinData {
  name: string; x: number; y: number; netIndex: number;
  /** Pad width in mils, ÷10000 from the raw u32 at (28 + nameLen). 0 = unknown. */
  padW: number;
  /** Pad height in mils. */
  padH: number;
  /** Pad rotation in degrees CCW (raw u32 at offset 20 ÷ 10000). 0 for round pads. */
  padAngleDeg: number;
  /** Pad shape from the 1-byte code at (28 + nameLen + 8): 0x01 = round (BGA),
   *  0x02 = rect (SMD). Unknown codes fall through to 'rect'. */
  padShape: 'round' | 'rect';
}
interface PartSilkLine { x1: number; y1: number; x2: number; y2: number; }
interface PartData { name: string; side: 'top' | 'bottom'; pins: PinData[]; groupName: string; silkLines: PartSilkLine[]; }

function parsePinSubBlock(data: Uint8Array, ptr: number): { pin: PinData; next: number } {
  const EMPTY: PinData = { name: '', x: 0, y: 0, netIndex: 0, padW: 0, padH: 0, padAngleDeg: 0, padShape: 'rect' };
  const FAIL = { pin: EMPTY, next: data.length };
  if (ptr + 4 > data.length) return FAIL;
  const pinBlockSize = ru32(data, ptr);
  const pinBlockEnd  = ptr + pinBlockSize + 4;
  ptr += 4 + 4; // size + flag(1)
  if (ptr + 16 > data.length) return { ...FAIL, next: Math.min(pinBlockEnd, data.length) };
  const x = ri32(data, ptr) / XZZ_SCALE; ptr += 4;
  const y = ri32(data, ptr) / XZZ_SCALE; ptr += 4;
  ptr += 4; // u32 = 0 (constant)
  const padAngleDeg = ru32(data, ptr) / XZZ_SCALE; ptr += 4;
  if (ptr + 4 > data.length) return { pin: { ...EMPTY, x, y, padAngleDeg }, next: Math.min(pinBlockEnd, data.length) };
  const nameLen = ru32(data, ptr); ptr += 4;
  const name = (ptr + nameLen <= data.length) ? rstr(data, ptr, nameLen) : '';
  ptr += nameLen;
  // Pad geometry — three identical (u32 w, u32 h, u8 shape) chunks of 9 bytes
  // each (27 bytes total). Reading the first one is sufficient — every chunk
  // is a copy on every part surveyed in A2442. Probably top/inner/bottom
  // layer copies of the same SMD pad shape on a multi-layer board.
  let padW = 0, padH = 0, padShape: 'round' | 'rect' = 'rect';
  if (ptr + 9 <= data.length) {
    padW = ru32(data, ptr)     / XZZ_SCALE;
    padH = ru32(data, ptr + 4) / XZZ_SCALE;
    const shapeByte = data[ptr + 8];
    padShape = shapeByte === 0x01 ? 'round' : 'rect';
  }
  // Then 27 bytes of pad geom + 5 padding bytes, then the netIndex.
  const unk3Ptr = ptr;
  ptr += 32;
  const netIndex = (ptr + 4 <= data.length) ? ru32(data, ptr) : 0;
  if (DEBUG_PART_DUMPS_REMAINING > 0 && ptr + 32 <= data.length) {
    // Dump the 32 trailing bytes of the pin sub-block (27 pad geom + 5
    // padding). The padW/padH/shape are already decoded from the first 9;
    // the rest is unmapped. Looking for orientation hints (per-pin rotation,
    // side flag, etc.). DEBUG_PART_DUMPS_REMAINING is decremented in the
    // PART block, so each part's first pin gets a row.
    log.parser.log(
      `[xzz unknown-bytes probe] pin="${name}" ` +
      `padW=${padW} padH=${padH} shape=${padShape} ang=${padAngleDeg} ` +
      `trailing32=${hex(data, unk3Ptr, 32)}`,
    );
  }
  return { pin: { name, x, y, netIndex, padW, padH, padAngleDeg, padShape }, next: Math.min(pinBlockEnd, data.length) };
}

/** When > 0, dump the unknown-byte regions of the next N decoded parts to
 *  log.parser. Set by parseXZZ at the start of each invocation so the dump
 *  fires once per file open (and not for every single part on a 2000-part
 *  board). Used to RE the part header — looking for orientation / rotation
 *  / mirror hints that would let us cross-check the pin-direction detector.
 *  Toggle off by setting to 0; production builds should ship at 0. */
let DEBUG_PART_DUMPS_REMAINING = 0;

function hex(data: Uint8Array, off: number, len: number): string {
  const end = Math.min(off + len, data.length);
  const parts: string[] = [];
  for (let i = off; i < end; i++) {
    parts.push(data[i].toString(16).padStart(2, '0'));
  }
  return parts.join(' ');
}

function parsePartBlock(encBuf: Uint8Array): PartData | null {
  const data = desDecrypt(encBuf);
  let ptr = 0;
  if (ptr + 4 > data.length) return null;
  const partSize = ru32(data, ptr); ptr += 4;
  // unknown1 — 18 bytes between partSize and groupNameSize
  const unk1Ptr = ptr;
  ptr += 18;
  if (ptr + 4 > data.length) return null;
  const groupNameSize = ru32(data, ptr); ptr += 4;
  const groupName = (groupNameSize > 0 && ptr + groupNameSize <= data.length) ? rstr(data, ptr, groupNameSize) : '';
  ptr += groupNameSize;

  if (ptr >= data.length || data[ptr] !== 0x06) return null;
  // unknown2 — 30 bytes after the 0x06 marker byte
  ptr += 1; // 0x06 marker
  const unk2Ptr = ptr;
  ptr += 30;
  if (ptr + 4 > data.length) return null;
  const nameLen = ru32(data, ptr); ptr += 4;
  const partName = (ptr + nameLen <= data.length) ? rstr(data, ptr, nameLen) : '';
  ptr += nameLen;

  if (DEBUG_PART_DUMPS_REMAINING > 0) {
    DEBUG_PART_DUMPS_REMAINING--;
    log.parser.log(
      `[xzz unknown-bytes probe] part="${partName}" group="${groupName}" ` +
      `unk1[18]=${hex(data, unk1Ptr, 18)} | ` +
      `unk2[30]=${hex(data, unk2Ptr, 30)}`,
    );
  }

  const pins: PinData[] = [];
  const silkLines: PartSilkLine[] = [];
  const endPtr = partSize + 4;
  while (ptr < endPtr && ptr < data.length) {
    const subType = data[ptr]; ptr += 1;
    switch (subType) {
      case 0x05: {
        // Per-part line on a sub-layer. Layout matches the top-level 0x05
        // (Line) block: 7×u32 = layer, x1, y1, x2, y2, width, netIdx. Apple
        // files use this to draw the part body outline (4 segments forming a
        // rectangle) on layer 17 (silkscreen). Surveyed on A2442:
        //   sub-block counts per big part: 0x05=4 0x06=1 0x09=N
        //   layer always = 17, width = 1.0 mil.
        if (ptr + 4 > data.length) { ptr = endPtr; break; }
        const sz = ru32(data, ptr); ptr += 4;
        if (ptr + sz > data.length) { ptr = endPtr; break; }
        if (sz >= 20) {
          const layer = ru32(data, ptr);
          if (layer === SILKSCREEN_LAYER) {
            const x1 = ri32(data, ptr + 4)  / XZZ_SCALE;
            const y1 = ri32(data, ptr + 8)  / XZZ_SCALE;
            const x2 = ri32(data, ptr + 12) / XZZ_SCALE;
            const y2 = ri32(data, ptr + 16) / XZZ_SCALE;
            silkLines.push({ x1, y1, x2, y2 });
          }
        }
        ptr += sz;
        break;
      }
      case 0x01: case 0x06:
        if (ptr + 4 > data.length) { ptr = endPtr; break; }
        ptr += ru32(data, ptr) + 4;
        break;
      case 0x09: {
        const { pin, next } = parsePinSubBlock(data, ptr);
        pins.push(pin);
        ptr = next;
        break;
      }
      case 0x00: break;
      default:
        if (ptr + 4 <= data.length) {
          const skip = ru32(data, ptr);
          ptr = (skip > 0 && ptr + 4 + skip <= data.length) ? ptr + 4 + skip : endPtr;
        } else { ptr = endPtr; }
        break;
    }
  }
  if (!partName) return null;
  return { name: partName, side: 'top', pins, groupName, silkLines };
}

interface TestPadData { x: number; y: number; netIndex: number; }

function parseTestPadBlock(data: Uint8Array): TestPadData | null {
  if (data.length < 16) return null;
  let ptr = 4; // skip pad_number
  const x = ri32(data, ptr) / XZZ_SCALE; ptr += 4;
  const y = ri32(data, ptr) / XZZ_SCALE; ptr += 4;
  ptr += 8; // inner_diameter + unknown
  if (ptr + 4 > data.length) return null;
  const nameLen = ru32(data, ptr); ptr += 4 + nameLen;
  const netIndex = data.length >= 4 ? ru32(data, data.length - 4) : 0;
  return { x, y, netIndex };
}

interface ViaData { x: number; y: number; outer: number; netIndex: number; }

/**
 * XZZ via block (block-type 0x02). 32-byte fixed layout, 8×i32 LE:
 *   [0..4)   i32  x          (÷10000 = mils)
 *   [4..8)   i32  y
 *   [8..12)  u32  outer/pad annular-ring diameter (÷10000 = mils)
 *   [12..16) u32  drill diameter (÷10000 = mils)  — unused, the renderer
 *                                                   derives drill as a fixed
 *                                                   ratio of the pad ring.
 *   [16..20) u32  layer-from / flag (always 1 in surveyed Apple files)
 *   [20..24) u32  layer-to   / flag (always 5 in surveyed Apple files)
 *   [24..28) u32  net index  (matches netDict)
 *   [28..32) u32  padding
 *
 * Surveyed on A2442 820-02098-A (17,273 vias). Coordinate space matches the
 * part / segment blocks. The layer-pair fields stay flag-coded (1, 5) on every
 * via sampled — without a board exposing real blind/buried stack-ups we can't
 * confirm whether they're [from, to] or constant. Treat as through-hole and
 * leave `Via.layers` empty until counter-evidence appears.
 */
function parseViaBlock(data: Uint8Array): ViaData | null {
  if (data.length < 28) return null;
  const x         = ri32(data, 0)  / XZZ_SCALE;
  const y         = ri32(data, 4)  / XZZ_SCALE;
  const outer     = ru32(data, 8)  / XZZ_SCALE;
  // drill at offset 12, layer-from/to at 16/20 — unused for now
  const netIndex  = ru32(data, 24);
  return { x, y, outer, netIndex };
}

interface FoldResult {
  axis: number;
  dim: 'x' | 'y';
  lowerIsBottom: boolean;
  /** True when the outline has two disconnected components (no clipping needed). */
  disconnectedOutline: boolean;
  _debug: { source: string; sideSignal: string; compGap: number | null };
}

/** Multi-board pack: ≥4 outline components that all pair off by
 *  (width, height, segCount). Each pair is one physical board (unfolded into
 *  top + bottom halves placed side-by-side); the pairs themselves sit next to
 *  each other in the file (e.g. iPhone AP+BB combined boardview). Such files
 *  must NOT be globally folded — every per-board fold axis is emitted via
 *  `boardGroups` and applied lazily when the user picks a board. */
function isMultiBoardOutline(segments: Segment[]): boolean {
  if (segments.length < 8) return false;
  const bboxes = componentBBoxes(segments);
  if (bboxes.length < 4 || bboxes.length % 2 !== 0) return false;
  const buckets = new Map<string, number>();
  for (const bb of bboxes) {
    const w = Math.round(bb.maxX - bb.minX);
    const h = Math.round(bb.maxY - bb.minY);
    buckets.set(`${w}|${h}|${bb.segCount}`, (buckets.get(`${w}|${h}|${bb.segCount}`) ?? 0) + 1);
  }
  for (const cnt of buckets.values()) {
    if (cnt < 2 || cnt % 2 !== 0) return false;
  }
  return true;
}

/**
 * Detect fold axis from two disconnected outline groups (connected-component analysis).
 *
 * XZZ butterfly boards often have two separate board outlines placed side-by-side
 * with a small gap (sometimes as little as 20 mils). Gap-ratio heuristics miss
 * these because the gap is tiny relative to the board width. Instead, group
 * segments by endpoint proximity and check if exactly two groups exist.
 */
function detectOutlineComponentFold(segments: Segment[]): { axis: number; dim: 'x' | 'y'; gap: number } | null {
  if (segments.length < 4) return null;
  const n = segments.length;
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

  // Connect segments sharing an endpoint (within 1 mil tolerance)
  const eps = 1.0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const si = segments[i], sj = segments[j];
      if (Math.hypot(si.p1.x - sj.p1.x, si.p1.y - sj.p1.y) < eps ||
          Math.hypot(si.p1.x - sj.p2.x, si.p1.y - sj.p2.y) < eps ||
          Math.hypot(si.p2.x - sj.p1.x, si.p2.y - sj.p1.y) < eps ||
          Math.hypot(si.p2.x - sj.p2.x, si.p2.y - sj.p2.y) < eps) {
        union(i, j);
      }
    }
  }

  // Collect groups
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    let g = groups.get(r);
    if (!g) { g = []; groups.set(r, g); }
    g.push(i);
  }

  if (groups.size !== 2) return null;

  // Compute bounds of each group
  const groupList = [...groups.values()];
  const bounds = groupList.map(idxs => {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const i of idxs) {
      const s = segments[i];
      minX = Math.min(minX, s.p1.x, s.p2.x); maxX = Math.max(maxX, s.p1.x, s.p2.x);
      minY = Math.min(minY, s.p1.y, s.p2.y); maxY = Math.max(maxY, s.p1.y, s.p2.y);
    }
    return { minX, maxX, minY, maxY };
  });

  const [b0, b1] = bounds;
  const xSep = !((b0.minX <= b1.maxX) && (b1.minX <= b0.maxX)); // no X overlap
  const ySep = !((b0.minY <= b1.maxY) && (b1.minY <= b0.maxY)); // no Y overlap

  // Separated in X, overlapping in Y → X fold
  if (xSep && !ySep) {
    const [left, right] = b0.maxX < b1.minX ? [b0, b1] : [b1, b0];
    const axis = (left.maxX + right.minX) / 2;
    return { axis, dim: 'x', gap: right.minX - left.maxX };
  }

  // Separated in Y, overlapping in X → Y fold
  if (ySep && !xSep) {
    const [lower, upper] = b0.maxY < b1.minY ? [b0, b1] : [b1, b0];
    const axis = (lower.maxY + upper.minY) / 2;
    return { axis, dim: 'y', gap: upper.minY - lower.maxY };
  }

  return null;
}

/** Find the fold axis in XZZ butterfly layout.
 *
 *  Returns null when no butterfly signal is present. The .pcb format is used for
 *  at least three layout styles, and only the first is an unfolded butterfly:
 *  1. Unfolded butterfly — one PCB split into top/bottom halves placed side-by-side
 *     (MacBook M1/M2 boardviews). Detectable by two mirror-image outline components.
 *  2. Multi-board assembly — two distinct PCBs side-by-side (iPhone AP+BB,
 *     MB+SUB). The outline is noisy (many disconnected feature fragments), halves
 *     are not mirror images. Must NOT be folded.
 *  3. Flat single-sided board — one connected outline, no fold. Must NOT be folded.
 *
 *  Detection priority:
 *  1. Outline connectivity — exactly two disconnected outline groups with similar
 *     extents = definitive butterfly.
 *  2. Part centroid gap — two dense clusters separated by a clear void, validated
 *     by outline mirror-symmetry check.
 *  3. Otherwise return null (preserve native layout).
 *
 *  Side determination: lower coordinate = top side (XZZ uses screen coords, Y down).
 */
function findFoldAxis(segments: Segment[], parts: PartData[], testPads: TestPadData[]): FoldResult | null {
  // Multi-board pack (≥4 paired outline components): no global fold — the
  // per-board axes live in `boardGroups`. Without this gate the centroid
  // gap detector below sometimes finds a spurious mid-Y gap (created by the
  // empty CPU centerlines that all boards share), folding 4 distinct boards
  // into one collapsed slab. Seen on iPhone14 Pro/ProMax combined boardview.
  if (isMultiBoardOutline(segments)) return null;

  function bestGap(values: number[]): { axis: number; ratio: number } | null {
    if (values.length < 4) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const span = sorted[sorted.length - 1] - sorted[0];
    if (span === 0) return null;
    let maxGap = 0, foldPos = 0;
    for (let i = 1; i < sorted.length; i++) {
      const gap = sorted[i] - sorted[i - 1];
      if (gap > maxGap) { maxGap = gap; foldPos = (sorted[i] + sorted[i - 1]) / 2; }
    }
    return maxGap > span * 0.2 ? { axis: foldPos, ratio: maxGap / span } : null;
  }

  // ---- Priority 1: outline connectivity (two disconnected board halves) ----
  const compFold = detectOutlineComponentFold(segments);

  // Primary: part centroid clusters (unaffected by board notches/holes)
  let xFold: ReturnType<typeof bestGap> = null;
  let yFold: ReturnType<typeof bestGap> = null;
  const cxs: number[] = [], cys: number[] = [];
  for (const pd of parts) {
    if (pd.pins.length === 0) continue;
    cxs.push(Math.round(pd.pins.reduce((s, p) => s + p.x, 0) / pd.pins.length));
    cys.push(Math.round(pd.pins.reduce((s, p) => s + p.y, 0) / pd.pins.length));
  }
  if (cxs.length >= 8) {
    xFold = bestGap(cxs);
    yFold = bestGap(cys);
  }

  // Fallback: outline segment coordinates
  if (!xFold && !yFold) {
    const outlineXs = new Set<number>(), outlineYs = new Set<number>();
    for (const s of segments) {
      outlineXs.add(Math.round(s.p1.x)); outlineXs.add(Math.round(s.p2.x));
      outlineYs.add(Math.round(s.p1.y)); outlineYs.add(Math.round(s.p2.y));
    }
    xFold = bestGap([...outlineXs]);
    yFold = bestGap([...outlineYs]);
  }

  // Try to pick a validated gap-based fold axis.
  // Rank candidates by gap ratio (strongest gap wins) and try both before giving up.
  let detectedDim: 'x' | 'y' | null = null;
  let detectedAxis = 0;

  const candidates: Array<{ dim: 'x' | 'y'; axis: number; ratio: number }> = [];
  if (xFold) candidates.push({ dim: 'x', axis: xFold.axis, ratio: xFold.ratio });
  if (yFold) candidates.push({ dim: 'y', axis: yFold.axis, ratio: yFold.ratio });
  // Sort by gap ratio descending — strongest gap first
  candidates.sort((a, b) => b.ratio - a.ratio);

  for (const cand of candidates) {
    let passedChecks = true;

    // Reject if one half has <15% of parts (board notch/hole, not a real fold gap).
    // Use a lenient threshold — butterfly boards can have very uneven part counts
    // (e.g. most ICs on top, only test points on bottom).
    if (cxs.length >= 8) {
      const coordValues = cand.dim === 'x' ? cxs : cys;
      const below = coordValues.filter(v => v < cand.axis).length;
      const balance = Math.min(below, coordValues.length - below) / coordValues.length;
      if (balance < 0.15) {
        passedChecks = false;
      }
    }

    // Reject if outline halves have very different extents (not mirror images)
    if (passedChecks && segments.length >= 4) {
      let lowerMin = Infinity, lowerMax = -Infinity;
      let upperMin = Infinity, upperMax = -Infinity;
      for (const s of segments) {
        for (const pt of [s.p1, s.p2]) {
          const v = cand.dim === 'x' ? pt.x : pt.y;
          if (v < cand.axis) { lowerMin = Math.min(lowerMin, v); lowerMax = Math.max(lowerMax, v); }
          else               { upperMin = Math.min(upperMin, v); upperMax = Math.max(upperMax, v); }
        }
      }
      if (isFinite(lowerMin) && isFinite(upperMin)) {
        const lw = lowerMax - lowerMin, uw = upperMax - upperMin;
        const outlineBalance = lw > 0 && uw > 0 ? Math.min(lw, uw) / Math.max(lw, uw) : 0;
        if (outlineBalance < 0.4) {
          passedChecks = false;
        }
      }
    }

    if (passedChecks) {
      detectedDim = cand.dim;
      detectedAxis = cand.axis;
      break; // accept the first candidate that passes
    }
  }

  // Only fold when we have a strong signal. Falling back to a midpoint fold
  // fabricates butterfly on flat / multi-board files, mirroring real parts into
  // nonexistent "bottom" positions and clipping half the outline.
  let dim: 'x' | 'y';
  let axis: number;
  if (compFold) {
    dim = compFold.dim;
    axis = compFold.axis;
  } else if (detectedDim !== null) {
    dim = detectedDim;
    axis = detectedAxis;
  } else {
    return null;
  }

  // Determine which half is bottom (gets mirrored onto the top half).
  let lowerIsBottom = false;
  let sideSignal = 'default';

  if (parts.length >= 8) {
    // Primary signal: the part with the most pins is the CPU/SoC — always on the top side.
    // Find it and use its position to determine which half is top.
    let maxPins = 0, maxPinCentroid = 0;
    for (const pd of parts) {
      if (pd.pins.length > maxPins) {
        maxPins = pd.pins.length;
        maxPinCentroid = pd.pins.reduce((s, p) => s + (dim === 'x' ? p.x : p.y), 0) / pd.pins.length;
      }
    }
    if (maxPins >= 10) {
      const cpuInLower = maxPinCentroid < axis;
      lowerIsBottom = !cpuInLower; // CPU side = top
      sideSignal = `cpu(${maxPins}pins): ${cpuInLower ? 'lower' : 'upper'}=top`;
    }
  } else if (testPads.length >= 5) {
    // Fallback: test pad distribution hints at which half is bottom.
    // Default: lower coordinate = top (XZZ screen coords, Y increases downward).
    const lowerPads  = testPads.filter(tp => (dim === 'x' ? tp.x : tp.y) < axis).length;
    const higherPads = testPads.length - lowerPads;
    if (higherPads > lowerPads * 1.5) lowerIsBottom = false;
    else if (lowerPads > higherPads * 1.5) lowerIsBottom = true;
    sideSignal = `test-pads: lower=${lowerPads} upper=${higherPads}`;
  }

  const source = compFold ? 'outline-components' : detectedDim !== null ? 'gap' : 'default';
  return {
    axis, dim, lowerIsBottom,
    disconnectedOutline: compFold !== null,
    _debug: { source, sideSignal, compGap: compFold?.gap ?? null },
  };
}

/**
 * Mentor PADS Layout (PowerPCB) native binary `.pcb` files share the `.pcb`
 * extension with XZZ but are an entirely different — and unsupported — format:
 * the native PADS design database, not a boardview. Every observed sample
 * begins with this 10-byte signature (magic `00 FF 26 20` + six zero bytes);
 * the body carries PADS database markers (`DOC_PARTTYPES`, `DOC_PADS`,
 * `DOC_VIAS`, `STANDARDVIA`, …). Recognised so the loader can reject it with a
 * clear message instead of XOR-mangling it and dying on "invalid header offsets".
 */
export function isPadsBinaryHeader(header: Uint8Array): boolean {
  if (header.length < 10) return false;
  if (header[0] !== 0x00 || header[1] !== 0xFF || header[2] !== 0x26 || header[3] !== 0x20) return false;
  for (let i = 4; i < 10; i++) if (header[i] !== 0) return false;
  return true;
}

/** "v6v6555v6v6" — the XOR-boundary marker. The diode-value table (when
 *  present) begins right after it. */
const DIODE_MARKER = [0x76,0x36,0x76,0x36,0x35,0x35,0x35,0x76,0x36,0x76,0x36];

/** Classify one raw diode token: "OL" → open, "0"/"0.000" → none, numeric →
 *  value (millivolts). Tolerates a trailing dot ("312."). Returns null for an
 *  unparseable token (counted as unmatched by the caller). */
function classifyXzzDiode(tok: string): DiodeReading | null {
  if (tok === '') return null;
  if (/^OL$/i.test(tok)) return { raw: tok, kind: 'open', mv: null, source: 'xzz-pcb' };
  const n = Number(tok.replace(/\.$/, ''));     // tolerate trailing dot
  if (!Number.isFinite(n)) return null;
  if (n === 0) return { raw: tok, kind: 'none', mv: 0, source: 'xzz-pcb' };
  return { raw: tok, kind: 'value', mv: Math.round(n), source: 'xzz-pcb' };
}

/** Parse the post-`v6v6555v6v6===` diode-value table baked into XZZ
 *  "Middle layer diode value" .pcb companions. Records are newline-delimited
 *  `=<value>=<partName>(<pinNumber>)`. Returns a map keyed `PART(PIN)`; empty
 *  for normal boardviews (no marker). The section is plaintext — it lives past
 *  the XOR boundary marker, so it is never XOR'd or DES'd. */
export function parseDiodeSection(raw: Uint8Array): Map<string, DiodeReading> {
  const out = new Map<string, DiodeReading>();
  let pos = -1;
  outer: for (let i = 0; i + DIODE_MARKER.length <= raw.length; i++) {
    for (let j = 0; j < DIODE_MARKER.length; j++) if (raw[i + j] !== DIODE_MARKER[j]) continue outer;
    pos = i; break;
  }
  if (pos < 0) return out;
  // Decode the tail as latin1 (records are ASCII) and scan for records.
  let s = '';
  for (let i = pos; i < raw.length; i++) s += String.fromCharCode(raw[i]);
  const rx = /=([^=\n]*)=([A-Za-z0-9_]+)\((\d+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(s))) {
    const reading = classifyXzzDiode(m[1].trim());
    if (reading) out.set(`${m[2]}(${m[3]})`, reading);
  }
  return out;
}

export function parseXZZ(buffer: ArrayBuffer): BoardData {
  let raw = new Uint8Array(buffer);

  // Mentor PADS Layout binary .pcb files reach here via the shared `.pcb`
  // extension; reject them clearly before the XOR/offset logic mis-fires.
  if (isPadsBinaryHeader(raw)) {
    throw new Error(
      'This .pcb file is a Mentor PADS Layout (PowerPCB) binary design file, ' +
      "not a boardview — BoardRipper can't open the native PADS database. " +
      '(The .pcb extension is shared with the supported XZZ "XZZPCB" boardview ' +
      'format; this file is the unrelated PADS format.)',
    );
  }

  // XOR decode: if raw[0x10] != 0, XOR all bytes before the "v6v6555v6v6" marker
  if (raw.length > 0x10 && raw[0x10] !== 0) {
    const xorKey = raw[0x10];
    const markerBytes = [0x76,0x36,0x76,0x36,0x35,0x35,0x35,0x76,0x36,0x76,0x36];
    let markerPos = raw.length;
    outer: for (let i = 0; i <= raw.length - markerBytes.length; i++) {
      for (let j = 0; j < markerBytes.length; j++) {
        if (raw[i + j] !== markerBytes[j]) continue outer;
      }
      markerPos = i;
      break;
    }
    const decoded = new Uint8Array(raw);
    for (let i = 0; i < markerPos; i++) decoded[i] ^= xorKey;
    raw = decoded;
  }

  if (raw.length < 0x30) throw new Error('XZZ: file too short');

  const mainDataOffset = ru32(raw, 0x20);
  const netDataOffset  = ru32(raw, 0x28);
  const mainDataStart  = mainDataOffset + 0x20;
  const netDataStart   = netDataOffset  + 0x20;

  if (mainDataStart + 4 > raw.length || netDataStart + 4 > raw.length) {
    throw new Error('XZZ: invalid header offsets');
  }

  // Parse net dictionary
  const netBlockSize = ru32(raw, netDataStart);
  const netDict = parseNetBlock(raw.subarray(netDataStart + 4, netDataStart + 4 + netBlockSize));

  // Diagnostic probe: dump the first N parts' unknown-byte regions so we
  // can RE any orientation / rotation / mirror hints hiding there. Used
  // to investigate A2338 820-02773 mirror bug — turned out the bug was in
  // the store, not the format, so the probe found nothing actionable.
  // Left at 0 so production builds are silent; bump to 5 (or higher) when
  // investigating new orientation / fold / side-detection issues.
  DEBUG_PART_DUMPS_REMAINING = 0;

  // Process main data blocks
  const mainBlocksSize = ru32(raw, mainDataStart);
  const mainEnd  = mainDataStart + 4 + mainBlocksSize;
  let ptr = mainDataStart + 4;

  const segments: Segment[] = [];
  const partDataList: PartData[] = [];
  const testPads: TestPadData[] = [];
  const viasRaw: ViaData[] = [];
  // Raw trace segments collected by source layer id. We assign 0-based
  // Trace.layer indices after we've seen every layer the file uses.
  const rawTraces: Array<{ rawLayer: number; x1: number; y1: number; x2: number; y2: number; width: number; netIndex: number }> = [];
  // Silkscreen segments — XZZ rawLayer 17. Routed here instead of into
  // rawTraces so the renderer's Silkscreen overlay (same toggle Allegro uses)
  // gets them with neutral styling rather than per-net trace coloring.
  const silkSegments: Segment[] = [];

  while (ptr + 5 <= mainEnd && ptr + 5 <= raw.length) {
    const blockType = raw[ptr]; ptr += 1;
    const blockSize = ru32(raw, ptr); ptr += 4;
    if (ptr + blockSize > raw.length) break;
    const blockData = raw.subarray(ptr, ptr + blockSize);
    ptr += blockSize;

    switch (blockType) {
      case 0x02: { // Via (drill + annular ring + net)
        const v = parseViaBlock(blockData);
        if (v) viasRaw.push(v);
        break;
      }
      case 0x01: { // Arc — 8×u32: layer, cx, cy, r, angStart, angEnd, width, netIdx
        if (blockData.length < 24) break;
        const layer = ru32(blockData, 0);
        const cx = ri32(blockData, 4)  / XZZ_SCALE;
        const cy = ri32(blockData, 8)  / XZZ_SCALE;
        const r  = Math.abs(ri32(blockData, 12) / XZZ_SCALE);
        // Angles are stored as deg × XZZ_SCALE (same scale as coordinates),
        // NOT deg × 10. OBV reference: XZZPCBFile.cpp:258-260 divides by
        // XZZ_GLOBAL_SCALE (10000). The wrong divisor wrapped arcs through
        // Math.cos/sin to produce random geometry — the "star bursts" seen in
        // the rendered outline on iPhone files.
        let startDeg = ri32(blockData, 16) / XZZ_SCALE;
        let endDeg   = ri32(blockData, 20) / XZZ_SCALE;
        if (startDeg > endDeg) [startDeg, endDeg] = [endDeg, startDeg];
        if (endDeg - startDeg > 180) startDeg += 360;
        const sRad = startDeg * Math.PI / 180;
        const eRad = endDeg   * Math.PI / 180;
        // Trace width + net index live past the core arc fields (blocks are
        // 32 bytes = 8×u32 on multi-layer files). Read when present.
        const width    = blockData.length >= 28 ? ru32(blockData, 24) / XZZ_SCALE : 0;
        const netIndex = blockData.length >= 32 ? ru32(blockData, 28) : 0;
        const N = 9; // 9 sub-segments (10 points) — matches OBV numPoints
        if (layer === OUTLINE_LAYER) {
          for (let i = 0; i < N; i++) {
            const t0 = sRad + (eRad - sRad) * i / N;
            const t1 = sRad + (eRad - sRad) * (i + 1) / N;
            segments.push({
              p1: { x: cx + r * Math.cos(t0), y: cy + r * Math.sin(t0) },
              p2: { x: cx + r * Math.cos(t1), y: cy + r * Math.sin(t1) },
            });
          }
        } else if (layer === SILKSCREEN_LAYER) {
          // Silkscreen arc — linearize and route to the silkscreen overlay.
          let px = cx + r * Math.cos(sRad), py = cy + r * Math.sin(sRad);
          for (let i = 1; i <= N; i++) {
            const t = sRad + (eRad - sRad) * i / N;
            const nx = cx + r * Math.cos(t), ny = cy + r * Math.sin(t);
            silkSegments.push({ p1: { x: px, y: py }, p2: { x: nx, y: ny } });
            px = nx; py = ny;
          }
        } else if (layer >= 1 && layer <= 16) {
          // Trace arc on a copper / mask layer — linearize into trace segments
          // with the arc's width + net-index attached.
          let px = cx + r * Math.cos(sRad), py = cy + r * Math.sin(sRad);
          for (let i = 1; i <= N; i++) {
            const t = sRad + (eRad - sRad) * i / N;
            const nx = cx + r * Math.cos(t), ny = cy + r * Math.sin(t);
            rawTraces.push({ rawLayer: layer, x1: px, y1: py, x2: nx, y2: ny, width, netIndex });
            px = nx; py = ny;
          }
        }
        break;
      }
      case 0x05: { // Line segment — 7×u32: layer, x1, y1, x2, y2, width, netIdx
        if (blockData.length < 20) break;
        const layer = ru32(blockData, 0);
        const x1 = ri32(blockData, 4)  / XZZ_SCALE;
        const y1 = ri32(blockData, 8)  / XZZ_SCALE;
        const x2 = ri32(blockData, 12) / XZZ_SCALE;
        const y2 = ri32(blockData, 16) / XZZ_SCALE;
        if (layer === OUTLINE_LAYER) {
          segments.push({ p1: { x: x1, y: y1 }, p2: { x: x2, y: y2 } });
        } else if (layer === SILKSCREEN_LAYER) {
          silkSegments.push({ p1: { x: x1, y: y1 }, p2: { x: x2, y: y2 } });
        } else if (layer >= 1 && layer <= 16) {
          const width    = blockData.length >= 24 ? ru32(blockData, 20) / XZZ_SCALE : 0;
          const netIndex = blockData.length >= 28 ? ru32(blockData, 24) : 0;
          rawTraces.push({ rawLayer: layer, x1, y1, x2, y2, width, netIndex });
        }
        break;
      }
      case 0x07: { // Part (DES-encrypted)
        const pd = parsePartBlock(blockData);
        if (pd) partDataList.push(pd);
        break;
      }
      case 0x09: { // Test pad
        const tp = parseTestPadBlock(blockData);
        if (tp) testPads.push(tp);
        break;
      }
    }
  }

  // Snapshot pre-fold geometry for the "Show all sides" view before the
  // butterfly branch mutates `segments` and `partDataList` in place.
  const rawSegmentsSnapshot: Segment[] = segments.map(s => ({
    p1: { x: s.p1.x, y: s.p1.y },
    p2: { x: s.p2.x, y: s.p2.y },
  }));
  const foldComponents = componentBBoxes(rawSegmentsSnapshot);

  // Detect board fold: XZZ stores top and bottom side-by-side (unfolded).
  const fold = findFoldAxis(segments, partDataList, testPads);
  if (fold) {
    for (const pd of partDataList) {
      if (pd.pins.length === 0) continue;
      const c = fold.dim === 'x'
        ? pd.pins.reduce((s, p) => s + p.x, 0) / pd.pins.length
        : pd.pins.reduce((s, p) => s + p.y, 0) / pd.pins.length;
      const isBottom = fold.lowerIsBottom ? c < fold.axis : c > fold.axis;
      if (isBottom) {
        pd.side = 'bottom';
        if (fold.dim === 'x') {
          for (const p of pd.pins) p.x = 2 * fold.axis - p.x;
          for (const s of pd.silkLines) { s.x1 = 2 * fold.axis - s.x1; s.x2 = 2 * fold.axis - s.x2; }
        } else {
          for (const p of pd.pins) p.y = 2 * fold.axis - p.y;
          for (const s of pd.silkLines) { s.y1 = 2 * fold.axis - s.y1; s.y2 = 2 * fold.axis - s.y2; }
        }
      }
    }
    // Mirror traces that sit in the "bottom" half. A segment is classified by
    // its midpoint. Without this, butterfly files (narrow iPhone sub-boards
    // like iPhone16E BB) render traces in the pre-fold layout while parts are
    // in the post-fold layout — they no longer line up.
    for (const t of rawTraces) {
      const mid = fold.dim === 'x' ? (t.x1 + t.x2) / 2 : (t.y1 + t.y2) / 2;
      const isBottom = fold.lowerIsBottom ? mid < fold.axis : mid > fold.axis;
      if (!isBottom) continue;
      if (fold.dim === 'x') {
        t.x1 = 2 * fold.axis - t.x1;
        t.x2 = 2 * fold.axis - t.x2;
      } else {
        t.y1 = 2 * fold.axis - t.y1;
        t.y2 = 2 * fold.axis - t.y2;
      }
    }
    // Vias use a single point — classify by it directly.
    for (const v of viasRaw) {
      const c = fold.dim === 'x' ? v.x : v.y;
      const isBottom = fold.lowerIsBottom ? c < fold.axis : c > fold.axis;
      if (!isBottom) continue;
      if (fold.dim === 'x') v.x = 2 * fold.axis - v.x;
      else                  v.y = 2 * fold.axis - v.y;
    }
    // Silkscreen segments — classify by midpoint, same as traces.
    for (const s of silkSegments) {
      const mid = fold.dim === 'x' ? (s.p1.x + s.p2.x) / 2 : (s.p1.y + s.p2.y) / 2;
      const isBottom = fold.lowerIsBottom ? mid < fold.axis : mid > fold.axis;
      if (!isBottom) continue;
      if (fold.dim === 'x') {
        s.p1.x = 2 * fold.axis - s.p1.x; s.p2.x = 2 * fold.axis - s.p2.x;
      } else {
        s.p1.y = 2 * fold.axis - s.p1.y; s.p2.y = 2 * fold.axis - s.p2.y;
      }
    }
    // Keep only the "top" half of the outline (discard the bottom half).
    const segsBefore = segments.length;
    let removed = 0, clipped = 0;

    if (fold.disconnectedOutline) {
      // Two-component outline: discard the component whose centroid is on the bottom side.
      // No clipping needed — each component is entirely on one side of the fold axis.
      // Also deduplicate segments — XZZ files often list each outline edge twice.
      for (let i = segments.length - 1; i >= 0; i--) {
        const s = segments[i];
        const mid = fold.dim === 'x'
          ? (s.p1.x + s.p2.x) / 2
          : (s.p1.y + s.p2.y) / 2;
        const isBottom = fold.lowerIsBottom ? mid < fold.axis : mid > fold.axis;
        if (isBottom) { segments.splice(i, 1); removed++; }
      }
      // Deduplicate: remove segments with both endpoints matching an earlier one
      const eps = 1.0;
      for (let i = segments.length - 1; i > 0; i--) {
        const a = segments[i];
        for (let j = 0; j < i; j++) {
          const b = segments[j];
          const match =
            (Math.hypot(a.p1.x - b.p1.x, a.p1.y - b.p1.y) < eps &&
             Math.hypot(a.p2.x - b.p2.x, a.p2.y - b.p2.y) < eps) ||
            (Math.hypot(a.p1.x - b.p2.x, a.p1.y - b.p2.y) < eps &&
             Math.hypot(a.p2.x - b.p1.x, a.p2.y - b.p1.y) < eps);
          if (match) { segments.splice(i, 1); removed++; break; }
        }
      }
    } else {
      // Single connected outline: cut along the geometric midpoint.
      const outlineVals = segments.flatMap(s => fold.dim === 'x'
        ? [s.p1.x, s.p2.x] : [s.p1.y, s.p2.y]);
      const outlineMid = outlineVals.length > 0
        ? (Math.min(...outlineVals) + Math.max(...outlineVals)) / 2
        : fold.axis;
      const inBottom = (v: number) => fold.lowerIsBottom ? v < outlineMid : v > outlineMid;
      for (let i = segments.length - 1; i >= 0; i--) {
        const s = segments[i];
        const v1 = fold.dim === 'x' ? s.p1.x : s.p1.y;
        const v2 = fold.dim === 'x' ? s.p2.x : s.p2.y;
        if (inBottom(v1) && inBottom(v2)) {
          segments.splice(i, 1); removed++;
        } else if (inBottom(v1) !== inBottom(v2)) {
          const t = (outlineMid - v1) / (v2 - v1);
          const cx = s.p1.x + t * (s.p2.x - s.p1.x);
          const cy = s.p1.y + t * (s.p2.y - s.p1.y);
          if (inBottom(v1)) { s.p1.x = cx; s.p1.y = cy; }
          else               { s.p2.x = cx; s.p2.y = cy; }
          clipped++;
        }
      }
      // Seal the cut with a closing segment along the fold axis.
      if (clipped > 0) {
        const eps = 0.5;
        const cutPts: Point[] = [];
        for (const s of segments) {
          const v1 = fold.dim === 'x' ? s.p1.x : s.p1.y;
          const v2 = fold.dim === 'x' ? s.p2.x : s.p2.y;
          if (Math.abs(v1 - outlineMid) < eps) cutPts.push({ ...s.p1 });
          if (Math.abs(v2 - outlineMid) < eps) cutPts.push({ ...s.p2 });
        }
        const uniqueCuts: Point[] = [];
        for (const cp of cutPts) {
          if (!uniqueCuts.some(u => Math.hypot(cp.x - u.x, cp.y - u.y) < eps)) {
            uniqueCuts.push(cp);
          }
        }
        if (uniqueCuts.length >= 2) {
          let bestDist = -1, bestA = uniqueCuts[0], bestB = uniqueCuts[1];
          for (let _i = 0; _i < uniqueCuts.length - 1; _i++) {
            for (let _j = _i + 1; _j < uniqueCuts.length; _j++) {
              const dd = Math.hypot(uniqueCuts[_i].x - uniqueCuts[_j].x, uniqueCuts[_i].y - uniqueCuts[_j].y);
              if (dd > bestDist) { bestDist = dd; bestA = uniqueCuts[_i]; bestB = uniqueCuts[_j]; }
            }
          }
          segments.push({ p1: bestA, p2: bestB });
        }
      }
    }
    // ---- Structured butterfly summary ----
    const topParts  = partDataList.filter(p => p.side === 'top').length;
    const botParts  = partDataList.filter(p => p.side === 'bottom').length;
    const d = fold._debug;
    log.parser.log(
      `(pcb butterfly) ` +
      `detect=${d.source}` +
      (d.compGap !== null ? ` gap=${d.compGap.toFixed(0)}` : '') +
      ` | fold: dim=${fold.dim} axis=${fold.axis.toFixed(0)}` +
      ` | side: lowerIsBottom=${fold.lowerIsBottom} (${d.sideSignal})` +
      ` | mirror: ${fold.dim === 'x' ? 'X' : 'Y'}-flip on ${fold.lowerIsBottom ? 'lower' : 'upper'} half` +
      ` | parts: top=${topParts} bottom=${botParts}` +
      ` | outline: ${segsBefore}→${segments.length} segs (removed=${removed} clipped=${clipped})`,
    );
  } else {
    const multiBoard = isMultiBoardOutline(segments);
    log.parser.log(
      `(pcb ${multiBoard ? 'multi-board' : 'flat'}) ${multiBoard ? 'paired outline components — per-board folds via boardGroups' : 'no butterfly signal — preserving native layout'} ` +
      `| parts=${partDataList.length} outline=${segments.length} segs`,
    );
  }

  // Whole-board mirror correction. XZZ files are often stored mirrored vs IPC
  // convention (pin 1 on top, pin numbering CCW from above). The butterfly
  // fold above handles the bottom-side reflection; this pass corrects the
  // file-wide mirror that survives it.
  //
  // Detector measures CHIRALITY (CW vs CCW) — axis-agnostic. The renderer
  // auto-rotates tall boards 270° (`computeAutoRotation` in board-store.ts:180)
  // so they display landscape, which swaps the screen axes. A storage X-flip
  // would then appear as a screen Y-flip ("vertically mirrored"), not what
  // the user reports as "mirrored horizontally". So:
  //   - tall in storage  (h > w, auto-rotated) → flip Y in storage → flips X on screen
  //   - wide in storage  (h ≤ w, no rotation)  → flip X in storage → flips X on screen
  // Either way fixes chirality; the choice picks the axis that becomes screen-X.
  //
  // `minSamples` is dropped to 4 because the post-fold XZZ corpus skews to
  // small-pin passives and large BGAs — the detector's perimeter-walk filter
  // discards both, leaving only a handful of clean QFN/SOIC packages to vote
  // with (820-02098-A has 4). The existing `ratioThreshold` (0.7) stays as the
  // false-positive guard, so we still need >70% of the qualifying parts to
  // walk CW before flipping.
  if (partDataList.length > 0) {
    const probeParts: Part[] = partDataList.map(pd => ({
      name: pd.name, side: pd.side, type: 'smd',
      origin: { x: 0, y: 0 },
      bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
      pins: pd.pins.map((p, i) => ({
        name: '', number: String(i + 1),
        position: { x: p.x, y: p.y },
        radius: 0, side: pd.side, net: '',
      })),
    }));
    const v = detectXMirrorByPinDirection(probeParts, { minSamples: 4 });
    log.parser.log(
      `[xzz mirror-detect] verdict=${v.mirrored ? 'MIRRORED → will flip X' : 'not mirrored → leave as-is'} | ` +
      `topCCW=${v.topCCW} topCW=${v.topCW} ratio=${isNaN(v.wrongRatio) ? 'NaN' : v.wrongRatio.toFixed(2)} ` +
      `(threshold 0.70) | bottomCCW=${v.bottomCCW} bottomCW=${v.bottomCW} | ` +
      `analyzed=${v.totalAnalyzed} (minSamples=4)`,
    );
    if (v.mirrored) {
      // Match the renderer's auto-rotate axis-swap so the user sees a
      // horizontal screen flip, not a vertical one.
      let bbMinX = Infinity, bbMaxX = -Infinity, bbMinY = Infinity, bbMaxY = -Infinity;
      for (const s of segments) {
        if (s.p1.x < bbMinX) bbMinX = s.p1.x; if (s.p1.x > bbMaxX) bbMaxX = s.p1.x;
        if (s.p2.x < bbMinX) bbMinX = s.p2.x; if (s.p2.x > bbMaxX) bbMaxX = s.p2.x;
        if (s.p1.y < bbMinY) bbMinY = s.p1.y; if (s.p1.y > bbMaxY) bbMaxY = s.p1.y;
        if (s.p2.y < bbMinY) bbMinY = s.p2.y; if (s.p2.y > bbMaxY) bbMaxY = s.p2.y;
      }
      if (!isFinite(bbMinX)) {
        for (const pd of partDataList) for (const p of pd.pins) {
          if (p.x < bbMinX) bbMinX = p.x; if (p.x > bbMaxX) bbMaxX = p.x;
          if (p.y < bbMinY) bbMinY = p.y; if (p.y > bbMaxY) bbMaxY = p.y;
        }
      }
      const tall = isFinite(bbMinX) && (bbMaxY - bbMinY) > (bbMaxX - bbMinX);
      const axis: 'x' | 'y' = tall ? 'y' : 'x';

      if (axis === 'x') {
        for (const pd of partDataList) {
          for (const p of pd.pins) p.x = -p.x;
          for (const s of pd.silkLines) { s.x1 = -s.x1; s.x2 = -s.x2; }
        }
        for (const tp of testPads) tp.x = -tp.x;
        for (const vd of viasRaw) vd.x = -vd.x;
        for (const s of segments) { s.p1.x = -s.p1.x; s.p2.x = -s.p2.x; }
        for (const s of silkSegments) { s.p1.x = -s.p1.x; s.p2.x = -s.p2.x; }
        for (const t of rawTraces) { t.x1 = -t.x1; t.x2 = -t.x2; }
        for (const s of rawSegmentsSnapshot) { s.p1.x = -s.p1.x; s.p2.x = -s.p2.x; }
        for (const fc of foldComponents) {
          const oldMin = fc.minX; fc.minX = -fc.maxX; fc.maxX = -oldMin;
        }
        if (fold && fold.dim === 'x') fold.axis = -fold.axis;
      } else {
        for (const pd of partDataList) {
          for (const p of pd.pins) p.y = -p.y;
          for (const s of pd.silkLines) { s.y1 = -s.y1; s.y2 = -s.y2; }
        }
        for (const tp of testPads) tp.y = -tp.y;
        for (const vd of viasRaw) vd.y = -vd.y;
        for (const s of segments) { s.p1.y = -s.p1.y; s.p2.y = -s.p2.y; }
        for (const s of silkSegments) { s.p1.y = -s.p1.y; s.p2.y = -s.p2.y; }
        for (const t of rawTraces) { t.y1 = -t.y1; t.y2 = -t.y2; }
        for (const s of rawSegmentsSnapshot) { s.p1.y = -s.p1.y; s.p2.y = -s.p2.y; }
        for (const fc of foldComponents) {
          const oldMin = fc.minY; fc.minY = -fc.maxY; fc.maxY = -oldMin;
        }
        if (fold && fold.dim === 'y') fold.axis = -fold.axis;
      }
      log.parser.log(
        `(pcb mirror) corrected file-wide mirror — axis=${axis.toUpperCase()} ` +
        `(${tall ? 'tall→Y-flip becomes screen-X' : 'wide→X-flip stays screen-X'}) ` +
        `analyzed=${v.totalAnalyzed} cw=${v.topCW} ccw=${v.topCCW} ratio=${v.wrongRatio.toFixed(2)}`,
      );
    }
  }

  // Normalize coordinates to origin
  let minX = Infinity, minY = Infinity;
  for (const s of segments) {
    if (s.p1.x < minX) minX = s.p1.x; if (s.p1.y < minY) minY = s.p1.y;
    if (s.p2.x < minX) minX = s.p2.x; if (s.p2.y < minY) minY = s.p2.y;
  }
  if (!isFinite(minX)) {
    for (const pd of partDataList) for (const p of pd.pins) {
      if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y;
    }
  }
  if (!isFinite(minX)) { minX = 0; minY = 0; }

  for (const s of segments) { s.p1.x -= minX; s.p1.y -= minY; s.p2.x -= minX; s.p2.y -= minY; }
  for (const pd of partDataList) {
    for (const p of pd.pins) { p.x -= minX; p.y -= minY; }
    for (const s of pd.silkLines) { s.x1 -= minX; s.y1 -= minY; s.x2 -= minX; s.y2 -= minY; }
  }
  for (const tp of testPads) { tp.x -= minX; tp.y -= minY; }
  for (const vd of viasRaw)  { vd.x -= minX; vd.y -= minY; }
  for (const s of silkSegments) { s.p1.x -= minX; s.p1.y -= minY; s.p2.x -= minX; s.p2.y -= minY; }
  for (const t of rawTraces) { t.x1 -= minX; t.y1 -= minY; t.x2 -= minX; t.y2 -= minY; }
  for (const s of rawSegmentsSnapshot) {
    s.p1.x -= minX; s.p1.y -= minY;
    s.p2.x -= minX; s.p2.y -= minY;
  }
  for (const fc of foldComponents) {
    fc.minX -= minX; fc.maxX -= minX;
    fc.minY -= minY; fc.maxY -= minY;
  }
  const rawOutline = chainByComponent(rawSegmentsSnapshot);
  const boardGroups = groupComponentsByGeometry(foldComponents);
  // XZZ `.pcb` files we've surveyed don't carry a board/sheet label in any
  // block we parse — the per-part `groupName` we extract (e.g. "C-01-55",
  // "IC-01-01") is a part-type designator, not a board name. If a future file
  // surfaces a real board name somewhere, populate `group.name` here; the UI
  // already falls back to "Board N" when name is undefined.

  // Build outline: cluster connected segments and chain each cluster as its
  // own sub-path with NaN pen-ups between them. This prevents greedy
  // nearest-neighbor chaining from drawing long-distance "spaghetti" between
  // disconnected board halves (MacBook unfolded butterfly) or between
  // independent boards in a multi-board file (iPhone AP+BB sandwich).
  const outline = chainByComponent(segments);

  // Build parts and per-pin pads. Pad geometry comes from the pin sub-block
  // (parsePinSubBlock decoded it). Pin.radius now scales to the actual pad —
  // half the smaller of (padW, padH), with an 0.5 mil floor so a missing-data
  // pin still renders as a dot. This is the fix for "BGA pins look way too
  // big": the old hard-coded radius=8 mil drew a 16 mil dot over what is
  // actually a 9 mil round pad.
  const parts: Part[] = [];
  const pads: Pad[] = [];
  for (const pd of partDataList) {
    if (!pd.name) continue;
    const pins: Pin[] = pd.pins.map((p, i) => {
      const raw2 = netDict.get(p.netIndex) ?? '';
      const net = (raw2 === 'NC' || raw2 === 'UNCONNECTED') ? '' : raw2;
      const r = (p.padW > 0 && p.padH > 0) ? Math.max(0.5, Math.min(p.padW, p.padH) / 2) : 8;
      // Forward the real pad geometry to the pin so the renderer can draw
      // the actual rect/round shape (rotated AABB for selection halo + pin
      // sprite) instead of a generic circle. Mirrors the Pad emission below;
      // also stops the pin-circle peeking out from under the copper overlay
      // when "Show pads" is on (the doubling fix).
      const hasGeom = p.padW > 0 && p.padH > 0;
      const halfW = p.padW / 2, halfH = p.padH / 2;
      const a = (p.padAngleDeg % 360) * Math.PI / 180;
      const cAng = Math.abs(Math.cos(a)), sAng = Math.abs(Math.sin(a));
      const aabbHalfW = halfW * cAng + halfH * sAng;
      const aabbHalfH = halfW * sAng + halfH * cAng;
      const padBounds = hasGeom ? {
        minX: p.x - aabbHalfW, maxX: p.x + aabbHalfW,
        minY: p.y - aabbHalfH, maxY: p.y + aabbHalfH,
      } : undefined;
      return {
        // Preserve the real pad number parsed from the pin sub-block — the
        // diode-value table (post-v6 section) keys readings by PART(pinNumber),
        // so dropping it (the old `String(i+1)`) broke the join. Fall back to
        // the 1-based index when the file carries no name.
        name: '', number: p.name || String(i + 1),
        position: { x: p.x, y: p.y }, radius: r, side: pd.side, net,
        ...(padBounds ? { padBounds } : {}),
        ...(hasGeom ? {
          padShape: p.padShape,
          padWidth: p.padW,
          padHeight: p.padH,
          ...(p.padAngleDeg !== 0 ? { padAngleDeg: p.padAngleDeg } : {}),
        } : {}),
      };
    });
    const pos  = pins.map(p => p.position);
    const bounds = computeBBox(pos.length > 0 ? pos : [{ x: 0, y: 0 }]);
    // Resolve a single part rotation from per-pad angles. Pads are centro-
    // symmetric, so angles 180° apart render identically — normalise via
    // mod 90 (90° ≡ 0° too, since that just swaps the long/short axis on
    // an axis-aligned chip). If a clear majority share the same non-axis-
    // aligned bucket, the part is rotated by that angle and the renderer
    // will draw an oriented bounding box for it.
    let angleDeg: number | undefined;
    let _dbgBuckets = '';
    let _dbgBestKey = 0, _dbgBestCount = 0, _dbgTotal = 0;
    if (pd.pins.length >= 2) {
      const buckets = new Map<number, number>();
      for (const p of pd.pins) {
        if (p.padW <= 0 || p.padH <= 0) continue;
        const m = ((Math.round(p.padAngleDeg) % 90) + 90) % 90;
        const key = m === 90 ? 0 : m;
        buckets.set(key, (buckets.get(key) ?? 0) + 1);
        _dbgTotal++;
      }
      let bestKey = 0, bestCount = 0;
      for (const [k, v] of buckets) if (v > bestCount) { bestCount = v; bestKey = k; }
      _dbgBestKey = bestKey;
      _dbgBestCount = bestCount;
      _dbgBuckets = [...buckets.entries()].sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k}°×${v}`).join(' ');
      if (bestKey > 0 && bestKey < 90 && _dbgTotal > 0 && bestCount >= _dbgTotal * 0.7) {
        angleDeg = bestKey;
      }
    }
    // Axis-aligned chip guard: pad angles are a noisy signal — UN/UF/UR
    // chips on 820-02016 have axis-aligned bodies but their pads happen to
    // be drawn at a 45° angle. Blindly trusting the pad-angle majority
    // produced diagonal selection outlines around chips the silkscreen
    // shows are straight. Mirror the perimeter test from
    // computeDiagonalOBB: if a substantial fraction of pin POSITIONS sit
    // on the AABB perimeter AND both a horizontal and vertical edge are
    // populated, the chip's body axis is the AABB regardless of what the
    // pad angles say. Skip the angleDeg assignment in that case.
    const angleDegBeforeGuard = angleDeg;
    let guardPassed = false;
    let onL = 0, onR = 0, onT = 0, onB = 0, onAny = 0;
    if (angleDeg !== undefined && pd.pins.length >= 3) {
      let aMinX = Infinity, aMaxX = -Infinity, aMinY = Infinity, aMaxY = -Infinity;
      for (const p of pd.pins) {
        if (p.x < aMinX) aMinX = p.x;
        if (p.x > aMaxX) aMaxX = p.x;
        if (p.y < aMinY) aMinY = p.y;
        if (p.y > aMaxY) aMaxY = p.y;
      }
      const span = Math.max(aMaxX - aMinX, aMaxY - aMinY);
      const eps = Math.min(2, span * 0.01);
      for (const p of pd.pins) {
        const isL = Math.abs(p.x - aMinX) <= eps;
        const isR = Math.abs(p.x - aMaxX) <= eps;
        const isB = Math.abs(p.y - aMinY) <= eps;
        const isT = Math.abs(p.y - aMaxY) <= eps;
        if (isL) onL++;
        if (isR) onR++;
        if (isB) onB++;
        if (isT) onT++;
        if (isL || isR || isB || isT) onAny++;
      }
      const hasH = onT >= 2 || onB >= 2;
      const hasV = onL >= 2 || onR >= 2;
      // hasH && hasV is the load-bearing check: at least two pins on a
      // horizontal AABB edge AND at least two pins on a vertical AABB edge
      // means the chip's body IS the AABB — that's geometrically how an
      // axis-aligned rectangular chip looks. The original `onAny ≥ 40%`
      // gate (copied from computeDiagonalOBB's PCA guard) misfired on
      // big BGAs like UN000 (110 pins, only 28 on perimeter, 25%) because
      // most pins are INSIDE the grid, not on the edges. A truly
      // 45°-rotated chip touches the AABB only at its 4 vertex pins, one
      // per side — which gives onL=onR=onT=onB=1, so hasH=hasV=false and
      // the guard correctly stays off. Empirically verified on the
      // UF400/UF500 (79°-pad BGAs) + UR600 + UF700/750 set from 820-02016.
      if (hasH && hasV) {
        angleDeg = undefined;
        guardPassed = true;
      }
    }
    // Diagnostic: surface the angle-detector decision for parts whose name
    // matches a small grep so we can iterate without flooding the log. The
    // user reported UN/UF/UR parts on 820-02016 still get diagonal outlines
    // after the perimeter guard — log enough state to identify the cause.
    if (angleDegBeforeGuard !== undefined && /^U\d/i.test(pd.name)) {
      log.parser.log(
        `[xzz angleDeg probe] part="${pd.name}" pins=${pd.pins.length} ` +
        `padBuckets={${_dbgBuckets}} bestKey=${_dbgBestKey} ` +
        `(${_dbgBestCount}/${_dbgTotal}=${(_dbgBestCount / Math.max(1, _dbgTotal) * 100).toFixed(0)}%) ` +
        `→ angleDegBeforeGuard=${angleDegBeforeGuard} | ` +
        `perimeter onL=${onL} onR=${onR} onT=${onT} onB=${onB} onAny=${onAny}/${pd.pins.length} ` +
        `guardPassed=${guardPassed} → final angleDeg=${angleDeg}`,
      );
    }
    parts.push({ name: pd.name, side: pd.side, type: 'smd', origin: { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 }, pins, bounds, ...(angleDeg !== undefined ? { angleDeg } : {}) });

    // Emit a Pad per pin with valid geometry.
    for (let i = 0; i < pd.pins.length; i++) {
      const p = pd.pins[i];
      if (p.padW <= 0 || p.padH <= 0) continue;
      const raw2 = netDict.get(p.netIndex) ?? '';
      const net = (raw2 === 'NC' || raw2 === 'UNCONNECTED') ? '' : raw2;
      // Bounds = AABB of the rotated rectangle centred at (p.x, p.y).
      const halfW = p.padW / 2, halfH = p.padH / 2;
      const a = (p.padAngleDeg % 360) * Math.PI / 180;
      const c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a));
      const aabbHalfW = halfW * c + halfH * s;
      const aabbHalfH = halfW * s + halfH * c;
      pads.push({
        bounds: {
          minX: p.x - aabbHalfW, maxX: p.x + aabbHalfW,
          minY: p.y - aabbHalfH, maxY: p.y + aabbHalfH,
        },
        side: pd.side,
        net,
        shape: p.padShape,
        width: p.padW,
        height: p.padH,
        angleDeg: p.padAngleDeg,
        attached: true,
      });
    }
  }

  // Build nails from test pads
  const nails: Nail[] = testPads.map(tp => {
    const raw2 = netDict.get(tp.netIndex) ?? '';
    return { position: { x: tp.x, y: tp.y }, side: 'top' as const, net: (raw2 === 'NC' || raw2 === 'UNCONNECTED') ? '' : raw2 };
  });

  // Build vias from 0x02 blocks. `layers: []` = through-hole — the 0x02
  // layer-pair fields are flag-coded (1, 5) on every surveyed Apple file with
  // no observed variance, so we can't reliably decode blind/buried stack-ups
  // yet. The renderer's via-overlay matches connected layers to nearby trace
  // endpoints regardless of `layers`, so empty here is safe.
  const vias = viasRaw.map(v => {
    const raw2 = netDict.get(v.netIndex) ?? '';
    return {
      position: { x: v.x, y: v.y },
      diameter: v.outer,
      net: (raw2 === 'NC' || raw2 === 'UNCONNECTED') ? '' : raw2,
      layers: [] as number[],
    };
  });

  // Build silkscreen paths. Two sources:
  //   1. Top-level layer-17 segments (board-wide silkscreen, no side info).
  //   2. Per-part silkscreen lines (the rectangle outline drawn around each
  //      component on the silkscreen layer — 4× 0x05 sub-blocks per part on
  //      surveyed Apple files). These carry the part's side, so a butterfly
  //      file's bottom-side parts get their outlines on the bottom overlay.
  //
  // Top-level segments get chainByComponent'd (fewer GPU draw calls for the
  // sparse legacy art). Per-part outlines render as 4 small segments each —
  // running them through the global chainer would be O(n²) for ~24k segments
  // (576M comparisons on A2442), so they're emitted directly. Each part's
  // four lines arrive as four 2-point SilkscreenPaths tagged with the part's
  // side; the renderer's per-side toggles drive visibility.
  const silkscreen: SilkscreenPath[] = [];
  if (silkSegments.length > 0) {
    const chained = chainByComponent(silkSegments);
    let cur: Point[] = [];
    for (const p of chained) {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
        if (cur.length >= 2) silkscreen.push({ points: cur, side: 'top' });
        cur = [];
      } else {
        cur.push({ x: p.x, y: p.y });
      }
    }
    if (cur.length >= 2) silkscreen.push({ points: cur, side: 'top' });
  }
  let partSilkPathCount = 0;
  for (const pd of partDataList) {
    if (pd.silkLines.length === 0) continue;
    for (const s of pd.silkLines) {
      silkscreen.push({
        points: [{ x: s.x1, y: s.y1 }, { x: s.x2, y: s.y2 }],
        side: pd.side,
      });
      partSilkPathCount++;
    }
  }

  // Build multi-layer trace data. XZZ layer IDs observed in the wild: 1–7
  // are copper signal layers, 16 is solder mask, 17 is silkscreen, 28 is the
  // board outline (handled as polygon above). The raw ID → 0-based index
  // mapping is driven by the set of layers actually present in *this* file.
  const LAYER_NAME_HINT: Record<number, string> = {
    1: 'L1 Top Copper', 2: 'L2 Inner', 3: 'L3 Inner', 4: 'L4 Inner',
    5: 'L5 Inner', 6: 'L6 Inner', 7: 'L7 Bottom Copper',
    8: 'L8', 9: 'L9', 10: 'L10', 11: 'L11', 12: 'L12', 13: 'L13',
    14: 'L14', 15: 'L15',
    16: 'Solder Mask', 17: 'Silkscreen',
  };
  const usedLayers = [...new Set(rawTraces.map(t => t.rawLayer))].sort((a, b) => a - b);
  const layerIndex = new Map<number, number>();
  const layerNames: string[] = [];
  for (const rawId of usedLayers) {
    layerIndex.set(rawId, layerNames.length);
    layerNames.push(LAYER_NAME_HINT[rawId] ?? `Layer ${rawId}`);
  }
  const traces: Trace[] = rawTraces.map(t => {
    const raw2 = netDict.get(t.netIndex) ?? '';
    const net = (raw2 === 'NC' || raw2 === 'UNCONNECTED') ? '' : raw2;
    return {
      start: { x: t.x1, y: t.y1 },
      end:   { x: t.x2, y: t.y2 },
      width: t.width > 0 ? t.width : 3,
      net,
      layer: layerIndex.get(t.rawLayer)!,
    };
  });

  if (parts.length === 0 && outline.length === 0) {
    throw new Error('XZZ file parsed but contains no parts or outline — file may be corrupt or empty');
  }

  const allPts: Point[] = [...outline, ...parts.flatMap(p => p.pins.map(pi => pi.position))];
  const bounds = computeBBox(allPts.length > 0 ? allPts : [{ x: 0, y: 0 }]);

  if (traces.length > 0) {
    log.parser.log(`(pcb traces) ${traces.length} segments across ${layerNames.length} layer(s): ${layerNames.join(', ')}`);
  }
  if (vias.length > 0) {
    log.parser.log(`(pcb vias) ${vias.length} vias`);
  }
  if (pads.length > 0) {
    const round = pads.filter(p => p.shape === 'round').length;
    const rect  = pads.filter(p => p.shape === 'rect').length;
    log.parser.log(`(pcb pads) ${pads.length} pads (${round} round, ${rect} rect)`);
  }
  if (silkscreen.length > 0) {
    log.parser.log(`(pcb silkscreen) ${silkscreen.length} paths (${silkSegments.length} top-level segs + ${partSilkPathCount} per-part)`);
  }

  const foldInfo = fold ? {
    dim: fold.dim,
    // Adjust axis from pre-normalised coords to post-normalised so it lines up
    // with rawOutline / part positions (which are all shifted by minX/minY).
    axis: fold.dim === 'x' ? fold.axis - minX : fold.axis - minY,
    lowerIsBottom: fold.lowerIsBottom,
    source: fold._debug.source,
    summary:
      `${fold._debug.source === 'outline-components' ? 'Two disconnected outline groups paired as butterfly' : 'Gap-detected butterfly fold'}` +
      ` — ${fold.dim.toUpperCase()}-fold axis @ ${(fold.dim === 'x' ? fold.axis - minX : fold.axis - minY).toFixed(0)} mils` +
      ` (${fold.lowerIsBottom ? 'lower' : 'upper'} half mirrored onto top)`,
  } : undefined;

  // Diode-value channel — join the post-v6 reading table onto pins by
  // PART(pinNumber). Absent on normal boardviews (no marker → empty map).
  const diodeMap = parseDiodeSection(raw);
  let diodeReference: DiodeReferenceChannel | undefined;
  if (diodeMap.size > 0) {
    const counts = { value: 0, open: 0, none: 0 };
    for (const r of diodeMap.values()) counts[r.kind]++;
    const matchedKeys = new Set<string>();
    for (const part of parts) {
      for (const pin of part.pins) {
        const r = diodeMap.get(`${part.name}(${pin.number})`);
        if (r) { pin.diode = r; matchedKeys.add(`${part.name}(${pin.number})`); }
      }
    }
    const matched = matchedKeys.size;
    diodeReference = { source: 'xzz-pcb', units: 'mV', counts, matched, unmatched: diodeMap.size - matched };
    log.parser.log(
      `[xzz diode] ${diodeMap.size} records → matched ${matched} pins, ` +
      `${diodeMap.size - matched} unmatched (value=${counts.value} open=${counts.open} none=${counts.none})`,
    );
  }

  return {
    format: 'XZZ', outline, parts, nails, nets: buildNets(parts), bounds,
    butterflyFoldAxis: fold?.dim,
    diodeReference,
    traces: traces.length > 0 ? traces : undefined,
    vias: vias.length > 0 ? vias : undefined,
    silkscreen: silkscreen.length > 0 ? silkscreen : undefined,
    pads: pads.length > 0 ? pads : undefined,
    layerNames: layerNames.length > 0 ? layerNames : undefined,
    rawOutline,
    foldComponents,
    foldInfo,
    boardGroups,
  };
}
