/**
 * 06-coverage.ts — walk the proposed v15 record chains and score them
 * against the v17 oracle.
 *
 *   traces:  every [0x14] track on class 6 (ETCH): layer = header byte 3,
 *            net = +0x0C → [0x10] → +0x0C (or +0x08) → [0x6c] → string,
 *            segments = +0x24 → chain of [0x54/0x58/0x5c/0x04] via +0x08,
 *            terminated by the track's own key.
 *   vias:    every [0xcc] on class 0x12: x/y at +0x14/+0x18, net as above,
 *            padstack +0x20 → [0x70].
 *   outline: the [0x50] on class 1 / subclass 0xFD (see 05-outline-layers.ts).
 *   layers:  slot 6 of the header map at 0x470 → [0xa8] inline names.
 *
 * Every v15 segment is matched to an oracle segment by exact endpoints (either
 * direction); width, layer, net and segment type are compared on the match.
 * Unmatched records on either side are counted and sampled.
 *
 * Run: cd src/frontend && npx vite-node ../../scripts/allegro-v15-copper-probe/06-coverage.ts
 */
import { loadV15, loadOracle, buildIndex, hex, dump, histogram, u32, i32, findAll } from './lib';

const buf = loadV15();
const ix = buildIndex(buf);
const oracle = loadOracle();
const SEGT = new Set([0x54, 0x58, 0x5c, 0x04]);

// ── nets ──
const netName6c = (k: number): string => {
  const o = ix.rec(k, 0x6c);
  if (o < 0) return '';
  return ix.strings.get(u32(buf, o + 0x0c)) ?? '';
};
const netOf10 = (k: number): string => {
  const o = ix.rec(k, 0x10);
  if (o < 0) return '';
  return netName6c(u32(buf, o + 0x0c)) || netName6c(u32(buf, o + 0x08));
};
/** Net of a connectivity member ([0x14] track / [0xcc] via / [0xc8] pad): +0x0C → [0x10] directly,
 *  else walk the member ring via +0x08 until a [0x10] turns up. Returns [name, route]. */
const memberNet = (off: number): [string, string] => {
  const direct = netOf10(u32(buf, off + 0x0c));
  if (direct) return [direct, 'direct'];
  let k = u32(buf, off + 8); const seen = new Set<number>();
  for (let i = 0; i < 20000 && k !== 0 && !seen.has(k); i++) {
    seen.add(k);
    const n = netOf10(k);
    if (n) return [n, `ring(${i + 1})`];
    const r = ix.recAnyType(k);
    if (!r || !(r.b1 === 0x14 || r.b1 === 0xcc || r.b1 === 0xc8 || r.b1 === 0xb8)) return ['', `ring-dead(${r?.b1.toString(16) ?? 'unres'})`];
    k = u32(buf, r.off + 8);
  }
  return ['', 'ring-none'];
};

// ── traces ──
interface Seg { t: number; x1: number; y1: number; x2: number; y2: number; w: number; layer: number; net: string; off: number; track: number }
const v15segs: Seg[] = [];
const tracks = (ix.ofType.get(0x14) ?? []).filter(o => buf[o + 2] === 6);
const routeHist = new Map<string, number>();
const brokenAt = new Map<string, number>();
let emptyTracks = 0, brokenChains = 0;
const trackNet = new Map<number, string>();
for (const o of tracks) {
  const key = u32(buf, o + 4);
  const [net, route] = memberNet(o);
  routeHist.set(route.replace(/\(\d+\)/, ''), (routeHist.get(route.replace(/\(\d+\)/, '')) ?? 0) + 1);
  trackNet.set(o, net);
  const layer = buf[o + 3];
  let k = u32(buf, o + 0x24); const seen = new Set<number>(); let n = 0;
  while (k !== 0 && k !== key && !seen.has(k)) {
    seen.add(k);
    const r = ix.recOfTypes(k, SEGT);
    if (!r) {
      brokenChains++;
      const any = ix.recAnyType(k);
      brokenAt.set(any ? any.b1.toString(16) : 'unres', (brokenAt.get(any ? any.b1.toString(16) : 'unres') ?? 0) + 1);
      break;
    }
    const s = r.off;
    v15segs.push({ t: r.b1, x1: i32(buf, s + 0x18), y1: i32(buf, s + 0x1c), x2: i32(buf, s + 0x20), y2: i32(buf, s + 0x24), w: u32(buf, s + 0x10), layer, net, off: s, track: o });
    n++;
    k = u32(buf, s + 8);
  }
  if (n === 0) emptyTracks++;
}
console.log(`== traces ==\nv15 ETCH tracks: ${tracks.length} (empty ${emptyTracks}, broken chains ${brokenChains} — broke at type: ${[...brokenAt].map(([k, n]) => `${k}:${n}`).join(' ')}); segments walked: ${v15segs.length}; oracle segments: ${oracle.segments.length}`);
console.log('track net route:', [...routeHist]);
console.log('track header byte 0 (flag):', [...histogram(tracks.map(o => buf[o].toString(16)))], ' byte 3 (ETCH subclass = layer):', [...histogram(tracks.map(o => buf[o + 3]))].sort((a, b) => a[0] - b[0]));
console.log('v15 segments per layer:', [...histogram(v15segs.map(s => s.layer))].sort((a, b) => a[0] - b[0]));
console.log('oracle segments per layer:', [...histogram(oracle.segments.map(s => s.sub))].sort((a, b) => a[0] - b[0]));
console.log('v15 segment types:', [...histogram(v15segs.map(s => s.t.toString(16)))]);

