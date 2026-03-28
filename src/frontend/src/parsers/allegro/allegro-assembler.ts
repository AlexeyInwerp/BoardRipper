/**
 * allegro-assembler.ts — Converts an AllegroDb into BoardData.
 *
 * Walks the resolved object database and string table to extract:
 *   - Components (parts) and their pins
 *   - Nets (via net assignment map)
 *   - Traces (ETCH-class track segments)
 *   - Vias
 *   - Board outline
 *   - Layer names
 *
 * Derived from KiCad 10's Allegro importer (GPL-3.0).
 * TypeScript implementation is original code for BoardRipper.
 */

import type { BoardData, Part, Pin, Point, Trace, Via } from '../types';
import { computeBBox, buildNets } from '../types';
import { AllegroDb } from './allegro-db';
import { FmtVer, LayerClass } from './allegro-types';
import type {
  Blk0x04NetAssign,
  Blk0x05Track,
  Blk0x07ComponentInst,
  Blk0x08PinNumber,
  Blk0x11PinName,
  Blk0x15_16_17Segment,
  Blk0x01Arc,
  Blk0x1BNet,
  Blk0x28Shape,
  Blk0x2ALayerList,
  Blk0x2BFootprintDef,
  Blk0x2DFootprintInst,
  Blk0x32PlacedPad,
  Blk0x33Via,
} from './allegro-types';
import { log } from '../../store/log-store';

const dbg = log.parser;

// ── Public entry point ────────────────────────────────────────────────────────

export function assembleBoard(db: AllegroDb): BoardData {
  const ver = db.header.fmtVer;
  const div = db.header.unitsDivisor || 1;

  // Build net assignment map first — needed by pins, traces, vias
  const netAssignMap = buildNetAssignMap(db);

  // Extract components + pins
  const { parts, allPinPositions } = extractComponents(db, ver, div, netAssignMap);

  // Extract traces
  const traces = extractTraces(db, ver, div, netAssignMap);

  // Extract vias
  const vias = extractVias(db, div, netAssignMap);

  // Extract board outline
  const outline = extractOutline(db, ver, div);

  // Extract layer names
  const layerNames = extractLayerNames(db);

  // Compute bounds from all geometry
  const allPoints: Point[] = [];
  for (const p of outline) allPoints.push(p);
  for (const part of parts) allPoints.push(part.origin);
  for (const p of allPinPositions) allPoints.push(p);
  const bounds = computeBBox(allPoints);

  dbg.log(
    `Assembled: ${parts.length} parts, ` +
    `${parts.reduce((n, p) => n + p.pins.length, 0)} pins, ` +
    `${traces.length} traces, ${vias.length} vias, ` +
    `${outline.length} outline pts, ${layerNames.length} layers`
  );

  return {
    format: 'ALLEGRO_BRD',
    outline,
    parts,
    nails: [],
    nets: buildNets(parts),
    bounds,
    traces: traces.length > 0 ? traces : undefined,
    vias: vias.length > 0 ? vias : undefined,
    layerNames: layerNames.length > 0 ? layerNames : undefined,
  };
}

// ── Net assignment map ────────────────────────────────────────────────────────

/**
 * Build a map from block key → net name string.
 * Sources: all 0x04 NET_ASSIGN blocks. Maps both the 0x04 key AND its
 * connItem to the net name (resolved via 0x1B NET → string table).
 */
function buildNetAssignMap(db: AllegroDb): Map<number, string> {
  const map = new Map<number, string>();

  for (const blk of db.blocks.values()) {
    if (blk.blockType !== 0x04) continue;
    const na = blk as Blk0x04NetAssign;

    // Resolve net name: na.net → 0x1B NET → netName → string table
    const netBlk = db.getBlockAs<Blk0x1BNet>(na.net, 0x1B);
    if (!netBlk) continue;
    const netName = db.getString(netBlk.netName);
    if (!netName) continue;

    map.set(na.key, netName);
    if (na.connItem !== 0) {
      map.set(na.connItem, netName);
    }
  }

  return map;
}

// ── Components & Pins ─────────────────────────────────────────────────────────

