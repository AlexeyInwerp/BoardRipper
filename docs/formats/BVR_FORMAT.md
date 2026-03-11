# BVR (Board View Raw) File Format Specification

> Extracted from [OpenBoardView](https://github.com/OpenBoardView/OpenBoardView) source code — the authoritative open-source reference.

## Overview

BVR stands for "BV Raw". The original `.bv` files are Microsoft Access `.mdb` databases with tables `Layout`, `Pin`, `Nail`. The `bvconv.sh` utility exports these into tab-delimited text with a format header.

There are **two major versions**:

| Version | Magic Header | Coordinate Handling |
|---------|-------------|---------------------|
| BVR1 | `BVRAW_FORMAT_1` | Doubles, scaled ×1000 internally |
| BVR3 | `BVRAW_FORMAT_3` | Doubles, truncated to int (already in mils) |

**Coordinate system:** mils (thousandths of an inch). Locale must be `C` (period as decimal separator).

---

## BVRAW_FORMAT_1 (BVR1)

Plain-text, line-oriented, tab-delimited. First line after each section header is a column header (skipped).

### Structure

```
BVRAW_FORMAT_1
<<Layout>>
LOC_X	LOC_Y
x1	y1
x2	y2
...
<<Pin>>
PART_NAME	LOC	PIN_ID	PIN_NAME	LOC_X	LOC_Y	LAYER	NET_NAME
part_name	location	pin_id	pin_name	x	y	layer	net_name
...
<<Nail>>
PROBE	LOC_X	LOC_Y	TYPE	GRID	LOC	NET_ID	NET_NAME
probe	x	y	type	grid	side	net_id	net_name
...
```

### Section: `<<Layout>>` — Board Outline

Polygon vertices defining the PCB outline.

| Field | Type | Description |
|-------|------|-------------|
| x | double | X coordinate (×1000 for mils) |
| y | double | Y coordinate (×1000 for mils) |

### Section: `<<Pin>>` — Parts and Pins

Each line = one pin. Parts are **implicitly defined**: first occurrence of a `part_name` creates the part; subsequent pins with same name belong to it.

| Field | Type | Description |
|-------|------|-------------|
| part_name | string | Component ref designator (e.g. `U1900`, `R5201`) |
| location | string | `(T)` = Top, `(B)` = Bottom |
| pin_id | integer | Pin index (read but unused) |
| pin_name | string | Pin label |
| x | double | Pin X position (×1000) |
| y | double | Pin Y position (×1000) |
| layer | integer | Layer number (read but unused) |
| net_name | string | Net/signal name |

All parts default to `SMD` type.

### Section: `<<Nail>>` — Test Points

| Field | Type | Description |
|-------|------|-------------|
| (field 0) | - | Skipped |
| x | double | Nail X position (×1000) |
| y | double | Nail Y position (×1000) |
| type | integer | Nail type (unused) |
| grid | string | Grid designation (unused) |
| side | string | `(T)` = Top, else Bottom |
| net_id | string | Net identifier (unused) |
| net_name | string | Net/signal name |

### Example BVR1

```
BVRAW_FORMAT_1
<<Layout>>
LOC_X	LOC_Y
0.000	0.000
6800.000	0.000
6800.000	4200.000
0.000	4200.000
<<Pin>>
PART_NAME	LOC	PIN_ID	PIN_NAME	LOC_X	LOC_Y	LAYER	NET_NAME
U1900	(T)	1	A1	1234.567	2345.678	1	PP3V3_S5
U1900	(T)	2	A2	1234.567	2395.678	1	PP5V_S3
R5201	(B)	1	1	500.000	1000.000	2	GND
R5201	(B)	2	2	550.000	1000.000	2	PP1V8_S3
<<Nail>>
PROBE	LOC_X	LOC_Y	TYPE	GRID	LOC	NET_ID	NET_NAME
1	1234.567	2345.678	1	A1	(T)	100	PP3V3_S5
2	500.000	1000.000	2	B3	(B)	200	GND
```

---

## BVRAW_FORMAT_3 (BVR3)

Keyword-value text format. Each line: `KEYWORD value`. More verbose, self-documenting. **Pin coordinates are relative to part origin.**

### Part Block

```
PART_NAME <name>
PART_SIDE <T|B|O>
PART_ORIGIN <x> <y>
PART_MOUNT <SMD|ThroughHole>
PART_OUTLINE_RELATIVE <data>        (optional, unsupported)
  [pin definitions...]
PART_END
```

| Keyword | Type | Description |
|---------|------|-------------|
| PART_NAME | string | Component reference designator |
| PART_SIDE | char | `T` = Top, `B` = Bottom, `O` = Both |
| PART_ORIGIN | double double | Absolute X Y position |
| PART_MOUNT | string | `SMD` or `ThroughHole` |
| PART_END | — | End of part + pins |

### Pin Block (nested inside Part)

```
PIN_ID <id>
PIN_NUMBER <number>
PIN_NAME <name>
PIN_SIDE <T|B|O>
PIN_ORIGIN <x> <y>
PIN_RADIUS <radius>
PIN_NET <net_name>
PIN_TYPE <type>
PIN_COMMENT <comment>
PIN_OUTLINE_RELATIVE <data>
PIN_END
```

| Keyword | Type | Description |
|---------|------|-------------|
| PIN_ID | integer | Pin identifier (ignored) |
| PIN_NUMBER | string | Pin number/designation |
| PIN_NAME | string | Pin label |
| PIN_SIDE | char | `T`/`B`/`O` |
| PIN_ORIGIN | double double | X Y **relative to PART_ORIGIN** |
| PIN_RADIUS | double | Circle radius for display |
| PIN_NET | string | Net/signal name |
| PIN_TYPE | integer | Pin type (ignored) |
| PIN_COMMENT | string | Comment (ignored) |
| PIN_END | — | End of pin |

### Board Outline (two formats, mutually exclusive)

**OUTLINE_POINTS** — sequential polygon:
```
OUTLINE_POINTS x1 y1 x2 y2 x3 y3 ...
```

**OUTLINE_SEGMENTED** — unordered line segments:
```
OUTLINE_SEGMENTED x1 y1 x2 y2 x3 y3 x4 y4 ...
```
Groups of 4 doubles = segment `(x1,y1)→(x2,y2)`. Parser reconstructs polygon by endpoint matching.

### Example BVR3

```
BVRAW_FORMAT_3
OUTLINE_POINTS 0 0 6800000 0 6800000 4200000 0 4200000 0 0
PART_NAME U1900
PART_SIDE T
PART_ORIGIN 1234567 2345678
PART_MOUNT SMD
PIN_ID 1
PIN_NUMBER 1
PIN_NAME A1
PIN_SIDE T
PIN_ORIGIN 0 0
PIN_RADIUS 50
PIN_NET PP3V3_S5
PIN_TYPE 2
PIN_END
PIN_ID 2
PIN_NUMBER 2
PIN_NAME A2
PIN_SIDE T
PIN_ORIGIN 0 50000
PIN_RADIUS 50
PIN_NET PP5V_S3
PIN_TYPE 2
PIN_END
PART_END
```

---

## Version Comparison

| Aspect | BVR1 | BVR3 |
|--------|------|------|
| Delimiter | Tab | Space (keyword-value) |
| Coordinates | Doubles ×1000 | Doubles as-is (mils) |
| Pin coords | Absolute | Relative to PART_ORIGIN |
| Part type | Always SMD | SMD or ThroughHole |
| Nails | Yes | No |
| Outline | Sequential points | OUTLINE_POINTS or OUTLINE_SEGMENTED |
| Part boundaries | Implicit (name change) | Explicit PART_END |
| Pin boundaries | Implicit (one per line) | Explicit PIN_END |

## Data Model

```
Board
├── outline: Point[]          // Board polygon
├── parts: Part[]
│   ├── name: string          // Reference designator
│   ├── side: Top|Bottom|Both
│   ├── type: SMD|ThroughHole
│   ├── origin: Point         // BVR3 only
│   └── pins: Pin[]
│       ├── name: string
│       ├── number: string
│       ├── position: Point   // Absolute (after resolving)
│       ├── radius: number    // BVR3 only
│       ├── side: Top|Bottom
│       └── net: string
└── nails: Nail[]             // BVR1 only
    ├── position: Point
    ├── side: Top|Bottom
    └── net: string
```

## References

- [OpenBoardView source — BVRFile.cpp](https://github.com/OpenBoardView/OpenBoardView/blob/master/src/openboardview/FileFormats/BVRFile.cpp)
- [OpenBoardView source — BVR3File.cpp](https://github.com/OpenBoardView/OpenBoardView/blob/master/src/openboardview/FileFormats/BVR3File.cpp)
- [OpenBoardView source — BRDFileBase.h](https://github.com/OpenBoardView/OpenBoardView/blob/master/src/openboardview/FileFormats/BRDFileBase.h)
- [bv2bvr converter](https://github.com/inflex/bv2bvr)
- [OpenBoardView BVR3 PR #236](https://github.com/OpenBoardView/OpenBoardView/pull/236)
