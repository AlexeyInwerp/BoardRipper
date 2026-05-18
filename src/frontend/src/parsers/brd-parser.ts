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
import { computeBBox, buildNets, computePartGeometry } from './types';
import { applyXMirrorInPlace } from './mirror-detect';
import { log } from '../store/log-store';

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
  // OpenBoardView convention: flag 1/4-7 → top, flag 2/8+ → bottom
  if (flags === 1 || (flags >= 4 && flags < 8)) return 'top';
  if (flags === 2 || flags >= 8) return 'bottom';
  return 'both';
}

function flipSide(s: 'top' | 'bottom' | 'both'): 'top' | 'bottom' | 'both' {
  return s === 'top' ? 'bottom' : s === 'bottom' ? 'top' : 'both';
}

/**
 * Detect whether the file's side flags are inverted relative to physical reality.
 * BRD files from different tools use opposite conventions for the flags field.
 *
 * Primary signal: ICs (U*, PU*) are overwhelmingly placed on the component/top
 * side, so whichever flag-side has more total IC pins is the true top.
 *
 * Secondary signal: when IC counts are close (< 2:1 ratio), test point
 * distribution is used as a tiebreaker. Test points (1-pin parts) are
 * predominantly placed on the bottom side of real PCBs.
 */
function detectSideInversion(
  partNames: string[],
  partFlags: number[],
  partCumPins: number[],
): boolean {
  let topIcPins = 0, bottomIcPins = 0;
  let topTestPoints = 0, bottomTestPoints = 0;

  for (let i = 0; i < partNames.length; i++) {
    const name = partNames[i].toUpperCase();
    const pinCount = partCumPins[i] - (i > 0 ? partCumPins[i - 1] : 0);
    const side = parseSideFlags(partFlags[i]);

    // 1-pin parts are test points — track separately, exclude from IC analysis
    if (pinCount === 1) {
      if (side === 'top') topTestPoints++;
      else if (side === 'bottom') bottomTestPoints++;
      continue;
    }

    if (!/^P?U[A-Z0-9]/.test(name)) continue;
    if (side === 'top') topIcPins += pinCount;
    else if (side === 'bottom') bottomIcPins += pinCount;
  }

  const icTotal = topIcPins + bottomIcPins;
  const icMax = Math.max(topIcPins, bottomIcPins);
  const icInverted = bottomIcPins > topIcPins;

  // Strong IC signal (≥ 2:1 ratio) — trust it directly
  if (icTotal > 0 && icMax >= icTotal * 0.66) {
    return icInverted;
  }

  // IC signal is weak or absent — use test point distribution as tiebreaker.
  // Domain knowledge: most test points sit on the bottom side.
  const tpTotal = topTestPoints + bottomTestPoints;
  if (tpTotal > 10) {
    const tpInverted = topTestPoints > bottomTestPoints; // majority flagged "top" → likely actually bottom → inverted
    // If IC signal exists but is close, test points break the tie
    if (icTotal > 0) {
      return tpInverted;
    }
    // No ICs at all — rely on test points alone
    return tpInverted;
  }

  // Fallback: use whatever IC signal we have, or no inversion
  return icInverted;
}

// ---------------------------------------------------------------------------
// Main parser
// ---------------------------------------------------------------------------

