/** Stadium (capsule) geometry for oblong "round" pads.
 *
 *  Several formats (XZZ shape 0x01, oval D-codes) encode oblong pads as a
 *  round-capped stroke: width = the short dimension, length = the long one,
 *  rotated by angleDeg CCW. Drawing these as circles of the long dimension
 *  (the old fallback) inflates a 15×60 QFP lead into a Ø60 blob.
 *
 *  Pure math kept out of board-scene.ts so it can be unit-tested without
 *  importing pixi.js.
 */

export interface CapsuleParams {
  /** First end-cap centre. */
  c1x: number; c1y: number;
  /** Second end-cap centre. */
  c2x: number; c2y: number;
  /** Cap radius (half the short dimension, grow included). */
  r: number;
  /** Direction from c1 to c2 in radians. */
  axisRad: number;
}

/** Compute the two end-cap centres + radius of the stadium inscribed in the
 *  w×h box centred at (cx, cy), rotated angleDeg CCW, expanded by `grow`.
 *  Returns null when the shape degenerates to a circle (square box, or the
 *  grown length no longer exceeds the diameter) — callers should draw a
 *  plain circle in that case. */
export function capsuleParams(
  cx: number, cy: number,
  w: number, h: number,
  angleDeg: number, grow: number,
): CapsuleParams | null {
  const gW = w + grow * 2;
  const gH = h + grow * 2;
  const long = Math.max(gW, gH);
  const short = Math.min(gW, gH);
  const r = short / 2;
  const half = long / 2 - r;          // centre → cap-centre distance
  if (half <= 1e-6 || r <= 0) return null;
  // Long axis: local X when w is the long side, local Y otherwise; then
  // rotate CCW by angleDeg.
  const rad = angleDeg * Math.PI / 180;
  const axisRad = gW >= gH ? rad : rad + Math.PI / 2;
  const ux = Math.cos(axisRad), uy = Math.sin(axisRad);
  return {
    c1x: cx - ux * half, c1y: cy - uy * half,
    c2x: cx + ux * half, c2y: cy + uy * half,
    r,
    axisRad,
  };
}
