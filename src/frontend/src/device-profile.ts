/**
 * What kind of machine is this, and what does that cost.
 *
 * Two facts about a tablet drive everything here, and neither is visible from
 * a user-agent string:
 *
 *  - **The primary pointer is a finger.** `(pointer: coarse)` is the media
 *    query for it, and it is the only reliable signal — a Mac with a touch
 *    monitor attached still reports `fine`, and an iPad reports `coarse` in
 *    desktop-mode Safari where the UA claims macOS.
 *  - **The GPU is a tile-based renderer with a 120 Hz panel in front of it.**
 *    An iPad Pro drives 2732×2048 CSS px at DPR 2 — 22 Mpx of backing store —
 *    at up to 120 fps. An M1 absorbs that; an A12Z does not, and the gap is
 *    much wider than the two chips' headline numbers suggest because every
 *    one of the three costs (refresh rate, pixel count, MSAA resolve) is
 *    multiplicative with the others.
 *
 * `touchPerformanceMode` (Settings ▸ Performance & Debug, on by default) trades
 * the three of them back: 60 fps, no MSAA, and a 1.5× render resolution ceiling
 * for the WebGL board. Board *text* is unaffected — the Canvas2D label overlay
 * keeps its own full device pixel ratio — so the visible cost is slightly
 * softer copper and silk, not blurry labels.
 */

/** True when the primary input is a finger — a phone or tablet, not a laptop
 *  with a touchscreen bolted on (that reports `fine` for its trackpad). */
export function isTouchPrimary(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(pointer: coarse)').matches;
}

/** Device pixel ratio ceiling for the WebGL board canvas when the touch
 *  profile is active. 1.5 rather than 1: a tablet is held close enough that
 *  1× copper edges read as aliased, while 1.5 keeps them smooth and still
 *  cuts the fragment count by 44 % against the panel's native 2×. */
export const TOUCH_MAX_PIXEL_RATIO = 1.5;

/** Resolution to hand `Application.init({ resolution })`. */
export function boardPixelRatio(touchPerfMode: boolean): number {
  const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
  if (touchPerfMode && isTouchPrimary()) return Math.min(dpr, TOUCH_MAX_PIXEL_RATIO);
  return dpr;
}

/** Whether to ask for a multisampled default framebuffer. MSAA on a tile GPU
 *  is paid in tile-memory bandwidth on every resolve, which is exactly the
 *  budget a 22 Mpx 120 Hz tablet has none of — and at DPR ≥ 1.5 the
 *  supersampling from the device pixel ratio already hides most of what MSAA
 *  would smooth. */
export function boardAntialias(touchPerfMode: boolean): boolean {
  return !(touchPerfMode && isTouchPrimary());
}

/** Ticker cap in fps (PixiJS reads 0 as uncapped). A 120 Hz ProMotion panel
 *  otherwise doubles the board's GPU work against a 60 Hz one for a
 *  difference no one reports seeing on a pan. */
export function boardMaxFps(cap60: boolean, touchPerfMode: boolean): number {
  if (cap60) return 60;
  if (touchPerfMode && isTouchPrimary()) return 60;
  return 0;
}
