# Granular Sub-Layer Visibility — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add independent visibility toggles for pins, part outlines, component names, and fills — so users can view raw traces without component clutter. Vias default to off.

**Architecture:** Wrap existing rendering phases in `buildBoardScene()` into named sub-containers within `topLayer`/`bottomLayer`. New per-tab toggles in `board-store` drive `.visible` flags in `BoardRenderer.applyLayerVisibility()`. Sidebar UI expands the existing "Components" button into a collapsible group with sub-toggles.

**Tech Stack:** PixiJS v8 Containers, React, board-store (useSyncExternalStore)

---

## File Structure

| File | Responsibility |
|---|---|
| `src/frontend/src/renderer/board-scene.ts` | Wrap fills/pins/borders/labels in sub-containers, add to `BoardSceneGraph` |
| `src/frontend/src/renderer/BoardRenderer.ts` | Add sub-container fields to `BoardScene`, apply visibility in `applyLayerVisibility()` |
| `src/frontend/src/store/board-store.ts` | Add `showPins`, `showOutlines`, `showLabels` to `BoardTab`; flip `showVias` default; add toggle methods + getters |
| `src/frontend/src/hooks/useBoardStore.ts` | Expose new fields in snapshot |
| `src/frontend/src/components/BoardSidebar.tsx` | Collapsible Components group with sub-toggles |
| `src/frontend/src/index.css` | Styles for collapsible group and sub-toggle indent |

---

### Task 1: Add Sub-Layer Toggle State to Board Store

**Files:**
- Modify: `src/frontend/src/store/board-store.ts:16-41` (BoardTab interface)
- Modify: `src/frontend/src/store/board-store.ts:155-160` (getters)
- Modify: `src/frontend/src/store/board-store.ts:306-331` (default tab creation)
- Modify: `src/frontend/src/store/board-store.ts:599-611` (toggle methods)

- [ ] **Step 1: Add fields to `BoardTab` interface**

In `src/frontend/src/store/board-store.ts`, add three new fields after `showVias` (line 37):

```typescript
  showVias: boolean;
  showPins: boolean;
  showOutlines: boolean;
  showLabels: boolean;
```

- [ ] **Step 2: Change `showVias` default to `false`, add defaults for new fields**

In the tab creation block (~line 327-329), change:

```typescript
      showTraces: true,
      showComponents: true,
      showVias: false,
      showPins: true,
      showOutlines: true,
      showLabels: true,
```

- [ ] **Step 3: Add getter properties**

After the existing `get showVias()` getter (line 160), add:

```typescript
  get showPins(): boolean { return this.activeTab?.showPins ?? true; }
  get showOutlines(): boolean { return this.activeTab?.showOutlines ?? true; }
  get showLabels(): boolean { return this.activeTab?.showLabels ?? true; }
```

- [ ] **Step 4: Add toggle methods**

After `toggleVias()` (line 611), add:

```typescript
  togglePins() {
    const tab = this.activeTab;
    if (!tab) return;
    this.updateActiveTab({ showPins: !tab.showPins });
    this.notify();
  }

  toggleOutlines() {
    const tab = this.activeTab;
    if (!tab) return;
    this.updateActiveTab({ showOutlines: !tab.showOutlines });
    this.notify();
  }

  toggleLabels() {
    const tab = this.activeTab;
    if (!tab) return;
    this.updateActiveTab({ showLabels: !tab.showLabels });
    this.notify();
  }
```

- [ ] **Step 5: Expose in hook**

In `src/frontend/src/hooks/useBoardStore.ts`, add to `StoreSnapshot` interface (after line 30):

```typescript
  showPins: boolean;
  showOutlines: boolean;
  showLabels: boolean;
```

And add to the snapshot factory (after line 60):

```typescript
  showPins: boardStore.showPins,
  showOutlines: boardStore.showOutlines,
  showLabels: boardStore.showLabels,
```

- [ ] **Step 6: Verify TypeScript compiles**

Run: `cd /Users/besitzer/Desktop/Boardviewer/src/frontend && npx tsc --noEmit`
Expected: No errors (or only pre-existing errors unrelated to these changes).

- [ ] **Step 7: Commit**

```bash
git add src/frontend/src/store/board-store.ts src/frontend/src/hooks/useBoardStore.ts
git commit -m "feat: add showPins/showOutlines/showLabels toggles to board store"
```

---

### Task 2: Wrap Scene Graph Phases in Sub-Containers

