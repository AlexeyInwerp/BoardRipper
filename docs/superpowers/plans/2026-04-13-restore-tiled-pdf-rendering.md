# Restore Tiled PDF Viewport Rendering

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the tiled viewport rendering system that was working well (commit `53c4a0d`) but was wiped during a git history cleanup. Fix the one bug that caused it to be abandoned: the composite canvas was sized to the full page at render scale, causing 10GB memory usage.

**Architecture:** At zoom > 1, the page is divided into a grid of 1024×1024 pixel tiles. Only tiles intersecting the visible viewport are rendered by pdf.js. Cached tiles are reused on pan (zero cost). The critical fix: instead of a full-page composite canvas, use **per-tile `<canvas>` DOM elements** positioned absolutely within the existing `pdf-page-wrapper`. The wrapper's `transform: translate(pan) scale(zoom)` handles positioning automatically — no CSS model conflict.

**Tech Stack:** pdf.js (existing), TypeScript, React refs for tile DOM management

---

## Background: Why It Was Removed

The original tile system (commit `53c4a0d`) worked well but had one fatal flaw:

```
canvas.width = grid.pagePixelW;   // = pageW × baseScale × tier
canvas.height = grid.pagePixelH;  // at zoom 10×: 7956 × 10296 = 82M pixels = 328MB
```

Tiles were rendered individually (small, fast) but composited onto a **single canvas sized to the full page at render scale**. This defeated the entire purpose of tiling. Three attempts to fix this failed:

1. **Viewport-clipped render** — kept full-page canvas, added clip rect. Canvas was still huge.
2. **Viewport-sized canvas** — canvas = container size. Broke CSS transform model (wrapper expects children sized at zoom-1 page dimensions).
3. **Gave up** — reverted to single `renderPage` for all zooms.

**The fix nobody tried:** Per-tile DOM canvases. Each tile is its own `<canvas>` element, TILE_SIZE × TILE_SIZE pixels, positioned absolutely at `left: col*tileCSS_W; top: row*tileCSS_H` inside the wrapper. CSS dimensions = tile size / (renderScale / baseScale). The wrapper transform handles zoom/pan. Memory = O(visible_tiles) ≈ 6-12 canvases × 1024² = 6-12MB. No composite canvas needed.

## What We're Recovering

The `tile-manager.ts` module (223 lines) from commit `53c4a0d` is intact in the reflog and well-designed:
- `computeTileGrid()` — grid dimensions from page size + render scale
- `visibleTiles()` — viewport intersection with center-out sorting
- `tileRenderRequest()` — per-tile source rect in PDF coordinate space
- `viewportToPagePixels()` — CSS pan/zoom → page-pixel space conversion
- LRU tile cache keyed by `file:page:col:row:scale`

We restore this module **as-is** and rewrite only the integration in `PdfViewerPanel.tsx` to use per-tile DOM canvases instead of a composite canvas.

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/frontend/src/pdf/tile-manager.ts` | **Restore** from `53c4a0d` | Tile grid math, LRU tile cache, viewport intersection |
| `src/frontend/src/panels/PdfViewerPanel.tsx` | **Modify** | Add `renderTiledPage()`, tile DOM management, routing |
| `src/frontend/src/index.css` | **Modify** | `.pdf-tile` styling |

## Critical Design Decisions

### 1. Per-Tile DOM Canvases (the fix)

Instead of compositing onto one large canvas:

```
<div ref={wrapperRef} class="pdf-page-wrapper" style="transform: translate(pan) scale(zoom)">
  <canvas ref={canvasRef} />           <!-- main canvas: zoom ≤ 1 only -->
  <canvas ref={highlightRef} />        <!-- search highlights -->
  <!-- tiles appear here at zoom > 1: -->
  <canvas class="pdf-tile" style="position:absolute; left:0; top:0; width:306px; height:306px" />
  <canvas class="pdf-tile" style="position:absolute; left:306px; top:0; width:306px; height:306px" />
  ...
