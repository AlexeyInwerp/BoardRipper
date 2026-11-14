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

## Open, by impact

1. **Dim the rest when something is lit.** The 2D view has a dim mode; 3D
   has none. Darkening the unlit parts by ~40 % while a net is lit would
   double the contrast of the selection without adding colour.
2. **Part colours match 2D.** Every IC is the same black and every passive
   follows its kind. The user's 2D part-type colour rules could tint the
   bodies (or their tops), so a part found in 2D is the same colour in 3D.
3. **Label clutter at middle zoom.** 0201/0402 names overlap where the
   parts are dense. They need screen-space collision culling (keep the larger
   part's name), drawn on the GPU like the size fade.
4. **Hover feedback.** Only a tooltip today. A thin outline on the body
   under the pointer would show what a click will pick, especially with
   drill-down.
5. **Copper under the mask is barely visible** at middle zoom
   (`#13281b` on `#0a1710`). It needs a "show copper" toggle with stronger
   traces, and the layer stack (phase 4).
6. **Contact shadows.** Shadows are clean now, but small parts still read as
   slightly floating from grazing angles. Screen-space ambient occlusion would
   ground them. It costs a full-screen pass, so it should be on only when the
   camera is still (the view already redraws at full resolution on settle).
7. **Board edge.** The FR4 sides are bright tan; real edges are darker and
   show the copper and mask layers. Cosmetic.
8. **Silkscreen** is drawn only where it is printed art (EAGLE, KiCad).
   Allegro and the boardview formats carry assembly outlines, deliberately not
   drawn. Allegro's real silk layer could be added.

## How to look

`src/frontend/tests/board-3d-perf.spec.ts` covers speed. The screenshots for
this review came from a throwaway spec that opens a board, focuses its largest
BGA, zooms in, and picks a pin. Re-run the same shots after any visual change.
