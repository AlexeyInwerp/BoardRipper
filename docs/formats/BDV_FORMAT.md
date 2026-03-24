# BDV (Plain-Text Boardview) File Format Specification

> Reverse-engineered from sample files and the [OpenBoardView](https://github.com/OpenBoardView/OpenBoardView) source.

---

## Overview

BDV is a plain-text boardview format commonly distributed with `.brd` or `.bdv` file extensions.
Unlike the binary-obfuscated BRD (Apple/Mac) or Cadence Allegro BRD, this is readable ASCII text
with keyword-prefixed sections.

| Property | Value |
|----------|-------|
| Extension | `.brd`, `.bdv` |
| Detection | ASCII text containing `BRDOUT:` within first 512 bytes |
| Encoding | ASCII / UTF-8 |
| Field separator | Whitespace (spaces/tabs) |
| Coordinate unit | Mils (thousandths of an inch) |
| Side encoding | `1` = top, `2` = bottom |

---

## File Structure

```
<creator/metadata string>        ← Line 1: ignored
BRDOUT: <N> <W> <H>             ← Board outline: N vertices, W×H dimensions
<x1> <y1>                        ← N outline vertex lines
<x2> <y2>
...

NETS: <N>                        ← Net list: N entries
<index> <net_name>               ← 1-based index + net name

PARTS: <N>                       ← Part catalogue: N entries
<name> <x1> <y1> <x2> <y2> <pinStartIdx> <side>

PINS: <N>                        ← Pin positions: N entries (flat global array)
<x> <y> <netIdx> <side>

NAILS: <N>                       ← Test points: N entries
<nailIdx> <x> <y> <netIdx> <side>
```

---

## Sections

### BRDOUT

Defines the board outline as a polygon.

```
BRDOUT: 4 5000 3000
0 0
5000 0
5000 3000
0 3000
```

- `N` — number of vertices
- `W`, `H` — board width and height (informational)
- Each subsequent line is an `x y` vertex pair

### NETS

Net name lookup table. Indices are 1-based and referenced by PINS and NAILS.

```
NETS: 3
1 VCC
2 GND
3 SDA
```

### PARTS

Component catalogue. Each part defines a bounding box and a starting index into the global PINS array.

```
PARTS: 2
U1 100 200 300 400 0 1
R1 500 600 550 650 8 1
```

| Field | Description |
|-------|-------------|
| `name` | Reference designator (e.g., `U1`, `R1`) |
| `x1 y1 x2 y2` | Bounding box corners |
| `pinStartIdx` | Index into the global PINS array (0-based) |
| `side` | `1` = top, `2` = bottom |

Pin ownership is determined by index ranges: part `i` owns pins from its `pinStartIdx` to the next part's `pinStartIdx` (exclusive).

### PINS

Global flat array of pin positions. Each pin belongs to the part whose index range covers it.

```
PINS: 10
150 250 1 1
200 250 2 1
...
```

| Field | Description |
|-------|-------------|
| `x y` | Pin position in mils |
| `netIdx` | 1-based index into NETS |
| `side` | `1` = top, `2` = bottom |

### NAILS

Test points / via probes.

```
NAILS: 2
1 400 300 2 1
2 600 500 3 2
```

| Field | Description |
|-------|-------------|
| `nailIdx` | Nail/probe identifier |
| `x y` | Position in mils |
| `netIdx` | 1-based index into NETS |
| `side` | `1` = top, `2` = bottom |

---

## Parser Notes

- All coordinates are in mils — no conversion needed for BoardRipper's internal coordinate system.
- Pin names are synthetic (sequential `1`, `2`, ...) since the format does not include pin names.
- The `flipY` flag is enabled for this format.
