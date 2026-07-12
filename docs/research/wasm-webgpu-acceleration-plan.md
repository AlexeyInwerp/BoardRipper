# WASM + WebGPU Acceleration — Benefits Analysis & Implementation Plan

*Written July 2026. Third report in the renderer-performance series; layers on
[threejs-webgpu-vs-pixi.md](./threejs-webgpu-vs-pixi.md) (April 2026 — WebGPU
backend flag, shipped) and
[pin-label-rendering-optimizations.md](./pin-label-rendering-optimizations.md)
(CullerPlugin, shipped). Codebase state surveyed at v0.31.35:
`BoardRenderer.ts` 5,620 lines, `board-scene.ts` 2,058 lines, pixi.js ^8.17,
Electron 35 / Chromium 134.*

---

## 0. TL;DR

**The framing "GPU-accelerated rendering using WASM" needs one correction up
front: WASM does not touch the GPU.** WASM is a CPU accelerator — its role in
a rendering stack is to *feed* the GPU faster (decode, decrypt, build
buffers) and to keep the main thread free. WebGPU is the actual GPU lever.
The two compose but solve different problems, and in BoardRipper today they
map onto **different bottlenecks**:

| Bottleneck (measured/surveyed) | Right tool |
|---|---|
| Scene build: synchronous main-thread, O(pins) tessellation (~140 ms typical, seconds on dense boards) | **Instanced rendering** (works on WebGL2 *and* WebGPU via PixiJS Mesh) |
| ~100k+ BitmapText label nodes — the dominant scene-graph pressure | **Instanced MSDF labels** (also backend-agnostic) |
| First-open parse: hand-written RC6 (FZ) / DES (XZZ) crypto loops, all main-thread | **Web Worker first, WASM kernel second** |
| Per-frame CPU | Already lean — on-demand render, O(1) LoD toggles. **No action needed.** |

The single most important survey finding: **the biggest wins previously filed
under "WebGPU step 2" do not actually require WebGPU.** PixiJS v8's `Mesh` +
instanced geometry + dual `GlProgram`/`GpuProgram` shaders run on both
backends. The plan below is therefore *backend-agnostic instancing first*,
with the WebGPU backend promotion riding along rather than gating anything.

Recommended order: **Phase 0 (measure, days) → Phase 1 (instanced pins/pads,
1–2 wks) → Phase 2 (instanced MSDF labels, 2–3 wks) → Phase 3 (worker parse +
WASM crypto, 1–2 wks) → Phase 4 (WebGPU default promotion, days)**. Each
phase ships independently and is gated on Phase-0 numbers.

---

## 1. Where the time actually goes today (survey results)

### 1.1 Per-frame CPU — already lean, not the target

The ticker (`onTick`, BoardRenderer.ts:567-668) renders **on demand** via a
`needsRender` flag (PixiJS's own render was removed from the ticker at
BoardRenderer.ts:972/1142). LoD is O(font-size-groups), not O(labels)
(`applyLabelVisibility`, BoardRenderer.ts:1599-1649); selection labels are
O(1) (`updateElevatedLabels`, BoardRenderer.ts:3960); the net-line pulse only
runs with an active selection and idle viewport. CullerPlugin
(BoardRenderer.ts:64) prunes off-screen grid cells. In steady state there is
**no per-frame O(parts) or O(pins) iteration**. WebGPU's classic pitch —
lower per-draw-call CPU — has little to bite on here; the scene already
collapses to roughly (grid cells × colors present × 2 sides) draw calls.

### 1.2 Scene build — synchronous, main-thread, O(pins)

