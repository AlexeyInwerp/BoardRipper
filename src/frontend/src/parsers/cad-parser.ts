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

import type { BoardData, BoardRevision, Part, Pin, Nail, Point, Trace, Via } from './types';
import { computeBBox, buildNets, computePartGeometry, generateSyntheticOutline, detectGhostComponents, detectBomAlternateClusters } from './types';
import { detectXMirrorByPinDirection, applyXMirrorInPlace } from './mirror-detect';
import { log } from '../store/log-store';

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

interface ParsedComponents {
  components: Component[];
  /** 1-based pass index per component (same length as components). */
  passOf: number[];
  /** Total number of detected passes. 1 = clean file, no revisions. */
  passCount: number;
}

function parseComponents(lines: string[]): ParsedComponents {
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
  // DRMOS in rev1.x but a DFN10 current-sense amp in rev2.0).
  //
  // We keep every component but tag each with its pass number so the
  // caller can build per-revision part lists and expose a revision
  // picker. Pass boundaries are detected by resetting a per-pass
  // seen-refdes set the first time a refdes repeats. Clean files with
  // no duplicates stay in pass 1 throughout.
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
  return { components, passOf, passCount: pass };
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
// Track width table ($TRACKS)
// ---------------------------------------------------------------------------

function parseTracks(lines: string[]): Map<string, number> {
  const tracks = new Map<string, number>();
  for (const raw of lines) {
    const line = raw.trim();
    if (!line.startsWith('TRACK ')) continue;
    const parts = line.split(/\s+/);
    if (parts.length >= 3) {
      const width = parseFloat(parts[2]);
      if (!isNaN(width)) tracks.set(parts[1], width);
    }
  }
  return tracks;
}

// ---------------------------------------------------------------------------
// Routes parsing ($ROUTES) — multilayer traces + vias
// ---------------------------------------------------------------------------

interface RoutesResult {
  traces: Trace[];
  vias: Via[];
  layerNames: string[];
}

function parseRoutes(lines: string[], tracks: Map<string, number>, passCount: number): RoutesResult {
  // Multi-revision CAD files (e.g. V382_20) concatenate each revision's
  // route data WITHIN each ROUTE block. A single ROUTE block for net X
  // contains [rev1 VIAs+traces][rev2 VIAs+traces][rev3 VIAs+traces].
  // Revision boundaries are marked by a VIA whose position already appeared
  // earlier in the same ROUTE block. We only keep the last revision pass
  // per route block, matching the component pass convention.
  //
  // Strategy: two-pass per ROUTE block.
  //   Pass 1: scan for VIA-coordinate repeats to find last-pass start index.
  //   Pass 2: parse only from that index onward.

  // First, split lines into per-route blocks: [startIdx, endIdx) pairs.
  const routeBlocks: { net: string; start: number; end: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('ROUTE ')) {
      if (routeBlocks.length > 0) routeBlocks[routeBlocks.length - 1].end = i;
      routeBlocks.push({ net: line.substring(6).trim(), start: i, end: lines.length });
    }
  }
  if (routeBlocks.length > 0) routeBlocks[routeBlocks.length - 1].end = lines.length;

  const allTraces: Trace[] = [];
  const allVias: Via[] = [];
  const layerNameOrder: string[] = [];
  const layerIndexOf = new Map<string, number>();

  function ensureLayer(name: string): number {
    let idx = layerIndexOf.get(name);
    if (idx === undefined) {
      idx = layerNameOrder.length;
      layerNameOrder.push(name.charAt(0).toUpperCase() + name.slice(1).toLowerCase());
      layerIndexOf.set(name, idx);
    }
    return idx;
  }

  for (const block of routeBlocks) {
    // Find last revision pass start within this route block.
    // Multi-revision files concatenate each revision's routing inside the
    // same ROUTE block. Boundaries are detected two ways:
    //   1. A VIA coordinate that already appeared earlier (same VIA set
    //      re-declared for a new revision).
    //   2. A VIA or TRACK line appearing after trace content (LINE/ARC)
    //      has already been emitted — indicates a new routing pass.
    // Scan for revision boundaries. Three markers:
    //  (a) VIA coordinate repeat (same VIA declared again for new pass)
    //  (b) VIA appearing after trace content, IF more traces follow it
    //      (distinguishes V382's "VIA-before-new-pass" from Avalon7's
    //       "VIA-at-end-of-route")
    //  (c) TRACK after trace content in multi-revision files only
    //      (handles no-VIA routes like XTALOUT; safe because single-rev
    //       files have passCount=1 and skip this rule)
    const isMultiRev = passCount > 1;
    const seenViaCoords = new Set<string>();
    let lastPassStart = block.start + 1;
    let hasTraceContent = false;
    for (let i = block.start + 1; i < block.end; i++) {
      const line = lines[i].trim();
      if (line.startsWith('LINE ') || line.startsWith('ARC ')) {
        hasTraceContent = true;
        continue;
      }
      if (line.startsWith('VIA ')) {
        const p = line.split(/\s+/);
        if (p.length >= 4) {
          const key = `${p[2]},${p[3]}`;
          const isRepeat = seenViaCoords.has(key);
          if (isRepeat || hasTraceContent) {
            // Check if traces follow this VIA group (look ahead past VIAs)
            let hasMoreTraces = false;
            for (let j = i + 1; j < block.end; j++) {
              const ahead = lines[j].trim();
              if (ahead.startsWith('VIA ')) continue;
              if (ahead.startsWith('LINE ') || ahead.startsWith('ARC ')) { hasMoreTraces = true; break; }
              if (ahead.startsWith('TRACK ') || ahead.startsWith('LAYER ')) continue;
              break;
            }
            if (isRepeat || hasMoreTraces) {
              lastPassStart = i;
              seenViaCoords.clear();
              hasTraceContent = false;
            }
          }
          seenViaCoords.add(key);
        }
        continue;
      }
      // In multi-rev files, a TRACK switch after traces = revision boundary
      // for routes that have no VIAs (e.g. XTALOUT). Single-rev files
      // legitimately switch tracks mid-route, so this rule is gated.
      if (isMultiRev && hasTraceContent && line.startsWith('TRACK ')) {
        lastPassStart = i;
        hasTraceContent = false;
      }
    }

    // For multi-rev routes with no VIA and no TRACK change (e.g.
    // UNNAMED_37_CAP_I169_A), the block is N identical copies of
    // the route. Split by dividing trace lines evenly by passCount.
    if (isMultiRev && lastPassStart === block.start + 1) {
      let traceLineCount = 0;
      for (let i = block.start + 1; i < block.end; i++) {
        const line = lines[i].trim();
        if (line.startsWith('LINE ') || line.startsWith('ARC ')) traceLineCount++;
      }
      if (traceLineCount > 0 && traceLineCount % passCount === 0) {
        const perPass = traceLineCount / passCount;
        const skipLines = perPass * (passCount - 1);
        let skipped = 0;
        for (let i = block.start + 1; i < block.end; i++) {
          const line = lines[i].trim();
          if (line.startsWith('LINE ') || line.startsWith('ARC ')) {
            skipped++;
            if (skipped === skipLines) { lastPassStart = i + 1; break; }
          }
        }
      }
    }

    // Parse only from lastPassStart onward
    let currentLayerIdx = 0;
    let currentWidth = 5;
    for (let i = lastPassStart; i < block.end; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      if (line.startsWith('LAYER ')) {
        currentLayerIdx = ensureLayer(line.substring(6).trim().toUpperCase());
      } else if (line.startsWith('TRACK ')) {
        const trackName = line.split(/\s+/)[1] ?? '';
        currentWidth = tracks.get(trackName) ?? 5;
      } else if (line.startsWith('LINE ')) {
        const p = line.split(/\s+/);
        if (p.length >= 5) {
          const x1 = parseFloat(p[1]), y1 = parseFloat(p[2]);
          const x2 = parseFloat(p[3]), y2 = parseFloat(p[4]);
          if (!isNaN(x1) && !isNaN(y1) && !isNaN(x2) && !isNaN(y2)) {
            allTraces.push({
              start: { x: x1, y: y1 },
              end: { x: x2, y: y2 },
              width: currentWidth,
              net: block.net,
              layer: currentLayerIdx,
            });
          }
        }
      } else if (line.startsWith('ARC ')) {
        const p = line.split(/\s+/);
        if (p.length >= 7) {
          const x1 = parseFloat(p[1]), y1 = parseFloat(p[2]);
          const x2 = parseFloat(p[3]), y2 = parseFloat(p[4]);
          const cx = parseFloat(p[5]), cy = parseFloat(p[6]);
          if (!isNaN(x1) && !isNaN(cx)) {
            tessellateArc(x1, y1, x2, y2, cx, cy, currentWidth, block.net, currentLayerIdx, allTraces);
          }
        }
      } else if (line.startsWith('VIA ')) {
        const p = line.split(/\s+/);
        if (p.length >= 4) {
          const padstack = p[1];
          const x = parseFloat(p[2]), y = parseFloat(p[3]);
          if (!isNaN(x) && !isNaN(y)) {
            const diameter = drillFromPadstack(padstack);
            allVias.push({
              position: { x, y },
              diameter,
              net: block.net,
              layers: [],
            });
          }
        }
      }
    }
  }

  // Deduplicate traces with identical coordinates (multi-rev files without
  // VIAs or TRACK switches produce exact duplicates from concatenated passes).
  const seen = new Set<string>();
  const dedupedTraces: Trace[] = [];
  for (const t of allTraces) {
    const key = `${t.net},${t.layer},${t.start.x},${t.start.y},${t.end.x},${t.end.y}`;
    if (!seen.has(key)) {
      seen.add(key);
      dedupedTraces.push(t);
    }
  }

  return { traces: dedupedTraces, vias: allVias, layerNames: layerNameOrder };
}

