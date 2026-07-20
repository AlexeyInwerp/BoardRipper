# Instanced Pins Implementation Plan (Acceleration Phase 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Replace per-pin CPU tessellation (Graphics `.circle()`/`.rect()`/
`drawPadShape()` per pin/pad/via/drill) with GPU-instanced quads + SDF
fragment shading, cutting dense-board scene builds from seconds to
milliseconds and making theme/palette changes a uniform update instead of a
140 ms × N-tabs rebuild.

**Architecture:** Mirror of the Text-fast-mode pattern that shipped in
v0.31.40: `buildBoardScene` gains a gated emit-records-instead-of-construct
path (`s.instancedPins`), a new pure module owns the GPU objects, BoardRenderer
wires lifecycle, and the Graphics path stays the default + SettingsMockup path
until explicit graduation (per project convention: experimental modes ship
opt-in — see feedback memory; textFastMode graduated in ~1 day of hands-on,
same track available here).

**Tech:** PixiJS v8.17 `Mesh` + `Geometry` (instanced attributes) + `Shader`
from a `GlProgram` (GLSL 300 es) / `GpuProgram` (WGSL) pair — runs on BOTH
backends; no WebGPU requirement. References: acceleration plan §3.2/§4
(Phase 1), pixijs.com Mesh guide.

## Global Constraints

- `buildBoardScene()` stays pure — reads only its `s: RenderSettings` param.
- Graphics path byte-identical when `instancedPins === false` (default) —
  the same airtight gating discipline the Task-5 LabelModel review verified.
- Never `app.destroy()`; GPU buffers owned by the new module get explicit
  destroy in scene teardown (follow how sceneCache destroys scenes).
- Dual-shader parity: GLSL + WGSL live side-by-side in one file; a PNG-diff
  spec must pass on BOTH backends (WebGL default + `?webgpu` localStorage
  flag) under SwiftShader.
- All work on branch `feature/instanced-pins`; explicit staging only (user
  WIP may be present in tree); tsc + vitest green per commit.
- Line refs verified 2026-07-20 @ v0.31.41: pin draw sites
  board-scene.ts:1268 (`target.circle`, two-pin), :1356-1377
  (`getGridPinGfx` + circle/rect + `ncGfx`), :1308-1320 (pad shapes),
  :1004-1016 (pads + drills), via draws near :2050. Settings pattern:
  `textFastMode` in render-settings.ts (interface ~:128, defaults ~:498) and
  SettingsPanel Performance & Debug section.

## Schedule

| Days | Work |
|---|---|
| 1 | T1 measurement lock-in (build-phase ms per sample via existing tick() timers, recorded to perf doc) + T2 module skeleton with unit-testable instance-record packing |
| 2–4 | T3 shader pair (SDF circle/square/rounded/oblong/ring/triangle by shapeId) + standalone visual probe page |
| 5–7 | T4 buildBoardScene emit path (pins → NC rings → pin-1 markers → vias → drills), per (side, grid-cell) buffers, palette table |
| 8–9 | T5 BoardRenderer wiring: culling parity (cell granularity preserved), selection/dim recolor via flags attribute, theme recolor = palette uniform update (NO rebuild) |
| 10–11 | T6 parity verification: PNG suite vs Graphics path across the sample matrix, both backends; perf-probe before/after |
| 12 | T7 Settings UI (opt-in experimental toggle), docs, :1234 deploy for hands-on |

## Tasks (summary level — expand per-task briefs at execution time)

### T1: Baseline lock-in
Record per-phase `buildBoardScene` timings (existing `tick()` reporters) for
820-02016.bvr + NM-G611-Intel.tvw with textFastMode ON (labels already
excluded) → table in `docs/research/perf-baseline-2026-07-19.md` under a new
section. These are the numbers T6 must beat (target: pads+pins phases ≥5×).

### T2: `renderer/instanced-pins.ts` — records + packing (pure, TDD)
```ts
export interface PinInstance { x: number; y: number; size: number; size2: number;
  rotation: number; shapeId: ShapeId; colorIdx: number; flags: number; }
export const enum ShapeId { Circle, Square, RoundedRect, Oblong, Ring, Triangle }
export function packInstances(list: PinInstance[]): Float32Array;   // interleaved, stride-checked
export class PinPalette { /* ≤64 colors, index-or-add, toUniformArray() */ }
```
Vitest: packing layout, palette dedup/overflow (>64 → nearest or spill
bucket — decide: spill into second mesh, simplest correct).

### T3: Shader pair + probe
One file exports `createPinShader(palette)`: GLSL vertex (quad corner ×
size + rotation + translate; passes shapeId/colorIdx/flags) + fragment
(SDF per shapeId, AA via fwidth/smoothstep) and the WGSL equivalents.
Standalone probe: a dev-only route or throwaway spec rendering a test grid
of every shape/size/color — screenshot both backends, LOOK at them.
Flags bits: dimmed, selected-glow… v1 keeps flags=0 and lets the EXISTING
overlay Graphics (selectionGfx/netDimGfx) do highlight work on top —
selection parity comes free, recolor-on-select stays out of scope.

### T4: buildBoardScene emit path
Gated on `s.instancedPins`: every site that currently issues pin/NC/via/drill
geometry into Graphics instead pushes a `PinInstance` (same guard shape as
`labelModel && pushLabel(...)` — zero OFF-path allocation). Records grouped
per (side, grid cell) to preserve CullerPlugin granularity; pads-overlay and
copper-drop layers stay Graphics in v1 (complex outlines, low count).
`BoardSceneGraph` gains `pinInstances: … | null` + the palette. Mockup
forces off (`{ ...s, instancedPins: false }`).

### T5: BoardRenderer wiring
Meshes created on scene activation from the records (one mesh per side per
color-page), inserted at the pin layer's z-position; destroyed with the
scene. Theme change with mode ON: update palette uniform + skip the pin
portion of rebuild (rebuild still runs for other layers in v1 — measure; the
full no-rebuild theme path is a follow-up once labels+pins are both
retained). Culling: meshes are per-cell children under the existing culled
cell containers OR one mesh + GPU-side always-draw (measure both; start
with per-cell to reuse CullerPlugin unchanged).

### T6: Parity + perf gates
`tests/instanced-pins.spec.ts` mirroring label-overlay.spec: fixed viewport
PNG set (fit/mid/deep zoom, both sides, NC pins, square-pad override board,
selection active) Graphics vs instanced, both backends; controller LOOKS at
the PNGs. perf-probe + build-phase table after; gates: pads+pins build ≥5×,
no frame-time regression, zero visual diffs beyond AA tolerance.

### T7: Ship opt-in
`instancedPins: boolean` default false, "(experimental)" UI label +
search-index entry, CLAUDE.md bullet, :1234 deploy. Graduation = separate
user decision after hands-on (textFastMode precedent).

## Risks
- **Dual-shader drift** — single-file colocation + both-backend PNG spec.
- **Palette >64 colors** on exotic themes/boards — spill-bucket design in T2.
- **Per-cell mesh count** (50×50 grid worst case) — if mesh-per-cell overhead
  shows up in T5 measurement, fall back to one mesh per side + no culling
  (GPU clips; vertex cost at 100k instances is trivial) — decide on numbers.
- **Pin-radius clamp semantics** (`maxNonOverlapRadius`, pad-inscribed caps,
  NC inset) — all live in build code BEFORE record emission, so they carry
  over verbatim; the T6 PNG suite is the guard.

## Explicitly deferred
Recolor-on-select via flags attribute; MSDF/label interactions (none — labels
are already off-scene); copper pads/drops instancing; full no-rebuild theme
path; WebGPU default flip.
