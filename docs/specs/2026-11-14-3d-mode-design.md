# 3D mode — design and plan

2026-11-14 · status: proposal, mockup for review
Mockups: [2026-11-14-3d-mode-mockup.html](2026-11-14-3d-mode-mockup.html) (models, layer stack, signal looks) and
[2026-11-14-3d-compare-mockup.html](2026-11-14-3d-compare-mockup.html) (a real board rendered over its product photos — see *Validated against photos*)

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
2. **Two-pin geometry**: three measurements, each from the pins or pads —
   **span** (centre to centre), **gap** between the pads' inner edges, and
   **pad width** across the axis — each mapped to an EIA size, then a 2-of-3
   vote. Span alone is 97.9 % right on the corpus but collapses on hand-solder
   footprints, whose pads reach outward (KiCad `*_HandSolder`: 5 %; Adafruit's
   `0603-NO`: 19 %, read as 0805). Gap and width barely change between
   footprint styles. Measured against the package name on 9,881 two-pin parts
   (7 boards: KiCad, Allegro, GenCAD, EAGLE):

   | Board | n | span only | vote |
   |---|---:|---:|---:|
   | tomu-fpga (KiCad) | 24 | 100 | 100 |
   | starfish (KiCad, hand-solder) | 150 | 5.3 | 96.0 |
   | P3HCJ (Allegro) | 1,570 | 100 | 100 |
   | NVIDIA4090 (GenCAD) | 2,856 | 99.8 | 99.8 |
   | LA-P161 (Allegro) | 2,896 | 98.9 | 100 |
   | LA-E331P (Allegro) | 2,353 | 100 | 100 |
   | Feather RP2040 (EAGLE) | 32 | 18.8 | 100 |
   | **all** | 9,881 | 97.9 | **99.9** |

   Thresholds (mil) — span 14/26/43/60/90/150/215/280, gap 4/8.5/21.5/32/50/90,
   width 9/17/31/45/62/85/115. Plain boardviews without pad sizes (BVR, BRD,
   XZZ) fall back to span alone.

   | EIA | span p10–p50–p90 | gap (median) | width (median) |
   |---|---|---:|---:|
   | 0201 | 18 – 19.5 – 23 | 7 | 14 |
   | 0402 | 30 – 32 – 36 | 10–17 | 20–26 |
   | 0603 | 52 – 53 – 55 | 25–31 | 35–39 |
   | 0805 | 63 – 75 – 75 | 31–43 | 49–59 |
   | 1206 | 105 – 105 – 120 | 61–79 | 63–69 |

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

`src/frontend/src/store/package-estimate.ts` (prototype exists) — pure,
`estimatePart(part, { usePackage }) → { family, kind?, size?, L, W, H, cx, cy, rotDeg, p, populated, evidence, why }`,
to be memoised per `BoardData`, no three.js import, so the Info panel, the MCP
`part_info` tool and the legend can use it without 3D. Unit tests plus a corpus
script (the measurement above, kept in `scripts/`) that reports agreement per
format so a threshold change shows its cost.

## Validated against photos

Board: **Adafruit Feather RP2040** (EAGLE, open source, 61 parts, 2 layers) —
chosen because the design files and two clean product photos (top-down and
angled) are public. The board is rendered from `estimatePart` alone, and the
camera is solved from the four mounting holes in each photo (position, aim and
field of view; reprojection error 0.2 px top, 1.1 px angled, of 1200 × 900),
so the render lies exactly on the photo and a wipe compares them part by part.

- **Against the photo, estimating from package names:** 55 of 58 parts match
  (kind, size, place, orientation, look), 3 are close — USB-C (overhang
  offset tuned on this board), JST PH battery connector (housing simplified),
  right-angle switch (body a little tall). None wrong.
- **Pins only** (what BVR/BRD/XZZ allow) agrees with the package names on 56
  of 58. The two misses can't be decided from pins: an unfitted SWD footprint
  (`…_NOCREAM`) is drawn as a SOIC, and the right-angle BOOTSEL switch as an
  upright one. A third difference is the kind of a chip: the red LED's refdes is
  `L`, so pins-only draws an inductor.
