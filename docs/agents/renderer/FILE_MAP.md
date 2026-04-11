# Renderer Agent — File Map

**git_hash:** a7bbb79
**last_updated:** 2026-04-11

## Staleness Check

```bash
git log --oneline a7bbb79..HEAD -- src/frontend/src/renderer/ src/frontend/src/store/render-settings.ts src/frontend/src/store/layer-store.ts
```

## Domain: Core Renderer (`src/frontend/src/renderer/`)

| File | Lines | Purpose |
|------|-------|---------|
| `BoardRenderer.ts` | 3,403 | Main PixiJS Application + Viewport. Scene lifecycle, multi-tab, selection, butterfly, net lines, LoD, WebGL context recovery |
| `board-scene.ts` | 1,358 | **Shared pure function** `buildBoardScene()` — outlines, parts, pins, labels, traces, vias. Spatial grid culling, color batching, BitmapText atlases |
| `mockup-data.ts` | 72 | Static fake board (U1+R1+C1) for SettingsMockup preview |

**Total: 4,833 lines**

## Domain: Settings Store

| File | Lines | Purpose |
|------|-------|---------|
| `render-settings.ts` | 853 | `RenderSettings` interface (50+ fields), `renderSettingsStore` singleton, pin/part geometry helpers, net color rules, per-board overrides |
| `layer-store.ts` | 63 | `LayerState` type, `DEFAULT_LAYER_PALETTE` (15 colors), layer creation helpers |

## Key Exports

### BoardRenderer (class)
- `constructor(container, tabId?)` → `init()` → `fitToBoard()` → `destroy()`
- `pause()` / `resume()` — ticker control for tab switching
- `restartRender()` — scene rebuild after WebGL context loss

### buildBoardScene (pure function)
- `(board: BoardData, s: RenderSettings) => BoardSceneGraph`
- Returns: root Container, layer containers, pin Graphics maps, label groups, border batches, trace/via layers
- **Shared by:** BoardRenderer AND SettingsMockup — changes propagate to both

### BoardSceneGraph (interface)
Key fields: `root`, `topLayer/bottomLayer`, `topPinGfx/bottomPinGfx` (Map<color, Graphics>), `fontSizeGroups`, `borderBatches`, `traceLayer`, `viaLayer`, `twoPinPadPolys`

### RenderSettings (50+ fields)
Grouped: Outline, Parts, Labels, Pins, Selection, Net Lines, Board, Zoom, Debug, Interaction, Net Colors, Part Type Overrides

## Architecture Patterns

1. **Pure rendering:** `buildBoardScene()` has zero side effects
2. **Scene caching:** one BoardScene per tab, swapped on tab switch
3. **On-demand render:** GPU frame only when `needsRender` flag set
4. **Spatial grid culling:** NxN cells (1×1 for <1K pins, 4×4 for <5K, 8×8 for >5K)
5. **Color batching:** per-cell pins grouped by color → O(cells × colors) draw calls
6. **BitmapText atlases:** fonts quantized to 12 discrete sizes → atlas reuse
7. **LoD groups:** labels bucketed by font size, toggled by zoom threshold
8. **NEVER `app.destroy()`** — corrupts PixiJS v8 global batchPool

## Consumers

- `BoardViewerPanel.tsx` — instantiates BoardRenderer
- `SettingsMockup.tsx` — calls buildBoardScene() for live preview
- `SettingsPanel.tsx` — imports renderSettingsStore
