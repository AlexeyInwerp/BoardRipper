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

import type { BoardData, Part, Pin, Nail, Point } from './types';
import { computeBBox, buildNets } from './types';

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
  const text = new TextDecoder('utf-8').decode(buffer);
  const sec = readSections(text);

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

  const parts: Part[] = [];
  for (let i = 0; i < rawParts.length; i++) {
    const rp = rawParts[i];
    const pinEnd = i + 1 < rawParts.length ? rawParts[i + 1].pinStart : rawPins.length;
    const side = sideStr(rp.side);

    const pins: Pin[] = [];
    for (let j = rp.pinStart; j < pinEnd && j < rawPins.length; j++) {
      const rpin = rawPins[j];
      pins.push({
        name: String(j - rp.pinStart + 1),
        number: String(j - rp.pinStart + 1),
        position: { x: rpin.x, y: rpin.y },
        radius: 8,
        side,
        net: netNames.get(rpin.netIdx) ?? '',
      });
    }

    const origin: Point = {
      x: (rp.x1 + rp.x2) / 2,
      y: (rp.y1 + rp.y2) / 2,
    };

    const bounds = pins.length > 0
      ? computeBBox(pins.map(p => p.position))
      : { minX: Math.min(rp.x1, rp.x2), minY: Math.min(rp.y1, rp.y2),
          maxX: Math.max(rp.x1, rp.x2), maxY: Math.max(rp.y1, rp.y2) };

    parts.push({ name: rp.name, side, type: 'smd', origin, pins, bounds });
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

  // ---- Finalise -------------------------------------------------------------
  const allPoints = [
    ...outline,
    ...parts.flatMap(p => p.pins.map(pin => pin.position)),
  ];
  const bounds = computeBBox(allPoints);
  const nets = buildNets(parts);

  return { format: 'BDV', outline, parts, nails, nets, bounds };
}
