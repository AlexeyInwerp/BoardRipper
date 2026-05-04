# Mentor Boardstation Neutral File Format

> Reverse-engineered from Mentor Graphics Boardstation/Expedition exports
> shipped with the `.cad` extension by some Samsung / Quanta / Compal / Acer
> notebook board packages. There is no public specification — Mentor
> documents the format only inside the Boardstation archive (see
> [Internet Archive: 1999 Mentor Board Station](https://archive.org/details/1999-mentor-boardstation-da-qsim-accusim-win)
> and [PTC's EIF format reference](https://support.ptc.com/help/creo/ced_modeling/r20.6.0.0/en/ced_modeling/OSDM_Modules/PCB_BoardStationCreate.html)
> for the related `.eif` flavour). This document captures the subset
> BoardRipper parses, derived from real-world samples (Samsung RV415,
> Quanta Brazos / Scala / Jinmao boards).

---

## Overview

Mentor Boardstation can export a board to a plain-text "neutral file"
(typically named `neutral_file` or `<design>.cad`) containing the data
needed by downstream fab/test/assembly tooling. It is **not** GenCAD —
the two formats share an extension by accident. Recognition cues:

- First (commented) line is `# file : <path/to/neutral_file>`.
- A `BOARD <name> OFFSET x:<X> y:<Y> ORIENTATION <rot>` record sits in
  the first ~512 bytes.
- Section banners are `###Section Name`, never `$SECTION` markers.
- Every record is line-oriented and prefix-keyed (`BOARD`, `B_UNITS`,
  `NET`, `N_PIN`, `COMP`, `C_PIN`, `GEOM`, `G_PIN`, `HOLE`, …).

| Property         | Value                                                                |
|------------------|----------------------------------------------------------------------|
| Extension        | `.cad` (shared with GenCAD; BoardRipper differentiates by content)   |
| Detection        | First 512 bytes contain `BOARD ... OFFSET ... ORIENTATION` and `B_UNITS` |
| Encoding         | ASCII / UTF-8                                                        |
| Coordinate unit  | Declared by `B_UNITS` (Inches \| Mils \| Mm) — internally ×1000 → mils |
| Origin           | `BOARD … OFFSET x:<X> y:<Y>` — usually `0.0`                         |
| Orientation      | `BOARD … ORIENTATION <deg>` — usually `0`                            |
| Side encoding    | `1` = top, `2` = bottom (in `COMP` and `C_PIN`)                       |

---

## Top-level structure

```
# file : <path>
# date : <human-readable date>
#
###Panel Added Part Information
# (usually empty for laptop boards)
###Board Information
BOARD <design-name> OFFSET x:<X> y:<Y> ORIENTATION <rot>
B_UNITS <Inches | Mils | Mm>
###Nets Information
NET <netname>
N_PROP …
N_PIN …
N_VIA …
…
###Geometry Information
GEOM <shape-name>
G_PIN …
G_ATTR …
…
###Component Information
COMP <ref> <part-no> <device> <shape> <X> <Y> <layer> <rotation>
C_PROP …
C_PIN …
…
###Hole Information
HOLE <NPTH | PTH> <X> <Y> <diameter> [<plating-extra>]
###Pad Information
PAD VIA <padstack> <Bur | Thru> <drill>
P_SHAPE …
###Board Added Part Information
B_ADDP <name> '<name>' <X> <Y> <rotation> …
```

Section banners (`###<title>`) are advisory — record kinds are
self-identifying, so a parser may scan the whole file in a single pass
without tracking the current section.

### Line continuation

Records longer than ~80 characters wrap. The producing line ends with
` - ` (space, dash, space) and the continuation line begins with leading
whitespace. Joiners must concatenate before tokenising. Observed on
`G_ATTR` lines with long polygon coordinate lists.

---

## `BOARD`

```
BOARD Jinmao14-L_Case2_MainBD_Optimize OFFSET x:0.0 y:0.0 ORIENTATION    0
```

| Field        | Notes                                                  |
|--------------|--------------------------------------------------------|
| `<name>`     | Design name (no embedded whitespace)                   |
| `OFFSET x:`  | World-X offset in `B_UNITS`                            |
| `y:`         | World-Y offset                                         |
| `ORIENTATION`| Whole degrees CCW. `0` is the dominant case in the wild.|

The offset and orientation describe a rigid-body transform from the
file's coordinate space into board coordinates. BoardRipper assumes
`OFFSET 0,0` and `ORIENTATION 0`; deviating files are recorded but the
transform is not applied.

## `B_UNITS`

```
B_UNITS Inches
```

One of `Inches`, `Mils`, `Mm`. BoardRipper converts to internal mils:
`Inches × 1000`, `Mm × 1000/25.4`.

---

## Nets section (`NET / N_PROP / N_PIN / N_VIA`)

```
NET /ADT3_ICM
N_PROP  (NET_TYPE,"DEFAULT_NET_TYPE")
N_PIN R611-2 7.157 5.762 r016x020   1
N_PIN U521-41 6.81285 2.9691 r008x080to   1
N_VIA 7.157 5.723 via10   1   8
```

`NET <name>` opens a record group. Net names are typically prefixed with
`/` for fully-qualified signals (the leading slash is stripped on parse
for consistency with other formats); short power names like `P3.3V` may
appear without it. The literal `$NONE$` marks an unconnected pin and is
folded to the empty net.

| Record  | Tokens                                                                |
|---------|-----------------------------------------------------------------------|
| `N_PROP`| Free-form `(KEY,"VALUE")` triples (e.g. `NET_TYPE`, `pow_ic`)         |
| `N_PIN` | `<RefDes-PinName> <X> <Y> <padstack> <layer-index>`                   |
| `N_VIA` | `<X> <Y> <padstack> <fromLayer> <toLayer>`                            |

Layer indices 1..8 follow the layer-stack order in the `PAD VIA` /
`P_SHAPE` records (e.g. 1 = `L1--TOP`, 8 = `L6--BOT` in a 6-layer
board). N_PIN entries duplicate data carried by `C_PIN`; BoardRipper
prefers `C_PIN` because pins are grouped by their parent component.

---

## Geometry section (`GEOM / G_PIN / G_ATTR`)

```
GEOM b1608
G_PIN 1 -0.0256 0.0 s029x035 Surf
G_PIN 2 0.0256 0.0 s029x035 Surf
G_ATTR 'COMPONENT_PLACEMENT_OUTLINE' '' -0.0501 0.0275 -0.0501 -0.0275 0.0501 -0.0275 0.0501 0.0275
G_ATTR 'COMPONENT_HEIGHT' ''  0.0374 0.0
```

`GEOM <shape>` defines a footprint in shape-local coordinates.

| Record   | Tokens                                                                       |
|----------|------------------------------------------------------------------------------|
| `G_PIN`  | `<num> <x> <y> <padstack> <Surf \| Thru> [drill]`                            |
| `G_ATTR` | `'<NAME>' '<VALUE>' [coords...]` — single-quoted strings + numerics list     |

Common `G_ATTR` names:

- `COMPONENT_PLACEMENT_OUTLINE` — open polyline (`x y x y …`) of the
  component placement outline.
- `COMPONENT_HEIGHT` — Z extent.
- `COMPONENT_LAYOUT_TYPE` — `surface` or `through`.
- `COMPONENT_LAYOUT_SURFACE` — `top`, `bottom`, or `both`.
- `ROUTING_KEEPOUT` — pad-edge keepout polygons (ignored).

A shape's pin coordinates are pre-rotated to its canonical orientation;
component placements rotate the shape into world space via `COMP`'s
`<rotation>`. BoardRipper does **not** need to apply this rotation,
because every `C_PIN` carries an absolute world-space position
(see below).

---

## Components section (`COMP / C_PROP / C_PIN`)

```
COMP B1 3301-001649 bead_core b1608  4.984 7.084 2 270
C_PROP (SUPLECODE,"BLM18PG181SN1") (INSERT_TYPE,"V") (DESC,"BEAD-SMD;180ohm,1608,…")
C_PIN B1-1 4.984 7.1096  8  2 270 s029x035 /SPK5_L_P
C_PIN B1-2 4.984 7.0584  8  2 270 s029x035 /N$55180
```

`COMP` declares a placement. Two field counts are observed:

| Form          | Fields                                                                       | Meaning                                                  |
|---------------|------------------------------------------------------------------------------|----------------------------------------------------------|
| Placed (9)    | `COMP <ref> <part-no> <device> <shape> <X> <Y> <side> <rotation>`           | Real placement                                           |
| BOM-only (5)  | `COMP <ref> <part-no> <device> <shape>`                                     | Unplaced — typically test points logged for BOM tracking |

`<side>`: `1` = top, `2` = bottom. `<rotation>`: whole degrees CCW.

`C_PROP` lines collect free-form `(KEY,"VALUE")` properties. Frequent
keys: `DESC` (BOM description), `SUPLECODE` (supplier part #), `MODEL`,
`SUBSYSID`, `INSERT_TYPE`, `REFLOC`. They are concatenated for component
metadata.

`C_PIN` carries a single pin's world-space placement:

```
C_PIN <ref-pin> <X> <Y> <pin-layer-mask> <pin-side> <rotation> <padstack> <net>
```

| Field             | Notes                                                                    |
|-------------------|--------------------------------------------------------------------------|
| `<ref-pin>`       | `<RefDes>-<PinName>`, e.g. `U521-A14`. Pin name = substring after last `-`. |
| `<X> <Y>`         | Already in world space — no rotation/translation needed.                 |
| `<pin-layer-mask>`| Layer-stack mask (top=1, bottom=8 in 6-cu boards). Redundant with `<pin-side>`. |
| `<pin-side>`      | `1` = top, `2` = bottom. Matches the parent `COMP`'s side for SMD; through-hole pins still take the parent side. |
| `<rotation>`      | Pin pad rotation (CCW degrees). Mirrors the parent `COMP` rotation.      |
| `<padstack>`      | Padstack name keyed in the Pad section.                                  |
| `<net>`           | Net name (with optional leading `/`), or literal `$NONE$` for an unconnected pin. |

Pin side detection: BoardRipper trusts `<pin-side>` directly; it always
matches the parent `COMP` side for the pieces we've seen. (If a future
sample shows mixed-side pads on a single COMP — e.g. an oddball
through-hole exiting on the opposite layer — the per-pin side already
suffices to render correctly.)

---

## Holes section (`HOLE`)

```
HOLE NPTH  7.95322 2.4849 0.043
HOLE PTH   8.26 5.165 0.028 0.0
```

| Field         | Notes                                                |
|---------------|------------------------------------------------------|
| `<plating>`   | `NPTH` (non-plated) or `PTH` (plated)                |
| `<X> <Y>`     | Centre of drill                                      |
| `<diameter>`  | Drill diameter                                       |
| `<extra>`     | Optional plating offset (PTH only); ignored by BoardRipper |

These are typically mounting/tooling/laser-cut features, not pin pads.
BoardRipper drops them on initial parse; if a later need surfaces (e.g.
showing dowel/standoff holes) they'd land in `BoardData.holes` or as
no-net `Nail`s.

---

## Pad section (`PAD VIA / P_SHAPE`)

```
PAD VIA via10 Thru  0.01
P_SHAPE via10 L1--TOP CIRCLE 0.02
P_SHAPE via10 L2--VCC CIRCLE 0.02
…
P_SHAPE via10 L6--BOT CIRCLE 0.02
```

| Record    | Tokens                                                                |
|-----------|-----------------------------------------------------------------------|
| `PAD VIA` | `<padstack> <Bur \| Thru> <drill>` — `Bur` = buried/blind             |
| `P_SHAPE` | `<padstack> <layer-name> <CIRCLE \| RECT \| OBLONG> <dim> [<dim2>]`   |

The `<layer-name>` token uses the form `L<idx>--<NAME>` (e.g. `L1--TOP`,
`L5--GND`, `L6--BOT`). Unnamed/empty inner-layer rows show up as `---`
or `----`. The numeric index (1..N) on the left corresponds to the
layer mask used in `N_PIN`/`N_VIA`/`C_PIN`.

BoardRipper currently does not construct copper pad rectangles from
`P_SHAPE`; pin radii fall back to the renderer default. A follow-up
could populate `Part.pins[].padBounds`/`padShape` from the padstack
table.

---

## Board added parts (`B_ADDP`)

```
B_ADDP guidehole 'guidehole' 2.705 7.413   0   1   1   1
B_ADDP fiducial_top 'fiducial_top' 8.32 7.82  0   1   1   1
B_ADDP sl_lf_main_t 'sl_lf_main_t' 3.18 1.155  0   1   1   1
```

Mechanical / artwork additions: fiducials, guideholes, silkscreen
labels (`sl_*`), AOI marks, missing-hole markers, ICT/FCT logos, and
sub-assembly markers. Carry no electrical role and are skipped.

---

## Coordinate handling (BoardRipper)

1. Parse `B_UNITS`, compute `scale = unitToMils(units)`.
2. Apply per-record: `mils = (raw - boardOffset) × scale`.
3. The format is Y-up like GenCAD; BoardRipper's descriptor sets
   `flipY: true`, so the renderer flips the axis on display.
4. Net names are stripped of a single leading `/` for consistency with
   the other text-format parsers (BVR3, BDV).
5. The literal `$NONE$` net becomes the empty string.

---

## Detection

```ts
detect(header: Uint8Array): boolean {
  const text = decoder.decode(header);
  return /\nBOARD\s+\S+\s+OFFSET\s+x:/i.test(text)
      && /\nB_UNITS\s+/i.test(text);
}
```

The conjunction of `BOARD … OFFSET x:` and `B_UNITS` is unique to
Mentor neutral within the BoardRipper format set. GenCAD's `$HEADER` /
`GENCAD` keywords have no overlap, so the two `.cad` flavours route
correctly.

---

## Known samples

| Sample                                                            | Notes                                               |
|-------------------------------------------------------------------|-----------------------------------------------------|
| Samsung RV415 BA41-01533A / BA41-01534A AMD MP1                   | Quanta Jinmao14-L, 6-layer, 1791 parts, 1771 nets   |
| (other Quanta Brazos/Scala/HP exports — same exporter family)     | Same record layout, occasional `Mm` units           |

Add new samples to `samples/` and reference the canary part list here
when fixing exporter-specific quirks.

---

## Outline (no explicit data, synthesised)

Mentor neutral has **no board-outline section**. The `BOARD … OFFSET …
ORIENTATION` line declares only the file's coordinate transform; the
actual edge polygon is not transmitted. (One Quanta-family quirk — the
file we reversed has 316 tiny `HOLE NPTH` dots at 0.01" diameter
clustered along a 0.16" × 0.7" notch, which look like a milled cutout
toolpath rather than the board edge.)

BoardRipper builds a synthetic outline from the bbox of every parsed
pin, via, and hole point. Mounting/PTH holes are explicitly included
even though they're discarded for everything else, because they often
sit outside pin extents (mounting ears, edge cutouts, card-edge slots)
and dropping them produces an outline that crops the real board.

Recovering true outline geometry would require either a different
Mentor export (the `*.fab` companion file in some Boardstation jobs
carries the milled outline) or a tool-path reconstruction pass over
the small-diameter NPTH cluster.

---

## Provenance

This document and the matching parser
([src/frontend/src/parsers/mentor-neutral-parser.ts](../../src/frontend/src/parsers/mentor-neutral-parser.ts))
are original reverse-engineering work — there is no public Mentor
spec, and no third-party parser was consulted at code level. Provenance
is recorded in [THIRD_PARTY.md](../../THIRD_PARTY.md) under "Mentor
Boardstation Neutral — original RE". The parser inherits BoardRipper's
**AGPL-3.0-or-later** licence; see [LICENSE](../../LICENSE).

---

## Open items

- Apply `BOARD … ORIENTATION` and non-zero `OFFSET` (untested — no sample).
- Build per-pin `padBounds` from `PAD VIA` + `P_SHAPE` (currently the
  renderer falls back to a fixed pin radius).
- Surface mounting holes as visible annotations (today only their
  positions seed the outline bbox).
- Detect SMT vs through-hole inserttype from the `GEOM` shape table and
  surface in `Part.type`. Today every Mentor-parsed `Part` is tagged
  `smd`.
- Reconstruct true board outline from the small-diameter `HOLE NPTH`
  toolpath cluster (Quanta family) when `BOARD ORIENTATION` is `0`.
