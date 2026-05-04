/**
 * Mentor Boardstation Neutral File Parser
 *
 * Plain-text PCB neutral export from Mentor Graphics Boardstation /
 * Expedition. Some Quanta / Compal / Samsung notebook builders ship the
 * file with a `.cad` extension — that is **not** GenCAD; the formats
 * just collide on extension. Detection routes by content signature.
 *
 * Format spec: docs/formats/MENTOR_NEUTRAL_FORMAT.md
 *
 * Records this parser cares about:
 *
 *   BOARD <name> OFFSET x:<X> y:<Y> ORIENTATION <rot>
 *   B_UNITS Inches | Mils | Mm
 *   GEOM <shape>            G_PIN, G_ATTR
 *   COMP <ref> <part> <device> <shape> <X> <Y> <side> <rot>
 *                           C_PROP, C_PIN
 *   NET <name>              N_PIN, N_VIA   (N_PIN duplicates C_PIN; only
 *                           N_VIA is consumed for via geometry)
 *   HOLE <NPTH|PTH> ...     ignored (mounting/tooling features)
 *   PAD VIA / P_SHAPE       ignored for MVP
 *   B_ADDP                  ignored (artwork / fiducials / silk labels)
 *
 * Coordinates: declared in `B_UNITS`; everything is converted to mils
 * (the engine's internal unit) on parse. C_PIN positions are absolute
 * world space, so no rotation/translation step is needed for pins.
 */

import type { BoardData, Part, Pin, Nail, Point, Via } from './types';
import { computeBBox, buildNets, detectGhostComponents, generateSyntheticOutline } from './types';
import { log } from '../store/log-store';

const decoder = new TextDecoder('utf-8');

// ---------------------------------------------------------------------------
// Internal data shapes
// ---------------------------------------------------------------------------

type Units = 'inches' | 'mils' | 'mm';

interface CompPinRaw {
  pinName: string;
  x: number;
  y: number;
  side: 'top' | 'bottom';
  padstack: string;
  net: string;
}

interface CompRaw {
  ref: string;
  partNumber: string;
  device: string;
  shape: string;
  x: number;
  y: number;
  side: 'top' | 'bottom';
  rotation: number;
  pins: CompPinRaw[];
  props: Map<string, string>;
}

interface GeomRaw {
  name: string;
  hasThru: boolean;
  outline?: Point[];
  height?: number;
}

interface ViaRaw {
  x: number;
  y: number;
  net: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function unitsToMils(u: Units): number {
  switch (u) {
    case 'inches': return 1000;
    case 'mm':     return 1000 / 25.4;
    case 'mils':   return 1;
  }
}

function pinSideFromCode(code: number): 'top' | 'bottom' {
  return code === 1 ? 'top' : 'bottom';
}

function netNormalize(raw: string | undefined): string {
  if (!raw || raw === '$NONE$') return '';
  return raw.startsWith('/') ? raw.slice(1) : raw;
}

/** Pull the pin-name suffix out of a "<RefDes>-<PinName>" token.
 *  Use lastIndexOf so refdes containing a dash (e.g. `J504-1` here vs
 *  hypothetical multi-dash refs) still works. */
function pinNameOf(refPin: string): string {
  const i = refPin.lastIndexOf('-');
  return i >= 0 ? refPin.slice(i + 1) : refPin;
}

/** Mentor wraps long records by ending the line with " - " and indenting
 *  the continuation. Re-join into a single logical line before parsing. */
function unfoldContinuations(rawLines: string[]): string[] {
  const out: string[] = [];
  let buf = '';
  for (const raw of rawLines) {
    const line = raw.replace(/\r$/, '');
    if (/\s-\s*$/.test(line)) {
      buf += (buf ? '' : '') + line.replace(/\s-\s*$/, ' ');
    } else if (buf) {
      buf += line.trim().length > 0 ? line : '';
      out.push(buf);
      buf = '';
    } else {
      out.push(line);
    }
  }
  if (buf) out.push(buf);
  return out;
}

/** Parse `BOARD <name> OFFSET x:<X> y:<Y> ORIENTATION <rot>`. */
function parseBoardLine(line: string): { name: string; offsetX: number; offsetY: number; orientation: number } | null {
  const m = /^BOARD\s+(\S+)\s+OFFSET\s+x:([-\d.eE+]+)\s+y:([-\d.eE+]+)\s+ORIENTATION\s+([-\d.eE+]+)/.exec(line);
  if (!m) return null;
  return { name: m[1], offsetX: Number(m[2]), offsetY: Number(m[3]), orientation: Number(m[4]) };
}

/** Parse `B_UNITS <Inches|Mils|Mm>` (case-insensitive). */
function parseUnits(line: string): Units {
  const tok = line.trim().split(/\s+/);
  const u = (tok[1] ?? '').toLowerCase();
  if (u.startsWith('mil')) return 'mils';
  if (u.startsWith('mm')) return 'mm';
  return 'inches';
}

/** Parse a `G_ATTR '<NAME>' '<VALUE>' [numerics...]` line.
 *  Single-quoted strings may contain anything (we only need their
 *  un-quoted text). Numerics follow on the same logical line. */
function parseGAttr(line: string): { name: string; numerics: number[] } | null {
  // Skip past `G_ATTR `
  let i = line.indexOf("'");
  if (i < 0) return null;
  const nameEnd = line.indexOf("'", i + 1);
  if (nameEnd < 0) return null;
  const name = line.slice(i + 1, nameEnd);

  i = line.indexOf("'", nameEnd + 1);
  if (i < 0) return { name, numerics: [] };
  const valEnd = line.indexOf("'", i + 1);
  if (valEnd < 0) return { name, numerics: [] };

  const tail = line.slice(valEnd + 1).trim();
  const numerics = tail === '' ? [] : tail.split(/\s+/).map(Number).filter(n => !isNaN(n));
  return { name, numerics };
}

// ---------------------------------------------------------------------------
// Main parser
// ---------------------------------------------------------------------------

export function parseMentorNeutral(buffer: ArrayBuffer): BoardData {
  const text = decoder.decode(buffer);
  const lines = unfoldContinuations(text.split(/\r?\n/));

  let units: Units = 'inches';
  let boardName = '';
  let offsetX = 0;
  let offsetY = 0;
  let orientation = 0;

  // Pre-pass: locate BOARD/B_UNITS so subsequent records can use the unit
  // scale. Both records sit in the first dozen lines.
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trimStart();
    if (l.startsWith('BOARD ')) {
      const b = parseBoardLine(l);
      if (b) { boardName = b.name; offsetX = b.offsetX; offsetY = b.offsetY; orientation = b.orientation; }
    } else if (l.startsWith('B_UNITS')) {
      units = parseUnits(l);
    }
    if (boardName && (l.startsWith('B_UNITS') || i > 30)) break;
  }
  const scale = unitsToMils(units);

