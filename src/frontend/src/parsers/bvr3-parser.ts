import type { BoardData, Part, Pin, Point } from './types';
import { computeBBox, buildNets } from './types';

export function parseBVR3(text: string): BoardData {
  const lines = text.split(/\r?\n/);
  if (!lines[0]?.includes('BVRAW_FORMAT_3')) {
    throw new Error('Not a valid BVR3 file: missing BVRAW_FORMAT_3 header');
  }

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
          reconstructOutline(segments, outline);
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
          // BVR3 pin coords are relative to part origin
          currentPin.position = {
            x: currentPart.origin.x + px,
            y: currentPart.origin.y + py,
          };
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
            console.warn(
              `[BVR3] Part "${currentPart.name}" pin "${currentPin.number || currentPin.name || '?'}": ` +
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

function reconstructOutline(segments: Array<[Point, Point]>, outline: Point[]): void {
  if (segments.length === 0) return;

  const used = new Array(segments.length).fill(false);
  used[0] = true;
  outline.push(segments[0][0], segments[0][1]);

  for (let count = 1; count < segments.length; count++) {
    const last = outline[outline.length - 1];
    let bestIdx = -1;
    let bestDist = Infinity;
    let bestFlip = false;

    for (let j = 0; j < segments.length; j++) {
      if (used[j]) continue;
      const d0 = Math.abs(last.x - segments[j][0].x) + Math.abs(last.y - segments[j][0].y);
      const d1 = Math.abs(last.x - segments[j][1].x) + Math.abs(last.y - segments[j][1].y);
      if (d0 < bestDist) { bestDist = d0; bestIdx = j; bestFlip = false; }
      if (d1 < bestDist) { bestDist = d1; bestIdx = j; bestFlip = true; }
    }

    if (bestIdx === -1) break;
    used[bestIdx] = true;
    if (bestFlip) {
      outline.push(segments[bestIdx][1], segments[bestIdx][0]);
    } else {
      outline.push(segments[bestIdx][0], segments[bestIdx][1]);
    }
  }
}
