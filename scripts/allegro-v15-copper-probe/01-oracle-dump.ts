/**
 * 01-oracle-dump.ts — dump the v17 re-save of Jasper_Kronos as an oracle.
 *
 * Reads the v17 file with the shipped v16+ parser (AllegroDb, raw blocks — NOT
 * the assembler, so coordinates stay in raw integer file units) and writes
 * `oracle.json` into $PROBE_OUT (default: scratchpad) with:
 *   - segments: every 0x15/0x16/0x17 line under an ETCH-class 0x05 track
 *               (raw i32 start/end, width, ETCH subclass, net name)
 *   - arcs:     every 0x01 arc under an ETCH track (raw i32 start/end, float center/radius)
 *   - vias:     every 0x33 (raw i32 x/y, net name, padstack key)
 *   - outline:  the segments of the 0x28 shape the assembler picks as board outline
 *   - layers:   the ETCH layer names (from layerMap[6] → 0x2A → string table)
 *   - header:   unitsDivisor, magic, version string
 *
 * Run: cd src/frontend && npx vite-node ../../scripts/allegro-v15-copper-probe/01-oracle-dump.ts
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { AllegroDb } from '../../src/frontend/src/parsers/allegro/allegro-db';
import { parseAllegroBRD } from '../../src/frontend/src/parsers/allegro/allegro-brd-parser';
import type {
  Blk0x05Track, Blk0x15_16_17Segment, Blk0x01Arc, Blk0x33Via, Blk0x28Shape,
  Blk0x04NetAssign, Blk0x1BNet, Blk0x2ALayerList,
} from '../../src/frontend/src/parsers/allegro/allegro-types';

const V17 = '/Users/inwerp/Projects/BoardRipper/samples/incoming/uncategorized/Jasper_Kronos_v17.brd';
const OUT = process.env.PROBE_OUT
  ?? '/private/tmp/claude-501/-Users-inwerp-Projects-BoardRipper/8b763fd4-4377-4f7c-aeb4-0119002b03b2/scratchpad';
mkdirSync(OUT, { recursive: true });

const buf = readFileSync(V17);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const db = new AllegroDb(ab);
console.log('v17 header: magic', db.header.magic.toString(16), 'div', db.header.unitsDivisor,
  'ver', db.header.allegroVersion.trim(), 'objects', db.header.objectCount);

// Net name resolution mirrors the assembler: 0x05.netAssignment → 0x04 → 0x1B → string.
const netNameOfAssign = (k: number): string => {
  const a = db.getBlock(k);
  if (!a) return '';
  if (a.blockType === 0x04) {
    const na = a as Blk0x04NetAssign;
    const n = db.getBlock(na.net);
    if (n && n.blockType === 0x1B) return db.getString((n as Blk0x1BNet).netName);
  }
  if (a.blockType === 0x1B) return db.getString((a as Blk0x1BNet).netName);
  return '';
};

const segments: any[] = [];
const arcs: any[] = [];
const trackLayers = new Map<number, number>();
for (const blk of db.blocks.values()) {
  if (blk.blockType !== 0x05) continue;
  const t = blk as Blk0x05Track;
  if (t.layer.classCode !== 0x06) continue;
  trackLayers.set(t.layer.subclass, (trackLayers.get(t.layer.subclass) ?? 0) + 1);
  const net = netNameOfAssign(t.netAssignment);
  let k = t.firstSegPtr;
  for (let i = 0; i < 1_000_000 && k !== 0; i++) {
    const s = db.getBlock(k);
    if (!s) break;
    if (s.blockType === 0x15 || s.blockType === 0x16 || s.blockType === 0x17) {
      const g = s as Blk0x15_16_17Segment;
      segments.push({ type: g.blockType, key: g.key, track: t.key, sub: t.layer.subclass, net, w: g.width,
        x1: g.startX, y1: g.startY, x2: g.endX, y2: g.endY, flags: g.flags });
      k = g.next;
    } else if (s.blockType === 0x01) {
      const a = s as Blk0x01Arc;
      arcs.push({ key: a.key, track: t.key, sub: t.layer.subclass, net, w: a.width,
        x1: a.startX, y1: a.startY, x2: a.endX, y2: a.endY, cx: a.centerX, cy: a.centerY, r: a.radius,
        subType: a.subType, bbox: a.bbox });
      k = a.next;
    } else break;
  }
}
console.log('ETCH tracks by subclass:', [...trackLayers.entries()].sort((a, b) => a[0] - b[0]));
console.log('segments', segments.length, 'arcs', arcs.length);

const vias: any[] = [];
for (const blk of db.blocks.values()) {
  if (blk.blockType !== 0x33) continue;
  const v = blk as Blk0x33Via;
  vias.push({ key: v.key, x: v.coordsX, y: v.coordsY, net: netNameOfAssign(v.netPtr), padstack: v.padstack,
    layer: v.layerInfo, bbox: v.bbox });
}
console.log('vias', vias.length);

// Outline: every 0x28 shape on BOUNDARY / BGEOM 0xEA / DFMT 0xFD, with its segments, ranked by bbox area.
const outlineCands: any[] = [];
for (const blk of db.blocks.values()) {
  if (blk.blockType !== 0x28) continue;
  const sh = blk as Blk0x28Shape;
  const cc = sh.layer.classCode, sc = sh.layer.subclass;
  const ok = cc === 0x15 || ((cc === 0x01 || cc === 0x04) && (sc === 0xEA || sc === 0xFD));
  if (!ok) continue;
  const segs: any[] = [];
  let k = sh.firstSegmentPtr;
  for (let i = 0; i < 100000 && k !== 0; i++) {
    const s = db.getBlock(k);
    if (!s) break;
    if (s.blockType === 0x15 || s.blockType === 0x16 || s.blockType === 0x17) {
      const g = s as Blk0x15_16_17Segment;
      segs.push({ type: g.blockType, key: g.key, w: g.width, x1: g.startX, y1: g.startY, x2: g.endX, y2: g.endY });
      k = g.next;
    } else if (s.blockType === 0x01) {
      const a = s as Blk0x01Arc;
      segs.push({ type: 1, key: a.key, w: a.width, x1: a.startX, y1: a.startY, x2: a.endX, y2: a.endY,
        cx: a.centerX, cy: a.centerY, r: a.radius, subType: a.subType });
      k = a.next;
    } else break;
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of segs) {
    for (const [x, y] of [[s.x1, s.y1], [s.x2, s.y2]]) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
  }
  outlineCands.push({ key: sh.key, type: sh.type, cc, sc, n: segs.length, area: (maxX - minX) * (maxY - minY),
    bbox: [minX, minY, maxX, maxY], coords: sh.coords, segs });
}
outlineCands.sort((a, b) => b.area - a.area);
console.log('outline candidates:', outlineCands.slice(0, 8).map(c =>
  `key=0x${c.key.toString(16)} cc=${c.cc} sc=0x${c.sc.toString(16)} n=${c.n} area=${c.area}`));

// Layer names via layerMap[6] (ETCH) → 0x2A
const layers: string[] = [];
const ent = db.header.layerMap[6];
const ll = ent ? db.getBlockAs<Blk0x2ALayerList>(ent.layerList0x2A, 0x2A) : undefined;
if (ll?.refEntries) for (const e of ll.refEntries) layers.push(db.getString(e.layerNameId));
console.log('layers', layers);
console.log('layerMap', db.header.layerMap.map(e => `${e.a}:0x${e.layerList0x2A.toString(16)}`).join(' '));

// Also the assembled board for cross-check.
const board = parseAllegroBRD(ab);
console.log('assembled: traces', board.traces?.length, 'vias', board.vias?.length,
  'outline', board.outline?.length, 'layerNames', board.layerNames);

writeFileSync(`${OUT}/oracle.json`, JSON.stringify({
  header: { magic: db.header.magic, div: db.header.unitsDivisor, version: db.header.allegroVersion.trim() },
  layers, segments, arcs, vias,
  outline: outlineCands[0],
  outlineCands: outlineCands.map(({ segs, ...rest }) => rest),
  assembledOutline: board.outline,
}));
console.log('wrote', `${OUT}/oracle.json`);
