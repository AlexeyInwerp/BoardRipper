/** HDR selection outline — draws the SAME outline shape the SDR selection
 *  already draws, but brighter than white, on an HDR display.
 *
 *  This is a "super-selection": the selected part's outline burns above SDR
 *  white so it cannot be confused with the thousands of SDR-white neighbours on
 *  a dense board. It is the existing selection rectangle, lit — NOT a halo or
 *  glow behind the part. (An earlier iteration drew a radial blob; that was the
 *  wrong shape.)
 *
 *  Why DOM images and not the Pixi canvas: WebGL has no shipped HDR path,
 *  Canvas2D is 8-bit by spec, and Pixi clamps vertex colours to 8-bit before
 *  they reach the buffer. An HDR *image* is the only technique honoured by both
 *  Chrome and Safari today.
 *
 *  How an IMAGE draws a polygon OUTLINE: one thin `<div>` per polygon edge,
 *  rotated to lie along that edge, each stretching a solid PQ-white tile. That
 *  handles the oriented bounding boxes the SDR outline uses, not just
 *  axis-aligned rectangles.
 *
 *  Why brightness is a sprite swap and not an opacity: opacity compositing
 *  flattens HDR back to SDR (measured on /hdr-probe.html — a sprite at opacity
 *  .6 over a canvas is exactly as bright as plain white). So the ladder of
 *  tiles, each baked at a different peak luminance, IS the brightness control.
 *  Never reintroduce alpha, filter: brightness(), or a CSS mask here — all of
 *  them composite the layer and flatten it.
 *  See docs/specs/2026-08-04-hdr-focus-glow-design.md. */

/** Number of baked luminance rungs (hdr-line-0.avif .. hdr-line-23.avif),
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

export type ScreenPoint = readonly [number, number];

/** One edge's placement in CSS px: where it starts, how long it is, its angle.
 *  Exported for unit testing — the DOM part is trivial, the geometry isn't. */
export interface EdgePlacement { x: number; y: number; length: number; angleRad: number }

/** Lay a polygon out as thick edge segments. Each segment is extended by
 *  `thickness` (half at each end) so the corners meet squarely instead of
 *  leaving notches. Returns one placement per edge, closing the loop. */
export function layoutPolygonEdges(pts: readonly ScreenPoint[], thickness: number): EdgePlacement[] {
  const out: EdgePlacement[] = [];
  const n = pts.length;
  if (n < 2) return out;
  const half = thickness / 2;
  for (let i = 0; i < n; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % n];
    const dx = x1 - x0, dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    if (len < 0.01) continue;          // degenerate edge — skip
    const ux = dx / len, uy = dy / len;
    out.push({
      x: x0 - ux * half,
      y: y0 - uy * half,
      length: len + thickness,
      angleRad: Math.atan2(dy, dx),
    });
  }
  return out;
}

export class HdrSelectionOutline {
  private root: HTMLDivElement;
  private edges: HTMLDivElement[] = [];
  private shownRung = -1;

  constructor(container: HTMLElement) {
    const root = document.createElement('div');
    const s = root.style;
    s.position = 'absolute';
    s.inset = '0';
    s.pointerEvents = 'none';       // pins under the outline must stay clickable
    s.zIndex = '3';                 // above the label overlay (zIndex 2)
    s.overflow = 'hidden';
    s.display = 'none';
    // Tell the compositor not to tone-map this layer down to SDR.
    s.setProperty('dynamic-range-limit', 'no-limit');
    container.appendChild(root);
    this.root = root;
  }

  /** No-op: everything is positioned per-show in CSS px. Present for lifecycle
   *  parity with LabelOverlay, which BoardRenderer calls uniformly. */
  resize(): void { /* intentionally empty */ }

  private edgeAt(i: number): HTMLDivElement {
    let el = this.edges[i];
    if (!el) {
      el = document.createElement('div');
      const s = el.style;
      s.position = 'absolute';
      s.left = '0';
      s.top = '0';
      s.transformOrigin = '0 50%';
      s.backgroundSize = '100% 100%';
      s.backgroundRepeat = 'no-repeat';
      s.willChange = 'transform';
      this.root.appendChild(el);
      this.edges[i] = el;
      this.shownRung = -1;   // fresh element needs its background set
    }
    return el;
  }

  /** Draw `pts` (CSS px, in the container's space) as an outline `thickness` px
   *  wide at the given luminance rung. */
  showPolygon(pts: readonly ScreenPoint[], thickness: number, rung: number): void {
    const placements = layoutPolygonEdges(pts, thickness);
    if (placements.length === 0) { this.hide(); return; }

    const url = `url(/hdr-line-${rung}.avif)`;
    const rungChanged = rung !== this.shownRung;

    for (let i = 0; i < placements.length; i++) {
      const p = placements[i];
      const el = this.edgeAt(i);
      const s = el.style;
      s.width = `${p.length}px`;
      s.height = `${thickness}px`;
      s.transform = `translate(${p.x}px, ${p.y - thickness / 2}px) rotate(${p.angleRad}rad)`;
      if (rungChanged || !s.backgroundImage) s.backgroundImage = url;
      s.display = 'block';
    }
    // Retire any edges left over from a previous, higher-vertex shape.
    for (let i = placements.length; i < this.edges.length; i++) {
      this.edges[i].style.display = 'none';
    }
    this.shownRung = rung;
    this.root.style.display = 'block';
  }

  hide(): void {
    this.root.style.display = 'none';
  }

  destroy(): void {
    this.root.remove();
    this.edges.length = 0;
  }
}
