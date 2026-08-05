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

/** Section titles the vendor tools print in each file's own header block.
 *  These are what identify a STANDALONE .asc file, which carries no
 *  `<<name.asc>>` marker of its own — the marker only exists inside the
 *  bundled (obfuscated .bdv) form, where it is literally the file name the
 *  section would have had on disk. */
const SECTION_TITLES: Array<{ re: RegExp; section: string }> = [
  { re: /Board\s+Outline\s+Contour/i, section: 'format.asc' },
  { re: /Test\s+Fixture\s+Nails/i,    section: 'nails.asc' },
  { re: /Part\s+Pins\s+List/i,        section: 'pins.asc' },
];

/** Identify which section a standalone .asc file holds.
 *
 *  Header title first (it is explicit and vendor-printed), then a shape
 *  fallback for files whose header was stripped: a `Part <name> (T)` line is
 *  unmistakably pins, a `$<id>` row is nails, and bare numeric triples are an
 *  outline contour. Returns null when nothing matches, so the caller can say
 *  so rather than silently parsing an empty board. */
export function identifyAscSection(text: string): string | null {
  const head = text.slice(0, 4000);
  for (const { re, section } of SECTION_TITLES) {
    if (re.test(head)) return section;
  }
  if (/^Part\s+\S+\s*\([TB]\)\s*$/m.test(text)) return 'pins.asc';
  if (/^\$\S+\s+-?\d/m.test(text)) return 'nails.asc';
  if (/^\s*-?\d+\.\d+\s+-?\d+\.\d+\s+-?\d+\.\d+\s*$/m.test(text)) return 'format.asc';
  return null;
}

/** True when the bytes are the Honhan / Tebo-ICT obfuscated bundle rather
 *  than plain ASC text. The signature is the cipher applied to the first
 *  section marker, so its presence is exactly the question "is this
 *  encoded?". */
export function isObfuscatedBDVAsc(bytes: Uint8Array): boolean {
  const SIG = 'dd:1.3?,r?-=bb';
  if (bytes.length < SIG.length) return false;
  for (let i = 0; i < SIG.length; i++) {
    if (bytes[i] !== SIG.charCodeAt(i)) return false;
  }
  return true;
}

/** Wrap standalone section files back into the bundled form the section
 *  splitter already understands: `<<name>>` + body, concatenated. The
 *  obfuscated .bdv IS this bundle, so one code path serves both deliveries.
 *  `name` is the file's own name — `pins.asc`, `PINS.ASC`, `board_pins.asc`
 *  — and is only used as a hint; the section is identified from content and
 *  falls back to the name when the content is unrecognisable. */
export function bundleAscFiles(files: Array<{ name: string; text: string }>): string {
  const out: string[] = [];
  for (const f of files) {
    const byContent = identifyAscSection(f.text);
    const lower = f.name.toLowerCase();
    const byName = SECTION_TITLES.find(t => lower.includes(t.section.replace('.asc', '')))?.section;
    const section = byContent ?? byName;
    if (!section) continue;
    out.push(`<<${section}>>\n${f.text}`);
  }
  return out.join('\n');
}

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
// Pin-number column is 4 wide right-aligned: single-digit "   1", 3-digit " 999",
// 4-digit pin numbers (BGAs >999 balls) land at column 0 with no leading
// whitespace — accept both forms. Later token-count + numeric checks guard
// against stray header/metadata lines that begin with a digit.
const PIN_LINE_RE = /^\s*\d+\s+\S/;

interface RawPart {
  name: string;
  side: 'top' | 'bottom';
  pins: Pin[];
  /** True once any pin reports layer 0 (through-hole). BDV ASC carries no
   *  other mount-style signal, so parts without a layer-0 pin stay 'unknown'. */
  hasThru: boolean;
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
        hasThru: false,
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
    if (layer === 0) cur.hasThru = true;
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
  const bytes = new Uint8Array(buffer);
  // Two deliveries of the same document: the obfuscated .bdv bundle, and the
  // plain .asc files some vendor tools write instead (issue #26). Decode only
  // when the cipher signature is actually there.
  const text = isObfuscatedBDVAsc(bytes)
    ? decodeBDVAsc(bytes)
    : new TextDecoder('ascii').decode(bytes);
  // `.asc` is also PADS Layout's ASCII export extension (PART.ASC / CONN.ASC
  // next to a PADS job). Say what it is rather than failing as an unreadable
  // boardview — same courtesy the XZZ parser extends to PADS binary `.pcb`.
  if (/^\s*\*PADS-PCB\*/.test(text.slice(0, 200))) {
    throw new Error('This is a PADS Layout ASCII export (*PADS-PCB*), not a boardview ASC file — BoardRipper does not read the PADS design database.');
  }
  let sections = splitSections(text);
  if (sections.size === 0) {
    // A standalone section file carries no marker — identify it and wrap it,
    // so a lone pins.asc still opens (parts, pins and nets, no outline).
    const section = identifyAscSection(text);
    if (!section) {
      throw new Error('ASC file holds no recognisable section (expected an outline contour, test nails, or part pins list)');
    }
    sections = new Map([[section, text]]);
  }

  const outline = parseOutline(sections.get('format.asc') ?? '');
  const rawParts = parsePartsPins(sections.get('pins.asc') ?? '');
  const nails = parseNails(sections.get('nails.asc') ?? '');

  const parts: Part[] = rawParts.map((rp) => {
    const geom = computePartGeometry(rp.pins);
    return {
      name: rp.name,
      side: rp.side,
      // Derive through-hole from a layer-0 pin; else leave unknown (BDV ASC
      // records no SMD marker, so asserting 'smd' would be a guess).
      type: rp.hasThru ? 'throughhole' as const : 'unknown' as const,
      origin: geom.origin,
      pins: rp.pins,
      bounds: geom.bounds,
    };
  });

  if (parts.length === 0 && outline.length === 0 && nails.length === 0) {
    throw new Error('BDV ASC file parsed but contains no parts, outline or nails — decoder may have desynced');
  }

  // Detect side-label inversion. Tebo-ICT / eM-Test files label parts from
  // the fixture's perspective — the side where the test nails land. For a
  // bed-of-nails ICT fixture that is physically opposite to the board's
  // component side, so laptop mainboards end up with every big BGA (CPU,
  // GPU, chipset) tagged (B) even though it's on the user-visible top.
  // Matches the Allegro assembler's pin-majority heuristic: when >55% of
  // pins sit on side='bottom' the "primary" side is bottom; the renderer
  // then swaps scene layers so the user's "Top" button shows them.
  const pinsOnTop = parts.filter(p => p.side === 'top').reduce((n, p) => n + p.pins.length, 0);
  const pinsOnBottom = parts.filter(p => p.side === 'bottom').reduce((n, p) => n + p.pins.length, 0);
  const totalPins = pinsOnTop + pinsOnBottom;
  const primarySide: 'top' | 'bottom' | undefined =
    totalPins > 0 && pinsOnBottom / totalPins > 0.55 ? 'bottom' : undefined;

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

  return { format: 'BDV_ASC', outline, parts, nails, nets, bounds, flipY, primarySide };
}