- **What the comparison changed:**
  - Span alone sized every Adafruit 0603 as 0805, which led to the span/gap/width vote.
  - A SOT-23 came out turned 20°, because the lone pin skewed the grid angle.
  - A JST PH's signal pads are larger than its tabs, so tabs are now found by pad shape, not by size.
  - EAGLE bitmap silkscreen layers (200/201) do not swap sides when the part is mirrored.
- **Board look:** mask, copper under the mask, ENIG pads, silkscreen
  (including EAGLE's bitmap logos, 24,566 rectangles) are baked into one
  texture per side — one quad, no per-feature geometry. This is the plan for the
  app: the silkscreen texture comes for free from `silkscreen` paths and board
  text.

Reproduce (board files and photos stay local, under `samples/3d-compare/`):

```sh
B=https://raw.githubusercontent.com/adafruit/Adafruit-Feather-RP2040-PCB/main
curl -so samples/3d-compare/rp2040.brd "$B/Adafruit%20Feather%20RP2040.brd"
for i in 04 05 06; do curl -so samples/3d-compare/4884-$i.jpg https://cdn-shop.adafruit.com/1200x900/4884-$i.jpg; done
cd src/frontend && npx vite-node ../../scripts/board-3d-export.ts -- ../../samples/3d-compare/rp2040.brd ../../samples/3d-compare/feather-rp2040.js "Adafruit Feather RP2040"
```

### MacBook Air M1, 820-02016: two plain boardviews against scans of the real board

Apple boards come in every boardview format, so this one tests the case that
matters most: no package names, only pins. Inputs: `820-02016.bvr` (3,075 parts,
pin positions and radii only) and the XZZ `.pcb` rev -07 (2,535 parts, with pad
sizes). Reference: the two board scans in Apple's "Scanning image" PDF, top and
bottom, 6,600 px wide. Select the board at the top of the comparison page
(`?board=m1-bvr` / `m1-xzz`).

- **Placement:** the scans are flat, so the camera is orthographic. The board
  outline from the file is fitted to the board's silhouette on the white
  background (scale, turn, shift, mirror): **99.3 % overlap** for the BVR, top
  and bottom. Drawn onto the scan, the file's mounting holes land on the gold
  rings.
- **The BVR is Y-down** (its format has no `flipY`). On the first try the fit
  only worked mirrored. The export now turns Y-down files Y-up before
  estimating, and the 3D view must apply the format's `flipY` the same way the
  2D renderer does.
- **The XZZ outline is drawn inside the board edge** (about 3 % short in Y).
  Its parts agree with the BVR's to 17 mil (median, 2,509 shared refdes, after
  a 0.13° turn and a 0.9 % scale). So the XZZ is placed through the BVR
  (`board-3d-export.ts --align=`), and two boardviews of one board need that
  alignment step before they can share anything.
- **What renders right** (XZZ, against both scans):
  - every chip field, including the dense 0201 capacitor field under the SoC on the bottom;
  - the polymer caps ("686 16E 042") and the molded inductors ("2R7", "R56", "150");
  - the 3-terminal caps and the RF coax receptacles;
  - the display board-to-board connector, the SMD standoffs and the mounting rings on both sides;
  - the Intel retimers, the NAND and the M1 package — position and size.
- **Fallback boxes:** 11 of 2,535 parts (XZZ) and 27 of 3,075 (BVR) — the
  battery connector, a shielded 49-pin connector, some odd-pin power parts. They
  are in the right place, shown as estimates.
- **Format limit, not a bug:** the BVR has no pad sizes, so its larger
  inductors fall back to chip sizes by span. The XZZ draws them right.
- **Not in any boardview, so not in the render:** shield cans and fences,
  thermal pads, stiffeners, rubber bumpers, laser markings. One NAND sits under
  a shield can in the photo.
- **A style guess, labelled as one:** a very large BGA is drawn as a metal lid
  over the SoC with two memory dies along its long edge — right for Apple
  M-series, a guess elsewhere.
- **Families added for this board, all from geometry:**
  - 3-terminal caps and coax receptacles: four pins in a plus, unequal or equal arms;
  - polymer caps and power inductors: large two-pin C or L, by span;
  - board-to-board connectors: two dominant rows at 0.3–0.55 mm;
  - mounting rings: a single pad ≥ 3.8 mm, drawn on both sides;
  - SMD standoffs: a 2.3–3.8 mm pad named SH/ST;
  - sparse and checkerboard BGAs, oriented by the tighter of two candidate angles.

  Chip sizing on the 7-board corpus is unchanged at 99.9 %.

