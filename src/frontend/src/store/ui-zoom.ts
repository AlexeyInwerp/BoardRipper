/**
 * The interface scale as the browser applies it: `body { zoom: var(--ui-scale) }`.
 *
 * A `position: fixed` element inside the zoomed body has its `left`/`top`
 * multiplied by this factor, while `clientX`, `pageX` and
 * `getBoundingClientRect()` report unzoomed viewport pixels. Every popup that
 * is placed from pointer or anchor coordinates therefore divides by it —
 * at 125 % the ribbon's suggestion list landed a quarter of the way across
 * the screen to the right of its field, at 80 % to the left and above it
 * (2026-10-22).
 */
export function uiZoom(doc: Document = document): number {
  const z = parseFloat(getComputedStyle(doc.body).zoom as string);
  return Number.isFinite(z) && z > 0 ? z : 1;
}