**Files:**
- Modify: `src/frontend/src/renderer/board-scene.ts:93-136` (BoardSceneGraph interface)
- Modify: `src/frontend/src/renderer/board-scene.ts:313-425` (container setup)
- Modify: `src/frontend/src/renderer/board-scene.ts:993-1114` (flush phases)
- Modify: `src/frontend/src/renderer/board-scene.ts:1292` (return statement)

- [ ] **Step 1: Add sub-container fields to `BoardSceneGraph` interface**

In `src/frontend/src/renderer/board-scene.ts`, add after `bottomLayer` (line 97):

```typescript
  /** Sub-layer containers for granular visibility control */
  topFillLayer: Container;
  bottomFillLayer: Container;
  topPinLayer: Container;
  bottomPinLayer: Container;
  topOutlineLayer: Container;
  bottomOutlineLayer: Container;
  topLabelLayer: Container;
  bottomLabelLayer: Container;
```

- [ ] **Step 2: Create sub-containers in `buildBoardScene()`**

After the `topLayer`/`bottomLayer` creation (line 317), add:

```typescript
  // Sub-layer containers for granular visibility control.
  // Each wraps a rendering phase so visibility can be toggled independently.
  const topFillLayer     = new Container();
  const bottomFillLayer  = new Container();
  const topPinLayer      = new Container();
  const bottomPinLayer   = new Container();
  const topOutlineLayer  = new Container();
  const bottomOutlineLayer = new Container();
  const topLabelLayer    = new Container();
  const bottomLabelLayer = new Container();
```

- [ ] **Step 3: Route fills into sub-containers**

Change the fill flush (~lines 993-1001) from adding to `topLayer`/`bottomLayer` to adding to `topFillLayer`/`bottomFillLayer`:

```typescript
  // Flush component-type fills — one Graphics per color, added before grid cells (fills under pins)
  for (const [color, gfx] of topFillMap) {
    gfx.fill({ color, alpha: s.componentFillAlpha });
    topFillLayer.addChild(gfx);
  }
  for (const [color, gfx] of bottomFillMap) {
    gfx.fill({ color, alpha: s.componentFillAlpha });
    bottomFillLayer.addChild(gfx);
  }
```

- [ ] **Step 4: Route pin grid cells and NC pins into sub-containers**

Change the grid cell flush (~lines 1010-1031) — replace `layer.addChild(cell.container)` targets:

```typescript
  for (const [grid, layer, flatMap] of [
    [topGrid, topPinLayer, topPinGfx],
    [bottomGrid, bottomPinLayer, bottomPinGfx],
  ] as [GridCell[][], Container, Map<number, Graphics>][]) {
```

(Only the second element in each tuple changes — `topLayer` → `topPinLayer`, `bottomLayer` → `bottomPinLayer`.)

Change the NC pin flush (~lines 1038-1041):

```typescript
  for (const [ncGfx, layer] of [[topNcPinGfx, topPinLayer], [bottomNcPinGfx, bottomPinLayer]] as [Graphics, Container][]) {
    ncGfx.stroke({ width: ncStrokeWidth, color: 0x555555, alpha: s.pinAlpha });
    layer.addChild(ncGfx);
  }
```

- [ ] **Step 5: Route borders into outline sub-containers**

Change the border flush (~lines 1045) — replace layer target:

```typescript
  for (const [batch, layer] of [[topBorderBatch, topOutlineLayer], [bottomBorderBatch, bottomOutlineLayer]] as [BorderBatch, Container][]) {
```

- [ ] **Step 6: Route part containers into label sub-containers**

Change the part container flush (~lines 1062-1064):

```typescript
  // Add part containers above pins, triangles, and borders
  for (const { container, isBottom } of partQueue) {
    (isBottom ? bottomLabelLayer : topLabelLayer).addChild(container);
  }
```

- [ ] **Step 7: Route pin label layers into label sub-containers**

Change the label layer additions (~lines 1110-1113):

```typescript
  // Group B (2-pin net names) added below Group A (circle labels) — Group A is smallest/densest.
  topLabelLayer.addChild(topTwoPinNetLayer);
  topLabelLayer.addChild(topCircleLabelLayer);
  bottomLabelLayer.addChild(bottomTwoPinNetLayer);
  bottomLabelLayer.addChild(bottomCircleLabelLayer);
```

- [ ] **Step 8: Add sub-containers to parent layers**

After the label layer additions, add the sub-containers to `topLayer`/`bottomLayer` in correct z-order:

```typescript
  // Add sub-layers in z-order: fills (bottom) → pins → outlines → labels (top)
  topLayer.addChild(topFillLayer);
  topLayer.addChild(topPinLayer);
  topLayer.addChild(topOutlineLayer);
  topLayer.addChild(topLabelLayer);
  bottomLayer.addChild(bottomFillLayer);
  bottomLayer.addChild(bottomPinLayer);
  bottomLayer.addChild(bottomOutlineLayer);
  bottomLayer.addChild(bottomLabelLayer);
```