Reproduce: copy `820-02016.bvr`, the XZZ `.pcb` and the "Scanning image" PDF to
`samples/3d-compare/m1air/`. Extract the two JPEGs from the PDF (they are plain
DCT streams) and downscale them to 3200 px as `top-3200.jpg` / `bottom-3200.jpg`.
Then:

```sh
cd src/frontend
npx vite-node ../../scripts/board-3d-export.ts -- ../../samples/3d-compare/m1air/820-02016.bvr ../../samples/3d-compare/m1air/m1-bvr.js "MacBook Air M1 820-02016 (bvr)"
npx vite-node ../../scripts/board-3d-export.ts -- ../../samples/3d-compare/m1air/820-02016.pcb ../../samples/3d-compare/m1air/m1-pcb.js "MacBook Air M1 820-02016 (pcb)" --align=../../samples/3d-compare/m1air/820-02016.bvr
```

A `file://` page cannot read the scan's pixels, so the silhouette fit is stored
in the page. Over HTTP it refits live.

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

## Layer stack (2026-11-15)

`buildBoard3DModel` carries every trace with its layer (`copper`), the pours
(`pours`, outer ring + holes) and the vias with the layer span they join
(`vias`), plus `layerNames`; a primary-bottom board reads its stack upside
down so layer 0 is always the user's Top face. `Board3DRenderer.buildStack`
runs for a board with two or more layers and copper:

- **Copper per layer**: one `InstancedBufferGeometry` of unit quads per layer;
  the vertex shader builds each segment's rectangle extended by half a width
  at both ends from `aP1`/`aP2`/`aW`, the fragment shader discards outside
  the capsule — round caps and joints for free, 515 k segments on the RTX 4090
  board are one draw per layer. Colour and alpha are uniforms per layer.
- **Pours**: `ShapeGeometry` with holes, merged per layer, drawn at 35 % in
  the layer colour under the traces.
- **Vias**: one `InstancedMesh` of barrels, each scaled to its layer span.
- **Dielectric**: the slab is cut into one extruded slice per layer gap; the
  single slab stays hidden. Outer layers sit 12 µm off the faces, inner ones
  evenly through the thickness.
