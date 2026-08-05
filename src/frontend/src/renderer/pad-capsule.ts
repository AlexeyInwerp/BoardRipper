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

/** Structural subset of `Pin` this module reasons about — keeps the capsule
 *  rules importable by unit tests without dragging in the parser types. */
export interface CapsulePinLike {
  padShape?: string;
  padWidth?: number;
  padHeight?: number;
  padAngleDeg?: number;
}

/** True when a pin's pad is a genuine stadium: shape 'round' with two
 *  positive, unequal dimensions. Square round pads are circles, and every
 *  other shape (rect, roundrect, poly) has its own drawing path.
 *
 *  The rule lives beside the capsule math rather than in board-scene.ts
 *  because both the scene builder and BoardRenderer's six highlight paths ask
 *  the same question, and they used to answer it in seven different places. */
export function isOblongRoundPad(pin: CapsulePinLike): boolean {
  return pin.padShape === 'round'
    && pin.padWidth  != null && pin.padWidth  > 0
    && pin.padHeight != null && pin.padHeight > 0
    && pin.padWidth !== pin.padHeight;
}

/** The `grow` that makes a capsule's pen exactly `2 * radius`.
 *
 *  A circle takes pin-size settings as a scalar radius; a capsule has no
 *  single radius, so the same intent has to become an outward offset of the
 *  whole stadium. `grow` is a true geometric offset — it cancels out of the
 *  centre→cap-centre distance — so offsetting by (radius − short/2) sets the
 *  pen to 2·radius while leaving the pad's skeleton, and therefore its
 *  length and orientation, exactly where the file put them.
 *
 *  This is what keeps the pin-size slider working on boards where most pins
 *  are oblong: on PL5TU1B 5,413 of 9,002 pins are capsules, and drawing them
 *  from raw pad dims would have made the setting a no-op across the board. */
export function capsuleGrowForRadius(pin: CapsulePinLike, radius: number): number {
  const short = Math.min(pin.padWidth ?? 0, pin.padHeight ?? 0);
  return radius - short / 2;
}

/** Sample a capsule outline as a closed polygon, `perCap` points per end cap.
 *
 *  For consumers that need vertices rather than a draw call — the HDR
 *  selection outline builds one rotated DIV per polygon edge, so it cannot
 *  use `arc`. Degenerate capsules return null; the caller falls back to its
 *  circle path, which is what the shape has become. */
export function capsulePolygon(
  cx: number, cy: number,
  w: number, h: number,
  angleDeg: number, grow: number,
  perCap = 12,
): Array<readonly [number, number]> | null {
  const cap = capsuleParams(cx, cy, w, h, angleDeg, grow);
  if (!cap) return null;
  const pts: Array<readonly [number, number]> = [];
  // Cap 1 sweeps the far half-circle, cap 2 the near one; walking them in this
  // order yields a single closed loop with the straight flanks implied by the
  // join between the two arcs.
  for (let i = 0; i <= perCap; i++) {
    const a = cap.axisRad + Math.PI / 2 + (i / perCap) * Math.PI;
    pts.push([cap.c1x + Math.cos(a) * cap.r, cap.c1y + Math.sin(a) * cap.r]);
  }
  for (let i = 0; i <= perCap; i++) {
    const a = cap.axisRad - Math.PI / 2 + (i / perCap) * Math.PI;
    pts.push([cap.c2x + Math.cos(a) * cap.r, cap.c2y + Math.sin(a) * cap.r]);
  }
  return pts;
}
