/** When the minimap shows itself: not on a single nudge of the board, only
 *  once the user is clearly travelling — the third pan gesture in a chain,
 *  where gestures chain when each starts soon after the last one ended.
 *  It stays while the chain continues and leaves once panning stops.
 *
 *  Pure and clock-injected so the rule is unit-testable without a renderer. */

export interface PanActivityOptions {
  /** Frames closer than this belong to one gesture (inertia included). */
  burstGapMs: number;
  /** A gesture starting within this of the previous one's end continues the chain. */
  chainGapMs: number;
  /** The gesture count at which the minimap appears. */
  gesturesToShow: number;
  /** Idle time after the last pan frame before it hides again. */
  hideAfterMs: number;
}

export const PAN_ACTIVITY_DEFAULTS: PanActivityOptions = {
  burstGapMs: 160,
  chainGapMs: 1500,
  gesturesToShow: 3,
  hideAfterMs: 900,
};

export class PanActivity {
  private lastMove = -Infinity;
  private gestures = 0;
  private shown = false;
  private readonly opts: PanActivityOptions;
  constructor(opts: PanActivityOptions = PAN_ACTIVITY_DEFAULTS) { this.opts = opts; }

  /** One frame of user panning. Returns whether the minimap should show. */
  move(now: number): boolean {
    const gap = now - this.lastMove;
    if (gap > this.opts.burstGapMs) {
      // A new gesture: it continues the chain only if the last one ended recently.
      this.gestures = gap <= this.opts.chainGapMs ? this.gestures + 1 : 1;
    }
    this.lastMove = now;
    if (this.gestures >= this.opts.gesturesToShow) this.shown = true;
    return this.shown;
  }

  /** Whether the minimap should be showing at `now`. */
  visible(now: number): boolean {
    if (this.shown && now - this.lastMove > this.opts.hideAfterMs) {
      this.shown = false;
      this.gestures = 0;
    }
    return this.shown;
  }

  /** When `visible` will next turn false, if it is showing. */
  hideAt(): number | null {
    return this.shown ? this.lastMove + this.opts.hideAfterMs : null;
  }

  /** Keep it up without counting a gesture (pointer resting on the minimap). */
  touch(now: number) { if (this.shown) this.lastMove = now; }
}
