/**
 * BRD (Binary Obfuscated Boardview) Parser
 *
 * The format uses a byte-level obfuscation (NOT nibble encoding — earlier
 * analysis was wrong). Each non-whitespace byte is transformed as follows,
 * replicating the C signed-char semantics used by OpenBoardView:
 *
 *   decoded = ~(((c >> 6) & 3) | (c << 2))  where c is the signed 8-bit value
 *
 * CR, LF, and null bytes are preserved unchanged.
 * Magic/detection header: first 4 bytes are 0x23 0xE2 0x63 0x28.
 *
 * After decoding the result is plain ASCII text with 6 named sections:
 *   str_length:  — max string lengths (metadata, unused by parser)
 *   var_data:    — record counts and origin offset
 *   Format:      — board outline polygon (x y per line)
 *   Pins1:       — part catalogue (name, flags, cumulative-pin-count)
 *   Pins2:       — pin positions (x, y, ignored, part_1idx, net_name)
 *   Nails:       — test-point positions (index, x, y, ignored, net_name)
 *
 * Coordinate unit: mils (thousandths of an inch) — same as BVR.
 *
 * See docs/formats/BRD_FORMAT.md for the full specification.
 */

import type { BoardData, Part, Pin, Nail, Point } from './types';
import { computeBBox, buildNets } from './types';

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

/**
 * Apply the OpenBoardView byte transform to the raw file bytes.
 * Replicates C: `char x = buf[i]; int c = x; x = ~(((c>>6)&3)|(c<<2));`
 * Non-printable control bytes (CR, LF, NUL) are preserved unchanged.
 */
export function decodeBRDBytes(bytes: Uint8Array): string {
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 0x0A || b === 0x0D || b === 0x00) {
      out[i] = b; // preserve line endings and null
    } else {
      // Sign-extend the unsigned byte to a signed 32-bit integer.
      // In JS bitwise ops already operate on signed 32-bit, but we need the
      // top-bit sign extension: (b << 24) >> 24 replicates `(int)(char)b`.
      const c = (b << 24) >> 24;
      out[i] = (~(((c >> 6) & 3) | (c << 2))) & 0xFF;
    }
  }
  return new TextDecoder('ascii').decode(out);
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/** Split a decoded text into named sections. Returns Map<sectionName, lines[]>. */
function parseSections(text: string): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  let current = '';
  const lines: string[] = [];

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (line.endsWith(':') && line.length <= 20 && !line.includes(' ')) {
      // Section header
      if (current) sections.set(current, [...lines]);
      current = line.slice(0, -1); // strip trailing ':'
      lines.length = 0;
    } else if (current) {
      lines.push(line);
    }
  }
  if (current) sections.set(current, [...lines]);
  return sections;
}

/** Parse flags byte (col1 of Pins1) into component side. */
function parseSideFlags(flags: number): 'top' | 'bottom' | 'both' {
  // bit 0: present on top copper,  bit 1: present on bottom copper
  const top    = (flags & 1) !== 0;
  const bottom = (flags & 2) !== 0;
  return top && bottom ? 'both' : bottom ? 'bottom' : 'top';
}

// ---------------------------------------------------------------------------
// Main parser
// ---------------------------------------------------------------------------

