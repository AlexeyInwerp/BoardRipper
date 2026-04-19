# Renderer Agent — Memory

## Critical PixiJS v8 Rules

1. **NEVER call `app.destroy()`** — triggers `GlobalResourceRegistry.clear()` which corrupts module-level `batchPool` in `Batcher.mjs`. Permanently breaks ALL other Application instances. Use `teardownForReinit()`: remove canvas from DOM, let GC reclaim.

2. **Avoid `resizeTo` option** in StrictMode — causes `_cancelResize` crash on early destroy. Use manual width/height + ResizeObserver instead.

3. **WebGL context loss** — detected automatically, ticker paused, viewport state cached. On resume: reinitialize Application, rebuild scene from cache.

## Performance Architecture

- **Spatial grid:** Auto-sized NxN (pin count dependent). Pins batched by color per cell.
- **BitmapText:** Fonts quantized to discrete sizes (2,3,4,6,8,12,16,24,32,48,64). Shared atlas = fewer draw calls.
- **LoD:** Labels grouped by font size. Toggle visibility by bucket, not per-label. O(buckets) not O(labels).
- **Border batches:** One Graphics per (side × color). Redrawn on zoom with minimum screen width enforcement.
- **On-demand rendering:** Ticker only fires GPU frame when `needsRender` is set.

## Historical Bugs

- #8: NC pad outline increased diameter — stroke rendered outward instead of inward
- #6: Zoom not rendered when panel unfocused — ticker stopped on Dockview deactivation
- #2: Selection overlay duplication — redundant label rendering
- Selected pin labels hidden under selection fill in normal (non-dim) mode — pin labels used to live in layer containers (zIndex 0) while selectionGfx draws at zIndex 30 inside scene.root. Fix: raise selected part's pin labels into netLabelLayer (zIndex 35) unconditionally whenever a part is selected, not only under dim modes.
- Net lines drawn over selection labels — netLinesGfx is a viewport-level sibling of scene.root, so it renders above all scene.root content including elevated labels (zIndex 100–103) and netLabelLayer (zIndex 35). Fix: use PixiJS v8 `RenderLayer` (`selectionLabelLayer`) added to viewport after netLinesGfx. The render layer attaches netLabelLayer + the 4 elevated label objects, so they keep scene.root as logical parent (for flip/rotation inheritance) but render after the net lines.

## Shared Boundary with UI Agent

- `SettingsMockup.tsx` is owned by UI but calls `buildBoardScene()` — changes to scene construction must be tested against both the main renderer AND the mockup.
- `render-settings.ts` and `layer-store.ts` are consumed by both renderer and UI agents.
