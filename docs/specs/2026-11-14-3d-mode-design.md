# 3D mode — design and plan

2026-11-14 · status: proposal, mockup for review
Mockup: [2026-11-14-3d-mode-mockup.html](2026-11-14-3d-mode-mockup.html) (open in a browser; three.js from jsDelivr)

## What it is

A second view of the open board, toggled per tab from the board ribbon. The board
is a slab with its real outline and holes; every part stands on it as a generated
3D model, sized from what the file says. Multi-layer files add copper per layer,
vias as barrels and pours, with an *explode* slider that pulls the layers apart.
A lit net animates: dashes flow outward from the clicked pin, along the copper
and through the vias.

The same signal animation is a separate deliverable for the existing 2D view of
layered boards — it does not wait for 3D.

Not in scope: STEP/VRML import, real 3D models from vendors, solder joints,
silkscreen text in 3D, editing.

## What the files give us

Measured on local samples (two-pin parts, `meta.package`, copper):

| File | Format | Parts | 2-pin | Pad geometry | Package name | Layers | Traces | Vias |
|---|---|---:|---:|---|---|---:|---:|---:|
| tomu-fpga | KiCad | 52 | 31 | yes | yes | 4 | 579 | 249 |
| starfish | KiCad | 229 | 183 | yes | yes | 4 | 2,197 | 413 |
| P3HCJ Rev20 | Allegro | 2,165 | 1,688 | yes | yes | 8 | 40,636 | 6,036 |
| LA-P161PR1B | Allegro | 3,369 | 2,987 | yes | yes | 2 | 39,319 | 11,380 |
| NVIDIA4090 | GenCAD | 3,282 | 3,094 | no | yes | 2 | 515,390 | 13,096 |
| A1862 820-00967 | XZZ | 7,917 | 5,515 | no | no | — | — | — |

Plain boardviews (BVR, BRD, BDV, FZ, XZZ) carry pins with a radius and nothing
else about a part. Heights are present only on TVW and Mentor Neutral
(`meta.heightMils`). Everything else must be estimated, and the estimate must say
so.

## Estimating the parts

Two independent questions, answered separately:

- **Size** — how big is the body. From geometry.
- **Kind** — resistor, MLCC, bead, diode, tantalum, IC… From names.

Each answer carries its evidence: `package` (named by the file), `geometry`
(inferred from pins/pads), `fallback` (body box from the pins, height guessed).
The Info panel and the 3D tooltip show it; an *evidence overlay* colours parts by
it (mockup ▸ Board 3D ▸ Evidence overlay).

### Size ladder

1. **Package name** (`meta.package`): a normaliser pulls the EIA code or package
   family out of names like `C_0402_1005Metric`, `VX_R0402_SMALL`, `CHIP0603R`,
   `CAP_SMD_7343`, `SOT23-5`, `BGA100C80P10X10`. Metric codes (1005, 1608…)
   map to imperial. A table of known families → model parameters.
2. **Two-pin geometry**: pin span (centre to centre) picks the EIA size; pad
   width across the axis separates 1206 from 1210. Measured against the package
   name on 9,859 two-pin parts (6 boards, KiCad/Allegro/GenCAD): **98.1 %
   agree** with thresholds at 14 / 26 / 43 / 60 / 90 / 150 / 215 / 280 mil.
   The misses are one size off (0402↔0603 hand-solder footprints, 0603↔0805).

   | EIA | n | span p10–p50–p90 (mil) | pad along / across (median) |
   |---|---:|---|---|
   | 0201 | 1,360 | 18 – 19.5 – 23 | 13 / 14 |
   | 0402 | 6,427 | 30 – 32 – 36 | 22 / 26 |
   | 0603 | 1,477 | 52 – 53 – 55 | 27 / 39 |
   | 0805 | 534 | 63 – 75 – 75 | 36 / 59 |
   | 1206 | 56 | 105 – 105 – 120 | 44 / 69 |

   Rule of thumb from the same data: span ≈ 0.82·L, pad along ≈ 0.5·L, pad
   across ≈ 1.3·W. The mockup draws its land patterns from these.
3. **Multi-pin pattern** (no package name): classify the pin cloud.
   - full or depopulated 2-D grid, equal pitch → BGA (pitch, rows, cols → body)
   - pins on four sides of a square/rect, pitch 0.4–0.8 mm, ± centre pad → QFN/QFP
     (QFN when the outer pins sit inside the body edge; QFP when beyond)
   - two parallel rows → SOIC (1.27) / TSSOP (0.65) / SSOP (0.5) / DFN
   - 3 pins, 2+1 → SOT-23; 5/6 pins, 3+2 / 3+3 → SOT-23-5/6; 3-4 pins with one
     wide tab → SOT-223 / DPAK
   - 1 pin → test pad, no body
   - one or two long rows at 2.54/2.0/1.27, drilled → header/connector
