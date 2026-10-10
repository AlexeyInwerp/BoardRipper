/**
 * 04-dumps.ts — byte-level looks at the records 03-record-shapes.ts sized:
 *   1. layer names: every inline "BOTTOM" in the v15 file, the [0xa8] record
 *      the header layer map points at, and the header map itself (which
 *      starts at 0x470 in v15, not 0x428 as in v16/v17)
 *   2. three consecutive [0x14] tracks with what follows them (are the
 *      segments interleaved?)
 *   3. a run of [0xcc] vias (stride 68?)
 *   4. a run of [0xa0] shapes (stride 132?), the parent shape of the board
 *      outline, and a census of [0xa0] class 1 / 4 / 0x15 subclasses
 *
 * Run: cd src/frontend && npx vite-node ../../scripts/allegro-v15-copper-probe/04-dumps.ts
 */
import { loadV15, loadOracle, buildIndex, hex, dump, histogram, u32, i32, findAll, pairPattern } from './lib';

const buf = loadV15();
const ix = buildIndex(buf);
const oracle = loadOracle();

// ── 1. layer names ──
console.log('== 1. layer names ==');
const hits = findAll(buf, Buffer.from('BOTTOM\0', 'latin1'), 50);
console.log('"BOTTOM\\0" at:', hits.map(h => hex(h)).join(' '));
for (const h of hits) {
  const txt = buf.toString('latin1', Math.max(0, h - 0x120), h + 0x60).replace(/[^\x20-\x7e]/g, '.');
  console.log(`  ${hex(h)}: ${txt.replace(/\.{2,}/g, m => `<${m.length}>`)}`);
}
console.log('\nraw header 0x460..0x540 as (a, ptr) pairs — v15 layer map:');
for (let o = 0x460; o < 0x540; o += 8) console.log(`  ${hex(o, 4)}  a=${u32(buf, o).toString().padStart(3)} ptr=${hex(u32(buf, o + 4))}`);
const a8 = ix.ofType.get(0xa8) ?? [];
console.log(`\n[0xa8] candidates: ${a8.length}`);
for (const o of a8.slice(0, 6)) {
  console.log(`--- [0xa8] at ${hex(o)} key ${hex(u32(buf, o + 4))}`);
  console.log(dump(buf, o, 0x60, o));
}
// The most-referenced map pointer 0x09154680 is nowhere in the file except the header:
for (const k of [0x09154680, 0x08fe0578, 0x08ecaa10, 0x0916ec7c, 0x08b24844, 0x08821f50]) {
  const p = Buffer.alloc(4); p.writeUInt32LE(k, 0);
  const at = findAll(buf, p, 20).filter(x => x > 0x600);
  console.log(`  key ${hex(k)} outside header at: ${at.map(x => hex(x)).join(' ') || '(nowhere)'}  — offset by LL addend would be ${hex(k - ix.globalAddend)}`);
}

// ── 2. tracks ──
console.log('\n== 2. [0x14] tracks — three consecutive records and what follows ==');
const t14 = (ix.ofType.get(0x14) ?? []).filter(o => buf[o + 2] === 6).sort((a, b) => a - b);
for (const o of [t14[100], t14[5000], t14[12000]]) {
  console.log(`--- track at ${hex(o)} class/sub ${buf[o + 2]}/${buf[o + 3]}`);
  console.log(dump(buf, o, 0xa0, o));
}
// Which field of the track holds its first segment? Check: for each track, does +0x24 point to a segment whose +0x0C (parent) == track key?
let firstSegOk = 0, firstSegBad = 0, noSeg = 0;
const segTypes = new Set([0x54, 0x58, 0x5c, 0x04]);
for (const o of t14) {
  const key = u32(buf, o + 4);
  const p = u32(buf, o + 0x24);
  if (p === 0) { noSeg++; continue; }
  const r = ix.recAnyType(p);
  if (r && segTypes.has(r.b1) && u32(buf, r.off + 0x0c) === key) firstSegOk++; else firstSegBad++;
}
console.log(`track +0x24 → segment whose parent is the track: ok=${firstSegOk} bad=${firstSegBad} zero=${noSeg} (of ${t14.length} ETCH tracks)`);
// Net: +0x0C → [0x10] → +0x0C → [0x6c] → string
let netOk = 0, netNone = 0;
const sampleNets: string[] = [];
for (const o of t14) {
  const o10 = ix.rec(u32(buf, o + 0x0c), 0x10);
  if (o10 < 0) { netNone++; continue; }
  const o6c = ix.rec(u32(buf, o10 + 0x0c), 0x6c);
  const name = o6c >= 0 ? ix.strings.get(u32(buf, o6c + 0x0c)) : undefined;
  if (name) { netOk++; if (sampleNets.length < 8) sampleNets.push(name); } else netNone++;
}
console.log(`track +0x0C → [0x10] → +0x0C → [0x6c] → name: ok=${netOk} none=${netNone}; e.g. ${sampleNets.join(', ')}`);

