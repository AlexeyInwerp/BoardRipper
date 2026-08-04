/** HDR focus glow — a DOM layer above the Pixi canvas carrying a PQ-encoded
 *  AVIF sprite, so the element the user navigated to can ride up into the
 *  display's headroom above SDR white. Nothing else on screen can produce that
 *  brightness, which is the whole point.
 *
 *  Why DOM and not the Pixi canvas: WebGL has no shipped HDR path, Canvas2D is
 *  8-bit by spec, and Pixi clamps vertex colours to 8-bit before they reach the
 *  buffer. An HDR *image* is the only route that works in both Chrome and
 *  Safari today. Cost: soft blobs only — no HDR outlines or strokes.
 *
 *  Why brightness is a sprite swap and not an opacity: opacity compositing
 *  flattens HDR back to SDR (measured on /hdr-probe.html — a glow at opacity
 *  .6 over a canvas is exactly as bright as plain white). So the ladder of
 *  sprites, each baked at a different peak luminance, IS the brightness
 *  control. Never reintroduce alpha here.
 *  See docs/specs/2026-08-04-hdr-focus-glow-design.md. */

/** Number of baked luminance rungs (hdr-glow-0.avif .. hdr-glow-23.avif),
 *  4000 nits down to 200. Rung 0 is brightest. */
export const GLOW_RUNGS = 24;

/** Map the user-facing 1-10 intensity onto a rung. 10 = brightest = rung 0. */
export function rungForIntensity(intensity: number): number {
  const clamped = Math.min(10, Math.max(1, intensity));
  const rung = Math.round(((10 - clamped) / 9) * (GLOW_RUNGS - 1));
  return Math.min(GLOW_RUNGS - 1, Math.max(0, rung));
}

const HDR_QUERY = '(dynamic-range: high)';

/** True when the browser AND the current display can show content above SDR
 *  white. Dynamic: docking to an SDR monitor, or iOS/macOS Low Power Mode
 *  forcing the panel to SDR, flips this at runtime. */
export function isHdrCapable(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia(HDR_QUERY).matches;
}

/** Subscribe to capability changes. Returns an unsubscribe function. */
export function onHdrCapabilityChange(cb: (capable: boolean) => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};
  const mq = window.matchMedia(HDR_QUERY);
  const handler = (e: MediaQueryListEvent) => cb(e.matches);
  mq.addEventListener('change', handler);
  return () => mq.removeEventListener('change', handler);
}

export class HdrGlowOverlay {
  private el: HTMLDivElement;
  private shownRung = -1;

  constructor(container: HTMLElement) {
    const el = document.createElement('div');
    const s = el.style;
    s.position = 'absolute';
    s.left = '0';
    s.top = '0';
    s.pointerEvents = 'none';       // pins under the glow must stay clickable
    s.zIndex = '3';                 // above the label overlay (zIndex 2)
    s.backgroundSize = 'contain';
    s.backgroundRepeat = 'no-repeat';
    s.display = 'none';
    s.willChange = 'transform';
    // Tell the compositor not to tone-map this layer down to SDR.
    s.setProperty('dynamic-range-limit', 'no-limit');
    container.appendChild(el);
    this.el = el;
  }

  /** No-op: the sprite is sized per-show in CSS px, so there is nothing
   *  resolution-dependent to rebuild. Present for lifecycle parity with
   *  LabelOverlay, which BoardRenderer calls uniformly. */
  resize(): void { /* intentionally empty */ }

  /** Place and light the glow. Coordinates are CSS px in the container's space
   *  (the same space LabelOverlay draws in); `cssSize` is the sprite diameter;
   *  `rung` selects the baked luminance. NOTE: no alpha parameter — see the
   *  class comment. */
  show(cssX: number, cssY: number, cssSize: number, rung: number): void {
    const s = this.el.style;
    const half = cssSize / 2;
    s.width = `${cssSize}px`;
    s.height = `${cssSize}px`;
    s.transform = `translate(${cssX - half}px, ${cssY - half}px)`;
    if (rung !== this.shownRung) {
      s.backgroundImage = `url(/hdr-glow-${rung}.avif)`;
      this.shownRung = rung;
    }
    s.display = 'block';
  }

  hide(): void {
    this.el.style.display = 'none';
  }

  destroy(): void {
    this.el.remove();
  }
}
