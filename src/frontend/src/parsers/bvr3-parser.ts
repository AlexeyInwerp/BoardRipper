import type { BoardData, Part, Pin, Point } from './types';
import { computeBBox, buildNets, chainSegments } from './types';
import { log } from '../store/log-store';

/**
 * Pre-scan to detect whether PIN_ORIGIN values are relative to PART_ORIGIN
 * or already absolute.  Many real-world BVR3 files (e.g. Apple boards) store
 * absolute pin positions even when PART_ORIGIN is non-zero.  We detect this
 * by looking at parts whose PART_ORIGIN is non-zero: if every such part's
 * first PIN_ORIGIN exactly equals its PART_ORIGIN the file uses absolute
 * coordinates and we must NOT add the origin offset.
 */
function detectAbsolutePinCoords(lines: string[]): boolean {
  let partOX = 0, partOY = 0;
  let nonZeroOriginParts = 0;
  let matchCount = 0;
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
        if (px === partOX && py === partOY) matchCount++;
      }
    } else if (kw === 'PART_END') {
      partOX = 0; partOY = 0; sawPin = false;
    }
  }

  // If every non-zero-origin part has first PIN_ORIGIN == PART_ORIGIN, coords are absolute.
  // Partial match (some absolute, some not) falls through to relative mode — log a warning.
  if (matchCount > 0 && matchCount < nonZeroOriginParts) {
    log.parser.warn(
      `Mixed coordinate convention detected: ${matchCount}/${nonZeroOriginParts} ` +
      'non-zero-origin parts have PIN_ORIGIN == PART_ORIGIN. Falling back to relative mode.',
    );
  }
  return nonZeroOriginParts > 0 && matchCount === nonZeroOriginParts;
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
      case 'PART_MOUNT':
        if (currentPart) {
          currentPart.type = value === 'ThroughHole' ? 'throughhole' : 'smd';
        }
        break;
      case 'PART_END':
        if (currentPart) {
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
        currentPin = { number: value, name: '', side: 'top', net: '', radius: 25 };
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
        if (currentPin) currentPin.radius = parseFloat(value);
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
          currentPart.pins.push({
            name: currentPin.name || '',
            number: currentPin.number || '',
            position: pinPos,
            radius: currentPin.radius || 25,
            side: currentPin.side || 'top',
            net: currentPin.net || '',
          });
          currentPin = null;
        }
        break;
    }
  }

  const allPoints = [...outline, ...parts.flatMap(p => p.pins.map(pin => pin.position))];
  const bounds = computeBBox(allPoints);
  const nets = buildNets(parts);

  return { format: 'BVR3', outline, parts, nails: [], nets, bounds };
}

