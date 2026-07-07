/**
 * BDV (Plain-Text Boardview) Parser
 *
 * Parses the plain-text .brd/.bdv format with these sections:
 *
 *   Line 1:        Creator/metadata string (ignored)
 *   BRDOUT: N W H  Board outline — N vertices, W×H dimensions
 *   NETS: N        Net list — 1-based index + net name per line
 *   PARTS: N       Part catalogue — name x1 y1 x2 y2 pinStartIdx side
 *   PINS: N        Pin positions — x y netIdx side
 *   NAILS: N       Test points — nailIdx x y netIdx side
 *
 * Side encoding: 1 = top, 2 = bottom.
 * Coordinates are in mils (thousandths of an inch).
 */

import type { BoardData, Part, Pin, Nail, Point, BBox } from './types';
import { computeBBox, buildNets, generateSyntheticOutline, computePartGeometry } from './types';
import { applyXMirrorInPlace } from './mirror-detect';
import { log } from '../store/log-store';

const decoder = new TextDecoder('utf-8');

// ---------------------------------------------------------------------------
// Section reader helper
// ---------------------------------------------------------------------------

interface Sections {
  header: string;
  brdout: { count: number; width: number; height: number };
  outlineVerts: string[];
  nets: string[];
  parts: string[];
  pins: string[];
  nails: string[];
}

function readSections(text: string): Sections {
  const lines = text.split(/\r?\n/);
  const header = lines[0] ?? '';

  let brdout = { count: 0, width: 0, height: 0 };
  const outlineVerts: string[] = [];
  const nets: string[] = [];
  const parts: string[] = [];
  const pins: string[] = [];
  const nails: string[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();

    if (line.startsWith('BRDOUT:')) {
      const nums = line.replace('BRDOUT:', '').trim().split(/\s+/).map(Number);
      brdout = { count: nums[0] ?? 0, width: nums[1] ?? 0, height: nums[2] ?? 0 };
      i++;
      // Read outline vertices
      for (let j = 0; j < brdout.count && i < lines.length; j++, i++) {
        const vl = lines[i].trim();
        if (vl && !vl.includes(':')) outlineVerts.push(vl);
        else { i--; break; } // hit next section
      }
      // Skip blank line after outline
      continue;
    }

    if (line.startsWith('NETS:')) {
      const count = parseInt(line.replace('NETS:', '').trim(), 10) || 0;
      i++;
      for (let j = 0; j < count && i < lines.length; j++, i++) {
        nets.push(lines[i]);
      }
      continue;
    }

    if (line.startsWith('PARTS:')) {
      const count = parseInt(line.replace('PARTS:', '').trim(), 10) || 0;
      i++;
      for (let j = 0; j < count && i < lines.length; j++, i++) {
        parts.push(lines[i]);
      }
      continue;
    }

    if (line.startsWith('PINS:')) {
      const count = parseInt(line.replace('PINS:', '').trim(), 10) || 0;
      i++;
      for (let j = 0; j < count && i < lines.length; j++, i++) {
        pins.push(lines[i]);
      }
      continue;
    }

    if (line.startsWith('NAILS:')) {
      const count = parseInt(line.replace('NAILS:', '').trim(), 10) || 0;
      i++;
      for (let j = 0; j < count && i < lines.length; j++, i++) {
        nails.push(lines[i]);
      }
      continue;
    }

    i++;
  }

  return { header, brdout, outlineVerts, nets, parts, pins, nails };
}

// ---------------------------------------------------------------------------
// Main parser
// ---------------------------------------------------------------------------

