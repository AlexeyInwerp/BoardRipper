/**
 * BDV ASC (Honhan / Tebo-ICT) Parser
 *
 * After line-key de-obfuscation (see bdv-asc-decoder.ts), the file is a
 * multi-section ASCII document with three `<<name.asc>>` markers:
 *
 *   <<format.asc>>  Board outline contour. Columns: X Y Radius (INCHES).
 *   <<nails.asc>>   Test nails. `$<id> X Y <typeInt> <grid> (<T|B>) #<netnum> <netname> … <viaType> .`
 *   <<pins.asc>>    Parts + pins. Parts are introduced by `Part <name> (<T|B>)`,
 *                   followed by pin lines: `<num> <name> <X> <Y> <layer> <netName> [<nailId>]`.
 *
 * Coordinates are in inches throughout; this parser multiplies by 1000 to
 * convert to mils (BoardRipper's internal unit).
 */
import type { BoardData, Part, Pin, Nail, Point } from './types';
import { computeBBox, buildNets, computePartGeometry } from './types';
import { decodeBDVAsc } from './bdv-asc-decoder';

const INCH_TO_MIL = 1000;

/** Split the decoded document on the `<<name.asc>>` section markers. */
function splitSections(text: string): Map<string, string> {
  const markers: Array<{ name: string; start: number; bodyStart: number }> = [];
  const re = /<<([^>]+)>>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    markers.push({ name: m[1], start: m.index, bodyStart: m.index + m[0].length });
  }
  const sections = new Map<string, string>();
  for (let i = 0; i < markers.length; i++) {
    const end = i + 1 < markers.length ? markers[i + 1].start : text.length;
    sections.set(markers[i].name, text.slice(markers[i].bodyStart, end));
  }
  return sections;
}

// ---------------------------------------------------------------------------
// format.asc — board outline polygon (single contour)
// ---------------------------------------------------------------------------

function parseOutline(body: string): Point[] {
  const outline: Point[] = [];
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const tokens = line.split(/\s+/);
    if (tokens.length < 2) continue;
    const x = Number(tokens[0]);
    const y = Number(tokens[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    outline.push({ x: x * INCH_TO_MIL, y: y * INCH_TO_MIL });
  }
  return outline;
}

// ---------------------------------------------------------------------------
// pins.asc — parts + pins
// ---------------------------------------------------------------------------

const PART_HEADER_RE = /^Part\s+(\S+)\s*\(([TB])\)\s*$/;
const PIN_LINE_RE = /^\s+\d/;

interface RawPart {
  name: string;
  side: 'top' | 'bottom';
  pins: Pin[];
}

function parsePartsPins(body: string): RawPart[] {
  const parts: RawPart[] = [];
  let cur: RawPart | null = null;
  for (const raw of body.split(/\r?\n/)) {
    const headerMatch = PART_HEADER_RE.exec(raw.trim());
    if (headerMatch) {
      cur = {
        name: headerMatch[1],
        side: headerMatch[2] === 'T' ? 'top' : 'bottom',
        pins: [],
      };
      parts.push(cur);
      continue;
    }
    if (!cur || !PIN_LINE_RE.test(raw)) continue;
    const tokens = raw.trim().split(/\s+/);
    if (tokens.length < 5) continue;
    const number = tokens[0];
    const name = tokens[1];
    const x = Number(tokens[2]);
    const y = Number(tokens[3]);
    const layer = Number(tokens[4]);
    const netToken = tokens[5] ?? '';
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const net = netToken === '(NC)' ? '' : netToken;
    // Layer 1 = top, 2 = bottom, 0 = through-hole (mounting holes, vias) — for
    // through-hole pins fall back to the part's declared side.
    const pinSide: 'top' | 'bottom' =
      layer === 1 ? 'top' : layer === 2 ? 'bottom' : cur.side;
    cur.pins.push({
      name,
      number,
      position: { x: x * INCH_TO_MIL, y: y * INCH_TO_MIL },
      radius: 8,
      side: pinSide,
      net,
    });
  }
  return parts;
}

// ---------------------------------------------------------------------------
// nails.asc — test points
// ---------------------------------------------------------------------------

const NAIL_LINE_RE = /^\$\d/;

function parseNails(body: string): Nail[] {
  const nails: Nail[] = [];
  const seen = new Set<string>();
  for (const raw of body.split(/\r?\n/)) {
    if (!NAIL_LINE_RE.test(raw)) continue;
    const tokens = raw.trim().split(/\s+/);
    if (tokens.length < 6) continue;
    const x = Number(tokens[1]);
    const y = Number(tokens[2]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;

    // Find the side marker (T) or (B) and the first token starting with #.
    let side: 'top' | 'bottom' = 'top';
    let netName = '';
    for (let i = 3; i < tokens.length; i++) {
      if (tokens[i] === '(T)') side = 'top';
      else if (tokens[i] === '(B)') side = 'bottom';
      else if (tokens[i].startsWith('#') && i + 1 < tokens.length) {
        netName = tokens[i + 1];
        if (netName === '(NC)') netName = '';
      }
    }

    // Nails can repeat — dedupe by position+side+net.
    const key = `${x.toFixed(4)}|${y.toFixed(4)}|${side}|${netName}`;
    if (seen.has(key)) continue;
    seen.add(key);

    nails.push({
      position: { x: x * INCH_TO_MIL, y: y * INCH_TO_MIL },
      side,
      net: netName,
    });
  }
  return nails;
}

// ---------------------------------------------------------------------------
// Main parser
// ---------------------------------------------------------------------------

export function parseBDVAsc(buffer: ArrayBuffer): BoardData {
  const text = decodeBDVAsc(new Uint8Array(buffer));
  const sections = splitSections(text);

  const outline = parseOutline(sections.get('format.asc') ?? '');
  const rawParts = parsePartsPins(sections.get('pins.asc') ?? '');
  const nails = parseNails(sections.get('nails.asc') ?? '');

  const parts: Part[] = rawParts.map((rp) => {
    const geom = computePartGeometry(rp.pins);
    return {
      name: rp.name,
      side: rp.side,
      type: 'smd' as const,
      origin: geom.origin,
      pins: rp.pins,
      bounds: geom.bounds,
    };
  });

  if (parts.length === 0 && outline.length === 0) {
    throw new Error('BDV ASC file parsed but contains no parts or outline — decoder may have desynced');
  }

  // Winding-order flipY detection (matches bdv-parser behaviour).
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

  const allPoints: Point[] = [
    ...outline,
    ...parts.flatMap((p) => p.pins.map((pin) => pin.position)),
  ];
  const bounds = computeBBox(allPoints);
  const nets = buildNets(parts);

  return { format: 'BDV_ASC', outline, parts, nails, nets, bounds, flipY };
}
