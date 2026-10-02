/** When the minimap shows itself. It is a locator, so it is only worth the
 *  screen space when the user is (a) zoomed in far enough to lose the board
 *  — at least `minZoom` times the fit view, i.e. the screen shows half the
 *  board or less at the default 2 — and (b) has actually travelled: the pans
 *  of one chain have moved the board by `travelFraction` of the screen in
 *  either axis (net, so wiggling in place does not count). Pans chain while
 *  each starts within `chainGapMs` of the last frame; a longer pause starts
 *  a new chain from zero. It leaves `hideAfterMs` after panning stops.
 *
 *  Pure and clock-injected so the rule is unit-testable without a renderer. */

export interface PanActivityOptions {
  /** Zoom relative to the fit view below which it never shows. */
  minZoom: number;
  /** Net travel, as a fraction of the screen's width (x) or height (y). */
  travelFraction: number;
  /** A pan frame within this of the previous one continues the chain. */
  chainGapMs: number;
  /** Idle time after the last pan frame before it hides again. */
  hideAfterMs: number;
}

export const PAN_ACTIVITY_DEFAULTS: PanActivityOptions = {
  minZoom: 2,
  travelFraction: 0.12,
  chainGapMs: 1500,
  hideAfterMs: 900,
};

export interface PanFrame {
  /** Screen px the board moved this frame. */
  dx: number;
  dy: number;
  /** Screen size, px. */
  width: number;
  height: number;
  /** Current zoom relative to the fit view (1 = whole board fits). */
  zoom: number;
}

export class PanActivity {
  private lastMove = -Infinity;
  private sumX = 0;
  private sumY = 0;
  private shown = false;
  private readonly opts: PanActivityOptions;
  constructor(opts: PanActivityOptions = PAN_ACTIVITY_DEFAULTS) { this.opts = opts; }

  /** One frame of user panning. Returns whether the minimap should show. */
  move(now: number, f: PanFrame): boolean {
    if (now - this.lastMove > this.opts.chainGapMs) { this.sumX = 0; this.sumY = 0; }
    this.lastMove = now;
    this.sumX += f.dx;
    this.sumY += f.dy;
    if (!this.shown && f.zoom >= this.opts.minZoom &&
        (Math.abs(this.sumX) >= this.opts.travelFraction * f.width ||
         Math.abs(this.sumY) >= this.opts.travelFraction * f.height)) {
      this.shown = true;
    }
    return this.shown;
  }

  /** Whether the minimap should be showing at `now`. */
  visible(now: number): boolean {
    if (this.shown && now - this.lastMove > this.opts.hideAfterMs) {
      this.shown = false;
      this.sumX = 0;
      this.sumY = 0;
    }
    return this.shown;
  }

  /** When `visible` will next turn false, if it is showing. */
  hideAt(): number | null {
    return this.shown ? this.lastMove + this.opts.hideAfterMs : null;
  }

  /** Keep it up without counting travel (pointer resting on the minimap). */
  touch(now: number) { if (this.shown) this.lastMove = now; }
}