function drillFromPadstack(name: string): number {
  // PAD_VIA22D12 → drill=12, PAD_VIA20D10A32 → drill=10
  const m = name.match(/D(\d+)(?:[A-Z_]|$)/i);
  return m ? parseFloat(m[1]) : 10;
}

function tessellateArc(
  x1: number, y1: number, x2: number, y2: number,
  cx: number, cy: number,
  width: number, net: string, layer: number,
  out: Trace[],
): void {
  const radius = Math.sqrt((x1 - cx) ** 2 + (y1 - cy) ** 2);
  if (radius <= 0) {
    out.push({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, width, net, layer });
    return;
  }

  const startAngle = Math.atan2(y1 - cy, x1 - cx);
  const endAngle = Math.atan2(y2 - cy, x2 - cx);

  // GenCAD convention: shorter arc (CCW by default)
  let sweep = endAngle - startAngle;
  if (sweep > Math.PI) sweep -= 2 * Math.PI;
  if (sweep < -Math.PI) sweep += 2 * Math.PI;

  const steps = Math.max(2, Math.ceil(Math.abs(sweep) / (Math.PI / 18)));
  const dAngle = sweep / steps;

  let prevX = x1, prevY = y1;
  for (let i = 1; i <= steps; i++) {
    const nx = i === steps ? x2 : cx + radius * Math.cos(startAngle + dAngle * i);
    const ny = i === steps ? y2 : cy + radius * Math.sin(startAngle + dAngle * i);
    out.push({ start: { x: prevX, y: prevY }, end: { x: nx, y: ny }, width, net, layer });
    prevX = nx;
    prevY = ny;
  }
}

