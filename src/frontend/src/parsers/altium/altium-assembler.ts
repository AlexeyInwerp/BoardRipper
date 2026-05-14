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
  const usedCopper = collectUsedCopperLayers(db);
  const { idxByAltiumLayer: copperLayerByAltium, names: layerNames } = buildCopperLayerTable(db.board.layerNames, usedCopper);

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

  // The synthetic outline + bounds must envelope ALL geometry the renderer
  // draws, not just pin positions — otherwise the board outline ends up
  // smaller than the trace/via field and the user sees routing escape the
  // box. Sample pins + trace endpoints + via centers + pad bounds corners.
  const allPoints: Point[] = [];
  for (const p of parts) for (const pin of p.pins) allPoints.push(pin.position);
  for (const t of traces) { allPoints.push(t.start); allPoints.push(t.end); }
  for (const v of vias) allPoints.push(v.position);
  for (const pad of pads) {
    allPoints.push({ x: pad.bounds.minX, y: pad.bounds.minY });
    allPoints.push({ x: pad.bounds.maxX, y: pad.bounds.maxY });
  }
  const bounds = allPoints.length > 0
    ? computeBBox(allPoints)
    : { minX: 0, minY: 0, maxX: 1000, maxY: 1000 };
  const outline = generateSyntheticOutline(allPoints, 50);

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
 * physical stackup order (TOP → MID1 → … → BOTTOM). Only includes inner
 * copper layers (MID1..30) that are *actually used* by the file — i.e.
 * referenced by at least one component, pad, track, or via.
 *
 * Why empirical and not name-based: Altium populates default names for
 * every mid-layer slot (`Mid-Layer 1`..`Mid-Layer 30`) regardless of
 * whether they're part of the stackup, so the name field alone can't
 * distinguish a 2-layer board from a 32-layer one. The presence of
 * geometry is the only reliable signal.
 *
 * TOP and BOTTOM are always included even if empty — the side toggle in
 * the UI needs both poles defined.
 */
function buildCopperLayerTable(
  boardLayerNames: string[],
  usedAltiumLayers: Set<number>,
): {
  idxByAltiumLayer: Map<number, number>;
  names: string[];
} {
  const order: number[] = [];
  order.push(ALTIUM_LAYER.TOP);
  for (let i = 0; i < 30; i++) order.push(ALTIUM_LAYER.MID_LAYER_1 + i);
  order.push(ALTIUM_LAYER.BOTTOM);

  const idxByAltiumLayer = new Map<number, number>();
  const names: string[] = [];
  for (const layerId of order) {
    const include = layerId === ALTIUM_LAYER.TOP
      || layerId === ALTIUM_LAYER.BOTTOM
      || usedAltiumLayers.has(layerId);
    if (!include) continue;
    const rawName = boardLayerNames[layerId - 1] ?? '';
    const label = rawName || (layerId === ALTIUM_LAYER.TOP ? 'Top' : layerId === ALTIUM_LAYER.BOTTOM ? 'Bottom' : `Mid ${layerId - 1}`);
    idxByAltiumLayer.set(layerId, names.length);
    names.push(label);
  }
  return { idxByAltiumLayer, names };
}

/**
 * Scan everything that references a copper layer and return the set of
 * Altium layer IDs actually used. Used to gate which MID layers appear
 * in the layer selector.
 */
function collectUsedCopperLayers(db: AltiumPcbDb): Set<number> {
  const used = new Set<number>();
  const isCopper = (layer: number): boolean =>
    layer === ALTIUM_LAYER.TOP
    || layer === ALTIUM_LAYER.BOTTOM
    || (layer >= ALTIUM_LAYER.MID_LAYER_1 && layer <= ALTIUM_LAYER.MID_LAYER_30);
  for (const c of db.components) if (isCopper(c.layer)) used.add(c.layer);
  for (const p of db.pads) {
    if (isCopper(p.layer)) used.add(p.layer);
    // through-hole pads (MULTI_LAYER) implicitly use top and bottom — leave
    // that to the always-include rule in the table builder.
  }
  for (const t of db.tracks) if (isCopper(t.layer)) used.add(t.layer);
  for (const a of db.arcs) if (isCopper(a.layer)) used.add(a.layer);
  for (const f of db.fills) if (isCopper(f.layer)) used.add(f.layer);
  for (const v of db.vias) {
    // A via's layer-span ends are themselves copper layer ids.
    if (isCopper(v.layerStart)) used.add(v.layerStart);
    if (isCopper(v.layerEnd)) used.add(v.layerEnd);
  }
  return used;
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
