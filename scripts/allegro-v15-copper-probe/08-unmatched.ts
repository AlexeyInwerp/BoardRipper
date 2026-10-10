/**
 * 08-unmatched.ts — what are the segments the exact match in 06-coverage.ts
 * leaves over on each side?
 *
 * Re-derives the v15 segment list exactly as 06 does, pairs it with the oracle
 * by exact endpoints, then for every leftover oracle segment finds the nearest
 * leftover v15 segment on the same layer and net (endpoint distance, either
 * orientation) and histograms the distance. Also tests a tolerance-based
 * "piece of" relation, dumps a few pairs, and looks for the three v17 vias the
 * v15 [0xcc] walk did not produce.
 *
 * Run: cd src/frontend && npx vite-node ../../scripts/allegro-v15-copper-probe/08-unmatched.ts
 */
import { loadV15, loadOracle, buildIndex, hex, dump, histogram, u32, i32, findAll, pairPattern } from './lib';

const buf = loadV15();
const ix = buildIndex(buf);
const oracle = loadOracle();
const SEGT = new Set([0x54, 0x58, 0x5c, 0x04]);
const netName6c = (k: number) => { const o = ix.rec(k, 0x6c); return o < 0 ? '' : (ix.strings.get(u32(buf, o + 0x0c)) ?? ''); };
const netOf10 = (k: number) => { const o = ix.rec(k, 0x10); return o < 0 ? '' : (netName6c(u32(buf, o + 0x0c)) || netName6c(u32(buf, o + 0x08))); };

interface Seg { x1: number; y1: number; x2: number; y2: number; w: number; layer: number; net: string; off: number }
const v15: Seg[] = [];
for (const o of (ix.ofType.get(0x14) ?? []).filter(o => buf[o + 2] === 6)) {
  const key = u32(buf, o + 4); const net = netOf10(u32(buf, o + 0x0c)); const layer = buf[o + 3];
  let k = u32(buf, o + 0x24); const seen = new Set<number>();
  while (k !== 0 && k !== key && !seen.has(k)) {
    seen.add(k); const r = ix.recOfTypes(k, SEGT); if (!r) break; const s = r.off;
    v15.push({ x1: i32(buf, s + 0x18), y1: i32(buf, s + 0x1c), x2: i32(buf, s + 0x20), y2: i32(buf, s + 0x24), w: u32(buf, s + 0x10), layer, net, off: s });
    k = u32(buf, s + 8);
  }
}
const byCoords = new Map<string, any[]>();
for (const s of oracle.segments) { const k = `${s.x1},${s.y1},${s.x2},${s.y2}`; (byCoords.get(k) ?? byCoords.set(k, []).get(k)!).push(s); }
const used = new Set<any>(); const left15: Seg[] = [];
for (const s of v15) {
  const c = [...(byCoords.get(`${s.x1},${s.y1},${s.x2},${s.y2}`) ?? []), ...(byCoords.get(`${s.x2},${s.y2},${s.x1},${s.y1}`) ?? [])];
  const o = c.find(x => !used.has(x) && x.sub === s.layer) ?? c.find(x => !used.has(x));
  if (o) used.add(o); else left15.push(s);
}
const left17 = oracle.segments.filter(s => !used.has(s));
console.log(`exact: ${v15.length - left15.length} matched; leftover v15 ${left15.length}, oracle ${left17.length}`);