// ---------------------------------------------------------------------------
// Test pins + power pins ($TESTPINS, $POWERPINS)
// ---------------------------------------------------------------------------

function parseTestpins(lines: string[]): Nail[] {
  const nails: Nail[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line.startsWith('TESTPIN ') && !line.startsWith('POWERPIN ')) continue;
    const p = line.split(/\s+/);
    // TESTPIN <name> <x> <y> <net> <altName> <code> <type> <side>
    if (p.length >= 5) {
      const x = parseFloat(p[2]), y = parseFloat(p[3]);
      const net = p[4] ?? '';
      const sideStr = (p[p.length - 1] ?? '').toUpperCase();
      const side: 'top' | 'bottom' = sideStr === 'TOP' ? 'top' : 'bottom';
      if (!isNaN(x) && !isNaN(y)) {
        nails.push({ position: { x, y }, side, net });
      }
    }
  }
  return nails;
}

// ---------------------------------------------------------------------------
// Mechanical features ($MECH)
// ---------------------------------------------------------------------------

function parseMech(lines: string[]): Via[] {
  const holes: Via[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line.startsWith('FHOLE ')) continue;
    const p = line.split(/\s+/);
    if (p.length >= 4) {
      const x = parseFloat(p[1]), y = parseFloat(p[2]);
      const diameter = parseFloat(p[3]);
      if (!isNaN(x) && !isNaN(y) && !isNaN(diameter)) {
        holes.push({ position: { x, y }, diameter, net: '', layers: [] });
      }
    }
  }
  return holes;
}

// ---------------------------------------------------------------------------
// Main parser
// ---------------------------------------------------------------------------

