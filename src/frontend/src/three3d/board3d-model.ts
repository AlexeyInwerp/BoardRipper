/**
 * What the 3D view draws, as plain data — no three.js here, so it is cheap to
 * test and could move to a worker.
 *
 * Frames. Files come Y-up or Y-down (the format's `flipY`, the same flag the 2D
 * renderer reads). Everything below works in one Y-up board frame (mils), so
 * the estimator's angles and "which side" conventions mean one thing; the
 * scene is mm, centred on the board, with scene z = −y (Y-up board seen from
 * above, +x right, +z towards the viewer).
 */
import type { BoardData, BBox, Part, Pin, Point } from '../parsers/types';
import { getFormat } from '../parsers/registry';
import { estimatePart, type PartEstimate } from '../store/package-estimate';

export const MM = 0.0254;

export interface Board3DPart {
  /** Index into the tab's `board.parts` — the selection index. */
  index: number;
  name: string;
  side: 'top' | 'bottom';
  est: PartEstimate;
}

export interface Board3DPad { x: number; z: number; w: number; h: number; angle: number; round: boolean; side: 'top' | 'bottom' | 'both'; drill: number }

export interface Board3DModel {
  /** Board size in mm. */
  width: number; height: number;
  /** Outer outline contours and cut-outs, scene mm [x, z]. */
  outlines: [number, number][][];
  cutouts: [number, number][][];
  parts: Board3DPart[];
  pads: Board3DPad[];
  /** Copper traces for the board-face texture, scene mm, per outer side. */
  traces: { side: 'top' | 'bottom'; x1: number; z1: number; x2: number; z2: number; w: number; net: string }[];
  /** Silkscreen polylines, scene mm (only where the format's silkscreen is printed art). */
  silk: { side: 'top' | 'bottom'; pts: [number, number][] }[];
  /** Mounting holes and drills, scene mm. */
  holes: { x: number; z: number; rx: number; rz: number }[];
  /** Copper layers, 0 = the user's Top face, in stack order. One entry for a board without layer data. */
  layerNames: string[];
  /** Every trace segment with its layer, scene mm — the inner stack (the face textures use `traces`). */
  copper: { layer: number; x1: number; z1: number; x2: number; z2: number; w: number; net: string }[];
  /** Copper pours per layer: outer ring and holes, scene mm. */
  pours: { layer: number; net: string; outer: [number, number][]; holes: [number, number][][] }[];
  /** The thinnest trace on the board, mm — the via pass sizes its barrels against it. */
  minTraceWidth: number;
  /** Vias: position, drill radius, the layer span they join (through = 0 … last). */
  vias: { x: number; z: number; r: number; net: string; l0: number; l1: number }[];
  /** The side the user calls Top (the file's `primarySide`). */
  primarySide: 'top' | 'bottom';
  /** Board frame (Y-up mils) → scene mm. */
  toScene(p: Point): [number, number];
  /** Pins of a part, scene mm, with side — for net highlight markers. */
  pinsOf(index: number): { x: number; z: number; side: 'top' | 'bottom'; net: string; r: number }[];
  /** The land under each pin of a part (same order as its pins), scene mm — for picking and the net highlight. */
  pinPads(index: number): (Board3DPad | null)[];
}

/** Formats whose silkscreen paths are printed art, not assembly outlines. */
const PRINTED_SILK = new Set(['EAGLE_BRD', 'KICAD']);

export interface Board3DModelOptions {
  /** Reference designators the user hid (the tab's part overrides) — left out like `part.hidden`. */
  hidden?: ReadonlySet<string>;
  /** Precomputed estimates by part index (from `estimateParts`), so the slow step can run in chunks with progress. */
  estimates?: ReadonlyMap<number, PartEstimate>;
}

/** The estimator over every part, in chunks that yield to the browser between them so a progress indicator can
 *  paint — on a 7,900-part board the estimates are most of the build. The Y-up conversion matches `buildBoard3DModel`. */
