/**
 * lib.ts — shared helpers for the v15 copper probes.
 *
 * Every probe loads the v15 file as a Node Buffer (little-endian reads), the
 * v17 oracle from `oracle.json` (written by 01-oracle-dump.ts) and searches
 * the raw bytes; nothing here touches the shipped parser.
 */
import { readFileSync } from 'node:fs';

export const V15 = '/Users/inwerp/Projects/BoardRipper/samples/incoming/uncategorized/Jasper_Kronos.brd';
export const V17 = '/Users/inwerp/Projects/BoardRipper/samples/incoming/uncategorized/Jasper_Kronos_v17.brd';
export const OUT = process.env.PROBE_OUT
  ?? '/private/tmp/claude-501/-Users-inwerp-Projects-BoardRipper/8b763fd4-4377-4f7c-aeb4-0119002b03b2/scratchpad';

export interface OracleSeg { type: number; key: number; track: number; sub: number; net: string; w: number; x1: number; y1: number; x2: number; y2: number; flags: number }
export interface OracleArc extends OracleSeg { cx: number; cy: number; r: number; subType: number; bbox: number[] }
export interface OracleVia { key: number; x: number; y: number; net: string; padstack: number; layer: { classCode: number; subclass: number }; bbox: number[] }
export interface Oracle {
  header: { magic: number; div: number; version: string };
  layers: string[];
  segments: OracleSeg[];
  arcs: OracleArc[];
  vias: OracleVia[];
  outline: { key: number; cc: number; sc: number; n: number; segs: any[] };
  outlineCands: any[];
  assembledOutline: { x: number; y: number }[];
}

export function loadOracle(): Oracle {
  return JSON.parse(readFileSync(`${OUT}/oracle.json`, 'utf8'));
}

export function loadV15(): Buffer {
  return readFileSync(V15);
}

export const u32 = (b: Buffer, o: number) => b.readUInt32LE(o);
export const i32 = (b: Buffer, o: number) => b.readInt32LE(o);
export const u8 = (b: Buffer, o: number) => b[o];

/** Header-ish: `00 XX YY ZZ` with XX != 0. */
export const looksLikeHeader = (b: Buffer, o: number) => o >= 0 && o + 4 <= b.length && b[o] === 0 && b[o + 1] !== 0;

export function i32le(v: number): Buffer {
  const b = Buffer.alloc(4); b.writeInt32LE(v | 0, 0); return b;
}
export function pairPattern(x: number, y: number): Buffer {
  return Buffer.concat([i32le(x), i32le(y)]);
}

/** Every offset (any alignment) where `pat` occurs in `buf`. */
export function findAll(buf: Buffer, pat: Buffer, limit = 1000): number[] {
  const hits: number[] = [];
  let from = 0;
  while (hits.length < limit) {
    const i = buf.indexOf(pat, from);
    if (i < 0) break;
    hits.push(i);
    from = i + 1;
  }
  return hits;
}

export function hex(n: number, w = 8): string { return '0x' + (n >>> 0).toString(16).padStart(w, '0'); }

/** Hex dump of `len` bytes at `off`, 16 per line, with offset column and i32 column for 4-aligned words. */
export function dump(b: Buffer, off: number, len: number, base = off): string {
  const lines: string[] = [];
  for (let o = off; o < off + len; o += 16) {
    const bytes: string[] = [];
    const words: string[] = [];
    for (let i = 0; i < 16 && o + i < b.length; i++) bytes.push(b[o + i].toString(16).padStart(2, '0'));
    for (let i = 0; i < 16 && o + i + 4 <= b.length; i += 4) words.push(String(b.readInt32LE(o + i)).padStart(11));
    lines.push(`${hex(o)} (+${(o - base).toString(16).padStart(3, '0')})  ${bytes.join(' ').padEnd(48)}  ${words.join(' ')}`);
  }
  return lines.join('\n');
}

/** Pick `n` oracle records whose coordinates are "distinctive" (not multiples of 1000 in v17 units, i.e. not round mils). */
export function distinctive<T extends { x1?: number; y1?: number; x?: number; y?: number }>(rows: T[], n: number, seed = 1): T[] {
  const pick: T[] = [];
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const isRound = (v: number) => v % 100000 === 0; // whole 10-mil multiples in v17 (1/10000 mil) units
  const shuffled = rows.slice().sort(() => rnd() - 0.5);
  for (const r of shuffled) {
    const x = r.x1 ?? r.x ?? 0, y = r.y1 ?? r.y ?? 0;
    if (isRound(x) || isRound(y) || x === 0 || y === 0) continue;
    pick.push(r);
    if (pick.length >= n) break;
  }
  return pick;
}