export function parseCAD(buffer: ArrayBuffer): BoardData {
  const text = decoder.decode(buffer);
  const lines = text.split(/\r?\n/);

  // Extract GENCAD version from header (e.g. "GENCAD 1.4")
  const headerLines = extractSection(lines, 'HEADER');
  let formatVersion: string | undefined;
  for (const raw of headerLines) {
    const line = raw.trim();
    if (line.startsWith('GENCAD ')) {
      formatVersion = line;
      break;
    }
  }

  // Parse sections
  // Note: UNITS USER 1000 means "1000 units per inch" = coordinates are in mils.
  // Our internal coordinate system is mils, so no conversion needed.
  const shapes     = parseShapes(extractSection(lines, 'SHAPES'));
  const parsedComps = parseComponents(extractSection(lines, 'COMPONENTS'));
  const components = parsedComps.components;
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
  // A shape qualifies for recentering when its pin centroid sits clearly
  // off-origin — more than 2× the shape's own half-extent in at least one
  // axis. This catches shapes with stale world coordinates from concatenated
  // exports (common in Teradyne GenCAM files) regardless of package size.
  // Connectors and mechanical parts with legitimately asymmetric pin layouts
  // have centroids close to their extent, so the ratio check leaves them alone.
  for (const [name, shape] of shapes.entries()) {
    if (shape.pins.length === 0) continue;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of shape.pins) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    const w = maxX - minX, h = maxY - minY;
    const halfW = w * 0.5 || 1;
    const halfH = h * 0.5 || 1;
    const bcx = (minX + maxX) * 0.5;
    const bcy = (minY + maxY) * 0.5;
    const offsetRatio = Math.max(Math.abs(bcx) / halfW, Math.abs(bcy) / halfH);
    if (offsetRatio < 2) continue;
    const users = shapeUsers.get(name);
    if (!users) continue;
    let anyPlaced = false;
    for (const u of users) {
      if (u.placeX !== 0 || u.placeY !== 0) { anyPlaced = true; break; }
    }
    if (!anyPlaced) continue;
    // Subtract the centroid (mean of pin coords) — for shapes where bbox
    // center matches centroid, this is equivalent. Using centroid handles
    // shapes with one outlier pin (e.g. thermal pad) more gracefully.
    let sx = 0, sy = 0;
    for (const p of shape.pins) { sx += p.x; sy += p.y; }
    const cx = sx / shape.pins.length;
    const cy = sy / shape.pins.length;
    for (const p of shape.pins) { p.x -= cx; p.y -= cy; }
  }

  // Assemble parts grouped by pass so we can emit one BoardRevision per
  // detected revision. Pass 1 is the "base" pass for clean files (no
  // duplicates) and is the only pass for every other format/sample.
  const partsByPass: Part[][] = Array.from({ length: parsedComps.passCount }, () => []);

  for (let i = 0; i < components.length; i++) {
    const comp = components[i];
    const shape = shapes.get(comp.shapeName);
    if (!shape) continue;

    const pins: Pin[] = [];
    for (const sp of shape.pins) {
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

    partsByPass[parsedComps.passOf[i] - 1].push({
      name:   comp.name,
      side:   comp.layer,
      type:   shape.insertType,
      origin,
      pins,
      bounds,
      // Surface DEVICE/SHAPE for ComponentInfo and BOM-alternate detection.
      // The BOM-cluster heuristic depends on `meta.value` to distinguish
      // shape-suffixed primary devices (e.g. `0.22uh_IND_NONRKO_TH_100X072_B`)
      // from bare-named alternates (e.g. `0.22uh`).
      meta: {
        value:   comp.deviceName || undefined,
        package: comp.shapeName  || undefined,
      },
    });
  }

  // Multilayer data (additive — no-ops for files without these sections)
  const trackWidths = parseTracks(extractSection(lines, 'TRACKS'));
  const routes      = parseRoutes(extractSection(lines, 'ROUTES'), trackWidths, parsedComps.passCount);
  const testpins    = parseTestpins(extractSection(lines, 'TESTPINS'));
  const powerpins   = parseTestpins(extractSection(lines, 'POWERPINS'));
  const mechHoles   = parseMech(extractSection(lines, 'MECH'));

  const nails: Nail[] = [...testpins, ...powerpins];

  // Detect an X-mirror via chip pin-numbering direction (IPC-7351: pins run
  // CCW on top-mounted chips when viewed from above, CW on bottom-mounted).
  // The heuristic runs on already-assembled world-coord pins, so it's
  // independent of how any given format lays out its shape data. If the
  // verdict trips, mirror every world coord we produced — parts, nails,
  // traces, vias, and mech holes — so downstream (butterfly fold, revision
  // build, outline synthesis) sees the corrected geometry.
  const allParts = partsByPass.flat();
  const mirrorVerdict = detectXMirrorByPinDirection(allParts);
  {
    const pct = isNaN(mirrorVerdict.wrongRatio) ? 'n/a' : (mirrorVerdict.wrongRatio * 100).toFixed(0) + '%';
    const diag = `top-CCW=${mirrorVerdict.topCCW} top-CW=${mirrorVerdict.topCW} (wrong=${pct} of ${mirrorVerdict.totalAnalyzed}), bottom-CCW=${mirrorVerdict.bottomCCW} bottom-CW=${mirrorVerdict.bottomCW}`;
    if (mirrorVerdict.mirrored) {
      log.parser.warn(`X-mirror detected via QFN pin-direction heuristic; un-mirroring board. ${diag}`);
    } else if (mirrorVerdict.totalAnalyzed >= 10) {
      log.parser.log(`X-mirror check: clean. ${diag}`);
    } else {
      log.parser.log(`X-mirror check: insufficient data (${mirrorVerdict.totalAnalyzed} top-side chips, need ≥10). ${diag}`);
    }
  }
  if (mirrorVerdict.mirrored) {
    applyXMirrorInPlace(allParts, nails, routes.traces, [...routes.vias, ...mechHoles]);
  }

  // Butterfly unfold: some CAMCAD exports (e.g. Apple 820-02841) place
  // bottom-side components at mirrored X (or Y) relative to the top side,
  // producing an already-unfolded "butterfly" layout. Rendering it as a
  // single-side board yields a 2×-wide outline and a view that looks
  // mirrored after flipping (stored bottom pins are already in bottom-POV,
  // so the renderer's bottom-view X-negation re-flips them). Detect this
  // pattern and fold the bottom half back onto the top so both sides share
  // the same world coordinate frame.
  const butterflyFold = unfoldButterflyIfPresent(partsByPass, nails, routes.traces, routes.vias);

  // Build a per-revision BoardRevision blob (parts + outline + bounds + nets).
  const hasTraces = routes.traces.length > 0;
  const hasMultiplePasses = parsedComps.passCount > 1;

  // Detect merged-board files: if the overlap between passes is low
  // relative to the smaller pass, these are likely different boards
  // concatenated rather than revisions of one board.
  let isMergedBoards = false;
  if (hasMultiplePasses) {
    const passNames: Set<string>[] = partsByPass.map(
      parts => new Set(parts.map(p => p.name)),
    );
    // Check each adjacent pair
    for (let i = 1; i < passNames.length; i++) {
      const prev = passNames[i - 1];
      const curr = passNames[i];
      const smaller = Math.min(prev.size, curr.size);
      let shared = 0;
      for (const n of curr) if (prev.has(n)) shared++;
      // If less than 90% of the smaller set is shared, these are
      // different boards rather than revisions of the same board.
      if (smaller > 0 && shared / smaller < 0.9) { isMergedBoards = true; break; }
    }
  }

  // Assign traces per-revision when multiple passes exist.
  // Uses connected-component analysis: for each net's trace graph,
  // find connected subgraphs and assign each to the revision whose
  // pin positions it physically touches.
  const perRevTraces: Trace[][] | null = (hasMultiplePasses && hasTraces)
    ? assignTracesToRevisions(routes.traces, partsByPass, isMergedBoards)
    : null;
  const perRevVias: Via[][] | null = (hasMultiplePasses && routes.vias.length > 0)
    ? assignViasToRevisions(routes.vias, partsByPass, isMergedBoards)
    : null;

  const revisions: BoardRevision[] = partsByPass.map((parts, idx) => {
    const allPoints: Point[] = parts.flatMap(p => p.pins.map(pin => pin.position));
    const outline = generateSyntheticOutline(allPoints);
    const bounds = computeBBox([...outline, ...allPoints]);
    const nets = buildNets(parts);
    const ghosts = detectGhostComponents(parts);
    const bomClusters = detectBomAlternateClusters(parts);
    const total = partsByPass.length;
    const isCurrent = idx === total - 1;
    let label: string;
    if (total === 1) {
      label = 'rev 1';
    } else if (isMergedBoards) {
      label = `Board ${String.fromCharCode(65 + idx)}`;
    } else {
      label = `rev ${idx + 1}${isCurrent ? ' (current)' : ''}`;
    }
    const rev: BoardRevision = {
      index: idx + 1,
      label,
      componentCount: parts.length,
      parts,
      bounds,
      outline,
      nets,
      ghosts,
    };
    if (bomClusters.length > 0) rev.bomClusters = bomClusters;
    if (perRevTraces) rev.traces = perRevTraces[idx];
    if (perRevVias) {
      const revVias = perRevVias[idx];
      if (idx === total - 1) {
        // Add mech holes to the last revision
        rev.vias = [...revVias, ...mechHoles];
      } else {
        rev.vias = revVias;
      }
    }
    if (hasTraces && routes.layerNames.length > 0) {
      rev.layerNames = routes.layerNames;
    }
    return rev;
  });

  // Default active = last pass (the canonical revision the file is named after).
  const active = revisions[revisions.length - 1];
  if (!active || active.parts.length === 0) {
    throw new Error('CAD file parsed but contains no parts — file may be corrupt or empty');
  }

  // Ensure nail-only nets are registered in the active revision's net map
  for (const nail of nails) {
    if (nail.net && !active.nets.has(nail.net)) {
      active.nets.set(nail.net, { name: nail.net, pinIndices: [] });
    }
  }

  // For clean single-pass files we don't expose the revisions UI — the
  // top-level fields alone are sufficient.
  const board: BoardData = {
    format: 'CAD',
    outline: active.outline,
    parts:   active.parts,
    nails,
    nets:    active.nets,
    bounds:  active.bounds,
  };
  if (formatVersion) board.formatVersion = formatVersion;
  if (active.ghosts.length > 0) board.ghosts = active.ghosts;
  if (active.bomClusters && active.bomClusters.length > 0) board.bomClusters = active.bomClusters;
  if (mirrorVerdict.mirrored) {
    const pct = (mirrorVerdict.wrongRatio * 100).toFixed(0);
    board.parserNotes = [
      `Board was horizontally un-mirrored on load — ${pct}% of ${mirrorVerdict.totalAnalyzed} analyzed top-side chips had CW pin numbering (IPC-7351 convention expects CCW from chip top), indicating an X-flipped layout in source.`,
    ];
  }
  if (revisions.length > 1) {
    board.revisions = revisions;
    board.activeRevision = active.index;
  }

  // Butterfly-unfolded boards auto-rotate 270° (they're taller than wide after
  // fold), which swaps scene and screen axes. The default flipAxis='x' would
  // then produce an X-mirror on screen when viewing the bottom side. Setting
  // flipAxis to the perpendicular of the fold axis keeps the bottom-view flip
  // visually a Y-mirror on screen, matching the intuitive "hinge on a long
  // edge" convention that non-rotated CAD files already exhibit.
  if (butterflyFold) {
    board.flipAxis = butterflyFold.dim === 'x' ? 'y' : 'x';
  }

  // Multilayer fields on top-level board (from active revision or global)
  const activeTraces = active.traces ?? routes.traces;
  if (activeTraces.length > 0) {
    board.traces = activeTraces;
    const allVias = active.vias ?? [...routes.vias, ...mechHoles];
    if (allVias.length > 0) board.vias = allVias;
    const layerNames = active.layerNames ?? (routes.layerNames.length > 0 ? routes.layerNames : undefined);
    if (layerNames) board.layerNames = layerNames;
  } else if (mechHoles.length > 0) {
    board.vias = mechHoles;
  }

  return board;
}

