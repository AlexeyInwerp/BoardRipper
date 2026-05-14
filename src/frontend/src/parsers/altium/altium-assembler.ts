/**
 * Altium PCB → BoardData assembler.
 *
 * P1 emits parts + pins + nets + synthetic outline + stand-alone pads.
 * P2 layers on traces (Tracks6 + tessellated Arcs6), vias, and Fills6 as
 * additional copper pads. Unit conversion happens here — decoders deal in
 * raw Altium units; the assembler converts to mils via altium-units.ts.
 */

import type { BoardData, Part, Pin, Point, Net, Pad, Trace, Via } from '../types';
import { buildNets, computeBBox, generateSyntheticOutline } from '../types';
import type {
  AltiumPcbDb,
  AComponent6,
  APad6,
  ATrack6,
  AVia6,
  AArc6,
  AFill6,
} from './altium-types';
import { altiumToMils, altiumYToMils, altiumAngleToDegrees } from './altium-units';
import { altiumLayerSide, ALTIUM_LAYER } from './altium-layers';

function partSide(c: AComponent6): 'top' | 'bottom' {
  const side = altiumLayerSide(c.layer);
  return side === 'bottom' ? 'bottom' : 'top';
}

function pinSide(p: APad6): 'top' | 'bottom' {
  const side = altiumLayerSide(p.layer);
  if (side === 'both') return 'top';
  return side;
}

function pinNet(p: APad6, netNames: string[]): string {
  if (p.netIndex < 0 || p.netIndex >= netNames.length) return '';
  return netNames[p.netIndex];
}

export function assembleBoardData(db: AltiumPcbDb): BoardData {
  const netNames = db.nets.map(n => n.name);
  const { idxByAltiumLayer: copperLayerByAltium, names: layerNames } = buildCopperLayerTable(db.board.layerNames);

  const padsByComp = new Map<number, APad6[]>();
  for (const pad of db.pads) {
    const arr = padsByComp.get(pad.componentIndex) ?? [];
    arr.push(pad);
    padsByComp.set(pad.componentIndex, arr);
  }

  const parts: Part[] = [];
  for (let ci = 0; ci < db.components.length; ci++) {
    const comp = db.components[ci];
    const compRot = altiumAngleToDegrees(comp.rotation);
    const side = partSide(comp);

    const pins: Pin[] = (padsByComp.get(ci) ?? []).map(pad => {
      const xMils = altiumToMils(pad.x);
      const yMils = altiumYToMils(pad.y);
      const w = altiumToMils(pad.xsize);
      const h = altiumToMils(pad.ysize);
      return {
        name: pad.name,
        number: pad.name,
        position: { x: xMils, y: yMils },
        radius: Math.max(2, Math.min(w, h) / 2),
        side: pinSide(pad),
        net: pinNet(pad, netNames),
        padBounds: {
          minX: xMils - w / 2,
          minY: yMils - h / 2,
          maxX: xMils + w / 2,
          maxY: yMils + h / 2,
        },
        padShape: pad.topShape === 1 ? 'round' : 'rect',
        padWidth: w,
        padHeight: h,
        padAngleDeg: altiumAngleToDegrees(pad.rotation),
      };
    });

    const origin: Point = {
      x: altiumToMils(comp.x),
      y: altiumYToMils(comp.y),
    };
    const bounds = pins.length > 0
      ? computeBBox(pins.map(p => p.position))
      : { minX: origin.x - 50, minY: origin.y - 50, maxX: origin.x + 50, maxY: origin.y + 50 };

    parts.push({
      name: comp.designator || `_unnamed_${ci}`,
      side,
      type: 'smd',
      origin,
      pins,
      bounds,
      layer: copperLayerByAltium.get(comp.layer),
      meta: {
        package: comp.pattern,
        partType: comp.componentName,
        angleDeg: compRot,
      },
    });
  }

  // Through-hole detection: any pad on MULTI_LAYER makes the parent component throughhole.
  for (let i = 0; i < parts.length; i++) {
    const pads = padsByComp.get(i) ?? [];
    if (pads.some(pad => pad.isThroughHole)) parts[i].type = 'throughhole';
  }

  const allPoints: Point[] = [];
  for (const p of parts) for (const pin of p.pins) allPoints.push(pin.position);
  const bounds = allPoints.length > 0
    ? computeBBox(allPoints)
    : { minX: 0, minY: 0, maxX: 1000, maxY: 1000 };
  const outline = generateSyntheticOutline(allPoints, 50);

  const nets: Map<string, Net> = buildNets(parts);

  const pads: Pad[] = [
    ...buildPads(db.pads, netNames),
    ...buildFillPads(db.fills, netNames),
  ];

  const traces: Trace[] = [
    ...buildTraces(db.tracks, netNames, copperLayerByAltium),
    ...buildArcTraces(db.arcs, netNames, copperLayerByAltium),
  ];

  const vias: Via[] = buildVias(db.vias, netNames, copperLayerByAltium);

  return {
    format: 'ALTIUM_PCB',
    formatVersion: db.board.formatVersion || undefined,
    outline,
    parts,
    nails: [],
    nets,
    bounds,
    pads,
    traces: traces.length > 0 ? traces : undefined,
    vias: vias.length > 0 ? vias : undefined,
    layerNames,
  };
}

