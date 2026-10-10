/**
 * 05-outline-layers.ts — the layer lists behind the header map, and the board
 * outline.
 *
 * A. For every non-zero pointer in the v15 header layer map (which starts at
 *    0x470, 25 × {a, ptr}), find the [0xa8] (= v16 0x2A) layer list it names.
 *    In v15 the record's key is stored AFTER its entries (as in v16) and the
 *    entries are inline 36-byte NUL-padded names (KiCad's pre-V165 layout),
 *    so the pointer is located by searching for the key value and walking
 *    back in 36-byte steps. Prints each list next to the v17 list at the same
 *    slot index (v17 stores string-table ids).
 * B. Board outline: every [0x50] (0x14 graphics container) and [0xa0] (0x28
 *    shape) on class 1 (BOARD_GEOMETRY), 4 (DRAWING_FORMAT) or 0x15
 *    (BOUNDARY); walk its segment chain (+0x08 = next, terminates on the
 *    container's own key), score by bbox area, and count primitives that
 *    match the v17 outline exactly.
 *
 * Run: cd src/frontend && npx vite-node ../../scripts/allegro-v15-copper-probe/05-outline-layers.ts
 */
import { readFileSync } from 'node:fs';
import { AllegroDb } from '../../src/frontend/src/parsers/allegro/allegro-db';
import type { Blk0x2ALayerList } from '../../src/frontend/src/parsers/allegro/allegro-types';
import { loadV15, loadOracle, buildIndex, hex, dump, histogram, u32, i32, findAll, V17 } from './lib';

const buf = loadV15();
const ix = buildIndex(buf);
const oracle = loadOracle();

// ── A. layer lists ──
console.log('== A. v15 header layer map at 0x470 and the [0xa8] lists ==');
const v17buf = readFileSync(V17);
const db17 = new AllegroDb(v17buf.buffer.slice(v17buf.byteOffset, v17buf.byteOffset + v17buf.byteLength));
const v17names = (slot: number): string[] => {
  const e = db17.header.layerMap[slot];
  if (!e || !e.layerList0x2A) return [];
  const ll = db17.getBlockAs<Blk0x2ALayerList>(e.layerList0x2A, 0x2A);
  return ll?.refEntries?.map(r => db17.getString(r.layerNameId)) ?? [];
};
const MAP15 = 0x470;
// A v15 [0xa8] entry is a 32-byte NUL-padded name followed by a u32 of
// properties (the ETCH list reads TOP=0x00088001 GND=0x00000103 VCC=0x00000103
// BOTTOM=0x00108002); the record header `00 a8 NN 00` carries the entry count
// in byte 2, and the key follows the last entry.
// The 32-byte name buffer is NUL-terminated but NOT NUL-padded: the bytes after
// the terminator are whatever the writer had in memory ("TOP LAYER TEXT\0" is
// followed by `y..aIt.` in the BOARD_GEOMETRY list), so only the run up to the
// first NUL is checked.
const isName = (o: number) => {
  let i = 0;
  while (i < 32 && buf[o + i] >= 0x20 && buf[o + i] <= 0x7e) i++;
  return i > 0 && i < 32 && buf[o + i] === 0;
};
const nameAt = (o: number) => { let i = 0; while (i < 32 && buf[o + i] !== 0) i++; return buf.toString('latin1', o, o + i); };
const seenLists = new Map<number, string[]>();
for (let slot = 0; slot < 25; slot++) {
  const a = u32(buf, MAP15 + slot * 8), p = u32(buf, MAP15 + slot * 8 + 4);
  const n17 = v17names(slot);
  const e17 = db17.header.layerMap[slot];
  if (p === 0) { console.log(`slot ${slot}: a=${a} ptr=0  | v17 a=${e17?.a} names=[${n17.join(',')}]`); continue; }
  let names = seenLists.get(p);
  let where = '';
  if (!names) {
    const pat = Buffer.alloc(4); pat.writeUInt32LE(p, 0);
    const F = findAll(buf, pat, 20).find(x => x > 0x600);
    if (F === undefined) { console.log(`slot ${slot}: a=${a} ptr=${hex(p)} — key not found in file`); continue; }
    // walk back in 36-byte entries (32-byte name + u32 props)
    let o = F - 36; const list: string[] = [];
    while (o > 0 && isName(o) && list.length < 64) {
      list.unshift(`${nameAt(o)}(${hex(u32(buf, o + 32))})`); o -= 36;
    }
    const hdrOff = o + 36 - 4;
    names = list; seenLists.set(p, names);
    where = `key at ${hex(F)}, header at ${hex(hdrOff)}: ${buf.subarray(hdrOff, hdrOff + 4).toString('hex').replace(/(..)/g, '$1 ')} (byte 2 = count ${buf[hdrOff + 2]})`;
  }
  console.log(`slot ${slot}: a=${a} ptr=${hex(p)} names(${names.length})=[${names.join(',')}]  ${where}\n         | v17 slot ${slot}: a=${e17?.a} names(${n17.length})=[${n17.join(',')}]`);
}
// the ETCH list in full, with the bytes around it
const etchPtr = u32(buf, MAP15 + 6 * 8 + 4);
const pat = Buffer.alloc(4); pat.writeUInt32LE(etchPtr, 0);
const F = findAll(buf, pat, 20).find(x => x > 0x600)!;
console.log(`\nETCH list (slot 6 ptr ${hex(etchPtr)}): key at ${hex(F)}; dump from ${hex(F - 4 * 36 - 16)}:`);
console.log(dump(buf, F - 4 * 36 - 16, 4 * 36 + 16 + 32, F - 4 * 36 - 16));