export async function estimateParts(board: BoardData, onProgress?: (done: number, total: number) => void | Promise<void>, chunk = 400): Promise<Map<number, PartEstimate>> {
  const yUp = board.flipY ?? getFormat(board.format)?.flipY ?? false, swap = board.primarySide === 'bottom';
  const out = new Map<number, PartEstimate>(); const n = board.parts.length;
  for (let i = 0; i < n; i++) {
    const pt = board.parts[i]; if (pt.hidden || !pt.pins.length) continue;
    out.set(i, estimatePart(yUpPartOf(pt, yUp, swap), { usePackage: true }));
    if ((i + 1) % chunk === 0 && onProgress) { await onProgress(i + 1, n); await new Promise<void>(r => setTimeout(r, 0)); }
  }
  if (onProgress) await onProgress(n, n);
  return out;
}

/** A part in the Y-up frame with its effective side (the user's Top is the +y face). */
function yUpPartOf(pt: Part, yUp: boolean, swap: boolean): Part {
  const S = (side: Part['side']): Part['side'] => (swap && side === 'top' ? 'bottom' : swap && side === 'bottom' ? 'top' : side);
  if (yUp) return swap ? { ...pt, side: S(pt.side) } : pt;
  const fy = (y: number) => -y, P = (p: Point): Point => ({ x: p.x, y: fy(p.y) }), B = (b: BBox): BBox => ({ minX: b.minX, maxX: b.maxX, minY: -b.maxY, maxY: -b.minY });
  return { ...pt, side: S(pt.side), origin: P(pt.origin), bounds: B(pt.bounds), angleDeg: pt.angleDeg === undefined ? undefined : -pt.angleDeg,
    pins: pt.pins.map((q: Pin): Pin => ({ ...q, position: P(q.position), padBounds: q.padBounds && B(q.padBounds), padAngleDeg: q.padAngleDeg === undefined ? undefined : -q.padAngleDeg, padPolygon: q.padPolygon?.map(P) })) };
}