</div>
```

Each tile canvas:
- Pixel size: `TILE_SIZE × TILE_SIZE` (1024×1024, ~4MB each)
- CSS size: `TILE_SIZE / (renderScale / baseScale)` px — fits the wrapper's coordinate system
- Position: `left: col * cssTileW; top: row * cssTileH`
- Created on demand, removed when off-screen or scale changes
- Never pooled (pdf.js safety rule)

### 2. Zoom ≤ 1: Existing Pipeline (unchanged)

The full-page `renderPage()` path remains for zoom ≤ 1. At zoom 1 the page fits the container — tiling adds overhead for no benefit. The `renderActive` router decides:

```typescript
const renderActive = zoomRef.current > 1.05 ? renderTiledPage : renderPage;
```

### 3. Never Downgrade (PDFium principle)

When zooming out, tiles rendered at a higher scale are kept visible (CSS downscales them sharply). New lower-scale tiles are NOT rendered to replace them. Tiles are only invalidated on:
- Page change
- Quality preset change
- Document close

### 4. Tile Canvas Lifecycle

- **Create:** when a tile becomes visible and has no cached bitmap
- **Show cached:** when a tile becomes visible and HAS a cached bitmap — draw bitmap, show canvas
- **Hide:** when a tile leaves the viewport — set `display: none` (keep in DOM for quick re-show)
- **Remove:** when render scale changes or page changes — remove from DOM, abandon to GC
- **Never pool:** pdf.js retains canvas references (established safety rule)

### 5. Highlight Canvas Sizing

At zoom > 1 with tiles, the highlight canvas must match the **visible area only**, not the full page. Size it to `containerW × containerH` with CSS positioning to align with the viewport. Alternatively, keep it full-page-sized but capped by `clampCanvasScale` (current approach) — highlights at zoom > 1 are small relative to the canvas so this is acceptable up to the clamp limit.

Simplest approach: keep highlight canvas as-is. It already works with `clampCanvasScale`. The tile canvases render underneath it. Search highlights are drawn in page-pixel space, same as before.

---

## Tasks

### Task 0: Create Worktree

- [ ] **Step 1: Create isolated worktree for tile work**

```bash
cd /Users/besitzer/Desktop/Boardviewer
git worktree add ../Boardviewer-tiles feat/pdf-tiles-v2 2>/dev/null || git worktree add -b feat/pdf-tiles-v2 ../Boardviewer-tiles HEAD
```

- [ ] **Step 2: Verify worktree**

```bash
cd ../Boardviewer-tiles && git log --oneline -1
```

Expected: current HEAD commit hash

All subsequent tasks run in the worktree.

---

### Task 1: Restore tile-manager.ts

**Files:**
- Create: `src/frontend/src/pdf/tile-manager.ts`

- [ ] **Step 1: Recover tile-manager.ts from reflog**

```bash
cd /Users/besitzer/Desktop/Boardviewer-tiles
git show 53c4a0d:src/frontend/src/pdf/tile-manager.ts > src/frontend/src/pdf/tile-manager.ts
```

- [ ] **Step 2: Verify the file compiles**

```bash
cd src/frontend && npx tsc --noEmit 2>&1 | head -5
```

Expected: clean (tile-manager.ts has no imports other than log-store)

- [ ] **Step 3: Add one enhancement — `getBestTileCached`**

Add this function after `getTileCached` in `tile-manager.ts`. It finds the highest-scale cached tile for a given position — implements the "never downgrade" principle:

```typescript
/** Find the best (highest-scale) cached tile for a given grid position.
 *  Returns undefined if no tile is cached at any scale for this position. */