export function histogram<K>(items: Iterable<K>): Map<K, number> {
  const m = new Map<K, number>();
  for (const it of items) m.set(it, (m.get(it) ?? 0) + 1);
  return new Map([...m.entries()].sort((a, b) => b[1] - a[1]));
}

// ── v15 heap index ─────────────────────────────────────────────────────────────

import { AllegroStream } from '../../src/frontend/src/parsers/allegro/allegro-stream';
import { parseHeader } from '../../src/frontend/src/parsers/allegro/allegro-header';
import type { FileHeader } from '../../src/frontend/src/parsers/allegro/allegro-types';

export interface V15Index {
  hdr: FileHeader;
  strings: Map<number, string>;
  stringTableEnd: number;
  globalAddend: number;
  /** key → offset(s) of candidate headers carrying that key at +4 */
  index: Map<number, number | number[]>;
  /** type byte (prefix byte 1) → offsets of accepted candidate headers */
  ofType: Map<number, number[]>;
  /** offset of the candidate with this key whose prefix byte 1 is `b1`, or -1 */
  rec: (key: number, b1: number) => number;
  /** offset of the first candidate with this key (any type), or -1; plus its type byte */
  recAnyType: (key: number) => { off: number; b1: number } | null;
  /** first candidate with this key whose type byte is in `types` */
  recOfTypes: (key: number, types: ReadonlySet<number>) => { off: number; b1: number } | null;
}

/** String table (same layout as v16): [u32 id][cString][pad to 4] × stringsCount, from 0x1200. */
export function parseStrings(buf: Buffer, count: number): { strings: Map<number, string>; end: number } {
  const strings = new Map<number, string>();
  let o = 0x1200;
  for (let i = 0; i < count && o + 4 < buf.length; i++) {
    const id = buf.readUInt32LE(o); o += 4;
    let e = o; while (e < buf.length && buf[e] !== 0) e++;
    strings.set(id, buf.toString('latin1', o, e));
    o = e + 1;
    while (o % 4 !== 0) o++;
  }
  return { strings, end: o };
}

/**
 * Candidate-header index over the whole file. A header is `00 b1 b2 b3` at a
 * 4-aligned offset with b1 a multiple of 4 (v15 type byte = v16 block type × 4)
 * and 0 < b1>>2 <= 0x3C, whose u32 at +4 (the key) sits within the addend
 * window of the LL pools. BLK_0xC8 may carry 0x04/0x10 in byte 0 (flags).
 */
/**
 * Per-type acceptance test on header bytes 2/3. A heavily referenced key (the
 * GND net assignment, say) is preceded by a header-shaped word in dozens of
 * unrelated records; requiring the bytes the real record is known to carry
 * rejects those twins. Types not listed accept anything.
 */
export const HEADER_OK: ReadonlyMap<number, (b2: number, b3: number) => boolean> = new Map([
  [0x10, (b2, b3) => b2 === 0 && b3 === 0],           // net assignment
  [0x6c, (b2, b3) => b2 === 0 && b3 === 0],           // net
  [0x54, (b2, b3) => b2 === 0 && b3 === 0],           // line segments
  [0x58, (b2, b3) => b2 === 0 && b3 === 0],
  [0x5c, (b2, b3) => b2 === 0 && b3 === 0],
  [0x04, (b2, b3) => b2 === 0 && (b3 & ~0x40) === 0], // arc: byte 3 = subtype (0x40 = CW)
  [0x14, (b2) => b2 >= 1 && b2 <= 0x15],              // track: byte 2 = layer class
  [0xcc, (b2) => b2 === 0x12],                        // via: class 0x12 VIA_CLASS
  [0x70, (b2, b3) => b2 === 0 && b3 === 0],           // padstack
  [0xb4, (b2, b3) => b3 === 0],                       // footprint instance
]);

