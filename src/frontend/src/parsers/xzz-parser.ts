import type { BoardData, Part, Pin, Nail, Point, Trace, SilkscreenPath, Pad, DiodeReading, DiodeReferenceChannel } from './types';
import { computeBBox, buildNets } from './types';
import { detectXMirrorByPinDirection } from './mirror-detect';
import { classifyComponents, pairMajors, decideSide, unionBBox, makeRegionLookup, type OutlineComponent, type ComponentPair, type CopperVotes } from './xzz-boards';
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

export interface Segment { p1: Point; p2: Point; }

/** Group outline segments into connected components via endpoint-proximity union-find.
 *  Two segments share a component if any endpoint-pair is within `eps` mils.
 *  Exported for the parity test in xzz-cluster.test.ts. */
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

/** Drop segments that are the SAME edge listed twice, in place. Returns how
 *  many went.
 *
 *  "Same edge" means the endpoints coincide — not that they land near each
 *  other. The distinction is the whole bug this replaced: the previous version
 *  compared endpoints with a fixed 1-mil epsilon, which cannot express
 *  duplication at all once a segment is shorter than the epsilon. Both
 *  endpoints of a 0.8-mil segment sit within 1 mil of both endpoints of its
 *  own neighbour, so each was deleted as a "duplicate" of the segment it was
 *  joined to.
 *
 *  Arc-sampled corners produce exactly those segments: `parseXZZ` linearises
 *  every outline arc into 9 pieces, so a 90° corner of r = 14.6 mil steps
 *  0.8 mil at a time. The guard therefore ate the rounded corners — and only
 *  the rounded corners — on 8 of the 32 corpus boards, cutting each outline
 *  loop open at every fillet. Downstream that is invisible as a missing line
 *  and very visible as a filled shape: `chainByComponent` emits the leftovers
 *  as open sub-paths (up to 18 on A2485-820-02100-A, gaps to 5,934 mil on a
 *  4,924-mil-wide board) and the renderer closes each one with a straight
 *  line, laying black wedges across the board.
 *
 *  XZZ coordinates are integers ÷ 10000 and identical arcs sample to identical
 *  floats, so a real duplicate is exactly equal. Quantising to 0.01 mil
 *  (0.25 µm) absorbs any float noise while staying two orders of magnitude
 *  below the shortest real segment, which makes "duplicate" and "neighbour"
 *  distinguishable by construction rather than by a tuned threshold. Keyed
 *  both ways round so a reversed copy of an edge still counts.
 *
 *  Worth knowing: across all 32 corpus files this has never once fired. The
 *  premise it was written for — "XZZ files often list each outline edge
 *  twice" — is unsupported by any sample here, and the reference parser
 *  (OpenBoardView's XZZPCBFile.cpp) does not deduplicate at all. It is kept,
 *  correctly implemented and logged, because a duplicated edge would give the
 *  chain walker a degree-4 vertex to guess at. */
export function dedupeCoincidentSegments(segments: Segment[]): number {
  const Q = 100; // 1/0.01 mil
  const k = (p: Point) => `${Math.round(p.x * Q)},${Math.round(p.y * Q)}`;
  const seen = new Set<string>();
  let write = 0;
  for (let read = 0; read < segments.length; read++) {
    const s = segments[read];
    const a = k(s.p1), b = k(s.p2);
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (seen.has(key)) continue;
    seen.add(key);
    segments[write++] = s;
  }
  const dropped = segments.length - write;
  segments.length = write;
  return dropped;
}

