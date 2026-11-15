# 3D view — visual review

2026-11-14 · reviewed on the M1 Air 820-02016 (XZZ), LA-P161 (Allegro) and Feather
RP2040 (EAGLE), Metal on an M1. Part of [2026-11-14-3d-mode-design.md](2026-11-14-3d-mode-design.md).

## Fixed in this round

| # | Problem seen | Change |
|---|---|---|
| 1 | Selection painted everything red: the part, every part on the net, their lands. Pin, net and part could not be told apart, and names showed through red boxes. | Three levels. The **picked pin** has its land in white, plus a white ring drawn through any body above it. The **net** has every land on it filled red and every part on it outlined red, with no fill. The **selected part** has a yellow outline and a faint fill, and turns see-through when one of its pins is picked. |
| 2 | Board too light for the parts and the lit net to stand out. | Mask `#12261a` → `#0a1710`, slab to match. |
| 3 | No way to see what is under a BGA, QFN or connector. | Large bodies (≥ 12 mm², or ≥ 4 mm² for BGA/QFN/SON/SOIC/connectors) keep their own meshes and materials. They fade from opaque to 22 % as they fill more than half the view, so zooming into a BGA shows its balls' lands and the lit net. |
| 4 | Only whole parts could be picked over a body. | **Drill-down.** A click on the selected part, or on any see-through body, picks the pin under the pointer (BGA ball, QFN pad). A click on a visible terminal near the board picks its pin directly (end caps, gull-wing feet). |
| 5 | BGAs floated 0.27 mm above the board. | Substrate 0.1 mm off the board, standing on collapsed balls. |
| 6 | Header names floated at the pin tips; names on large parts were huge. | Labels sit on the body's top (not on whatever sticks up from it), at most 1.0 mm high and 45 % of the short side. |
| 7 | Laptop CPU and GPU (`ADL-P_BGA_1744P`, `GN22…FCBGA_2088P`) drawn as grey fallback boxes. | BGA from the package name (`BGA`, `FCBGA`…). From pins, a dense ball field (balls × pitch² > 25 % of its area) is a BGA even when it mixes pitches. |
| 8 | Large BGAs drawn as an M1 (lid + memory) on non-Apple boards. | Lid style only at ≥ 2,000 balls at ≤ 0.55 mm pitch; everything else is a moulded box. (Earlier round.) |
| 9 | The board tilted more and more while rotating in circles; the pivot drifted. | Turntable about the pressed point. (Earlier round.) |
| 10 | Second pass: red/white selection still hard to see; the white pin land competed with the white names. | Colours no board has. **Picked pin:** electric cyan, with a cyan ring of constant screen size, so it can be found from any zoom. **Net:** magenta lands, magenta part outlines, and magenta dots of constant size for lands hidden under bodies, on the face the camera sees (skipped above 300 pins, e.g. GND). **Selected part:** violet. Outlines are 2.5–3.5 px screen-space lines instead of 1-px GL lines. |
| 11 | The M1 package looked worse after the see-through change: it faded at a normal inspection distance, and its memory dies stood taller than the lid. | Fade only when the camera is closer than ~2× the part's size. The lid is the highest point again, with a sealant rim; the dies sit lower. |
| 12 | Third pass: the pin ring (26 px, plus a world-space ring) covered neighbouring parts and sat over their names; magenta read as noise; no net lines; nothing to adjust. | **Pin ring** is one 14 px screen-constant ring and nothing else. **Net** defaults to cyan, **pin** to lime, **part** to violet. **Net lines** follow the ribbon's mode (star from the picked pin, chain through one land per part; off by default; skipped on GND), drawn through bodies. **Net names** print on the lands in pale blue and fade in from 7 px of screen height, so they appear only close up. **Dim the rest**: lights at 30 % while a net is lit; the selection is unlit and keeps its colour. **Settings menu** (sliders icon beside the cube): the three colours, part names, net names, dimming, see-through, shadows, marker size, outline width; global, persisted in `boardripper-view3d`. |
| 13 | Fourth pass: text and lands went soft close up (a bitmap glyph atlas and a face texture capped at 8192 px); the board was glossier than solder mask; no hidden-side ghosts. | **Text** is a signed-distance atlas (96 px cells, Felzenszwalb EDT at build, ~100 ms) thresholded in the shader with a `fwidth` band: one pixel soft at every zoom, with a dark halo. **Lands are geometry** (a quad or a 16-gon per pad, one mesh per face, 8 µm off the face), matt gold; the face texture keeps mask, copper and silk. **Board** roughness 0.8 at a quarter of the room light; the slab edge darker; epoxy bodies 0.62. **Ghosts** follow the ribbon's ghost button: the lit net's parts on the face the camera does not see, drawn through the board as a translucent box and outline in the net colour; disco pulses them; ground excluded by the same `isGroundNet` rule as 2D. |

