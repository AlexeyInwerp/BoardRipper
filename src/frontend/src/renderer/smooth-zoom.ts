/** Frame-rate-independent exponential approach used for wheel-zoom tweening.
 *  value' = value + (target − value) · (1 − e^(−dt·rate)); snaps within a
 *  relative epsilon so animations terminate exactly. Rate 18/s ≈ 60 ms to
 *  90% — matches the [external viewer] feel documented in
 *  docs/research/renderer-research-2026-07-19.md §1.6. */

export const ZOOM_TWEEN_RATE = 18;

export function stepExpApproach(current: number, target: number, dtMs: number, rate: number): number {
  const delta = target - current;
  const eps = Math.max(Math.abs(current) * 5e-4, 1e-6);
  if (Math.abs(delta) <= eps) return target;
  const k = 1 - Math.exp(-(dtMs / 1000) * rate);
  const next = current + delta * k;
  // A huge dt (tab was backgrounded) must not overshoot past the target.
  return delta > 0 ? Math.min(next, target) : Math.max(next, target);
}
