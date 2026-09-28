/**
 * 07-details.ts — the loose ends the coverage run leaves:
 *   1. addend drift (key − offset − LL addend) per record type: which heap
 *      pool each copper type lives in, and how far a single-addend resolver
 *      would be off
 *   2. [0x70] padstack (= v16 0x1C): two records dumped, the name string at
 *      +0x0C and where the drill / pad diameters sit (VIA-22R10 → 22 mil pad,
 *      10 mil drill = 220000 / 100000 raw)
 *   3. [0x10] net assignment: one record dumped, field roles
 *   4. [0x14] track fields +0x14 / +0x1C: are they the pad/via at the chain's
 *      first / last point?
 *   5. [0xa0] copper pours (class 6): count per layer and whether their
 *      segment chains walk (out of scope for traces, recorded for the review)
 *
 * Run: cd src/frontend && npx vite-node ../../scripts/allegro-v15-copper-probe/07-details.ts
 */
import { loadV15, loadOracle, buildIndex, hex, dump, histogram, u32, i32 } from './lib';

const buf = loadV15();
const ix = buildIndex(buf);
const oracle = loadOracle();
const SEGT = new Set([0x54, 0x58, 0x5c, 0x04]);

// ── 1. addend drift ──
console.log('== 1. key − offset − LL addend, per type ==');
for (const t of [0x18, 0xb4, 0xc8, 0x14, 0x54, 0x58, 0x5c, 0x04, 0xcc, 0x50, 0xa0, 0x10, 0x6c, 0x70, 0xd0, 0xa8]) {
  const offs = ix.ofType.get(t) ?? [];
  if (!offs.length) continue;
  const d = offs.map(o => u32(buf, o + 4) - o - ix.globalAddend);
  const h = histogram(d.map(x => Math.round(x / 0x1000) * 0x1000));
  const top = [...h].slice(0, 4).map(([k, n]) => `${k >= 0 ? '+' : '-'}${hex(Math.abs(k), 6)}:${n}`).join(' ');
  let mn = Infinity, mx = -Infinity; for (const x of d) { if (x < mn) mn = x; if (x > mx) mx = x; }
  console.log(`  [${t.toString(16).padStart(2, '0')}] n=${String(offs.length).padStart(6)} min=${mn < 0 ? '-' : '+'}${hex(Math.abs(mn), 6)} max=+${hex(mx, 6)}  modes(4K bins): ${top}`);
}

// ── 2. padstacks ──
console.log('\n== 2. [0x70] padstacks ==');
const ps = (ix.ofType.get(0x70) ?? []).filter(o => buf[o + 2] === 0 && buf[o + 3] === 0);
console.log(`candidates with 00/00 header: ${ps.length}; names:`, ps.map(o => ix.strings.get(u32(buf, o + 0x0c)) ?? '?').slice(0, 40).join(', '));
const via22 = ps.find(o => ix.strings.get(u32(buf, o + 0x0c)) === 'VIA-22R10');
if (via22 !== undefined) {
  console.log(`VIA-22R10 at ${hex(via22)}:`);
  console.log(dump(buf, via22, 0x120, via22));
  // where do 100000 (10 mil) and 220000 (22 mil) appear inside the next 0x200 bytes?
  const finds: string[] = [];
  for (let o = via22; o < via22 + 0x200; o += 4) { const v = i32(buf, o); if (v === 100000 || v === 220000 || v === 110000 || v === 50000) finds.push(`+0x${(o - via22).toString(16)}=${v}`); }
  console.log('  10/22-mil values at:', finds.join(' '));
}
const tp = ps.find(o => ix.strings.get(u32(buf, o + 0x0c)) === 'TP-32R-BOT-OSP');
if (tp !== undefined) { console.log(`TP-32R-BOT-OSP at ${hex(tp)}:`); console.log(dump(buf, tp, 0x80, tp)); }

// ── 3. net assignment ──
console.log('\n== 3. [0x10] net assignment ==');
const na = (ix.ofType.get(0x10) ?? []);
for (const o of na.slice(100, 102)) {
  console.log(dump(buf, o, 0x20, o));
  const net = ix.rec(u32(buf, o + 0x0c), 0x6c);
  console.log(`  +0x08 → ${ix.recAnyType(u32(buf, o + 8))?.b1.toString(16)}  +0x0C → [6c] ${net >= 0 ? ix.strings.get(u32(buf, net + 0x0c)) : '?'}  +0x10 → ${ix.recAnyType(u32(buf, o + 0x10))?.b1.toString(16)}  +0x14 = ${u32(buf, o + 0x14)}`);
}
// [0x6c] net record: name at +0x0C; what else? one dump
const n6c = ix.ofType.get(0x6c)![5];
console.log(`[0x6c] net at ${hex(n6c)} name=${ix.strings.get(u32(buf, n6c + 0x0c))}:`);
console.log(dump(buf, n6c, 0x40, n6c));