## Code notes from the self-review

- **Draw-call regression from the see-through round, found by re-measuring:** each
  large body was its own mesh with its own cloned materials — 872 draw calls on
  the 6,055-part iMac Pro board (31 before), 47 fps. The see-through parts now
  share one merged mesh per material with a per-vertex `aOpacity` attribute the
  shader multiplies in (`buildFadingParts`); fading a part writes a few floats.
  45 draw calls again. Their materials use alpha-to-coverage, not blending: a
  blended surface defeats the Apple GPU's hidden-surface removal, and these are
  the largest surfaces on the board (3 fps on its own).
- **Labels below their fade-in size collapse in the vertex shader** to a point
  outside the clip volume, so a zoomed-out board rasterises none of the ~150 k
  net-name quads.
- **The "resolution fix" stutter, and where the frame really went (2026-11-15).**
  Switching the canvas's own pixel ratio between moving (1×) and settled (2×)
  reallocated the drawing buffer twice per gesture: 40–70 ms at the first move
  and again at the stop, measured through the real loop (`dragBench`). Rendering
  the moving frames into a 1× target and blitting removed the reallocation but
  gained nothing per frame (51 fps either way), and that pointed at the real
  fixed cost: the canvas was created with `antialias: true`, so every frame
  drawn to it — even a one-quad blit — paid a 4× MSAA resolve of the whole
  window, ~8 ms at 2× on an M1. The canvas now has no multisampling. Moving
  frames go through a 1× 8-bit target with none; the settled frame goes once
  through a full-size 4× target (8-bit, stored sRGB-encoded so the dark board
  does not band; half-float was 30 ms a frame to 8-bit's 21 for the same
  picture). Both are blitted by one quad, which applies the tone mapping and
  the colour-space conversion three only does on the canvas. Result on the M1
  board: a drag runs at 59–60 fps with a 19 ms worst frame, first move 20 ms,
  settle one 21 ms frame; it was 60 fps with 40–70 ms hitches, or 47 fps
  hitch-free at 2× with no dynamic resolution. The second shader set the target
  pass needs is compiled at open (`warmLowPass`); on the first drag it was a
  1.7 s stall.
- **Measuring:** the render loop used to fight `bench(…, 1)` / `fps(…, 1)` over
  the pixel ratio every frame, so the 1× numbers in earlier rounds were taken at
  2× with a resize per frame; `benchPr` now holds the loop off. And the day's
  baseline matters: the 38-part Tomu board measured 53 fps at 2× in this session
  against 59 earlier, so a comparison needs a same-session control. With that
  control, this round is at parity with the last measured one.
- `netLines` had a dangling `else`: the star branch's inner `if` took it, so chain mode drew nothing. Braces now; `selectionStats()` lets the E2E assert segments per mode.
- Marker sprites were a new `CanvasTexture` per selection redraw and were never disposed; they are two module-wide textures now, excluded from `disposeTree`.
- The settings effect runs before `setModel`, so a persisted setting does not rebuild the labels a second time on open.
- `chain-adjacent` in 3D draws like `chain` for the lit net only; the adjacent nets the 2D view lights are not drawn. Noted, not fixed.

## Open, by impact

1. **Part colours match 2D.** Every IC is the same black and every passive
   follows its kind. The user's 2D part-type colour rules could tint the
   bodies (or their tops), so a part found in 2D is the same colour in 3D.
2. **Label clutter at middle zoom.** 0201/0402 names overlap where the
   parts are dense. They need screen-space collision culling (keep the larger
   part's name), drawn on the GPU like the size fade.
3. **Hover feedback.** Only a tooltip today. A thin outline on the body
   under the pointer would show what a click will pick, especially with
   drill-down.
4. **Copper under the mask is barely visible** at middle zoom
   (`#13281b` on `#0a1710`). It needs a "show copper" toggle with stronger
   traces, and the layer stack (phase 4).
5. **Contact shadows.** Shadows are clean now, but small parts still read as
   slightly floating from grazing angles. Screen-space ambient occlusion would
   ground them. It costs a full-screen pass, so it should be on only when the
   camera is still (the view already redraws at full resolution on settle).
6. **Board edge.** The FR4 sides are bright tan; real edges are darker and
   show the copper and mask layers. Cosmetic.
7. **Silkscreen** is drawn only where it is printed art (EAGLE, KiCad).
   Allegro and the boardview formats carry assembly outlines, deliberately not
   drawn. Allegro's real silk layer could be added.

## How to look

`src/frontend/tests/board-3d-perf.spec.ts` covers speed. The screenshots for
this review came from a throwaway spec that opens a board, focuses its largest
BGA, zooms in, and picks a pin. Re-run the same shots after any visual change.