export function buildBoard3DModel(board: BoardData, opts: Board3DModelOptions = {}): Board3DModel {
  const yUp = board.flipY ?? getFormat(board.format)?.flipY ?? false;
  // The user's Top is the file's primary side. The 2D view draws a primary-bottom board in the file frame with the
  // bottom-side parts on top; the 3D view does the same by putting that side on the +y face — before, the Top preset
  // looked at it from underneath, a mirror image of the 2D view, and turning the board felt inverted (Legion Pro 5
  // NM-F701, 2026-11-15). Every side label below is the effective one, estimator included (its bottom-side mirror).
  const swap = board.primarySide === 'bottom';
  const S = <T extends 'top' | 'bottom' | 'both' | undefined>(side: T): T => (swap && side === 'top' ? 'bottom' : swap && side === 'bottom' ? 'top' : side) as T;
  const fy = (y: number) => (yUp ? y : -y);
  const P = (p: Point): Point => ({ x: p.x, y: fy(p.y) });
  const B = (b: BBox): BBox => (yUp ? b : { minX: b.minX, maxX: b.maxX, minY: -b.maxY, maxY: -b.minY });

  // outline → contours, in the Y-up frame
  const contours: Point[][] = []; let cur: Point[] = [];
  for (const p of board.outline) { if (Number.isNaN(p.x) || Number.isNaN(p.y)) { if (cur.length > 2) contours.push(cur); cur = []; } else cur.push(P(p)); }
  if (cur.length > 2) contours.push(cur);
  const visibleParts = board.parts.filter(p => !p.hidden && p.pins.length);
  if (!contours.length) { // no outline: the parts' box plus a margin
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const pt of visibleParts) for (const q of pt.pins) { const y = fy(q.position.y); x0 = Math.min(x0, q.position.x); x1 = Math.max(x1, q.position.x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    const m = 120; contours.push([{ x: x0 - m, y: y0 - m }, { x: x1 + m, y: y0 - m }, { x: x1 + m, y: y1 + m }, { x: x0 - m, y: y1 + m }]);
  }
  const bb = (c: Point[]) => c.reduce((b, p) => ({ x0: Math.min(b.x0, p.x), x1: Math.max(b.x1, p.x), y0: Math.min(b.y0, p.y), y1: Math.max(b.y1, p.y) }), { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity });
  const boxes = contours.map(bb);
  const all = boxes.reduce((b, c) => ({ x0: Math.min(b.x0, c.x0), x1: Math.max(b.x1, c.x1), y0: Math.min(b.y0, c.y0), y1: Math.max(b.y1, c.y1) }));
  const cx = (all.x0 + all.x1) / 2, cy = (all.y0 + all.y1) / 2;
  const toScene = (p: Point): [number, number] => [(p.x - cx) * MM, -(p.y - cy) * MM];
  // a contour inside another's box is a cut-out
  const inside = (i: number) => boxes.some((o, j) => j !== i && o.x0 <= boxes[i].x0 && o.x1 >= boxes[i].x1 && o.y0 <= boxes[i].y0 && o.y1 >= boxes[i].y1 && (o.x1 - o.x0) * (o.y1 - o.y0) > (boxes[i].x1 - boxes[i].x0) * (boxes[i].y1 - boxes[i].y0));
  const outlines: [number, number][][] = [], cutouts: [number, number][][] = [];
  contours.forEach((c, i) => (inside(i) ? cutouts : outlines).push(c.map(toScene)));

  // parts: estimate in the Y-up frame
  const yUpPart = (pt: Part): Part => yUp ? (swap ? { ...pt, side: S(pt.side) } : pt) : {
    ...pt, side: S(pt.side), origin: P(pt.origin), bounds: B(pt.bounds), angleDeg: pt.angleDeg === undefined ? undefined : -pt.angleDeg,
    pins: pt.pins.map((q: Pin): Pin => ({ ...q, position: P(q.position), padBounds: q.padBounds && B(q.padBounds), padAngleDeg: q.padAngleDeg === undefined ? undefined : -q.padAngleDeg, padPolygon: q.padPolygon?.map(P) })),
  };
  const parts: Board3DPart[] = [];
  const holes: Board3DModel['holes'] = [];
  board.parts.forEach((pt, index) => {
    if (pt.hidden || !pt.pins.length || opts.hidden?.has(pt.name)) return;
    const est = opts.estimates?.get(index) ?? estimatePart(yUpPart(pt), { usePackage: true });
    const side = S(pt.side) === 'bottom' ? 'bottom' : 'top';
    parts.push({ index, name: pt.name, side, est });
    if (est.family === 'hole') { const [x, z] = toScene({ x: est.cx, y: est.cy }); holes.push({ x, z, rx: (est.p.drill || est.L * 0.5) / 2, rz: (est.p.drill || est.W * 0.5) / 2 }); }
  });

  // pads: the file's list, else one per pin — from the pin's pad when it has one,
  // else shaped like the estimated package's terminal (BVR and other formats
  // carry only a pin radius, and a round pad under a chip's end cap reads wrong)
  const pads: Board3DPad[] = [];
  const estByIndex = new Map(parts.map(p => [p.index, p.est]));
  const pinPadMap = new Map<number, (Board3DPad | null)[]>();
  const pushPad = (b: BBox, side: Board3DPad['side'], w: number | undefined, h: number | undefined, a: number | undefined, round: boolean, drill: number | undefined) => {
    const yb = B(b); const [x, z] = toScene({ x: (yb.minX + yb.maxX) / 2, y: (yb.minY + yb.maxY) / 2 });
    pads.push({ x, z, w: (w ?? b.maxX - b.minX) * MM, h: (h ?? b.maxY - b.minY) * MM, angle: (yUp ? 1 : -1) * (a ?? 0), round, side, drill: (drill ?? 0) * MM });
  };
  if (board.pads?.length) for (const p of board.pads) pushPad(p.bounds, S(p.side), p.width, p.height, p.angleDeg, p.shape === 'round', p.drill);
  else board.parts.forEach((pt, index) => {
    if (pt.hidden) return;
    const est = estByIndex.get(index);
    const list: (Board3DPad | null)[] = []; pinPadMap.set(index, list);
    for (const q of pt.pins) {
      const before = pads.length;
      const roundFamily = est && ['bga', 'testpoint', 'fiducial', 'hole'].includes(est.family);
      if (q.padBounds) { pushPad(q.padBounds, S(q.side), q.padWidth, q.padHeight, q.padAngleDeg, q.padShape === 'round' || (!q.padShape && !!roundFamily), q.drill); list.push(pads[before]); continue; }
      const t = est && !q.drill ? terminalPad(est, P(q.position), q.radius * MM) : null;
      const [x, z] = toScene(P(q.position));
      if (t) pads.push({ x, z, w: t.w, h: t.h, angle: t.angle, round: false, side: S(q.side), drill: 0 });
      else pads.push({ x, z, w: q.radius * 2 * MM, h: q.radius * 2 * MM, angle: 0, round: true, side: S(q.side), drill: (q.drill ?? 0) * MM });
      list.push(pads[before]);
    }
  });
  for (const p of pads) if (p.drill > 0.25) holes.push({ x: p.x, z: p.z, rx: p.drill / 2, rz: p.drill / 2 });
  if (board.pads?.length) { // the file's own pad list: find the pad each pin sits in
    const cell = 1, grid = new Map<string, Board3DPad[]>(), key = (x: number, z: number) => `${Math.floor(x / cell)},${Math.floor(z / cell)}`;
    for (const p of pads) { const k = key(p.x, p.z); let l = grid.get(k); if (!l) grid.set(k, (l = [])); l.push(p); }
    board.parts.forEach((pt, index) => {
      if (pt.hidden) return;
      pinPadMap.set(index, pt.pins.map(q => {
        const [x, z] = toScene(P(q.position)); let best: Board3DPad | null = null, bd = Infinity;
        for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const p of grid.get(`${Math.floor(x / cell) + i},${Math.floor(z / cell) + j}`) ?? []) {
          if (p.side !== 'both' && p.side !== S(q.side)) continue; const d = Math.hypot(p.x - x, p.z - z); if (d < bd && d < Math.max(p.w, p.h) / 2 + 0.05) { bd = d; best = p; }
        }
        return best;
      }));
    });
  }

  // traces on the outer layers, for the board-face texture
  const nLayers = board.layerNames?.length ?? 0;
  const traces: Board3DModel['traces'] = [];
  for (const t of board.traces ?? []) {
    const L = t.layer ?? 0; const side = S(L === 0 ? 'top' : nLayers > 1 && L === nLayers - 1 ? 'bottom' : undefined); if (!side) continue;
    const [x1, z1] = toScene(P(t.start)), [x2, z2] = toScene(P(t.end)); traces.push({ side, x1, z1, x2, z2, w: t.width * MM, net: t.net });
  }
  const silk = PRINTED_SILK.has(board.format) ? (board.silkscreen ?? []).map(s => ({ side: S(s.side), pts: s.points.map(p => toScene(P(p))) })) : [];

  // the layer stack: names from the file, else as many layers as the traces use; a primary-bottom board reads
  // its stack upside down (layer 0 is the user's Top face), like every other side label here
  const maxTraceLayer = (board.traces ?? []).reduce((m, t) => Math.max(m, t.layer ?? 0), 0);
  const nL = Math.max(board.layerNames?.length ?? 0, maxTraceLayer + 1, 1);
  const layerNames = Array.from({ length: nL }, (_, i) => board.layerNames?.[i] ?? (nL === 1 ? 'Copper' : i === 0 ? 'Top' : i === nL - 1 ? 'Bottom' : `Inner ${i}`));
  const LI = (i: number) => (swap ? nL - 1 - i : i);
  const copper: Board3DModel['copper'] = [];
  for (const t of board.traces ?? []) { const [x1, z1] = toScene(P(t.start)), [x2, z2] = toScene(P(t.end)); copper.push({ layer: LI(Math.min(nL - 1, t.layer ?? 0)), x1, z1, x2, z2, w: Math.max(t.width * MM, 0.05), net: t.net }); }
  const pours: Board3DModel['pours'] = [];
  for (const sf of board.surfaces ?? []) { if (sf.polygon.length < 3) continue; pours.push({ layer: LI(Math.min(nL - 1, sf.layer ?? 0)), net: sf.net ?? '', outer: sf.polygon.map(p => toScene(P(p))), holes: (sf.voids ?? []).filter(v => v.length >= 3).map(v => v.map(p => toScene(P(p)))) }); }
  const vias: Board3DModel['vias'] = [];
  for (const v of board.vias ?? []) { const [x, z] = toScene(P(v.position)); const ls = v.layers.length ? v.layers.map(LI) : [0, nL - 1]; vias.push({ x, z, r: Math.max(v.diameter * MM / 2, 0.08), net: v.net, l0: Math.min(...ls), l1: Math.max(...ls) }); }
  if (swap) layerNames.reverse();

  const pinsOf = (index: number) => {
    const pt = board.parts[index]; if (!pt) return [];
    return pt.pins.map(q => { const [x, z] = toScene(P(q.position)); return { x, z, side: (S(q.side) === 'bottom' ? 'bottom' : 'top') as 'top' | 'bottom', net: q.net, r: Math.max(q.radius * MM, 0.12) }; });
  };

  return {
    width: (all.x1 - all.x0) * MM, height: (all.y1 - all.y0) * MM,
    outlines, cutouts, parts, pads, traces, silk, holes, layerNames, copper, pours, vias, minTraceWidth: copper.length ? copper.reduce((m, c) => Math.min(m, c.w), Infinity) : 0.2,
    primarySide: board.primarySide === 'bottom' ? 'bottom' : 'top',
    toScene, pinsOf,
    pinPads: (index: number) => pinPadMap.get(index) ?? [],
  };
}