// match
const TYPE15TO17: Record<number, number> = { 0x54: 0x15, 0x58: 0x16, 0x5c: 0x17, 0x04: 0x01 };
const byCoords = new Map<string, any[]>();
for (const s of oracle.segments) {
  const k = `${s.x1},${s.y1},${s.x2},${s.y2}`;
  (byCoords.get(k) ?? byCoords.set(k, []).get(k)!).push(s);
}
const used = new Set<any>();
let matched = 0, wOk = 0, layerOk = 0, netOk = 0, typeOk = 0, netMissingV15 = 0;
const netMismatch: string[] = [];
const layerMismatch = new Map<string, number>();
const unmatched: Seg[] = [];
for (const s of v15segs) {
  const cands = [...(byCoords.get(`${s.x1},${s.y1},${s.x2},${s.y2}`) ?? []), ...(byCoords.get(`${s.x2},${s.y2},${s.x1},${s.y1}`) ?? [])];
  // Prefer the candidate on the same layer: a segment drawn identically on TOP and
  // BOTTOM (16 such pairs on Kronos) is otherwise paired crosswise by a greedy match.
  const o = cands.find(c => !used.has(c) && c.sub === s.layer) ?? cands.find(c => !used.has(c));
  if (!o) { unmatched.push(s); continue; }
  used.add(o); matched++;
  if (o.w === s.w) wOk++;
  if (o.sub === s.layer) layerOk++; else layerMismatch.set(`v15 ${s.layer} → v17 ${o.sub}`, (layerMismatch.get(`v15 ${s.layer} → v17 ${o.sub}`) ?? 0) + 1);
  if (TYPE15TO17[s.t] === o.type) typeOk++;
  if (!s.net) netMissingV15++;
  else if (o.net === s.net) netOk++;
  else if (netMismatch.length < 10) netMismatch.push(`${s.net} vs ${o.net} @(${s.x1},${s.y1})`);
}
const oracleUnmatched = oracle.segments.filter(s => !used.has(s));
console.log(`\nmatched by endpoints: ${matched} / ${v15segs.length} v15 segments (${(100 * matched / v15segs.length).toFixed(2)}%); of the oracle's ${oracle.segments.length}: ${(100 * matched / oracle.segments.length).toFixed(2)}%`);
console.log(`  width equal: ${wOk}   layer equal: ${layerOk}   type equal: ${typeOk}   net equal: ${netOk}   v15 net missing: ${netMissingV15}   net mismatch: ${matched - netOk - netMissingV15}`);
console.log('  layer mismatches:', [...layerMismatch]);
console.log('  net mismatch samples:', netMismatch);
console.log(`  v15 unmatched: ${unmatched.length}; oracle unmatched: ${oracleUnmatched.length}`);
console.log('  v15 unmatched by layer:', [...histogram(unmatched.map(s => s.layer))], 'zero-length:', unmatched.filter(s => s.x1 === s.x2 && s.y1 === s.y2).length);
console.log('  oracle unmatched by layer:', [...histogram(oracleUnmatched.map(s => s.sub))]);
for (const s of unmatched.slice(0, 5)) console.log(`   v15 unmatched: [${s.t.toString(16)}] (${s.x1},${s.y1})→(${s.x2},${s.y2}) w=${s.w} L${s.layer} net=${s.net} at ${hex(s.off)}`);
for (const s of oracleUnmatched.slice(0, 5)) console.log(`   oracle unmatched: [${s.type.toString(16)}] (${s.x1},${s.y1})→(${s.x2},${s.y2}) w=${s.w} L${s.sub} net=${s.net}`);
// Subdivision test: is an unmatched oracle segment a collinear piece of an
// unmatched v15 segment on the same layer and net (the re-save split it), and
// is an unmatched v15 segment covered end-to-end by such pieces?
const onSeg = (px: number, py: number, s: { x1: number; y1: number; x2: number; y2: number }) => {
  const dx = s.x2 - s.x1, dy = s.y2 - s.y1, ex = px - s.x1, ey = py - s.y1;
  const cross = dx * ey - dy * ex; const len2 = dx * dx + dy * dy;
  if (len2 === 0) return px === s.x1 && py === s.y1;
  if (Math.abs(cross) / Math.sqrt(len2) > 2) return false; // > 2 raw units (0.0002 mil) off the line
  const t = (ex * dx + ey * dy) / len2;
  return t >= -1e-6 && t <= 1 + 1e-6;
};
const v15ByLayerNet = new Map<string, Seg[]>();
for (const s of unmatched) (v15ByLayerNet.get(`${s.layer}|${s.net}`) ?? v15ByLayerNet.set(`${s.layer}|${s.net}`, []).get(`${s.layer}|${s.net}`)!).push(s);
let pieceOfV15 = 0; const coveredV15 = new Set<Seg>(); let sameLayerNetOnly = 0;
for (const o of oracleUnmatched) {
  const pool = v15ByLayerNet.get(`${o.sub}|${o.net}`) ?? [];
  const host = pool.find(s => onSeg(o.x1, o.y1, s) && onSeg(o.x2, o.y2, s));
  if (host) { pieceOfV15++; coveredV15.add(host); } else if (pool.length) sameLayerNetOnly++;
}
console.log(`  oracle-unmatched that are collinear pieces of an unmatched v15 segment (same layer+net): ${pieceOfV15} / ${oracleUnmatched.length}; v15-unmatched segments hosting such pieces: ${coveredV15.size} / ${unmatched.length}; oracle-unmatched with same layer+net v15 candidates but not collinear: ${sameLayerNetOnly}`);
// the v15-unmatched not explained by subdivision: sample + are their coords present in the v17 file?
const rest = unmatched.filter(s => !coveredV15.has(s));
console.log(`  v15-unmatched not hosting a piece: ${rest.length}; by layer:`, [...histogram(rest.map(s => s.layer))], 'by width:', [...histogram(rest.map(s => s.w))].slice(0, 5));
for (const s of rest.slice(0, 6)) console.log(`   [${s.t.toString(16)}] (${s.x1},${s.y1})→(${s.x2},${s.y2}) w=${s.w} L${s.layer} net=${s.net} at ${hex(s.off)} track ${hex(s.track)}`);
// v15 segments never reached by a track chain: how many segment records with a class-6 [0x14] parent are there in total?
const reached = new Set(v15segs.map(s => s.off));
let orphan = 0; const orphanParents = new Map<string, number>();
for (const t of [0x54, 0x58, 0x5c]) for (const o of ix.ofType.get(t) ?? []) {
  if (reached.has(o)) continue;
  const p = ix.recAnyType(u32(buf, o + 0x0c));
  if (p && p.b1 === 0x14 && buf[p.off + 2] === 6) { orphan++; orphanParents.set(`L${buf[p.off + 3]}`, (orphanParents.get(`L${buf[p.off + 3]}`) ?? 0) + 1); }
}
console.log(`  segment records whose parent is an ETCH track but that no chain reached: ${orphan}`, [...orphanParents]);
// tracks without a net: what does +0x0C point at?
const noNetTracks = tracks.filter(o => !trackNet.get(o));
console.log(`\ntracks without net: ${noNetTracks.length}; their +0x0C resolves to:`, [...histogram(noNetTracks.map(o => { const r = ix.recAnyType(u32(buf, o + 0x0c)); return r ? r.b1.toString(16) : (u32(buf, o + 0x0c) === 0 ? 'zero' : 'unres'); }))].slice(0, 8));
if (noNetTracks.length) { const o = noNetTracks[0]; console.log(`sample no-net track at ${hex(o)}:`); console.log(dump(buf, o, 0x30, o)); const t = ix.recAnyType(u32(buf, o + 0x0c)); if (t) { console.log(`  +0x0C target at ${hex(t.off)}:`); console.log(dump(buf, t.off, 0x30, t.off)); } }