function extractComponents(
  db: AllegroDb,
  ver: FmtVer,
  div: number,
  netAssignMap: Map<number, string>,
): { parts: Part[]; allPinPositions: Point[] } {
  const parts: Part[] = [];
  const allPinPositions: Point[] = [];

  // Walk LL_0x2B → 0x2B footprint defs → firstInstPtr → 0x2D chain
  const fpDefs = db.walkLinkedList(
    db.header.LL_0x2B,
    (blk) => (blk as Blk0x2BFootprintDef).next,
  );

  for (const fpDefBlk of fpDefs) {
    if (fpDefBlk.blockType !== 0x2B) continue;
    const fpDef = fpDefBlk as Blk0x2BFootprintDef;

    // Walk 0x2D instance chain
    let instKey = fpDef.firstInstPtr;
    const MAX_INST = 1_000_000;

    for (let ii = 0; ii < MAX_INST && instKey !== 0; ii++) {
      const inst = db.getBlockAs<Blk0x2DFootprintInst>(instKey, 0x2D);
      if (!inst) break;

      // Resolve refdes: instRef (>= V172) or instRef16x (< V172) → 0x07 → refDesStrPtr → string
      const instRefKey = ver >= FmtVer.V_172 ? inst.instRef : inst.instRef16x;
      let refdes = '';
      if (instRefKey) {
        const compInst = db.getBlockAs<Blk0x07ComponentInst>(instRefKey, 0x07);
        if (compInst) {
          refdes = db.getString(compInst.refDesStrPtr);
        }
      }

      // Skip unplaced instances (no refdes)
      if (!refdes) {
        instKey = inst.next;
        continue;
      }

      const origin: Point = { x: inst.coordX / div, y: inst.coordY / div };
      const side: 'top' | 'bottom' = inst.layer === 0 ? 'top' : 'bottom';

      // Extract pins for this footprint instance
      const pins = extractPins(db, inst, ver, div, netAssignMap);
      for (const pin of pins) {
        allPinPositions.push(pin.position);
      }

      // Compute bounds from pin positions + origin
      const pinPts: Point[] = pins.map((p) => p.position);
      pinPts.push(origin);
      const bounds = computeBBox(pinPts);

      // Determine type from pins — if any pin has a through-hole pad, it's throughhole
      const partType: 'smd' | 'throughhole' = 'smd';

      parts.push({
        name: refdes,
        side,
        type: partType,
        origin,
        pins,
        bounds,
      });

      instKey = inst.next;
    }
  }

  return { parts, allPinPositions };
}

function extractPins(
  db: AllegroDb,
  fpInst: Blk0x2DFootprintInst,
  ver: FmtVer,
  div: number,
  netAssignMap: Map<number, string>,
): Pin[] {
  const pins: Pin[] = [];
  let padKey = fpInst.firstPadPtr;
  const MAX_PADS = 1_000_000;

  for (let i = 0; i < MAX_PADS && padKey !== 0; i++) {
    const pad = db.getBlockAs<Blk0x32PlacedPad>(padKey, 0x32);
    if (!pad) break;

    // Position: 0x32 bbox midpoint gives board-absolute coords.
    // (0x0D coords are footprint-local offsets, not board-absolute.)
    const [cx1, cy1, cx2, cy2] = pad.coords;
    const px = ((cx1 + cx2) / 2) / div;
    const py = ((cy1 + cy2) / 2) / div;

    // Pin number: 0x32 ptrPinNumber → 0x08 PIN_NUMBER
    let pinNumber = '';
    const pinNumBlk = db.getBlockAs<Blk0x08PinNumber>(pad.ptrPinNumber, 0x08);
    if (pinNumBlk) {
      const strKey = ver >= FmtVer.V_172 ? pinNumBlk.strPtr : pinNumBlk.strPtr16x;
      if (strKey) {
        pinNumber = db.getString(strKey);
      }
    }

    // Pin name: 0x08 pinNamePtr → 0x11 PIN_NAME → pinNameStrPtr → string
    let pinName = '';
    if (pinNumBlk && pinNumBlk.pinNamePtr) {
      const pinNameBlk = db.getBlockAs<Blk0x11PinName>(pinNumBlk.pinNamePtr, 0x11);
      if (pinNameBlk) {
        pinName = db.getString(pinNameBlk.pinNameStrPtr);
      }
    }

    // Net: 0x32 netPtr → net assignment map
    const net = netAssignMap.get(pad.netPtr) ?? '';

    // Radius: from 0x32 bbox. The bbox includes clearance/mask extent,
    // so use the smaller dimension as a better pad-body estimate.
    const bw = Math.abs(cx2 - cx1) / div;
    const bh = Math.abs(cy2 - cy1) / div;
    const rawRadius = Math.min(bw, bh) / 2;
    const radius = Math.max(3, Math.min(30, rawRadius));

    const side: 'top' | 'bottom' = fpInst.layer === 0 ? 'top' : 'bottom';

    pins.push({
      name: pinName,
      number: pinNumber,
      position: { x: px, y: py },
      radius,
      side,
      net,
    });

    // Follow nextInFp (NOT next!) for footprint pad chain
    padKey = pad.nextInFp;
  }

  return pins;
}

// ── Traces ────────────────────────────────────────────────────────────────────