export function parseBDV(buffer: ArrayBuffer): BoardData {
  const text = decoder.decode(buffer);
  const sec = readSections(text);
  const creator = sec.header.trim();

  // ---- Board outline -------------------------------------------------------
  const outline: Point[] = [];
  for (const vl of sec.outlineVerts) {
    const cols = vl.trim().split(/\s+/);
    if (cols.length < 2) continue;
    const x = Number(cols[0]);
    const y = Number(cols[1]);
    if (!isNaN(x) && !isNaN(y)) outline.push({ x, y });
  }

  // ---- Net index → name map (1-based) -------------------------------------
  const netNames = new Map<number, string>();
  for (const line of sec.nets) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 2) continue;
    const idx = parseInt(cols[0], 10);
    const name = cols.slice(1).join(' ');
    if (!isNaN(idx)) netNames.set(idx, name);
  }

  // ---- Parse raw pin data (global flat array) ------------------------------
  interface RawPin { x: number; y: number; netIdx: number; side: number }
  const rawPins: RawPin[] = [];
  for (const line of sec.pins) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4) continue;
    rawPins.push({
      x: Number(cols[0]),
      y: Number(cols[1]),
      netIdx: Number(cols[2]),
      side: Number(cols[3]),
    });
  }

  // ---- Parse parts and assign pins ----------------------------------------
  // PARTS columns: name x1 y1 x2 y2 pinStartIdx side
  interface RawPart {
    name: string;
    x1: number; y1: number; x2: number; y2: number;
    pinStart: number;
    side: number;
  }
  const rawParts: RawPart[] = [];
  for (const line of sec.parts) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 7) continue;
    rawParts.push({
      name: cols[0],
      x1: Number(cols[1]), y1: Number(cols[2]),
      x2: Number(cols[3]), y2: Number(cols[4]),
      pinStart: Number(cols[5]),
      side: Number(cols[6]),
    });
  }

  const sideStr = (s: number): 'top' | 'bottom' => s === 1 ? 'top' : 'bottom';

  // ---- Side=0 Y-mirror axis (BRDOUT height) --------------------------------
  // The "159xxxx" Compal/Quanta-family BDV writer encodes through-hole
  // mounting-hole pins as side=0 with the Y coordinate pre-mirrored around
  // the board's BRDOUT height when the parent part is on the top side. For
  // bottom-side parents the Y is already in un-mirrored space. We flip only
  // in the top-parent case and assign the pin to the side opposite the
  // part's declared side (through-hole exits on the back of the component).
  //
  // The mirror axis is the declared BRDOUT height when present — earlier
  // revisions used per-part max(partY1, partY2), which undershoots by ~80 mils
  // and scatters mounting-hole pins away from their holes.
  //
  // When BRDOUT is degenerate (creator 1457685 = DAG3BEMBCD0 ships
  // `BRDOUT: 5 0 0`), fall back to the global max part Y. Since the topmost
  // part bbox sits within a few mils of the board edge, this approximates the
  // true axis closely enough that mirrored pins land inside their parent
  // part's bounds. Without this fallback, top-side parts with side=0
  // through-hole pins (notably connectors like CN1001/CN1014/CN2C/CN2U) skip
  // the mirror entirely, scattering pins to the opposite end of the board and
  // stretching the part bbox by 5×–137×.
  let mirrorY = sec.brdout.height > 0 ? sec.brdout.height : 0;
  if (mirrorY === 0 && rawParts.length > 0) {
    let maxPartY = 0;
    for (const rp of rawParts) {
      if (rp.y1 > maxPartY) maxPartY = rp.y1;
      if (rp.y2 > maxPartY) maxPartY = rp.y2;
    }
    mirrorY = maxPartY;
  }

  const parts: Part[] = [];
  for (let i = 0; i < rawParts.length; i++) {
    const rp = rawParts[i];
    const pinEnd = i + 1 < rawParts.length ? rawParts[i + 1].pinStart : rawPins.length;
    const side = sideStr(rp.side);

    const pins: Pin[] = [];
    // A side=0 pin is a through-hole pin (exits the opposite copper side), so
    // any part carrying one is a through-hole part; absent that signal BDV
    // records no mount style, so we leave it 'unknown' rather than assert 'smd'.
    let hasThruPin = false;
    for (let j = rp.pinStart; j < pinEnd && j < rawPins.length; j++) {
      const rpin = rawPins[j];
      // side=0 encodes a through-hole pin exiting on the opposite side of the
      // parent part. When the parent is on the top side, the file pre-mirrors
      // the Y coordinate around the BRDOUT height; when the parent is on the
      // bottom side, the Y is stored directly.
      let pinY = rpin.y;
      let pinSide: 'top' | 'bottom' = side;
      if (rpin.side === 0) {
        hasThruPin = true;
        if (rp.side === 1 && mirrorY > 0) {
          pinY = mirrorY - rpin.y;
          pinSide = 'bottom';
        } else if (rp.side === 2) {
          pinSide = 'top';
        }
      }
      pins.push({
        name: String(j - rp.pinStart + 1),
        number: String(j - rp.pinStart + 1),
        position: { x: rpin.x, y: pinY },
        radius: 8,
        side: pinSide,
        net: netNames.get(rpin.netIdx) ?? '',
      });
    }

    // Some BDV writers (notably the ASUS X540 family, 60NB0HF0-MB1020) store
    // `0 0 0 0` for every part's x1/y1/x2/y2 — the file carries NO per-part
    // geometry. Folding those all-zero corners into origin/bounds collapses
    // every part's label to (0,0) and stretches every outline from its pins to
    // the origin, so all silk elements misalign from the (correctly placed)
    // pins. When the file corners are degenerate, derive geometry from the pins
    // alone (matching brd-parser's computePartGeometry). A part that supplies a
    // real position (even a zero-height box like `5424 3451 5455 3451`) is left
    // on the file-bounds path.
    const noFileGeometry = rp.x1 === 0 && rp.y1 === 0 && rp.x2 === 0 && rp.y2 === 0;

    let origin: Point;
    let bounds: BBox;
    if (noFileGeometry) {
      ({ origin, bounds } = computePartGeometry(pins));
    } else {
      origin = { x: (rp.x1 + rp.x2) / 2, y: (rp.y1 + rp.y2) / 2 };
      // Use file-provided part bounds so outlier pins don't stretch the box
      const fileBounds = {
        minX: Math.min(rp.x1, rp.x2), minY: Math.min(rp.y1, rp.y2),
        maxX: Math.max(rp.x1, rp.x2), maxY: Math.max(rp.y1, rp.y2),
      };
      bounds = pins.length > 0
        ? computeBBox([...pins.map(p => p.position), { x: fileBounds.minX, y: fileBounds.minY }, { x: fileBounds.maxX, y: fileBounds.maxY }])
        : fileBounds;
    }

    parts.push({ name: rp.name, side, type: hasThruPin ? 'throughhole' : 'unknown', origin, pins, bounds });
  }

  // ---- Nails / test points -------------------------------------------------
  // Columns: nailIdx x y netIdx side
  const nails: Nail[] = [];
  for (const line of sec.nails) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5) continue;
    const x = Number(cols[1]);
    const y = Number(cols[2]);
    const netIdx = Number(cols[3]);
    const side = sideStr(Number(cols[4]));
    if (!isNaN(x) && !isNaN(y)) {
      nails.push({ position: { x, y }, side, net: netNames.get(netIdx) ?? '' });
    }
  }

  if (parts.length === 0 && outline.length === 0) {
    throw new Error('BDV file parsed but contains no parts or outline — file may be corrupt or empty');
  }

  // ---- Detect Y direction from outline winding order -------------------------
  // Positive signed area (shoelace) → CCW in Y-up space → file uses Y-up → need flipY.
  // Negative → CW in Y-up = file is Y-down → no flipY.
  // Zero/degenerate outline → assume screen-oriented (Y-down) → no flipY.
  let flipY = false;
  if (outline.length >= 3) {
    let signedArea2 = 0;
    for (let i = 0; i < outline.length; i++) {
      const j = (i + 1) % outline.length;
      signedArea2 += outline[i].x * outline[j].y - outline[j].x * outline[i].y;
    }
    if (Math.abs(signedArea2) > 1) {
      flipY = signedArea2 > 0;
    }
  }

  const parserNotes: string[] = [];

  // ---- X-mirror normalization for the "Compal/Quanta 7-digit ID" writer -----
  // The BDV family whose first-line creator is a 7-digit numeric ID (e.g.
  // 1599467 = LA-L978P, 1593300 = LA-L191P-R1C, 1450250 = Quanta G37D) stores
  // coordinates horizontally flipped relative to the renderer's frame. The
  // same exporter also emits files with an all-zero BRDOUT (e.g. 1457685 =
  // DAG3BEMBCD0), and those files are NOT X-mirrored. The discriminating
  // signal is the outline itself: when it's a rectangle sitting at (0,0)-(W,H)
  // with the same W/H declared in the BRDOUT header, the file belongs to the
  // mirrored bucket. Matches the same shape as brd-parser.ts's Pins1/Pins2
  // writer X-flip.
  const hasRectOutline =
    outline.length >= 4 &&
    sec.brdout.width > 0 &&
    sec.brdout.height > 0 &&
    Math.min(...outline.map(p => p.x)) === 0 &&
    Math.min(...outline.map(p => p.y)) === 0 &&
    Math.abs(Math.max(...outline.map(p => p.x)) - sec.brdout.width) < 1 &&
    Math.abs(Math.max(...outline.map(p => p.y)) - sec.brdout.height) < 1;
  const needsXFlip = /^\d{7}$/.test(creator) && hasRectOutline;
  if (needsXFlip) {
    log.parser.warn(
      `BDV X-mirror normalization applied (creator='${creator}', rectangular ${sec.brdout.width}×${sec.brdout.height} outline)`,
    );
    applyXMirrorInPlace(parts, nails, [], [], outline);
    parserNotes.push(
      "Board was horizontally un-mirrored on load — the file was produced by the Compal/Quanta-family BDV writer (7-digit creator ID) whose X-axis convention is opposite to the renderer's.",
    );
  } else {
    log.parser.log(
      `BDV X-mirror check: creator='${creator}', rectOutline=${hasRectOutline}, no flip needed`,
    );
  }

  // ---- primarySide pin-majority heuristic ----------------------------------
  // Matches Allegro/BDV-ASC: when the IC-heavy side ends up tagged 'bottom',
  // flag the board so the renderer swaps scene layers on open. No-op when
  // the file's side encoding already matches reality (>55% pins on 'bottom'
  // is the trigger).
  const pinsOnTop = parts.reduce((n, p) => n + (p.side === 'top' ? p.pins.length : 0), 0);
  const pinsOnBottom = parts.reduce((n, p) => n + (p.side === 'bottom' ? p.pins.length : 0), 0);
  const totalPins = pinsOnTop + pinsOnBottom;
  const primarySide: 'top' | 'bottom' | undefined =
    totalPins > 0 && pinsOnBottom / totalPins > 0.55 ? 'bottom' : undefined;

  // ---- Synthetic outline fallback ------------------------------------------
  // Some files (e.g. DAG3BEMBCD0, creator 1457685) declare `BRDOUT: 5 0 0`
  // with five (0,0) vertices — effectively no outline. Without one the view
  // has nothing to frame the board and parts float against the origin.
  // Generate a rectangular outline around the parts' bbox when this happens.
  let finalOutline = outline;
  const outlineDegenerate =
    outline.length === 0 ||
    (outline.length > 0 &&
      Math.abs(Math.max(...outline.map(p => p.x)) - Math.min(...outline.map(p => p.x))) < 1 &&
      Math.abs(Math.max(...outline.map(p => p.y)) - Math.min(...outline.map(p => p.y))) < 1);
  if (outlineDegenerate && parts.length > 0) {
    const partPoints = parts.flatMap(p => p.pins.map(pin => pin.position));
    if (partPoints.length > 0) {
      finalOutline = generateSyntheticOutline(partPoints, 200);
      parserNotes.push(
        'Board outline was missing in the file — a synthetic rectangular outline was derived from the part positions.',
      );
    }
  }

  // ---- Finalise -------------------------------------------------------------
  const allPoints = [
    ...finalOutline,
    ...parts.flatMap(p => p.pins.map(pin => pin.position)),
  ];
  const bounds = computeBBox(allPoints);
  const nets = buildNets(parts);

  const board: BoardData = {
    format: 'BDV',
    outline: finalOutline,
    parts,
    nails,
    nets,
    bounds,
    flipY,
  };
  if (primarySide) board.primarySide = primarySide;
  if (parserNotes.length > 0) board.parserNotes = parserNotes;
  return board;
}