// ── 3. vias ──
console.log('\n== 3. [0xcc] vias — a run ==');
const vcc = (ix.ofType.get(0xcc) ?? []).filter(o => buf[o + 2] === 0x12).sort((a, b) => a - b);
console.log(dump(buf, vcc[2000], 68 * 3, vcc[2000]));
let viaNetOk = 0, viaNetNone = 0;
for (const o of vcc) {
  const o10 = ix.rec(u32(buf, o + 0x0c), 0x10);
  const o6c = o10 >= 0 ? ix.rec(u32(buf, o10 + 0x0c), 0x6c) : -1;
  if (o6c >= 0 && ix.strings.get(u32(buf, o6c + 0x0c))) viaNetOk++; else viaNetNone++;
}
console.log(`via +0x0C → [0x10] → net: ok=${viaNetOk} none=${viaNetNone} (of ${vcc.length})`);
console.log('via +0x1C target types:', [...histogram(vcc.map(o => ix.recAnyType(u32(buf, o + 0x1c))?.b1.toString(16) ?? 'unres'))].slice(0, 6));
console.log('via header byte 3 histogram:', [...histogram(vcc.map(o => buf[o + 3].toString(16)))]);

// ── 4. shapes ──
console.log('\n== 4. [0xa0] shapes ==');
const sa0 = (ix.ofType.get(0xa0) ?? []).sort((a, b) => a - b);
console.log(dump(buf, sa0[3000], 132 * 2, sa0[3000]));
console.log('class-1 subclasses:', [...histogram(sa0.filter(o => buf[o + 2] === 1).map(o => buf[o + 3].toString(16)))]);
console.log('class-4 subclasses:', [...histogram(sa0.filter(o => buf[o + 2] === 4).map(o => buf[o + 3].toString(16)))]);
console.log('class-0x15 subclasses:', [...histogram(sa0.filter(o => buf[o + 2] === 0x15).map(o => buf[o + 3].toString(16)))]);
console.log('class-6 subclasses:', [...histogram(sa0.filter(o => buf[o + 2] === 6).map(o => buf[o + 3].toString(16)))]);
console.log('all classes:', [...histogram(sa0.map(o => buf[o + 2].toString(16)))]);

// the outline's parent: find the v15 line record for the first oracle outline primitive whose parent is a shape
const o0 = oracle.outline.segs.find((s: any) => s.type !== 1);
for (const h of findAll(buf, pairPattern(o0.x1, o0.y1), 40)) {
  const recOff = h - 0x18;
  if (!(buf[recOff] === 0 && [0x54, 0x58, 0x5c].includes(buf[recOff + 1]))) continue;
  if (i32(buf, h + 8) !== o0.x2 || i32(buf, h + 12) !== o0.y2) continue;
  const parent = u32(buf, recOff + 0x0c);
  const p = ix.recAnyType(parent);
  console.log(`outline line at ${hex(recOff)} parent ${hex(parent)} → ${p ? `[${p.b1.toString(16)}] at ${hex(p.off)} class/sub ${buf[p.off + 2].toString(16)}/${buf[p.off + 3].toString(16)}` : 'unresolved'}`);
  if (p) console.log(dump(buf, p.off, 0x50, p.off));
}
