/**
 * Recovering the position of components a file defines but never places.
 *
 * Some Allegro files are shipped with components *unplaced* — the footprint
 * instance is gone, so every pad record carries zero coords and no padstack —
 * while their routing is left untouched. Compal LA-P161P is one: 67 components
 * including the BQ24800 charger, both SO-DIMM sockets and every board-edge
 * connector. Nothing in the file says where they are, so a viewer that only
 * reads stored geometry has to drop them, and the board becomes hard to
 * troubleshoot exactly where the interesting parts live.
 *
 * But the copper still runs to where the pads were. A trace that ended on a
 * now-absent pad ends on nothing: an endpoint used by exactly one segment and
 * sitting on no placed pad. Those *dangling* endpoints are the footprint's
 * ghost — on PUB1 they reproduce three sides of a 0.4 mm-pitch QFN ring.
 *
 * This module turns that ghost back into a position. It is inference, not data
 * recovery: callers must mark what it returns as inferred and never present it
 * as the file's own placement.
 */

import type { Point, Trace } from '../types';

/** Endpoints that belong to no placed pad, grouped by net. */
export interface DanglingIndex {
  byNet: Map<string, Point[]>;
  /** Copper layer each loose end sits on, keyed like `key(point)`. Lets a
   *  caller tell which side a recovered component is mounted on. */
  layerAt: Map<string, number>;
}

/** Quantise to 0.1 mil so endpoint identity survives float arithmetic. */
export function pointKey(p: Point): string {
  return `${Math.round(p.x * 10)},${Math.round(p.y * 10)}`;
}

/**
 * Build the dangling-endpoint index.
 *
 * `terminatorKeys` are the quantised positions of everything a trace may
 * legitimately end on and still be fully routed: pads that DO exist, and
 * **vias**. Vias matter — a trace dropping to another layer ends in mid-air as
 * far as this pass is concerned, and counting those as ghosts is what put a
 * tail of mis-placed pins on the measurement. An endpoint shared by two or
 * more segments is a corner or a junction, not a termination.
 */
export function buildDanglingIndex(traces: Trace[], terminatorKeys: Set<string>): DanglingIndex {
  const degree = new Map<string, number>();
  const point = new Map<string, { p: Point; net: string; layer: number }>();

  for (const t of traces) {
    for (const p of [t.start, t.end]) {
      const k = `${t.net}|${pointKey(p)}`;
      degree.set(k, (degree.get(k) ?? 0) + 1);
      if (!point.has(k)) point.set(k, { p, net: t.net, layer: t.layer ?? 0 });
    }
  }

  const byNet = new Map<string, Point[]>();
  const layerAt = new Map<string, number>();
  for (const [k, n] of degree) {
    if (n !== 1) continue;
    const e = point.get(k)!;
    if (terminatorKeys.has(pointKey(e.p))) continue;
    let arr = byNet.get(e.net);
    if (!arr) byNet.set(e.net, arr = []);
    arr.push(e.p);
    layerAt.set(pointKey(e.p), e.layer);
  }
  return { byNet, layerAt };
}

