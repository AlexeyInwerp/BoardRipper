import type { BoardData, Pad, Part, Pin, Point, SilkscreenPath } from './types';
import { computeBBox, buildNets, chainSegments } from './types';
import { log } from '../store/log-store';

/**
 * `PIN_RADIUS` is a plain number of mils on most exports (`9.268`). The
 * Switch Lite logic board writes a tuple instead — `(0.0175, 3)` — whose first
 * number is the ball DIAMETER in inches: on every BGA there it comes out at
 * 0.68–0.8 of the ball pitch (0.0125 at 15.75 mil, 0.0225 at 31.5). The second
 * number's meaning is unknown. `parseFloat` read the tuple as NaN and every
 * pin fell back to 25 mil.
 */
export function parsePinRadius(value: string): number | undefined {
  const tuple = /^\(\s*([-+]?[\d.]+(?:e[-+]?\d+)?)\s*,/i.exec(value);
  const r = tuple ? parseFloat(tuple[1]) * 500 : parseFloat(value);
  return Number.isFinite(r) && r > 0 ? r : undefined;
}

/**
 * `PIN_OUTLINE_RELATIVE x1 y1 x2 y2 …` — the copper pad's corners relative to
 * the pin origin (which need not be the pad centre: 820-02016 pads run from
 * y −5.5 to 0). Returns the corners in board coordinates.
 */
export function parsePinOutline(value: string, at: Point): Point[] | undefined {
  const n = value.split(/\s+/).map(Number);
  if (n.length < 6 || n.length % 2 !== 0 || n.some(v => !Number.isFinite(v))) return undefined;
  const pts: Point[] = [];
  for (let i = 0; i < n.length; i += 2) pts.push({ x: at.x + n[i], y: at.y + n[i + 1] });
  return pts;
}

/**
 * `PART_OUTLINE_RELATIVE` — the part body's corners relative to PART_ORIGIN,
 * drawn as a closed silkscreen loop (the Switch Lite: every one of its 1,272
 * parts; 820-02016: 87, with origin 0 so effectively absolute). 820-02016
 * writes each rectangle twice in a row; the repeat is dropped.
 */
export function parsePartOutline(value: string, origin: Point): Point[] | undefined {
  const pts = parsePinOutline(value, origin);
  if (!pts) return undefined;
  const half = pts.length / 2;
  if (pts.length % 2 === 0 && half >= 3 && pts.slice(0, half).every((p, i) => p.x === pts[half + i].x && p.y === pts[half + i].y)) {
    pts.length = half;
  }
  return [...pts, pts[0]];
}

/** Pin pad fields for an outline: a rectangle when the corners are an
 *  axis-aligned box (all of the Switch Lite's and 820-02016's), a polygon
 *  otherwise. */
function padFromOutline(pts: Point[]): Pick<Pin, 'padBounds' | 'padShape' | 'padWidth' | 'padHeight' | 'padPolygon'> {
  const b = computeBBox(pts);
  const onEdge = (v: number, lo: number, hi: number) => Math.abs(v - lo) < 1e-3 || Math.abs(v - hi) < 1e-3;
  const rect = pts.every(p => onEdge(p.x, b.minX, b.maxX) && onEdge(p.y, b.minY, b.maxY));
  return {
    padBounds: b,
    padShape: rect ? 'rect' : 'poly',
    padWidth: b.maxX - b.minX,
    padHeight: b.maxY - b.minY,
    ...(rect ? {} : { padPolygon: pts }),
  };
}

/**
 * Whether the file's pin outlines describe pads around their pins. 820-02016
 * (M1 Air) writes every 0201 pad as the half that starts at the pin and runs
 * outward — pin 1 at y 978 gets y 972.5…978 — on all 4,252 outlined pins; the
 * Switch Lite centres 2,128 of 2,744 on the pin and has the rest inside. A
 * file whose pins sit on a pad edge nearly everywhere is not drawn from.
 */
function padOutlinesPlausible(parts: Part[]): boolean {
  let total = 0, onEdge = 0;
  for (const part of parts) for (const pin of part.pins) {
    const b = pin.padBounds;
    if (!b) continue;
    total++;
    const { x, y } = pin.position;
    const eps = 0.01 * Math.max(1, b.maxX - b.minX, b.maxY - b.minY);
    if (Math.abs(x - b.minX) < eps || Math.abs(x - b.maxX) < eps || Math.abs(y - b.minY) < eps || Math.abs(y - b.maxY) < eps) onEdge++;
  }
  return total > 0 && onEdge < total * 0.9;
}

/**
 * Pre-scan to detect whether PIN_ORIGIN values are relative to PART_ORIGIN
 * or already absolute.  Many real-world BVR3 files (e.g. Apple boards) store
 * absolute pin positions even when PART_ORIGIN is non-zero.
 *
 * Each part with a non-zero PART_ORIGIN votes with its first pin: read as
 * absolute, the pin sits at its distance from the part origin; read as
 * relative, at its distance from (0,0). A pin belongs near its part, so the
 * smaller of the two is the file's convention, and the majority decides.
 *
 * The earlier rule demanded that EVERY such part's first pin sit exactly on
 * its origin — true for Apple exports, where pin 1 is the origin. The Switch
 * Lite logic board (2026-11-14) stores absolute pins whose pin 1 is off the
 * origin on all but 170 of 1272 parts; read as relative, the pins landed at
 * twice their coordinates and the outline drew at a quarter of the board.
 * Across 17 BVR3 files from the corpus the vote agrees with the old rule on
 * every one, and puts all of the Switch Lite's pins inside its outline.
 */
export function detectAbsolutePinCoords(lines: string[]): boolean {
  let partOX = 0, partOY = 0;
  let nonZeroOriginParts = 0;
  let absVotes = 0;
  let sawPin = false;

  for (const raw of lines) {
    const line = raw.trim();
    const spIdx = line.indexOf(' ');
    const kw = spIdx === -1 ? line : line.substring(0, spIdx);
    const val = spIdx === -1 ? '' : line.substring(spIdx + 1).trim();

    if (kw === 'PART_ORIGIN') {
      const vals = val.split(/\s+/);
      partOX = Number(vals[0]) || 0;
      partOY = Number(vals[1]) || 0;
      sawPin = false;
    } else if (kw === 'PIN_ORIGIN' && !sawPin) {
      sawPin = true; // only check first pin per part
      if (partOX !== 0 || partOY !== 0) {
        nonZeroOriginParts++;
        const vals = val.split(/\s+/);
        const px = Number(vals[0]) || 0;
        const py = Number(vals[1]) || 0;
        if (Math.hypot(px - partOX, py - partOY) < Math.hypot(px, py)) absVotes++;
      }
    } else if (kw === 'PART_END') {
      partOX = 0; partOY = 0; sawPin = false;
    }
  }

  const absolute = nonZeroOriginParts > 0 && absVotes > nonZeroOriginParts / 2;
  if (absVotes > 0 && absVotes < nonZeroOriginParts) {
    log.parser.log(
      `BVR3 pin coordinates: ${absVotes}/${nonZeroOriginParts} parts read as absolute → ${absolute ? 'absolute' : 'relative'}`,
    );
  }
  return absolute;
}

export function parseBVR3(text: string): BoardData {
  const lines = text.split(/\r?\n/);
  if (!lines[0]?.includes('BVRAW_FORMAT_3')) {
    throw new Error('Not a valid BVR3 file: missing BVRAW_FORMAT_3 header');
  }

  const useAbsoluteCoords = detectAbsolutePinCoords(lines);

  const outline: Point[] = [];
  const parts: Part[] = [];

  let currentPart: Part | null = null;
  let currentPin: Partial<Pin> | null = null;
  let currentPinOutline = '';
  let currentPartOutline = '';
  const pads: Pad[] = [];
  const silkscreen: SilkscreenPath[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const spaceIdx = line.indexOf(' ');
    const keyword = spaceIdx === -1 ? line : line.substring(0, spaceIdx);
    const value = spaceIdx === -1 ? '' : line.substring(spaceIdx + 1).trim();

    switch (keyword) {
      case 'OUTLINE_POINTS': {
        const nums = value.split(/\s+/).map(Number);
        for (let j = 0; j + 1 < nums.length; j += 2) {
          outline.push({ x: nums[j], y: nums[j + 1] });
        }
        break;
      }
      case 'OUTLINE_SEGMENTED': {
        const nums = value.split(/\s+/).map(Number);
        const segments: Array<[Point, Point]> = [];
        for (let j = 0; j + 3 < nums.length; j += 4) {
          segments.push([
            { x: nums[j], y: nums[j + 1] },
            { x: nums[j + 2], y: nums[j + 3] },
          ]);
        }
        if (segments.length > 0) {
          outline.push(...chainSegments(segments));
        }
        break;
      }
      case 'PART_NAME':
        currentPartOutline = '';
        currentPart = {
          name: value,
          side: 'top',
          type: 'smd',
          origin: { x: 0, y: 0 },
          pins: [],
          bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
        };
        break;
      case 'PART_SIDE':
        if (currentPart) {
          // Side intentionally inverted — see bvr1-parser.ts for detailed explanation.
          currentPart.side = value === 'T' ? 'bottom' : value === 'B' ? 'top' : 'both';
        }
        break;
      case 'PART_ORIGIN':
        if (currentPart) {
          const [ox, oy] = value.split(/\s+/).map(Number);
          currentPart.origin = { x: ox, y: oy };
        }
        break;
      case 'PART_OUTLINE_RELATIVE':
        currentPartOutline = value;
        break;
      case 'PART_MOUNT':
        if (currentPart) {
          currentPart.type = value === 'ThroughHole' ? 'throughhole' : 'smd';
        }
        break;
      case 'PART_END':
        if (currentPart) {
          if (currentPartOutline && currentPart.side !== 'both') {
            const body = parsePartOutline(currentPartOutline, currentPart.origin);
            if (body) silkscreen.push({ points: body, side: currentPart.side });
          }
          if (currentPart.pins.length > 0) {
            const positions = currentPart.pins.map(p => p.position);
            currentPart.bounds = computeBBox(positions);
            // If origin is 0,0 (not set), compute from pin center
            if (currentPart.origin.x === 0 && currentPart.origin.y === 0) {
              currentPart.origin = {
                x: (currentPart.bounds.minX + currentPart.bounds.maxX) / 2,
                y: (currentPart.bounds.minY + currentPart.bounds.maxY) / 2,
              };
            }
          } else {
            currentPart.bounds = {
              minX: currentPart.origin.x - 50,
              minY: currentPart.origin.y - 50,
              maxX: currentPart.origin.x + 50,
              maxY: currentPart.origin.y + 50,
            };
          }
          parts.push(currentPart);
          currentPart = null;
        }
        break;
      case 'PIN_ID':
        currentPin = { number: value, name: '', side: 'top', net: '', radius: undefined };
        currentPinOutline = '';
        break;
      case 'PIN_NUMBER':
        if (currentPin) currentPin.number = value;
        break;
      case 'PIN_NAME':
        if (currentPin) currentPin.name = value;
        break;
      case 'PIN_SIDE':
        if (currentPin) {
          currentPin.side = value === 'T' ? 'bottom' : 'top';
        }
        break;
      case 'PIN_ORIGIN':
        if (currentPin && currentPart) {
          const [px, py] = value.split(/\s+/).map(Number);
          if (useAbsoluteCoords) {
            // File uses absolute pin positions (common in Apple BVR3 exports)
            currentPin.position = { x: px, y: py };
          } else {
            // Standard BVR3: pin coords are relative to part origin
            currentPin.position = {
              x: currentPart.origin.x + px,
              y: currentPart.origin.y + py,
            };
          }
        }
        break;
      case 'PIN_RADIUS':
        if (currentPin) currentPin.radius = parsePinRadius(value);
        break;
      case 'PIN_OUTLINE_RELATIVE':
        // Resolved at PIN_END: the outline may precede PIN_ORIGIN.
        currentPinOutline = value;
        break;
      case 'PIN_NET':
        if (currentPin) currentPin.net = value;
        break;
      case 'PIN_END':
        if (currentPin && currentPart) {
          const pinPos = currentPin.position || currentPart.origin;
          if (!currentPin.position && currentPart.origin.x === 0 && currentPart.origin.y === 0) {
            log.parser.warn(
              `Part "${currentPart.name}" pin "${currentPin.number || currentPin.name || '?'}": ` +
              'both PIN_ORIGIN and PART_ORIGIN absent — falling back to {0, 0}'
            );
          }
          const outlinePts = currentPinOutline ? parsePinOutline(currentPinOutline, pinPos) : undefined;
          const pad = outlinePts ? padFromOutline(outlinePts) : undefined;
          const side = currentPin.side || 'top';
          const net = currentPin.net || '';
          // No radius in the file: half the pad's short side, as the
          // pad-carrying parsers do; 25 mil only when there is neither.
          const radius = currentPin.radius
            ?? (pad ? Math.max(0.5, Math.min(pad.padWidth!, pad.padHeight!) / 2) : 25);
          currentPart.pins.push({
            name: currentPin.name || '',
            number: currentPin.number || '',
            position: pinPos,
            radius,
            side,
            net,
            ...(pad ?? {}),
          });
          if (pad) {
            pads.push({
              bounds: pad.padBounds!,
              side,
              ...(net ? { net } : {}),
              attached: true,
              shape: pad.padShape!,
              width: pad.padWidth!,
              height: pad.padHeight!,
              ...(pad.padPolygon ? { polygon: pad.padPolygon } : {}),
            });
          }
          currentPin = null;
        }
        break;
    }
  }

  const allPoints = [...outline, ...parts.flatMap(p => p.pins.map(pin => pin.position))];
  const bounds = computeBBox(allPoints);
  const nets = buildNets(parts);

  const keepPads = pads.length > 0 && padOutlinesPlausible(parts);
  if (pads.length > 0 && !keepPads) {
    for (const part of parts) for (const pin of part.pins) {
      delete pin.padBounds; delete pin.padShape; delete pin.padWidth; delete pin.padHeight; delete pin.padPolygon;
    }
    log.parser.log(`BVR3: ${pads.length} pin outlines ignored — the pin sits on an edge of nearly every pad, not inside it`);
  }

  return {
    format: 'BVR3', outline, parts, nails: [], nets, bounds,
    ...(keepPads ? { pads } : {}),
    ...(silkscreen.length > 0 ? { silkscreen } : {}),
  };
}