4. **Fallback**: body = `computePartRenderBounds` (the 2D rule, so 2D and 3D
   agree on the footprint), height from the kind table, translucent with a red
   edge. Never pretend.

Heights: `meta.heightMils` when the file has it, else a table per (kind, size)
— resistors 0.13–0.55 mm, MLCCs 0.2–1.6 mm by size, ICs by family. A
"compress heights" toggle (0.5×) keeps tall electrolytics from hiding the board.

### Kind ladder

Package name (`C_`, `R_`, `L_`, `LED`, `SOD`, `CASE_B`…) → `meta.partType`
(TVW, Mentor) → refdes prefix (R, C, L, FB, D, LED, Q, U, Y/X, J/CN, TP, F) with
the board's own prefix variants (`PR`, `PC`, `PCV`, `RV`, `CV` on Compal;
`CA/CD/CP/RD` on XZZ Apple) → neutral grey chip. The part-type colour rules the
user already configures (`renderSettings` part types) are reused, not duplicated.
XZZ Apple files have parts with no letter prefix (1,499 on the iMac Pro board);
those fall to geometry-only and a neutral body.

### Where it lives

`src/frontend/src/store/package-estimate.ts` — pure,
`(part, board) → { kind, family, size?, L, W, H, rotationDeg, pads?, evidence, why }`,
memoised per `BoardData`, no three.js import, so the Info panel, the MCP
`part_info` tool and the legend can use it without 3D. Unit tests plus a corpus
script (the measurement above, kept in `scripts/`) that reports agreement per
format so a threshold change shows its cost.

## Renderer

- **three.js** (MIT), lazy-loaded with the 3D view: the 2D path pays nothing.
  Expected chunk ~150–180 KB gzipped (to measure). Its own canvas, its own
  WebGL context, mounted in the board panel in place of the Pixi canvas — never
  sharing Pixi's context. Unmount releases the context
  (`renderer.forceContextLoss()`), because browsers cap live contexts (~16) and
  every board tab is already one.
- **`buildBoardScene3D(board, estimates, settings)`** — pure builder like
  `buildBoardScene`, so a settings mockup can use it.
- **Units**: mils on the board plane, real Z in mils (1.6 mm = 63 mil) with a
  Z-exaggeration factor for the explode.
- **Orientation**: board frame as parsed, then the same `flipY`, `primarySide`
  and board-pack transforms the 2D view applies (`deriveBoardView`); Butterfly
  has no meaning in 3D — orbiting replaces it. Top/Bottom/Iso/Edge camera
  presets; the ribbon's rotate buttons turn the board about Z.
- **Draw calls**: one `InstancedMesh` per (model, size) — a 7,900-part board is
  a few dozen draws. Models are generated once per (family, L, W, H) and cached.
  Pads: one instanced box and one instanced disc per layer.
- **Copper at scale**: NVIDIA4090 has 515k trace segments. Per-segment ribbons
  with joint discs (what the mockup does for its 400 segments) would be ~15 M
  vertices — instead, one instanced quad per segment with a capsule SDF in the
  fragment shader (round caps for free), one draw per layer, ~2 M vertices of
  attributes on that board. Pours as triangulated polygons per layer. Vias as
  instanced barrels spanning `Via.layers` (blind/buried honoured).
- **Picking**: a click ray hits the board plane at the clicked layer's Z and
  goes to the existing 2D `hitTest` in board coordinates — one hit rule for both
  views. Raised bodies get a coarse ray–AABB pass first so clicking the top of a
  tall part picks it.
- **State**: selection, lit net, search hits, worklist marks and cross-probing
  all read and write `boardStore` as in 2D. Switching views keeps the selection
  and centres the camera on it.
- **Touch**: orbit with one finger, pan/zoom with two (OrbitControls touch
  map), taps go through the same 12 px tap rule as the 2D renderer.
  `touchPerformanceMode` caps resolution and turns shadows off.

## Plain boardviews (BVR, BRD, BDV, FZ, XZZ)

