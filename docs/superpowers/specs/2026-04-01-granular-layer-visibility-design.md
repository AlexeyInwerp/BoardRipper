# Granular Sub-Layer Visibility

**Date:** 2026-04-01
**Goal:** Allow viewing raw traces without component clutter. Vias off by default. Independent toggles for pins, part outlines, component names, and fills.

---

## Current State

- `showTraces`, `showVias`, `showComponents` exist in board-store (per-tab)
- `showComponents` is a dead toggle — stored and rendered in sidebar UI but **never applied** in BoardRenderer
- `showPartLabels` exists in render-settings (global), applied via LoD in BoardRenderer
- All component-related rendering (fills, pins, borders, labels) is added directly to `topLayer`/`bottomLayer` with no sub-grouping

## Design

### 1. New Sub-Containers in `buildBoardScene()`

Wrap component rendering phases into named sub-containers within `topLayer`/`bottomLayer`:

| Sub-container | Contents | Default |
|---|---|---|
| `fillLayer` (top/bottom) | Component-type color fills from `topFillMap`/`bottomFillMap` | ON (follows `showComponentColors`) |
| `pinLayer` (top/bottom) | Grid cells with filled pins + pin-1 triangles + NC pin outlines | ON |
| `outlineLayer` (top/bottom) | `borderBatch` Graphics (green/red part borders) | ON |
| `labelLayer` (top/bottom) | Part containers (BitmapText names) + circle label layers + 2-pin net label layers | ON |
| `viaLayer` | Already separate at root level | **OFF** |

Parent `topLayer`/`bottomLayer` remain — `showTop`/`showBottom` still act as master side switches.

### 2. New Toggles in Board Store

Add to `TabState` interface:

```typescript
showPins: boolean;      // default: true
showOutlines: boolean;  // default: true
showLabels: boolean;    // default: true
```

Change existing:
- `showVias` default: `true` → `false`

Add toggle methods:
- `togglePins()`
- `toggleOutlines()`
- `toggleLabels()`

### 3. Wire Visibility in BoardRenderer

In `applyLayerVisibility()`, after existing trace/via logic:

```typescript
// Component sub-layer visibility (master: showComponents)
const showComp = tab.showComponents;
for (const scene of [this.activeScene]) {
  if (!scene) continue;
  scene.topFillLayer.visible    = showComp && showComponentColors;
  scene.bottomFillLayer.visible = showComp && showComponentColors;
  scene.topPinLayer.visible     = showComp && tab.showPins;
  scene.bottomPinLayer.visible  = showComp && tab.showPins;
  scene.topOutlineLayer.visible = showComp && tab.showOutlines;
  scene.bottomOutlineLayer.visible = showComp && tab.showOutlines;
  scene.topLabelLayer.visible   = showComp && tab.showLabels;
  scene.bottomLabelLayer.visible = showComp && tab.showLabels;
}
```

### 4. `showComponents` as Master Toggle

- `showComponents = false` → hide all sub-containers (pins, outlines, labels, fills)
- `showComponents = true` → respect individual sub-toggles

### 5. Sidebar UI Update

In the Layers tab, expand the existing Components button into a group with sub-toggles. **Uncollapsed by default**, collapsible state persisted.

```
◉ Traces
○ Vias                    ← off by default
▾ ◉ Components            ← master toggle, group uncollapsed by default
    ◉ Pins
    ◉ Outlines
    ◉ Labels
    ◉ Fills
```

Clicking the master "Components" toggle:
- OFF: hides all sub-layers, dims sub-toggles
- ON: restores sub-toggle states

Collapse/expand state stored in a local UI state (not per-tab — it's a UI preference).

### 6. BoardSceneGraph Interface Update

Add to `BoardScene` / `BoardSceneGraph`:

```typescript
topFillLayer: Container;
bottomFillLayer: Container;
topPinLayer: Container;
bottomPinLayer: Container;
topOutlineLayer: Container;
bottomOutlineLayer: Container;
topLabelLayer: Container;
bottomLabelLayer: Container;
```

These are returned from `buildBoardScene()` alongside existing fields.

### 7. SettingsMockup Compatibility

`buildBoardScene()` is a shared pure function used by both `BoardRenderer` and `SettingsMockup`. The sub-containers are structural — they don't change rendering output, just grouping. `SettingsMockup` doesn't need visibility toggling, so no changes needed there.

## Files Changed

| File | Change |
|---|---|
| `renderer/board-scene.ts` | Wrap fills/pins/borders/labels in sub-containers, return them |
| `renderer/BoardRenderer.ts` | Apply sub-layer visibility in `applyLayerVisibility()` |
| `store/board-store.ts` | Add `showPins`, `showOutlines`, `showLabels` to TabState; flip `showVias` default; add toggle methods |
| `components/BoardSidebar.tsx` | Expand Components toggle into collapsible group with sub-toggles |
| `hooks/useBoardStore.ts` | Expose new fields in the hook |

## Not Changed

- `store/render-settings.ts` — `showPartLabels` stays as-is (global LoD setting, orthogonal to per-tab visibility)
- `showComponentColors` in render-settings — still controls whether fills are *drawn* at all; `showFills` sub-toggle controls whether the fill container is *visible*
- Trace/via rendering — untouched
- Selection highlighting — operates on `selectionGfx` which is separate from these sub-containers