export function parseBRD(buffer: ArrayBuffer): BoardData {
  const bytes = new Uint8Array(buffer);
  const text  = decodeBRDBytes(bytes);
  const secs  = parseSections(text);

  // ---- var_data: counts and board origin ----------------------------------
  let nOutline = 0, nParts = 0, nPins = 0, nNails = 0;
  const varLines = secs.get('var_data') ?? [];
  const varLine  = varLines.find(l => l.trim());
  if (varLine) {
    const nums = varLine.trim().split(/\s+/).map(Number);
    nOutline = nums[0] ?? 0;
    nParts   = nums[1] ?? 0;
    nPins    = nums[2] ?? 0;
    nNails   = nums[3] ?? 0;
    // nums[4] = origin x, nums[5] = origin y (board offset — not applied here)
  }

  // ---- Format: board outline polygon --------------------------------------
  // Read all outline vertices as-is — deduplication of consecutive duplicates
  // happens in drawOutline() at render time.
  const outline: Point[] = [];
  const fmtLines = secs.get('Format') ?? [];
  let parsed = 0;
  for (const line of fmtLines) {
    if (nOutline > 0 && parsed >= nOutline) break;
    const cols = line.trim().split(/\s+/);
    if (cols.length < 2) continue;
    const x = Number(cols[0]);
    const y = Number(cols[1]);
    if (isNaN(x) || isNaN(y)) continue;
    outline.push({ x, y });
    parsed++;
  }

  // ---- Pins1: part catalogue ----------------------------------------------
  // Columns: name  flags  cumulative_pin_count
  // Also handles 'Parts:' section name (alternate BRD variant)
  const partNames: string[] = [];
  const partFlags: number[] = [];
  const partCumPins: number[] = []; // running total of pins through this part
  const p1Lines = secs.get('Pins1') ?? secs.get('Parts') ?? [];
  let p1count = 0;
  for (const line of p1Lines) {
    if (nParts > 0 && p1count >= nParts) break;
    const cols = line.trim().split(/\s+/);
    if (cols.length < 3) continue;
    partNames.push(cols[0]);
    partFlags.push(Number(cols[1]) || 0);
    partCumPins.push(Number(cols[2]) || 0);
    p1count++;
  }

  // ---- Pins2: pin positions -----------------------------------------------
  // Columns: x  y  <ignored>  part_1idx  net_name
  // part_1idx is a 1-based index into the Pins1 catalogue.
  // Also handles 'Pins:' section name (alternate BRD variant — same column layout).
  // Build an array of (x, y, partIdx, net) for each pin.
  const pinData: Array<{ x: number; y: number; partIdx: number; net: string }> = [];
  const p2Lines = secs.get('Pins2') ?? secs.get('Pins') ?? [];
  let p2count = 0;
  for (const line of p2Lines) {
    if (nPins > 0 && p2count >= nPins) break;
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4) continue;
    const x       = Number(cols[0]);
    const y       = Number(cols[1]);
    const partIdx = Number(cols[3]); // 1-based
    const net     = cols.length >= 5 ? cols.slice(4).join(' ').trim() : '';
    if (!isNaN(x) && !isNaN(y) && partIdx > 0) {
      pinData.push({ x, y, partIdx, net });
    }
    p2count++;
  }

  // ---- Assemble parts and pins --------------------------------------------
  // Group pin data by partIdx, then join with Pins1 catalogue.
  const pinsByPart = new Map<number, typeof pinData>();
  for (const pd of pinData) {
    const list = pinsByPart.get(pd.partIdx);
    if (list) list.push(pd);
    else pinsByPart.set(pd.partIdx, [pd]);
  }

  const parts: Part[] = [];
  for (let i = 0; i < partNames.length; i++) {
    const partIdx = i + 1; // 1-based index matching Pins2 col3
    const side    = parseSideFlags(partFlags[i]);
    const pins: Pin[] = [];

    const pdata = pinsByPart.get(partIdx) ?? [];
    for (let j = 0; j < pdata.length; j++) {
      const pd = pdata[j];
      pins.push({
        name:     String(j + 1),
        number:   String(j + 1),
        position: { x: pd.x, y: pd.y },
        radius:   8,
        side:     side === 'both' ? 'top' : side,
        net:      pd.net,
      });
    }

    let origin: Point;
    let bounds = computeBBox(pins.map(p => p.position));
    if (pins.length > 0) {
      origin = {
        x: (bounds.minX + bounds.maxX) / 2,
        y: (bounds.minY + bounds.maxY) / 2,
      };
    } else {
      origin = { x: 0, y: 0 };
      bounds = { minX: -50, minY: -50, maxX: 50, maxY: 50 };
    }

    parts.push({
      name:   partNames[i],
      side,
      type:   'smd',
      origin,
      pins,
      bounds,
    });
  }

  // ---- Nails / test points ------------------------------------------------
  // Columns: nail_idx  x  y  side(1=top,else=bottom)  net_name
  const nails: Nail[] = [];
  const nailLines = secs.get('Nails') ?? [];
  let ncount = 0;
  for (const line of nailLines) {
    if (nNails > 0 && ncount >= nNails) break;
    const cols = line.trim().split(/\s+/);
    if (cols.length < 3) continue;
    const x    = Number(cols[1]);
    const y    = Number(cols[2]);
    const side = Number(cols[3]) === 1 ? 'top' : 'bottom' as const;
    const net  = cols.length >= 5 ? cols.slice(4).join(' ').trim() : '';
    if (!isNaN(x) && !isNaN(y)) {
      nails.push({ position: { x, y }, side, net });
    }
    ncount++;
  }

  // ---- Finalise -----------------------------------------------------------
  const allPoints = [
    ...outline,
    ...parts.flatMap(p => p.pins.map(pin => pin.position)),
  ];
  const bounds = computeBBox(allPoints);
  const nets   = buildNets(parts);

  return { format: 'BRD', outline, parts, nails, nets, bounds };
}
