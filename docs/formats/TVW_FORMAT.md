# TVW (Teboview) Binary Board View Format

## Overview

TVW is a **binary, little-endian** PCB boardview format produced by **Teboview** (full name: "Tebo-ICT View"), an EDA/DFT (Design for Test) tool used in PCB manufacturing. The `.tvw` extension stands for **Tebo View**. Files are commonly found for Lenovo laptop boards manufactured by Chinese ODMs (LianBao/LCFC, Quanta, Compal) and range from ~3MB to 25MB+.

The source CAD data typically originates from **Cadence Allegro** designs, converted via a `cds2f` (Cadence-to-FAB) pipeline. D-code tables in the format borrow from Gerber/photo-plotter conventions.

> **Note:** The community research agent flagged possible mixed endianness (big-endian global header, little-endian layer data). However, the eagleview parser — the only complete working implementation — uses **all little-endian** throughout. Treat as LE unless empirical testing proves otherwise for specific fields.

TVW is significantly richer than text-based formats like BVR — it contains full copper geometry (pads, traces, arcs, copper fills), drill data, multi-layer stackups (14+ copper layers), silkscreen, solder mask, paste, assembly drawings, and test probe accessibility data.

### Key Differences from BVR

| Feature | BVR (text) | TVW (binary) |
|---------|-----------|--------------|
| Layers | Top + Bottom only | Full stackup (14+ copper + silk/mask/paste/assembly) |
| Geometry | Pads only (no traces) | Pads, traces, arcs, copper fills, drill holes/slots |
| Coordinates | Mils × 1000 (BVR1) or relative (BVR3) | Fixed32 (hundredths of mils) |
| Strings | Plain text | Position-dependent substitution cipher |
| Nets | Inline with pins | Separate net name table + index references |
| Parts | Name + type + pins | Name + type + BOM value + package + serial + height + tolerances |
| Test data | None | Probe accessibility, fixture definitions, test sequences |

### Sources & References