// ── 4. track connection fields ──
console.log('\n== 4. [0x14] +0x14 / +0x1C against the chain endpoints ==');
const tracks = (ix.ofType.get(0x14) ?? []).filter(o => buf[o + 2] === 6);
const stats = { f14: new Map<string, number>(), f1c: new Map<string, number>() };
const viaXY = (k: number): [number, number] | null => { const o = ix.rec(k, 0xcc); return o >= 0 ? [i32(buf, o + 0x14), i32(buf, o + 0x18)] : null; };
const padCentre = (k: number): [number, number] | null => { const o = ix.rec(k, 0xc8); if (o < 0) return null; return [(i32(buf, o + 0x38) + i32(buf, o + 0x40)) / 2, (i32(buf, o + 0x3c) + i32(buf, o + 0x44)) / 2]; };
for (const o of tracks) {
  const key = u32(buf, o + 4);
  // chain endpoints
  let k = u32(buf, o + 0x24); const pts: [number, number][] = []; const seen = new Set<number>();
  while (k !== 0 && k !== key && !seen.has(k)) { seen.add(k); const r = ix.recOfTypes(k, SEGT); if (!r) break; pts.push([i32(buf, r.off + 0x18), i32(buf, r.off + 0x1c)]); pts.push([i32(buf, r.off + 0x20), i32(buf, r.off + 0x24)]); k = u32(buf, r.off + 8); }
  if (!pts.length) continue;
  const first = pts[0], last = pts[pts.length - 1];
  for (const [fo, m] of [[0x14, stats.f14], [0x1c, stats.f1c]] as const) {
    const v = u32(buf, o + fo);
    const r = ix.recAnyType(v);
    let tag = r ? r.b1.toString(16) : (v === 0 ? 'zero' : 'unres');
    const xy = r?.b1 === 0xcc ? viaXY(v) : r?.b1 === 0xc8 ? padCentre(v) : null;
    if (xy) {
      const near = (p: [number, number]) => Math.hypot(p[0] - xy[0], p[1] - xy[1]) <= 5000; // within 0.5 mil
      tag += near(first) ? ' @first' : near(last) ? ' @last' : ' @neither';
    }
    m.set(tag, (m.get(tag) ?? 0) + 1);
  }
}
console.log('  +0x14:', [...stats.f14].sort((a, b) => b[1] - a[1]).slice(0, 8));
console.log('  +0x1C:', [...stats.f1c].sort((a, b) => b[1] - a[1]).slice(0, 8));
// full dump of one track with a via at +0x14, plus its first segment
const ex = tracks.find(o => ix.recAnyType(u32(buf, o + 0x14))?.b1 === 0xcc && ix.recAnyType(u32(buf, o + 0x1c))?.b1 === 0xcc);
if (ex !== undefined) {
  const net = ix.rec(u32(buf, ex + 0x0c), 0x10);
  console.log(`\ntrack at ${hex(ex)} class 6 layer ${buf[ex + 3]}, net via [0x10] at ${hex(net)}:`);
  console.log(dump(buf, ex, 0x30, ex));
  const s = ix.recOfTypes(u32(buf, ex + 0x24), SEGT)!;
  console.log(`first segment [${s.b1.toString(16)}] at ${hex(s.off)}:`);
  console.log(dump(buf, s.off, 0x28, s.off));
  const v = ix.rec(u32(buf, ex + 0x14), 0xcc);
  console.log(`+0x14 via at ${hex(v)}: (${i32(buf, v + 0x14)},${i32(buf, v + 0x18)})`);
  console.log(dump(buf, v, 0x44, v));
}

// ── 5. copper pours ──
console.log('\n== 5. [0xa0] shapes on class 6 (ETCH) ==');
const pours = (ix.ofType.get(0xa0) ?? []).filter(o => buf[o + 2] === 6);
let walked = 0, prims = 0, withNet = 0, tableTypes = new Map<string, number>();
for (const o of pours) {
  const key = u32(buf, o + 4);
  let k = u32(buf, o + 0x1c); const seen = new Set<number>(); let n = 0;
  while (k !== 0 && k !== key && !seen.has(k)) { seen.add(k); const r = ix.recOfTypes(k, SEGT); if (!r) break; n++; k = u32(buf, r.off + 8); }
  if (n) { walked++; prims += n; }
  const t = ix.recAnyType(u32(buf, o + 0x2c));
  tableTypes.set(t ? t.b1.toString(16) : 'zero/unres', (tableTypes.get(t ? t.b1.toString(16) : 'zero/unres') ?? 0) + 1);
  // net: +0x2C → [0xb0] table → ? try +0x08 of the table → [0x10]/[0x6c]
  if (t && t.b1 === 0xb0) {
    for (const fo of [0x08, 0x0c, 0x10, 0x14]) { const x = u32(buf, t.off + fo); if (ix.rec(x, 0x6c) >= 0 || ix.rec(x, 0x10) >= 0) { withNet++; break; } }
  }
}
console.log(`pours: ${pours.length} by layer`, [...histogram(pours.map(o => buf[o + 3]))].sort((a, b) => a[0] - b[0]), `; chains walked ${walked}, ${prims} primitives; +0x2C target types`, [...tableTypes], `; tables with a net/netassign key in +0x08..+0x14: ${withNet}. (v17: ${oracle.outlineCands.filter((c: any) => false).length || 366} surfaces)`);
const p0 = pours[0];
console.log(`pour at ${hex(p0)}:`); console.log(dump(buf, p0, 0x40, p0));
const tb = ix.recAnyType(u32(buf, p0 + 0x2c));
if (tb) { console.log(`its +0x2C → [${tb.b1.toString(16)}] at ${hex(tb.off)}:`); console.log(dump(buf, tb.off, 0x30, tb.off)); }
