# KiCad Board File Format (`.kicad_pcb`)

> KiCad's native board database. Unlike every other format BoardRipper
> supports, this one is fully documented and openly specified — see
> [KiCad's S-expression PCB file format reference](https://dev-docs.kicad.org/en/file-formats/sexpr-pcb/).
> This document records the subset BoardRipper's `kicad-parser.ts` reads,
> what it deliberately skips, and the two placement conventions that are easy
> to get backwards.
>
> The parser is an original implementation written from that public
> documentation and validated against the fixtures listed below. No code is
> derived from KiCad itself (unlike the Allegro and Altium parsers, which are
> transliterations — see [THIRD_PARTY.md](../../THIRD_PARTY.md)).

---

## Outline contours

A board outline is normally **several closed contours** — the perimeter plus every
slot, milled window and castellation — all drawn on `Edge.Cuts` and stored in
arbitrary order and direction. The parser chains them by nearest endpoint with a
**5 mil break threshold**: when the nearest unused segment is farther than that,
the contour has ended, a `NaN` pen-up sentinel is emitted and the next contour
starts. `drawOutline` already splits sub-paths on `NaN`.

Without the threshold every contour is welded to the next by a false edge leaping
across the board (reported as "vertex 114 is next to 152").

The threshold is chosen on the join error, not on the distance between output
points — output gaps are segment *lengths*, and a long real edge is
indistinguishable from a false one. starfish's four 3543 mil steps are the sides
of a 90 mm panel joined by corner arcs, a single unbroken contour. On tomu-fpga,
84 of 88 joins measure under 0.5 mil while the genuine contour boundaries are
27.8-131 mil, so 5 mil sits in a wide empty band and also absorbs any endpoint
drift from arc tessellation.

Result: tomu-fpga yields 2 contours (114 + 40 points) and starfish 1, each
closing on itself to 0.00 mil.


## Overview

A `.kicad_pcb` file is a single S-expression document, plain UTF-8 text, no
compression and no obfuscation. Everything the viewer needs — placements,
copper, connectivity, board outline — is in the clear.

| Property        | Value                                                            |
|-----------------|------------------------------------------------------------------|
| Extension       | `.kicad_pcb` (unshared)                                          |
| Detection       | Document opens with `(kicad_pcb`                                 |
| Encoding        | UTF-8                                                            |
| Coordinate unit | Millimetres → mils via `×1000/25.4`                              |
| Y axis          | **Down** (screen orientation) ⇒ `flipY: false` on the descriptor |
| Angles          | Degrees, CCW **as displayed** ⇒ negative in the raw Y-down frame |
| Origin          | Absolute page coordinates; no offset record to apply             |
| Format ID       | `KICAD`                                                          |

Written by KiCad 4 through 9. The `(version YYYYMMDD)` token records the
schema date and is surfaced as `BoardData.formatVersion`.

---

## Top-level structure

```
(kicad_pcb (version 20221018) (generator pcbnew)
  (general (thickness 1.6))
  (paper "A4")
  (layers
    (0  "F.Cu"      signal)
    (1  "In1.Cu"    signal)
    (31 "B.Cu"      signal)
    (44 "Edge.Cuts" user)
    …)
  (setup …)
  (net 0 "")
  (net 1 "GND")
  (net 2 "+3V3")
  …
  (footprint "lib:name" (layer "F.Cu")
    (at 83.7 141.998 90)
    (attr smd)
    (fp_text reference "C1508" (at 2.5 0) (layer "F.SilkS") hide …)
    (fp_text value "470p" (at -1.2125 0 180) (layer "F.Fab") …)
    (fp_line  (start -0.1 0) (end -0.2 0) (layer "F.SilkS") (width 0.12) …)
    (pad "1" smd roundrect (at -0.8625 0 90) (size 1.075 0.95)
      (layers "F.Cu" "F.Paste" "F.Mask") (roundrect_rratio 0.25)
      (net 63 "Net-(C1508-Pad1)") (pintype "passive") …))
  …
  (gr_line (start 47.7 55.6105) (end 137.7 55.6105) (layer "Edge.Cuts") (width 0.5) …)
  (gr_arc  (start 137.7 55.6105) (mid 141.235534 57.074966) (end 142.7 60.6105)
           (layer "Edge.Cuts") (width 0.5) …)
  (segment (start 17.45 19.2) (end 18.225 18.425) (width 0.1524) (layer "F.Cu") (net 1) …)
  (arc     (start …) (mid …) (end …) (width 0.2) (layer "F.Cu") (net 3) …)
  (via micro (at 23.65 18.575) (size 0.2) (drill 0.1) (layers "F.Cu" "In1.Cu") (net 1) …)
  (zone …))
```

Token order inside a list is not guaranteed beyond the leading positional
atoms, so the parser addresses every optional field by keyword lookup
(`child(node, 'size')`) rather than by index.

---

## Tokenizer

`parseSExpr()` in `kicad-parser.ts` is a self-contained ~70-line scanner with
no dependencies, usable in both Node (tests) and the browser (worker):

- Iterative with an explicit stack — a pathological nesting depth cannot blow
  the JS stack.
- Works on char codes and `slice()` rather than regexes; a 4.7 MB board is
  roughly 2 M tokens and parses in ~300 ms.
- Quoted strings are unescaped (`\"`, `\\`, `\n`, `\t`, `\r`) and are **not**
  distinguished from bare atoms in the output. That single decision is what
  lets the same downstream code read both the modern quoted spelling
  (`(layer "F.Cu")`) and the legacy bare one (`(layer F.Cu)`).
- Unbalanced parentheses are tolerated rather than thrown on, so a truncated
  file still yields everything that parsed. Structural validation is a single
  check for a `(kicad_pcb …)` root.

---

## Coordinates, rotation, and sides

### Units

Every stored coordinate is millimetres. The parser multiplies by
`1000 / 25.4` (39.370078…) exactly once, at the point each value is read.

### Y axis

KiCad's Y grows **downward**, which is already BoardRipper's un-flipped
screen orientation. `KiCadPcbFormat.flipY` is therefore left `false` and no
axis transformation is applied — unlike GenCAD/Allegro/XZZ/TVW, which all
store Y-up and set `flipY: true`.

### Footprint rotation

`(at X Y ROT)` — `ROT` is degrees counter-clockwise **as displayed**. Because
the stored frame is Y-down, "CCW on screen" is a *negative* rotation in raw
file coordinates:

```
x' = ox + x·cos θ + y·sin θ
y' = oy − x·sin θ + y·cos θ
```

This was not taken on faith. Both candidate signs were scored against the
fixtures by placing every pad of every non-0°/180° footprint and asking
whether a track endpoint at that exact position carries that pad's net id
(a position-only test can't tell the two apart, because on a symmetric 2-pin
chip the wrong sign merely swaps pads 1 and 2). Result on `starfish`:
**189/231 for the convention above, 0/231 for the other**; `tomu-fpga`
agrees 12/0.

### Pad placement

A pad's `(at x y [rot])` position is **footprint-local and unrotated** — it
must be run through the footprint transform. Its *angle*, in contrast, is
stored **absolute**, with the footprint rotation already folded in. This is
visible directly in the fixtures: a footprint placed `(at 83.7 141.998 90)`
carries pads written `(at -0.8625 0 90)`. When the angle token is absent the
absolute angle is 0, matching KiCad's own reader.

### Back-side footprints

KiCad stores a flipped footprint with its pad geometry **already mirrored in
footprint-local space**, so no extra mirror is applied on the `B.Cu` path.
Verified the same way as the rotation sign: on `tomu-fpga`'s 50 back-side
footprints, plain placement matches 63 net-checked track endpoints against 3
for a local-X mirror and 22 for a local-Y mirror.

### Angle sign in the output

`Part.angleDeg`, `Pin.padAngleDeg` and `Pad.angleDeg` are consumed by the
renderer as plain `(cos θ, sin θ)` axes over the stored coordinates
(`computeRotatedOBB`, `drawPadShape`), so they carry the **raw-frame** angle —
i.e. the negation of the authored KiCad value, normalised to `[0, 360)`. The
as-authored value is preserved separately in `part.meta.angleDeg`, which is
what the Component Info panel shows, so a footprint KiCad calls 90° reads
back as 90°.

---

## What is parsed

### Footprints → `Part`

Both the modern `(footprint …)` and the legacy `(module …)` spellings are
collected; they are structurally identical for everything read here, and the
tokenizer's atom handling already covers the legacy unquoted variants.

| `Part` field  | Source                                                              |
|---------------|---------------------------------------------------------------------|
| `name`        | `(fp_text reference "R1" …)`, or KiCad 8+'s `(property "Reference" "R1" …)`. **Not** the library id — that is the footprint, not the component. Falls back to the library id's short name. |
| `side`        | `(layer "B.Cu")` → `bottom`, anything else → `top`                  |
| `type`        | From the pads: any `thru_hole` → `throughhole`, else any `smd` → `smd`, else `unknown`. KiCad states this per pad, so it is never guessed. |
| `origin`      | `computePartGeometry(pins)` — the centre of the pin-centre AABB, matching every other parser (**not** the footprint's `(at)`, which is often off-centre) |
| `bounds`      | `computePartGeometry(pins)` — AABB of pin centres; the renderer expands it through `pin.padBounds` |
| `angleDeg`    | Footprint `(at)` rotation, converted to the raw board frame          |
| `meta.package`| Library id with the `lib:` prefix stripped                           |
| `meta.value`  | `(fp_text value …)` / `(property "Value" …)`                          |
| `meta.angleDeg` | Footprint rotation **as authored** by KiCad                        |

Footprints with no copper pads (fiducials, mounting-hole-only helpers, pure
annotation footprints, soldermask-relief helpers) are **dropped** and
counted. The renderer derives every part box from pins, so a pin-less part
has nothing to draw and nothing to connect.

### Pads → `Pin` + `Pad`

`(pad "NUM" TYPE SHAPE (at x y [rot]) (size w h) [(drill …)] (layers …) [(net N "NAME")] …)`

- A pad's copper side comes from `(layers …)`: `*.Cu` or any F.Cu+B.Cu
  pairing → `both`; F.Cu → `top`; B.Cu → `bottom`; inner-only → `both`.
- Pads carrying **no copper layer at all** — soldermask-relief and
  paste-stencil apertures that wear the `pad` keyword — are dropped from both
  the pin and the pad output. They are not electrical connection points.
- `np_thru_hole` (unplated mounting holes) become a `Pad` with
  `attached: false` and a `drill`, but **never a `Pin`**: they carry no net.
- `Pin.radius` is the inscribed circle of the pad (`min(w, h) / 2`) so oblong
  and finger pads don't get a circle overflowing their narrow axis.
- `Pin.side` is two-valued, so a through-hole pad takes the side its
  footprint is placed on.
- `(drill D)`, `(drill oval DX DY)` (→ `min`) and `(drill D (offset …))` are
  all read; the offset itself is ignored.

Pad-shape mapping onto BoardRipper's `PadShape` vocabulary:

| KiCad       | `PadShape`  | Notes                                              |
|-------------|-------------|-----------------------------------------------------|
| `circle`    | `round`     |                                                     |
| `rect`      | `rect`      |                                                     |
| `roundrect` | `roundrect` | corner radius = `min(w,h) × roundrect_rratio`        |
| `oval`      | `roundrect` | corner radius = `min(w,h)/2` — a stadium             |
| `trapezoid` | `rect`      | the taper is not representable; the AABB is close    |
| `custom`    | `rect`      | the base `size` box; `(primitives …)` are skipped    |

### Nets

The top-level `(net N "NAME")` table is read into an id → name map. A pad's
own `(net N "NAME")` is preferred when present (hand-edited files can name a
net the table doesn't), with the table as fallback.

KiCad qualifies sheet-local nets with a leading slash (`/SPI_MISO`,
`/Connections/AUX OUT`) while global labels and power symbols stay bare
(`GND`, `+3V3`). Every other BoardRipper format carries bare names and users
search for `SPI_MISO`, so the leading slash is stripped — **but only when
doing so is injective across the whole file**. If a file holds both `GND` and
`/GND`, stripping would merge two genuinely distinct nets, so the file keeps
its verbatim names and a `parserNotes` entry records why.

`Net` objects themselves are built by the shared `buildNets(parts)`, so nets
with no pads never appear.

### Board outline (`Edge.Cuts`)

`gr_line` / `gr_arc` / `gr_circle` / `gr_rect` / `gr_poly` on layer
`Edge.Cuts` are sampled into segments and chained by the shared
`chainSegments()`. The equivalent `fp_*` graphics **inside footprints** are
swept too, transformed by the footprint's placement — board edges are
sometimes drawn inside an edge-connector or board-outline helper footprint.

When a file has no `Edge.Cuts` geometry at all, the outline falls back to
`generateSyntheticOutline(pinPositions)` and a `parserNotes` entry says so.

#### Arcs — no shortest-arc normalisation

KiCad 6+ stores an arc as `(start) (mid) (end)` where **`mid` is a real point
on the arc**, not a sweep angle. That makes the arc unambiguous: the sweep is
whichever direction passes through `mid`, major or minor. `kicadArcPoints()`
computes the circumcentre of the three points, then decides direction by
asking whether `mid` is reached before `end` walking counter-clockwise from
`start`.

There is deliberately **no** "fold a >180° sweep into its complement" step
here. That idiom is the bug tracked as issue #33, which bit both
`xzzArcSweepDeg` and `gencadArcSweepRad` — formats that really do store two
bare angles, where a major arc silently collapsed into its minor complement.
KiCad gives us a third point precisely so the question never arises.

Tessellation is one segment per 15° of sweep, capped at 96. Collinear or
degenerate inputs fall back to a straight chord. A closed arc
(`start == end`) degenerates correctly to a full turn.

The legacy KiCad 4/5 spelling `(start CX CY) (end X Y) (angle A)` — centre,
first endpoint, signed sweep — is also handled, for files old enough to still
use `(module …)`. **No fixture in the corpus exercises it**, so its sweep
sign follows KiCad's documented angle convention rather than measurement.

`gr_circle` / `fp_circle` use `(center)` plus a point on the rim `(end)` and
are sampled as a full 32-segment circle. `gr_rect` corners are transformed
individually, so a rect inside a rotated footprint stays a rotated rectangle
rather than collapsing to an AABB.

### Tracks → `Trace`

Top-level `(segment (start) (end) (width) (layer) (net N))` maps one-to-one.
KiCad 6+ curved tracks `(arc (start) (mid) (end) …)` go through the same
`kicadArcPoints()` sampler and are emitted as consecutive straight traces,
which is the model the renderer uses.

### Vias → `Via`

`(via [micro|blind] (at) (size) (drill) (layers …) (net N))`.
`Via.diameter` is the drill diameter per the type contract, falling back to
`(size)` when no drill is stated. A via spanning the full copper stack-up is
normalised to `layers: []` ("through-hole, all layers"); blind/buried vias
keep their explicit compact layer indices.

### Zones → `Surface` (copper pours)

```
(zone (net 1) (net_name "GND") (layer "F.Cu") (priority 2)
  (connect_pads yes (clearance 0))
  (fill yes (thermal_gap 0.508) (thermal_bridge_width 0.508))
  (polygon (pts (xy …) …))                       ← user-drawn boundary
  (filled_polygon (layer "F.Cu") (pts (xy …) …))  ← computed fill, one per island
  (filled_polygon (layer "F.Cu") (pts (xy …) …)))
```

KiCad stores the **computed** fill, already clipped for clearances, thermal
reliefs and cutouts, so there is no fill algorithm to implement. Each
`(filled_polygon)` island becomes one `Surface`.

Three rules, each of which is a trap if got wrong:

1. **Keepouts are not copper.** A zone carrying a `(keepout …)` child is a
   DRC rule area — it says where copper may *not* go. It is skipped outright,
   and the check runs *before* the unfilled-zone fallback below, because a
   keepout is precisely the kind of zone that has no `(filled_polygon)`.
   `tomu-fpga` contains exactly one, on `B.Cu`, and it is also the only zone
   in either fixture with no computed fill — so a naive "fall back to
   `(polygon)`" would paint one solid plane over the single region defined as
   having no pour.
2. **Never emit both.** When a zone has computed fills, its own `(polygon)`
   boundary is not emitted; doing so would double-draw the pour at its
   un-clipped extent.
3. **The layer comes from the island, not the zone.** A zone may declare
   `(layers F&B.Cu)` or `(layers In1.Cu In2.Cu)` and fill several layers from
   one boundary — and `F&B.Cu` is a layer-*set* shorthand that names no
   single layer. Every `(filled_polygon)` in both fixtures carries its own
   `(layer …)`, which is what the parser reads, falling back to the zone's
   only if absent.

An unfilled non-keepout zone (drawn but never poured) falls back to its
`(polygon)` boundary, expanded across the layers its `(layers …)` names — with
`F&B.Cu` and `*.Cu` resolved as shorthands. That geometry *over-states* the
copper, since no clearance has been subtracted, so it raises a `parserNotes`
entry telling the user to re-run "Fill all zones" and re-export. **No fixture
exercises this path** — after excluding the keepout, both fixtures are fully
filled.

#### Voids — the outline is already faithful, so `voids` stays unset

`Surface.voids` exists, but KiCad hands us no hole list to put in it, so the
parser never populates it. Fills are stored **fractured**
(`SHAPE_POLY_SET::Fracture()`): every cutout — via clearance, thermal relief,
pad keepout — is stitched into the outer boundary by a zero-width slit, so
what the file contains is a set of *self-touching single rings*, not
outer-ring-plus-holes.

This was measured, not assumed. Three independent signatures agree:

| Signature | starfish | tomu-fpga |
|---|---|---|
| Fill rings with a duplicated vertex (slit endpoints) | 11 of 125 | 3 of 30 |
| Duplicated vertices / of those, backtracking edge pairs | 762 / 381 | 16 / 8 |
| Rings winding **clockwise** (i.e. reversed inner rings) | 0 of 125 | 0 of 30 |

Every duplicated vertex belongs to a backtracking pair — the walk goes out
along the slit and straight back — and not one ring is reversed. If holes
were stored as separate rings, the third row would be non-zero.

The decisive check is behavioural rather than structural: **a via on a
different net that reaches the fill's layer must sit in a clearance hole.**
Under the even-odd rule — the rule the renderer's fill relies on, and the
reason fracturing works at all — every such via must therefore test as
*outside* the copper. Of **721 such vias on starfish and 275 on tomu-fpga,
zero test as inside**. (Counting vias that do *not* reach the fill's layer
gives 81 false hits on tomu-fpga, which is correct: a blind via stopping
short of a layer legitimately passes over that layer's copper with no hole.)

So the fractured ring is not a lossy approximation — it is the faithful
representation, and it is also the one the renderer wants. `drawSurface` in
`board-scene.ts` emits a single `moveTo`/`lineTo`/`closePath` sub-path and
fills it; the slit's two coincident edges cancel, and the holes appear for
free. Notably `board-scene` explicitly *refuses* to punch `Surface.voids` at
all (earcut over ground planes with thousands of void rings regressed
first-load badly on NM-G611 without a visible difference), so splitting these
rings back into outer + voids would be work that produces a strictly worse
input for the only consumer.

Cost is modest: starfish's 125 surfaces carry 72,624 vertices and triangulate
in ~70 ms (72,374 triangles — exactly `n − 2` per ring, confirming earcut
digests each self-touching ring as one simple polygon); tomu-fpga's 30
surfaces are 2,462 vertices and ~2 ms.

### Copper stack-up → `layerNames`

Copper entries in the `(layers …)` block (`F.Cu`, `In*.Cu`, `B.Cu`) get a
compact 0-based index in file order — `F.Cu = 0` … `B.Cu = last` — and that
index is what tags each trace and via. `BoardData.layerNames` carries the
names so the renderer can colour tracks per layer and flag layer hops, the
same arrangement the GenCAD parser uses. This is **not** a butterfly layout,
so the descriptor leaves `hasLayers` unset.

---

## What is skipped

| Skipped                                   | Why                                                            |
|-------------------------------------------|-----------------------------------------------------------------|
| Keepout / rule-area zones                 | Not copper — see *Zones* above                                 |
| Zone `(fill)` / `(connect_pads)` settings | Fill *parameters*; the computed result is already in `(filled_polygon)` |
| Silkscreen / fab / courtyard graphics     | `BoardData.silkscreen` is a phase-2 item; the geometry walk already exists, only the layer filter and tagging are missing |
| `(gr_text)`, `(fp_text)` other than reference/value | No text rendering in the board scene            |
| `(dimension …)`                           | Drafting annotation, not board geometry                        |
| `(gr_curve …)` Bézier                     | Rare; would need a separate flattener                          |
| Pad `(primitives …)` on `custom` pads     | The base `size` box is used instead                            |
| Pad `(drill (offset …))`                  | Offset holes render at the pad centre                          |
| `(group)`, `(image)`, `(model)`, `(embedded_files)` | No viewer consumer                                   |
| `(setup)`, `(paper)`, `(title_block)`, `(general)` | No viewer consumer                                    |
| Test points                               | KiCad has no first-class test-point concept, so `nails` is always empty |

---

## Failure modes

| Situation                                      | Behaviour                                        |
|------------------------------------------------|--------------------------------------------------|
| No `(kicad_pcb …)` root                        | Throws `KiCad: file does not contain a (kicad_pcb …) root expression` |
| Root present but no footprint has a copper pad | Throws `KiCad: file parsed but contains no placed footprints with copper pads` |
| Truncated file                                 | Everything that tokenised is kept; the two checks above then decide |

The second case is what the `text.kicad_pcb` and `dimensions.kicad_pcb`
fixtures hit — they are kicanvas *rendering* test files (text and dimension
primitives only, zero pads), not boards. Throwing is correct: BoardRipper's
hit-testing, net highlighting and part selection all key off pins.

---

## Validation fixtures

Public MIT-licensed samples from
[theacodes/kicanvas](https://github.com/theacodes/kicanvas), kept in the
gitignored `samples/kicad/` tree. `src/frontend/tests/kicad-parser.spec.ts`
skips (rather than fails) when they are absent.

| Fixture              | Parts | Pins | Nets | Outline pts | Traces | Vias | Pads | Surfaces |
|----------------------|-------|------|------|-------------|--------|------|------|----------|
| `starfish.kicad_pcb` | 229   | 705  | 165  | 33          | 2197   | 413  | 711  | 125      |
| `tomu-fpga.kicad_pcb`| 52    | 148  | 31   | 153         | 579    | 249  | 148  | 30       |
| `dimensions.kicad_pcb` | —   | —    | —    | —           | —      | —    | —    | —        |
| `text.kicad_pcb`     | —     | —    | —    | —           | —      | —    | —    | —        |

Reconciliation against raw record counts (the parser drops nothing silently):

- `starfish`: 262 `(footprint)` = 229 parts + 33 pad-less; 767 `(pad)` = 711
  emitted + 56 non-copper apertures; 705 pins = 711 pads − 6 `np_thru_hole`.
- `tomu-fpga`: 55 `(footprint)` = 52 parts + 3 pad-less; 222 `(pad)` = 148
  emitted + 74 non-copper; 579 `(segment)` = 579 traces; 249 `(via)` = 249
  vias.
- Zones: `starfish` 62 `(zone)` → 125 `(filled_polygon)` islands → 125
  surfaces, no keepouts. `tomu-fpga` 24 `(zone)` = 23 filled (30 islands) + 1
  keepout skipped → 30 surfaces.

`starfish` also exercises the `(arc)` curved-track path (143 of them, sampled
into the 2197 traces) and the four-arc rounded-rectangle `Edge.Cuts` outline.

---

## Phase 2 candidates

- Silkscreen / fab outlines → `BoardData.silkscreen` + `hasSilkscreen`.
- A fixture with an unfilled (but non-keepout) copper zone, to exercise the
  `(polygon)`-boundary fallback and its layer-shorthand expansion against
  real data.
- `custom` pad `(primitives …)` → `PadShape: 'poly'` via `padPolygon`.
- A fixture that actually exercises the legacy `(module …)` + centre/angle arc
  path, so the one unmeasured convention in this parser can be pinned down.
