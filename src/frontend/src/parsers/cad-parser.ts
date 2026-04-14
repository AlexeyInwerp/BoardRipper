/**
 * GenCAD (.cad) Parser
 *
 * GenCAD is a plain-text PCB interchange format. This parser handles the
 * subset needed for boardview rendering:
 *
 *   $HEADER    — version, units, origin
 *   $SHAPES    — footprint definitions with pin positions
 *   $COMPONENTS — component placements (name, position, layer, rotation, shape)
 *   $DEVICES   — part descriptions (BOM info)
 *   $SIGNALS   — net connectivity (signal → component.pin nodes)
 *
 * Coordinates: GenCAD uses "UNITS USER <n>" where n is a divisor.
 * UNITS USER 1000 means raw coords are in mils × 1 (divisor applied at parse).
 *
 * Reference: GenCAD 1.4 specification, OpenBoardView GenCADFile.cpp
 */

import type { BoardData, Part, Pin, Nail, Point } from './types';
import { computeBBox, buildNets, computePartGeometry, generateSyntheticOutline } from './types';

const decoder = new TextDecoder('utf-8');

// ---------------------------------------------------------------------------
// Section extraction
// ---------------------------------------------------------------------------

/** Extract lines between $NAME and $ENDNAME (exclusive of both markers). */
function extractSection(lines: string[], name: string): string[] {
  const start = `$${name}`;
  const end   = `$END${name}`;
  const result: string[] = [];
  let inside = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === start) { inside = true; continue; }
    if (trimmed === end) break;
    if (inside) result.push(line);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Shape parsing (pin templates)
// ---------------------------------------------------------------------------

interface ShapePin {
  name: string;
  x: number;
  y: number;
  side: 'top' | 'bottom';
}

interface Shape {
  name: string;
  pins: ShapePin[];
  insertType: 'smd' | 'throughhole';
}

function parseShapes(lines: string[]): Map<string, Shape> {
  const shapes = new Map<string, Shape>();
  let current: Shape | null = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith('SHAPE ')) {
      // SHAPE <name>
      const name = line.substring(6).trim();
      current = { name, pins: [], insertType: 'smd' };
      shapes.set(name, current);
    } else if (line.startsWith('PIN ') && current) {
      // PIN <name> <padstack> <x> <y> <side> <rot> <mirror>
      const parts = line.split(/\s+/);
      if (parts.length >= 6) {
        const pinName = parts[1];
        const x = parseFloat(parts[3]);
        const y = parseFloat(parts[4]);
        const sideStr = (parts[5] ?? '').toUpperCase();
        const side: 'top' | 'bottom' = sideStr === 'BOTTOM' ? 'bottom' : 'top';
        if (!isNaN(x) && !isNaN(y)) {
          current.pins.push({ name: pinName, x, y, side });
        }
      }
    } else if (line.startsWith('INSERT ') && current) {
      const insert = line.substring(7).trim().toUpperCase();
      current.insertType = insert === 'TH' || insert === 'THROUGHHOLE' ? 'throughhole' : 'smd';
    }
  }

  // Some exports (e.g. concatenated/panelised .cad files) list each pin name
  // multiple times within one SHAPE block, once per merged revision. The
  // duplicate pin positions are not shape-local — they're residuals from the
  // source design's world placement — so blindly keeping them all produces a
  // huge bounding box and a diagonally-skewed part outline. Collapse each
  // pin-name group to the single position that lies closest to the shape's
  // local origin (the only cluster that is truly shape-relative).
  for (const shape of shapes.values()) {
    if (shape.pins.length > 0) {
      shape.pins = dedupeShapePins(shape.pins);
    }
  }

  return shapes;
}

/**
 * Collapse duplicate pin-name entries to one representative per pin name.
 *
 * A corrupted shape has each pin name listed multiple times, once per
 * coordinate frame (one per merged revision). Picking nearest-to-origin
 * per pin name independently scrambles multi-pin footprints (e.g. BGAs)
 * because different pin names can have their "nearest" entry in
 * different frames, producing a grid mixed from several revisions.
 *
 * Two-pass strategy:
 *
 * 1. Delta-based (handles the common 2-frame case, e.g. V382_20 QFNs
 *    and BGAs). Every pin with two distinct positions has them
 *    separated by the same revision-shift vector δ. Find the
 *    dominant δ across all pin-name pairs, then for every pin pick
 *    either the "low" or the "high" entry along δ consistently.
 *    Compare the two candidate frames by centroid-distance to
 *    origin; the winner is the shape-local frame.
 *
 * 2. Anchor-based fallback (handles 3+ frame cases like SO8_THERMAL
 *    where clusters are spatially distant). Try each entry of the
 *    most-duplicated pin as an anchor; for every other pin pick the
 *    entry closest to the anchor; score each candidate by centroid
 *    distance to origin and keep the best. Works when inter-cluster
 *    distance is much larger than the package span.
 *
 * Clean shapes with no duplicates return the input pins unchanged.
 */