export function parseBRD(buffer: ArrayBuffer): BoardData {
  const bytes = new Uint8Array(buffer);

  // Proprietary "BRD_V1.0" container: 16-byte ASCII header followed by an
  // encoded body. Decoding is under active investigation — the algorithm
  // isn't published and no client-side artifact carries the key. Reject
  // early with a descriptive message instead of letting OpenBoardView-style
  // decoding emit garbage. Support may be added in a future release once
  // the format is understood.
  if (
    bytes.length >= 16 &&
    bytes[0] === 0x42 && bytes[1] === 0x52 && bytes[2] === 0x44 && bytes[3] === 0x5F &&
    bytes[4] === 0x56 && bytes[5] === 0x31 && bytes[6] === 0x2E && bytes[7] === 0x30
  ) {
    throw new Error(
      'BRD_V1.0 is a proprietary, encoded boardview format. ' +
      'Decoding is under active investigation — support may be added in a future release.'
    );
  }

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
  // Distinguish the two BRD writer tools by which section naming they use
  // ("Pins1"/"Pins2" vs "Parts"/"Pins"). The X-flip normalization below
  // applies only to the "Pins1/Pins2" writer when its IC distribution is
  // un-inverted — see rationale at the normalization block.
  const isPins1Variant = secs.has('Pins1');
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

  // ---- Detect side inversion ------------------------------------------------
  // BRD files from different tools use opposite flag conventions.
  // Auto-detect by checking which flag-side has more IC pins.
  const inverted = detectSideInversion(partNames, partFlags, partCumPins);

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
    const rawSide = parseSideFlags(partFlags[i]);
    const side    = inverted ? flipSide(rawSide) : rawSide;
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

    const { origin, bounds } = computePartGeometry(pins);

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
    const rawSide = Number(cols[3]) === 1 ? 'top' : 'bottom' as const;
    const side = inverted ? flipSide(rawSide) as 'top' | 'bottom' : rawSide;
    const net  = cols.length >= 5 ? cols.slice(4).join(' ').trim() : '';
    if (!isNaN(x) && !isNaN(y)) {
      nails.push({ position: { x, y }, side, net });
    }
    ncount++;
  }

  if (parts.length === 0 && outline.length === 0) {
    throw new Error('BRD file parsed but contains no parts or outline — file may be corrupt or empty');
  }

  // ---- BRD-writer X-flip normalization ------------------------------------
  // The BRD corpus comes from two different writer tools. They split into
  // four buckets by (section-variant × inverted-flag):
  //
  //   Parts/Pins  + inverted=Y  →  render correctly as-is   (e.g. 820-00281)
  //   Parts/Pins  + inverted=N  →  render correctly as-is   (e.g. 820-00291)
  //   Pins1/Pins2 + inverted=Y  →  render correctly as-is   (e.g. LA-H501P)
  //   Pins1/Pins2 + inverted=N  →  X-FLIPPED in storage     (020-02098 etc.)
  //
  // Only the last bucket needs a parse-time X-flip. The Pins1/Pins2 writer
  // with un-inverted IC flags stores coordinates in the opposite X frame
  // from the other three, so without the flip the board renders mirrored.
  // Confirmed ground truth on 6 files: 820-00281, LA-H501P, 820-00291,
  // 820-02098, 820-02935-05, 820-01823.
  let parserNotes: string[] | undefined;
  const needsXFlip = isPins1Variant && !inverted;
  if (needsXFlip) {
    log.parser.warn(`BRD X-mirror normalization applied (Pins1/Pins2 writer, inverted=false)`);
    applyXMirrorInPlace(parts, nails, [], [], outline);
    parserNotes = [
      'Board was horizontally un-mirrored on load — the file was produced by a BRD writer whose X-axis convention is opposite to the renderer\'s (Pins1/Pins2 section format with non-inverted flag distribution).',
    ];
  } else {
    log.parser.log(`BRD X-mirror check: variant=${isPins1Variant ? 'Pins1/Pins2' : 'Parts/Pins'}, inverted=${inverted}, no flip needed`);
  }

  // ---- Finalise -----------------------------------------------------------
  const allPoints = [
    ...outline,
    ...parts.flatMap(p => p.pins.map(pin => pin.position)),
  ];
  const bounds = computeBBox(allPoints);
  const nets   = buildNets(parts);

  const board: BoardData = { format: 'BRD', outline, parts, nails, nets, bounds };
  if (parserNotes) board.parserNotes = parserNotes;
  return board;
}
