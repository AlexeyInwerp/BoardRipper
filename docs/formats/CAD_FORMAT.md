# GenCAD (.cad) File Format Specification

> Based on the GenCAD 1.4 specification and the [OpenBoardView](https://github.com/OpenBoardView/OpenBoardView) source (`GenCADFile.cpp`).

---

## Overview

GenCAD is a plain-text PCB interchange format designed for transferring board data between
CAD/CAM systems. BoardRipper parses the subset needed for boardview rendering.

| Property | Value |
|----------|-------|
| Extension | `.cad` |
| Detection | File starts with `$HEADER` and contains `GENCAD` |
| Encoding | ASCII / UTF-8 |
| Coordinate unit | Defined by `UNITS USER <n>` — typically mils |

---

## File Structure

GenCAD files are organized into named sections delimited by `$SECTION` / `$ENDSECTION` markers:

```
$HEADER
GENCAD 1.4
UNITS USER 1000
$ENDHEADER

$SHAPES
SHAPE QFP48
  PIN 1 PAD1 10 20 TOP 0 NO
  PIN 2 PAD1 30 20 TOP 0 NO
  INSERT SMD
$ENDSHAPES

$COMPONENTS
COMPONENT U1
  PLACE 1500 2000
  LAYER TOP
  ROTATION 90
  SHAPE QFP48
  DEVICE IC1
$ENDCOMPONENTS

$SIGNALS
SIGNAL VCC
  NODE U1 1
  NODE R1 1
SIGNAL GND
  NODE U1 2
$ENDSIGNALS
```

---

## Sections

### $HEADER

```
$HEADER
GENCAD 1.4
UNITS USER 1000
ORIGIN 0 0
$ENDHEADER
```

- `GENCAD <version>` — format identifier and version
- `UNITS USER <n>` — coordinate divisor. `1000` means 1000 units/inch = mils

### $SHAPES (Footprint Definitions)

Defines pin templates for each footprint.

```
SHAPE <name>
  PIN <pin_name> <padstack> <x> <y> <side> <rotation> <mirror>
  INSERT <type>
```

| Field | Description |
|-------|-------------|
| `name` | Footprint/shape name |
| `pin_name` | Pin identifier |
| `padstack` | Pad type reference |
| `x`, `y` | Pin position relative to shape origin |
| `side` | `TOP` or `BOTTOM` |
| `rotation` | Rotation in degrees |
| `mirror` | Mirror flag |
| `INSERT` | `SMD` or `TH` (through-hole) |

### $COMPONENTS (Placements)

```
COMPONENT <refdes>
  PLACE <x> <y>
  LAYER <TOP|BOTTOM>
  ROTATION <degrees>
  SHAPE <shape_name> [<mirror>] [<flip>]
  DEVICE <device_name>
```

| Field | Description |
|-------|-------------|
| `refdes` | Reference designator (e.g., `U1`) |
| `PLACE x y` | Component origin position |
| `LAYER` | `TOP` or `BOTTOM` |
| `ROTATION` | Placement rotation in degrees |
| `SHAPE` | Reference to a $SHAPES definition, plus optional mirror/flip tokens (see below) |
| `DEVICE` | Device type identifier |

#### SHAPE mirror / flip tokens

When the referenced shape is defined in **shape-local** coordinates (pins
relative to the component origin, as Allegro2CAD v0.2 emits), the placement
transform is **mirror → rotate (`ROTATION`) → translate (`PLACE`)**. The
optional 2nd/3rd tokens on the `SHAPE` line carry the mirror:

| Token | Meaning |
|-------|---------|
| `0 0` | No mirror (typical top-side part) |
| `MIRRORY` | Reflect the footprint across the Y axis → **negate local X**, applied before rotation |
| `MIRRORX` | Reflect the footprint across the X axis → **negate local Y**, applied before rotation |
| `FLIP` | Side marker for bottom-mounted parts; redundant with `LAYER BOTTOM`, no extra coordinate transform |

Allegro2CAD v0.2 tags every bottom-side component `SHAPE <name> MIRRORY FLIP`.
**The mirror token must be applied** — dropping it renders all bottom-side
footprints X-flipped about their placement origin (pins on the wrong side;
asymmetric parts shift bodily to the wrong location). World-coordinate
exporters instead bake pins into absolute coords with `PLACE 0 0`,
`ROTATION 0` and `SHAPE <name> 0 0`, so no mirror is needed there.

### $SIGNALS (Net Connectivity)

```
SIGNAL <net_name>
  NODE <component> <pin>
```

- Each `SIGNAL` block names a net
- `NODE` entries list component.pin pairs belonging to that net

### $DEVICES (BOM Info)

```
DEVICE <name>
  ...
```

Currently not parsed — BoardData has no BOM field.

---

## Coordinate System

- `UNITS USER 1000` → 1000 units per inch → coordinates are in mils
- Pin positions in $SHAPES are relative to the shape origin
- Final pin positions = shape pin rotated by component rotation + component PLACE offset

### Rotation

Component rotation is applied to shape-relative pin positions:
```
x' = x·cos(θ) - y·sin(θ) + place_x
y' = x·sin(θ) + y·cos(θ) + place_y
```

---

## Parser Notes

- No explicit board outline in most GenCAD files — generated from pin bounding box with 20-mil margin.
- No test points/nails — the `$TESTPINS` section is not parsed.
- The `flipY` flag is enabled for this format.
- Pin radius defaults to 6 mils.