/**
 * Builds a deterministic Altium-layer → output-layer-index mapping in
 * physical stackup order (TOP → MID1 → … → BOTTOM), restricted to layers
 * that have a populated name in Board6 (so we don't expose phantom MID
 * slots the board file doesn't actually use).
 *
 * Returns `{ idxByAltiumLayer, names }` where `names[idx]` is the user-
 * visible layer label and `idxByAltiumLayer.get(altiumLayerId)` is the
 * output index for that raw Altium layer.
 */
function buildCopperLayerTable(boardLayerNames: string[]): {
  idxByAltiumLayer: Map<number, number>;
  names: string[];
} {
  // Altium layer IDs in physical stackup order: TOP=1, MID1=2, …, MID30=31, BOTTOM=32.
  // boardLayerNames[i] holds the name for Altium layer (i+1).
  const order: number[] = [];
  order.push(ALTIUM_LAYER.TOP);
  for (let i = 0; i < 30; i++) order.push(ALTIUM_LAYER.MID_LAYER_1 + i);
  order.push(ALTIUM_LAYER.BOTTOM);

  const idxByAltiumLayer = new Map<number, number>();
  const names: string[] = [];
  for (const layerId of order) {
    const rawName = boardLayerNames[layerId - 1] ?? '';
    // Always include TOP and BOTTOM (some files leave their names blank);
    // only include MID layers when the file gave them an explicit name.
    const include = layerId === ALTIUM_LAYER.TOP
      || layerId === ALTIUM_LAYER.BOTTOM
      || rawName.length > 0;
    if (!include) continue;
    let label = rawName;
    if (!label) {
      label = layerId === ALTIUM_LAYER.TOP ? 'Top' : 'Bottom';
    }
    idxByAltiumLayer.set(layerId, names.length);
    names.push(label);
  }
  return { idxByAltiumLayer, names };
}

function netNameAt(idx: number, netNames: string[]): string {
  if (idx < 0 || idx >= netNames.length) return '';
  return netNames[idx];
}

function padSide(p: APad6): 'top' | 'bottom' | 'both' {
  return altiumLayerSide(p.layer);
}

function padShape(topShape: number): 'round' | 'rect' | 'roundrect' {
  switch (topShape) {
    case 1: return 'round';
    case 9: return 'roundrect';
    default: return 'rect';
  }
}

function buildPads(decoded: APad6[], netNames: string[]): Pad[] {
  const out: Pad[] = [];
  for (const pad of decoded) {
    const xMils = altiumToMils(pad.x);
    const yMils = altiumYToMils(pad.y);
    const w = altiumToMils(pad.xsize);
    const h = altiumToMils(pad.ysize);
    // Skip the zero-size sentinel pads that signal "shape in subrecord 6"
    // (currently unparsed — see ALTIUM_PCB_FORMAT.md). They'd render as
    // single pixels and clutter the pads layer.
    if (w <= 0 || h <= 0) continue;
    const side = padSide(pad);
    const net = pad.netIndex >= 0 && pad.netIndex < netNames.length
      ? netNames[pad.netIndex]
      : undefined;
    out.push({
      bounds: {
        minX: xMils - w / 2,
        minY: yMils - h / 2,
        maxX: xMils + w / 2,
        maxY: yMils + h / 2,
      },
      side,
      net,
      drill: pad.isThroughHole && pad.holeSize > 0 ? altiumToMils(pad.holeSize) : undefined,
      attached: pad.componentIndex >= 0,
      shape: padShape(pad.topShape),
      width: w,
      height: h,
      angleDeg: altiumAngleToDegrees(pad.rotation),
    });
  }
  return out;
}

