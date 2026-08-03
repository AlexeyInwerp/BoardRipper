/** SMPTE ST 2084 (PQ) inverse EOTF: absolute luminance in nits -> 0..1 signal.
 *  Used to bake the HDR glow sprite. PQ is absolute: signal 1.0 always means
 *  10000 cd/m2 regardless of the display, which is what lets a value ride up
 *  into the panel's headroom above SDR white (~100-203 nits). */
const M1 = 2610 / 16384;        // 0.1593017578125
const M2 = (2523 / 4096) * 128; // 78.84375
const C1 = 3424 / 4096;         // 0.8359375
const C2 = (2413 / 4096) * 32;  // 18.8515625
const C3 = (2392 / 4096) * 32;  // 18.6875

export function pqEncode(nits: number): number {
  const Y = Math.min(Math.max(nits, 0), 10000) / 10000;
  if (Y === 0) return 0;
  const Ym = Math.pow(Y, M1);
  return Math.pow((C1 + C2 * Ym) / (1 + C3 * Ym), M2);
}