`buildBoardScene` (board-scene.ts:628) runs synchronously on the main thread
on every board open, settings change (140 ms-debounced `scheduleRebuild`,
BoardRenderer.ts:3115-3128), theme palette change, fold change, and per-part
override. A full rebuild is quoted at ~140 ms in-code (BoardRenderer.ts:3113)
for a typical board and is worse on dense ones (NM-G611's ground planes,
LA-H271P's 10,791 vias). The cost drivers:

- One CPU-tessellated `.circle()`/`.rect()`/`drawPadShape()` **per pin** into
  batched Graphics (board-scene.ts:1226-1356), per pad (967-996), per via
  (1985-1986), per drill (992-993).
- Per-part geometry work in the same loop: min-pin-spacing scan
  (board-scene.ts:1169-1201), BGA row-map build (1208-1224).
- Up to **~100k+ `BitmapText` instantiations** for pin numbers + net names +
  part labels — the dominant node count and build phase.

The build already has per-phase timers (`tick()`, board-scene.ts:645-653
— outline/surfaces/traces/silkscreen/pads phases reported to
`loadProgressStore`), so Phase 0 profiling hooks largely exist.

### 1.3 Parse pipeline — main-thread crypto, but cache-limited

- **FZ**: hand-written modified RC6 stream cipher, 20 rounds *per byte* over
  the payload (`rc6Decrypt`, fz-parser.ts:91-130), then pako inflate
  (fz-parser.ts:446/465). `DecompressionStream` was evaluated and rejected —
  too strict for converter-mangled streams (comment at fz-parser.ts:432-434).
- **XZZ**: hand-written DES over the **entire file** 8 bytes at a time
  (xzz-parser.ts:7-191, invoked at :557), plus an O(n²) `Math.hypot`
  segment-clustering pass (xzz-parser.ts:206-224).
- **Allegro/TVW**: no crypto — branchy DataView struct-walking and
  cross-reference assembly (~6,000 lines for Allegro). Sample corpus includes
  Allegro binaries up to **380 MB** (`Camp.brd`), 276 MB, 84 MB.
- **Everything is on the main thread.** The only Web Worker in the frontend
  is pdf.js's own. No WASM ships to the browser today (pdfium.wasm is
  backend-only, inside wazero in Go).
- **But:** the IndexedDB cache (`boardripper-cache`, PARSER_VERSION at
  board-cache.ts:43) means parse cost is paid **once per file** (re-paid on
  file change or version bump). This caps the real-world ROI of parser
  acceleration — it improves *first-open* latency only.

---

## 2. What WASM can and cannot buy here

Honest assessment per candidate, ranked:

| Candidate | Frequency paid | Expected speedup | Verdict |
|---|---|---|---|
| **RC6 kernel (FZ)** — fz-parser.ts:91-130 | First open per file | 5–15× on the decrypt step (published WASM crypto benchmarks: AES ~7–14× vs JS) | **Do, if Phase 0 shows > ~500 ms** on real files. ~100 lines of Rust. |
| **DES kernel (XZZ)** — xzz-parser.ts:7-191 | First open per file | 5–10× on decrypt | **Same gate.** ~200 lines of Rust. Whole-file decrypt on multi-MB XZZ is the likeliest real offender. |
| pako inflate → WASM zlib-ng | First open (FZ only) | 1.5–2× | **Skip.** pako is mature; the quirk-tolerance that killed `DecompressionStream` applies to any strict inflater too. |
| Allegro/TVW parser rewrite in WASM | First open per file | ~1.5–3× (branchy pointer-chasing, not math kernels) | **Reject.** 6,000+ lines of working, blind-RE'd TS; rewrite risk dwarfs the win. The 380 MB-file problem is I/O + allocation shape, not instruction throughput. |
| Pin/pad tessellation in WASM (lyon-style) | Every scene build | Moot | **Reject — obviated by Phase 1.** Instanced SDF quads need no tessellation at all; earcut-class JS is already fast (mapbox benchmarks: 1.9 M vertices ≈ 445 ms), and copper-fill deliberately avoids hole-punching tessellation (board-scene.ts:719-730). |
| Hit-testing in WASM | Per pointer-move | Moot | **Reject.** The spatial-hash hit grid (BoardRenderer.ts:4646-4694) is cached and O(cell occupancy) per move. Not a bottleneck. |

**The bigger CPU-side lever is Web Workers, not WASM.** Moving
`parseBoardFile` + `flagMechanicalParts` + `buildNets` +
`detectGhostComponents` off the main thread removes first-open jank
*entirely* regardless of how fast the parser is — the UI stays interactive
while a 380 MB Allegro board parses. WASM kernels then compose naturally
(run inside the worker). This is Phase 3, and the worker half is the
higher-value half.

Two prerequisites already in place: Vite 7 has first-class
`new Worker(new URL(...))` support (pdf.js already uses the pattern,
pdf-store.ts:49-52), and Electron enables `SharedArrayBuffer`
(desktop/main.js:12) — though single-threaded WASM kernels don't need SAB,
so no COOP/COEP header work on the Go server is required.

---

## 3. What WebGPU buys (updated for the current codebase)

### 3.1 Status of the backend flag (step 1 — shipped)

`RENDERER_PREFERENCE` (BoardRenderer.ts:68-71) opts into PixiJS's
`WebGPURenderer` via `localStorage.boardripper.renderer.webgpu='1'`, applied
at both `Application.init()` sites (:960, :1122). No WebGPU-specific code
paths exist beyond the flag. Upstream, PixiJS **still defaults
`autoDetectRenderer` to WebGL and recommends WebGL for production** (their
docs, unchanged since v8.1) — so promoting our default should trail their
signal, not lead it. Known local gap: context-loss handling is
WebGL-only (`webglcontextlost` listeners, BoardRenderer.ts:912-921); the
WebGPU equivalent is `GPUDevice.lost`.