Slab from the outline (holes punched, same chaining as the 2D outline), pads at
pin positions on both faces, estimated parts on both faces. A lit net lights its
pins and draws thin straight "air wires" between them, flowing from the clicked
pin — there is no copper to animate and the view must not invent any. XZZ packs:
one slab per board in `BoardData.boards`, side by side as in 2D.

## Multi-layer boards (KiCad, Allegro, Altium, EAGLE, TVW, GenCAD, Mentor)

Each copper layer at its stack position (evenly spaced over the board thickness
— no file in our set gives a real stackup), in the layer colours of the Layers
tab, with its traces, pours and pads. Vias are barrels with annular rings on each
layer they touch. Controls:

- **Explode** 0–1: layers spread apart; parts ride on the outer layers.
- **X-ray**: board body translucent, inner layers visible without exploding.
- Layer visibility = the Layers tab (one source of truth).
- Pours dim to 30 % so traces on the same layer read over them.

## Signal animation

Applies to the lit net (selected pin's net, `focusNet`, cross-probe).

- **Direction**: a distance field over the net's graph — trace segments
  (length), vias (layer gap), through-hole pins — by Dijkstra from the clicked
  pin, else from the net's first pin. Dashes run away from the source, so the
  animation reads "where does this go". Computed once per (net, source), a few
  ms for a large net.
- **Looks** (mockup ▸ *Signal effect*): Static · Flow dashes · Skewed stripes
  (diagonal, barber-pole, direction-aware) · Comet (one bright head with a tail).
  Plus *Dim others* (a contrast veil on the rest of the board) and *Glow* (a
  wide additive halo). Default proposal: Flow dashes, slow (3 mm/s), dim 0.75,
  glow on.
- **Reduced motion** (`prefers-reduced-motion`) and a setting fall back to
  Static.

### 2D (layered boards, ships first)

A Canvas2D overlay above the Pixi canvas, like `renderer/label-overlay.ts`,
drawing **only the lit net** each frame: dashes as parallelograms along each
segment (direction-aware, skew = 0 or ~1× the trace width), glow as a wider
low-alpha stroke under them, vias and pins as pulsing rings. The WebGL scene is
not re-rendered for the animation — that is the rule from the 2026-09-23 iPad
stall (a full render on a 39k-trace board is ~35 ms on a desktop, hundreds on an
A12Z). The overlay redraws at most 30 fps, stops when the panel is hidden or
paused, and goes static if a frame exceeds its budget. Dash length in screen
pixels by default so the rhythm is the same at every zoom (mockup ▸ Signal 2D ▸
Dash length compares both).

### 3D

The same parameters drive a shader on the trace instances: per-vertex distance,
side and width, active net id as a uniform — no geometry rebuild when the lit net
changes, only when its source pin does.

## Performance budget

| Board | Parts | Segments | Target |
|---|---:|---:|---|
| P3HCJ (Allegro, 8 layers) | 2,165 | 40,636 | 60 fps orbit on an M1, 30 on A12Z |
| NVIDIA4090 (GenCAD) | 3,282 | 515,390 | 60 fps M1; on A12Z build traces per layer on demand |
| A1862 (XZZ, plain) | 7,917 | 0 | 60 fps both |

Scene build off the main thread where possible (estimates and instance buffers
in the parse worker), with the existing background-load banner during the
build. Shadows are one directional light, off in touch performance mode.

## Phases

1. **Estimator** — `package-estimate.ts`, kind/size ladders, tests, corpus
   script; evidence shown in the Info panel (useful before any 3D exists).
2. **2D signal animation** — overlay, distance field, effect setting, reduced
   motion, iPad measurement at 6× throttle.
3. **3D plain** — three.js chunk, slab + outline, model library, instanced
   parts, picking through `hitTest`, store parity, ribbon toggle, camera presets.
4. **3D multi-layer** — stacked copper (instanced capsules), pours, vias,
   explode, X-ray, Layers tab binding.
5. **3D signal** — shader effects, air wires on plain boards.
6. **Polish** — touch, iPad performance, PNG export (slide mode), settings,
   E2E (public KiCad samples: model counts per family, pick parity with 2D,
   explode keeps picking right).

## Open questions

1. Ribbon toggle per tab (proposed) or a separate dockable 3D panel next to the
   2D one?
2. Default signal look: Flow dashes, Skewed or Comet? And should 2D animate by
   default or only on request?
3. Air wires on plain boardviews: wanted, or pins only?
4. Height exaggeration: real heights, or compressed by default so a 10 mm
   electrolytic doesn't hide a quarter of a laptop board?
5. Should the evidence ("sized from pin span") appear in the 2D Info panel from
   phase 1?
