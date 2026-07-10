/** Ranking for the click hit-test stack (BoardRenderer.hitTestStack, #23/#24).
 *
 *  A part enters the stack either because the click is genuinely INSIDE it
 *  (`contained` — body or pad contains the point) or merely because one of its
 *  pins is within the zoom-scaled click threshold (`contained: false`). That
 *  distance threshold balloons in world units when zoomed out, so a tiny test
 *  point NEAR the intended component sneaks into the stack. #24: with a pure
 *  smallest-area-first sort that test point (smallest) won over the component
 *  the click was actually on.
 *
 *  Fix: rank contained hits ahead of distance-only hits, THEN smallest-area
 *  first (the #23 "most specific stacked part wins"), then pin-before-body. A
 *  component the click is inside now beats a nearby test point, while genuinely
 *  stacked (both-contained) parts still resolve smallest-first. */
export interface StackHit {
  partIndex: number;
  pinIndex: number;
  /** Part render-area (world units) — smaller = more specific. */
  area: number;
  /** Intra-part tiebreak: pin entry (0) before whole-body entry (1). */
  sub: number;
  /** True when the click is inside the part's body or a pad; false when it only
   *  fell within a pin's zoom-scaled distance threshold. */
  contained: boolean;
}

/** Comparator: contained-first → smallest-area → pin-before-body. */
export function compareStackHits(a: StackHit, b: StackHit): number {
  return (Number(b.contained) - Number(a.contained)) || (a.area - b.area) || (a.sub - b.sub);
}
