# Cadence Allegro BRD Binary Format

**Attribution**: This document is derived primarily from the KiCad Allegro importer
(`pcbnew/pcb_io/allegro/`), released under GPL-3.0. Additional sources include
[brd_parser](https://github.com/bernayigit/brd_parser) (MIT) by Jeff Wheeler.
This is NOT an official Cadence specification — all information is reverse-engineered.

---

## File Layout

```
Offset 0x0000  Header (~4 KB)
               - Magic (u32 LE): version detection
               - Object count
               - 22 linked-list descriptors (pre-V180) or 28 (V180+)
               - Allegro version string (60 bytes ASCII)
               - Board units (1 byte: 0x01=Imperial, 0x02=Metric)
               - Units divisor (u32): scale factor for coordinates
               - String count (pre-V180 explicit; V180 embedded in header)
               - Layer map (256 entries, pointers to 0x2A layer lists)
               - 0x35 file reference extents (pre-V180: between LL groups)

Offset 0x1200  String Table
               - Each entry: [u32 ID] [null-terminated string]
               - Repeated string_count times, word-aligned

Variable       Object Blocks
               - Repeated: [1-byte type tag] [type-specific data]
               - Fixed size per type per version (see Size Tables)
               - V180: zero-padded gaps may appear between groups
               - Terminated by 0x00 type byte (V180: parser skips gaps and
                 continues if another valid tag follows)
```

---

## Version Detection

First 4 bytes (u32 LE) are the magic number. Mask the lower byte to get the format
version constant. Version 17.2 is the most significant struct layout change;
Version 18.0 is the most significant header layout change.

| Magic          | Version | Allegro Release |
|----------------|---------|-----------------|
| `0x00130000`   | V_160   | 16.0            |
| `0x00130400`   | V_162   | 16.2            |
| `0x00130C00`   | V_164   | 16.4            |
| `0x00131000`   | V_165   | 16.5            |
| `0x00131500`   | V_166   | 16.6            |
| `0x00140400`   | V_172   | 17.2            |
| `0x00140900`   | V_174   | 17.4            |
| `0x00141500`   | V_175   | 17.5            |
| `0x00150000`   | V_180   | 18.0            |
| `0x00150200`   | V_180   | 18.0.2 (Dell XPS LA-E331P) — see V18.0.2 layout note |

Additional check: bytes 8–11 as u32 LE == 1 distinguishes Allegro BRD from the
obfuscated Apple/Mac BRD format (which shares the same file extension).

---

## Coordinate System

- **Integer coords**: signed 32-bit. Convert to mils: `mils = coord / unitsDivisor`.
- **Y-axis**: negated (flipped) relative to internal storage.
- **Arc geometry**: center and radius use `ReadAllegroFloat` — two big-endian 32-bit
  words forming an IEEE 754 double.
- **Rotation**: unsigned 32-bit millidegrees (divide by 1000 for degrees). Rotation
  is NOT negated despite the Y-axis flip (same convention as Altium).
- **Pad rotation** (0x0D blocks) is board-absolute; subtract the footprint rotation
  to get footprint-local pad rotation.

---

## Linked Lists

Most block types form singly-linked lists via an `m_Next` field holding the key of
the next block. The header contains linked-list descriptors (head + tail key pairs).
All blocks are indexed by key in a flat hash map.

### Pre-V180 Header Linked Lists (22 descriptors, head=word2, tail=word1)

| Index | Field                    | Points To                          |
|-------|--------------------------|------------------------------------|
| 0     | m_LL_X01                 | 0x01 Arc segments                  |
| 1     | m_LL_X03_X30             | 0x03 Field + 0x30 text wrappers    |
| 2     | m_LL_X04                 | 0x04 Net assignments               |
| 3     | m_LL_X05                 | 0x05 Track collections             |
| 4     | m_LL_X06                 | 0x06 Component/symbol definitions  |
| 5     | m_LL_X07                 | 0x07 Footprint instance refs       |
| 6     | m_LL_X0D                 | 0x0D Pad geometry blocks           |
| 7     | m_LL_X0E                 | 0x0E Shape/fill segments           |
| 8     | m_LL_X0F_X10             | 0x0F/0x10 function slot/instance   |
| 9     | m_LL_X14                 | 0x14 Graphics containers           |
| 10    | m_LL_X1B                 | 0x1B Net definitions               |
| 11    | m_LL_X1C                 | 0x1C Padstack definitions          |
| 12    | m_LL_X1D_X1E_X1F         | 0x1D constraint / 0x1E IBIS / 0x1F|
| 13    | m_LL_X20                 | 0x20 Unknown                       |
| 14    | m_LL_X21                 | 0x21 Headered blocks               |
| 15    | m_LL_X22                 | 0x22 Unknown                       |
| 16    | m_LL_X23                 | 0x23 Ratsnest lines                |
| 17    | m_LL_X24_X28             | 0x24 Rect + 0x28 Polygon shapes    |
| 18    | m_LL_X36                 | 0x36 Font/misc definitions         |
| 19    | m_LL_Unknown5            | Unknown                            |
| 20    | m_LL_X38                 | 0x38 Film definitions              |
| 21    | m_LL_X2B_X2D             | 0x2B def + 0x2D placed footprints  |

### V180 Header Changes

V180 adds 6 new linked lists (28 total) and reverses the head/tail word order
within each descriptor (word1=head, word2=tail). Positions 23–24 swap
`m_LL_X36` and `m_LL_Unknown5` relative to pre-V18 order.

---

## Block Type Reference

| Type | Struct Name               | Purpose                                   |
|------|---------------------------|-------------------------------------------|
| 0x01 | BLK_0x01_ARC              | Arc segment (track, shape, zone, outline) |
| 0x03 | BLK_0x03                  | Field/property reference                  |
| 0x04 | BLK_0x04_NET_ASSIGNMENT   | Net assignment (links nets to shapes)     |
| 0x05 | BLK_0x05_TRACK            | Track segment collection                  |
| 0x06 | BLK_0x06                  | Component/symbol definition               |
| 0x07 | BLK_0x07                  | Footprint instance reference data         |
| 0x08 | BLK_0x08                  | Pin number                                |
| 0x09 | BLK_0x09                  | Fill-to-shape link (intermediate)         |
| 0x0A | BLK_0x0A_DRC              | DRC error marker                          |
| 0x0C | BLK_0x0C                  | Pin definition                            |
| 0x0D | BLK_0x0D_PAD              | Pad geometry and placement                |
| 0x0E | BLK_0x0E                  | Shape/fill segment                        |
| 0x0F | BLK_0x0F                  | Function slot reference                   |
| 0x10 | BLK_0x10                  | Function instance reference               |
| 0x11 | BLK_0x11                  | Pin name                                  |
| 0x12 | BLK_0x12                  | Unknown                                   |
| 0x14 | BLK_0x14                  | Graphics container (lines, arcs)          |
| 0x15 | BLK_0x15_16_17_SEGMENT    | Line segment — horizontal orientation     |
| 0x16 | (same as 0x15)            | Line segment — diagonal orientation       |
| 0x17 | (same as 0x15)            | Line segment — vertical orientation       |
| 0x1B | BLK_0x1B_NET              | Net definition                            |
| 0x1C | BLK_0x1C_PADSTACK         | Padstack definition                       |
| 0x1D | BLK_0x1D                  | Physical constraint set                   |
| 0x1E | BLK_0x1E                  | Signal integrity model (IBIS data)        |
| 0x1F | BLK_0x1F                  | Linked-list connector (empty)             |
| 0x20 | BLK_0x20_UNKNOWN          | Unknown                                   |
| 0x21 | BLK_0x21                  | Headered block (rules, stackup)           |
| 0x22 | BLK_0x22                  | Unknown                                   |
| 0x23 | BLK_0x23_RATLINE          | Ratsnest line                             |
| 0x24 | BLK_0x24_RECT             | Rectangle shape                           |
| 0x26 | BLK_0x26                  | Match group indirection (diff pair)       |
| 0x27 | BLK_0x27                  | Constraint manager cross-reference table  |
| 0x28 | BLK_0x28_SHAPE            | Polygon shape (zones, fills, pads)        |
| 0x29 | BLK_0x29_PIN              | Pin instance (in .dra footprint files)    |
| 0x2A | BLK_0x2A_LAYER_LIST       | Layer list entry                          |
| 0x2B | BLK_0x2B                  | Component/symbol reference (definition)   |
| 0x2C | BLK_0x2C_TABLE            | Table/lookup structure                    |
| 0x2D | BLK_0x2D                  | Footprint instance (placed part)          |
| 0x2E | BLK_0x2E                  | Connection/ratsnest                       |
| 0x2F | BLK_0x2F                  | Unknown                                   |
| 0x30 | BLK_0x30_STR_WRAPPER      | Text object (wraps 0x31 graphic)          |
| 0x31 | BLK_0x31_SGRAPHIC         | String graphic content (position, font)   |
| 0x32 | BLK_0x32_PLACED_PAD       | Placed pad instance                       |
| 0x33 | BLK_0x33_VIA              | Via instance                              |
| 0x34 | BLK_0x34_KEEPOUT          | Keepout area                              |
| 0x35 | BLK_0x35                  | File references (log paths)               |
| 0x36 | BLK_0x36                  | Font/misc definitions (substructs)        |
| 0x37 | BLK_0x37                  | Pointer array (net resolution)            |
| 0x38 | BLK_0x38_FILM             | Film definition                           |
| 0x39 | BLK_0x39_FILM_LAYER_LIST  | Film layer list                           |
| 0x3B | BLK_0x3B                  | Unknown                                   |
| 0x3C | BLK_0x3C                  | Unknown                                   |

---

## Layer Encoding

Each block carries a 2-byte `LAYER_INFO`: one byte class code + one byte subclass code.

### Layer Classes

| Code | Class            | Purpose                        |
|------|------------------|--------------------------------|
| 0x01 | BOARD_GEOMETRY   | Board-level features           |
| 0x02 | COMPONENT_VALUE  | Component value text           |
| 0x03 | DEVICE_TYPE      | Device type text               |
| 0x04 | DRAWING_FORMAT   | Drawing annotations            |
| 0x05 | DRC_ERROR        | DRC error markers              |
| 0x06 | ETCH             | Copper layers (stackup order)  |
| 0x07 | MANUFACTURING    | Manufacturing features         |
| 0x08 | ANALYSIS         | Analysis features              |
| 0x09 | PACKAGE_GEOMETRY | Footprint-level geometry       |
| 0x0A | PACKAGE_KEEPIN   | Package keepin                 |
| 0x0B | PACKAGE_KEEPOUT  | Package keepout                |
| 0x0C | PIN              | Pin features                   |
| 0x0D | REF_DES          | Reference designator text      |
| 0x0E | ROUTE_KEEPIN     | Route keepin                   |
| 0x0F | ROUTE_KEEPOUT    | Route keepout region           |
| 0x10 | TOLERANCE        | Tolerance text                 |
| 0x11 | USER_PART_NUMBER | User part number text          |
| 0x12 | VIA_CLASS        | Via class features             |
| 0x13 | VIA_KEEPOUT      | Via keepout region             |
| 0x14 | ANTI_ETCH        | Anti-etch (negative copper)    |
| 0x15 | BOUNDARY         | Zone boundary outlines         |

For ETCH class, subclass values 0..N-1 index copper layers in stackup order
(0 = top, N-1 = bottom).

### Key Fixed Subclass Codes

High subclass values (>= 0xEA) are reserved; low values index the per-class
custom layer list from the header layer map.

| Code | Class(es)                          | Meaning              |
|------|------------------------------------|----------------------|
| 0xEA | BOARD_GEOMETRY                     | Board outline        |
| 0xFD | DRAWING_FORMAT, PACKAGE_GEOMETRY   | Outline / Assembly top |
| 0xF7 | PACKAGE_GEOMETRY                   | Silkscreen top       |
| 0xF6 | PACKAGE_GEOMETRY                   | Silkscreen bottom    |
| 0xF4 | MANUFACTURING                      | Autosilk top         |
| 0xF3 | MANUFACTURING                      | Autosilk bottom      |
| 0xF9 | REF_DES, COMPONENT_VALUE           | Display top          |
| 0xF8 | REF_DES, COMPONENT_VALUE           | Display bottom       |

---

## Data Extraction Chains

### Components and Pins

```
Header m_LL_X2B_X2D
  └─ 0x2D (placed footprint)
       ├─ m_Layer: 0 = top, 1 = bottom
       ├─ m_CoordX / m_CoordY: board position (÷ unitsDivisor = mils)
       ├─ m_Rotation: millidegrees
       ├─ m_InstRef (V172+) / m_InstRef16x (pre-V172)
       │    └─ 0x07 instance ref
       │         └─ refdes_string_key → string table → "U1", "R42" …
       ├─ m_GraphicPtr → 0x14 graphics chain (silkscreen, courtyard)
       ├─ m_FirstPadPtr → 0x32 placed pad chain
       │    ├─ m_CoordsX / m_CoordsY: pad position (board coords)
       │    ├─ m_PadStack → 0x1C padstack → pad shape, drill
       │    ├─ m_Rotation: board-absolute millidegrees
       │    ├─ net link → 0x04 → 0x1B net → net name string
       │    ├─ pin name → 0x0D → 0x11 → string table
       │    └─ m_Next → next 0x32 (chain ends when key is 0x2D or 0x2B)
       └─ m_TextPtr → 0x30 text chain (refdes, value labels)
```

Bottom-layer footprints must be flipped AFTER adding all children.

### Nets

```
Header m_LL_X1B
  └─ 0x1B (net definition)
       ├─ net_name_string_key → string table → "VCC", "GND" …
       └─ net assignments reachable via 0x04 / 0x05 chains
```

### Traces (Copper Segments)

```
Header m_LL_X05
  └─ 0x05 (track collection)
       └─ linked 0x15 / 0x16 / 0x17 segments
            ├─ start / end coords
            ├─ width
            └─ layer (ETCH class + subclass = copper layer index)
```

Arc segments (0x01) use `ReadAllegroFloat` for center/radius
and a `m_SubType` direction bit (bit 6: 0 = CCW, 0x40 = CW).

### Zone Net Resolution

```
BOUNDARY 0x28 shape
  └─ m_Ptr7 (V172+) or m_Ptr7_16x (pre-V172)
       └─ 0x2C TABLE
            └─ m_Ptr1
                 └─ 0x37 pointer array
                      └─ m_Ptrs[0]
                           └─ 0x1B NET block
```

---

## Board Outline Detection

The board outline is stored as polygon shapes (0x28) with specific class + subclass:

| Class (code)          | Subclass | Name          |
|-----------------------|----------|---------------|
| BOUNDARY (0x15)       | any      | Zone boundary |
| BOARD_GEOMETRY (0x01) | 0xEA     | BGEOM_OUTLINE |
| DRAWING_FORMAT (0x04) | 0xFD     | DFMT_OUTLINE  |

Both subclass codes 0xEA and 0xFD must be checked. The outline geometry is a
linked list of 0x15/0x16/0x17 line segments and 0x01 arcs forming a closed contour.

**Pick by bounding-box area, not segment count.** Some Compal/Quanta files
(LA-H271P) carry routing keepins and copper-pour boundaries on the BOUNDARY
class with *more segments* than the actual board edge — a rounded-rect outline
is just a few arcs + a few lines, while a keepin polygon may have 2000+
segments. Ranking candidates by area (`(maxX-minX) * (maxY-minY)` of the
walked points) consistently selects the true edge across every sample we
have. The 0xEA tiebreaker is preserved for the rare exact-area collision.

---

## Record Size Tables (Empirically Verified)

Sizes are in bytes. Many types have version-conditional fields; sizes change at V172.

### v16.5

```
x01=80  x02=36  x04=20  x05=60  x06=36  x07=40  x08=24  x09=44
x0A=68  x0C=56  x0D=40  x0E=60  x0F=56  x10=32  x11=24  x12=28
x14=32  x15=40  x16=40  x17=40  x1B=56  x20=40  x22=40  x23=84
x26=20  x28=68  x2B=72  x2C=36  x2D=64  x2E=36  x2F=32  x30=44
x32=76  x33=72  x34=32  x37=428 x38=64  x39=60  x3A=16
```

### v17.2

```
x02=72  x05=72  x06=40  x07=48  x09=48  x0A=44  x0B=72  x0C=72
x0D=44  x0E=68  x0F=60  x10=36  x11=28  x12=28  x14=36  x1B=60
x23=88  x2B=76  x2D=72  x33=76  x34=36  x3A=16
```

---

## Notable Implementation Notes

- **0x27 blob**: The constraint manager cross-reference table can be 10 KB–4 MB.
  Starts with 3 zero bytes, then uint32 LE values. V172+ values are compact block
  keys; pre-V172 values are runtime heap addresses. Not needed for boardview parsing.

- **Pad rotation**: 0x0D stores board-absolute rotation. Subtract parent footprint
  rotation to get footprint-local pad rotation.

- **Drill slot orientation**: Allegro stores slot dimensions as (primary=larger,
  secondary=smaller) regardless of orientation. Compare pad aspect ratio vs drill
  aspect ratio and swap drill dimensions if they disagree.

- **Dynamic copper** (V172+): 0x28 shapes with `m_Unknown2 & 0x1000` are
  auto-generated teardrops/fillets. Values 0x3001 = teardrops, 0x1001 = fillets,
  0x0001 = genuine copper pours.

- **Empty net names**: BOUNDARY shapes with an unnamed net should get a synthetic
  name `Net_<code>` to avoid collapsing into UNCONNECTED during zone-fill matching.

- **Board outline — flat-scan required**: Many Allegro files (confirmed on Quanta
  Y0D, Z8I, Acer Z8IA; V_165 and V_172) do **not** link the real board outline
  `0x28` shape into `LL_Shapes`. KiCad's reference importer walks three linked
  lists (`LL_Shapes`, `LL_0x24_0x28`, `LL_0x14`); even that is insufficient in
  these files. BoardRipper's `extractOutline` flat-scans `db.blocks.values()` for
  all `0x28` blocks matching the outline filter (BOUNDARY class, or
  BOARD_GEOMETRY/DRAWING_FORMAT + subclass `0xEA/0xFD`) and picks the largest by
  segment count. Minimal-risk — the filter predicate is unchanged, only the
  traversal scope widened.

- **`inst.layer` side-label inversion**: KiCad's `backSide = inst.m_Layer != 0`
  check is mathematically correct, but some Allegro exports (Quanta laptop
  motherboards) use the opposite convention: big chips (CPU, SoC, DIMMs) sit on
  `inst.layer=1` while the ETCH layer-name table labels layer 0 as "TOP". The
  geometry and bottom-frame coordinate convention are preserved; only the user-
  facing side label is reversed. BoardRipper detects this by pin-count majority
  (if >55% of pins are on `side='bottom'`, set `BoardData.primarySide='bottom'`).
  The renderer, scene graph, and coordinate frames stay untouched; the fix lives
  purely at the UI layer: `selectTop`/`selectBottom` swap which store flag they
  set, and the Toolbar swaps which button highlights as active. The initial
  view on open also uses `showBottom=true` so the file loads onto the CPU side.
  Single-sided boards and normally-laid-out boards (tvk336169) are untouched.

  **v18.0.2 sub-version** (Dell XPS LA-E331P) uses a different `0x2D.layer`
  encoding: bottom is `3` (binary `0b011`) instead of the older `1`. Reading
  it as `layer === 0 ? 'top' : 'bottom'` keeps the mapping correct without a
  bitmask — bit 0 alone is the side bit; bit 1 in v18 is some unidentified
  flag that's always set on the bottom side.

- **v18.0.2 header layout (LA-E331P)**: between the existing V_180 header
  fields and the Allegro version string, this sub-version inserts **4
  additional linked-list pairs** (32 bytes), so the version string sits at
  file offset `0x144` instead of the V_180 baseline `0x124`. Each pair has
  an increasing head value (e.g. `0x7d..0x80`) with `tail = 0`; treated as
  opaque alignment-only data — the parser reads them into `LL_V18_7..10`
  to keep the stream aligned. The position assertion was widened to `0x144`
  for V_180. v18.0.0 is not in the corpus to validate against; if a file
  shows up missing these 4 pairs we'll branch by sub-magic.

- **Layer-name extraction — most-referenced fallback**: in v16/v17 files the
  ETCH layer list lives at `header.layerMap[LayerClass.ETCH]` (slot 6). v18
  abandoned this slot-by-class-code convention — LA-E331P puts the ETCH list
  at slot 1 with slot 6 empty. The robust signature across every sample is:
  the ETCH list is the single `0x2A` block referenced by the *most* layer-map
  slots (Y0D 11×, Z8IA 10×, LA-H271P 9×, LA-E331P 8×). Try slot 6 first to
  preserve older behaviour, fall back to "most-referenced" when it's empty.

- **Per-component silkscreen / assembly outlines**: each
  `Blk0x2DFootprintInst` has a `graphicPtr` field that walks a chain of
  `0x14 Graphic` blocks. Each `0x14` carries a `LayerInfo` of its own and a
  `segmentPtr` head into the same `0x15/0x16/0x17/0x01` segment-and-arc
  primitives the board outline walks. Filtering to `LayerClass.PACKAGE_GEOMETRY`
  (`cc=0x09`) yields the per-part silkscreen / assembly polylines. **Segments
  arrive in board coordinates already** — pre-rotated and pre-translated by
  Allegro for the standard 0/90/180/270° placements — so no transform pass is
  needed at extraction time. Side comes from `fpInst.layer`.

  Subclass legend (`cc=0x09`):

  | sc     | Block type    | Meaning                              |
  |--------|---------------|--------------------------------------|
  | `0xF7` | 0x14 lines    | ASSEMBLY_TOP outline (open polylines + arcs) |
  | `0xF6` | 0x14 lines    | ASSEMBLY_BOTTOM                      |
  | `0xFB` | 0x28 polygons | SILKSCREEN_TOP body (closed)         |
  | `0xFA` | 0x28 polygons | SILKSCREEN_BOTTOM                    |
  | `0xFD` | 0x14 lines    | package default                      |
  | `0xF4` / `0xF3` | 0x28 polygons | place-bound / courtyard       |

  BoardRipper extracts the `0x14` open polylines (not the `0x28` polygons)
  because they include pin-1 markers, polarity ticks, and body outlines —
  the visually richer set most closely matching what a CAD tool draws.

- **Copper pads — placed-pad bbox**: `Blk0x07ComponentInst.fpInstPtr →
  Blk0x2DFootprintInst.firstPadPtr` walks a chain of `Blk0x32 PlacedPad`
  blocks (one per pin). Each `0x32` carries a `coords[4]` field that's the
  axis-aligned bbox of the pad in board coordinates, already pre-rotated and
  pre-translated for standard placements. Use it directly as the pad
  rectangle. **Side**: through-hole vs SMD is decided by the pad's padstack
  (`Blk0x32.padPtr → Blk0x0D.padStack → Blk0x1C`); when `Blk0x1C.layerCount
  > 1` the pad spans multiple etch layers and is treated as `side='both'`,
  otherwise SMD on `fpInst.layer`. Net is resolved through `Blk0x32.netPtr →
  netAssignMap`.

  The same bbox is also stored on each `Pin` as `padBounds` so the renderer
  can hit-test a click anywhere on the pad area (selecting the pin) and draw
  selection highlights as the pad rectangle rather than a circle stuck on
  top.

- **Drill diameter from padstack, not bbox**: vias (`Blk0x33`) and through-
  hole pads (`Blk0x32` with multi-layer padstack) have their actual drill
  size in `Blk0x1CPadstack.drill`. The placed-via `bbox` is the **pad ring**
  (signal pad + clearance), not the drill — using it overstates the hole by
  2–6×. Reading `padstack.drill` and falling back to bbox only when drill is
  zero gives accurate per-via diameters. Through-hole pads also expose this
  as `Pad.drill` so the renderer can punch a black drill disc through the
  filled rectangle (otherwise the pad obscures the hole on power/ground TH
  pins, which look like solid coloured rectangles with no visible hole).

---

## References

- [KiCad Allegro importer FORMAT.md](https://github.com/KiCad/kicad-source-mirror/blob/master/pcbnew/pcb_io/allegro/FORMAT.md) — GPL-3.0, primary source
- [brd_parser](https://github.com/bernayigit/brd_parser) — C++ parser by Jeff Wheeler (MIT)
- [OpenBoardView Issue #62](https://github.com/OpenBoardView/OpenBoardView/issues/62)