function extractTraces(
  db: AllegroDb,
  ver: FmtVer,
  div: number,
  netAssignMap: Map<number, string>,
): Trace[] {
  const traces: Trace[] = [];

  for (const blk of db.blocks.values()) {
    if (blk.blockType !== 0x05) continue;
    const track = blk as Blk0x05Track;

    // Only ETCH-class tracks (actual copper traces)
    if (track.layer.classCode !== LayerClass.ETCH) continue;

    // Resolve net name via netAssignment → net assign map
    const net = netAssignMap.get(track.netAssignment) ?? '';

    // Resolve layer index from subclass (0-based ETCH layer)
    const layerIdx = track.layer.subclass > 0 ? track.layer.subclass - 1 : 0;

    // Walk segment chain: firstSegPtr → 0x15/16/17 segments + 0x01 arcs
    let segKey = track.firstSegPtr;
    const MAX_SEGS = 1_000_000;

    for (let i = 0; i < MAX_SEGS && segKey !== 0; i++) {
      const seg = db.getBlock(segKey);
      if (!seg) break;

      if (seg.blockType === 0x15 || seg.blockType === 0x16 || seg.blockType === 0x17) {
        const s = seg as Blk0x15_16_17Segment;
        const width = s.width / div;

        traces.push({
          start: { x: s.startX / div, y: s.startY / div },
          end: { x: s.endX / div, y: s.endY / div },
          width: width > 0 ? width : 1,
          net,
          layer: layerIdx,
        });

        segKey = s.next;
      } else if (seg.blockType === 0x01) {
        // Arc — linearize into polyline segments (~10 degrees each)
        const arc = seg as Blk0x01Arc;
        const arcTraces = linearizeArc(arc, div, net, layerIdx);
        for (const t of arcTraces) traces.push(t);
        segKey = arc.next;
      } else {
        // Unknown segment type — stop following chain
        break;
      }
    }
  }

  return traces;
}

/**
 * Linearize an arc into polyline trace segments.
 * Uses ~10-degree angular steps for smooth curves.
 */
function linearizeArc(
  arc: Blk0x01Arc,
  div: number,
  net: string,
  layer: number,
): Trace[] {
  const traces: Trace[] = [];
  const cx = arc.centerX / div;
  const cy = arc.centerY / div;
  const sx = arc.startX / div;
  const sy = arc.startY / div;
  const ex = arc.endX / div;
  const ey = arc.endY / div;
  const width = (arc.width / div) || 1;

  // Calculate start and end angles
  const startAngle = Math.atan2(sy - cy, sx - cx);
  const endAngle = Math.atan2(ey - cy, ex - cx);
  const radius = arc.radius / div;

  if (radius <= 0) {
    // Degenerate arc — just draw a line
    traces.push({ start: { x: sx, y: sy }, end: { x: ex, y: ey }, width, net, layer });
    return traces;
  }

  // Determine sweep direction from subType bit 6
  const clockwise = (arc.subType & 0x40) !== 0;

  let sweep: number;
  if (clockwise) {
    sweep = startAngle - endAngle;
    if (sweep <= 0) sweep += 2 * Math.PI;
  } else {
    sweep = endAngle - startAngle;
    if (sweep <= 0) sweep += 2 * Math.PI;
  }

  // Number of segments (~10 degrees each)
  const steps = Math.max(2, Math.ceil(Math.abs(sweep) / (Math.PI / 18)));
  const dAngle = (clockwise ? -sweep : sweep) / steps;

  let prevX = sx;
  let prevY = sy;

  for (let i = 1; i <= steps; i++) {
    const angle = startAngle + dAngle * i;
    const nx = i === steps ? ex : cx + radius * Math.cos(angle);
    const ny = i === steps ? ey : cy + radius * Math.sin(angle);

    traces.push({
      start: { x: prevX, y: prevY },
      end: { x: nx, y: ny },
      width,
      net,
      layer,
    });

    prevX = nx;
    prevY = ny;
  }

  return traces;
}

// ── Vias ──────────────────────────────────────────────────────────────────────

function extractVias(
  db: AllegroDb,
  div: number,
  netAssignMap: Map<number, string>,
): Via[] {
  const vias: Via[] = [];

  for (const blk of db.blocks.values()) {
    if (blk.blockType !== 0x33) continue;
    const via = blk as Blk0x33Via;

    const x = via.coordsX / div;
    const y = via.coordsY / div;

    // Net from netPtr → net assign map
    const net = netAssignMap.get(via.netPtr) ?? '';

    // Diameter from bbox
    const [bx1, , bx2] = via.bbox;
    const diameter = Math.abs(bx2 - bx1) / div;

    vias.push({
      position: { x, y },
      diameter: diameter > 0 ? diameter : 10,
      net,
      layers: [], // through-hole (all layers)
    });
  }

  return vias;
}

// ── Board outline ─────────────────────────────────────────────────────────────

