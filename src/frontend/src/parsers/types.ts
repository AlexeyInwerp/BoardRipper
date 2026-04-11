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
  /** Layer index for multi-layer boards (0-based). Undefined = single-layer. */
  layer?: number;
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

export interface Trace {
  start: Point;
  end: Point;
  width: number;
  net: string;
  /** Layer index for multi-layer boards (0-based). Undefined = single-layer. */
  layer?: number;
}

export interface Via {
  position: Point;
  /** Drill diameter in mils */
  diameter: number;
  net: string;
  /** Connected layer indices (0-based). Empty = through-hole (all layers). */
  layers: number[];
}

export interface BoardData {
  format: string; // format ID from FormatDescriptor.id (e.g. 'BVR1', 'BVR3', 'BRD')
  outline: Point[];
  parts: Part[];
  nails: Nail[];
  nets: Map<string, Net>;
  bounds: BBox;
  traces?: Trace[];
  /** Via/drill holes for multi-layer boards */
  vias?: Via[];
  /** Layer names for multi-layer formats (e.g. TVW butterfly columns). Index = column. */
  layerNames?: string[];
  /** Butterfly fold axis in board coordinates — renderer mirrors this axis for the bottom half.
   *  When 'x', the board store also sets mirrorY on load to correct orientation.
   *  'x' = fold was vertical (left/right split), 'y' = fold was horizontal (top/bottom split). */
  butterflyFoldAxis?: 'x' | 'y';
  /** Per-board flipY override. When set, takes precedence over the format descriptor's flipY. */
  flipY?: boolean;
}

/** Display ID for a pin: prefer name, then number, then 1-based index fallback. */
export function pinDisplayId(pin: Pin, index: number): string {
  return pin.name || pin.number || String(index + 1);
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

/**
 * Compute part origin (center of pin bounds) and bounding box from pin positions.
 * If no pins, returns origin {0,0} with a small default bounding box.
 */
export function computePartGeometry(pins: Pin[]): { origin: Point; bounds: BBox } {
  if (pins.length > 0) {
    const bounds = computeBBox(pins.map(p => p.position));
    const origin: Point = {
      x: (bounds.minX + bounds.maxX) / 2,
      y: (bounds.minY + bounds.maxY) / 2,
    };
    return { origin, bounds };
  }
  return {
    origin: { x: 0, y: 0 },
    bounds: { minX: -50, minY: -50, maxX: 50, maxY: 50 },
  };
}

/**
 * Generate a rectangular outline from a set of points with an optional margin.
 * Returns an empty array if no points are provided.
 */
export function generateSyntheticOutline(points: Point[], margin = 20): Point[] {
  if (points.length === 0) return [];
  const b = computeBBox(points);
  return [
    { x: b.minX - margin, y: b.minY - margin },
    { x: b.maxX + margin, y: b.minY - margin },
    { x: b.maxX + margin, y: b.maxY + margin },
    { x: b.minX - margin, y: b.maxY + margin },
  ];
}

/**
 * Greedy nearest-neighbor chain: connect line segments into a single ordered polygon.
 * Each segment is a pair of points [start, end]. The algorithm picks the closest
 * unvisited segment endpoint to the current chain tail and appends the far endpoint.
 */
export function chainSegments(segments: Array<[Point, Point]>): Point[] {
  if (segments.length === 0) return [];

  const used = new Uint8Array(segments.length);
  const chain: Point[] = [];

  // Start with segment 0: push both endpoints
  chain.push(segments[0][0], segments[0][1]);
  used[0] = 1;

  for (let step = 1; step < segments.length; step++) {
    const last = chain[chain.length - 1];
    let bestIdx = -1;
    let bestDist = Infinity;
    let bestFlip = false;

    for (let j = 0; j < segments.length; j++) {
      if (used[j]) continue;
      const d0 = Math.hypot(last.x - segments[j][0].x, last.y - segments[j][0].y);
      const d1 = Math.hypot(last.x - segments[j][1].x, last.y - segments[j][1].y);
      if (d0 < bestDist) { bestDist = d0; bestIdx = j; bestFlip = false; }
      if (d1 < bestDist) { bestDist = d1; bestIdx = j; bestFlip = true; }
    }

    if (bestIdx < 0) break;
    used[bestIdx] = 1;
    // Append the far endpoint (near endpoint ≈ current chain tail)
    chain.push(bestFlip ? segments[bestIdx][0] : segments[bestIdx][1]);
  }

  return chain;
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
