# Pin Label Rendering Optimizations

Research context: BoardRipper renders boards with ~10k parts and 100k+ pins on
PixiJS v8. The renderer feels fine until the user zooms in far enough that pin
labels appear, at which point frame time climbs noticeably. The user proposed
restricting label rendering to the visible viewport (plus a small margin) with
a debounce on pan, and also asked about shader-level approaches. This report
complements [threejs-webgpu-vs-pixi.md](./threejs-webgpu-vs-pixi.md) — it does
not repeat the WebGPU/MSDF/instancing case there, but layers onto it.

---

## 1. Diagnose the actual cost of pin labels

### How labels are currently produced

Every visible pin with a number or a net name gets its own fresh `BitmapText`
built inside `buildBoardScene()`:

- Pin number: `new BitmapText({ ... fontFamily: ensurePinFont(pinFontSize) })`
  — [board-scene.ts:802-815](../../src/frontend/src/renderer/board-scene.ts).
- Net name on pin: `new BitmapText({ ... fontFamily: ensureShadowFont(…) })`
  — [board-scene.ts:873-919](../../src/frontend/src/renderer/board-scene.ts).
  For 2-pin parts and when `pinNetLabelBg` is on, the label is wrapped in a
  `Container` with a background `Graphics` behind it (extra scene node per
  label — ~871-919).
- Part labels: one `BitmapText` per part, same pattern
  ([board-scene.ts:1063-1074](../../src/frontend/src/renderer/board-scene.ts)).

Labels are created **once** at scene build and never recycled. A dense BGA
board can realistically instantiate 100k+ BitmapText nodes plus, for some
settings, a wrapper `Container` and a background `Graphics` per label — i.e.
300k scene-graph nodes in the worst case.

### How labels are grouped for culling/visibility

`buildBoardScene()` builds a spatial grid (1×1 / 4×4 / 8×8 depending on pin
count — [board-scene.ts:58-62](../../src/frontend/src/renderer/board-scene.ts)).
Labels are bucketed into per-cell `Container`s with `cullable = true` and an
explicit `cullArea` Rectangle
([board-scene.ts:505-520, 1186-1210](../../src/frontend/src/renderer/board-scene.ts)).

On top of that, labels are bucketed by font size ("font size groups") so the
renderer can flip whole tiers visible/invisible on zoom
([board-scene.ts:1223-1280](../../src/frontend/src/renderer/board-scene.ts)),
and `BoardRenderer.applyLabelVisibility()`
([BoardRenderer.ts:1087-1139](../../src/frontend/src/renderer/BoardRenderer.ts))
walks those groups and sets `lbl.visible` per group when thresholds cross.

### The critical finding — PixiJS v8 culling is **not** actually running