// ── vias ──
console.log('\n== vias ==');
const vias = (ix.ofType.get(0xcc) ?? []).filter(o => buf[o + 2] === 0x12);
const viaByXY = new Map<string, any[]>();
for (const v of oracle.vias) (viaByXY.get(`${v.x},${v.y}`) ?? viaByXY.set(`${v.x},${v.y}`, []).get(`${v.x},${v.y}`)!).push(v);
const usedV = new Set<any>();
let vMatched = 0, vNetOk = 0, vNetMissing = 0, vNetBad = 0, vBothEmpty = 0; const vRoute = new Map<string, number>();
const vUnmatched: number[] = [];
const padstackNames = new Map<string, number>();
for (const o of vias) {
  const x = i32(buf, o + 0x14), y = i32(buf, o + 0x18);
  const [net, route] = memberNet(o);
  vRoute.set(route.replace(/\(\d+\)/, ''), (vRoute.get(route.replace(/\(\d+\)/, '')) ?? 0) + 1);
  const ps = ix.rec(u32(buf, o + 0x20), 0x70);
  const psName = ps >= 0 ? (ix.strings.get(u32(buf, ps + 0x0c)) ?? `?${hex(u32(buf, ps + 0x0c))}`) : 'no-padstack';
  padstackNames.set(psName, (padstackNames.get(psName) ?? 0) + 1);
  const c = (viaByXY.get(`${x},${y}`) ?? []).find(v => !usedV.has(v));
  if (!c) { vUnmatched.push(o); continue; }
  usedV.add(c); vMatched++;
  if (net === c.net) { vNetOk++; if (!net) vBothEmpty++; } else if (!net) vNetMissing++; else vNetBad++;
}
console.log(`v15 vias: ${vias.length}; oracle: ${oracle.vias.length}; matched by centre: ${vMatched}; net equal ${vNetOk} (of which both empty ${vBothEmpty}), v15 net missing where oracle has one ${vNetMissing}, net mismatch ${vNetBad}`);
console.log('via net route:', [...vRoute]);
console.log('padstack (+0x20 → [0x70] → +0x0C string):', [...padstackNames].slice(0, 8));
console.log(`v15 unmatched vias: ${vUnmatched.length}; oracle unmatched: ${oracle.vias.filter(v => !usedV.has(v)).length}`);
for (const o of vUnmatched.slice(0, 3)) { console.log(`  v15 via at ${hex(o)} (${i32(buf, o + 0x14)},${i32(buf, o + 0x18)}) header ${buf.subarray(o, o + 4).toString('hex')}`); }
console.log('oracle unmatched samples:', oracle.vias.filter(v => !usedV.has(v)).slice(0, 3).map(v => `(${v.x},${v.y}) net=${v.net} layer=${v.layer.classCode}/${v.layer.subclass}`));
console.log('v15 via header byte 3 vs oracle via subclass:', [...histogram(vias.map(o => buf[o + 3].toString(16)))], [...histogram(oracle.vias.map(v => v.layer.subclass.toString(16)))]);

// ── layers ──
console.log('\n== layers ==');
const etchPtr = u32(buf, 0x470 + 6 * 8 + 4);
const p = Buffer.alloc(4); p.writeUInt32LE(etchPtr, 0);
const F = findAll(buf, p, 20).find(x => x > 0x600)!;
let o = F - 36; const names: string[] = [];
while (o > 0) { let i = 0; while (i < 32 && buf[o + i] >= 0x20 && buf[o + i] <= 0x7e) i++; if (i === 0) break; names.unshift(buf.toString('latin1', o, o + i)); o -= 36; }
console.log(`slot 6 → key ${hex(etchPtr)} at ${hex(F)}, header ${buf.subarray(o + 32, o + 36).toString('hex')} → [${names.join(', ')}]  (oracle: [${oracle.layers.join(', ')}])`);