| Source | Description | License |
|--------|-------------|---------|
| [eagleview](https://github.com/nitrocaster/eagleview) by Pavel Kovalenko | **Complete TVW parser** (C++, 1111 lines) | MIT |
| [inflex/teboviewformat](https://github.com/inflex/teboviewformat) by Paul Daniels | Partial spec + string decoder + password remover | Partial |
| [mmuman/teboviewformat](https://github.com/mmuman/teboviewformat/tree/python-dump-tool) by Francois Revol | Python dump tool (`dump_tvw.py`) | — |
| [FlexBV5](https://pldaniels.com/flexbv5/) by Paul Daniels | Commercial viewer with full TVW support | Proprietary |
| [OpenBoardView #291](https://github.com/OpenBoardView/OpenBoardView/issues/291) | Feature request (still open) | — |

Reference source code saved in `docs/formats/tvw-reference/`.

---

## File Structure (Top-Level)

```
┌─────────────────────────────────────┐
│ Header                              │  Magic + version + customer + password + date
├─────────────────────────────────────┤
│ Layer[0]  (e.g., SILKSCREEN_TOP)    │  D-codes, pads, lines, arcs, surfaces, texts
│ Layer[1]  (e.g., SOLDERMASK_TOP)    │
│ Layer[2]  (e.g., TOP)              │  ← Logic layers (copper) have extra probe data
│ ...                                 │
│ Layer[N-1]                          │  ← Through layers (drill) have drill holes/slots
├─────────────────────────────────────┤
│ 4 × zero dwords (separator)        │
├─────────────────────────────────────┤
│ Net Name Table                      │  count + Pascal string array
├─────────────────────────────────────┤
│ Probe Registry                      │  Test probe definitions
├─────────────────────────────────────┤
│ Fixture Registry                    │  Top/bottom fixture variants
├─────────────────────────────────────┤
│ Mysterious Block                    │  Board metadata, top-right corner coords
├─────────────────────────────────────┤
│ Parts[]                             │  Component definitions with pins
├─────────────────────────────────────┤
│ Decals[]                            │  Package/footprint outlines
└─────────────────────────────────────┘
```

---

## Primitive Types

### Pascal String (`pstr`)
```
u8    length      // 0–255
u8[]  data        // UTF-8 encoded, NOT null-terminated
```

### Fixed32 Coordinates
```
i32   raw_value   // divide by 100 → value with 2 decimal places
```
Units are **hundredths of mils** (thousandths of an inch). Raw value `12345600` = `123456.00` mils = `123.456` inches.

### Vector2S
```
Fixed32  x
Fixed32  y
```

All multi-byte integers are **little-endian**.

---

## Header

```c
struct TvwHeader {
    pstr    file_type;      // obfuscated product name (20 bytes in samples)
    u32     unknown;        // always 1 in samples
    pstr    customer;       // obfuscated — decoded via DecodeString()
    pstr    password;       // obfuscated — can be zeroed (see notvwpwd.py)
    pstr    date;           // obfuscated
    pstr    h5;             // unknown
    pstr    h6;             // unknown
    pstr    h7;             // unknown — fixed "G34vS4z" in samples
    u32     size1;          // unknown size field
    u32     size2;          // unknown size field
    u32     size3;          // unknown size field
    u32     layer_count;    // number of layers to follow
    u32     zero;           // always 0
};
```

The `"G34vS4z"` string is the format version identifier — when decoded, it reveals the company name **"LianBao"** (the Chinese ODM). The `file_type` field decodes to `"Tebo-ictview files."`. Password-protected files have a non-empty password field; `notvwpwd.py` zeros it and forces version to `"G34vS4z"` to unlock.

---

## String Obfuscation (DecodeString)

TVW uses a **position-dependent substitution cipher** for header strings. Each character is decoded based on its class and position index `i` within the string:

```
Lowercase a–j:  shift by -(i%3 + 4), wraparound within a–j, then 154 - x
Lowercase k–z:  shift by -(i%10 + 5), wraparound +16 within k–z
Uppercase A–Z:  shift by +(i%10 + 5), wraparound -26 within A–Z
Digits    0–9:  shift by +(i%3 + 4), wraparound -10, then +49
```

Full lookup tables are in `inflex-decode-string.cpp`. The eagleview implementation is at `TeboBoard.cpp:91-131`.

---

## Layer Types

```c
enum LayerType : u32 {
    Document      = 0,
    Top           = 1,
    Bottom        = 2,
    Signal        = 3,   // inner copper
    PowerGround   = 4,   // power/ground plane
    SolderMaskTop = 5,
    SolderMaskBot = 6,
    SilkscreenTop = 7,
    SilkscreenBot = 8,
    PasteTop      = 9,
    PasteBot      = 10,
    Drill         = 11,
    Roul          = 12,  // board outline
};
```

### Layer Detection

Layers come in two flavors, auto-detected by reading up to 4 `u32` values:
- **LogicLayer** (type = 3): copper layers with shapes, pads, lines, arcs, surfaces, test points
- **ThroughLayer** (type = 1): drill layers with tools, holes, and slots

### Layer Header (common)

```c
struct LayerHeader {
    pstr    layer_name;     // e.g., "TOP", "SILKSCREEN_TOP"
    pstr    initial_name;   // original/internal name
    pstr    path;           // CAD source path (e.g., "BD:\DFT\...\cds2f_NMD712R01.cad")
    u32     layer_type;     // LayerType enum
    u32     pad_color;      // RGBA or index
    u32     line_color;     // RGBA or index
    u32     unknown_id;
};
```

---

## D-Code Table (Shape Dictionary)

Each layer has a D-Code table defining pad/aperture shapes. Indices start at **10** (D10, D11, ...).

```c
enum ShapeType : u32 {
    Round     = 0,
    Rect      = 1,
    RoundRect = 3,  // note: 2 is skipped
    Poly      = 5,
};

struct DCodeEntry {
    u32     marker;         // always 1
    Fixed32 width;          // 0 signals end of table
    Fixed32 height;
    u32     shape_type;     // ShapeType enum
    u32     extra1;
    u32     extra2;         // corner radius for RoundRect
};
// Terminated by entry with width = 0, followed by 0, 1
```

---

## Logic Layer Contents

```c
struct LogicLayer {
    DCodeEntry[]  shapes;       // D-code table (terminated)
    u8            flag;         // 1 = normal, 2 = extra data mode
    Pad[]         pads;         // count-prefixed
    Line[]        lines;        // count-prefixed
    Arc[]         arcs;         // count-prefixed
    Surface[]     surfaces;     // count-prefixed (copper fills)
    // if flag == 2: second pass of lines + arcs
    UnknownItem[] unknowns;     // count-prefixed
    TestPoint[]   test_points;  // count-prefixed
    TestSeq[]     test_seqs;    // count-prefixed
};
```

### Pad

```c
struct Pad {
    i32     net_index;      // index into net name table (-1 = no net)
    u32     dcode;          // D-code index (shape reference)
    Fixed32 x, y;           // position
    u8      is_exposed;     // test probe accessibility
    u8      is_copper;
    u8      flag3;
    // Optional: hole data, extended test point data (flag-dependent)
};
```

### Line (Trace)

```c
struct Line {
    i32     net_index;
    u32     dcode;          // width from D-code table
    Fixed32 x0, y0;         // start
    Fixed32 x1, y1;         // end
};
```

### Arc

```c
struct Arc {
    i32     net_index;
    u32     dcode;
    Fixed32 cx, cy;         // center
    Fixed32 radius;
    Fixed32 start_angle;    // degrees
    Fixed32 sweep_angle;    // degrees
    u32     unknown;
};
```

### Surface (Copper Fill)

```c
struct Surface {
    i32     net_index;
    u32     edge_count;
    Vector2S edges[edge_count];   // polygon outline
    u32     line_width;           // usually 0
    u32     void_count;           // cutout count
    Void    voids[void_count];    // internal cutouts
};

struct Void {
    u32      line_width;
    u32      edge_count;
    Vector2S edges[edge_count];
};
```

---

## Through Layer (Drill)

```c
struct ThroughLayer {
    DrillTool[] tools;          // count-prefixed
    // Then iterate entries discriminated by 1-byte code:
    //   0x08 = DrillHole
    //   0x0A, 0x0B = DrillSlot
};

struct DrillTool {
    pstr    name;
    u8      type;
    u32     size;               // drill diameter
    u8      unknown[0x17];
};

struct DrillHole {
    u8      code;               // 0x08
    i32     net_index;
    u32     tool_index;
    Fixed32 x, y;
};

struct DrillSlot {
    u8      code;               // 0x0A or 0x0B
    i32     net_index;
    u32     tool_index;
    Fixed32 x0, y0;             // start
    Fixed32 x1, y1;             // end
};
```

---

## Net Name Table

Located after all layers + 4 zero dwords separator.

```c
u32     count;          // number of net names
u32     count_dup;      // same as count (validation)
pstr    nets[count];    // 0-indexed net names
```

Nets are referenced by **0-based index** from pads, lines, arcs, surfaces, drill holes. Index `-1` means unconnected.

**NM-D711 sample:** ~3,375–3,927 net names (count varies by extraction method) including `CHASSIS1_GND`, `DDRB_MA11`, `+5VALW`, `VCCIN_AUX_SW`, `EC_SMB_CK1`, `BBA_SPI_CLK`, `TBTA_SMBUS_SCL`.

The net name table is followed by a marker sequence `0x00000000 0x00000000 0x04000000` and then `0x07 "ProbeDB#"` which marks the transition to probe/fixture data.

---

## Parts (Components)

```c
struct Part {
    pstr    name;               // e.g., "PU3200" (Lenovo P-prefix convention)
    Fixed32 bbox_min_x, bbox_min_y;
    Fixed32 bbox_max_x, bbox_max_y;
    Fixed32 center_x, center_y;
    Fixed32 angle;              // rotation in degrees
    u32     decal_index;        // index into Decals[] (package/footprint)
    u32     part_type;          // PartType enum
    u32     unknown1;
    u32     unknown2;
    Fixed32 height;
    u8      flag0;              // gates serial number field
    pstr    bom_value;          // e.g., "100K", "10uF"
    i16     unknown3;
    pstr    package_name;       // e.g., "CHIP0603R" (case insensitive)
    pstr    serial_number;      // only if flag0 set
    u32     unknown4;
    u32     pin_count;
    u32     layer;              // 1 = Top, 2 = Bottom
    Pin     pins[pin_count];
};
```

### Part Types

```c
enum PartType : u32 {
    IC              = 0,
    Diode           = 1,
    Transistor      = 2,
    Resistor        = 3,
    ResistorNetSI   = 4,
    Capacitor       = 5,
    CapacitorNetSI  = 6,
    Zener           = 7,
    LED             = 8,
    Jumper          = 9,
    Battery         = 10,
    Mask            = 11,
    Relay           = 12,
    Fuse            = 13,
    Choke           = 14,
    Crystal         = 15,
    Switch          = 16,
    Connector       = 17,
    TestPoint       = 18,
    Transformer     = 19,
    Potentiometer   = 20,
    Mechanical      = 21,
    ResistorNetDI   = 22,
    ResistorNetSB   = 23,
    ResistorNetDB   = 24,
    CapacitorNetDI  = 25,
    CapacitorNetSB  = 26,
    CapacitorNetDB  = 27,
    Strap           = 28,
    Fiducial        = 29,
    Unknown         = 30,
};
```

### Pin

```c
struct Pin {
    u32     handle;         // *** KEY: handle / 8 = pad index in layer ***
    u32     unknown;        // always 0
    u32     pin_index;      // 1-based sequential
    pstr    pin_name;       // "1", "2" for passives; "AA42", "B24" for BGA
    u32     unknown2;       // always 0
};
```

### Pin-to-Pad-to-Net Mapping (The Critical Link)

This was the hardest part to reverse-engineer and was solved by the eagleview project:

```
pin.handle / 8 → pad index within the part's layer
pad[index].net_index → index into net name table
net_names[net_index] → net name string
```

This chain connects: **Part → Pin → Pad → Net Name**.

---

## Decals (Package/Footprint Outlines)

```c
struct Decal {
    pstr        name;           // e.g., "CHIP0603R_14R173"
    LogicLayer  sub_layers[3];  // up to 3 embedded sub-layers for outline geometry
    Vector2S    outline[];      // package outline polygon vertices
};
```

---

## Probe & Fixture Data

### Probe Registry
Test probe definitions with coordinates, sizes, and fixture assignments. Referenced by test points in logic layers.

### Fixture Registry
Top/bottom fixture variants with workspace dimensions. Contains probe size defaults (e.g., "100 Mil" = 70.00 mils diameter).

### Test Accessibility Enum
```c
enum Untestable {
    ACCESSIBLE          = 0,
    NEEDLESS            = 1,
    MASK                = 2,
    OVERLAPPED          = 3,
    NO_APPROPRIATE_PROBE = 4,
    SMD                 = 5,
    // ... more values
};
```

---

## Coordinate System

- **Units:** Hundredths of mils (Fixed32 with 2 decimal places)
- **Origin:** Board-specific (often near center or bottom-left corner of board outline)
- **Conversion to mils:** `raw_i32 / 100.0`
- **Conversion to mm:** `raw_i32 / 100.0 * 0.0254`
- **Signed coordinates:** Negative values are common (origin may not be at corner)

### Comparison with BVR coordinates

| Format | Storage | To mils |
|--------|---------|---------|
| BVR1 | `i32 × 1000` | `value / 1000` |
| BVR3 | relative to PART_ORIGIN | `value` (already mils) |
| TVW | Fixed32 (hundredths) | `value / 100` |

---

## NM-D711 Sample Board Profile

| Property | Value |
|----------|-------|
| Board | LCFC HY568 (NM-D711/NM-D712) |
| Platform | Intel Tiger Lake-H + NVIDIA GN20-E GPU |
| Laptop | Lenovo Legion / Yoga variant |
| Copper layers | 14 (TOP, IN1-IN4, GND1-GND5, VCC, BOTTOM) |
| Total layers | 20 (+ silk, mask, assembly, placement) |
| Components | ~921 unique designators (P-prefix convention) |
| Nets | 3,375 net names |
| File size | 25.1 MB |
| CAD source | Cadence Allegro (`cds2f_NMD712R01.cad`) |
| Naming | P-prefix: PU=IC, PR=Resistor, PC=Capacitor, PL=Inductor, PQ=MOSFET, PJ=Connector, PD=Diode |

---

## Implementation Notes for BoardRipper

### Parser Strategy
1. **Use eagleview as reference** — MIT-licensed, complete, well-structured C++ → straightforward TypeScript port
2. **Client-side parsing** — consistent with existing BVR approach (no server dependency)
3. **Binary reading** — use `DataView` with little-endian flag, implement Pascal string reader

### Data Model Mapping (TVW → BoardData)

```typescript
// TVW parsing produces richer data than BVR — extend BoardData or create TvwBoardData
interface TvwBoardData extends BoardData {
    layers: TvwLayer[];           // multiple copper + non-copper layers
    traces: TvwLine[];            // trace segments (lines)
    arcs: TvwArc[];               // arc segments
    surfaces: TvwSurface[];       // copper fills with voids
    drillHoles: TvwDrillHole[];   // via/through-hole drill data
    decals: TvwDecal[];           // package outlines
    probes?: TvwProbe[];          // test probe data (optional)
}
```

### Multi-Layer Rendering
TVW's multi-layer data requires layer visibility toggles — each of the 14+ copper layers can be independently shown/hidden. This maps well to the existing render settings infrastructure.

### TVW-to-PDF Cross-Reference
Component names (with P-prefix stripped) and net names from the TVW directly match schematic references in the PDF. The mapping is 1:1 — no transformation needed beyond optional P-prefix removal for display.