// ── B. outline ──
console.log('\n== B. outline candidates ==');
const SEG = new Set([0x54, 0x58, 0x5c, 0x04]);
interface Prim { t: number; x1: number; y1: number; x2: number; y2: number; w: number; cx?: number; cy?: number; r?: number; sub?: number }
function walkChain(containerKey: number, first: number): Prim[] {
  const out: Prim[] = [];
  let k = first; const seen = new Set<number>();
  while (k !== 0 && k !== containerKey && !seen.has(k) && out.length < 100000) {
    seen.add(k);
    const r = ix.recAnyType(k);
    if (!r || !SEG.has(r.b1)) break;
    const o = r.off;
    const p: Prim = { t: r.b1, x1: i32(buf, o + 0x18), y1: i32(buf, o + 0x1c), x2: i32(buf, o + 0x20), y2: i32(buf, o + 0x24), w: u32(buf, o + 0x10) };
    if (r.b1 === 0x04) { p.cx = i32(buf, o + 0x28); p.cy = i32(buf, o + 0x2c); p.r = i32(buf, o + 0x30); p.sub = buf[o + 3]; }
    out.push(p);
    k = u32(buf, o + 8);
  }
  return out;
}
const oracleKeys = new Set(oracle.outline.segs.map((s: any) => `${s.x1},${s.y1},${s.x2},${s.y2}`));
const cands: any[] = [];
for (const [b1, firstOff] of [[0x50, 0x10], [0xa0, 0x1c]] as const) {
  for (const o of ix.ofType.get(b1) ?? []) {
    const cls = buf[o + 2], sub = buf[o + 3];
    if (!(cls === 1 || cls === 4 || cls === 0x15)) continue;
    const key = u32(buf, o + 4);
    const prims = walkChain(key, u32(buf, o + firstOff));
    if (prims.length === 0) continue;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of prims) for (const [x, y] of [[p.x1, p.y1], [p.x2, p.y2]]) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    const matches = prims.filter(p => oracleKeys.has(`${p.x1},${p.y1},${p.x2},${p.y2}`) || oracleKeys.has(`${p.x2},${p.y2},${p.x1},${p.y1}`)).length;
    cands.push({ b1, off: o, key, cls, sub, n: prims.length, area: (maxX - minX) * (maxY - minY), bbox: [minX, minY, maxX, maxY], matches, prims });
  }
}
cands.sort((a, b) => b.area - a.area);
console.log(`candidates: ${cands.length}; top 12 by bbox area (oracle outline: ${oracle.outline.n} primitives, bbox ${oracle.outline.bbox})`);
for (const c of cands.slice(0, 12)) {
  console.log(`  [${c.b1.toString(16)}] at ${hex(c.off)} key ${hex(c.key)} class ${c.cls.toString(16)} sub 0x${c.sub.toString(16).padStart(2, '0')}  n=${c.n} matches=${c.matches} area=${c.area.toExponential(3)} bbox=[${c.bbox}]`);
}
console.log('\nclass/sub of all candidates with ≥ 8 oracle matches:', [...histogram(cands.filter(c => c.matches >= 8).map(c => `[${c.b1.toString(16)}] ${c.cls.toString(16)}/${c.sub.toString(16)} n=${c.n} m=${c.matches}`))]);
const best = cands.find(c => c.matches === oracle.outline.n && c.n === oracle.outline.n) ?? cands[0];
console.log(`\nbest full match: [${best.b1.toString(16)}] at ${hex(best.off)} class ${best.cls}/0x${best.sub.toString(16)}`);
console.log(dump(buf, best.off, 0x30, best.off));
console.log('its primitives vs oracle:');
for (const p of best.prims) {
  const k = `${p.x1},${p.y1},${p.x2},${p.y2}`;
  console.log(`  [${p.t.toString(16)}] (${p.x1},${p.y1})→(${p.x2},${p.y2}) w=${p.w}${p.t === 0x04 ? ` c=(${p.cx},${p.cy}) r=${p.r} sub=0x${p.sub!.toString(16)}` : ''}  ${oracleKeys.has(k) ? 'oracle ✓' : '✗'}`);
}
// hex of one outline line and one outline arc
const line = best.prims.findIndex((p: Prim) => p.t !== 0x04), arc = best.prims.findIndex((p: Prim) => p.t === 0x04);
{
  let k = u32(buf, best.off + (best.b1 === 0x50 ? 0x10 : 0x1c)); let i = 0;
  while (k !== 0 && k !== best.key && i <= Math.max(line, arc)) {
    const r = ix.recAnyType(k)!;
    if (i === line || i === arc) { console.log(`\n${i === arc ? 'arc' : 'line'} record at ${hex(r.off)}:`); console.log(dump(buf, r.off, r.b1 === 0x04 ? 0x44 : 0x28, r.off)); }
    k = u32(buf, r.off + 8); i++;
  }
}
