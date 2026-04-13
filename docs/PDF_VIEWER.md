# PDF Viewer Architecture

Authoritative reference for BoardRipper's PDF viewer pipeline. Complements the
PDF-related bullets in `CLAUDE.md` with the level of detail needed to work on
the render path without breaking it.

## Goals

- Read large engineering schematics (50–500+ pages, A3 at 300 DPI+) smoothly in
  a browser, side-by-side with a board view
- Support zoom up to ~10× with text that stays crisp enough to read component
  designators
- Multi-page vertical scroll with seamless transitions
- Search + multi-term grouping + click-to-lookup tied back to board components
- Erase vendor watermarks (`www.chinafix.com`, etc.) before they ever reach the
  canvas
- Run on integrated-GPU laptops without melting the machine

## Core files

| File | Responsibility |
|---|---|
| `src/frontend/src/panels/PdfViewerPanel.tsx` | React panel, event handling, render orchestration, tier math, tile DOM management |
| `src/frontend/src/pdf/tile-manager.ts` | Tile grid math, `ImageBitmap` LRU tile cache |
| `src/frontend/src/store/pdf-store.ts` | Document lifecycle, text extraction, watermark skip sets, `getPageFor` |
| `src/frontend/src/hooks/usePdfStore.ts` | `useSyncExternalStore` snapshots for per-document state |
| `src/frontend/src/store/render-settings.ts` | Quality presets, watermark filter config, `isPdfWatermarkText` |
| `docs/PDF_VIEWER.md` | This file |

## Two render paths, one router

`renderActive()` in `PdfViewerPanel.tsx` routes every render request based on
`zoomRef.current`:

- **zoom ≤ 1.05 — full-page path** (`renderPage`): renders the whole current
  page to a pooled offscreen canvas, produces an `ImageBitmap`, caches it in
  `_pageCache` keyed by `(file, page, tier, cleanMode)`, blits to the visible
  main canvas. Adjacent pages (one above, one below) are rendered separately by
  `renderPageToBitmap` into `adjCanvasMapRef` for vertical scroll continuity.
- **zoom > 1.05 — tiled path** (`renderTiledPage`): divides the page into
  1024×1024 pixel tiles via `tile-manager.computeTileGrid`, checks each tile
  against the LRU tile cache, renders misses sequentially with pdf.js's
  `viewport.offsetX/offsetY` trick (no composite canvas), blits rendered tiles
  in a single `requestAnimationFrame`.

The 1.05 threshold has hysteresis built in: we don't switch paths on tiny
sub-percent zoom changes. At the boundary, `clearTileDom()` and the main-canvas
visibility toggle (`tiledMode` state) handle the handoff.

## The tier pipeline

Every render goes through four transforms before calling `page.render()`:

```
zoom → mainTierFromZoom → quantiseTier → hysteresisFilter → clampCanvasScale
```

- **`mainTierFromZoom(zoom, maxTier)`** — clamps zoom into `[1, maxTier]`.
  `maxTier` comes from the active quality preset (`QUALITY_CONFIGS[quality].maxMainTier`).
- **`quantiseTier(tier)`** — snaps to half-integer steps (1, 1.5, 2, 2.5, …).
  Reduces cache key fragmentation so a user's zoom-to-1.37× hits the same cache
  entry as zoom-to-1.52×.
- **`hysteresisFilter(rawTier)`** — module-global state (`_lastCommittedTier`)
  with 5% upgrade threshold and 10% downgrade threshold. Prevents render
  thrashing at quantisation boundaries. The hysteresis state is reset to 0
  inside the `scheduleTierRender` trailing debounce so the final settle render
  always commits to the exact requested tier.