// nearest leftover v15 segment (same layer+net) for each leftover oracle segment
const dist = (a: Seg | any, b: Seg | any) => {
  const d1 = Math.hypot(a.x1 - b.x1, a.y1 - b.y1) + Math.hypot(a.x2 - b.x2, a.y2 - b.y2);
  const d2 = Math.hypot(a.x1 - b.x2, a.y1 - b.y2) + Math.hypot(a.x2 - b.x1, a.y2 - b.y1);
  return Math.min(d1, d2);
};
const pool = new Map<string, Seg[]>();
for (const s of left15) (pool.get(`${s.layer}|${s.net}`) ?? pool.set(`${s.layer}|${s.net}`, []).get(`${s.layer}|${s.net}`)!).push(s);
const bins = new Map<string, number>(); const examples: string[] = [];
const bin = (d: number) => d <= 2 ? '≤2 units' : d <= 10 ? '≤10' : d <= 100 ? '≤100 (0.01 mil)' : d <= 10000 ? '≤1 mil' : d <= 100000 ? '≤10 mil' : d === Infinity ? 'no same layer+net candidate' : '>10 mil';
let pairedWithin10 = 0; const usedNear = new Set<Seg>();
// piece-of with tolerance: oracle segment's endpoints both within 10 units of the v15 segment's line and inside its span
const onSegTol = (px: number, py: number, s: Seg, tol: number) => {
  const dx = s.x2 - s.x1, dy = s.y2 - s.y1, ex = px - s.x1, ey = py - s.y1; const len2 = dx * dx + dy * dy;
  if (!len2) return false;
  if (Math.abs(dx * ey - dy * ex) / Math.sqrt(len2) > tol) return false;
  const t = (ex * dx + ey * dy) / len2; return t >= -1e-4 && t <= 1 + 1e-4;
};
let pieces = 0; const hosts = new Set<Seg>();
for (const o of left17) {
  const c = pool.get(`${o.sub}|${o.net}`) ?? [];
  let best: Seg | null = null, bd = Infinity;
  for (const s of c) { const d = dist(o, s); if (d < bd) { bd = d; best = s; } }
  bins.set(bin(bd), (bins.get(bin(bd)) ?? 0) + 1);
  if (best && bd <= 10) { pairedWithin10++; usedNear.add(best); }
  if (best && bd > 10 && examples.length < 8) examples.push(`L${o.sub} ${o.net}: v17 (${o.x1},${o.y1})→(${o.x2},${o.y2}) w${o.w}  nearest v15 (${best.x1},${best.y1})→(${best.x2},${best.y2}) w${best.w} d=${bd.toFixed(0)}`);
  const host = c.find(s => onSegTol(o.x1, o.y1, s, 20) && onSegTol(o.x2, o.y2, s, 20));
  if (host) { pieces++; hosts.add(host); }
}
console.log('nearest-candidate distance bins (raw units, 10000 = 1 mil):', [...bins]);
console.log(`oracle leftovers within 10 units of a v15 leftover: ${pairedWithin10} (distinct v15 partners ${usedNear.size})`);
console.log(`oracle leftovers that are a piece (±20 units) of a v15 leftover: ${pieces}; hosts ${hosts.size}`);
console.log('examples with d > 10:'); for (const e of examples) console.log('  ' + e);
const rest15 = left15.filter(s => !usedNear.has(s) && !hosts.has(s));
console.log(`v15 leftovers neither near-paired nor hosting a piece: ${rest15.length}`, [...histogram(rest15.map(s => `L${s.layer}`))]);
for (const s of rest15.slice(0, 6)) console.log(`  (${s.x1},${s.y1})→(${s.x2},${s.y2}) w${s.w} L${s.layer} ${s.net} at ${hex(s.off)}`);
// are the rest15 coordinates present in the v17 file at all?
{
  const { readFileSync } = await import('node:fs');
  const v17buf = readFileSync('/Users/inwerp/Projects/BoardRipper/samples/incoming/uncategorized/Jasper_Kronos_v17.brd');
  let present = 0;
  for (const s of rest15.slice(0, 300)) if (findAll(v17buf, pairPattern(s.x1, s.y1), 1).length) present++;
  console.log(`  of the first 300 such v15 leftovers, ${present} have their start point somewhere in the v17 file`);
  // and the 45° ones: is the oracle's neighbour endpoint off by one unit?
  const odd = rest15.filter(s => (s.x1 % 10) !== 0 || (s.y1 % 10) !== 0).length;
  console.log(`  ${odd} of ${rest15.length} have a start point that is not a multiple of 10 raw units`);
}

// the oracle vias the v15 walk missed
console.log('\n== oracle vias not produced by the [0xcc] walk ==');
const v15via = new Set((ix.ofType.get(0xcc) ?? []).filter(o => buf[o + 2] === 0x12).map(o => `${i32(buf, o + 0x14)},${i32(buf, o + 0x18)}`));
for (const v of oracle.vias.filter(v => !v15via.has(`${v.x},${v.y}`))) {
  const hits = findAll(buf, pairPattern(v.x, v.y), 20);
  console.log(`(${v.x},${v.y}) net=${v.net} sub=0x${v.layer.subclass.toString(16)} padstack ${hex(v.padstack)} — v15 hits: ${hits.map(h => { let back = -1; for (let d = 4; d <= 64; d += 4) if (buf[h - d] === 0 && buf[h - d + 1] !== 0 && (buf[h - d + 1] & 3) === 0) { back = d; break; } return back > 0 ? `${hex(h)}[${buf[h - back + 1].toString(16)}@-${back}]` : hex(h); }).join(' ')}`);
}