  if (orientation !== 0 || offsetX !== 0 || offsetY !== 0) {
    log.parser.warn(`Mentor neutral: BOARD orientation=${orientation} offset=(${offsetX},${offsetY}) is non-default — ignored, board may render misplaced`);
  }

  const geoms = new Map<string, GeomRaw>();
  const comps: CompRaw[] = [];
  const viasRaw: ViaRaw[] = [];

  let curGeom: GeomRaw | null = null;
  let curComp: CompRaw | null = null;
  let curNet = '';

  for (const raw of lines) {
    const line = raw.trimStart();
    if (!line || line[0] === '#') continue;

    // Cheap dispatch by leading keyword.
    const sp = line.indexOf(' ');
    const kw = sp < 0 ? line : line.slice(0, sp);

    switch (kw) {
      case 'GEOM': {
        curComp = null;
        curNet = '';
        const name = line.slice(5).trim();
        curGeom = { name, hasThru: false };
        if (name) geoms.set(name, curGeom);
        break;
      }

      case 'G_PIN': {
        if (!curGeom) break;
        const tok = line.split(/\s+/);
        // G_PIN <num> <x> <y> <padstack> <Surf|Thru> [drill]
        if (tok.length >= 6 && tok[5] === 'Thru') curGeom.hasThru = true;
        break;
      }

      case 'G_ATTR': {
        if (!curGeom) break;
        const a = parseGAttr(line);
        if (!a) break;
        if (a.name === 'COMPONENT_PLACEMENT_OUTLINE') {
          const pts: Point[] = [];
          for (let j = 0; j + 1 < a.numerics.length; j += 2) {
            pts.push({ x: a.numerics[j], y: a.numerics[j + 1] });
          }
          if (pts.length >= 2) curGeom.outline = pts;
        } else if (a.name === 'COMPONENT_HEIGHT') {
          if (a.numerics.length > 0) curGeom.height = a.numerics[0];
        }
        break;
      }

      case 'COMP': {
        curGeom = null;
        curNet = '';
        const tok = line.split(/\s+/);
        // Placed: 9 tokens (COMP ref part device shape X Y side rot)
        // BOM-only: 5 tokens (COMP ref part device shape) — skip
        if (tok.length < 9) { curComp = null; break; }
        const sideCode = Number(tok[7]);
        const x = Number(tok[5]);
        const y = Number(tok[6]);
        const rot = Number(tok[8]);
        if (isNaN(x) || isNaN(y)) { curComp = null; break; }
        curComp = {
          ref: tok[1],
          partNumber: tok[2],
          device: tok[3],
          shape: tok[4],
          x, y,
          side: pinSideFromCode(sideCode),
          rotation: isNaN(rot) ? 0 : rot,
          pins: [],
          props: new Map(),
        };
        comps.push(curComp);
        break;
      }

      case 'C_PROP': {
        if (!curComp) break;
        // Free-form: (KEY,"VALUE") (KEY,"VALUE") ...
        // Capture the keys we care about for Part.meta. Use a non-greedy
        // pattern so adjacent tuples on the same line don't bleed into one.
        const re = /\(([A-Z_]+),"([^"]*)"\)/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(line)) !== null) {
          if (!curComp.props.has(m[1])) curComp.props.set(m[1], m[2]);
        }
        break;
      }