export interface InferredPlacement {
  origin: Point;
  /** One entry per input pin; null where no dangling endpoint could be claimed. */
  pinPositions: Array<Point | null>;
  /** How many pins were located. */
  resolved: number;
  /** Bounding box of the located pins. */
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

/**
 * A net with dangling ends all over the board (GND, a rail) says nothing about
 * where any one component sits. Only nets with a handful of loose ends are
 * private enough to seed a cluster; the rest are still used afterwards, once
 * the cluster is known, to claim their own pin.
 */
const MAX_SEED_ENDS = 6;

/** Region-growing radius. Wide enough to walk along a connector's pad row,
 *  tight enough not to jump to the next component. */
const GROW_EPS = 120;

/** A pin is only claimed by a ghost endpoint this close to the cluster. */
const CLAIM_RADIUS = 150;

/** Below this, a "cluster" is a coincidence rather than a footprint. */
const MIN_RESOLVED = 4;

/**
 * Small parts are not inferable and pretending otherwise is harmful. A 2-pin
 * resistor's nets are shared with half the circuit, so its "private" seeds are
 * other people's loose ends: measured leave-one-out against placed parts, the
 * 2-4 pin bucket came back with a median per-pin error over 1100 mils, while
 * parts of 21+ pins came back exact. Multi-pin ICs and connectors are also the
 * parts worth recovering — an unplaced 0402 is not what makes a board hard to
 * troubleshoot.
 */
const MIN_PINS = 5;

/** At least this share of a part's pins must resolve before we believe the
 *  cluster is really that part's footprint. */
const MIN_RESOLVED_FRACTION = 0.10;

/** No single component's pad ring spans more than this. Guards against a
 *  cluster wandering across the board through a chain of loose ends. */
const MAX_CLUSTER_SPAN = 4000;

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Infer where a component sits from the loose ends of its own nets.
 *
 * `pinNets[i]` is pin i's net. Returns null when the ghost is too faint to
 * trust — a part with no routing (an unplaced mounting hole) resolves nothing,
 * and that is the correct answer for it.
 */
export function inferPlacement(pinNets: string[], idx: DanglingIndex): InferredPlacement | null {
  if (pinNets.length < MIN_PINS) return null;

  // Seed from the component's private nets only.
  const seeds: Point[] = [];
  for (const net of new Set(pinNets)) {
    const ends = idx.byNet.get(net);
    if (ends && ends.length >= 1 && ends.length <= MAX_SEED_ENDS) seeds.push(...ends);
  }
  if (seeds.length < MIN_RESOLVED) return null;

  // Densest seed: the one with the most neighbours inside the growing radius.
  let best = seeds[0], bestN = -1;
  for (const s of seeds) {
    let n = 0;
    for (const o of seeds) if (dist(s, o) <= GROW_EPS) n++;
    if (n > bestN) { bestN = n; best = s; }
  }

  // Grow a cluster outward from it, so an elongated connector's pad row is
  // followed rather than cut off by a fixed radius around the centre.
  const cluster: Point[] = [best];
  const used = new Set<Point>([best]);
  for (let i = 0; i < cluster.length; i++) {
    for (const s of seeds) {
      if (used.has(s)) continue;
      if (dist(cluster[i], s) <= GROW_EPS) { used.add(s); cluster.push(s); }
    }
  }
  if (cluster.length < MIN_RESOLVED) return null;

  const cxs = cluster.map((p) => p.x), cys = cluster.map((p) => p.y);
  if (Math.max(...cxs) - Math.min(...cxs) > MAX_CLUSTER_SPAN) return null;
  if (Math.max(...cys) - Math.min(...cys) > MAX_CLUSTER_SPAN) return null;

  // Claim one endpoint per pin: the nearest loose end on that pin's own net
  // that lies near the cluster, each endpoint claimed at most once.
  const nearCluster = (p: Point) => cluster.some((c) => dist(c, p) <= CLAIM_RADIUS);

  // Claim a pin ONLY when the answer is unambiguous: exactly one loose end of
  // that pin's net lies near the cluster. Picking the nearest of several
  // candidates looks like more coverage and is mostly wrong — measured against
  // placed parts it moved the per-pin p90 from 164 mils to over 1000. A pin we
  // decline to place is honest; a pin placed on the wrong pad is a bad probe.
  const taken = new Set<string>();
  const pinPositions: Array<Point | null> = [];
  for (const net of pinNets) {
    const ends = (idx.byNet.get(net) ?? []).filter((p) => !taken.has(pointKey(p)) && nearCluster(p));
    if (ends.length !== 1) { pinPositions.push(null); continue; }
    taken.add(pointKey(ends[0]));
    pinPositions.push(ends[0]);
  }

  // Trim outliers: a footprint's pads are mutually close, so keep only the
  // largest group of claimed points that are connected within the growing
  // radius. One stray claim on the far side of a shared net would otherwise
  // stretch the inferred body well past the real package.
  {
    const claimed = pinPositions
      .map((p, i) => ({ p, i }))
      .filter((e): e is { p: Point; i: number } => e.p !== null);
    const seenIdx = new Set<number>();
    let biggest: number[] = [];
    for (const start of claimed) {
      if (seenIdx.has(start.i)) continue;
      const group = [start.i];
      seenIdx.add(start.i);
      for (let g = 0; g < group.length; g++) {
        for (const o of claimed) {
          if (seenIdx.has(o.i)) continue;
          if (dist(pinPositions[group[g]]!, o.p) <= GROW_EPS) { seenIdx.add(o.i); group.push(o.i); }
        }
      }
      if (group.length > biggest.length) biggest = group;
    }
    const keep = new Set(biggest);
    for (let i = 0; i < pinPositions.length; i++) if (pinPositions[i] && !keep.has(i)) pinPositions[i] = null;
  }

  const located = pinPositions.filter((p): p is Point => p !== null);
  if (located.length < MIN_RESOLVED) return null;
  if (located.length / pinNets.length < MIN_RESOLVED_FRACTION) return null;

  const xs = located.map((p) => p.x), ys = located.map((p) => p.y);
  const bounds = {
    minX: Math.min(...xs), minY: Math.min(...ys),
    maxX: Math.max(...xs), maxY: Math.max(...ys),
  };
  return {
    origin: { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 },
    pinPositions,
    resolved: located.length,
    bounds,
  };
}

export const __testing = { key: pointKey, GROW_EPS, CLAIM_RADIUS, MIN_RESOLVED, MAX_SEED_ENDS, MIN_PINS };
