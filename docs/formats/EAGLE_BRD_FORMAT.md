# EAGLE `.brd` Board Format (XML, EAGLE 6.0+)

> Autodesk (formerly CadSoft) EAGLE board files. From **EAGLE 6.0 (2011)**
> onward the `.brd` container is plain XML, described by the `eagle.dtd`
> that ships with every EAGLE/Fusion install and is reproduced in the
> "EAGLE File Format" appendix of the manual. This document captures the
> subset BoardRipper reads, verified against four EAGLE 6.3/6.4 boards.
>
> Pre-6.0 EAGLE wrote a **proprietary binary** `.brd`. It is out of scope:
> BoardRipper detects that the file is not XML and asks the user to re-save
> it from EAGLE 6 or newer.

---

## Overview

| Property         | Value                                                                        |
|------------------|------------------------------------------------------------------------------|
| Extension        | `.brd` — **shared** with Apple/Mac BRD and Cadence Allegro (see [Detection](#detection)) |
| Detection        | `<?xml` / `<!DOCTYPE eagle` / `<eagle …>` in the first 512 bytes             |
| Encoding         | UTF-8 XML (`<?xml version="1.0" encoding="utf-8"?>`)                        |
| Coordinate unit  | **Millimetres, always** — independent of the editor's grid unit             |
| Y axis           | Up (`flipY: true` in the format descriptor)                                 |
| Origin           | Design origin; boards commonly sit in the +X/+Y quadrant                     |
| Side encoding    | Layer `1` = top, `16` = bottom; an `M` in an element's `rot` flips the part  |
| Parser           | [`src/frontend/src/parsers/eagle-parser.ts`](../../src/frontend/src/parsers/eagle-parser.ts) |
| Descriptor       | [`src/frontend/src/parsers/eagle-format.ts`](../../src/frontend/src/parsers/eagle-format.ts) |
| Format id        | `EAGLE_BRD`                                                                  |

### What makes this format different: indirection

Every other boardview format BoardRipper reads stores a pin's position
directly. EAGLE does not. A `.brd` carries three cross-referencing tables and
the pin geometry only exists once you join them:

```
<libraries>                        footprint geometry, in PACKAGE-LOCAL mm
  <library name="fcd">
    <packages>
      <package name="RESC1005">
        <smd name="1" x="-0.48" y="0" dx="0.62" dy="0.57" layer="1" rot="R90"/>
        <pad name="A" x="-1.27" y="0" drill="0.8128" shape="octagon"/>
        <wire x1=… y1=… x2=… y2=… layer="20" curve="90"/>

<elements>                         placements referencing a package by NAME
  <element name="R56" library="fcd" package="RESC1005"
           value="" x="71.755" y="16.51" smashed="yes" rot="MR180"/>

<signals>                          nets, joined by (element, pad) NAME
  <signal name="GND">
    <contactref element="R56" pad="1"/>
    <wire x1=… y1=… x2=… y2=… width="0.2" layer="1"/>
    <via x=… y=… extent="1-16" drill="0.381"/>
```

so

```
pin position = package pad (x, y)  →  element transform  →  board coords
pin net      = netByContact[(element.name, pad.name)]     (never a coordinate)
```

---

## Document structure

```
<eagle version="6.4">
  <drawing>
    <settings/> <grid/>
    <layers>            <layer number name color …/>            (layer table)
    <board>
      <plain>           board-level graphics: wire / text / circle / rectangle
      <libraries>       <library><packages><package>…           (footprints)
      <attributes> <variantdefs> <classes> <designrules>
      <autorouter>
      <elements>        <element …>                            (placements)
      <signals>         <signal><contactref|wire|via|polygon>   (nets + copper)
      <errors>
```

A schematic (`.sch`) or library (`.lbr`) uses the same envelope with a
`<schematic>` / `<library>` child instead of `<board>`; the parser reports that
explicitly rather than producing an empty board.

---

## Units

**EAGLE XML coordinates are millimetres**, no exceptions. The `<grid unit=…>`
setting only controls the editor's display and never the stored numbers.
BoardRipper converts once, in `mm()`:

```
mils = mm × 1000 / 25.4      (≈ × 39.3701)
```

Design-rule values are the one place a unit *suffix* appears
(`"10mil"`, `"0.25mm"`, `"0.01inch"`); `ruleMm()` normalises those.

---

## The element transform (the crux)

```
<element name="R56" package="RESC1005" x="71.755" y="16.51" rot="MR180"/>
```

`rot` follows the grammar `[S][M]R<degrees>`:

| Token | Meaning                                                                |
|-------|------------------------------------------------------------------------|
| `R<a>`| Rotation, **degrees CCW**. Boards use multiples of 90; the grammar allows any angle. |
| `M`   | Mirror across the element's local **Y** axis (x → −x). The part is on the **bottom** side. |
| `S`   | "Spin" — text-readability flag only. Ignored for geometry.             |

The composite applied to a package-local point `p` is

```
p' = R(a) · M · p + t          M = diag(−1, 1),  t = (element.x, element.y)
```

i.e. **mirror first, then rotate CCW, then translate**. This matches KiCad's
EAGLE importer, which writes the same composite the other way round ("flip
about X, then set orientation to a + 180") — algebraically identical, since
`R(a+180)·diag(1,−1) = R(a)·diag(−1,1)`.

Consequences the parser relies on:

- A pad's own `rot` composes as `angle' = a + φ` normally and `a − φ` under a
  mirror (a mirror maps a local direction φ to `a + 180 − φ`, and pads are
  180°-symmetric).
- An `<smd layer="1">` inside a mirrored element lands on layer 16 — the pad
  side is `mirror ? !onTop : onTop`.
- `rot="MR0"` and `rot="MR180"` are **invariant** under the two possible
  mirror/rotate orderings (`R(180)·M = M·R(180) = diag(1,−1)`), so a corpus
  containing only those cannot distinguish them. All four reference boards are
  in that class; the ordering above rests on the documented semantics and the
  KiCad importer, not on the fixtures.

---

## Pads

### `<smd>` — surface mount

```
<smd name="1" x="-0.48" y="0" dx="0.62" dy="0.57" layer="1" rot="R90" roundness="0"/>
```

Rectangle of `dx × dy` centred on `(x, y)`, rotated by `rot` inside the
package. `roundness` is a percentage of the half-short-side; non-zero maps to
`PadShape 'roundrect'`, zero to `'rect'`. `layer` is `1` or `16`.

### `<pad>` — through-hole

```
<pad name="A" x="-1.27" y="0" drill="0.8128" diameter="1.6" shape="octagon" rot="R90"/>
```

| `shape`             | BoardRipper `PadShape` | Geometry                                     |
|---------------------|------------------------|----------------------------------------------|
| `round` *(default)* | `round`                | circle of `diameter`                          |
| `square`            | `rect`                 | `diameter × diameter`                         |
| `octagon`           | `poly`                 | regular octagon, flats at `diameter/2`, emitted as 8 pre-translated vertices |
| `long`              | `roundrect`            | `2·diameter × diameter`, corner radius `diameter/2` |
| `offset`            | `roundrect`            | treated as `long` (the offset is not modelled) |

`diameter` is optional. When absent it is derived from the design rules the
same way EAGLE does:

```
diameter = drill + 2 · clamp(drill · rvPadTop, rlMinPadTop, rlMaxPadTop)
```

with EAGLE's factory defaults (`0.25`, `0.25 mm`, `20 mm`) when the file has
no `<designrules>`.

Through-hole pads produce a `Pad` with `side: 'both'` and a `drill`; SMD pads
get the resolved side. Every pad is also attached to its `Pin`
(`padBounds`/`padShape`/`padWidth`/`padHeight`/`padAngleDeg`/`padPolygon`).

### `Part.type`

EAGLE distinguishes the two pad kinds explicitly, so the part type is real
data rather than a guess: any `<pad>` in the package → `throughhole`,
otherwise any `<smd>` → `smd`, otherwise `unknown` (fiducials, logos,
mounting frames).

---

## Nets

```
<signals>
  <signal name="GND">
    <contactref element="U1" pad="1"/>
    …
```

`<contactref>` joins by **name pair**, never by coordinate. The parser builds
`(element, pad) → net` up front and stamps `Pin.net` during placement, then
runs the shared `buildNets()`. A `<contactref>` naming a pad no placed
footprint provides is counted and reported in `parserNotes`.

A `<signal>` with no `<contactref>` (via-only stitching, unconnected rails)
contributes no net — which is why the epic-cape fixture yields 88 nets from 91
signals.

---

## Traces, vias, copper

- `<signal><wire …>` on a **copper layer (1–16)** becomes a `Trace` carrying
  the signal name. Curved wires are flattened into segments first.
- Copper layers actually used are collected, sorted top→bottom and re-indexed
  0-based into `Trace.layer`; `BoardData.layerNames` carries the names from the
  `<layers>` table so the renderer's per-layer palette has real labels.
- `<signal><via x y drill extent>` becomes a `Via` (diameter = drill, net =
  signal). `extent` is not currently decoded into `Via.layers`.
- `<signal><polygon>` (copper pours) is **not** parsed. This is visible in the
  routing oracle: pins tied to a plane rather than a trace are the only pins
  that do not sit on one of their net's trace endpoints.

---

## Board outline

Layer **20 (Dimension)** carries the board edge. Two places must be searched:

1. `<plain>` — the usual case (`<wire layer="20">`, occasionally `<circle>` /
   `<rectangle>`).
2. **Inside a placed package.** Carrier/shield footprints often own the whole
   board edge; `10004_epic_cape.brd` has *zero* layer-20 geometry in `<plain>`
   and all 13 dimension wires inside the placed `BEAGLEBONE_SHIELD` package.
   Those are transformed by the element transform like any other footprint
   geometry, and a `parserNotes` entry records that this happened.

Wires are flattened, chained end-to-end within 2 mils into as few sub-paths as
possible, and separated by `NaN` points — the sub-path convention
`drawOutline()` already understands. If no layer-20 geometry exists at all, a
synthetic bbox outline is generated from the pins and noted.

### `curve` — a signed sweep, never normalise it

```
<wire x1="86.36" y1="41.91" x2="73.66" y2="54.61" width="0.1016" layer="20" curve="90"/>
```

`curve` is the arc's **signed included angle in degrees, CCW-positive**, in the
open range (−360, 360). It is unambiguous on its own: `curve="270"` is a 270°
arc, not the 90° short way round.

`eagleArcPoints()` consumes it verbatim. It deliberately does **not** fold the
value into a shortest-arc normal form — that idiom is exactly what broke the
XZZ and GenCAD arc paths (issue #33; see `xzzArcSweepDeg` /
`gencadArcSweepRad`), where a sweep had to be *reconstructed* from two endpoint
angles and the reconstruction silently picked the wrong side of the circle.
EAGLE hands us the answer; we use it.

Centre derivation for chord `P1→P2` of length `L` and half-angle `h = θ/2`:

```
R  = L / (2·sin h)                       (signed)
C  = midpoint(P1, P2) − R·cos(h) · w     w = chord direction rotated −90°
```

---

## Silkscreen

Package `<wire>` and `<circle>` on layers **21 (tPlace)** and **22 (bPlace)**
become `SilkscreenPath`s, transformed by the element and tagged with the
mirror-resolved side.

`<rectangle>` on those layers is deliberately **excluded**: it is a *filled*
area, and EAGLE renders raster logos as thousands of ~0.5 mm boxes (2 646 of
them in `10004_epic_cape.brd` alone) — stroking those as outlines turns the
logo into noise.

---

## Detection

`.brd` has three claimants. The sniffs are disjoint by construction:

| Format        | Sniff                                                                  |
|---------------|------------------------------------------------------------------------|
| Apple/Mac BRD | binary magic `23 E2 63 28`, or the ASCII `BRD_V1.0` variant             |
| Allegro BRD   | `uint32 LE` version magic in `0x0012xxxx`–`0x0015xxxx` **and** word at byte 8 == 1 |
| **EAGLE BRD** | `<?xml`, `<!DOCTYPE eagle` or `<eagle …>` within the first 512 bytes    |

An EAGLE file starts with the ASCII `<?xm`, whose `uint32 LE` value is
`0x6D783F3C` — outside every Allegro family window — so no ordering subtlety is
needed. `EagleBRDFormat` is nevertheless registered **after** `AllegroBRDFormat`
in `parsers/index.ts` so that the *extension-only* fallback (used when no
`detect()` matched at all) resolves exactly as it did before this format
existed. `tests/eagle-parser.spec.ts` guards all of the above without needing
any fixture.

---

## Known samples

Fixtures live in the gitignored `samples/eagle/` (EAGLE 6.3/6.4 boards from
the public `enjrolas/eagleAnalyzer` corpus). Parsed counts:

| Sample                              | ver | parts | pins | nets | outline pts | traces | vias |
|-------------------------------------|-----|-------|------|------|-------------|--------|------|
| `10004_epic_cape.brd`               | 6.3 | 99    | 405  | 88   | 65 (1 loop) | 674    | 179  |
| `1-Axis_Board_-_Camera_Gantry.brd`  | 6.4 | 61    | 297  | 63   | 5 (1 loop)  | 89     | 6    |
| `10leds.brd`                        | 6.4 | 21    | 42   | 12   | 5 (1 loop)  | 118    | 1    |
| `180V_power.brd`                    | 6.4 | 22    | 46   | 12   | 5 (1 loop)  | 123    | 0    |

### Routing oracle

EAGLE routes copper to pad **centres**, so on a fully routed board every pin
that has any trace on its own net must sit *exactly* on one of that net's trace
endpoints. That is a far sharper check on the whole placement transform
(rotation direction, mirror composition, mm→mil scale) than any hand-picked
coordinate, and two fixtures satisfy it at 0.000 mil residual across every pin:

| Sample                             | pins on an endpoint | notes                                            |
|------------------------------------|---------------------|--------------------------------------------------|
| `10leds.brd`                       | 42 / 42 (100 %)     | includes `R90`/`R180`/`R270` and 5 `MR0` parts    |
| `180V_power.brd`                   | 46 / 46 (100 %)     | includes `R90`/`R180`/`R270`                      |
| `10004_epic_cape.brd`              | 277 / 312 (88.8 %)  | all 35 misses are GND / VDD_3V3EXP on the shield connector — **plane-connected**, and planes are not parsed |
| `1-Axis_Board_-_Camera_Gantry.brd` | 47 / 80 (58.8 %)    | misses are PVDD/VCC, plus four electrolytics parked *outside* the board outline and unrouted |

The oracle runs as a test for the two fully-routed boards.

---

## Provenance

The parser and this document are original work written against the public
EAGLE DTD and manual appendix, plus the four reference boards. No code was
copied from EAGLE or from any GPL importer; the mirror/rotate ordering was
cross-checked against KiCad's documented behaviour but not transliterated. The
parser inherits BoardRipper's **AGPL-3.0-or-later** licence; see
[LICENSE](../../LICENSE).

---

## Open items

- **Copper pours.** `<signal><polygon>` is skipped, so plane-tied pins have no
  visible connection. `BoardData.surfaces` already exists — filling it needs
  EAGLE's `<polygon>` vertex list (which also uses per-vertex `curve`) and its
  thermal/isolate handling.
- **`<hole>`** (non-plated mounting holes, in `<plain>` and in packages) is not
  surfaced. It has no net and no copper, so it would need a pad-overlay-only
  representation.
- **`<via extent="1-16">`** is not decoded into `Via.layers`; every via is
  emitted as through-hole.
- **`<rectangle>`/`<polygon>` on silkscreen layers** are dropped (see
  [Silkscreen](#silkscreen)). Rendering them would need a filled-area path.
- **EAGLE 7+/9+ `urn` libraries.** When `<library urn=…>` is used and an
  element cites a library the `name` index does not resolve, the parser falls
  back to a package-name-only match and notes it. Untested — no sample.
- **Non-orthogonal placements.** The transform handles arbitrary `R<a>`, but
  every reference board uses multiples of 90°.
- **Pre-6.0 binary `.brd`.** Rejected with an actionable message. It is not
  *detected* as EAGLE (the sniff is XML-only), so a binary EAGLE board that
  reaches the parser does so through the extension fallback.