**Important:** Remove the existing `root.addChild(bottomLayer)` and `root.addChild(topLayer)` (~line 424-425) and move them AFTER the sub-container additions. Or — since the sub-containers are added to topLayer/bottomLayer (not root), the existing `root.addChild` at lines 424-425 is fine as-is. The sub-containers are children of topLayer/bottomLayer, so they'll be included automatically. The key is that the sub-container `addChild` calls happen BEFORE the return statement, which they do since they replace the direct `layer.addChild()` calls.

**Wait — ordering issue:** Currently `root.addChild(bottomLayer)` and `root.addChild(topLayer)` happen at lines 424-425, BEFORE the flush phases populate them. That's fine because PixiJS renders children at draw time, not add time. The sub-containers just need to be added to their parent layers before the return. So: create them after line 317, add them to their parent layers right after creation:

```typescript
  // Add sub-layers to parent layers in z-order: fills → pins → outlines → labels
  topLayer.addChild(topFillLayer, topPinLayer, topOutlineLayer, topLabelLayer);
  bottomLayer.addChild(bottomFillLayer, bottomPinLayer, bottomOutlineLayer, bottomLabelLayer);
```

This goes right after the sub-container creation (after step 2). The flush phases then `addChild` into the sub-containers instead of the parent layers.

- [ ] **Step 9: Update return statement**

Add the 8 new containers to the return statement at line 1292:

```typescript
  return { root, outlineGfx, topLayer, bottomLayer, topFillLayer, bottomFillLayer, topPinLayer, bottomPinLayer, topOutlineLayer, bottomOutlineLayer, topLabelLayer, bottomLabelLayer, labels, topLabels, bottomLabels, topPinLabels, bottomPinLabels, borderBatches, fontSizeGroups, topPinGfx, bottomPinGfx, topCircleLabelLayer, bottomCircleLabelLayer, topTwoPinNetLayer, bottomTwoPinNetLayer, circleFontSizeGroups, twoPinFontSizeGroups, partLabelByIndex, pinRadiusClamp, traceLayer, traceLayerContainers, viaLayer, viaLabels, viaConnectedLayers };
```

- [ ] **Step 10: Verify TypeScript compiles**

Run: `cd /Users/besitzer/Desktop/Boardviewer/src/frontend && npx tsc --noEmit`
Expected: Errors in `BoardRenderer.ts` because `BoardScene` interface doesn't have the new fields yet. That's expected — Task 3 fixes it.

- [ ] **Step 11: Commit**

```bash
git add src/frontend/src/renderer/board-scene.ts
git commit -m "feat: wrap scene graph phases in sub-containers for granular visibility"
```

---

### Task 3: Wire Visibility in BoardRenderer

**Files:**
- Modify: `src/frontend/src/renderer/BoardRenderer.ts:35-75` (BoardScene interface)
- Modify: `src/frontend/src/renderer/BoardRenderer.ts:1055-1067` (applyLayerVisibility)

- [ ] **Step 1: Add sub-container fields to `BoardScene` interface**

In `src/frontend/src/renderer/BoardRenderer.ts`, add after `bottomLayer` (line 39):

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

- [ ] **Step 2: Expand `applyLayerVisibility()`**

Replace the method at lines 1055-1067:

```typescript
  /** Apply per-layer trace, via, and component sub-layer visibility */
  private applyLayerVisibility(scene: BoardScene) {
    const { layerStates, showTraces, showVias, showComponents, showPins, showOutlines, showLabels } = boardStore;
    // Trace layer master toggle
    if (scene.traceLayer) scene.traceLayer.visible = showTraces;
    // Per-layer trace containers
    for (let i = 0; i < scene.traceLayerContainers.length; i++) {
      const c = scene.traceLayerContainers[i];
      if (c) c.visible = showTraces && (i < layerStates.length ? layerStates[i].visible : true);
    }
    // Via overlay
    if (scene.viaLayer) scene.viaLayer.visible = showVias;
    // Component sub-layer visibility (master: showComponents)
    scene.topFillLayer.visible     = showComponents;
    scene.bottomFillLayer.visible  = showComponents;
    scene.topPinLayer.visible      = showComponents && showPins;
    scene.bottomPinLayer.visible   = showComponents && showPins;
    scene.topOutlineLayer.visible  = showComponents && showOutlines;
    scene.bottomOutlineLayer.visible = showComponents && showOutlines;
    scene.topLabelLayer.visible    = showComponents && showLabels;
    scene.bottomLabelLayer.visible = showComponents && showLabels;
  }
```

