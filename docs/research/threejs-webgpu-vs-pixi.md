# three.js + WebGPU vs PixiJS v8 + WebGL for BoardRipper

*Written April 2026. BoardRipper is on `pixi.js@^8.17`, `pixi-viewport@^6.0.3`,
React 19, Vite 7. Renderer entry points: `src/frontend/src/renderer/BoardRenderer.ts`
(3,817 lines) and `src/frontend/src/renderer/board-scene.ts` (1,400 lines).*

## 1. What WebGPU buys you that WebGL doesn't (for this workload)

The honest answer: for a static-ish 2D scene that already batches well, the
single-frame GPU win is small. The wins are CPU-side and architectural.

- **No global state validation per draw call.** WebGL drivers re-validate the
  giant pipeline state on every `drawElements`. WebGPU pre-bakes a
  `RenderPipeline` + `BindGroup` and the CPU just records "use pipeline X,
  bind group Y, draw N instances" into a command encoder. For BoardRipper this
  matters because we currently emit one `Graphics` per pin colour per spatial
  cell (`board-scene.ts:532-538` `getGridPinGfx`) — that's hundreds to a few
  thousand draw calls on a busy board, and each one pays the WebGL state-check
  tax. Industry write-ups consistently call out this CPU overhead as the
  primary WebGL ceiling
  ([dailydevpost: WebGPU vs WebGL 2026](https://dailydevpost.com/blog/webgpu-vs-webgl-performance-guide)).
- **Real instancing.** WebGL2 has `drawArraysInstanced`, but you still feed
  per-instance attributes through vertex buffers and re-bind on changes.
  WebGPU's storage buffers (≥128 MB per binding vs 64 KB UBOs in WebGL) let
  you ship one big `pins[]` SSBO with `{x, y, radius, colorIdx, partIdx,
  flags}` and draw all 100k+ pins of a board in **one** `draw(6, pinCount)`
  call. That collapses the entire grid-of-`Graphics` apparatus we built in
  `board-scene.ts:497-538` to "one quad, N instances".
- **Compute shaders.** WebGL has none. With WebGPU we can:
  - Cull pins/labels against the viewport on the GPU (a single dispatch
    over the pin SSBO writes a compacted indirect-draw command — replaces the
    spatial-grid + `cullable`/`cullArea` plumbing in `board-scene.ts:505-522`).
  - Do **GPU picking via an ID buffer**: render the scene once into an R32-uint
    target keyed by `(partIdx, pinIdx)`, then `readBuffer` a 1×1 region under
    the cursor. Replaces `pointInConvexPoly`, `hitGrid`, and the rest of the
    CPU-side hit-testing machinery (`BoardRenderer.ts:43`, `:269-271`). Works
    perfectly for arbitrary shapes (diagonal pads, rotated 2-pin parts).
  - **MSDF text** in a compute pass — generate atlases on the fly so we no
    longer need 8+ pre-installed `BitmapFont` sizes per session
    (`board-scene.ts:171-191`, `:223-248`).
- **Bind-group model.** Render-settings (colour palette, LoD thresholds,
  selection state) become two bind groups that you swap atomically rather than
  N `setUniform` calls. Useful here because settings change frequently
  (LoD on every zoom tick, selection on every click).
- **Multi-tab cleanly.** WebGL caps GPU contexts at ~8-16 per process; we
  already work around this in `BoardRenderer.ts:489-494` by force-releasing
  the context with `WEBGL_lose_context` on tab teardown. WebGPU has no such
  hard cap — `GPUDevice` is a software handle on top of a single adapter — so
  multi-board UX scales further before falling over.
- **Multi-threaded submission.** WebGPU command encoders are designed to be
  built on workers and submitted to one queue. WebGL is strictly main-thread.
  We don't need this today, but it's the path for offloading hit-testing or
  scene rebuilds.

What **doesn't** improve much: pure fill-rate-bound passes (the big trace/fill
draw) and anything dominated by `Graphics`-tessellation CPU work. WebGPU's
`Graphics` path in PixiJS still tessellates on the CPU.

## 2. Concrete BoardRipper hot spots that map to WebGPU shaders

Reading `board-scene.ts` and `BoardRenderer.ts`, the candidates ranked by
expected payoff:

1. **Pins/pads as instanced quads + SDF.** Today `buildBoardScene` creates
   `Map<color, Graphics>` per spatial cell and pushes individual `circle()` /
   `rect()` calls (`board-scene.ts:532-746`). Replace with one
   `pins: GPUBuffer<Pin>` SSBO and a fragment shader that picks
   round/square/rounded by `pin.shapeId` via SDF. ~100k draw primitives →
   1 instanced draw. This is the single biggest win.
2. **Pin-1 triangles, vias, NC pins.** Same pattern. Each is currently its own
   batched `Graphics` (`board-scene.ts:391-392, :948`). Each becomes another
   instanced draw — three or four total instead of 2× gridSize².
3. **GPU picking.** Replace `hitGrid` (`BoardRenderer.ts:269-271`),
   `pointInConvexPoly` (`:43`), and the entire hover-tooltip pointer-move
   handler (`boundHover`, `:170`) with a single 1×1 `readBuffer` from an ID
   target. The current CPU path does scene-graph lookups on every pointer
   move; a GPU path is constant-time and exact for diagonal/rotated pads we
   currently approximate.
4. **MSDF labels.** BitmapText atlases (`board-scene.ts:171-248`) are a real
   win over canvas Text but they bake one atlas per font size. MSDF gives one
   atlas, all sizes, sub-pixel sharp, and side-steps the hairy "never
   `BitmapFont.uninstall()` because atlases are global"  rule in CLAUDE.md
   altogether — there'd be one shared MSDF texture per `GPUDevice`, no
   cross-tab teardown problem.
   ([webgpu-samples MSDF text](https://deepwiki.com/webgpu/webgpu-samples/6.2-text-rendering-with-msdf),
   [Mapbox sdf-glyph-foundry](https://github.com/mapbox/sdf-glyph-foundry))
5. **Frustum culling on GPU.** Replace `cullable=true` + `cullArea` plumbing
   (`board-scene.ts:511-517`) with a compute pass producing an indirect-draw
   buffer. Removes per-frame CPU bounds checks.
6. **Trace strokes as instanced fat lines.** Per-layer trace `Graphics`
   (`board-scene.ts:430-474`) become instanced quads — the standard
   "fat-line in shader" pattern. Lets you do correct width-in-pixels at any
   zoom without the `MAX_TRACE_WIDTH` hack at line 55.

## 3. The hybrid path: PixiJS-first

The cheapest experiment is **flip PixiJS to its WebGPU backend**.
PixiJS v8 ships a `WebGPURenderer` and the API surface is identical to the
WebGL one — it's a constructor flag (`preference: 'webgpu'`) on
`Application.init()` (the call site is `BoardRenderer.ts:747-755`).

Caveats from the PixiJS team themselves:

- v8 made WebGPU "feature complete", but they then **switched
  `autoDetectRenderer` back to WebGL as the default** because of inconsistent
  browser behaviour ([PixiJS Renderers guide](https://pixijs.com/8.x/guides/components/renderers)).
  As of April 2026 they still recommend WebGL for production.
- WebGPU only helps PixiJS in scenes with many "batch breaks" — filters,
  masks, blend modes. BoardRipper has very few of these (no filters, no masks
  on the hot path, blend modes only in the optional dim overlay). So the
  per-frame win from just flipping the switch is probably in the 0–15%
  range, not 5×.
- We'd lose nothing: the renderer falls back to WebGL automatically on
  unsupported devices.

Beyond the flag, a real hybrid would be: keep PixiJS for outline/text/UI
overlays and traces, add a custom WebGPU pass for the pin layer. PixiJS v8
exposes hooks for this (`pixi-mixing-three` guide). Useful but non-trivial —
you'd be hand-rolling the bind-group plumbing for one layer while still
paying PixiJS's render costs for the rest.
([PixiJS — Mixing PixiJS and Three.js](https://pixijs.com/8.x/guides/third-party/mixing-three-and-pixi))

## 4. Risks and costs

**Browser support (April 2026):** WebGPU has effectively shipped everywhere
that matters for BoardRipper. Chrome/Edge had it since 113. Safari 26 (macOS
Tahoe, iOS/iPadOS 26) ships it on by default since September 2025. Firefox 141
on Windows; Firefox 145 on Apple-Silicon macOS. Linux Firefox is still
Nightly-only and Firefox-on-Android is behind a flag — both are immaterial
for the current desktop+NAS+Electron deployment.
([web.dev — WebGPU in major browsers](https://web.dev/blog/webgpu-supported-major-browsers),
[caniuse: webgpu](https://caniuse.com/webgpu),
[gpuweb implementation status](https://github.com/gpuweb/gpuweb/wiki/Implementation-Status))

**Electron:** Electron 34+ ships Chromium 132+ and WebGPU is available;
historically it required `--enable-unsafe-webgpu`, and even in current builds
it's worth setting that flag explicitly in the desktop wrapper rather than
relying on the default. Test on the actual NAS-bundled Electron version
before committing.
([electron#26944](https://github.com/electron/electron/issues/26944))

**Bundle size:**
- PixiJS v8 with WebGPU enabled: same bundle as today (~430 KB min+gz).
- three.js WebGPURenderer pulls in TSL + the WebGPU node-graph compiler;
  realistic budget is ~600–800 KB min+gz, more than 2× our current PixiJS
  cost. Vite + Rollup tree-shaking helps but TSL compiler resists shaking.
- Three has **no pan/zoom-viewport equivalent**. `pixi-viewport` gives us
  drag, pinch, wheel, decelerated drag, momentum, follow, snap, pluggable
  scroll bindings (`BoardRenderer.applyViewportPlugins()` at `:2015`) — all
  off the shelf. The closest three options are
  [`yomotsu/camera-controls`](https://github.com/yomotsu/camera-controls)
  (3D-first, ortho works but pan/zoom semantics differ from a 2D map) and
  [`anvaka/three.map.control`](https://github.com/anvaka/three.map.control)
  (2D-map style, smaller and unmaintained). Either way, expect to rewrite
  the viewport layer.

**Rewrite effort (rough):**
- *Flip PixiJS to WebGPU:* hours. Add `preference: 'webgpu'` (with WebGL
  auto-fallback), test on Mac/Win/Linux + Electron + the headless Playwright
  suite. The "never call `app.destroy()`" / "never `BitmapFont.uninstall()`"
  rules in CLAUDE.md still apply; the underlying `Batcher.mjs` corruption
  bug exists in both backends.
- *Custom WebGPU pin pass under PixiJS:* 1–2 weeks. Need to write the
  pipeline + SSBO setup, hook into PixiJS's render loop, and re-derive
  selection/dim/highlight uniforms from `boardStore`.
- *Full three.js + WebGPU rewrite:* 6–10 weeks. Re-implement
  `buildBoardScene`, the entire viewport layer, hit-testing, the multi-tab
  Application lifecycle (which currently works around half a dozen PixiJS
  bugs), the BitmapText/MSDF migration, the LoD pipeline, and the
  `SettingsMockup` mirror. Plus maintaining two parsers' worth of unfamiliar
  three.js patterns.

**Three.js maturity:** r171 made WebGPURenderer "production-ready" with
auto WebGL2 fallback and TSL (Three Shader Language) lets you write shaders
once and compile to WGSL/GLSL — useful insurance.
([utsubo: three.js 2026](https://www.utsubo.com/blog/threejs-2026-what-changed),
[three.js docs — WebGPURenderer](https://threejs.org/docs/?q=webgpu#api/en/renderers/WebGPURenderer))
But the docs themselves still call the renderer "experimental" — read
that as: stable enough for a greenfield project, *not* obviously stable
enough to bet a working codebase on.

**Loss of pixi-viewport's polish.** This deserves its own line. The
viewport's behaviour (deceleration curves, pinch handling, the shift-wheel
intercept at `BoardRenderer.installShiftWheelHandler` documented in
CLAUDE.md, snap-on-zoom, follow) is a non-trivial chunk of UX value built
into pixi-viewport. Re-implementing it on a three.js camera is the kind of
work nobody wants to budget for and everyone underestimates.

## 5. Recommendation

**(b) Stay on PixiJS, but enable its WebGPU backend behind a feature flag
this quarter; defer (c) until profiling proves a hot pin/pad layer is
actually GPU-bound.**

Rationale: BoardRipper's perf ceiling is **CPU-side draw-call count and
scene-graph traversal**, not GPU fill rate. Flipping `preference: 'webgpu'`
on PixiJS v8's `Application.init()` (`BoardRenderer.ts:747-755`) is a
half-day experiment that gives us measurably lower per-frame CPU on busy
boards while keeping `pixi-viewport`, BitmapText, the multi-tab
`teardownForReinit` plumbing, and the `Batcher.mjs` workarounds intact —
auto-falling back to WebGL on Linux Firefox or any device without a
WebGPU adapter. A full three.js migration costs 1–2 months, throws away
pixi-viewport, and only pays off if we then go further and rewrite
pins/pads as instanced SDF quads. That second step is worth doing eventually
— it would collapse the grid-of-`Graphics` machinery in `board-scene.ts`
and let us replace `hitGrid` with GPU picking — but it should land as a
custom render pass under the existing PixiJS host (option c, hybrid), not as
a justification for rewriting the rest of the renderer.

## 6. Label blending options (deferred)

Current state: the selected part's name clone fades to 0.55 alpha when pin
numbers become LoD-visible so it doesn't blot out the pins beneath it
(`BoardRenderer.ts`, `updateElevatedLabels`). Workable, but a true
read-under-text effect would be nicer — "dark text on white pins, light
text on dark board, always readable" regardless of what's underneath.

What we tried:

- **`blendMode: 'difference'`** on the clone, with `fill: 0xffffff`. White
  XOR bg gives the inverted-colour effect we want. In PixiJS v8 this is an
  *advanced* blend mode, gated behind `import 'pixi.js/advanced-blend-modes'`
  (side-effect registration). We wired it up; the import was served and the
  extension registered, but the blend never took effect visually.
- **Root cause:** advanced blend modes are implemented in PixiJS v8 as an
  internal filter pass (see `pixi.js/lib/rendering/renderers/shared/blendModes/BlendModePipe.mjs`
  — `_beginAdvancedBlendMode` calls `pushFilter` with a `BlendModeFilter`).
  Our clone lives in `netLabelLayer`, which is attached to `selectionLabelLayer`
  (a `RenderLayer`). The `RenderLayer` docs explicitly say: *"Filters on
  ancestor containers do not apply to children attached to a RenderLayer."*
  Since the blend machinery IS a filter under the hood, the filter gets
  stripped during render-layer collection and the clone renders as plain
  white. Ref: `scene/layers/RenderLayer.mjs:collectRenderables`.

Options when we come back to this:

1. **Move the clone out of the RenderLayer.** Keep it as a direct child of
   `scene.root` with a high zIndex, or put it in a new Container that's a
   direct sibling of `netLinesGfx` in the viewport. We still want it
   rendered above net lines, which is why we put it in the RenderLayer in
   the first place — so this needs its own z-ordering plan (probably:
   split selection labels out of `selectionLabelLayer` into a non-layer
   Container rendered after net lines, at the cost of losing the nice
   "single point of ordering" abstraction).
2. **Custom shader for text colour from backdrop.** Write a small WGSL/GLSL
   Filter that samples the framebuffer under each glyph fragment and emits
   `1 − backdrop.rgb` (or a perceptual-contrast rule). Attach it directly
   to the clone. Sidesteps the RenderLayer/advanced-blend-mode coupling
   because it's an ordinary user-level Filter (those DO work per-object
   even in v8; the stripped ones are specifically the implicit advanced-
   blend filters that PixiJS wraps inside push/pop instructions).
3. **Baked dark halo / outline.** Instead of blending with the backdrop,
   lean harder on `ensureShadowFont`'s baked shadow (make the halo wider,
   more opaque) so the label reads against any background purely from the
   baked atlas. No blend-mode plumbing at all. Cheapest; slightly chunky
   look.

Priority: **low** — alpha fade is shipping. Revisit after stable alpha and
alongside the WebGPU flag flip and the pin/pad instanced-SDF rewrite in §5,
because (1) and (2) both get easier if we're already touching the label
pipeline or writing our own render pass. On WebGPU specifically, option (2)
becomes trivial: the compute/fragment shader has direct access to the
framebuffer sample and the whole "advanced blend mode needs a filter pass"
dance goes away.
