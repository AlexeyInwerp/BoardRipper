// src/frontend/src/pdf/bezier-utils.ts

export interface Point { x: number; y: number; }

/** Sample a quadratic Bezier curve into polyline points (adaptive subdivision). */
export function sampleQuadratic(
  p0: Point, p1: Point, p2: Point, tolerance = 0.5,
): Point[] {
  const points: Point[] = [p0];
  subdivideQuad(p0, p1, p2, tolerance, points);
  points.push(p2);
  return points;
}

function subdivideQuad(p0: Point, p1: Point, p2: Point, tol: number, out: Point[]) {
  const mx = (p0.x + p2.x) / 2;
  const my = (p0.y + p2.y) / 2;
  const d = Math.abs(p1.x - mx) + Math.abs(p1.y - my);
  if (d < tol) return;
  const q0 = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
  const q1 = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
  const mid = { x: (q0.x + q1.x) / 2, y: (q0.y + q1.y) / 2 };
  subdivideQuad(p0, q0, mid, tol, out);
  out.push(mid);
  subdivideQuad(mid, q1, p2, tol, out);
}

/** Sample a cubic Bezier curve into polyline points (adaptive subdivision). */
export function sampleCubic(
  p0: Point, p1: Point, p2: Point, p3: Point, tolerance = 0.5,
): Point[] {
  const points: Point[] = [p0];
  subdivideCubic(p0, p1, p2, p3, tolerance, points);
  points.push(p3);
  return points;
}

function subdivideCubic(
  p0: Point, p1: Point, p2: Point, p3: Point, tol: number, out: Point[],
) {
  const dx = p3.x - p0.x;
  const dy = p3.y - p0.y;
  const d1 = Math.abs((p1.x - p3.x) * dy - (p1.y - p3.y) * dx);
  const d2 = Math.abs((p2.x - p3.x) * dy - (p2.y - p3.y) * dx);
  const dSq = d1 + d2;
  const lenSq = dx * dx + dy * dy;
  if (dSq * dSq <= tol * tol * lenSq) return;
  const q0 = mid(p0, p1), q1 = mid(p1, p2), q2 = mid(p2, p3);
  const r0 = mid(q0, q1), r1 = mid(q1, q2);
  const s = mid(r0, r1);
  subdivideCubic(p0, q0, r0, s, tol, out);
  out.push(s);
  subdivideCubic(s, r1, q2, p3, tol, out);
}

function mid(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/** Ramer-Douglas-Peucker line simplification. */
export function rdpSimplify(points: Point[], epsilon: number): Point[] {
  if (points.length <= 2) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  rdpRecurse(points, 0, points.length - 1, epsilon, keep);
  const result: Point[] = [];
  for (let i = 0; i < points.length; i++) {
    if (keep[i]) result.push(points[i]);
  }
  return result;
}

function rdpRecurse(
  pts: Point[], start: number, end: number, eps: number, keep: Uint8Array,
) {
  let maxDist = 0;
  let maxIdx = start;
  const dx = pts[end].x - pts[start].x;
  const dy = pts[end].y - pts[start].y;
  const lenSq = dx * dx + dy * dy;

  for (let i = start + 1; i < end; i++) {
    let dist: number;
    if (lenSq === 0) {
      const ex = pts[i].x - pts[start].x;
      const ey = pts[i].y - pts[start].y;
      dist = Math.sqrt(ex * ex + ey * ey);
    } else {
      const cross = Math.abs((pts[i].x - pts[start].x) * dy - (pts[i].y - pts[start].y) * dx);
      dist = cross / Math.sqrt(lenSq);
    }
    if (dist > maxDist) { maxDist = dist; maxIdx = i; }
  }

  if (maxDist > eps) {
    keep[maxIdx] = 1;
    if (maxIdx - start > 1) rdpRecurse(pts, start, maxIdx, eps, keep);
    if (end - maxIdx > 1) rdpRecurse(pts, maxIdx, end, eps, keep);
  }
}
