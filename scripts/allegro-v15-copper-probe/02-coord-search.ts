/**
 * 02-coord-search.ts — where do the v17 oracle coordinates live in the v15 bytes?
 *
 * For a sample of oracle trace segments, vias and outline vertices, search the
 * v15 file for the (x, y) i32 pair at ANY byte alignment, trying the scale
 * factors 1, 10, 100, 1000 (v17 raw / scale) plus float32 / float64 of the
 * mil value. Reports hit rates per scale (found once / several / never) and,
 * for the winning scale, the byte distance from each hit back to the nearest
 * `00 XX YY ZZ` header and the structure around it.
 *
 * Run: cd src/frontend && npx vite-node ../../scripts/allegro-v15-copper-probe/02-coord-search.ts
 */
import { AllegroStream } from '../../src/frontend/src/parsers/allegro/allegro-stream';
import { parseHeader } from '../../src/frontend/src/parsers/allegro/allegro-header';
import { loadOracle, loadV15, findAll, pairPattern, distinctive, hex, dump, histogram, u32, i32 } from './lib';

const v15 = loadV15();
const ab = v15.buffer.slice(v15.byteOffset, v15.byteOffset + v15.byteLength);
const hdr = parseHeader(new AllegroStream(ab));
console.log(`v15 header: magic ${hex(hdr.magic)} div ${hdr.unitsDivisor} ver ${hdr.allegroVersion.trim()} objects ${hdr.objectCount}`);
const oracle = loadOracle();
console.log(`v17 div ${oracle.header.div}; oracle: ${oracle.segments.length} segments, ${oracle.vias.length} vias, outline ${oracle.outline.n} primitives`);

const N = Number(process.env.N ?? 300);
const segs = distinctive(oracle.segments, N);
const vias = distinctive(oracle.vias, N);
const outlinePts = oracle.outline.segs.map((s: any) => ({ x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2 }));

type Kind = 'seg' | 'via' | 'outline';
function scaleSearch(kind: Kind, rows: { x1?: number; y1?: number; x?: number; y?: number }[]) {
  for (const scale of [1, 10, 100, 1000]) {
    let once = 0, several = 0, never = 0, nonInt = 0;
    for (const r of rows) {
      const x = r.x1 ?? r.x!, y = r.y1 ?? r.y!;
      if (x % scale !== 0 || y % scale !== 0) { nonInt++; continue; }
      const hits = findAll(v15, pairPattern(x / scale, y / scale), 50);
      if (hits.length === 0) never++; else if (hits.length === 1) once++; else several++;
    }
    console.log(`  ${kind.padEnd(8)} scale /${String(scale).padEnd(5)} once=${once} several=${several} never=${never} nonIntegral=${nonInt} (of ${rows.length})`);
  }
  // float32 / float64 of the mil value
  let f32 = 0, f64 = 0;
  for (const r of rows) {
    const x = (r.x1 ?? r.x!) / oracle.header.div, y = (r.y1 ?? r.y!) / oracle.header.div;
    const b4 = Buffer.alloc(8); b4.writeFloatLE(x, 0); b4.writeFloatLE(y, 4);
    const b8 = Buffer.alloc(16); b8.writeDoubleLE(x, 0); b8.writeDoubleLE(y, 8);
    if (findAll(v15, b4, 1).length) f32++;
    if (findAll(v15, b8, 1).length) f64++;
  }
  console.log(`  ${kind.padEnd(8)} float32 pair hits=${f32}  float64 pair hits=${f64}`);
}

console.log('\n== hit rates per scale ==');
scaleSearch('seg', segs);
scaleSearch('via', vias);
scaleSearch('outline', outlinePts);