function buildTraces(tracks: ATrack6[], netNames: string[], copperLayer: Map<number, number>): Trace[] {
  const out: Trace[] = [];
  for (const t of tracks) {
    const layer = copperLayer.get(t.layer);
    if (layer === undefined) continue; // skip silkscreen / mech / mask traces
    out.push({
      start: { x: altiumToMils(t.startX), y: altiumYToMils(t.startY) },
      end:   { x: altiumToMils(t.endX),   y: altiumYToMils(t.endY)   },
      width: altiumToMils(t.width),
      net: netNameAt(t.netIndex, netNames),
      layer,
    });
  }
  return out;
}

/**
 * Tessellate each Arcs6 record into short line segments. Segment count scales
 * with the arc's angular span so tight arcs still look smooth without exploding
 * primitive counts on near-full circles.
 */
function buildArcTraces(arcs: AArc6[], netNames: string[], copperLayer: Map<number, number>): Trace[] {
  const out: Trace[] = [];
  const DEG_PER_SEG = 5;
  for (const a of arcs) {
    const layer = copperLayer.get(a.layer);
    if (layer === undefined) continue;
    const cx = altiumToMils(a.centerX);
    const cy = altiumYToMils(a.centerY);
    const r = altiumToMils(a.radius);
    const w = altiumToMils(a.width);
    const net = netNameAt(a.netIndex, netNames);
    // KiCad treats angles as CCW degrees; our Y is flipped so the visual
    // direction reverses. The renderer doesn't care about orientation for
    // line segments, only endpoints, so flip Y per-vertex like other coords.
    let span = a.endAngle - a.startAngle;
    if (span <= 0) span += 360;
    const segs = Math.max(4, Math.min(64, Math.ceil(Math.abs(span) / DEG_PER_SEG)));
    const step = span / segs;
    let prev: Point | null = null;
    for (let i = 0; i <= segs; i++) {
      const theta = (a.startAngle + step * i) * Math.PI / 180;
      const x = cx + r * Math.cos(theta);
      const y = -(-cy + r * Math.sin(theta)); // -y_alt = -(cy_alt + r sin) then flip back
      const p: Point = { x, y };
      if (prev) out.push({ start: prev, end: p, width: w, net, layer });
      prev = p;
    }
  }
  return out;
}

function buildVias(decoded: AVia6[], netNames: string[], copperLayer: Map<number, number>): Via[] {
  const out: Via[] = [];
  for (const v of decoded) {
    const start = copperLayer.get(v.layerStart);
    const end = copperLayer.get(v.layerEnd);
    const layers: number[] = [];
    if (start !== undefined && end !== undefined && start !== end) {
      const [lo, hi] = start < end ? [start, end] : [end, start];
      for (let l = lo; l <= hi; l++) layers.push(l);
    } else if (start !== undefined) {
      layers.push(start);
    }
    out.push({
      position: { x: altiumToMils(v.x), y: altiumYToMils(v.y) },
      diameter: altiumToMils(v.diameter),
      net: netNameAt(v.netIndex, netNames),
      layers,
    });
  }
  return out;
}

/**
 * Altium Fills6 records are axis-aligned rectangles defined by two corners
 * plus a rotation about the rect's center. We emit them as Pad entries
 * (attached=false) — the existing Pads layer renders rotated rect pads.
 */
function buildFillPads(fills: AFill6[], netNames: string[]): Pad[] {
  const out: Pad[] = [];
  for (const f of fills) {
    const x1 = altiumToMils(f.x1);
    const y1 = altiumYToMils(f.y1);
    const x2 = altiumToMils(f.x2);
    const y2 = altiumYToMils(f.y2);
    const cx = (x1 + x2) / 2;
    const cy = (y1 + y2) / 2;
    const w = Math.abs(x2 - x1);
    const h = Math.abs(y2 - y1);
    if (w <= 0 || h <= 0) continue;
    const altiumSide = altiumLayerSide(f.layer);
    // Fills only land on copper / mech layers; skip if we can't place them top/bottom.
    if (altiumSide !== 'top' && altiumSide !== 'bottom' && altiumSide !== 'both') continue;
    out.push({
      bounds: {
        minX: cx - w / 2,
        minY: cy - h / 2,
        maxX: cx + w / 2,
        maxY: cy + h / 2,
      },
      side: altiumSide,
      net: netNameAt(f.netIndex, netNames) || undefined,
      attached: false,
      shape: 'rect',
      width: w,
      height: h,
      angleDeg: altiumAngleToDegrees(f.rotation),
    });
  }
  return out;
}