### 3.2 The key insight: instancing is backend-agnostic in PixiJS v8

The April report framed instanced pins/SDF labels as "a custom WebGPU pass."
That's unnecessarily narrow. PixiJS v8's `Mesh` accepts a `Geometry` with
instanced attributes and a `Shader` built from a **`GlProgram` + `GpuProgram`
pair** — one GLSL source, one WGSL source, same pipeline object, running on
whichever backend the Application picked. `RenderContainer` exists as the
escape hatch for fully custom draw code on either backend. Consequences:

- The pin-layer and label-layer rewrites work for **every user immediately**,
  including WebGL-only environments (headless Playwright, old drivers,
  Linux Firefox), instead of being gated on WebGPU adoption.
- WebGPU-only niceties (storage buffers > 64 KB UBOs, compute) are *not
  needed* for the core win: per-instance vertex attributes comfortably hold
  `{x, y, radius, shapeId, colorIdx, flags}` at 100k instances on WebGL2.
- The WebGPU backend then becomes what it should be: a progressively-better
  execution target (lower driver overhead, no context-count cap for
  multi-tab), not a fork in the scene code.

### 3.3 Ranked WebGPU-adjacent wins

1. **Instanced pins/pads/vias/drills (Phase 1).** Replaces per-pin CPU
   tessellation with a Float32Array fill (milliseconds at 100k pins). SDF
   fragment shader selects circle/square/rounded/oblong by `shapeId`. Two
   knock-on wins: **palette changes become a uniform update** — theme/color
   settings changes stop triggering the 140 ms `scheduleRebuild` for the pin
   layer entirely — and pins become resolution-independent (no re-stroke on
   zoom).
2. **Instanced MSDF labels (Phase 2).** One glyph atlas for all sizes, one
   instanced mesh per side instead of ~100k BitmapText Containers. Kills the
   quantized atlas zoo (`board-pin-N` / `board-shadow-N-v3`,
   board-scene.ts:401-469), the global-BitmapFont-never-uninstall footgun,
   and the label share of build time. Shadow/halo becomes a fragment effect
   instead of a second baked atlas family. LoD becomes a per-instance
   size attribute compared against a zoom uniform — the font-size-group
   bucketing machinery (board-scene.ts:1866-1897) collapses.
3. **GPU picking (defer).** The ID-buffer approach is elegant but replaces a
   working, cached, O(1)-per-move CPU hit grid. Revisit only if diagonal/
   rotated-pad hit precision becomes a real complaint. Note GPU readback is
   async (`mapAsync`) — it would make hit-testing a Promise, which touches
   the hover/tooltip contract.
4. **Compute-shader culling (reject).** CullerPlugin is O(grid cells) —
   already effectively free. Same verdict as the April report.
5. **Read-under-text label blending (opportunistic).** The deferred
   `blendMode: 'difference'` item (threejs-webgpu-vs-pixi.md §6) becomes a
   trivial fragment-shader variant once labels are a custom mesh — fold it
   into Phase 2 rather than treating it separately.

---

## 4. Implementation plan

### Phase 0 — Measure (1–2 days) — *gates everything after it*

No code ships. Produce a numbers table checked into this doc:

- **Scene-build phase breakdown** via the existing `tick()` timers
  (board-scene.ts:645) + `buildScene` total (BoardRenderer.ts:2015-2023) on:
  a typical board (`820-02016.bvr`), dense planes (`NM-G611-Intel.tvw`),
  via-heavy (LA-H271P), and the pathological CAD (`FA506QR` 9.1 M-pin
  history case).
- **Parse timing per stage** for the biggest real FZ and XZZ samples
  (wrap `rc6Decrypt`, `desDecrypt`, `inflate` with `performance.now()`
  behind `log.perf`) and one ≥ 84 MB Allegro board.
- **Frame-time histograms** (perf overlay already exists —
  `flushPerfOverlay`, BoardRenderer.ts:1490-1518) at fit / labels-visible /
  deep zoom, WebGL vs WebGPU flag, to quantify what backend promotion alone
  is worth.
- **Decision gates:** Phase 1 proceeds if pads+pins phases dominate build
  (expected); Phase 3's WASM half proceeds only if decrypt > ~500 ms on real
  files; Phase 4 proceeds only if the WebGPU flag shows neutral-or-better
  frame times and no artifacts across Mac/Win + Electron.