export function getBestTileCached(
  file: string, page: number, col: number, row: number,
): CachedTile | undefined {
  let best: CachedTile | undefined;
  for (const [, entry] of _tileCache) {
    if (entry.col === col && entry.row === row) {
      // Check if this entry belongs to the right file:page
      // (cache key starts with file:page:)
      if (!best || entry.scale > best.scale) best = entry;
    }
  }
  if (best) {
    // LRU touch
    const key = tileCacheKey(file, page, best.col, best.row, best.scale);
    if (_tileCache.has(key)) {
      _tileCache.delete(key);
      _tileCache.set(key, best);
    }
  }
  return best;
}
```

Note: This is a linear scan of the cache. With typical cache sizes (50-200 entries), this is <0.1ms. If profiling shows it's hot, add a secondary index later.

- [ ] **Step 4: Commit**

```bash
git add src/frontend/src/pdf/tile-manager.ts
git commit -m "feat: restore tile-manager from 53c4a0d + add getBestTileCached"
```

---

### Task 2: Add Tile CSS

**Files:**
- Modify: `src/frontend/src/index.css`

- [ ] **Step 1: Add tile canvas styles**

Add after the `.pdf-highlight-canvas` block:

```css
.pdf-tile {
  position: absolute;
  pointer-events: none;
  image-rendering: auto;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/frontend/src/index.css
git commit -m "style: add .pdf-tile CSS for per-tile DOM canvases"
```

---

### Task 3: Add Tile DOM Management to PdfViewerPanel

**Files:**
- Modify: `src/frontend/src/panels/PdfViewerPanel.tsx`

This task adds the infrastructure for managing tile `<canvas>` elements in the DOM without rendering anything yet.

- [ ] **Step 1: Add imports**

At the top of `PdfViewerPanel.tsx`, add after the existing imports:

```typescript
import {
  TILE_SIZE, computeTileGrid, visibleTiles, tileRenderRequest,
  viewportToPagePixels, getTileCached, putTileCached, invalidateTileCache,
  setTileCacheLimit, getBestTileCached,
} from '../pdf/tile-manager';
import type { TileGridInfo } from '../pdf/tile-manager';
```

- [ ] **Step 2: Add tile refs**

After `const clickHighlightKeyRef = useRef(0);` (around line 520), add:

```typescript
// Tile DOM management
const tileGridRef = useRef<TileGridInfo | null>(null);
const tileRenderIdRef = useRef(0);
const tileContainerRef = useRef<Map<string, HTMLCanvasElement>>(new Map());
```

- [ ] **Step 3: Wire tile cache limit to quality preset**

In the `useEffect` that calls `setPageCacheLimits` (around line 583), add:

```typescript
setTileCacheLimit(qcfg.cacheMaxPixels);
```

In the quality change handler (around line 597), add after `invalidatePageCache`:

```typescript
setTileCacheLimit(cfg.cacheMaxPixels);
invalidateTileCache(pdfFileName);
```

- [ ] **Step 4: Add tile cleanup helper**

Add before `renderTiledPage` (will be added in next task):

```typescript
/** Remove all tile canvases from the DOM and clear the tile map */
const clearTileDom = useCallback(() => {
  for (const canvas of tileContainerRef.current.values()) {
    canvas.remove();
  }
  tileContainerRef.current.clear();
}, []);
```

- [ ] **Step 5: Commit**

```bash
git add src/frontend/src/panels/PdfViewerPanel.tsx
git commit -m "feat: tile DOM infrastructure — imports, refs, cleanup helper"
```

---

### Task 4: Implement renderTiledPage

**Files:**
- Modify: `src/frontend/src/panels/PdfViewerPanel.tsx`

This is the core function. Add it after the `renderPage` function (after the adjacent page effect, around line 1070).

- [ ] **Step 1: Add renderTiledPage function**

```typescript
// --- Tiled viewport rendering (zoom > 1) ---
// Renders only the visible portion of the page as per-tile DOM canvases.
// Memory = O(visible_tiles) ≈ 6-12MB. Render cost = O(viewport).
const renderTiledPage = useCallback(async () => {
  if (!isLoaded) return;
  renderTaskRef.current?.cancel();

  const tileRenderId = ++tileRenderIdRef.current;
  const zoom = zoomRef.current;
  const maxTier = qcfgRef.current.maxMainTier;
  const resTier = hysteresisFilter(quantiseTier(mainTierFromZoom(zoom, maxTier)));
  renderTierRef.current = resTier;

  const container = containerRef.current;
  const wrapper = wrapperRef.current;
  if (!container || !wrapper) return;
  const containerWidth = container.clientWidth;
  const containerH = container.clientHeight;
  if (containerWidth === 0) return;

  try {
    const page = await pdfStore.getPageFor(pdfFileName, currentPage);
    if (tileRenderIdRef.current !== tileRenderId) return;

    const unscaledVp = page.getViewport({ scale: 1 });
    const baseScale = containerWidth / unscaledVp.width;
    const dpr = window.devicePixelRatio || 1;
    let renderScale = baseScale * resTier * dpr;
    renderScale = clampCanvasScale(unscaledVp.width, unscaledVp.height, renderScale, qcfgRef.current.maxCanvasDim);

    const cssW = containerWidth;
    const cssH = unscaledVp.height * baseScale;
    scaleRef.current = baseScale;
    hiresScaleRef.current = renderScale;
    viewportHeightRef.current = unscaledVp.height;
    viewportTransformRef.current = unscaledVp.transform;
    pageCssHRef.current = cssH;

    const grid = computeTileGrid(unscaledVp.width, unscaledVp.height, renderScale);
    const prevGrid = tileGridRef.current;
    tileGridRef.current = grid;

    // If render scale changed, remove old tile canvases (they're at wrong resolution)
    if (!prevGrid || prevGrid.renderScale !== grid.renderScale) {
      clearTileDom();
    }

    // Hide the main canvas when tiling is active
    const mainCanvas = canvasRef.current;
    if (mainCanvas) mainCanvas.style.display = 'none';

    // Compute which tiles are visible (with 1-tile padding for smooth pan)
    const vp = viewportToPagePixels(
      panRef.current.x, panRef.current.y, zoom,
      containerWidth, containerH, baseScale, renderScale,
    );
    const PAD = TILE_SIZE;
    const tiles = visibleTiles(
      vp.x - PAD, vp.y - PAD, vp.w + PAD * 2, vp.h + PAD * 2, grid,
    );

    // CSS size of one tile in wrapper coordinates
    const cssTileW = TILE_SIZE / (renderScale / baseScale);
    const cssTileH = TILE_SIZE / (renderScale / baseScale);

    // Mark all existing tiles as candidates for hiding
    const visibleKeys = new Set<string>();

    // Phase 1: show cached tiles immediately, collect tiles that need rendering
    const toRender: { col: number; row: number }[] = [];
    for (const t of tiles) {
      const key = `${t.col}:${t.row}`;
      visibleKeys.add(key);

      let tileCanvas = tileContainerRef.current.get(key);
      const cached = getTileCached(pdfFileName, currentPage, t.col, t.row, renderScale);

      if (cached) {
        // Tile is cached — show it
        if (!tileCanvas) {
          tileCanvas = document.createElement('canvas');
          tileCanvas.className = 'pdf-tile';
          tileCanvas.width = cached.bitmap.width;
          tileCanvas.height = cached.bitmap.height;
          tileCanvas.style.width = `${cssTileW}px`;
          tileCanvas.style.height = `${cssTileH}px`;
          tileCanvas.style.left = `${t.col * cssTileW}px`;
          tileCanvas.style.top = `${t.row * cssTileH}px`;
          wrapper.appendChild(tileCanvas);
          tileContainerRef.current.set(key, tileCanvas);
        }
        const ctx = tileCanvas.getContext('2d');
        if (ctx) ctx.drawImage(cached.bitmap, 0, 0);
        tileCanvas.style.display = '';
      } else {
        // Check for a higher-scale cached tile (never-downgrade principle)
        const best = getBestTileCached(pdfFileName, currentPage, t.col, t.row);
        if (best && tileCanvas) {
          // Keep showing the old tile (CSS downscale) — don't blank it
          tileCanvas.style.display = '';
        }
        toRender.push(t);
      }
    }

    // Hide tiles that are no longer visible
    for (const [key, canvas] of tileContainerRef.current) {
      if (!visibleKeys.has(key)) {
        canvas.style.display = 'none';
      }
    }

    // Phase 2: render missing tiles (center-out priority, already sorted)
    const t0 = performance.now();
    for (const t of toRender) {
      if (tileRenderIdRef.current !== tileRenderId) return;

      const req = tileRenderRequest(t.col, t.row, grid);
      const offscreen = acquireCanvas(req.pixelW, req.pixelH);
      const offCtx = offscreen.getContext('2d', { alpha: false });
      if (!offCtx) { releaseCanvas(offscreen); continue; }

      // Render with offset viewport — pdf.js draws only this tile's region
      const tileViewport = page.getViewport({
        scale: renderScale,
        offsetX: -req.srcX * renderScale,
        offsetY: -req.srcY * renderScale,
      });
      const task = page.render({
        canvas: offscreen, canvasContext: offCtx,
        viewport: tileViewport, intent: 'display',
      });
      renderTaskRef.current = { cancel: () => task.cancel() };

      try {
        await task.promise;
      } catch {
        offscreen.width = 1; offscreen.height = 1;
        continue;
      }

      if (tileRenderIdRef.current !== tileRenderId) {
        offscreen.width = 1; offscreen.height = 1;
        return;
      }

      // Apply clean mode contrast if needed
      let srcCanvas = offscreen;
      if (cleanMode) {
        const tmp = acquireCanvas(req.pixelW, req.pixelH);
        const tmpCtx = tmp.getContext('2d', { alpha: false });
        if (tmpCtx) {
          tmpCtx.filter = `contrast(${cleanContrastRef.current})`;
          tmpCtx.drawImage(offscreen, 0, 0);
          offscreen.width = 1; offscreen.height = 1;
          srcCanvas = tmp;
        }
      }

      // Create bitmap, cache it, blit to tile canvas
      try {
        const bitmap = await createImageBitmap(srcCanvas);
        srcCanvas.width = 1; srcCanvas.height = 1; // abandon to GC

        putTileCached(pdfFileName, currentPage, {
          bitmap, col: t.col, row: t.row, scale: renderScale,
        });

        if (tileRenderIdRef.current === tileRenderId) {
          const key = `${t.col}:${t.row}`;
          let tileCanvas = tileContainerRef.current.get(key);
          if (!tileCanvas) {
            tileCanvas = document.createElement('canvas');
            tileCanvas.className = 'pdf-tile';
            tileCanvas.width = req.pixelW;
            tileCanvas.height = req.pixelH;
            tileCanvas.style.width = `${cssTileW}px`;
            tileCanvas.style.height = `${cssTileH}px`;
            tileCanvas.style.left = `${t.col * cssTileW}px`;
            tileCanvas.style.top = `${t.row * cssTileH}px`;
            wrapper.appendChild(tileCanvas);
            tileContainerRef.current.set(key, tileCanvas);
          }
          const ctx = tileCanvas.getContext('2d');
          if (ctx) ctx.drawImage(bitmap, 0, 0);
          tileCanvas.style.display = '';
        }
      } catch {
        srcCanvas.width = 1; srcCanvas.height = 1;
      }
    }

    drawHighlightsRef.current();
    setRenderEpoch(e => e + 1);

    const totalMs = performance.now() - t0;
    if (toRender.length > 0) {
      log.perf.log(`tiled-render page=${currentPage} tiles=${toRender.length}/${tiles.length} ${Math.round(totalMs)}ms scale=${renderScale.toFixed(1)}`);
      const prev = renderTimeEmaRef.current;
      renderTimeEmaRef.current = prev > 0 ? prev * 0.7 + totalMs * 0.3 : totalMs;
    }
  } catch (err) {
    if (err instanceof Error && err.message?.includes('cancel')) return;
    log.pdf.error('renderTiledPage failed:', err);
    setError(String(err));
  }
}, [pdfFileName, isLoaded, currentPage, cleanMode, clearTileDom]);
```

- [ ] **Step 2: Verify it compiles**

```bash
cd src/frontend && npx tsc --noEmit 2>&1 | head -10
```

Expected: clean (renderTiledPage is defined but not yet wired)

- [ ] **Step 3: Commit**

```bash
git add src/frontend/src/panels/PdfViewerPanel.tsx
git commit -m "feat: renderTiledPage — per-tile DOM canvases, no composite canvas"
```

---

### Task 5: Wire Routing + Tile Cleanup

**Files:**
- Modify: `src/frontend/src/panels/PdfViewerPanel.tsx`

- [ ] **Step 1: Add renderActive router**

After `renderTiledPage`, add:

```typescript
/** Route to tiled or full-page render based on zoom level */
const renderActive = useCallback(() => {
  if (zoomRef.current > 1.05) {
    // Switch to tiled mode — hide main canvas, show tiles
    renderTiledPage();
  } else {
    // Switch to full-page mode — show main canvas, remove tiles
    clearTileDom();
    const mainCanvas = canvasRef.current;
    if (mainCanvas) mainCanvas.style.display = '';
    renderPage();
  }
}, [renderPage, renderTiledPage, clearTileDom]);
```

- [ ] **Step 2: Wire renderPageRef to renderActive**

Find the line `renderPageRef.current = renderPage;` and change to:

```typescript
renderPageRef.current = renderActive;
```

Find `useEffect(() => { renderPage(); }, [renderPage]);` and change to:

```typescript
useEffect(() => { renderActive(); }, [renderActive]);
```

- [ ] **Step 3: Clear tiles on page change**

In the `useEffect` that fires on `currentPage` change (the one that resets zoom/pan, around line 755-761), add `clearTileDom()` at the start:

```typescript
useEffect(() => {
  clearTileDom(); // remove tiles from previous page
  // ... existing page-change logic
```

Add `clearTileDom` to the dependency array of this effect.

- [ ] **Step 4: Clear tiles on unmount**

In the cleanup return of the component (or add a new effect):

```typescript
useEffect(() => {
  return () => {
    clearTileDom();
    invalidateTileCache(pdfFileName);
  };
}, [pdfFileName, clearTileDom]);
```

- [ ] **Step 5: Verify it compiles and test manually**

```bash
cd src/frontend && npx tsc --noEmit 2>&1 | head -10
```

Then test: open a PDF, zoom in past 100%. Tiles should appear. Zoom out to ≤ 100% — main canvas should reappear. Pan while zoomed — cached tiles show instantly, new tiles render progressively.

- [ ] **Step 6: Commit**

```bash
git add src/frontend/src/panels/PdfViewerPanel.tsx
git commit -m "feat: wire tile routing — zoom > 1 uses tiles, zoom ≤ 1 uses full-page"
```

---

### Task 6: Fix scheduleTierRender for Tiles

**Files:**
- Modify: `src/frontend/src/panels/PdfViewerPanel.tsx`

The current `scheduleTierRender` has the "never re-render on zoom out" optimization. With tiles, we WANT to re-render on zoom changes (tiles at new positions become visible). But we still don't want to replace high-res tiles with lower ones.

- [ ] **Step 1: Update scheduleTierRender**

Replace the adaptive throttle block (lines ~718-730) with:

```typescript
// During tiled mode: always re-render on zoom (tiles need updating for new viewport).
// During full-page mode: only re-render if zooming in (CSS downscale is sharp enough).
const candidateTier = quantiseTier(mainTierFromZoom(zoomRef.current, qcfgRef.current.maxMainTier));
const isTiled = zoomRef.current > 1.05;
if (isTiled || candidateTier > renderTierRef.current) {
  const ema = renderTimeEmaRef.current;
  const throttleMs = ema > 0 ? Math.max(ema * 1.5, 16) : 0;
  const now = performance.now();
  if (now - lastThrottleRenderRef.current >= throttleMs) {
    lastThrottleRenderRef.current = now;
    renderPageRef.current();
  }
}
```

- [ ] **Step 2: Verify and commit**

```bash
cd src/frontend && npx tsc --noEmit 2>&1 | head -5
git add src/frontend/src/panels/PdfViewerPanel.tsx
git commit -m "fix: scheduleTierRender — allow re-render in tiled mode for viewport updates"
```

---

### Task 7: Handle Highlight Canvas in Tiled Mode

**Files:**
- Modify: `src/frontend/src/panels/PdfViewerPanel.tsx`

The highlight canvas overlays the main canvas. In tiled mode, the main canvas is hidden. The highlight canvas must remain visible and sized correctly.

- [ ] **Step 1: Keep highlight canvas visible in tiled mode**

In `renderTiledPage`, after setting `hiresScaleRef.current = renderScale`, ensure the highlight canvas is sized and visible:

```typescript
// Size highlight canvas to match page at render scale (clamped)
const highlight = highlightRef.current;
if (highlight) {
  // Use clampCanvasScale to keep highlight canvas within GPU limits
  // (it doesn't need to be tile-resolution, just high enough for visible highlights)
  const hlScale = clampCanvasScale(unscaledVp.width, unscaledVp.height, renderScale, qcfgRef.current.maxCanvasDim);
  highlight.width = Math.ceil(unscaledVp.width * hlScale);
  highlight.height = Math.ceil(unscaledVp.height * hlScale);
  highlight.style.width = `${cssW}px`;
  highlight.style.height = `${cssH}px`;
  highlight.style.display = '';
}
```

- [ ] **Step 2: Ensure highlight z-index is above tiles**

The highlight canvas is already in the DOM before tile canvases are appended. Since tiles are appended dynamically, they'll be AFTER the highlight in DOM order and render ON TOP of it. Fix by ensuring highlight canvas has a z-index.

In `src/frontend/src/index.css`, update `.pdf-highlight-canvas`:

```css
.pdf-highlight-canvas {
  position: absolute;
  top: 0;
  left: 0;
  pointer-events: none;
  z-index: 2;
}
```

And `.pdf-tile`:

```css
.pdf-tile {
  position: absolute;
  pointer-events: none;
  image-rendering: auto;
  z-index: 1;
}
```

- [ ] **Step 3: Commit**

```bash
git add src/frontend/src/panels/PdfViewerPanel.tsx src/frontend/src/index.css
git commit -m "fix: highlight canvas z-order and sizing in tiled mode"
```

---

### Task 8: Handle Click-to-Lookup and Follow-Target in Tiled Mode

**Files:**
- Modify: `src/frontend/src/panels/PdfViewerPanel.tsx`

The `hitTestWord` function uses `scaleRef.current` (baseScale) for CSS-coordinate hit testing. This is independent of tile vs full-page rendering — it works in wrapper CSS coordinates which are the same regardless. No changes needed for hit testing.

The click highlight overlay (`pdf-click-highlight` div) is positioned in wrapper coordinates and already has a z-index. No changes needed.

- [ ] **Step 1: Verify click-to-lookup works in tiled mode**

Manual test: zoom to 200%+, click on text in PDF. Orange highlight + tooltip should appear. Double-click should populate search.

- [ ] **Step 2: Verify follow-target works**

Manual test: with board loaded, click a component. PDF should navigate, zoom, and show highlight on the matching text.

- [ ] **Step 3: Commit (no-op if no changes needed)**

If any fixes were needed, commit them. Otherwise, skip.

---

### Task 9: Prevent Memory Leak — Tile DOM Limit

**Files:**
- Modify: `src/frontend/src/panels/PdfViewerPanel.tsx`

The original memory leak was from an unbounded composite canvas. With per-tile DOM canvases, a different leak is possible: accumulated hidden tiles that are never removed. Add a hard limit.

- [ ] **Step 1: Add tile DOM eviction in renderTiledPage**

After the "hide tiles that are no longer visible" loop, add eviction of excess hidden tiles:

```typescript
// Evict hidden tile canvases if we have too many in the DOM
const MAX_TILE_DOM = 50; // max tile canvases in DOM (visible + hidden)
if (tileContainerRef.current.size > MAX_TILE_DOM) {
  const toEvict: string[] = [];
  for (const [key, canvas] of tileContainerRef.current) {
    if (canvas.style.display === 'none') {
      toEvict.push(key);
    }
  }
  // Remove oldest hidden tiles first (Map preserves insertion order)
  for (const key of toEvict) {
    if (tileContainerRef.current.size <= MAX_TILE_DOM) break;
    const canvas = tileContainerRef.current.get(key)!;
    canvas.remove();
    tileContainerRef.current.delete(key);
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/frontend/src/panels/PdfViewerPanel.tsx
git commit -m "fix: limit tile DOM to 50 canvases — evict hidden tiles to prevent leak"
```

---

### Task 10: Fix "Best Available" Cache for Full-Page Mode (Bonus)

**Files:**
- Modify: `src/frontend/src/panels/PdfViewerPanel.tsx`

Even at zoom ≤ 1, the blur-on-unzoom bug exists in the full-page path. Fix it with the "best available" cache lookup principle.

- [ ] **Step 1: Add getBestPageCache helper**

After `getPageCache`, add:

```typescript
/** Find the best (highest-tier) cached render for a page, regardless of tier.
 *  Returns the entry if found, undefined otherwise. */
function getBestPageCache(file: string, page: number, clean: boolean): CachedRender | undefined {
  let best: { key: string; entry: CachedRender; tier: number } | undefined;
  for (const [key, entry] of _pageCache) {
    // Keys are "file:page:tier:clean"
    if (key.startsWith(`${file}:${page}:`) && key.endsWith(`:${clean ? 1 : 0}`)) {
      const tier = parseFloat(key.split(':')[2]);
      if (!best || tier > best.tier) {
        best = { key, entry, tier };
      }
    }
  }
  if (best) {
    // LRU touch
    _pageCache.delete(best.key);
    _pageCache.set(best.key, best.entry);
  }
  return best?.entry;
}
```

- [ ] **Step 2: Use in renderPage fallback**

In `renderPage`, after the exact cache lookup miss, before the preview fallback, add:

```typescript
// Check for any higher-tier cached render (never show blur if sharp version exists)
const bestCached = getBestPageCache(pdfFileName, currentPage, cleanMode);
if (bestCached && bestCached.cssW === cssW) {
  blitToCanvas(bestCached);
  // Still render at the correct tier for proper cache management, but
  // the user sees the sharp version immediately (no blur flash)
}
```

- [ ] **Step 3: Commit**

```bash
git add src/frontend/src/panels/PdfViewerPanel.tsx
git commit -m "fix: best-available cache lookup — never show blur when sharp version is cached"
```

---

### Task 11: Manual Testing Checklist

- [ ] **Step 1: Start dev server**

```bash
cd /Users/besitzer/Desktop/Boardviewer-tiles/src/frontend && npm run dev
```

- [ ] **Step 2: Run through test scenarios**

| Test | Expected |
|------|----------|
| Open PDF, zoom stays ≤ 100% | Full-page render (existing behavior, no tiles) |
| Zoom in past 105% | Tiles appear, main canvas hides. Text gets crisp. |
| Pan while zoomed in | Cached tiles show instantly at edges. New tiles render progressively. |
| Zoom in to 500%, pan around | Only ~6-12 tiles in DOM. Memory stays under 50MB. |
| Zoom out from 500% → 100% | Smooth transition back to full-page canvas. No blur flash. |
| Zoom out from 500% → 200% | Existing tiles stay visible (CSS downscale). No blur. |
| Change page while zoomed | Old tiles removed, new page renders at zoom 1. |
| Search for text while zoomed | Yellow highlights appear above tiles. |
| Click text while zoomed | Orange highlight + tooltip appears. |
| Follow from board viewer | Navigates + zooms + highlights in tiled mode. |
| Change quality preset while zoomed | Old tiles removed, re-rendered at new quality. |
| Open DevTools → Memory tab | No unbounded growth during zoom/pan cycles. |

- [ ] **Step 3: Run Playwright smoke tests**

```bash
cd /Users/besitzer/Desktop/Boardviewer-tiles && npx playwright test --project=chromium
```

Expected: all existing tests pass (they run at zoom 1, so tiling doesn't activate).

- [ ] **Step 4: Final commit if any fixes**

```bash
git add -A && git commit -m "fix: manual test fixes for tiled rendering"
```

---

### Task 12: Merge to Main

- [ ] **Step 1: Verify clean state**

```bash
cd /Users/besitzer/Desktop/Boardviewer-tiles
npx tsc -b --noEmit
git status
git log --oneline feat/pdf-tiles-v2 --not main
```

- [ ] **Step 2: Merge**

```bash
cd /Users/besitzer/Desktop/Boardviewer
git merge feat/pdf-tiles-v2
```

- [ ] **Step 3: Remove worktree**

```bash
git worktree remove ../Boardviewer-tiles
git branch -d feat/pdf-tiles-v2
```

- [ ] **Step 4: Final commit message**

The merge commit should summarize:
```
feat: tiled PDF viewport rendering v2 — per-tile DOM canvases

Restores tile system from 53c4a0d with architectural fix:
instead of one full-page composite canvas (caused 10GB leak),
each tile is its own <canvas> element positioned in the wrapper.
Memory = O(visible_tiles) ≈ 6-12MB regardless of zoom level.

- tile-manager.ts: grid math, LRU cache, viewport intersection
- renderTiledPage: per-tile DOM management, center-out rendering
- Never-downgrade: high-res tiles kept on zoom-out (CSS downscale)
- Best-available cache: full-page path also avoids blur-on-unzoom
- Tile DOM capped at 50 canvases to prevent DOM bloat
```