/** Compute per-cluster bounding boxes for UI display of outline components. */
function componentBBoxes(segments: Segment[]): OutlineComponent[] {
  const tCluster = performance.now();
  const groups = clusterSegments(segments);
  log.perf.log(`XZZ clusterSegments (bboxes): ${(performance.now() - tCluster).toFixed(0)}ms for ${segments.length} segments → ${groups.length} groups`);
  return groups.map(idxs => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const i of idxs) {
      const s = segments[i];
      if (s.p1.x < minX) minX = s.p1.x; if (s.p1.y < minY) minY = s.p1.y;
      if (s.p2.x < minX) minX = s.p2.x; if (s.p2.y < minY) minY = s.p2.y;
      if (s.p1.x > maxX) maxX = s.p1.x; if (s.p1.y > maxY) maxY = s.p1.y;
      if (s.p2.x > maxX) maxX = s.p2.x; if (s.p2.y > maxY) maxY = s.p2.y;
    }
    return { minX, minY, maxX, maxY, segCount: idxs.length, segIdxs: idxs };
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
  const tCluster = performance.now();
  const groups = clusterSegments(segments);
  log.perf.log(`XZZ clusterSegments (chain): ${(performance.now() - tCluster).toFixed(0)}ms for ${segments.length} segments → ${groups.length} groups`);
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
  /** Drill diameter in mils (raw u32 at offset 16 ÷ 10000), 0 for SMD pins.
   *  See parsePinSubBlock for the evidence that this slot is a drill. */
  drill: number;
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
/** Structural subset of PinData used by normalizeOblongPads (exported for tests). */
export interface OblongPinLike {
  x: number; y: number;
  padW: number; padH: number;
  padAngleDeg: number;
  padShape: 'round' | 'rect';
}

/** Oblong-pad plausibility guard.
 *
 *  Shape 0x01 with w ≠ h is a round-capped stroke (stadium): the pen width is
 *  whichever of w/h is SHORTER, the stroke length whichever is longer, rotated
 *  by padAngleDeg. There is no fixed axis — either field can be the pen.
 *  This guard used to assume `w` was always the pen and write off anything
 *  with h ≤ w as a degenerate stroke, which held only because every oblong
 *  entry in the corpus it was tuned against (PL5TU1B / EC1 / CPU1) happens to
 *  have w < h. It flattened real capsules elsewhere: 88 pads of 37×10 on
 *  A2485-820-02100-A became Ø37 dots, 3.5× too fat in the direction that
 *  matters for reading a connector footprint, and HAC-CPU-20's 71×20 USB-C
 *  mounting legs likewise. The axis assumption, and that the pen is
 *  min(w, h) rather than a fixed field, were identified by Sean Johnson
 *  (@sjohnson1021) in issue #32.
 *
 *  Lengths run 1–350 mil against a typical 15-mil pen. Real for chip pads
 *  (15×20…40) and QFP leads (15×60, matches the vendor's assembly drawing) —
 *  but bogus on BGA perimeter rings, where 15×300/350 "pads" would cross a
 *  dozen neighbouring balls the vendor's own drawing shows as plain 15-mil
 *  dots (probably escape-stub metadata, not pad copper).
 *
 *  Copper pads of different pins can never overlap, so the guard is
 *  physical: a pin's oblong footprint (w×h box at the pad angle) must not
 *  intersect any same-part neighbour's pen circle (penetration > 1 mil;
 *  duplicate records within 2 mil of the same spot don't count). Two
 *  orientations are tried — the declared angle, then +90° — because the
 *  exporter stamps ONE angle on every pin of a part while a QFP's top/bottom
 *  leads are physically perpendicular to its left/right leads; an oblong
 *  only collapses to a pen-width round dot when neither orientation is
 *  physically possible. Sub-manufacturable pens collapse unconditionally:
 *  once the pen is defined as min(w, h) the old "length shorter than pen"
 *  branch is impossible by construction, but it was doing a second job the
 *  axis fix would have silently dropped — PL5TU1B writes 139 entries of 15×1
 *  and 42 more at 15×2/15×3, and 1-mil copper is not manufacturable. Those
 *  are the same escape-stub metadata, and nothing else catches them (a
 *  hairline overlaps no neighbour, so the physical test passes it). Hence
 *  MIN_PEN_MILS. A final majority pass drags stragglers along: the
 *  exporter writes one length for a whole ring/side, so when most pins of
 *  an identical (w, h) group prove implausible, the survivors (stubs that
 *  happen to thread a gap in a staggered ball grid — CPU1 pin W1) are the
 *  same bogus population and collapse too. Must run BEFORE the butterfly
 *  fold: the geometry assumes positions and angles from the same
 *  (un-mirrored) frame.
 *
 *  Mutates `pins` in place; returns how many pads were collapsed. */
/** Narrowest pen that can be real copper. Below this the short dimension is
 *  read as noise rather than as a hairline stroke — a 1-mil-wide pad is not
 *  manufacturable, and PL5TU1B writes 181 of them. */
const MIN_PEN_MILS = 4;

export function normalizeOblongPads(pins: OblongPinLike[], stats?: { subPen: number }): number {
  let collapsed = 0;
  // True when p's w×h box rotated by angDeg overlaps no neighbour's pen circle.
  const plausibleAt = (p: OblongPinLike, angDeg: number): boolean => {
    const halfW = p.padW / 2, halfH = p.padH / 2;
    const rad = angDeg * Math.PI / 180;
    const c = Math.cos(rad), s = Math.sin(rad);
    for (const q of pins) {
      if (q === p) continue;
      const dx = q.x - p.x, dy = q.y - p.y;
      if (dx * dx + dy * dy <= 4) continue;         // duplicate record at (nearly) the same spot
      // World delta → pad-local frame (rotate by −ang), then point-to-box distance.
      const lx = dx * c + dy * s;
      const ly = -dx * s + dy * c;
      const ex = Math.max(0, Math.abs(lx) - halfW);
      const ey = Math.max(0, Math.abs(ly) - halfH);
      const rq = (q.padW > 0 && q.padH > 0) ? Math.min(q.padW, q.padH) / 2 : 4;
      if (ex * ex + ey * ey < Math.max(0, rq - 1) ** 2) return false;
    }
    return true;
  };
  // Per-(w,h) group stats for the majority pass. Survivors keep a reference
  // under their ORIGINAL size key (mutation changes p.padH).
  const groupTotal = new Map<string, number>();
  const groupCollapsed = new Map<string, number>();
  const groupSurvivors = new Map<string, OblongPinLike[]>();
  // Collapse to a round dot of diameter `d`, dropping the (now meaningless)
  // stroke angle. Axis-symmetric: both dims are written, so it no longer
  // matters which one carried the pen.
  const collapseTo = (p: OblongPinLike, d: number): void => {
    p.padW = d;
    p.padH = d;
    p.padAngleDeg = 0;
    collapsed++;
  };
  for (const p of pins) {
    if (p.padShape !== 'round' || p.padW <= 0 || p.padH <= 0 || p.padW === p.padH) continue;
    const pen = Math.min(p.padW, p.padH);
    const len = Math.max(p.padW, p.padH);
    if (pen < MIN_PEN_MILS) {
      // Not a credible pen — the short dimension is noise, not copper, so the
      // record is read as "a dot roughly `len` across" rather than as a
      // hairline. Keeps PL5TU1B's 15×1 escape stubs rendering as the Ø15 dots
      // they have always been instead of turning them invisible.
      collapseTo(p, len);
      if (stats) stats.subPen++;
      continue;
    }
    const key = `${pen}x${len}`;
    groupTotal.set(key, (groupTotal.get(key) ?? 0) + 1);
    if (plausibleAt(p, p.padAngleDeg) ||
        (plausibleAt(p, p.padAngleDeg + 90) &&       // perpendicular sibling-side lead
         ((p.padAngleDeg = (p.padAngleDeg + 90) % 360), true))) {
      let list = groupSurvivors.get(key);
      if (!list) { list = []; groupSurvivors.set(key, list); }
      list.push(p);
      continue;
    }
    collapseTo(p, pen);
    groupCollapsed.set(key, (groupCollapsed.get(key) ?? 0) + 1);
  }
  // Majority pass: a size-group that is mostly implausible is exporter
  // metadata, not copper — collapse its gap-threading survivors too.
  for (const [key, bad] of groupCollapsed) {
    if (bad * 2 <= (groupTotal.get(key) ?? 0)) continue;
    for (const p of groupSurvivors.get(key) ?? []) {
      collapseTo(p, Math.min(p.padW, p.padH));
    }
  }
  return collapsed;
}

interface PartSilkLine { x1: number; y1: number; x2: number; y2: number; }
interface PartData {
  name: string; side: 'top' | 'bottom'; pins: PinData[]; groupName: string; silkLines: PartSilkLine[];
  /** Index into the boards the pack was split into; -1 / undefined when the
   *  part lies outside every board region. Set by the board-pack pass. */
  boardIndex?: number;
  /** BOM value ("22uF", "100K") when the exporter wrote one into a body
   *  label sub-block. See readLabelSubBlock / parsePartBlock. */
  value?: string;
}

/** Longest string still plausible as a BOM value. Anything longer is a sign
 *  the 26-byte header guess missed and we are reading neighbouring bytes. */
const MAX_PART_VALUE_LEN = 48;

/** Placeholder-channel guard (see the "(pcb values)" pass in parseXZZ): a
 *  label that is alphabetic-then-numeric ("Device1", "Part207"). Real values
 *  lead with the magnitude — "22uF", "10K", "0R" — so they don't match. */
const SERIAL_LABEL_RE = /^[A-Za-z][A-Za-z ._-]*\d+$/;
const PLACEHOLDER_MIN_SAMPLES = 20;
const PLACEHOLDER_UNIQUE_RATIO = 0.95;
const PLACEHOLDER_SERIAL_RATIO = 0.8;

/** Read a 0x06 label sub-block from a part body, `ptr` positioned just past
 *  the marker byte. Same framing as the part header's own 0x06 label
 *  ([30 unknown][len:u32][text]) minus 4 bytes, because a body sub-block
 *  spends them on its own size prefix:
 *
 *    [0x06] [size:u32] [26 unknown] [len:u32] [text…]
 *
 *  Returns `label: ''` for a block whose payload doesn't hold a readable
 *  string — the block is still skipped correctly via its size prefix.
 *
 *  The block, and the 26-byte offset to its length prefix, were documented
 *  from hex dumps by Sean Johnson (@sjohnson1021) in issue #27. */
function readLabelSubBlock(data: Uint8Array, ptr: number): { label: string; next: number } {
  if (ptr + 4 > data.length) return { label: '', next: data.length };
  const size = ru32(data, ptr); ptr += 4;
  const end = ptr + size;
  if (end > data.length) return { label: '', next: data.length };
  let label = '';
  const lenPtr = ptr + 26;
  if (lenPtr + 4 <= end) {
    const len = ru32(data, lenPtr);
    if (len > 0 && len <= MAX_PART_VALUE_LEN && lenPtr + 4 + len <= end) {
      label = rstr(data, lenPtr + 4, len);
    }
  }
  return { label, next: end };
}

/** A value is only accepted when it is printable text — a mis-framed read
 *  lands on binary, and half a struct rendered as mojibake in the Info pane
 *  is worse than no value at all. */
function isPlausiblePartValue(s: string): boolean {
  if (s.length === 0 || s.length > MAX_PART_VALUE_LEN) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    // Control range, C1 range, or U+FFFD — the decoder's marker for bytes that
    // were never text to begin with.
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0xfffd) return false;
  }
  return true;
}