### Phase 1 — Instanced pin/pad layer, backend-agnostic (1–2 weeks)

- New `renderer/instanced-pins.ts`: `Geometry` (unit quad + instanced
  attributes `{x, y, size, shapeId, colorIdx, selectFlags}`), `Shader` from
  GLSL + WGSL sources, palette as a small uniform array indexed by
  `colorIdx`.
- `buildBoardScene` gains a build path that emits instance buffers per
  (side, grid cell) — keeping the existing cull/cell granularity — instead
  of Graphics `.circle()` calls. Pin-1 triangles, NC pins, vias, drills are
  additional `shapeId`s in the same buffer.
- **Keep the Graphics path** behind a render-setting
  (`renderSettings.instancedPins`, default on, fallback off) for at least
  one release — it is also the automatic diff base for verification.
- Selection/dim/highlight: reuse the existing pattern (selection overlays
  are separate Gfx today); recolor-on-select becomes a flags-attribute
  update on the touched instances.
- `SettingsMockup` shares `buildBoardScene` — it inherits the path
  automatically; verify the mockup board renders identically.
- **Verification:** Playwright + SwiftShader PNG diffs (per project
  practice) of Graphics-path vs instanced-path renders across the sample
  matrix, both backends; perf HUD before/after; `buildScene` ms logged.
- **Exit criteria:** pads+pins build phases reduced to buffer-fill cost
  (≥ 5× on dense boards), zero visual regressions, theme recolor without
  rebuild.

### Phase 2 — Instanced MSDF labels (2–3 weeks)

- Generate an MSDF atlas for the label charset (digits, A–Z, net-name
  punctuation) at build time via `msdf-bmfont-xml` (build step, checked-in
  atlas) — runtime generation not needed for a fixed charset.
- New instanced glyph mesh: per-instance `{x, y, glyphId, scale, colorIdx,
  tier}`; fragment shader renders MSDF with an optional halo (replaces the
  shadow-atlas family) and, optionally, the backdrop-contrast blend from
  the deferred §6 item.
- LoD: `tier` attribute vs zoom uniform in the vertex shader (emit
  off-screen degenerate for hidden tiers) — replaces font-size groups and
  most of `applyLabelVisibility`.
