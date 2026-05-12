# Pin Drawing Optimization — Plan

## Current Situation

`buildBoardScene()` iterates over every part and creates a new `Graphics` object for each
unique color found **within that part**:

```
for each part:
  pinColorMap = new Map<color, Graphics>()     ← new Map per part
  for each pin:
    color = resolvePinColor(...)
    pinColorMap.get(color).circle(...)         ← draw into per-part Graphics
  for each [color, gfx] in pinColorMap:
    partContainer.addChild(gfx)               ← many Graphics per part
```

On a real board (3,075 parts, ~11,000 pins) with 5 distinct pin colors this produces
**~15,000 Graphics objects** — each one a separate GPU draw-call batch.

---

## Proposed Change: Board-Wide Color Batching

Collapse all pin rendering into **one `Graphics` object per unique color per layer**
across the entire board. With the current default net-color rules (GND, VCC, PP +
top/bottom fallbacks) the total pin color count is 5–10, regardless of board size.

```
// Before the part loop:
const topPinGfx   = new Map<number, Graphics>()   // color → Graphics (top layer)
const bottomPinGfx = new Map<number, Graphics>()  // color → Graphics (bottom layer)

// Inside the part loop, for each pin:
const map   = pin.side === 'top' ? topPinGfx : bottomPinGfx
const color = resolvePinColor(s, pin.net, pin.side)
if (!map.has(color)) map.set(color, new Graphics())
drawPinShape(map.get(color)!, pin, ...)    ← add to global Graphics, not per-part

// After the part loop:
for (const [color, gfx] of topPinGfx)    topLayer.addChild(gfx)
for (const [color, gfx] of bottomPinGfx) bottomLayer.addChild(gfx)
```

Result: **5–10 Graphics objects total** for all pins on any board.

---

## Effect on Culling

Currently `partContainer` is `cullable = true`, which skips off-screen parts.
With global pin Graphics, individual pins can no longer be culled at the container level.

**Why this is still a net win:**
- PixiJS culls at the Container/Graphics boundary. Even with per-part culling, a Graphics
  object with 3 pin shapes in it is already a single draw call — skipping it saves one
  batch. Skipping one global Graphics (which has 3,000 circles) also saves one batch.
- The real cost is submitting GPU state for each draw call, not the number of pixels drawn.
  Reducing from ~15,000 submissions to ~10 is the dominant win.

**Acceptable trade-off:** pins outside the viewport are still clipped by the GPU scissor rect
at the viewport level. The overdraw cost for off-screen pins is negligible vs. the per-batch
overhead we eliminate.

If culling becomes measurable later, an explicit clip rect on the pin Graphics objects
(set to the Viewport's visible world bounds) would restore it without reverting the structure.

---

## Separation of Top / Bottom Layers

The existing `topLayer` / `bottomLayer` containers control layer visibility with a single
`layer.visible = false`. This works identically with global pin Graphics — they are children
of those same layer containers.

No behavior change needed.

---

## Two-Pin Parts (Rectangles)

Two-pin parts already use `rect()` calls instead of `circle()`. These go into the same
global color-keyed Graphics — circles and rectangles can coexist in one Graphics object.
No special case required.

---

## What Does NOT Change

| Element | Why it stays per-part |
|---|---|
| Part borders (`borderGfx`) | `updateBorderWidths()` needs to reach each border's Graphics individually for dynamic min-width during zoom; stored in `BorderEntry[]` |
| Part labels (`BitmapText`) | Already lifted to a separate `labelsRoot` container above selection; unchanged |
| Pin labels / net labels (`BitmapText`) | Already returned in separate arrays; unchanged |
| Pin-1 triangle marker | Small per-part Graphics, 1 per multi-pin part; relatively rare, not worth batching |
| Selection / highlight overlay | Already in `selectionGfx` (separate Graphics in `BoardRenderer`); unchanged |

---

## Changes to `BoardSceneGraph`

Add two new fields to the return type so callers can inspect or reuse the global pin maps:

```typescript
export interface BoardSceneGraph {
  root:           Container;
  outlineGfx:     Graphics;
  topLayer:       Container;
  bottomLayer:    Container;
  labels:         BitmapText[];
  topLabels:      BitmapText[];
  bottomLabels:   BitmapText[];
  topPinLabels:   BitmapText[];
  bottomPinLabels: BitmapText[];
  borderEntries:  BorderEntry[];
  fontSizeGroups: FontSizeGroup[];
  butterflyRoot:  Container | null;
  butterflyOutline: Graphics | null;
  // NEW:
  topPinGfx:      Map<number, Graphics>;   // color → global pin Graphics (top)
  bottomPinGfx:   Map<number, Graphics>;   // color → global pin Graphics (bottom)
}
```

`BoardRenderer` and `SettingsMockup` don't need to use these fields directly — they just
keep existing `sceneRoot`/`graph.root` handling. The fields are there for future use
(e.g. re-coloring a single net without a full rebuild).

---

## Expected Performance Impact

| Metric | Before | After |
|---|---|---|
| Graphics objects (pins only) | ~15,000 | ~10 |
| GPU draw-call submissions (pins) | ~15,000 | ~10 |
| Memory (Graphics overhead) | High | Minimal |
| `buildBoardScene()` CPU time | Similar | Similar (loop unchanged) |
| Frame render time (large board) | High | Near-zero for pins |

The improvement is most visible during the initial render and whenever settings change
trigger a full scene rebuild (`pinAlpha`, `pinMinRadius`, `netColorRules`).

---

## Implementation Scope

Only `board-scene.ts` needs to change — specifically the pin-drawing section inside
`buildBoardScene()`. The public `BoardSceneGraph` interface gains two fields.
No changes to `BoardRenderer.ts`, `SettingsMockup.tsx`, or any store.

Estimated change: ~40 lines modified/replaced, ~5 lines added to the interface.