function parsePinSubBlock(data: Uint8Array, ptr: number): { pin: PinData; next: number } {
  const EMPTY: PinData = { name: '', x: 0, y: 0, netIndex: 0, drill: 0, padW: 0, padH: 0, padAngleDeg: 0, padShape: 'rect' };
  const FAIL = { pin: EMPTY, next: data.length };
  if (ptr + 4 > data.length) return FAIL;
  const pinBlockSize = ru32(data, ptr);
  const pinBlockEnd  = ptr + pinBlockSize + 4;
  ptr += 4 + 4; // size + flag(1)
  if (ptr + 16 > data.length) return { ...FAIL, next: Math.min(pinBlockEnd, data.length) };
  const x = ri32(data, ptr) / XZZ_SCALE; ptr += 4;
  const y = ri32(data, ptr) / XZZ_SCALE; ptr += 4;
  // Drill diameter, same ÷10000 = mils scale as everything else; 0 on an SMD
  // pin. Long documented as "u32 = 0 (constant)" because the boards surveyed
  // first happen to be SMD-only. Across 32 .pcb files / 415,520 pins here,
  // 253 pins carry a non-zero value and the annular-ring relation
  // (drill < min(padW, padH)) holds on every single one — a flag field would
  // have no reason to respect it. Values land in the 6.5–60 mil range, always
  // on connector legs, headers and mounting pins, and never on a top-level
  // 0x09 test pad (which is correct — probe points are surface features).
  // Reverse-engineered by Sean Johnson (@sjohnson1021) and reported with
  // Switch / PS5 / MSI evidence in issue #32; the annular-ring argument and
  // the drill-vs-flag reasoning above are his.
  const drill = ru32(data, ptr) / XZZ_SCALE; ptr += 4;
  const padAngleDeg = ru32(data, ptr) / XZZ_SCALE; ptr += 4;
  if (ptr + 4 > data.length) return { pin: { ...EMPTY, x, y, drill, padAngleDeg }, next: Math.min(pinBlockEnd, data.length) };
  const nameLen = ru32(data, ptr); ptr += 4;
  const name = (ptr + nameLen <= data.length) ? rstr(data, ptr, nameLen) : '';
  ptr += nameLen;
  // Pad geometry — three identical (u32 w, u32 h, u8 shape) chunks of 9 bytes
  // each (27 bytes total). Reading the first one is sufficient — every chunk
  // is a copy on every part surveyed in A2442. Probably top/inner/bottom
  // layer copies of the same SMD pad shape on a multi-layer board.
  //
  // Known latent risk, spotted by Sean Johnson (@sjohnson1021) in issue #32:
  // this is really a *terminated record list* —
  // (w, h, type) records read until a type byte of 0x00, then a 5-byte
  // terminator — and the fixed "read one, skip 32" only works because every
  // pin carries exactly 3 records. That is true of 415,520 pins across all 32
  // local files and of the reporter's Switch / PS5 / MSI corpus, so there is
  // no counter-example to fix against; a file with 1, 2 or 4+ records would
  // silently misalign the netIndex read below rather than fail loudly.
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
  return { pin: { name, x, y, netIndex, drill, padW, padH, padAngleDeg, padShape }, next: Math.min(pinBlockEnd, data.length) };
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
  let value: string | undefined;
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
      case 0x01:
        if (ptr + 4 > data.length) { ptr = endPtr; break; }
        ptr += ru32(data, ptr) + 4;
        break;
      case 0x06: {
        // Body label. Apple exports write exactly one and it repeats the
        // refdes; MSI (and other Cadence/PADS re-exports) write a second one
        // carrying the BOM value — "22uF" under C757. The first label that
        // isn't the refdes is that value; a board with only the refdes copy
        // yields nothing, which is the pre-existing behaviour.
        const { label, next } = readLabelSubBlock(data, ptr);
        if (value === undefined && label !== partName && isPlausiblePartValue(label)) value = label;
        ptr = next;
        break;
      }
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
  return { name: partName, side: 'top', pins, groupName, silkLines, value };
}

interface TestPadData { x: number; y: number; netIndex: number; side?: 'top' | 'bottom'; }

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

interface ViaData { x: number; y: number; outer: number; netIndex: number; mirrored?: boolean; }

/**
 * XZZ via block (block-type 0x02). 32-byte fixed layout, 8×i32 LE:
 *   [0..4)   i32  x          (÷10000 = mils)
 *   [4..8)   i32  y
 *   [8..12)  u32  outer/pad annular-ring diameter (÷10000 = mils)
 *   [12..16) u32  drill diameter (÷10000 = mils)  — unused, the renderer
 *                                                   derives drill as a fixed
 *                                                   ratio of the pad ring.
 *   [16..20) u32  layer-from   (real layer index, not a flag — see below)
 *   [20..24) u32  layer-to     (ditto; always > layer-from)
 *   [24..28) u32  net index  (matches netDict)
 *   [28..32) u32  padding
 *
 * Coordinate space matches the part / segment blocks.
 *
 * The layer pair is a genuine layer span. An earlier survey of this same
 * fixture — A2442 820-02098-A, 17,273 vias — recorded it as flag-coded
 * (always 1, 5) and this comment told the next reader that no board exposed
 * real blind/buried stack-ups. Both halves were wrong, and the counter-
 * evidence was in the file the claim was written from: that board carries 19
 * distinct pairs, of which (1, 5) is only 2,412. Across five via-carrying
 * files here (A2442-A, A2485-A, S7-SM-G930FD, iPhone16E AP + BB): 18–41
 * distinct pairs each, and `from < to` on every one of 45,000+ vias — never
 * once inverted. Every value used also appears in that board's own segment
 * layer set. Reported with the same finding on HAC-CPU-20 (2,559 vias, 25
 * pairs) by Sean Johnson (@sjohnson1021) in issue #32.
 *
 * Still unused by choice, not for lack of evidence: `Via.layers` stays empty
 * and every via renders through-hole, because acting on the span means
 * deciding how a blind via should draw when its layers are hidden — a
 * rendering question, not a parsing one. The drill at [12..16) is populated
 * too (2.5–3 mil across this corpus) and equally unused.
 */