- **Scope control:** pin-number and pin-net labels first (the ~100k-node
  problem); part labels + selection "elevated" labels stay BitmapText
  initially (they're O(parts)/O(1) and interact with `updateElevatedLabels`).
- Risks: text layout fidelity (kerning/measure vs BitmapText), the 2-pin
  label background wrappers (board-scene.ts:881-894 — bake as an SDF rect
  behind glyphs in-shader), atlas charset coverage for exotic net names
  (fallback: keep BitmapText for out-of-charset labels).
- **Exit criteria:** scene-graph node count on a 100k-pin board drops from
  ~100k+ to O(parts); label build phase ≥ 10×; deep-zoom pan p95 improved;
  PNG-diff parity.

### Phase 3 — Parse off the main thread + WASM crypto kernels (1–2 weeks)

- **3a — Worker (the high-value half, ~1 week):** move
  `parseBoardFile` + `flagMechanicalParts` + `buildNets` +
  `detectGhostComponents` + synthetic-outline generation into a Vite
  module worker. `BoardData` is plain objects/arrays — structured-clone
  friendly; transfer the underlying ArrayBuffers where possible. Main
  thread keeps IndexedDB cache read/write (cache hit skips the worker
  entirely). UI gain: first open of a 380 MB Allegro board no longer
  freezes the tab; the existing `loadProgressStore` messages stream from
  the worker.
- **3b — WASM kernels (gated on Phase 0, ~1 week):** one small Rust crate
  (`rc6_fz` + `des_xzz`, ~300 lines total, MIT/Apache — AGPL-compatible)
  compiled with `wasm-pack`, loaded lazily inside the worker only for
  FZ/XZZ files. TS implementations stay as the fallback (feature-detect +
  parity test). **Parser output is byte-identical (same plaintext), so no
  PARSER_VERSION bump is needed for 3b; 3a doesn't change output either.**
  Add a fixture-based parity test: TS kernel vs WASM kernel over real
  sample files must produce identical buffers.
- **Exit criteria:** main-thread long-task count during first open ≈ 0;
  FZ/XZZ first-open decrypt time ÷ 5 or better; parity tests green.

### Phase 4 — WebGPU backend promotion (days, trailing)

- Promote the localStorage flag to Settings ▸ Rendering (three-state:
  auto / WebGL / WebGPU) with the adapter actually chosen surfaced in the
  Debug panel (`renderer.type` at runtime).
- Add `GPUDevice.lost` handling alongside the existing
  `webglcontextlost` path (BoardRenderer.ts:912-921).
- Electron: verify WebGPU adapter availability in the shipped Electron 35
  build; add `enable-unsafe-webgpu` only if the smoke test needs it. The
  existing GPU-crash retry (desktop/main.js:215-227) already covers the
  failure mode.
- Flip the *default* to `auto → webgpu-first` only when (a) PixiJS upstream
  flips or blesses it, and (b) Phase-0/1 telemetry shows neutral-or-better
  frames with no artifacts. Until then WebGPU stays user-selectable.
- Headless Playwright note: no WebGL *or* WebGPU in default headless
  Chromium — the board-render spec cohort behaves the same; keep
  SwiftShader flags for PNG-proof runs.

---

## 5. Cross-cutting risks & invariants

- **PixiJS lifetime rules still apply on both backends:** never
  `app.destroy()` (batchPool corruption), never `BitmapFont.uninstall()`
  (until Phase 2 removes BitmapText from the hot path entirely — the rule
  stays for the remaining labels).
- **`buildBoardScene` stays the single shared scene builder** — both
  `BoardRenderer` and `SettingsMockup` must get instanced paths for free.
- **AGPL:** Rust WASM deps must be MIT/Apache/BSD (they are, for RC6/DES
  from-scratch implementations — write them clean, don't vendor GPL code).
- **Bundle size:** WASM kernels ~30–60 KB, lazily loaded per format —
  negligible. MSDF atlas PNG ~100–300 KB — acceptable, and it *replaces*
  runtime canvas atlas generation.
- **Dual-shader maintenance:** every Phase 1/2 shader exists as GLSL + WGSL.
  Keep them side-by-side in one file per effect with a parity PNG test, or
  the pair will drift.
- **Cache correctness:** any future parser change that *does* alter output
  still requires the PARSER_VERSION bump (board-cache.ts:43) — Phase 3 as
  specced does not.

## 6. Explicitly rejected (so nobody re-walks them)

- **three.js migration** — re-affirmed rejected (April report §5 rationale
  unchanged; pixi-viewport UX + 6–10 week cost).
- **WASM rewrite of Allegro/TVW parsers** — branchy struct-walking, low
  speedup, high regression risk against blind-RE'd formats.
- **WASM tessellation library (lyon/earcut-wasm)** — obviated by instancing;
  JS earcut-class perf already sufficient for the remaining polygon work.
- **Compute-shader culling** — CullerPlugin is already O(cells).
- **`DecompressionStream` for FZ** — re-affirmed rejected
  (fz-parser.ts:432-434, quirk-tolerant pako required).
- **GPU picking** — deferred, not rejected; only on a real precision
  complaint, and it makes hit-testing async.

## 7. Sources

- [PixiJS — Renderers guide (WebGL default, WebGPU opt-in)](https://pixijs.com/8.x/guides/components/renderers)
- [PixiJS v8.1.0 release — autoDetectRenderer switched back to WebGL](https://github.com/pixijs/pixijs/releases/tag/v8.1.0)
- [PixiJS — Mesh guide (custom geometry/shader, GlProgram + GpuProgram)](https://pixijs.com/8.x/guides/components/scene-objects/mesh)
- [PixiJS — RenderContainer (custom render logic per backend)](https://pixijs.download/release/docs/scene.RenderContainer.html)
- [PixiJS — GpuProgram (WGSL program wrapper)](https://pixijs.download/dev/docs/rendering.GpuProgram.html)
- [WebAssembly and SIMD — Robert Aboukhalil](https://robaboukhalil.medium.com/webassembly-and-simd-7a7daa4f2ecd)
- [Client-side WASM crypto speedups (AES 6.9–13.9× vs JS) — IncaMail case study](https://arxiv.org/pdf/2306.13388)
- [Rust + WebAssembly performance incl. SIMD](https://medium.com/@oemaxwell/rust-webassembly-performance-javascript-vs-wasm-bindgen-vs-raw-wasm-with-simd-687b1dc8127b)
- [mapbox/earcut — JS triangulation benchmarks](https://github.com/mapbox/earcut)
- [nical/lyon — GPU path tessellation in Rust](https://github.com/nical/lyon)
- [Mapbox GL text rendering (instanced SDF glyph architecture)](https://github.com/mapbox/mapbox-gl-native/wiki/Text-Rendering)
- [webgpu-samples — MSDF text rendering](https://deepwiki.com/webgpu/webgpu-samples/6.2-text-rendering-with-msdf)