export function buildIndex(buf: Buffer, opts: { below?: number; above?: number } = {}): V15Index {
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const hdr = parseHeader(new AllegroStream(ab));
  const { strings, end } = parseStrings(buf, hdr.stringsCount);
  const globalAddend = hdr.LL_0x06.head - end;
  // Default window: −1 MB / +8 MB around the LL addend (the shipped parser's).
  // PROBE_BELOW / PROBE_ABOVE (hex) widen it: the Kronos tracks at the file's
  // tail sit in pools at −0x1EA79E0 and +0xA38068, outside the default window.
  const below = opts.below ?? (process.env.PROBE_BELOW ? parseInt(process.env.PROBE_BELOW, 16) : 0x100000);
  const above = opts.above ?? (process.env.PROBE_ABOVE ? parseInt(process.env.PROBE_ABOVE, 16) : 0x800000);
  const index = new Map<number, number | number[]>();
  const ofType = new Map<number, number[]>();
  for (let off = 0; off + 8 <= buf.length; off += 4) {
    const b1 = buf[off + 1];
    // Byte 0 is a flag byte on BLK_0xC8 pads (0x04 / 0x10) AND on [0x14] tracks:
    // the 6-mil DDR address tracks on Kronos read `04 14 06 00` — 975 of the
    // oracle's segments hung off such tracks and were invisible to a byte-0 == 0
    // scan (see 10-orphan-parents.ts).
    if (buf[off] !== 0 && !((b1 === 0xc8 || b1 === 0x14) && (buf[off] & ~0x14) === 0)) continue;
    if ((b1 & 3) !== 0 || b1 === 0 || (b1 >> 2) > 0x3c) continue;
    const ok = HEADER_OK.get(b1);
    if (ok && !ok(buf[off + 2], buf[off + 3])) continue;
    const key = buf.readUInt32LE(off + 4);
    const add = key - off;
    if (add < globalAddend - below || add > globalAddend + above) continue;
    const cur = index.get(key);
    if (cur === undefined) index.set(key, off);
    else if (typeof cur === 'number') index.set(key, [cur, off]);
    else cur.push(off);
    let arr = ofType.get(b1);
    if (!arr) { arr = []; ofType.set(b1, arr); }
    arr.push(off);
  }
  const rec = (key: number, b1: number): number => {
    if (key === 0) return -1;
    const cur = index.get(key);
    if (cur === undefined) return -1;
    if (typeof cur === 'number') return buf[cur + 1] === b1 ? cur : -1;
    for (const o of cur) if (buf[o + 1] === b1) return o;
    return -1;
  };
  const recAnyType = (key: number) => {
    if (key === 0) return null;
    const cur = index.get(key);
    if (cur === undefined) return null;
    const o = typeof cur === 'number' ? cur : cur[0];
    return { off: o, b1: buf[o + 1] };
  };
  const recOfTypes = (key: number, types: ReadonlySet<number>) => {
    if (key === 0) return null;
    const cur = index.get(key);
    if (cur === undefined) return null;
    for (const o of typeof cur === 'number' ? [cur] : cur) if (types.has(buf[o + 1])) return { off: o, b1: buf[o + 1] };
    return null;
  };
  return { hdr, strings, stringTableEnd: end, globalAddend, index, ofType, rec, recAnyType, recOfTypes };
}

/**
 * For a set of same-type records, classify each u32 field at +4·i (i in 1..n)
 * by what its value resolves to: 'zero', a candidate record type byte (as
 * 'T<hex>'), 'small' (< 0x100000, not a pointer), or 'unres'.
 */
export function fieldTypeHistogram(buf: Buffer, ix: V15Index, offsets: number[], nFields: number, sample = 2000): string[] {
  const lines: string[] = [];
  const step = Math.max(1, Math.floor(offsets.length / sample));
  for (let f = 1; f <= nFields; f++) {
    const h = new Map<string, number>();
    let n = 0;
    for (let i = 0; i < offsets.length; i += step) {
      const v = buf.readUInt32LE(offsets[i] + 4 * f);
      let k: string;
      if (v === 0) k = 'zero';
      else {
        const cur = ix.index.get(v);
        if (cur !== undefined) {
          const types = typeof cur === 'number' ? [buf[cur + 1]] : cur.map(o => buf[o + 1]);
          k = 'T' + [...new Set(types)].map(t => t.toString(16)).sort().join('/');
        } else if (v < 0x100000) k = 'small';
        else k = 'unres';
      }
      h.set(k, (h.get(k) ?? 0) + 1); n++;
    }
    const top = [...h.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([k, c]) => `${k}:${(100 * c / n).toFixed(0)}%`).join(' ');
    lines.push(`  +0x${(4 * f).toString(16).padStart(2, '0')}  ${top}`);
  }
  return lines;
}
