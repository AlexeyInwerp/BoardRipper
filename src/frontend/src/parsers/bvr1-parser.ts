import type { BoardData, Part, Pin, Nail, Point } from './types';
import { computeBBox, buildNets } from './types';

export function parseBVR1(text: string): BoardData {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== 'BVRAW_FORMAT_1') {
    throw new Error('Not a valid BVR1 file: missing BVRAW_FORMAT_1 header');
  }

  const outline: Point[] = [];
  const parts: Part[] = [];
  const nails: Nail[] = [];
  const partMap = new Map<string, Part>();

  let section = '';

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (line.startsWith('<<')) {
      section = line.replace(/[<>]/g, '').trim();
      i++; // skip column header
      continue;
    }

    const fields = line.split('\t');

    switch (section) {
      case 'Layout': {
        const x = parseFloat(fields[0]) * 1000;
        const y = parseFloat(fields[1]) * 1000;
        if (!isNaN(x) && !isNaN(y)) {
          outline.push({ x, y });
        }
        break;
      }
      case 'Pin': {
        if (fields.length < 8) break;
        const partName = fields[0];
        const location = fields[1];
        const pinName = fields[3];
        const x = parseFloat(fields[4]) * 1000;
        const y = parseFloat(fields[5]) * 1000;
        const netName = fields[7];
        const side: 'top' | 'bottom' = location === '(T)' ? 'top' : 'bottom';

        const pin: Pin = {
          name: pinName,
          number: fields[2],
          position: { x, y },
          radius: 25,
          side,
          net: netName,
        };

        let part = partMap.get(partName);
        if (!part) {
          part = {
            name: partName,
            side,
            type: 'smd',
            origin: { x: 0, y: 0 },
            pins: [],
            bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
          };
          partMap.set(partName, part);
          parts.push(part);
        }
        part.pins.push(pin);
        break;
      }
      case 'Nail': {
        if (fields.length < 8) break;
        const x = parseFloat(fields[1]) * 1000;
        const y = parseFloat(fields[2]) * 1000;
        const side: 'top' | 'bottom' = fields[5] === '(T)' ? 'top' : 'bottom';
        const netName = fields[7];
        nails.push({ position: { x, y }, side, net: netName });
        break;
      }
    }
  }

  // Compute origins and bounds for each part
  for (const part of parts) {
    if (part.pins.length > 0) {
      const positions = part.pins.map(p => p.position);
      part.bounds = computeBBox(positions);
      part.origin = {
        x: (part.bounds.minX + part.bounds.maxX) / 2,
        y: (part.bounds.minY + part.bounds.maxY) / 2,
      };
    }
  }

  const allPoints = [...outline, ...parts.flatMap(p => p.pins.map(pin => pin.position))];
  const bounds = computeBBox(allPoints);
  const nets = buildNets(parts);

  return { format: 'BVR1', outline, parts, nails, nets, bounds };
}