function dedupeShapePins(pins: ShapePin[]): ShapePin[] {
  const groups = new Map<string, ShapePin[]>();
  const order: string[] = [];
  for (const p of pins) {
    let g = groups.get(p.name);
    if (!g) { g = []; groups.set(p.name, g); order.push(p.name); }
    g.push(p);
  }

  let hasDup = false;
  for (const g of groups.values()) if (g.length > 1) { hasDup = true; break; }
  if (!hasDup) return pins;

  const deltaResult = pickByDelta(groups, order);
  if (deltaResult) return deltaResult;

  return pickByAnchor(groups, order) ?? pins;
}

/** Unique-positions helper: dedupe (x, y) tuples with sub-mil tolerance. */
function uniquePositions(entries: ShapePin[]): ShapePin[] {
  const out: ShapePin[] = [];
  for (const e of entries) {
    let seen = false;
    for (const q of out) {
      if (Math.abs(q.x - e.x) < 0.01 && Math.abs(q.y - e.y) < 0.01) { seen = true; break; }
    }
    if (!seen) out.push(e);
  }
  return out;
}

/**
 * 2-frame delta-based dedup. Returns null if no consistent δ is found.
 */
function pickByDelta(
  groups: Map<string, ShapePin[]>,
  order: string[],
): ShapePin[] | null {
  // Bucket deltas between paired distinct entries. Tolerance 0.5 mil
  // absorbs float rounding between instances of the same vector.
  const TOL = 0.5;
  const deltas = new Map<string, { dx: number; dy: number; count: number }>();
  let totalPairs = 0;
  for (const name of order) {
    const uniq = uniquePositions(groups.get(name)!);
    if (uniq.length !== 2) continue;
    let dx = uniq[1].x - uniq[0].x;
    let dy = uniq[1].y - uniq[0].y;
    if (dx < 0 || (dx === 0 && dy < 0)) { dx = -dx; dy = -dy; }
    const bx = Math.round(dx / TOL) * TOL;
    const by = Math.round(dy / TOL) * TOL;
    const key = bx + ':' + by;
    const prev = deltas.get(key);
    if (prev) prev.count++;
    else deltas.set(key, { dx: bx, dy: by, count: 1 });
    totalPairs++;
  }
  if (totalPairs === 0) return null;

  let best: { dx: number; dy: number; count: number } | null = null;
  for (const d of deltas.values()) if (!best || d.count > best.count) best = d;
  if (!best || best.count / totalPairs < 0.8) return null;

  const { dx, dy } = best;
  const pickLow: ShapePin[] = [];
  const pickHigh: ShapePin[] = [];
  let lowX = 0, lowY = 0, highX = 0, highY = 0;
  for (const name of order) {
    const g = groups.get(name)!;
    let lo = g[0], hi = g[0];
    let loDot = lo.x * dx + lo.y * dy;
    let hiDot = loDot;
    for (let i = 1; i < g.length; i++) {
      const q = g[i];
      const qd = q.x * dx + q.y * dy;
      if (qd < loDot) { lo = q; loDot = qd; }
      if (qd > hiDot) { hi = q; hiDot = qd; }
    }
    pickLow.push(lo); pickHigh.push(hi);
    lowX += lo.x; lowY += lo.y;
    highX += hi.x; highY += hi.y;
  }
  const n = order.length;
  const loScore = (lowX / n) ** 2 + (lowY / n) ** 2;
  const hiScore = (highX / n) ** 2 + (highY / n) ** 2;
  return loScore <= hiScore ? pickLow : pickHigh;
}

/**
 * Anchor-based dedup. Used for 3+ frame cases (SO8 and similar)
 * where clusters are spatially distant (intra-cluster distance ≪
 * inter-cluster distance), so nearest-neighbor from an anchor
 * reliably stays in the same frame.
 */