/** A rectangular land for one pin of an estimated package, in the Y-up frame:
 *  width along the body's X axis, height across, angle = the body's. Null for
 *  packages whose lands are round (BGA balls, test points, holes). */
function terminalPad(e: PartEstimate, pin: Point, radiusMm: number): { w: number; h: number; angle: number } | null {
  const a = e.rotDeg * Math.PI / 180, dx = (pin.x - e.cx) * MM, dy = (pin.y - e.cy) * MM;
  const lx = dx * Math.cos(a) + dy * Math.sin(a), ly = -dx * Math.sin(a) + dy * Math.cos(a); // pin in the body frame, mm
  const along = (w: number, h: number) => ({ w, h, angle: e.rotDeg }), across = (w: number, h: number) => ({ w: h, h: w, angle: e.rotDeg });
  switch (e.family) {
    case 'chip': case 'chip3t': return Math.abs(lx) >= Math.abs(ly) ? along(e.L * 0.5, e.W * 1.25) : across(e.W * 0.6, e.L * 0.3);
    case 'molded-cap': case 'inductor': case 'sod123': case 'sod323': return along(Math.max(e.L * 0.28, radiusMm * 2), e.W * 0.75);
    case 'sot23': case 'sot23-5': return across(0.6, 1.0);
    case 'soic': return across(Math.max(0.3, (e.p.pitch || 1.27) * 0.55), 1.5);
    case 'qfn': case 'son': case 'b2b': {
      const pitch = e.p.pitch || 0.5, len = e.family === 'b2b' ? 0.7 : 0.8;
      if (Math.abs(lx) < e.L * 0.3 && Math.abs(ly) < e.W * 0.3) return along(e.L * 0.6, e.W * 0.6); // exposed centre pad
      return Math.abs(lx) / e.L > Math.abs(ly) / e.W ? along(len, pitch * 0.55) : across(len, pitch * 0.55);
    }
    case 'conn': case 'usb-c': case 'header': return null;
    default: return null;
  }
}