      case 'C_PIN': {
        if (!curComp) break;
        const tok = line.split(/\s+/);
        // C_PIN <ref-pin> <X> <Y> <layer-mask> <side> <rot> <padstack> <net>
        if (tok.length < 9) break;
        const x = Number(tok[2]);
        const y = Number(tok[3]);
        if (isNaN(x) || isNaN(y)) break;
        const sideCode = Number(tok[5]);
        curComp.pins.push({
          pinName: pinNameOf(tok[1]),
          x, y,
          side: pinSideFromCode(sideCode),
          padstack: tok[7],
          net: netNormalize(tok[8]),
        });
        break;
      }

      case 'NET': {
        curComp = null;
        curGeom = null;
        curNet = netNormalize(line.slice(4).trim());
        break;
      }

      case 'N_VIA': {
        const tok = line.split(/\s+/);
        // N_VIA <X> <Y> <padstack> <fromLayer> <toLayer>
        const x = Number(tok[1]);
        const y = Number(tok[2]);
        if (isNaN(x) || isNaN(y)) break;
        viasRaw.push({ x, y, net: curNet });
        break;
      }

      // Records we deliberately drop:
      case 'N_PROP':
      case 'N_PIN':       // duplicated by C_PIN
      case 'HOLE':        // mounting/tooling, no pin/net role
      case 'PAD':
      case 'P_SHAPE':
      case 'B_ADDP':
        break;

      default:
        // Unknown record — silently skip.
        break;
    }
  }

  // ----- Build BoardData -----------------------------------------------------

  const parts: Part[] = [];
  const pinPoints: Point[] = [];
  let droppedNoPin = 0;

  for (const c of comps) {
    if (c.pins.length === 0) { droppedNoPin++; continue; }

    const pins: Pin[] = c.pins.map(cp => {
      const px = (cp.x - offsetX) * scale;
      const py = (cp.y - offsetY) * scale;
      pinPoints.push({ x: px, y: py });
      return {
        name: cp.pinName,
        number: cp.pinName,
        position: { x: px, y: py },
        radius: 8,
        side: cp.side,
        net: cp.net,
      };
    });

    const origin: Point = {
      x: (c.x - offsetX) * scale,
      y: (c.y - offsetY) * scale,
    };
    const bounds = computeBBox(pins.map(p => p.position));

    const geom = geoms.get(c.shape);
    const partType: Part['type'] = geom?.hasThru ? 'throughhole' : 'smd';

    const desc = c.props.get('DESC');
    const supplier = c.props.get('SUPLECODE');
    parts.push({
      name: c.ref,
      side: c.side,
      type: partType,
      origin,
      pins,
      bounds,
      meta: {
        value:    c.device || undefined,
        package:  c.shape || undefined,
        partType: desc || undefined,
        serial:   supplier || c.partNumber || undefined,
        heightMils: geom?.height ? geom.height * scale : undefined,
        angleDeg: c.rotation,
      },
    });
  }

  if (parts.length === 0) {
    throw new Error('Mentor neutral file parsed but contains no placed components — file may be corrupt or empty');
  }

  // Vias: drill diameter is in the padstack table; for MVP we tag a
  // small default — the renderer treats this as a hint, not load-bearing.
  const vias: Via[] = viasRaw.map(v => ({
    position: { x: (v.x - offsetX) * scale, y: (v.y - offsetY) * scale },
    diameter: 10,
    net: v.net,
    layers: [],
  }));

  const allPoints: Point[] = [
    ...pinPoints,
    ...vias.map(v => v.position),
  ];
  const bounds = computeBBox(allPoints);
  const outline = generateSyntheticOutline(allPoints);

  const nets = buildNets(parts);
  const ghosts = detectGhostComponents(parts);

  log.parser.log(
    `Mentor neutral: ${parts.length} parts, ${nets.size} nets, ${vias.length} vias` +
    (droppedNoPin > 0 ? `, ${droppedNoPin} BOM-only entries skipped` : ''),
  );

  const nails: Nail[] = [];
  const board: BoardData = {
    format: 'MENTOR',
    formatVersion: 'Boardstation Neutral',
    outline,
    parts,
    nails,
    nets,
    bounds,
    parserNotes: [
      `Mentor Boardstation neutral file (${units}) — board "${boardName || '(unnamed)'}"`,
    ],
  };
  if (vias.length > 0) board.vias = vias;
  if (ghosts.length > 0) board.ghosts = ghosts;
  return board;
}