- **Layers tab**: visibility and colour per layer, the pinned / selected
  layer at full alpha with the rest at 20 % (`setLayerStates`, fed by
  `Board3DView` from the tab's `layerStates`).
- **X-ray** (`xray`): slices at 22 % and faces at 45 %, no depth write.
- **Explode** (`explode` 0–1): every resting height is scaled by `1 + 7·e`;
  the faces, pads, parts (merged per side for this), pick boxes, labels and
  one-sided highlights are tagged with their side and lifted by the top
  face's travel, so what stands on a face rides with it. Net lines between
  the faces stay where they are.
- **Copper layers** (`copperLayers`): the stack's copper and vias can be
  switched off to see the plain mask faces again; the slices stay.

Not done: picking inner copper (the 2D hit test only knows the outer
faces), lighting a net on the stack, a real stackup (every file in the
corpus spaces its layers evenly).

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

## Performance (prototype, measured 2026-11-14)

The prototype is in the app: ribbon cube button → `three3d/Board3DView.tsx`
(lazy chunk) → `Board3DRenderer`. Measured with `tests/board-3d-perf.spec.ts`
(`BR_3D_PERF=1`) on an M1 MacBook through ANGLE/Metal, 1600 × 1000 at 2× pixel
ratio.

| Board | Parts drawn | Triangles before → after | Build before → after | Frame rate during orbit (2× / 1×) |
|---|---:|---:|---:|---:|
| Tomu (KiCad) | 38 | 26 k → 3.4 k | 0.13 → 0.05 s | 59 / 60 fps |
| MacBook Air M1 (XZZ) | 2,368 | 1.52 M → 181 k | 1.96 → 0.41 s | 60 / 60 fps |
| LA-P161 (Allegro) | 3,194 | 1.60 M → 327 k | 1.67 → 0.63 s | 58 / 60 fps |
| NVIDIA 4090 (GenCAD) | 3,238 | 1.91 M → 411 k | 2.48 → 0.93 s | 58 / 60 fps |
| iMac Pro (XZZ) | 6,055 | 3.41 M → 496 k | 3.45 → 0.73 s | 59 / 60 fps |

What each round changed:

1. **Geometry.**
   - Parts are merged per material with their indices kept; the first cut
     de-indexed everything and tripled the vertices.
   - Bodies under 0.6 mm are drawn as plain boxes, since rounded edges cannot
     show at that size. These are the 0201s and 0402s that make up most of a
     laptop board.
   - The shadow map is drawn once per board, not every frame. The light is
     fixed to the board and only the camera moves.

   Result: 8–9× fewer triangles, ~10× fewer vertices, 3–5× faster build.
2. **Pixels.** After round 1 the view is fill-bound: 16 ms a frame at 2× and
   8 ms at 1×, even for the 3.4 k-triangle Tomu. So:
   - it draws at 1× while the camera moves and once at full resolution 180 ms
     after it settles;
   - the board face is a standard material, not a clearcoat one;
   - only the board receives shadows;
   - anisotropic filtering is capped at 4×.

   The worst frame during an orbit drops from 35–85 ms to ~20 ms. That
   headroom is what a tablet GPU (A12Z, 3–4× slower) needs.
3. **CPU.** The estimator's nearest-neighbour search was all-pairs: one second
   for a 3,328-ball GPU. A uniform grid now does it: 1,042 → 52 ms for the
   whole NVIDIA board, 38 ms for the M1 board.

Still open:
- The remaining open time on NVIDIA 4090 is the 2D renderer still building
  its 515 k-trace scene when 3D is switched on, not 3D work.
- The model build (0.4–0.9 s) runs on the main thread; it can move to the
  parse worker.
- Instancing repeated chips would cut memory further, but draw calls are
  already 27–31.

## Voxels instead of geometry?

Reviewed, not recommended for the board itself:

- **Resolution.** A 01005 is 0.4 × 0.2 mm and the board must stay sharp
  zoomed in to a single part. At 0.05 mm voxels the M1 board
  (188 × 46 mm, parts up to 3 mm) is a 3760 × 920 × 92 grid: 318 M cells
  dense, still 10–20 M surface voxels in a sparse octree. That is roughly
  40–80 MB, against ~10 MB for the 181 k-triangle mesh. Voxel edges would also
  staircase at exactly the zoom levels repair work uses.
- **Cost model.** A GPU rasterises 0.2–0.5 M triangles in well under a
  millisecond. Ray-marching a sparse voxel tree costs tens of steps per pixel.
  At 6 M pixels that is 100–400 M steps a frame, and this view is already
  pixel-bound.
- **Content.** Board parts are boxes, cylinders and extrusions, which a few
  triangles describe exactly. Voxels pay off for volumetric or organic data
  (CT scans, sculpting, destruction). Nothing here is volumetric.

Two related ideas do fit, and are worth keeping:
- **Heightfield impostor (far LOD).** Bake each side into a 2.5D height and
  colour texture (about 4096 × 1000) and draw the board as one relief-mapped
  quad. Cost is fixed per pixel whatever the part count, so it suits a
  zoomed-out 6,000-part board on a tablet. Switch to geometry when zoomed in.
- **Layer textures for the stack.** Inner copper as one 2D texture per layer
  on thin slabs, as the face texture is now. 515 k traces become a few
  textures instead of geometry.

## Phases

1. **Estimator** — `package-estimate.ts`, kind/size ladders, tests, corpus
   script; evidence shown in the Info panel (useful before any 3D exists).
2. **2D signal animation** — overlay, distance field, effect setting, reduced
   motion, iPad measurement at 6× throttle.
3. **3D plain** — prototype done 2026-11-14 (see Performance): three.js chunk,
   slab + outline + baked face textures, generated models merged per material,
   picking, shared selection and net highlight, ribbon toggle, camera presets.
   Open: picking through the 2D `hitTest`, touch tuning, model build in a worker.
4. **3D multi-layer** — shipped 2026-11-15 (first cut, see *Layer stack*
   below): stacked copper (instanced capsule quads), pours, via barrels,
   dielectric slices, explode, X-ray, Layers-tab colours / visibility /
   emphasis. Open: picking inner copper, the signal animation on the stack.
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