// ---------------------------------------------------------------------------
// Per-revision trace assignment via connected-component pin proximity
// ---------------------------------------------------------------------------

const PROX_TOL = 20; // mils — bucket size for spatial hashing

function buildPinBuckets(parts: Part[]): Set<string> {
  const s = new Set<string>();
  for (const p of parts) {
    for (const pin of p.pins) {
      const kx = Math.round(pin.position.x / PROX_TOL);
      const ky = Math.round(pin.position.y / PROX_TOL);
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++)
          s.add((kx + dx) + ',' + (ky + dy));
    }
  }
  return s;
}

function traceKey(x: number, y: number): string {
  return Math.round(x / PROX_TOL) + ',' + Math.round(y / PROX_TOL);
}

/**
 * Assign traces to revisions using connected-component analysis.
 * For each net, build a graph of trace endpoints, find connected subgraphs,
 * then assign each subgraph to the revision whose pin positions it touches.
 *
 * For true revisions: multi-touch subgraphs go to the last (current) revision.
 * For merged boards: multi-touch subgraphs are duplicated to ALL touching boards.
 */
function assignTracesToRevisions(
  traces: Trace[],
  partsByPass: Part[][],
  merged: boolean,
): Trace[][] {
  const passCount = partsByPass.length;
  const result: Trace[][] = Array.from({ length: passCount }, () => []);
  const pinSets = partsByPass.map(buildPinBuckets);

  // Group traces by net
  const byNet = new Map<string, Trace[]>();
  for (const t of traces) {
    let arr = byNet.get(t.net);
    if (!arr) { arr = []; byNet.set(t.net, arr); }
    arr.push(t);
  }

  for (const [, netTraces] of byNet) {
    if (netTraces.length === 0) continue;

    // Union-Find on bucketed endpoints
    const parent = new Map<string, string>();
    function find(x: string): string {
      let r = x;
      while (parent.get(r) !== r) r = parent.get(r)!;
      let c = x;
      while (c !== r) { const n = parent.get(c)!; parent.set(c, r); c = n; }
      return r;
    }
    function union(a: string, b: string) {
      const ra = find(a), rb = find(b);
      if (ra !== rb) parent.set(ra, rb);
    }

    // Build union-find from trace endpoints
    const traceRoots: string[] = [];
    for (const t of netTraces) {
      const sk = traceKey(t.start.x, t.start.y);
      const ek = traceKey(t.end.x, t.end.y);
      if (!parent.has(sk)) parent.set(sk, sk);
      if (!parent.has(ek)) parent.set(ek, ek);
      union(sk, ek);
      traceRoots.push(find(sk));
    }

    // Collect all points per connected component
    const compPoints = new Map<string, string[]>();
    for (const [k] of parent) {
      const root = find(k);
      let arr = compPoints.get(root);
      if (!arr) { arr = []; compPoints.set(root, arr); }
      arr.push(k);
    }

    // Determine which revision(s) each component touches
    const compRevisions = new Map<string, number[]>();
    for (const [root, points] of compPoints) {
      const touches: number[] = [];
      for (let r = 0; r < passCount; r++) {
        for (const p of points) {
          if (pinSets[r].has(p)) { touches.push(r); break; }
        }
      }
      compRevisions.set(root, touches.length > 0 ? touches : [passCount - 1]);
    }

    // Assign each trace to its component's revision(s)
    for (let i = 0; i < netTraces.length; i++) {
      const root = find(traceRoots[i]);
      const revs = compRevisions.get(root) ?? [passCount - 1];
      if (revs.length === 1 || !merged) {
        // Single touch, or true-revision mode: assign to one revision
        result[revs[revs.length - 1]].push(netTraces[i]);
      } else {
        // Merged boards: duplicate trace to all touching boards
        for (const r of revs) result[r].push(netTraces[i]);
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Butterfly-layout unfold (CAMCAD/Apple exports)
// ---------------------------------------------------------------------------

interface ButterflyFold {
  dim: 'x' | 'y';
  axis: number;
  /** Coord sign (after subtracting axis) of the half that needs mirroring. */
  bottomSign: 1 | -1;
}

/**
 * Detect + apply a butterfly fold on the assembled parts. Fold is applied
 * in-place to pin positions, part origin/bounds, nail positions, and
 * trace/via endpoints that fall on the mirrored half.
 *
 * No-op when the board doesn't exhibit butterfly-authored bottom coordinates,
 * which covers every non-Apple CAD sample in the test set. Guards are
 * deliberately conservative (disjoint axis-range, comparable widths, strong
 * perpendicular overlap) to avoid mis-firing on partly-populated boards.
 */
function unfoldButterflyIfPresent(
  partsByPass: Part[][],
  nails: Nail[],
  traces: Trace[],
  vias: Via[],
): ButterflyFold | null {
  const fold = detectButterflyFold(partsByPass);
  if (!fold) return null;

  const mirrorCoord = (v: number) => 2 * fold.axis - v;

  for (const parts of partsByPass) {
    for (const part of parts) {
      if (part.side !== 'bottom') continue;
      for (const pin of part.pins) {
        if (fold.dim === 'x') pin.position.x = mirrorCoord(pin.position.x);
        else                  pin.position.y = mirrorCoord(pin.position.y);
      }
      const { origin, bounds } = computePartGeometry(part.pins);
      part.origin = origin;
      part.bounds = bounds;
    }
  }

  for (const nail of nails) {
    if (nail.side !== 'bottom') continue;
    if (fold.dim === 'x') nail.position.x = mirrorCoord(nail.position.x);
    else                  nail.position.y = mirrorCoord(nail.position.y);
  }

  // Traces/vias have no side — classify by midpoint position along the fold
  // axis. The bottom half is the one whose coord-sign relative to the axis
  // matches bottomSign.
  for (const t of traces) {
    const mid = fold.dim === 'x'
      ? (t.start.x + t.end.x) / 2
      : (t.start.y + t.end.y) / 2;
    if (Math.sign(mid - fold.axis) !== fold.bottomSign) continue;
    if (fold.dim === 'x') {
      t.start.x = mirrorCoord(t.start.x);
      t.end.x   = mirrorCoord(t.end.x);
    } else {
      t.start.y = mirrorCoord(t.start.y);
      t.end.y   = mirrorCoord(t.end.y);
    }
  }
  for (const v of vias) {
    const coord = fold.dim === 'x' ? v.position.x : v.position.y;
    if (Math.sign(coord - fold.axis) !== fold.bottomSign) continue;
    if (fold.dim === 'x') v.position.x = mirrorCoord(v.position.x);
    else                  v.position.y = mirrorCoord(v.position.y);
  }
  return fold;
}

function detectButterflyFold(partsByPass: Part[][]): ButterflyFold | null {
  let tMinX = Infinity, tMaxX = -Infinity, tMinY = Infinity, tMaxY = -Infinity, tN = 0;
  let bMinX = Infinity, bMaxX = -Infinity, bMinY = Infinity, bMaxY = -Infinity, bN = 0;
  for (const parts of partsByPass) {
    for (const part of parts) {
      for (const pin of part.pins) {
        const x = pin.position.x, y = pin.position.y;
        if (part.side === 'top') {
          if (x < tMinX) tMinX = x; if (x > tMaxX) tMaxX = x;
          if (y < tMinY) tMinY = y; if (y > tMaxY) tMaxY = y;
          tN++;
        } else {
          if (x < bMinX) bMinX = x; if (x > bMaxX) bMaxX = x;
          if (y < bMinY) bMinY = y; if (y > bMaxY) bMaxY = y;
          bN++;
        }
      }
    }
  }
  if (tN < 50 || bN < 50) return null;

  const xFold = checkFoldAxis(tMinX, tMaxX, bMinX, bMaxX, tMinY, tMaxY, bMinY, bMaxY);
  const yFold = checkFoldAxis(tMinY, tMaxY, bMinY, bMaxY, tMinX, tMaxX, bMinX, bMaxX);

  // Prefer the stronger signal (larger gap / smaller-half ratio)
  const pick = xFold && (!yFold || xFold.score >= yFold.score) ? xFold : yFold;
  if (!pick) return null;
  return { dim: pick === xFold ? 'x' : 'y', axis: pick.axis, bottomSign: pick.bottomSign };
}

/**
 * Returns a fold descriptor when the two layer ranges along the primary axis
 * are disjoint, comparable in size, and overlap along the perpendicular axis.
 * These three conditions together are specific to butterfly-authored files
 * and don't hold for normal boards (top/bottom always overlap in world X/Y).
 */
function checkFoldAxis(
  tMin: number, tMax: number, bMin: number, bMax: number,
  pTMin: number, pTMax: number, pBMin: number, pBMax: number,
): { axis: number; score: number; bottomSign: 1 | -1 } | null {
  const tSpan = tMax - tMin, bSpan = bMax - bMin;
  if (tSpan <= 0 || bSpan <= 0) return null;

  const topBelow = tMax <= bMin;
  const botBelow = bMax <= tMin;
  if (!topBelow && !botBelow) return null;

  // Widths must be comparable (butterfly implies mirror symmetry).
  const widthRatio = Math.min(tSpan, bSpan) / Math.max(tSpan, bSpan);
  if (widthRatio < 0.6) return null;

  // Perpendicular ranges must overlap substantially (both halves span the
  // same physical board on the other axis).
  const pOverlap = Math.min(pTMax, pBMax) - Math.max(pTMin, pBMin);
  const pMinSpan = Math.min(pTMax - pTMin, pBMax - pBMin);
  if (pMinSpan <= 0 || pOverlap / pMinSpan < 0.6) return null;

  const axis = topBelow ? (tMax + bMin) / 2 : (bMax + tMin) / 2;
  const bottomSign: 1 | -1 = topBelow ? 1 : -1; // side-of-axis where bottom lives
  // Score = perpendicular overlap ratio × width similarity (higher = more butterfly-like)
  const score = (pOverlap / pMinSpan) * widthRatio;
  return { axis, score, bottomSign };
}

/** Assign vias to revisions by pin proximity. */
function assignViasToRevisions(
  vias: Via[],
  partsByPass: Part[][],
  merged: boolean,
): Via[][] {
  const passCount = partsByPass.length;
  const result: Via[][] = Array.from({ length: passCount }, () => []);
  const pinSets = partsByPass.map(buildPinBuckets);

  for (const via of vias) {
    const key = traceKey(via.position.x, via.position.y);
    const touches: number[] = [];
    for (let r = 0; r < passCount; r++) {
      if (pinSets[r].has(key)) touches.push(r);
    }
    if (touches.length === 0) {
      result[passCount - 1].push(via);
    } else if (touches.length === 1 || !merged) {
      result[touches[touches.length - 1]].push(via);
    } else {
      for (const r of touches) result[r].push(via);
    }
  }

  return result;
}
