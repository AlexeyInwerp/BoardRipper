export interface Point {
  x: number;
  y: number;
}

export interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface Pin {
  name: string;
  number: string;
  position: Point;
  radius: number;
  side: 'top' | 'bottom';
  net: string;
}

export interface Part {
  name: string;
  side: 'top' | 'bottom' | 'both';
  type: 'smd' | 'throughhole';
  origin: Point;
  pins: Pin[];
  bounds: BBox;
}

export interface Nail {
  position: Point;
  side: 'top' | 'bottom';
  net: string;
}

export interface Net {
  name: string;
  pinIndices: Array<{ partIndex: number; pinIndex: number }>;
}

export interface BoardData {
  format: 'BVR1' | 'BVR3';
  outline: Point[];
  parts: Part[];
  nails: Nail[];
  nets: Map<string, Net>;
  bounds: BBox;
}

export function computeBBox(points: Point[]): BBox {
  if (points.length === 0) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

export function buildNets(parts: Part[]): Map<string, Net> {
  const nets = new Map<string, Net>();
  for (let pi = 0; pi < parts.length; pi++) {
    const part = parts[pi];
    for (let pni = 0; pni < part.pins.length; pni++) {
      const pin = part.pins[pni];
      if (!pin.net || pin.net === '(null)' || pin.net === '') continue;
      let net = nets.get(pin.net);
      if (!net) {
        net = { name: pin.net, pinIndices: [] };
        nets.set(pin.net, net);
      }
      net.pinIndices.push({ partIndex: pi, pinIndex: pni });
    }
  }
  return nets;
}
