# Renderer Agent — File Map

**git_hash:** 0fc0f2d
**last_updated:** 2026-04-18

## Staleness Check

```bash
git log --oneline a7bbb79..HEAD -- src/frontend/src/renderer/ src/frontend/src/store/render-settings.ts src/frontend/src/store/layer-store.ts
```

## Domain: Core Renderer (`src/frontend/src/renderer/`)

| File | Lines | Purpose |
|------|-------|---------|
| `BoardRenderer.ts` | 3,675 | Main PixiJS Application + Viewport. Scene lifecycle, multi-tab, selection, butterfly, net lines, LoD, WebGL context recovery, board-flip keeps-view-centered (be40ade, b8faf59), ambient-dim preserves selection+labels (5c91f95, b3465ac), ghost-hide for multi-rev CAD (176cced, 32b9efc), `selectionLabelLayer` RenderLayer lifts selected labels above net lines, pin labels raised unconditionally when a part is selected |
| `board-scene.ts` | 1,371 | **Shared pure function** `buildBoardScene()` — outlines, parts, pins, labels, traces, vias. Spatial grid culling, color batching, BitmapText atlases, OBB skip for near-axis-aligned parts (4df9295), `pinLabelsByPartIndex` on BoardScene (93ab00d) |
| `mockup-data.ts` | 72 | Static fake board (U1+R1+C1) for SettingsMockup preview |

**Total: ~5,050 lines**

## Domain: Settings Store

| File | Lines | Purpose |
|------|-------|---------|
| `render-settings.ts` | 953 | `RenderSettings` interface, `renderSettingsStore` singleton, pin/part geometry helpers, net color rules. Part Type prefixes grouped under categories (696cbe2), MOSFET→Transistor rename (a5a2f8e). Format overrides system removed (0355f93). `labelSizeSmall` default lowered 4 → 3 with auto-migration for stored value 4. |
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

## Recent churn (a7bbb79..a5a2f8e)

- a5a2f8e — refactor(settings): rename Part Type MOSFET → Transistor
- 696cbe2 — feat(settings): Part Types — group prefixes under component categories (#10)
- b8faf59 — fix: board flip with no selection now actually flips
- be40ade — fix: board flip keeps view centered + search nav no longer jiggles
- 93ab00d — fix(ci): pinLabelsByPartIndex on BoardScene + remove unused isBotGfx
- 4df9295 — fix(render): skip diagonal OBB when principal axis is near-axis-aligned
- b3465ac — fix: raised pin labels were hidden behind selection-drawn pin circles
- 5c91f95 — fix: selected part pins + pin labels stay dimmed under ambient dim
- 0355f93 — refactor: remove format overrides system
- 95c6480 — fix: remove broken momentum suppression, consistent inertia UI

