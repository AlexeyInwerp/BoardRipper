/**
 * 11-worked-examples.ts — the byte-level examples quoted in
 * docs/formats/ALLEGRO_V15_FORMAT.md ▸ "Copper, outline and layers", each with
 * the chain of records that names its net / layer, so the review can re-derive
 * every quoted number.
 *
 *   1. line segment at 0x8fb224 (v17 twin: 0x15 key 0x37980, GPU_SPI_CS_N_R, TOP)
 *      → its parent [0x14] track → [0x10] net assignment → [0x6c] net → string
 *   2. via at 0x45ca34 (v17 twin: 0x33 key 0x1b35e, V_GPUCORE) → [0x10] → [0x6c];
 *      its padstack [0x70]
 *   3. the board outline: [0x50] class 1 / 0xFD at 0xa982c8, its first line and
 *      first arc (v17 twins: 0x15 key 0x89e02 and 0x01 key 0x89e03 under the
 *      0x28 shape 0x89e01 on class 1 / 0xEA)
 *   4. the ETCH layer list [0xa8] at 0xddb460
 *
 * Run: cd src/frontend && npx vite-node ../../scripts/allegro-v15-copper-probe/11-worked-examples.ts
 */
import { loadV15, buildIndex, hex, dump, u32, i32 } from './lib';

const buf = loadV15();
const ix = buildIndex(buf);
const SEGT = new Set([0x54, 0x58, 0x5c, 0x04]);
const show = (title: string, off: number, len: number) => { console.log(`\n${title} — file offset ${hex(off)}`); console.log(dump(buf, off, len, off)); };

// 1. segment → track → net
const SEG = 0x8fb224;
show('[0x54] line segment', SEG, 0x28);
const trackKey = u32(buf, SEG + 0x0c);
const track = ix.rec(trackKey, 0x14);
show(`[0x14] track, key ${hex(trackKey)} (segment's +0x0C), class/sub ${buf[track + 2]}/${buf[track + 3]}`, track, 0x30);
const na = ix.rec(u32(buf, track + 0x0c), 0x10);
show(`[0x10] net assignment, key ${hex(u32(buf, track + 0x0c))} (track's +0x0C)`, na, 0x14);
const net = ix.rec(u32(buf, na + 0x0c), 0x6c);
show(`[0x6c] net, key ${hex(u32(buf, na + 0x0c))} (assignment's +0x0C)`, net, 0x34);
console.log(`string id ${hex(u32(buf, net + 0x0c))} → "${ix.strings.get(u32(buf, net + 0x0c))}"`);
// the track's whole chain
{
  let k = u32(buf, track + 0x24); const pts: string[] = []; const seen = new Set<number>();
  while (k && k !== trackKey && !seen.has(k)) { seen.add(k); const r = ix.recOfTypes(k, SEGT)!; pts.push(`[${r.b1.toString(16)}]@${hex(r.off)} (${i32(buf, r.off + 0x18)},${i32(buf, r.off + 0x1c)})→(${i32(buf, r.off + 0x20)},${i32(buf, r.off + 0x24)}) w=${u32(buf, r.off + 0x10)}`); k = u32(buf, r.off + 8); }
  console.log(`track chain from +0x24, following +0x08 until the track key returns (${pts.length} segments):\n  ${pts.join('\n  ')}\n  → ${k === trackKey ? 'track key (ring closed)' : hex(k)}`);
  const s = ix.recAnyType(u32(buf, track + 0x14)), e = ix.recAnyType(u32(buf, track + 0x1c));
  console.log(`track +0x14 → [${s?.b1.toString(16)}] (object at the chain start), +0x1C → [${e?.b1.toString(16)}] (object at the chain end)`);
}

// 2. via
const VIA = 0x45ca34;
show('[0xcc] via', VIA, 0x44);
const vna = ix.rec(u32(buf, VIA + 0x0c), 0x10);
const vnet = ix.rec(u32(buf, vna + 0x0c), 0x6c);
console.log(`+0x0C → [0x10] at ${hex(vna)} → +0x0C → [0x6c] at ${hex(vnet)} → "${ix.strings.get(u32(buf, vnet + 0x0c))}"`);
const ps = ix.rec(u32(buf, VIA + 0x20), 0x70);
console.log(`+0x20 → [0x70] padstack at ${hex(ps)} → +0x0C string "${ix.strings.get(u32(buf, ps + 0x0c))}", drill (+0x10) ${u32(buf, ps + 0x10)}, first pad entry shape/w/h (+0x54/+0x58/+0x5C) ${u32(buf, ps + 0x54)}/${u32(buf, ps + 0x58)}/${u32(buf, ps + 0x5c)}`);
const conn = ix.recAnyType(u32(buf, VIA + 0x1c));
console.log(`+0x1C → [${conn?.b1.toString(16)}]  (+0x08 → [${ix.recAnyType(u32(buf, VIA + 8))?.b1.toString(16)}] next member of the net ring)`);

// 3. outline
const OUT = 0xa982c8;
show('[0x50] graphics container, class 1 (BOARD_GEOMETRY) / subclass 0xFD — the board outline', OUT, 0x1c);
{
  const key = u32(buf, OUT + 4);
  let k = u32(buf, OUT + 0x10); let i = 0; const seen = new Set<number>();
  while (k && k !== key && !seen.has(k) && i < 16) {
    seen.add(k); const r = ix.recOfTypes(k, SEGT)!;
    if (i < 2) show(`outline primitive ${i} [${r.b1.toString(16)}]`, r.off, r.b1 === 0x04 ? 0x44 : 0x28);
    k = u32(buf, r.off + 8); i++;
  }
  console.log(`${i} primitives, chain ${k === key ? 'closed on the container key' : 'ended at ' + hex(k)}`);
}
console.log(`owner +0x0C = ${hex(u32(buf, OUT + 0x0c))} (${ix.recAnyType(u32(buf, OUT + 0x0c)) ? 'in index' : 'not a key the index knows — outside every pool window'})`);

// 4. layer list
show('[0xa8] ETCH layer list (header 00 a8 04 00, 4 × {32-byte name, u32 props}, then the key 0x09154680)', 0xddb460, 0x9c);
console.log(`header layer map at 0x470: slot 6 = (a=${u32(buf, 0x470 + 6 * 8)}, ptr=${hex(u32(buf, 0x470 + 6 * 8 + 4))})`);