function parseViaBlock(data: Uint8Array): ViaData | null {
  if (data.length < 28) return null;
  const x         = ri32(data, 0)  / XZZ_SCALE;
  const y         = ri32(data, 4)  / XZZ_SCALE;
  const outer     = ru32(data, 8)  / XZZ_SCALE;
  // drill at offset 12, layer span at 16/20 — parsed and documented above,
  // deliberately not surfaced (see the block comment).
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
function findFoldAxis(segments: Segment[], parts: PartData[], testPads: TestPadData[], majorCount = 0): FoldResult | null {
  // Three or more board-sized outline loops that did not pair off is still a
  // pack, not a butterfly: the centroid-gap search below would fold across
  // two physical boards (XR.pcb, iPhoneSE boardview before the pack pass).
  if (majorCount >= 3) return null;
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

/** Classify one raw diode token: "OL" → open, numeric (including "0") →
 *  value (millivolts). Tolerates a trailing dot ("312."). Returns null for an
 *  unparseable token (counted as unmatched by the caller). A literal "0" is a
 *  real measurement (short to ground) — XZZ's own viewer draws it on the pin,
 *  and on connector diode maps it can be the majority of records (776/1144 on
 *  820-03097), so it must not be classified 'none'/suppressed. */
function classifyXzzDiode(tok: string): DiodeReading | null {
  if (tok === '') return null;
  if (/^OL$/i.test(tok)) return { raw: tok, kind: 'open', mv: null, source: 'xzz-pcb' };
  const n = Number(tok.replace(/\.$/, ''));     // tolerate trailing dot
  if (!Number.isFinite(n)) return null;
  return { raw: tok, kind: 'value', mv: Math.round(n), source: 'xzz-pcb' };
}

/** Locate the `v6v6555v6v6` XOR-boundary marker, or -1. The annotation
 *  section (diode table / rename table) begins right after it. */
function findDiodeMarker(raw: Uint8Array): number {
  outer: for (let i = 0; i + DIODE_MARKER.length <= raw.length; i++) {
    for (let j = 0; j < DIODE_MARKER.length; j++) if (raw[i + j] !== DIODE_MARKER[j]) continue outer;
    return i;
  }
  return -1;
}

/** Everything the post-marker annotation section can carry. All maps are empty
 *  on a normal boardview (no marker, or a marker with nothing after it). */
export interface XzzTailAnnotations {
  /** Diode readings keyed `PART(PIN)`, where PART is the JSON `reference`. */
  diodes: Map<string, DiodeReading>;
  /** Same readings keyed by the JSON `alias` — `PART(PIN)` again, but under the
   *  human designator. Populated only from the JSON tail (the legacy record
   *  format has no alias concept). Lets the join try both keys without
   *  re-walking the table. */
  diodesByAlias: Map<string, DiodeReading>;
  /** `reference` → `alias`: the internal part id the binary blocks use mapped
   *  to the designator XZZ's viewer displays (`C356_1` → `C11814`). */
  partAliases: Map<string, string>;
  /** `Net21` → `PP_VDD_MAIN`. Sparse — only the nets the author bothered to
   *  name; most boards carry none. */
  netAliases: Map<string, string>;
  /** Which encoding the section used, for logging. */
  encoding: 'none' | 'legacy' | 'json';
}

function emptyAnnotations(): XzzTailAnnotations {
  return {
    diodes: new Map(), diodesByAlias: new Map(),
    partAliases: new Map(), netAliases: new Map(), encoding: 'none',
  };
}

/** Shape of the JSON annotation tail. Every field is optional — the two
 *  deliveries of one board ("Boardview" carries `pad`/`net`, "YiDianTong"
 *  carries only `reference`/`alias`) differ in exactly which are present. */
interface XzzTailJson {
  part?: Array<{
    reference?: string;
    alias?: string;
    value?: string;
    pad?: Array<{ name?: string; diode?: string }>;
  }>;
  net?: Array<{ name?: string; alias?: string }>;
}

/** Parse the post-marker section in whichever of its two encodings this file
 *  uses. Both live past the XOR boundary, so neither is ever XOR'd or DES'd.
 *
 *  **Legacy** (older "Middle layer diode value" companions): newline-delimited
 *  `=<value>=<partName>(<pinNumber>)` records, nothing but diode values.
 *
 *  **JSON** (current iPhone-era deliveries, e.g. iPhone16_16Plus): a single
 *  `{"part":[…],"net":[…],"bitmap":{…}}` document after a `===PCB<gb2312>`
 *  banner line. Diode readings hang off `part[].pad[].diode`; `part[].alias`
 *  and `net[].alias` are the rename tables XZZ's own viewer applies. A board
 *  can ship the JSON with the rename tables and NO `pad[]` at all — that file
 *  genuinely has no diode data, and this returns empty `diodes` for it.
 *
 *  Detection is by content, not by file name: try JSON when a `{` follows the
 *  marker, else fall back to the legacy regex. */
export function parseXzzTailAnnotations(raw: Uint8Array): XzzTailAnnotations {
  const pos = findDiodeMarker(raw);
  if (pos < 0) return emptyAnnotations();

  const tail = raw.subarray(pos + DIODE_MARKER.length);
  // The JSON body is UTF-8, but the banner between the marker and the `{` is
  // GB2312 ("===PCB<4 high bytes>"), which would corrupt a whole-tail UTF-8
  // decode of the prefix. Find the brace on the raw bytes, then decode only
  // from there. 0x7b = '{'.
  // 0x7b = '{'. Capped scan: the banner is one short line, so a brace further
  // in than this is not a JSON document header. A legacy tail that happens to
  // contain a brace just fails JSON.parse below and falls through.
  let brace = -1;
  for (let i = 0; i < tail.length && i < 4096; i++) {
    if (tail[i] === 0x7b) { brace = i; break; }
  }
  if (brace >= 0) {
    const json = parseXzzTailJson(tail.subarray(brace));
    if (json) return json;
  }
  return parseLegacyDiodeRecords(tail);
}

function parseXzzTailJson(bytes: Uint8Array): XzzTailAnnotations | null {
  let doc: XzzTailJson;
  try {
    doc = JSON.parse(new TextDecoder('utf-8').decode(bytes)) as XzzTailJson;
  } catch {
    return null;                                  // not JSON after all
  }
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.part)) return null;

  const out = emptyAnnotations();
  out.encoding = 'json';
  for (const p of doc.part) {
    const ref = typeof p?.reference === 'string' ? p.reference : '';
    if (!ref) continue;
    const alias = typeof p.alias === 'string' && p.alias !== '' && p.alias !== ref ? p.alias : '';
    if (alias) out.partAliases.set(ref, alias);
    if (!Array.isArray(p.pad)) continue;
    for (const pad of p.pad) {
      if (typeof pad?.name !== 'string' || typeof pad.diode !== 'string') continue;
      const reading = classifyXzzDiode(pad.diode.trim());
      if (!reading) continue;
      out.diodes.set(`${ref}(${pad.name})`, reading);
      if (alias) out.diodesByAlias.set(`${alias}(${pad.name})`, reading);
    }
  }
  if (Array.isArray(doc.net)) {
    for (const n of doc.net) {
      if (typeof n?.name !== 'string' || typeof n.alias !== 'string') continue;
      if (n.name === '' || n.alias === '' || n.name === n.alias) continue;
      out.netAliases.set(n.name, n.alias);
    }
  }
  return out;
}

function parseLegacyDiodeRecords(tail: Uint8Array): XzzTailAnnotations {
  const out = emptyAnnotations();
  // Decode as latin1 (records are ASCII) and scan for records.
  let s = '';
  for (let i = 0; i < tail.length; i++) s += String.fromCharCode(tail[i]);
  const rx = /=([^=\n]*)=([A-Za-z0-9_]+)\((\d+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(s))) {
    const reading = classifyXzzDiode(m[1].trim());
    if (reading) out.diodes.set(`${m[2]}(${m[3]})`, reading);
  }
  if (out.diodes.size > 0) out.encoding = 'legacy';
  return out;
}

/** Diode readings only, keyed `PART(PIN)` by the JSON `reference` (or, in the
 *  legacy encoding, by the part name in the record). Thin wrapper over
 *  `parseXzzTailAnnotations` kept for callers that want just the table. */
export function parseDiodeSection(raw: Uint8Array): Map<string, DiodeReading> {
  return parseXzzTailAnnotations(raw).diodes;
}

/**
 * Normalise an XZZ arc sweep into `[0, 360)`.
 *
 * XZZ arcs are counter-clockwise: the format mirrors arc pairs about an axis by
 * reflecting each angle **and** swapping start/end, so the stored order encodes
 * a direction rather than an undirected chord. Lift negative sweeps by a full
 * turn; never reduce a sweep that exceeds 180°, which would silently select the
 * complementary arc.
 */
export function xzzArcSweepDeg(startDeg: number, endDeg: number): number {
  // Modulo rather than a single lift: identical for every in-domain input
  // (stored angles sit within one turn, so the difference is in (-360, 360)),
  // but a malformed file cannot produce an over-wound arc. It never reduces a
  // legitimate 180-360 sweep, which is the failure this fix exists to prevent.
  return ((endDeg - startDeg) % 360 + 360) % 360;
}

type RawTrace = { rawLayer: number; x1: number; y1: number; x2: number; y2: number; width: number; netIndex: number; mirrored?: boolean };

/** One physical board of a pack, as the parser leaves it: folded, and moved
 *  into its final place. `region` and `fold.axis` are tracked through the
 *  mirror-correction and origin-normalisation passes that follow. */
interface PackBoard {
  components: number[];
  top: number;
  bottom?: number;
  fold?: { dim: 'x' | 'y'; axis: number; lowerIsBottom: boolean };
  sideSource: 'copper' | 'layout' | 'single';
  cpuDisagrees?: boolean;
  region: { minX: number; minY: number; maxX: number; maxY: number };
  shift: { dx: number; dy: number };
  pair?: ComponentPair;
}

interface PackResult {
  boards: PackBoard[];
  /** Two or more boards, or one pair next to unpaired boards. */
  isPack: boolean;
  /** Copper's verdict on whether the design's top half sits opposite to
   *  where the layout rule puts it; null when no pair had decisive copper.
   *  Has never been true on the corpus — kept as the tripwire. */
  fileMirrored: boolean | null;
  /** The old single-butterfly `FoldResult`, synthesised for a lone pair so
   *  `foldInfo` / the sidebar summary / "Show all sides" keep working. */
  compatFold: FoldResult | null;
  majorCount: number;
  copperLayers: { first: number; last: number } | null;
}