In PixiJS v8, `cullable = true` + `cullArea` are **inert** unless the app also
runs either `Culler.shared.cull(stage, screen)` each frame or installs the
`CullerPlugin`. This is the headline change in the v8 migration guide
([v8 migration](https://pixijs.com/8.x/guides/migrations/v8),
[Culler deep dive — Richard Fu](https://www.richardfu.net/optimizing-rendering-with-pixijs-v8-a-deep-dive-into-the-new-culling-api/)).
BoardRipper does neither — a codebase search for `Culler`, `CullerPlugin`,
`viewport.cull` turns up nothing. `applyViewportPlugins()`
([BoardRenderer.ts:2026-2045](../../src/frontend/src/renderer/BoardRenderer.ts))
installs `drag/pinch/wheel/clampZoom/decelerate` only, not `cull`. The render
tick at [BoardRenderer.ts:390-402](../../src/frontend/src/renderer/BoardRenderer.ts)
just calls `app.render()`.

**Consequence:** every frame that re-renders, PixiJS walks all 100k+
BitmapTexts to accumulate batches. `visible=false` does short-circuit the
traversal for that subtree, so the font-size-group toggling *does* save work
at very low zoom. But once any Group-A bucket is visible (the user is zoomed
in enough to see at least some pin labels), every pin-label BitmapText in
that bucket — across the entire board, not just the viewport — is walked,
has its global transform recomputed, and contributes to batching.

### Where the frame time actually goes

1. **Transform update:** on any `viewport.moved` event (pan, wheel, zoom),
   PixiJS recomputes world transforms top-down. With 100k+ text nodes the
   per-frame overhead is non-trivial.
2. **Batcher churn:** each visible `BitmapText` feeds quads into the batcher.
   Text sharing one font atlas *does* batch well, but with multiple font
   sizes and the shadow/plain atlas split
   ([board-scene.ts:174-243](../../src/frontend/src/renderer/board-scene.ts))
   the batch count grows. Wrapper `Container`s with a per-label background
   `Graphics` (2-pin net labels with `twoPinNetLabelBg` — ~881-894) break
   the batch between text and rect and back — one of the nastier cases.
3. **Absent CPU cull:** because `cullable=true` is not enforced, the entire
   board's visible labels are traversed even when 95% are off-screen.
4. **Zoom-transient churn:** labels are hidden en-masse on the first zoom
   frame (`textHiddenForZoom`, [BoardRenderer.ts:1018-1060](../../src/frontend/src/renderer/BoardRenderer.ts))
   and restored after a 32 ms settle. That's already good; pan has no
   equivalent path and keeps paying for every off-screen label.

---

## 2. Evaluate the viewport-cull + pan-cooldown idea

**Verdict: yes, this is the right direction, and it's mostly a one-line fix
before anything fancier.**

### Why the idea works

Because the scene graph nominally already has `cullable=true` on the
per-part and per-grid-cell containers, turning on PixiJS's built-in culling
should silently activate them. Two equivalent minimal options, ranked:

1. **Register `CullerPlugin`** once at app boot:
   `extensions.add(CullerPlugin)` — the plugin calls `Culler.shared.cull`
   automatically each frame against `app.screen`
   ([Culler docs](https://pixijs.download/dev/docs/scene.Culler.html)).
2. Or explicitly call `Culler.shared.cull(this.viewport, this.app.screen)`
   at the top of the existing `onTick` just before `app.render()`
   ([BoardRenderer.ts:330-402](../../src/frontend/src/renderer/BoardRenderer.ts)).

Either way, PixiJS will test each `cullable` Container's `cullArea` against
the screen rect in global coords and set `visible` on the miss. That converts
"walk 100k BitmapTexts" into "walk ~N grid cells × ~M parts in-frame",
roughly a 10–100× reduction at deep zoom on a large board. `cullableChildren
= false` on the leaf grid-cell containers would tell Pixi not to recurse into
each cell's children — the per-cell rect is already tighter than any
individual label's rect, so recursion buys nothing
([performance tips](https://pixijs.com/8.x/guides/concepts/performance-tips)).

### Gotchas

- **cullArea is in global coordinates.** The scene's cullArea rects are in
  scene-local (pre-transform) coords
  ([board-scene.ts:511-517](../../src/frontend/src/renderer/board-scene.ts)).
  After `applyFlips` rotates/mirrors the root, those rects will be wrong
  unless we either (a) reverse-project the screen rect into scene space once
  per frame and cull against that, or (b) rebuild cullArea rects on every
  transform change (expensive). Option (a) is the correct fix — `Culler`
  normally takes a rect in stage space and descends with transforms, which
  works fine if `cullArea` is interpreted correctly relative to each
  container's worldTransform. Verify before turning culling on globally;
  there are known v8 gotchas where `cullArea` is expected to be in the
  cullable container's own local coordinate frame.
- **Font-size group visibility mixes with culling.** `applyLabelVisibility`
  sets `group.visible` = scene root children's `visible` bits; culling only
  toggles ancestor containers. Both can coexist — the narrower of the two
  wins. Leave the group logic alone for LoD.
- **BitmapText is a Container** (it's a mesh-shading View subclass), but
  does *not* have its own cullArea — so it inherits the decision from its
  ancestor grid-cell container. Correct behaviour.
- **Label pop-in on pan is cosmetic**: the grid cell size at the 8×8
  resolution is roughly 1/8 of the board. At deep zoom the viewport usually
  lies inside one or two cells, so a cell-boundary crossing during pan is
  rare; when it happens, the entire newly-entered cell turns on at once,
  already populated — no visible pop-in, no rebuild work.
- **BitmapText construction cost** would only be an issue in a lazy-create
  scheme. With the "cull existing nodes" design above it's irrelevant.

### The pan cooldown

With hard culling in place, no cooldown is needed for correctness. A
cooldown helps only if we choose the more aggressive lazy-create strategy
(destroy labels when they leave the viewport, rebuild on entry). For that
design, the equivalent of `textHiddenForZoom` at
[BoardRenderer.ts:1018-1060](../../src/frontend/src/renderer/BoardRenderer.ts)
is the right template: debounce rebuild to ~48–96 ms after the last
`viewport.moved` event (one-and-a-half frames at 60 Hz), using the existing
`zoomSettleTimer` pattern. `requestIdleCallback` adds unpredictable latency
and is the wrong tool for interactive pan. But: lazy build/destroy of
100k+ nodes churns GC, and the cull-only design almost certainly removes
the need. Start there.

### How map renderers solve this

Mapbox GL builds a per-tile **GlyphAtlas + symbol geometry buffer** on a
Web Worker when the tile loads, keeps a `FeatureIndex` for collision, and
renders labels with an SDF fragment shader — each glyph is one instanced
quad
([Text Rendering · mapbox-gl-native wiki](https://github.com/mapbox/mapbox-gl-native/wiki/Text-Rendering),
[GlobeletJS/tile-labeler](https://github.com/GlobeletJS/tile-labeler)).
deck.gl delegates label drawing to Mapbox's symbol layer and controls
ordering with `beforeId` ([deck.gl + Mapbox](https://deck.gl/docs/api-reference/mapbox/mapbox-overlay)).
The design tenet is "spatial index + generate labels only for visible tiles
+ render every tile's labels as buffers, not scene-graph nodes." BoardRipper
already has the spatial grid; it's missing the worker-side geometry buffer
and the active culling.

---

## 3. Complementary / superior shader-based approaches

These are covered at a deeper architectural level in
[threejs-webgpu-vs-pixi.md](./threejs-webgpu-vs-pixi.md); the framing here is
purely "is it worth it for the pin-label hot path specifically?"

- **Instanced label rendering in PixiJS v8.** Yes, doable without leaving
  Pixi. v8 ships a custom `Mesh` with shader + geometry
  ([PixiJS Mesh guide](https://pixijs.com/8.x/guides/components/scene-objects/mesh))
  and `ParticleContainer` is internally instanced. `ParticleContainer`
  itself cannot render text (particles carry pos/scale/rot/tint/alpha only,
  no per-instance text index —
  [ParticleContainer guide](https://pixijs.com/8.x/guides/components/scene-objects/particle-container)),
  but a custom Mesh with per-instance (pos, glyphId, rotation, tint) feeding
  an MSDF glyph atlas is the standard "instanced SDF labels" pattern
  ([SDF PIXI article — Clash of Coins](https://medium.com/@clashofcoins/implementing-sdf-text-rendering-in-pixi-js-3cf78614071d)).
  Effort: real — custom WGSL+GLSL shader pair, buffer packing, tint glue.
  Impact: collapses 100k labels into O(1) draw calls.
- **SDF (or MSDF) text** vs BitmapText: SDF is scale-independent (one atlas
  serves all zoom levels), crisper at deep zoom, and eliminates the
  `pin-N` / `board-shadow-N-v3` quantized atlas zoo
  ([board-scene.ts:174-243](../../src/frontend/src/renderer/board-scene.ts)).
  Shadow would be a cheap fragment-shader effect rather than a baked atlas.
  Atlas memory drops. Combine with instancing for the full win.
- **Vertex-shader-side culling.** With an instanced buffer, the vertex
  shader for off-screen instances can emit degenerate triangles
  (`gl_Position = vec4(2,2,2,1)`). This beats CPU culling **only when the
  CPU cull itself is the bottleneck**. After installing `CullerPlugin`,
  CPU culling is O(grid cells), essentially free — GPU culling gains
  nothing for BoardRipper's N. Skip.
- **Zoom-gated LoD.** Already implemented via font-size groups
  ([BoardRenderer.ts:1087-1139](../../src/frontend/src/renderer/BoardRenderer.ts)).
  The one missing tier is "at very high zoom, only the ~3 largest tiers
  exist as scene nodes at all" — useful if we later switch to instanced
  labels and want to keep per-frame instance count bounded.
- **Spatial index (grid/R-tree).** BoardRipper already has the grid
  ([board-scene.ts:505-520](../../src/frontend/src/renderer/board-scene.ts))
  and a separate hit-grid ([BoardRenderer.ts:276-282](../../src/frontend/src/renderer/BoardRenderer.ts)).
  Adding an R-tree buys precision over the current uniform grid only if we
  also switch to a draw-per-frame architecture (instancing); with
  scene-graph culling the uniform grid is adequate.

---

## 4. Recommendation stack

Ranked by (impact / effort) for BoardRipper specifically:

1. **Turn on PixiJS v8 culling — one commit, near-zero risk.**
   - `extensions.add(CullerPlugin)` at app boot, or call
     `Culler.shared.cull(this.viewport, this.app.screen)` in `onTick` just
     before `app.render()`
     ([BoardRenderer.ts:390-396](../../src/frontend/src/renderer/BoardRenderer.ts)).
   - Set `cullableChildren = false` on the per-grid-cell label containers
     at [board-scene.ts:1187, 1201](../../src/frontend/src/renderer/board-scene.ts)
     so Pixi doesn't descend into each cell's label list.
   - Verify `cullArea` coordinate frame matches how `Culler` expects it
     after `applyFlips` is applied. Use the perf HUD to watch
     `pinVis / pinTotal` drop proportionally when zoomed in.
2. **Drop unnecessary wrappers for 2-pin net labels.**
   The Container+Graphics wrapper at
   [board-scene.ts:881-894](../../src/frontend/src/renderer/board-scene.ts)
   roughly triples the node count per label when the bg is enabled. Either
   bake the background as a shared 9-slice sprite behind all labels in a
   cell, or skip the bg except on hover/selection. Small effort, visible
   reduction in batcher churn.
3. **(Optional, later)** Pan-end debounce for expensive label-layout work.
   Only worth doing if, after (1), net-label repainting on pan still shows
   in the perf HUD. Reuse the `zoomSettleTimer` pattern from
   [BoardRenderer.ts:1044-1059](../../src/frontend/src/renderer/BoardRenderer.ts);
   ~48–80 ms after last `viewport.moved`.
4. **(Longer horizon, aligns with [threejs-webgpu-vs-pixi.md](./threejs-webgpu-vs-pixi.md))**
   Instanced SDF labels via a custom `Mesh`. Do this when we touch the
   label pipeline for other reasons (text-colour-from-backdrop, label
   collision). Not until (1)-(3) show they've plateaued.

---

## 5. Open questions / measurements needed

Before committing to anything more than step (1), collect numbers with the
Chrome DevTools Performance timeline on a ~100k-pin BVR3 sample
(`samples/820-02016.bvr` is 11k pins — find or synthesise denser for a
stress test):

- **Baseline frame-time histogram** at three zoom levels: fit-to-board,
  "labels just visible", "deep zoom". Record mean and p95 over a 5 s pan.
- **After enabling CullerPlugin,** re-measure the same three. Expect p95 at
  deep zoom to drop by 5–20×; at fit-to-board it should be unchanged (all
  labels already invisible via font-size groups).
- **Counter experiment:** force `cullable = false` everywhere and measure
  the delta to confirm cull is what changed things, not a side effect.
- **Node count check:** log `scene.root` descendants. If >200k, that alone
  is probably the cost driver and step (2) or instancing becomes more
  attractive.
- **Batch-break count:** PixiJS's WebGL debug extension reports draw-call
  count. Expect the pin-label scene at deep zoom to issue a handful of
  draws — watch for outliers caused by bg wrappers or multiple font
  atlases.

Only if culling alone doesn't close the gap should the shader-side work in
§3 be scheduled — and at that point the WebGPU-migration write-up in
[threejs-webgpu-vs-pixi.md](./threejs-webgpu-vs-pixi.md) becomes the
applicable plan.

---

### Sources

- [PixiJS v8 migration guide](https://pixijs.com/8.x/guides/migrations/v8)
- [Culler API reference](https://pixijs.download/dev/docs/scene.Culler.html)
- [PixiJS v8 performance tips](https://pixijs.com/8.x/guides/concepts/performance-tips)
- [PixiJS v8 Mesh guide](https://pixijs.com/8.x/guides/components/scene-objects/mesh)
- [PixiJS v8 ParticleContainer guide](https://pixijs.com/8.x/guides/components/scene-objects/particle-container)
- [Richard Fu — Optimizing rendering with PixiJS v8 culling](https://www.richardfu.net/optimizing-rendering-with-pixijs-v8-a-deep-dive-into-the-new-culling-api/)
- [Mapbox text rendering wiki](https://github.com/mapbox/mapbox-gl-native/wiki/Text-Rendering)
- [GlobeletJS/tile-labeler](https://github.com/GlobeletJS/tile-labeler)
- [Mapbox GL JS PR #5190 — per-tile glyph/icon atlases](https://github.com/mapbox/mapbox-gl-js/pull/5190)
- [SDF text in PixiJS — Clash of Coins](https://medium.com/@clashofcoins/implementing-sdf-text-rendering-in-pixi-js-3cf78614071d)
- [deck.gl + Mapbox overlay](https://deck.gl/docs/api-reference/mapbox/mapbox-overlay)