function pickByAnchor(
  groups: Map<string, ShapePin[]>,
  order: string[],
): ShapePin[] | null {
  let anchorName = order[0];
  let maxEntries = 0;
  for (const name of order) {
    const n = groups.get(name)!.length;
    if (n > maxEntries) { maxEntries = n; anchorName = name; }
  }

  const anchorCandidates = groups.get(anchorName)!;
  let bestResult: ShapePin[] | null = null;
  let bestScore = Infinity;
  for (const anchor of anchorCandidates) {
    const picked: ShapePin[] = [];
    let sumX = 0, sumY = 0;
    for (const name of order) {
      const g = groups.get(name)!;
      let best = g[0];
      let bestD = (best.x - anchor.x) ** 2 + (best.y - anchor.y) ** 2;
      for (let i = 1; i < g.length; i++) {
        const q = g[i];
        const d = (q.x - anchor.x) ** 2 + (q.y - anchor.y) ** 2;
        if (d < bestD) { best = q; bestD = d; }
      }
      picked.push(best);
      sumX += best.x;
      sumY += best.y;
    }
    const cx = sumX / picked.length;
    const cy = sumY / picked.length;
    const score = cx * cx + cy * cy;
    if (score < bestScore) { bestScore = score; bestResult = picked; }
  }
  return bestResult;
}

// ---------------------------------------------------------------------------
// Component parsing
// ---------------------------------------------------------------------------

interface Component {
  name: string;
  placeX: number;
  placeY: number;
  layer: 'top' | 'bottom';
  rotation: number;
  shapeName: string;
  deviceName: string;
}

function parseComponents(lines: string[]): Component[] {
  const components: Component[] = [];
  let current: Partial<Component> | null = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith('COMPONENT ')) {
      if (current?.name) components.push(current as Component);
      current = {
        name: line.substring(10).trim(),
        placeX: 0, placeY: 0,
        layer: 'top', rotation: 0,
        shapeName: '', deviceName: '',
      };
    } else if (current) {
      if (line.startsWith('PLACE ')) {
        const parts = line.split(/\s+/);
        current.placeX = parseFloat(parts[1] ?? '0');
        current.placeY = parseFloat(parts[2] ?? '0');
      } else if (line.startsWith('LAYER ')) {
        current.layer = line.substring(6).trim().toUpperCase() === 'BOTTOM' ? 'bottom' : 'top';
      } else if (line.startsWith('ROTATION ')) {
        current.rotation = parseFloat(line.substring(9).trim()) || 0;
      } else if (line.startsWith('SHAPE ')) {
        // SHAPE <name> <mirrorX> <mirrorY>
        current.shapeName = line.split(/\s+/)[1] ?? '';
      } else if (line.startsWith('DEVICE ')) {
        current.deviceName = line.substring(7).trim();
      }
    }
  }
  if (current?.name) components.push(current as Component);

  // Some exporters accumulate every prior revision of the board into the
  // same .cad file as a sequence of concatenated passes. Example:
  // V382_20.cad = [rev1.1 pass] [rev1.0 additions pass] [rev2.0 pass].
  // Each pass is a complete component list for that revision, and
  // refdes can be repurposed between revisions (e.g. U503 is a QFN033
  // DRMOS in rev1.x but a DFN10 current-sense amp in rev2.0). Keeping
  // any mix of passes produces ghost placements and wrong packages.
  //
  // The canonical revision is always the *last* pass — that's the one
  // the file is named after. Detect pass boundaries by resetting the
  // per-pass seen-set the first time a refdes repeats, then keep only
  // components assigned to the highest pass number. Clean files with
  // no duplicates stay in pass 1 and pass through unchanged.
  let pass = 1;
  let seen = new Set<string>();
  const passOf: number[] = new Array(components.length);
  for (let i = 0; i < components.length; i++) {
    const name = components[i].name;
    if (seen.has(name)) {
      pass++;
      seen = new Set();
    }
    seen.add(name);
    passOf[i] = pass;
  }
  if (pass === 1) return components;
  return components.filter((_, i) => passOf[i] === pass);
}

// ---------------------------------------------------------------------------
// Signal (net) parsing
// ---------------------------------------------------------------------------

/** Returns map of "component.pin" → net name */
function parseSignals(lines: string[]): Map<string, string> {
  const pinNetMap = new Map<string, string>();
  let currentSignal = '';

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith('SIGNAL ')) {
      currentSignal = line.substring(7).trim();
    } else if (line.startsWith('NODE ') && currentSignal) {
      // NODE <component> <pin>
      const parts = line.split(/\s+/);
      if (parts.length >= 3) {
        const key = `${parts[1]}.${parts[2]}`;
        pinNetMap.set(key, currentSignal);
      }
    }
  }

  return pinNetMap;
}