/** Split the file into boards and fold each one in place.
 *
 *  Steps, all on the pre-fold geometry:
 *   1. classify outline loops (board / cutout / fragment / frame) and pair
 *      the boards' halves — `xzz-boards.ts`;
 *   2. decide each pair's top half: copper if the file has traces, else the
 *      exporter's layout rule (lower coordinate = top), with the CPU rule
 *      kept as the prior for a lone pair without copper — the MacBook case
 *      the rule was written for, where copper confirms it;
 *   3. mirror every bottom-half item (pins, part silk, traces, vias, silk,
 *      test pads) across the pair's axis and drop the bottom half's loops;
 *   4. on a pack, slide the folded boards next to each other so the empty
 *      bottom-half areas don't sit between them.
 *
 *  Returns null when there are fewer than two loops; `boards` is empty when
 *  nothing paired (the caller then runs the legacy single-outline path). */
function foldBoardPack(args: {
  segments: Segment[]; comps: OutlineComponent[]; parts: PartData[];
  rawTraces: RawTrace[]; vias: ViaData[]; silk: Segment[]; testPads: TestPadData[];
}): PackResult | null {
  const { segments, comps, parts, rawTraces, vias, silk, testPads } = args;
  if (comps.length < 2) return null;

  const centroid = (pd: PartData): Point | null => {
    if (pd.pins.length === 0) return null;
    let x = 0, y = 0;
    for (const p of pd.pins) { x += p.x; y += p.y; }
    return { x: x / pd.pins.length, y: y / pd.pins.length };
  };
  const compAt = makeRegionLookup(comps);
  const partCount = new Array<number>(comps.length).fill(0);
  const partComp = parts.map(pd => {
    const c = centroid(pd);
    if (!c) return -1;
    const i = compAt(c.x, c.y);
    if (i >= 0) partCount[i]++;
    return i;
  });
  const cls = classifyComponents(comps, partCount);
  const { pairs, singles } = pairMajors(comps, cls.majors);
  const majorOf = (i: number): number => {
    let guard = 0;
    while (i >= 0 && cls.cls[i] === 'cutout' && guard++ < comps.length) i = cls.parentOf[i]!;
    return i;
  };
  const empty: PackResult = { boards: [], isPack: false, fileMirrored: null, compatFold: null, majorCount: cls.majors.length, copperLayers: null };
  if (pairs.length === 0) {
    log.parser.log(
      `(pcb boards) ${comps.length} outline loops: ${cls.majors.length} board-sized, ` +
      `${cls.cls.filter(c => c === 'cutout').length} cutouts, ${cls.cls.filter(c => c === 'fragment').length} fragments, ` +
      `${cls.cls.filter(c => c === 'frame').length} frames — no mirror-image pair found`,
    );
    return empty;
  }
  const isPack = pairs.length >= 2 || cls.majors.length >= 3;

  // ── Copper oracle ──
  let votes: CopperVotes[] | null = null;
  let copperLayers: { first: number; last: number } | null = null;
  if (rawTraces.length >= 1000) {
    let lo = Infinity, hi = -Infinity;
    for (const t of rawTraces) { if (t.rawLayer < lo) lo = t.rawLayer; if (t.rawLayer > hi) hi = t.rawLayer; }
    if (hi > lo) {
      copperLayers = { first: lo, last: hi };
      const key = (x: number, y: number) => `${Math.round(x)},${Math.round(y)}`;
      const ep = new Map<string, number>(); // bit 1 = first layer, bit 2 = last layer
      for (const t of rawTraces) {
        const bit = t.rawLayer === lo ? 1 : t.rawLayer === hi ? 2 : 0;
        if (!bit) continue;
        for (const [x, y] of [[t.x1, t.y1], [t.x2, t.y2]]) {
          const k = key(x, y);
          ep.set(k, (ep.get(k) ?? 0) | bit);
        }
      }
      votes = comps.map(() => ({ first: 0, last: 0 }));
      parts.forEach((pd, pi) => {
        const m = majorOf(partComp[pi]);
        if (m < 0) return;
        for (const p of pd.pins) {
          let bits = 0;
          for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
            bits |= ep.get(key(p.x + dx, p.y + dy)) ?? 0;
          }
          if (bits & 1) votes![m].first++;
          else if (bits & 2) votes![m].last++;
        }
      });
    }
  }

  // The most-pinned part's half — the CPU rule the MacBook path used to
  // decide sides with. Kept as a diagnostic against the layout rule.
  let cpuTop: number | null = null;
  if (parts.length >= 8) {
    let best = -1, bestPins = 9;
    parts.forEach((pd, i) => { if (pd.pins.length > bestPins) { bestPins = pd.pins.length; best = i; } });
    if (best >= 0) cpuTop = majorOf(partComp[best]);
  }
  const decisions = pairs.map(p => decideSide(p, votes, cpuTop));
  // Copper's view of whether the design's top half sits where the layout
  // rule expects it. Across the corpus it always has (78/78), which is what
  // lets the layout rule stand in when a file carries no copper.
  let mir = 0;
  decisions.forEach((d, i) => {
    if (d.source !== 'copper') return;
    const layoutTop = pairs[i].dim === 'x' ? pairs[i].lower : pairs[i].upper;
    mir += d.top === layoutTop ? -1 : 1;
  });
  const fileMirrored: boolean | null = mir > 0 ? true : mir < 0 ? false : null;

  // ── Boards + membership ──
  const cutoutsOf = (m: number): number[] => {
    const out: number[] = [];
    for (let i = 0; i < comps.length; i++) if (cls.cls[i] === 'cutout' && majorOf(i) === m) out.push(i);
    return out;
  };
  const boards: PackBoard[] = [];
  const regionsPre: Array<{ minX: number; minY: number; maxX: number; maxY: number }> = [];
  pairs.forEach((p, i) => {
    const d = decisions[i];
    const all = [d.top, d.bottom, ...cutoutsOf(d.top), ...cutoutsOf(d.bottom)];
    boards.push({
      components: all, top: d.top, bottom: d.bottom,
      fold: { dim: p.dim, axis: p.axis, lowerIsBottom: d.top === p.upper },
      sideSource: d.source,
      cpuDisagrees: d.cpuDisagrees,
      region: unionBBox(comps, [d.top, ...cutoutsOf(d.top)]),
      shift: { dx: 0, dy: 0 },
      pair: p,
    });
    regionsPre.push(unionBBox(comps, all));
  });
  for (const sIdx of singles) {
    const all = [sIdx, ...cutoutsOf(sIdx)];
    boards.push({ components: all, top: sIdx, sideSource: 'single', region: unionBBox(comps, all), shift: { dx: 0, dy: 0 } });
    regionsPre.push(unionBBox(comps, all));
  }
  const boardAt = makeRegionLookup(regionsPre);
  const compBoard = new Int32Array(comps.length).fill(-1);
  boards.forEach((b, bi) => { for (const ci of b.components) compBoard[ci] = bi; });
  // Membership computed once, before anything moves.
  for (const pd of parts) { const c = centroid(pd); pd.boardIndex = c ? boardAt(c.x, c.y) : -1; }
  const traceBoard = rawTraces.map(t => boardAt((t.x1 + t.x2) / 2, (t.y1 + t.y2) / 2));
  const viaBoard = vias.map(v => boardAt(v.x, v.y));
  const silkBoard = silk.map(s => boardAt((s.p1.x + s.p2.x) / 2, (s.p1.y + s.p2.y) / 2));
  const tpBoard = testPads.map(tp => boardAt(tp.x, tp.y));
  const segBoard = new Int32Array(segments.length).fill(-1);
  comps.forEach((c, ci) => { for (const si of c.segIdxs) segBoard[si] = compBoard[ci]; });

  // ── Fold each pair ──
  const dropSeg = new Set<number>();
  let mirroredParts = 0;
  boards.forEach((b, bi) => {
    if (!b.fold || b.bottom === undefined) return;
    const { dim, axis, lowerIsBottom } = b.fold;
    const isBottom = (x: number, y: number) => { const c = dim === 'x' ? x : y; return lowerIsBottom ? c < axis : c > axis; };
    const mx = (p: { x: number; y: number }) => { if (dim === 'x') p.x = 2 * axis - p.x; else p.y = 2 * axis - p.y; };
    for (const pd of parts) {
      if (pd.boardIndex !== bi) continue;
      const c = centroid(pd);
      if (!c || !isBottom(c.x, c.y)) continue;
      pd.side = 'bottom';
      mirroredParts++;
      for (const p of pd.pins) mx(p);
      for (const s of pd.silkLines) {
        if (dim === 'x') { s.x1 = 2 * axis - s.x1; s.x2 = 2 * axis - s.x2; }
        else             { s.y1 = 2 * axis - s.y1; s.y2 = 2 * axis - s.y2; }
      }
    }
    rawTraces.forEach((t, i) => {
      if (traceBoard[i] !== bi || !isBottom((t.x1 + t.x2) / 2, (t.y1 + t.y2) / 2)) return;
      if (dim === 'x') { t.x1 = 2 * axis - t.x1; t.x2 = 2 * axis - t.x2; }
      else             { t.y1 = 2 * axis - t.y1; t.y2 = 2 * axis - t.y2; }
      t.mirrored = true;
    });
    vias.forEach((v, i) => { if (viaBoard[i] === bi && isBottom(v.x, v.y)) { mx(v); v.mirrored = true; } });
    silk.forEach((s, i) => {
      if (silkBoard[i] !== bi || !isBottom((s.p1.x + s.p2.x) / 2, (s.p1.y + s.p2.y) / 2)) return;
      mx(s.p1); mx(s.p2);
    });
    testPads.forEach((tp, i) => {
      if (tpBoard[i] !== bi) return;
      if (isBottom(tp.x, tp.y)) { tp.side = 'bottom'; mx(tp); } else tp.side = 'top';
    });
    for (const ci of [b.bottom, ...cutoutsOf(b.bottom)]) for (const si of comps[ci].segIdxs) dropSeg.add(si);
  });
  // Frames go; fragments on a discarded half go with it.
  comps.forEach((c, ci) => {
    if (cls.cls[ci] === 'frame') { for (const si of c.segIdxs) dropSeg.add(si); return; }
    if (cls.cls[ci] !== 'fragment') return;
    const cx = (c.minX + c.maxX) / 2, cy = (c.minY + c.maxY) / 2;
    const bi = boardAt(cx, cy);
    const b = bi >= 0 ? boards[bi] : null;
    if (!b || !b.fold) return;
    const v = b.fold.dim === 'x' ? cx : cy;
    if (b.fold.lowerIsBottom ? v < b.fold.axis : v > b.fold.axis) for (const si of c.segIdxs) dropSeg.add(si);
  });

  // ── Compaction: slide the folded boards next to each other ──
  const dims = new Set(boards.filter(b => b.fold).map(b => b.fold!.dim));
  if (isPack && dims.size === 1 && boards.length > 1) {
    const dim = [...dims][0];
    const lo = (r: PackBoard['region']) => dim === 'x' ? r.minX : r.minY;
    const ext = (r: PackBoard['region']) => dim === 'x' ? r.maxX - r.minX : r.maxY - r.minY;
    const order = boards.map((_, i) => i).sort((a, b) => lo(boards[a].region) - lo(boards[b].region));
    const across = Math.max(...boards.map(b => dim === 'x' ? b.region.maxY - b.region.minY : b.region.maxX - b.region.minX));
    const gap = Math.max(40, across * 0.04);
    let cursor = lo(boards[order[0]].region);
    for (const bi of order) {
      const b = boards[bi];
      const d = cursor - lo(b.region);
      cursor += ext(b.region) + gap;
      if (Math.abs(d) < 1e-9) continue;
      const sh = (p: { x: number; y: number }) => { if (dim === 'x') p.x += d; else p.y += d; };
      for (const pd of parts) {
        if (pd.boardIndex !== bi) continue;
        for (const p of pd.pins) sh(p);
        for (const s of pd.silkLines) { if (dim === 'x') { s.x1 += d; s.x2 += d; } else { s.y1 += d; s.y2 += d; } }
      }
      rawTraces.forEach((t, i) => { if (traceBoard[i] === bi) { if (dim === 'x') { t.x1 += d; t.x2 += d; } else { t.y1 += d; t.y2 += d; } } });
      vias.forEach((v, i) => { if (viaBoard[i] === bi) sh(v); });
      silk.forEach((s, i) => { if (silkBoard[i] === bi) { sh(s.p1); sh(s.p2); } });
      testPads.forEach((tp, i) => { if (tpBoard[i] === bi) sh(tp); });
      segments.forEach((s, i) => { if (segBoard[i] === bi) { sh(s.p1); sh(s.p2); } });
      if (dim === 'x') { b.region.minX += d; b.region.maxX += d; b.shift.dx = d; }
      else             { b.region.minY += d; b.region.maxY += d; b.shift.dy = d; }
    }
  }

  // Outline: keep what survived, in place.
  const before = segments.length;
  const kept = segments.filter((_, i) => !dropSeg.has(i));
  segments.length = 0;
  for (const s of kept) segments.push(s);
  const dup = dedupeCoincidentSegments(segments);

  // ── Log ──
  boards.forEach((b, bi) => {
    const n = parts.filter(pd => pd.boardIndex === bi);
    const bot = n.filter(pd => pd.side === 'bottom').length;
    const w = (b.region.maxX - b.region.minX).toFixed(0), h = (b.region.maxY - b.region.minY).toFixed(0);
    log.parser.log(
      `(pcb board ${bi + 1}) ${w}×${h} mil | side=${b.sideSource}` +
      (votes && b.bottom !== undefined ? ` (L${copperLayers!.first}:${votes[b.top].first}/${votes[b.bottom].first} L${copperLayers!.last}:${votes[b.top].last}/${votes[b.bottom].last})` : '') +
      (b.fold ? ` | fold ${b.fold.dim}@${b.fold.axis.toFixed(0)} top=C${b.top} bottom=C${b.bottom}` : ' | single-sided') +
      (b.cpuDisagrees ? ' | CPU RULE DISAGREES' : '') +
      ` | parts top=${n.length - bot} bottom=${bot}` +
      (b.shift.dx || b.shift.dy ? ` | moved ${b.shift.dx ? b.shift.dx.toFixed(0) + ' x' : b.shift.dy.toFixed(0) + ' y'}` : ''),
    );
  });
  log.parser.log(
    `(pcb ${isPack ? 'pack' : 'butterfly'}) ${boards.length} board${boards.length === 1 ? '' : 's'} from ${comps.length} outline loops ` +
    `(${cls.majors.length} board-sized, ${cls.cls.filter(c => c === 'cutout').length} cutouts, ${cls.cls.filter(c => c === 'fragment').length} fragments, ${cls.cls.filter(c => c === 'frame').length} frames)` +
    ` | mirrored parts=${mirroredParts} | outline ${before}→${segments.length} segs (dup=${dup})` +
    ` | file mirrored: ${fileMirrored === null ? 'unknown' : fileMirrored}`,
  );

  let compatFold: FoldResult | null = null;
  if (!isPack && boards.length === 1 && boards[0].fold && boards[0].pair) {
    const b = boards[0];
    compatFold = {
      axis: b.fold!.axis, dim: b.fold!.dim, lowerIsBottom: b.fold!.lowerIsBottom,
      disconnectedOutline: true,
      _debug: { source: 'outline-components', sideSignal: b.sideSource, compGap: b.pair!.gap },
    };
  }
  return { boards, isPack, fileMirrored, compatFold, majorCount: cls.majors.length, copperLayers };
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
  const rawTraces: RawTrace[] = [];
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
        const startDeg = ri32(blockData, 16) / XZZ_SCALE;
        const endDeg   = ri32(blockData, 20) / XZZ_SCALE;
        // The stored (start, end) pair names TWO arcs — the CCW one and the CW
        // one — so normalising the sweep IS the choice between them, not angle
        // hygiene. The previous swap+clamp implemented a shortest-arc rule and
        // therefore replaced every arc sweeping past 180° with its complement:
        // notches, slot mouths and re-entrant fillets rendered as outward lobes
        // anchored at the same two points. Endpoints match under either
        // reading, so only the midpoint discriminates. See issue #33.
        const sweepDeg = xzzArcSweepDeg(startDeg, endDeg);
        const sRad = startDeg * Math.PI / 180;
        const eRad = (startDeg + sweepDeg) * Math.PI / 180;
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

  // Decide whether the part-label channel actually carries BOM values.
  // The 0x06 body label is a silkscreen text element and what an exporter
  // puts in it varies: MSI (and other Cadence/PADS re-exports) write the
  // component value — "22uF" under C757 — while Apple's exporter writes a
  // serialised placeholder, Device1 / Device2 / … one per part and never
  // repeated. A value column that is unique on every single part of a board
  // full of passives is not a BOM, so drop the whole channel rather than
  // stamping 4,745 parts with a meaningless "DeviceN".
  {
    const values = partDataList.map(pd => pd.value).filter((v): v is string => !!v);
    const distinct = new Set(values).size;
    if (values.length >= PLACEHOLDER_MIN_SAMPLES
        && distinct >= values.length * PLACEHOLDER_UNIQUE_RATIO
        && values.filter(v => SERIAL_LABEL_RE.test(v)).length >= values.length * PLACEHOLDER_SERIAL_RATIO) {
      for (const pd of partDataList) pd.value = undefined;
      log.parser.log(
        `(pcb values) dropped ${values.length} part labels — ${distinct} distinct and serially numbered ` +
        `(e.g. "${values[0]}"): exporter placeholder text, not BOM values`,
      );
    } else if (values.length > 0) {
      log.parser.log(`(pcb values) ${values.length} parts carry a component value (${distinct} distinct)`);
    }
  }

  // Collapse implausible oblong pad geometry (see normalizeOblongPads doc)
  // while positions and pad angles are still in the un-mirrored frame.
  {
    let collapsedTotal = 0;
    const stats = { subPen: 0 };
    for (const pd of partDataList) collapsedTotal += normalizeOblongPads(pd.pins, stats);
    if (collapsedTotal > 0) {
      log.parser.log(
        `(pcb pads) oblong guard: collapsed ${collapsedTotal} implausible oblong pads to round dots` +
        (stats.subPen > 0 ? ` (${stats.subPen} of them for a sub-${MIN_PEN_MILS}-mil pen — not manufacturable copper)` : ''),
      );
    }
  }

  // Snapshot pre-fold geometry for the "Show all sides" view before the
  // butterfly branch mutates `segments` and `partDataList` in place.
  const rawSegmentsSnapshot: Segment[] = segments.map(s => ({
    p1: { x: s.p1.x, y: s.p1.y },
    p2: { x: s.p2.x, y: s.p2.y },
  }));
  const foldComponents = componentBBoxes(rawSegmentsSnapshot);

  // Split the file into boards and fold each one (see foldBoardPack). Falls
  // back to the legacy single-outline detector when no mirror-image pair
  // exists (flat boards, one connected loop cut down the middle).
  const pack = foldBoardPack({ segments, comps: foldComponents, parts: partDataList, rawTraces, vias: viasRaw, silk: silkSegments, testPads });
  const packFolded = !!(pack && pack.boards.length > 0);
  const fold: FoldResult | null = packFolded ? pack!.compatFold : findFoldAxis(segments, partDataList, testPads, pack?.majorCount ?? 0);
  if (fold && !packFolded) {
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
      t.mirrored = true;
    }
    // Vias use a single point — classify by it directly.
    for (const v of viasRaw) {
      const c = fold.dim === 'x' ? v.x : v.y;
      const isBottom = fold.lowerIsBottom ? c < fold.axis : c > fold.axis;
      if (!isBottom) continue;
      if (fold.dim === 'x') v.x = 2 * fold.axis - v.x;
      else                  v.y = 2 * fold.axis - v.y;
      v.mirrored = true;
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
      removed += dedupeCoincidentSegments(segments);
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
  } else if (!packFolded) {
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
    // The pin-direction detector decides. Copper cannot: on every one of the
    // 78 trace-carrying corpus files the design's top half sits at the lower
    // coordinate, whether or not the pins wind clockwise — mirroring changes
    // the winding, not where the exporter puts the halves. What the pack
    // pass changed is the detector's input: folded boards with real sides,
    // so its top-side votes no longer come from both sides at once (the
    // false flip on iPhone X Qualcomm came from that).
    const packBoards = packFolded ? pack!.boards : [];
    const doFlip = v.mirrored;
    if (packFolded && pack!.fileMirrored !== null) {
      log.parser.log(`(pcb mirror) copper: design top ${pack!.fileMirrored ? 'OPPOSITE to' : 'where'} the layout rule expects${pack!.fileMirrored ? ' — first time in the corpus, please report this file' : ''}`);
    }
    if (doFlip) {
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
        for (const b of packBoards) {
          const r = b.region; const oMin = r.minX; r.minX = -r.maxX; r.maxX = -oMin;
          if (b.fold && b.fold.dim === 'x') b.fold.axis = -b.fold.axis;
          b.shift.dx = -b.shift.dx;
        }
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
        for (const b of packBoards) {
          const r = b.region; const oMin = r.minY; r.minY = -r.maxY; r.maxY = -oMin;
          if (b.fold && b.fold.dim === 'y') b.fold.axis = -b.fold.axis;
          b.shift.dy = -b.shift.dy;
        }
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
  if (packFolded) {
    for (const b of pack!.boards) {
      b.region.minX -= minX; b.region.maxX -= minX;
      b.region.minY -= minY; b.region.maxY -= minY;
      if (b.fold) b.fold.axis -= b.fold.dim === 'x' ? minX : minY;
    }
  }
  const rawOutline = chainByComponent(rawSegmentsSnapshot);
  const boardsOut: NonNullable<BoardData['boards']> | undefined = packFolded
    ? pack!.boards.map(b => ({
        components: b.components, top: b.top,
        ...(b.bottom !== undefined ? { bottom: b.bottom } : {}),
        ...(b.fold ? { fold: { ...b.fold } } : {}),
        sideSource: b.sideSource,
        bounds: { ...b.region },
        shift: { ...b.shift },
      }))
    : undefined;
  const boardGroups = boardsOut
    ? boardsOut.map(b => ({ components: b.components, ...(b.fold ? { fold: { ...b.fold } } : {}) }))
    : groupComponentsByGeometry(foldComponents.map(({ segIdxs: _s, ...rest }) => rest));
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

  // Placeholder-geometry guard: newer XZZ exports (M2-era Apple boards —
  // roughly half the surveyed corpus) write the SAME pad geometry on every
  // pin in the file (12×12 mil round, angle 0) instead of real pad shapes.
  // Trusting it shrinks a 125-mil coil pad to a 12-mil dot. Real-geometry
  // files carry 180+ distinct sizes, so the split is clean: if every
  // geometry-carrying pin shares one identical (w, h, shape, angle) and the
  // shape is a round dot, the data is a placeholder — drop it, so pins fall
  // back to the classic radius-8 dot and the renderer synthesizes the
  // classic FlexBV 2-pin pads.
  let geomPinCount = 0;
  let uniformGeom = true;
  let firstGeom: PinData | undefined;
  for (const pd of partDataList) {
    for (const p of pd.pins) {
      if (p.padW <= 0 || p.padH <= 0) continue;
      geomPinCount++;
      if (!firstGeom) { firstGeom = p; continue; }
      if (p.padW !== firstGeom.padW || p.padH !== firstGeom.padH ||
          p.padShape !== firstGeom.padShape || p.padAngleDeg !== firstGeom.padAngleDeg) {
        uniformGeom = false;
        break;
      }
    }
    if (!uniformGeom) break;
  }
  const placeholderPadGeom = uniformGeom && geomPinCount >= 100 &&
    firstGeom !== undefined && firstGeom.padShape === 'round' && firstGeom.padW === firstGeom.padH;
  if (placeholderPadGeom) {
    log.parser.log(
      `(pcb pads) placeholder pad geometry detected — all ${geomPinCount} pins are ` +
      `${firstGeom!.padW}x${firstGeom!.padH} ${firstGeom!.padShape}; dropping pad geometry, ` +
      `renderer falls back to synthesized pads`,
    );
  }

  for (const pd of partDataList) {
    if (!pd.name) continue;
    const pins: Pin[] = pd.pins.map((p, i) => {
      const raw2 = netDict.get(p.netIndex) ?? '';
      const net = (raw2 === 'NC' || raw2 === 'UNCONNECTED') ? '' : raw2;
      // Forward the real pad geometry to the pin so the renderer can draw
      // the actual rect/round shape (rotated AABB for selection halo + pin
      // sprite) instead of a generic circle. Mirrors the Pad emission below;
      // also stops the pin-circle peeking out from under the copper overlay
      // when "Show pads" is on (the doubling fix).
      const hasGeom = !placeholderPadGeom && p.padW > 0 && p.padH > 0;
      const r = hasGeom ? Math.max(0.5, Math.min(p.padW, p.padH) / 2) : 8;
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
        ...(p.drill > 0 ? { drill: p.drill } : {}),
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
    // A part is through-hole when any of its pins carries a drill. Until the
    // drill field was decoded every XZZ part claimed 'smd', which is wrong
    // exactly where the distinction matters — connectors, headers, mounting
    // pins — and both the Info pane and MCP part_info read it.
    const partType: Part['type'] = pd.pins.some(p => p.drill > 0) ? 'throughhole' : 'smd';
    parts.push({ name: pd.name, side: pd.side, type: partType, origin: { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 }, pins, bounds, ...(angleDeg !== undefined ? { angleDeg } : {}), ...(pd.value ? { meta: { value: pd.value } } : {}), ...(packFolded && pd.boardIndex !== undefined && pd.boardIndex >= 0 ? { boardIndex: pd.boardIndex } : {}) });

    // Emit a Pad per pin with valid geometry (none when the file only
    // carries placeholder geometry — 12-mil dots are not copper pads).
    for (let i = 0; i < pd.pins.length; i++) {
      if (placeholderPadGeom) break;
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
        // Guarded: a drill wider than the copper it sits in is not a hole.
        // The relation holds on every pin in the corpus, but nothing upstream
        // enforces it and the drill never reaches capsuleParams' own guards.
        ...(p.drill > 0 && p.drill < Math.min(p.padW, p.padH) ? { drill: p.drill } : {}),
      });
    }
  }

  // Build nails from test pads
  const nails: Nail[] = testPads.map(tp => {
    const raw2 = netDict.get(tp.netIndex) ?? '';
    return { position: { x: tp.x, y: tp.y }, side: tp.side ?? ('top' as const), net: (raw2 === 'NC' || raw2 === 'UNCONNECTED') ? '' : raw2 };
  });

  // Build vias from 0x02 blocks. `layers: []` = through-hole. The layer-pair
  // fields ARE decodable — see parseViaBlock for the evidence that they carry
  // a real span — but acting on them means deciding how a blind via draws when
  // its layers are hidden, which is a rendering question we haven't answered.
  // The renderer's via-overlay matches connected layers to nearby trace
  // endpoints regardless of `layers`, so empty here stays safe.
  const vias = viasRaw.map(v => {
    const raw2 = netDict.get(v.netIndex) ?? '';
    return {
      position: { x: v.x, y: v.y },
      diameter: v.outer,
      net: (raw2 === 'NC' || raw2 === 'UNCONNECTED') ? '' : raw2,
      layers: [] as number[],
      ...(v.mirrored ? { mirrored: true } : {}),
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
      ...(t.mirrored ? { mirrored: true } : {}),
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

  // ── Post-marker annotation section ───────────────────────────────────────
  // Everything past `v6v6555v6v6` is plaintext (never XOR'd or DES'd) and
  // carries, depending on the delivery: a diode-value table, a part rename
  // table, and a net rename table. See parseXzzTailAnnotations for the two
  // encodings. Absent on normal boardviews → every map empty, nothing runs.
  const tail = parseXzzTailAnnotations(raw);

  // Part rename (`reference` → `alias`). The binary blocks name parts by the
  // internal id on some deliveries (`C356_1`) and by the designator on others
  // (`C11814`); the alias table is how XZZ's viewer shows the designator in
  // both cases. Only rename parts the binary named by `reference`, and never
  // onto a name a *different* part already holds — a rename whose target is
  // itself being vacated by another rename is fine, so collisions are tested
  // against (existing names − names being vacated).
  if (tail.partAliases.size > 0) {
    const byName = new Map<string, typeof parts[number]>();
    for (const p of parts) byName.set(p.name, p);
    const vacating = new Set<string>();
    for (const ref of tail.partAliases.keys()) if (byName.has(ref)) vacating.add(ref);
    const claimed = new Set<string>();
    let renamed = 0, skipped = 0;
    for (const [ref, alias] of tail.partAliases) {
      const part = byName.get(ref);
      if (!part) continue;                       // binary already uses the alias, or part absent
      if ((byName.has(alias) && !vacating.has(alias)) || claimed.has(alias)) { skipped++; continue; }
      claimed.add(alias);
      part.name = alias;
      renamed++;
    }
    if (renamed > 0 || skipped > 0) {
      log.parser.log(`[xzz tail] part rename: ${renamed} renamed, ${skipped} skipped (name collision) of ${tail.partAliases.size} aliases`);
    }
  }

  // Net rename (`Net21` → `PP_VDD_MAIN`). Sparse — usually only the rails the
  // author named. Same collision rule as parts: never merge two distinct nets
  // into one name, since net identity here IS the string (buildNets groups on
  // it, and highlight/search key on it).
  if (tail.netAliases.size > 0) {
    const existing = new Set<string>();
    for (const p of parts) for (const pin of p.pins) if (pin.net) existing.add(pin.net);
    const apply = new Map<string, string>();
    const claimed = new Set<string>();
    for (const [name, alias] of tail.netAliases) {
      if (!existing.has(name)) continue;
      if ((existing.has(alias) && !tail.netAliases.has(alias)) || claimed.has(alias)) continue;
      claimed.add(alias);
      apply.set(name, alias);
    }
    if (apply.size > 0) {
      for (const p of parts) for (const pin of p.pins) {
        const a = pin.net ? apply.get(pin.net) : undefined;
        if (a) pin.net = a;
      }
      log.parser.log(`[xzz tail] net rename: ${apply.size} of ${tail.netAliases.size} net aliases applied`);
    }
  }

  // Diode-value channel — join the reading table onto pins by PART(pinNumber).
  // Try the `reference` key first, then the `alias` key: the two deliveries of
  // one board disagree about which of the two the binary blocks use, and after
  // the rename above `part.name` may be either.
  let diodeReference: DiodeReferenceChannel | undefined;
  if (tail.diodes.size > 0) {
    const counts = { value: 0, open: 0, none: 0 };
    for (const r of tail.diodes.values()) counts[r.kind]++;
    // Identity set, not key set: `diodes` and `diodesByAlias` hold the SAME
    // reading objects under two keys, so counting objects is what makes
    // `unmatched` line up with `tail.diodes.size`.
    const matchedReadings = new Set<DiodeReading>();
    for (const part of parts) {
      for (const pin of part.pins) {
        const key = `${part.name}(${pin.number})`;
        const r = tail.diodes.get(key) ?? tail.diodesByAlias.get(key);
        if (r) { pin.diode = r; matchedReadings.add(r); }
      }
    }
    const matched = matchedReadings.size;
    diodeReference = { source: 'xzz-pcb', units: 'mV', counts, matched, unmatched: tail.diodes.size - matched };
    log.parser.log(
      `[xzz diode] ${tail.encoding} section: ${tail.diodes.size} records → matched ${matched} pins, ` +
      `${tail.diodes.size - matched} unmatched (value=${counts.value} open=${counts.open} none=${counts.none})`,
    );
  }

  return {
    format: 'XZZ', outline, parts, nails, nets: buildNets(parts), bounds,
    butterflyFoldAxis: fold?.dim ?? (boardsOut && boardsOut.some(b => b.fold) ? boardsOut.find(b => b.fold)!.fold!.dim : undefined),
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
    ...(boardsOut ? { boards: boardsOut } : {}),
  };
}