- **`clampCanvasScale(pageW, pageH, scale, maxDim)`** — clamps both individual
  canvas dimensions (`maxDim × maxDim`) and total pixel area (`maxDim²`). When
  a clamp actually reduces the requested scale, a one-shot warning is emitted
  via `log.perf.warn` (throttled per `pageW:pageH:maxDim` so it doesn't spam).

Final render scale: `hiresScale = baseScale × resTier × devicePixelRatio` then
clamped. `baseScale` is `containerWidth / unscaledViewport.width` so the page
CSS width always equals the container width.

## Adaptive throttle + trailing debounce (scheduleTierRender)

Every zoom event calls `scheduleTierRender()`, which does three things:

1. **Schedules a trailing debounce** (60 ms) that resets hysteresis and
   triggers one final crisp render. This is the "settle" — guarantees the
   final frame is at exact tier, not a CSS-scaled blurry backdrop.
2. **Fires an adaptive-throttle render** if the new candidate tier is higher
   than the currently displayed tier and the EMA of recent render times
   allows it. Throttle delay = `max(ema × 1.5, 16 ms)`. Fast pages get near-
   instant re-renders; slow pages get CSS-scaled zoom with the settle making up
   for it.
3. **Schedules a crisp-settle timer** (500 ms) that forces a full-tier render
   when the user has zoomed past the preset cap, accepting a longer wait in
   exchange for ultimate sharpness.

The "zooming out uses CSS downscale" optimisation is deliberate: tiles and
cached bitmaps at higher tiers look perfectly sharp when CSS-scaled down, so
we don't need to re-render on the way down.

## Page-level bitmap caches

Two caches, both module-level, both sized from the active quality preset:

- **`_pageCache`** (LRU) — stores rendered `ImageBitmap`s at all tiers. Keyed
  by `(file, page, tier, cleanMode)`. Bounded by BOTH entry count
  (`cacheMaxEntries`) AND total pixel area (`cacheMaxPixels`) — the tighter
  constraint wins. `getBestPageCache()` returns the highest-tier hit for a
  given `(file, page, cleanMode)` regardless of tier, used as the "no-blur
  flash" fallback while a fresh tier renders in the background.
- **`_previewCache`** (separate LRU, tier-1 only, 6 entries max) — dedicated
  to cheap backdrop fallbacks. Never evicted by hi-res bitmap pressure, so
  there's always a soft-but-present preview to blit when all else fails.

Both caches key on `cleanMode` because clean-mode renders apply a contrast
filter and must not mix with normal renders.

## Tile cache (tile-manager.ts)

A module-global LRU keyed by `(file, page, col, row, scale)`. Bounded by total
pixel area, configured via `setTileCacheLimit(maxPixels)` which follows the
active quality preset.

- `visibleTiles(viewport, grid)` returns tiles intersecting the viewport in
  center-out order so nearest tiles render first.
- `getTileCached` and `putTileCached` do their own LRU move-to-end and pixel-
  budget eviction, closing `ImageBitmap`s when evicted.
- `invalidateTileCache(file)` drops all tiles for a given document (called on
  clean mode toggle, watermark filter change, document close).

Per-tile DOM canvases live in `tileContainerRef.current` keyed by
`"${page}:${col}:${row}:${renderScale}"`. The page number is in the key so a
page transition at the same scale doesn't collide with the previous page's
tiles. When the DOM budget (`MAX_TILE_DOM = 80`) is exceeded, tiles not at the
current render scale are evicted first (oldest-insertion-order wins).

## Adjacent page rendering

When the user scrolls vertically and the next/previous page becomes visible in
the viewport, `adjCanvasMapRef` tracks a separate `HTMLCanvasElement` per
adjacent page. `renderPageToBitmap` is the shared path used by both the full-
page route and the adjacent-page effect, which lets adjacent pages reuse
`_pageCache` entries from normal navigation.

Adjacent pages render at `min(mainTier, maxAdjTier)` — capped at 4× for the
"high" preset even when the main page is at 10× — because seeing a slightly
soft next-page through the viewport edge is fine, and cutting their tier
dramatically reduces GPU pressure during high-zoom scrolling.

The adjacent-page effect is debounced (`adjSettleMs` from the quality preset,
100–300 ms) so we don't keep re-rendering neighbors during active zoom.

## Watermark filter (operator-level)

Vendor watermarks like `"w w w . c h i n a f i x . c o m"` at 50 pt rotated
45° are stripped at the pdf.js operator-list level — not by clipping, not by
post-processing:

1. `pdfStore.getWatermarkSkipSet(file, pageIndex)` computes a `Set<number>` of
   pdf.js operator indices corresponding to glyph-drawing operators
   (`OPS.showText` = 44, `OPS.showSpacedText` = 45, `OPS.nextLineShowText` =
   46, `OPS.nextLineSetSpacingShowText` = 47) whose effective font size
   (`|textMatrixScale × fontSize|`) matches any configured watermark text
   item's font size within 5% relative tolerance. The scanner walks the op
   list in order, tracking `setFont` and `setTextMatrix` to maintain the
   effective-size state.
2. `isPdfWatermarkText(str, filter)` does whitespace-insensitive,
   case-insensitive substring matching so a filter entry of
   `"www.chinafix.com"` catches `"w w w . c h i n a f i x . c o m"` as a
   literal text item on the page (from `page.getTextContent()`).
3. The computed skip set is cached per `(file, pageIndex, filterSig)` on the
   document itself (`watermarkSkipSets` array). Changing the filter clears all
   skip sets and re-triggers background prewarm.
4. All three render paths (`renderPage`, `renderTiledPage`, `renderPageToBitmap`)
   pass the skip set to pdf.js via the public `operationsFilter` parameter on
   `page.render()`. pdf.js's `CanvasGraphics.executeOperatorList` checks the
   filter before dispatching each operator — watermark glyph draws are
   **entirely bypassed**, while path/image operators run normally. Schematic
   content underneath the watermark is preserved pixel-for-pixel.

### Background prewarm

After text extraction completes, `_prewarmWatermarkSkipSets` computes skip
sets for every page in the background, one page per `requestIdleCallback`.
Falls back to `setTimeout(0)` on Safari. Running one page per idle tick
ensures the prewarm yields to user-interactive renders on the shared pdf.js
Worker queue — if the user opens a PDF and immediately starts zooming, their
renders slip in between prewarm pages.

## Canvas safety rules

These are invariants, not suggestions — violating any of them produces
visible corruption:

- **Offscreen pooled canvases** use `getContext('2d', { alpha: false })`.
  This is safe because we fully overwrite them on acquire.
- **Persistent canvases** (main visible, adjacent page canvases, tile
  canvases, highlight, glyph overlay) must NOT use `alpha: false`. Setting
  `canvas.width = N` is supposed to reset all attributes including alpha, but
  browsers are inconsistent, and a persistent canvas reused with stale alpha
  produces mirrored/flipped content. Only pooled "used once and released"
  canvases are safe to opt out of alpha.
- **Never pool pdf.js-rendered canvases.** After `page.render()` completes,
  the pdf.js Worker thread may still queue stale draw operations that reach
  the canvas microseconds later. If we return the canvas to the pool and
  another caller acquires it, those late draws land on the wrong content.
  Instead: abandon to GC by setting `width = 1; height = 1` after
  `createImageBitmap()` has captured the pixels we care about.
- **Canvas pool shrinks synchronously on release.** Never defer the `width =
  1; height = 1` step — if the pool hands out the canvas to a new caller
  before the shrink fires, the new caller starts with stale backing store.

## Stale render guards

`renderIdRef` (full-page path) and `tileRenderIdRef` (tiled path) are
monotonic counters incremented at the start of each render. Every async step
checks that the counter hasn't advanced, and bails out if it has. Without
this, a slow page mid-render followed by a user zoom would race the old
render's output against the new one and produce corruption.

## Page boundary crossing during pan

When the user scrolls vertically past a page boundary, `skipResetRef.current
= true` tells the page-change effect not to reset zoom/pan to defaults, so
the visual position stays continuous. The tile cache isn't cleared — the old
page's tiles slide out of view naturally as the new page's tiles render in.

## Click-to-lookup

Clicking on PDF text runs `hitTestWord` which:

1. Converts screen coordinates to wrapper-local coordinates via the current
   pan/zoom refs
2. Walks `textItemsForPage`, computes each item's oriented bounding box via
   `textItemRect(transform, width, vpT, scale)`, and finds the smallest-font
   item under the click point (watermark items are skipped since they always
   have the largest font)
3. Extracts the word under the click via character-width interpolation
4. If the word matches a board part or net name, triggers `focusPart` /
   `focusNet` on the board
5. Draws an orange highlight overlay and a "Double-click to search" tooltip
   above the click target for ~4 seconds

Double-click bypasses the part/net check and always stuffs the word into the
search input, overwriting any existing query.

## Performance envelope

Rough numbers on a modern laptop with integrated GPU, "high" quality preset:

| Scenario | Typical time |
|---|---|
| Initial page render at zoom 1× (cold) | 30–80 ms |
| Cache hit | < 5 ms |
| 12 tiles at zoom 5× (cold) | 36–120 ms total |
| Tile cache hit on pan | < 1 ms per tile |
| Text extraction, 100 pages | 2–5 s |
| Text extraction from IndexedDB cache | < 200 ms |
| Watermark skip set, per page | 5–20 ms (in pdf.js Worker) |

Memory budget at "high": ~120 MP page cache + ~80 MP tile cache, ~2 MB text
per document. `applyDeviceMemoryScaling` halves the pixel budgets on devices
reporting ≤ 2 GB RAM.

## Things that are deliberately not fixed

- **Hysteresis state is module-global.** `_lastCommittedTier` is shared across
  panels. In practice, user interaction is serialized per panel so the
  conflict window is microseconds — not worth the refactor cost.
- **`applyDeviceMemoryScaling` is one-shot at quality-config read.** No
  runtime response to memory pressure. `navigator.deviceMemory` is coarse
  anyway.
- **DPR is read fresh on every render.** No `matchMedia` listener. Moving a
  window between different-DPR monitors and never interacting will show soft
  pixels until any interaction triggers a re-render.

## Debugging tips

- Scoped loggers: `log.pdf`, `log.perf`, `log.cache` in the Debug Panel.
- Blur complaints: grep the Debug Panel for `clampCanvasScale` — if the user's
  page hit the clamp, there's a one-shot warning with the requested vs.
  clamped ratio.
- "Wrong page flashes during scroll" → check `tileRenderId` guards and the
  adjacent-page effect cleanup. The batch-display rAF in `renderTiledPage`
  removes transition-backdrop canvases once new tiles are up.
- "Mirroring / flipped tiles" → something is pooling a pdf.js-rendered
  canvas. Check canvas pool acquires and make sure we abandon (width/height
  = 1) after `createImageBitmap`, never `releaseCanvas`.
- Watermark filter not working → check `pdfStore.getWatermarkSkipSet` returned
  a non-empty set. If empty, either the filter is empty or no text items on
  the page match (check text extraction succeeded and the page actually has a
  text layer, not just a raster image).