// ---------------------------------------------------------------------------
// Main parser
// ---------------------------------------------------------------------------

export function parseCAD(buffer: ArrayBuffer): BoardData {
  const text = decoder.decode(buffer);
  const lines = text.split(/\r?\n/);

  // Parse sections
  // Note: UNITS USER 1000 means "1000 units per inch" = coordinates are in mils.
  // Our internal coordinate system is mils, so no conversion needed.
  const shapes     = parseShapes(extractSection(lines, 'SHAPES'));
  const components = parseComponents(extractSection(lines, 'COMPONENTS'));
  const pinNetMap  = parseSignals(extractSection(lines, 'SIGNALS'));

  // Some shapes in V382-style exports are left with stale world
  // coordinates leaked from a previous instance (e.g. PDFN8/DFN8 in
  // V382_20.cad whose 9 pins sit near (-1829, -910) instead of at
  // origin). These aren't revision duplicates — each pin has a
  // single entry — so dedup never touches them. We recenter them
  // here by subtracting the centroid. Quanta-style files use the
  // opposite convention (shape pins in world coords, components at
  // PLACE 0 0), so we only recenter a shape if at least one of its
  // referring components is placed at a non-zero PLACE. That keeps
  // world-absolute files untouched while fixing broken shape-local
  // definitions.
  const shapeUsers = new Map<string, Component[]>();
  for (const c of components) {
    let list = shapeUsers.get(c.shapeName);
    if (!list) { list = []; shapeUsers.set(c.shapeName, list); }
    list.push(c);
  }
  const CENTROID_TOL_SQ = 100 * 100;
  for (const [name, shape] of shapes.entries()) {
    if (shape.pins.length === 0) continue;
    let sx = 0, sy = 0;
    for (const p of shape.pins) { sx += p.x; sy += p.y; }
    const cx = sx / shape.pins.length;
    const cy = sy / shape.pins.length;
    if (cx * cx + cy * cy < CENTROID_TOL_SQ) continue;
    const users = shapeUsers.get(name);
    if (!users) continue;
    let anyPlaced = false;
    for (const u of users) {
      if (u.placeX !== 0 || u.placeY !== 0) { anyPlaced = true; break; }
    }
    if (!anyPlaced) continue;
    for (const p of shape.pins) { p.x -= cx; p.y -= cy; }
  }

  // Assemble parts
  const parts: Part[] = [];

  for (const comp of components) {
    const shape = shapes.get(comp.shapeName);
    if (!shape) continue;

    const pins: Pin[] = [];
    for (const sp of shape.pins) {
      // Apply component placement offset + rotation
      let px = sp.x, py = sp.y;
      if (comp.rotation !== 0) {
        const rad = (comp.rotation * Math.PI) / 180;
        const cos = Math.cos(rad), sin = Math.sin(rad);
        const rx = px * cos - py * sin;
        const ry = px * sin + py * cos;
        px = rx; py = ry;
      }
      px += comp.placeX;
      py += comp.placeY;

      // Look up net
      const netKey = `${comp.name}.${sp.name}`;
      const net = pinNetMap.get(netKey) ?? '';

      const side = comp.layer === 'bottom' ? 'bottom' : sp.side;

      pins.push({
        name:     sp.name,
        number:   sp.name,
        position: { x: px, y: py },
        radius:   6,
        side,
        net,
      });
    }

    const { origin, bounds } = computePartGeometry(pins);

    parts.push({
      name:   comp.name,
      side:   comp.layer,
      type:   shape.insertType,
      origin,
      pins,
      bounds,
    });
  }

  // No nails in GenCAD (test points would need $TESTPINS section)
  const nails: Nail[] = [];

  if (parts.length === 0) {
    throw new Error('CAD file parsed but contains no parts — file may be corrupt or empty');
  }

  // Board outline — GenCAD $BOARD section can define it, but often empty.
  // Generate from pin bounds like FZ.
  const allPoints: Point[] = parts.flatMap(p => p.pins.map(pin => pin.position));
  const outline = generateSyntheticOutline(allPoints);

  const bounds = computeBBox([...outline, ...allPoints]);
  const nets = buildNets(parts);

  return { format: 'CAD', outline, parts, nails, nets, bounds };
}
