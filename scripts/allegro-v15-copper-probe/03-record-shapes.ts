/**
 * 03-record-shapes.ts — record layouts of the v15 copper/outline/layer types.
 *
 * Builds the candidate-header index over the v15 file (lib.buildIndex) and,
 * for each record type that 02-coord-search.ts found around oracle
 * coordinates, prints: record stride (from the distance between consecutive
 * headers of that type), the histogram of header bytes 2/3 (class/subclass),
 * and a per-field histogram of what each u32 resolves to (record type of the
 * pointee, zero, small integer). Also dumps the header layer map and the
 * [0xa8] layer-list record it points at.
 *
 * Types (v15 byte 1 = v16 block type × 4):
 *   0x54/0x58/0x5c = 0x15/0x16/0x17 line segments   0x04 = 0x01 arc
 *   0x14 = 0x05 track (etch container)              0xcc = 0x33 via
 *   0xa0 = 0x28 shape/polygon                       0x10 = 0x04 net assignment
 *   0xa8 = 0x2A layer list                          0x70 = 0x1C padstack
 *
 * Run: cd src/frontend && npx vite-node ../../scripts/allegro-v15-copper-probe/03-record-shapes.ts
 */
import { loadV15, buildIndex, fieldTypeHistogram, hex, dump, histogram, u32, i32 } from './lib';

const buf = loadV15();
const ix = buildIndex(buf);
console.log(`v15: strings ${ix.strings.size}, string table ends ${hex(ix.stringTableEnd)}, globalAddend ${hex(ix.globalAddend)}, ${ix.index.size} keys indexed`);

// ── census ──
console.log('\n== candidate headers per type byte (b1 → v16 type = b1>>2) ==');
const census = [...ix.ofType.entries()].sort((a, b) => b[1].length - a[1].length);
console.log(census.map(([t, offs]) => `${t.toString(16)}(=0x${(t >> 2).toString(16)}):${offs.length}`).join('  '));

function stride(offs: number[]): Map<number, number> {
  const s = offs.slice().sort((a, b) => a - b);
  const h = new Map<number, number>();
  for (let i = 1; i < s.length; i++) { const d = s[i] - s[i - 1]; if (d <= 512) h.set(d, (h.get(d) ?? 0) + 1); }
  return new Map([...h.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6));
}
function headerBytes(offs: number[]): string {
  const h = histogram(offs.map(o => `${buf[o + 2].toString(16).padStart(2, '0')}/${buf[o + 3].toString(16).padStart(2, '0')}`));
  return [...h.entries()].slice(0, 12).map(([k, n]) => `${k}:${n}`).join(' ');
}
function describe(name: string, b1: number, nFields: number) {
  const offs = ix.ofType.get(b1) ?? [];
  console.log(`\n== [${b1.toString(16)}] ${name}: ${offs.length} candidates ==`);
  console.log('  stride histogram (consecutive header distance):', [...stride(offs)].map(([d, n]) => `${d}:${n}`).join(' '));
  console.log('  header bytes 2/3 (class/subclass):', headerBytes(offs));
  console.log(fieldTypeHistogram(buf, ix, offs, nFields).join('\n'));
  return offs;
}

const segOffs = [...describe('line segment 0x54 (=0x15)', 0x54, 9), ...describe('line segment 0x58 (=0x16)', 0x58, 9), ...describe('line segment 0x5c (=0x17)', 0x5c, 9)];
describe('arc 0x04 (=0x01)', 0x04, 16);
describe('track 0x14 (=0x05)', 0x14, 14);
describe('via 0xcc (=0x33)', 0xcc, 15);
describe('shape 0xa0 (=0x28)', 0xa0, 16);
describe('net assignment 0x10 (=0x04)', 0x10, 7);
describe('padstack 0x70 (=0x1C)', 0x70, 12);

// ── segment parents ──
console.log('\n== segment +0x0C parent: type byte and parent header class/subclass ==');
const parentTypes = new Map<string, number>();
for (const o of segOffs) {
  const p = ix.recAnyType(u32(buf, o + 0x0c));
  const k = p ? `${p.b1.toString(16)} cls=${buf[p.off + 2].toString(16)} sub=${buf[p.off + 3].toString(16)}` : 'unres';
  parentTypes.set(k, (parentTypes.get(k) ?? 0) + 1);
}
console.log([...parentTypes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k, n]) => `  ${k}: ${n}`).join('\n'));

console.log('\n== arc +0x0C parent ==');
const arcParents = new Map<string, number>();
for (const o of ix.ofType.get(0x04) ?? []) {
  const p = ix.recAnyType(u32(buf, o + 0x0c));
  const k = p ? `${p.b1.toString(16)} cls=${buf[p.off + 2].toString(16)} sub=${buf[p.off + 3].toString(16)}` : 'unres';
  arcParents.set(k, (arcParents.get(k) ?? 0) + 1);
}
console.log([...arcParents.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([k, n]) => `  ${k}: ${n}`).join('\n'));

// ── layer map ──
console.log('\n== header layer map (25 × {a, ptr}) ==');
console.log(ix.hdr.layerMap.map((e, i) => `[${i}] a=${e.a} ptr=${hex(e.layerList0x2A)}`).join('\n'));
const slot6 = ix.hdr.layerMap[6];
for (const [i, e] of ix.hdr.layerMap.entries()) {
  if (e.layerList0x2A === 0) continue;
  const r = ix.recAnyType(e.layerList0x2A);
  console.log(`slot ${i} (a=${e.a}) ptr ${hex(e.layerList0x2A)} → ${r ? `candidate type ${r.b1.toString(16)} at ${hex(r.off)}` : 'unresolved in index'}`);
}
// Search for the slot-6 key anywhere in the file (it may not be at +4 of a header — v16 0x2A puts the key AFTER the entries).
const keyPat = Buffer.alloc(4); keyPat.writeUInt32LE(slot6.layerList0x2A, 0);
let from = 0; const keyHits: number[] = [];
while (keyHits.length < 10) { const i = buf.indexOf(keyPat, from); if (i < 0) break; keyHits.push(i); from = i + 1; }
console.log(`slot 6 key ${hex(slot6.layerList0x2A)} occurs at: ${keyHits.map(h => hex(h)).join(' ')}`);
for (const h of keyHits.slice(0, 3)) {
  console.log(`--- around ${hex(h)}:`);
  console.log(dump(buf, Math.max(0, h - 0xc0), 0x120, h - 0xc0));
  // any ASCII runs nearby?
  const txt = buf.toString('latin1', Math.max(0, h - 0x200), h + 0x40).replace(/[^\x20-\x7e]/g, '.');
  console.log('  ascii:', txt.replace(/\.{3,}/g, '…'));
}
