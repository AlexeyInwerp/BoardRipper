/**
 * 09-oracle-only.ts — where do the v17 segments come from that no v15 ETCH
 * track chain produces (exactly or within 10 raw units)?
 *
 * For each such oracle segment, find every v15 record whose coordinate block
 * (+0x18..+0x24) equals it in either orientation, and report the record type
 * and its parent's type / class / subclass. The hypothesis under test: they are
 * the segments under class-6 [0x50] graphics containers (footprint-level
 * copper), which the re-save promoted to 0x05 tracks.
 *
 * Run: cd src/frontend && npx vite-node ../../scripts/allegro-v15-copper-probe/09-oracle-only.ts
 */
import { loadV15, loadOracle, buildIndex, hex, dump, histogram, u32, i32, findAll, pairPattern } from './lib';

const buf = loadV15();
const ix = buildIndex(buf);
const oracle = loadOracle();
const SEGT = new Set([0x54, 0x58, 0x5c, 0x04]);
const netName6c = (k: number) => { const o = ix.rec(k, 0x6c); return o < 0 ? '' : (ix.strings.get(u32(buf, o + 0x0c)) ?? ''); };
const netOf10 = (k: number) => { const o = ix.rec(k, 0x10); return o < 0 ? '' : (netName6c(u32(buf, o + 0x0c)) || netName6c(u32(buf, o + 0x08))); };

// v15 track segments (as in 06/08) → exact + near match, leaving the oracle-only set
interface Seg { x1: number; y1: number; x2: number; y2: number; layer: number; net: string }
const v15: Seg[] = [];
for (const o of (ix.ofType.get(0x14) ?? []).filter(o => buf[o + 2] === 6)) {
  const key = u32(buf, o + 4); const net = netOf10(u32(buf, o + 0x0c)); const layer = buf[o + 3];
  let k = u32(buf, o + 0x24); const seen = new Set<number>();
  while (k !== 0 && k !== key && !seen.has(k)) {
    seen.add(k); const r = ix.recOfTypes(k, SEGT); if (!r) break; const s = r.off;
    v15.push({ x1: i32(buf, s + 0x18), y1: i32(buf, s + 0x1c), x2: i32(buf, s + 0x20), y2: i32(buf, s + 0x24), layer, net });
    k = u32(buf, s + 8);
  }
}
const q = (x: number, y: number) => `${Math.round(x / 20)},${Math.round(y / 20)}`; // 20-unit cells for the near match
const cells = new Map<string, Seg[]>();
for (const s of v15) for (const k of [`${s.layer}|${s.net}|${q(s.x1, s.y1)}|${q(s.x2, s.y2)}`, `${s.layer}|${s.net}|${q(s.x2, s.y2)}|${q(s.x1, s.y1)}`]) (cells.get(k) ?? cells.set(k, []).get(k)!).push(s);
const near = (o: any) => {
  for (const dx1 of [-1, 0, 1]) for (const dy1 of [-1, 0, 1]) for (const dx2 of [-1, 0, 1]) for (const dy2 of [-1, 0, 1]) {
    const k = `${o.sub}|${o.net}|${Math.round(o.x1 / 20) + dx1},${Math.round(o.y1 / 20) + dy1}|${Math.round(o.x2 / 20) + dx2},${Math.round(o.y2 / 20) + dy2}`;
    for (const s of cells.get(k) ?? []) {
      const d = Math.min(Math.hypot(s.x1 - o.x1, s.y1 - o.y1) + Math.hypot(s.x2 - o.x2, s.y2 - o.y2), Math.hypot(s.x1 - o.x2, s.y1 - o.y2) + Math.hypot(s.x2 - o.x1, s.y2 - o.y1));
      if (d <= 10) return true;
    }
  }
  return false;
};
const only = oracle.segments.filter((o: any) => !near(o));
console.log(`oracle segments with no v15 track segment within 10 units (same layer+net): ${only.length} of ${oracle.segments.length}`);
console.log('by layer:', [...histogram(only.map((o: any) => o.sub))], 'by net (top 6):', [...histogram(only.map((o: any) => o.net))].slice(0, 6));

// provenance: any v15 record with these coords at +0x18
const prov = new Map<string, number>();
const examples: string[] = [];
let none = 0;
for (const o of only) {
  const hits = [...findAll(buf, Buffer.concat([pairPattern(o.x1, o.y1), pairPattern(o.x2, o.y2)]), 10), ...findAll(buf, Buffer.concat([pairPattern(o.x2, o.y2), pairPattern(o.x1, o.y1)]), 10)];
  const recs = hits.map(h => h - 0x18).filter(r => r >= 0 && buf[r] === 0 && SEGT.has(buf[r + 1]));
  if (!recs.length) { none++; prov.set('no segment record', (prov.get('no segment record') ?? 0) + 1); continue; }
  const tags = new Set<string>();
  for (const r of recs) {
    const p = ix.recAnyType(u32(buf, r + 0x0c));
    tags.add(p ? `[${p.b1.toString(16)}] ${buf[p.off + 2].toString(16)}/${buf[p.off + 3].toString(16)}` : 'parent unresolved');
  }
  const tag = [...tags].sort().join(' + ');
  prov.set(tag, (prov.get(tag) ?? 0) + 1);
  if (examples.length < 6 && !tag.includes('[14]')) examples.push(`L${o.sub} ${o.net} (${o.x1},${o.y1})→(${o.x2},${o.y2}) w${o.w}: ${tag} @ ${recs.map(r => hex(r)).join(',')}`);
}
console.log('parent of the v15 segment record(s) carrying the same coordinates:');
for (const [k, n] of [...prov].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`  ${String(n).padStart(5)}  ${k}`);
console.log('examples:'); for (const e of examples) console.log('  ' + e);
// one class-6 [0x50] container in full, with its owner
const c50 = (ix.ofType.get(0x50) ?? []).find(o => buf[o + 2] === 6);
if (c50 !== undefined) {
  console.log(`\na class-6 [0x50] container at ${hex(c50)}:`); console.log(dump(buf, c50, 0x1c, c50));
  const owner = ix.recAnyType(u32(buf, c50 + 0x0c));
  console.log(`  owner +0x0C → ${owner ? `[${owner.b1.toString(16)}] at ${hex(owner.off)}` : 'unresolved ' + hex(u32(buf, c50 + 0x0c))}`);
  console.log('  class-6 [0x50] owners by type:', [...histogram((ix.ofType.get(0x50) ?? []).filter(o => buf[o + 2] === 6).map(o => ix.recAnyType(u32(buf, o + 0x0c))?.b1.toString(16) ?? 'unres'))]);
}
