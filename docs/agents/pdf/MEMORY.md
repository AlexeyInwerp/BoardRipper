# PDF Agent — Memory

## Status: Stable — Bug-Only Engagement

The PDF pipeline is battle-hardened after a series of stability fixes in v0.3.3–v0.3.5. Do not touch unless a bug is reported.

## Hard-Won Rules

These were learned from production bugs. Violating any of them will cause visual artifacts:

1. **Never call `getContext('2d', { alpha: false })` on persistent canvases** — resetting `canvas.width` doesn't reliably reset the alpha attribute across browsers, causing mirrored/flipped content on reuse.

2. **Never pool pdf.js-rendered canvases** — pdf.js retains internal references. Pooling them causes the next render to paint onto a canvas that pdf.js is still writing to → mirroring.

3. **Shrink canvas backing store synchronously before pooling** — `canvas.width = 1; canvas.height = 1;` MUST happen before returning to pool. Deferring creates a race condition where the pool hands out a canvas with stale large backing store.

4. **Hysteresis band prevents zoom thrashing** — 5% up / 10% down band ensures the tier doesn't flip-flop during smooth zoom. The `hysteresisFilter()` state must be reset when the debounce settles to get a crisp final render.

5. **Preview cache is never evicted by hi-res** — tier-1 previews provide instant fallback during zoom/page transitions. Separate cache namespace.

## Dependencies

- `pdf.js` (pdfjs-dist) — text extraction via `getTextContent()`, page rendering
- `pdf-lib` — metadata manipulation (not rendering)

## Known Limitations

- PDF text extraction can fail on malformed PDFs — backend has a 2-minute timeout per file
- Glyph extraction is a fallback for broken fonts — not all fonts supported
- Canvas pool size of 8 is a balance between memory and pre-render coverage