// ── Structure around segment hits at the winning scale (expected: 100, v15 raw = mils×100) ──
const SCALE = Number(process.env.SCALE ?? (oracle.header.div / 100));
console.log(`\n== segment hit structure at scale /${SCALE} ==`);
const alignHist = new Map<number, number>();
const consecutiveHist = new Map<string, number>();
const backHeaderHist = new Map<number, number>();
const headerBytesHist = new Map<string, number>();
const examples: { seg: any; off: number }[] = [];
for (const s of segs) {
  if (s.x1 % SCALE || s.y1 % SCALE || s.x2 % SCALE || s.y2 % SCALE) continue;
  const hits = findAll(v15, pairPattern(s.x1 / SCALE, s.y1 / SCALE), 50);
  for (const h of hits) {
    alignHist.set(h % 4, (alignHist.get(h % 4) ?? 0) + 1);
    // Is the second endpoint right after?
    const x2 = i32(v15, h + 8), y2 = i32(v15, h + 12);
    const key = x2 === s.x2 / SCALE && y2 === s.y2 / SCALE ? 'x1y1x2y2' :
      (i32(v15, h - 8) === s.x2 / SCALE && i32(v15, h - 4) === s.y2 / SCALE ? 'x2y2x1y1' : 'other');
    consecutiveHist.set(key, (consecutiveHist.get(key) ?? 0) + 1);
    if (key === 'other') continue;
    // Nearest header-shaped word going back (4-aligned): 00 XX YY ZZ with XX != 0
    let back = -1;
    for (let d = 4; d <= 128; d += 4) {
      const o = h - d;
      if (o < 0) break;
      if (v15[o] === 0 && v15[o + 1] !== 0 && v15[o + 2] !== 0xff) { back = d; break; }
    }
    backHeaderHist.set(back, (backHeaderHist.get(back) ?? 0) + 1);
    if (back > 0) {
      const o = h - back;
      headerBytesHist.set(`${v15[o + 1].toString(16)}`, (headerBytesHist.get(`${v15[o + 1].toString(16)}`) ?? 0) + 1);
    }
    if (examples.length < 6) examples.push({ seg: s, off: h });
  }
}
console.log('alignment (hit offset mod 4):', [...alignHist]);
console.log('endpoint order:', [...consecutiveHist]);
console.log('distance back to nearest 00 XX header (bytes):', [...backHeaderHist].sort((a, b) => b[1] - a[1]).slice(0, 8));
console.log('header type byte at that header:', [...headerBytesHist].sort((a, b) => b[1] - a[1]).slice(0, 8));

for (const { seg, off } of examples) {
  console.log(`\n-- oracle seg key=${hex(seg.key)} type=0x${seg.type.toString(16)} sub=${seg.sub} net=${seg.net} w=${seg.w} (${seg.x1},${seg.y1})→(${seg.x2},${seg.y2})  v15 x1 at ${hex(off)}`);
  console.log(dump(v15, off - 48, 96, off - 48));
}

// ── via hits ──
console.log(`\n== via hit structure at scale /${SCALE} ==`);
const viaBack = new Map<number, number>();
const viaHdr = new Map<string, number>();
const viaEx: { via: any; off: number }[] = [];
for (const v of vias) {
  if (v.x % SCALE || v.y % SCALE) continue;
  const hits = findAll(v15, pairPattern(v.x / SCALE, v.y / SCALE), 50);
  for (const h of hits) {
    let back = -1;
    for (let d = 4; d <= 128; d += 4) {
      const o = h - d;
      if (o < 0) break;
      if (v15[o] === 0 && v15[o + 1] !== 0 && v15[o + 2] !== 0xff) { back = d; break; }
    }
    viaBack.set(back, (viaBack.get(back) ?? 0) + 1);
    if (back > 0) { const o = h - back; const k = v15[o + 1].toString(16); viaHdr.set(k, (viaHdr.get(k) ?? 0) + 1); }
    if (viaEx.length < 4) viaEx.push({ via: v, off: h });
  }
}
console.log('distance back to nearest header:', [...viaBack].sort((a, b) => b[1] - a[1]).slice(0, 8));
console.log('header type byte:', [...viaHdr].sort((a, b) => b[1] - a[1]).slice(0, 8));
for (const { via, off } of viaEx) {
  console.log(`\n-- oracle via key=${hex(via.key)} net=${via.net} (${via.x},${via.y}) padstack=${hex(via.padstack)}  v15 x at ${hex(off)}`);
  console.log(dump(v15, off - 64, 128, off - 64));
}

// ── outline hits ──
console.log(`\n== outline hit structure at scale /${SCALE} ==`);
for (const s of oracle.outline.segs.slice(0, 4)) {
  const hits = findAll(v15, pairPattern(s.x1 / SCALE, s.y1 / SCALE), 20);
  console.log(`outline prim type=${s.type} (${s.x1},${s.y1})→(${s.x2},${s.y2}) hits: ${hits.map(h => hex(h)).join(' ')}`);
  for (const h of hits.slice(0, 2)) console.log(dump(v15, h - 48, 96, h - 48));
}