Note: `topFillLayer`/`bottomFillLayer` visibility is just `showComponents` — the `showComponentColors` render-setting controls whether fills are *drawn* in `buildBoardScene()`, while this toggle controls whether the container is *visible*. No separate `showFills` toggle needed (the existing `showComponentColors` in render-settings already serves this purpose).

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd /Users/besitzer/Desktop/Boardviewer/src/frontend && npx tsc --noEmit`
Expected: Clean compilation (or only pre-existing errors).

- [ ] **Step 4: Commit**

```bash
git add src/frontend/src/renderer/BoardRenderer.ts
git commit -m "feat: wire sub-layer visibility in BoardRenderer.applyLayerVisibility"
```

---

### Task 4: Update Sidebar UI — Collapsible Components Group

**Files:**
- Modify: `src/frontend/src/components/BoardSidebar.tsx:81-126` (LayersTab)
- Modify: `src/frontend/src/index.css` (new styles)

- [ ] **Step 1: Update LayersTab to use collapsible Components group**

Replace the LayersTab function in `src/frontend/src/components/BoardSidebar.tsx` (lines 81-161):

```tsx
function LayersTab() {
  const { layerStates, showComponents, showVias, showTraces, showPins, showOutlines, showLabels, board, selection } = useBoardStore();
  const [componentsExpanded, setComponentsExpanded] = useState(true);

  // Compute which layers have traces for the currently highlighted net
  const highlightedLayers = useMemo(() => {
    const set = new Set<number>();
    if (selection.highlightedNet && board?.traces) {
      for (const t of board.traces) {
        if (t.net === selection.highlightedNet && t.layer != null) {
          set.add(t.layer);
        }
      }
    }
    return set;
  }, [selection.highlightedNet, board?.traces]);

  return (
    <div className="panel-content layer-list" data-testid="layer-list">
      <div className="layer-list-header">
        <span>{layerStates.length} layers</span>
        <div className="layer-header-buttons">
          <button
            className={`layer-toggle-all ${showTraces ? '' : 'off'}`}
            onClick={() => boardStore.toggleTraces()}
            title={showTraces ? 'Hide all traces' : 'Show all traces'}
          >
            {showTraces ? '◉ Traces' : '○ Traces'}
          </button>
          {board?.vias && board.vias.length > 0 && (
            <button
              className={`layer-toggle-all ${showVias ? '' : 'off'}`}
              onClick={() => boardStore.toggleVias()}
              title={showVias ? 'Hide vias' : 'Show vias'}
            >
              {showVias ? '◉ Vias' : '○ Vias'}
            </button>
          )}
        </div>
      </div>

      {/* Collapsible Components group */}
      <div className="component-layer-group">
        <div className="component-layer-header">
          <button
            className="component-layer-collapse"
            onClick={() => setComponentsExpanded(!componentsExpanded)}
            title={componentsExpanded ? 'Collapse' : 'Expand'}
          >
            {componentsExpanded ? '▾' : '▸'}
          </button>
          <button
            className={`layer-toggle-all ${showComponents ? '' : 'off'}`}
            onClick={() => boardStore.toggleComponents()}
            title={showComponents ? 'Hide all components' : 'Show all components'}
          >
            {showComponents ? '◉ Components' : '○ Components'}
          </button>
        </div>
        {componentsExpanded && (
          <div className={`component-sub-toggles ${showComponents ? '' : 'disabled'}`}>
            <button
              className={`layer-toggle-sub ${showComponents && showPins ? '' : 'off'}`}
              onClick={() => boardStore.togglePins()}
              disabled={!showComponents}
              title={showPins ? 'Hide pins' : 'Show pins'}
            >
              {showPins ? '◉ Pins' : '○ Pins'}
            </button>
            <button
              className={`layer-toggle-sub ${showComponents && showOutlines ? '' : 'off'}`}
              onClick={() => boardStore.toggleOutlines()}
              disabled={!showComponents}
              title={showOutlines ? 'Hide outlines' : 'Show outlines'}
            >
              {showOutlines ? '◉ Outlines' : '○ Outlines'}
            </button>
            <button
              className={`layer-toggle-sub ${showComponents && showLabels ? '' : 'off'}`}
              onClick={() => boardStore.toggleLabels()}
              disabled={!showComponents}
              title={showLabels ? 'Hide labels' : 'Show labels'}
            >
              {showLabels ? '◉ Labels' : '○ Labels'}
            </button>
          </div>
        )}
      </div>

      <div className="layer-list-container">
        {layerStates.map((layer, idx) => {
          const hasNet = highlightedLayers.has(idx);
          const blinkHidden = hasNet && !layer.visible;
          return (
            <div
              key={idx}
              className={[
                'layer-item',
                layer.visible ? '' : 'layer-hidden',
                hasNet ? 'layer-net-active' : '',
                blinkHidden ? 'layer-blink' : '',
              ].join(' ')}
            >
              <button
                className={`layer-visibility ${layer.visible ? 'on' : 'off'}`}
                onClick={() => boardStore.toggleLayer(idx)}
                title={layer.visible ? 'Hide layer' : 'Show layer'}
              >
                {layer.visible ? '●' : '○'}
              </button>
              <input
                type="color"
                className="layer-color-picker"
                value={colorToHex(layer.color)}
                onChange={(e) => boardStore.setLayerColor(idx, hexToColor(e.target.value))}
                title="Change layer color"
              />
              <span className="layer-name">{layer.name}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add CSS for the collapsible Components group**

In `src/frontend/src/index.css`, after the `.layer-toggle-all.off` rule (~line 1529), add:

```css
/* Component sub-layer group */
.component-layer-group {
  border-bottom: 1px solid var(--border);
  padding: 4px 12px 6px;
}

.component-layer-header {
  display: flex;
  align-items: center;
  gap: 2px;
}

.component-layer-collapse {
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: 10px;
  cursor: pointer;
  padding: 2px 4px;
  line-height: 1;
}

.component-layer-collapse:hover {
  color: var(--text-primary);
}

.component-sub-toggles {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding-left: 20px;
  margin-top: 2px;
}

.component-sub-toggles.disabled {
  opacity: 0.35;
  pointer-events: none;
}

.layer-toggle-sub {
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: 11px;
  cursor: pointer;
  padding: 1px 6px;
  border-radius: 3px;
  text-align: left;
}

.layer-toggle-sub:hover {
  color: var(--text-primary);
  background: rgba(255, 255, 255, 0.06);
}

.layer-toggle-sub.off {
  opacity: 0.5;
}
```

- [ ] **Step 3: Verify dev server renders correctly**

Run: `cd /Users/besitzer/Desktop/Boardviewer/src/frontend && npx vite --port 8082`
Expected: Sidebar Layers tab shows Traces + Vias at top, then a collapsible Components group with Pins/Outlines/Labels sub-toggles. Components group is expanded by default. Vias start as off (○).

- [ ] **Step 4: Verify TypeScript compiles**

Run: `cd /Users/besitzer/Desktop/Boardviewer/src/frontend && npx tsc --noEmit`
Expected: Clean compilation.

- [ ] **Step 5: Commit**

```bash
git add src/frontend/src/components/BoardSidebar.tsx src/frontend/src/index.css
git commit -m "feat: collapsible Components group with sub-layer toggles in sidebar"
```

---

### Task 5: Manual Integration Test + Fix-Up

- [ ] **Step 1: Load a multi-layer board (TVW or Allegro) and verify**

Open a multi-layer board file. In the Layers sidebar tab:
1. Vias should be OFF by default (○ Vias)
2. Toggle Vias ON — via markers + crosshairs should appear
3. Toggle Components OFF — all pins, outlines, labels, fills should disappear, leaving only traces + outline
4. Toggle Components ON — everything reappears
5. Toggle Pins OFF — filled pads disappear, outlines + labels remain
6. Toggle Outlines OFF — green/red borders disappear
7. Toggle Labels OFF — component names (R1, C2, etc.) and pin labels disappear
8. Toggle Components OFF — all sub-layers hidden regardless of sub-toggle states
9. Toggle Components ON — sub-toggles restore their previous states

- [ ] **Step 2: Load a single-layer board (BVR/BRD) and verify**

Open a single-layer board. Vias button should not appear (existing behavior). Components group and sub-toggles should work the same way.

- [ ] **Step 3: Test butterfly mode**

Enable butterfly mode. Both top and bottom sides should respect the sub-layer toggles independently (they share the same tab state, so both sides toggle together — this is correct).

- [ ] **Step 4: Fix any issues found**

Address any visual or functional issues. Common things to check:
- Selection highlighting still works (operates on `selectionGfx`, separate from sub-containers)
- Part hover/click still works (uses hit-testing against part bounds, not container visibility)
- LoD (zoom-based label hiding) still works (font-size groups operate on BitmapText references, not containers)

- [ ] **Step 5: Commit any fixes**

```bash
git add -A
git commit -m "fix: integration fixes for granular sub-layer visibility"
```