function extractOutline(db: AllegroDb, ver: FmtVer, div: number): Point[] {
  const points: Point[] = [];

  // Walk LL_Shapes → 0x28 shapes
  const shapes = db.walkLinkedList(
    db.header.LL_Shapes,
    (blk) => (blk as Blk0x28Shape).next,
  );

  for (const shapeBlk of shapes) {
    if (shapeBlk.blockType !== 0x28) continue;
    const shape = shapeBlk as Blk0x28Shape;

    // Filter: BOUNDARY class (0x15), or BOARD_GEOMETRY (0x01) / DRAWING_FORMAT (0x04)
    // with subclass 0xEA or 0xFD
    const cc = shape.layer.classCode;
    const sc = shape.layer.subclass;

    const isBoundary = cc === LayerClass.BOUNDARY;
    const isBoardGeomOutline =
      (cc === LayerClass.BOARD_GEOMETRY || cc === LayerClass.DRAWING_FORMAT) &&
      (sc === 0xEA || sc === 0xFD);

    if (!isBoundary && !isBoardGeomOutline) continue;

    // Walk segment chain → lines + arcs → point array
    const shapePoints = walkSegmentChain(db, shape.firstSegmentPtr, div);
    for (const p of shapePoints) points.push(p);

    // If we found outline points, stop (use first matching shape)
    if (points.length > 0) break;
  }

  return points;
}

/**
 * Walk a segment/arc chain starting at headKey, collecting points.
 */
function walkSegmentChain(db: AllegroDb, headKey: number, div: number): Point[] {
  const points: Point[] = [];
  let key = headKey;
  const MAX_ITER = 1_000_000;

  for (let i = 0; i < MAX_ITER && key !== 0; i++) {
    const seg = db.getBlock(key);
    if (!seg) break;

    if (seg.blockType === 0x15 || seg.blockType === 0x16 || seg.blockType === 0x17) {
      const s = seg as Blk0x15_16_17Segment;
      if (points.length === 0) {
        points.push({ x: s.startX / div, y: s.startY / div });
      }
      points.push({ x: s.endX / div, y: s.endY / div });
      key = s.next;
    } else if (seg.blockType === 0x01) {
      const arc = seg as Blk0x01Arc;
      // Linearize arc into points
      const cx = arc.centerX / div;
      const cy = arc.centerY / div;
      const sx = arc.startX / div;
      const sy = arc.startY / div;
      const ex = arc.endX / div;
      const ey = arc.endY / div;
      const radius = arc.radius / div;

      if (points.length === 0) {
        points.push({ x: sx, y: sy });
      }

      if (radius > 0) {
        const startAngle = Math.atan2(sy - cy, sx - cx);
        const endAngle = Math.atan2(ey - cy, ex - cx);
        const clockwise = (arc.subType & 0x40) !== 0;

        let sweep: number;
        if (clockwise) {
          sweep = startAngle - endAngle;
          if (sweep <= 0) sweep += 2 * Math.PI;
        } else {
          sweep = endAngle - startAngle;
          if (sweep <= 0) sweep += 2 * Math.PI;
        }

        const steps = Math.max(2, Math.ceil(Math.abs(sweep) / (Math.PI / 18)));
        const dAngle = (clockwise ? -sweep : sweep) / steps;

        for (let j = 1; j <= steps; j++) {
          const angle = startAngle + dAngle * j;
          const nx = j === steps ? ex : cx + radius * Math.cos(angle);
          const ny = j === steps ? ey : cy + radius * Math.sin(angle);
          points.push({ x: nx, y: ny });
        }
      } else {
        points.push({ x: ex, y: ey });
      }

      key = arc.next;
    } else {
      break;
    }
  }

  return points;
}

// ── Layer names ───────────────────────────────────────────────────────────────

function extractLayerNames(db: AllegroDb): string[] {
  const names: string[] = [];

  // From header layerMap[LayerClass.ETCH].layerList0x2A → 0x2A block → entries → names
  const etchIdx = LayerClass.ETCH; // 0x06
  if (etchIdx >= db.header.layerMap.length) return names;

  const layerEntry = db.header.layerMap[etchIdx];
  if (!layerEntry || layerEntry.layerList0x2A === 0) return names;

  const layerList = db.getBlockAs<Blk0x2ALayerList>(layerEntry.layerList0x2A, 0x2A);
  if (!layerList) return names;

  if (layerList.refEntries) {
    // V165+: string table references
    for (const entry of layerList.refEntries) {
      const name = db.getString(entry.layerNameId);
      if (name) names.push(name);
    }
  } else if (layerList.nonRefEntries) {
    // Pre-V165: inline strings
    for (const entry of layerList.nonRefEntries) {
      if (entry.name) names.push(entry.name);
    }
  }

  return names;
}
