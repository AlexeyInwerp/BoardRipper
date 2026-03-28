# Allegro BRD Parser Rewrite — Design Spec

## Summary

Complete rewrite of the Cadence Allegro BRD binary parser, replacing the current heuristic-based implementation with a field-by-field Object DB architecture derived from KiCad 10's open-source Allegro importer (GPL-3.0). The new parser supports versions 16.0–18.0+, parses all ~35 block types with version-conditional field layouts, and resolves cross-references via a global key→object map.

## Motivation

The current parser (~1,400 lines, single file) has fundamental limitations:

- **Fixed-size record table**: breaks on variable-size blocks (0x03, 0x1C padstacks, 0x1D constraints, 0x1E, 0x1F, 0x21, 0x36)
- **Hardcoded coordinate divisor**: assumes `÷100` for mils; fails on metric boards or non-standard divisors
- **Incomplete pin/net extraction**: only reads pre-x27 region (~4% of file), then does a fragile flat scan. Most pins and nets reside in the x27 blob region.
- **Heuristic resynchronization**: skips null gaps and forward-scans on parse errors — masks bugs, produces incomplete data silently
- **No v17.5/v18.0 support**: only handles v16.0–17.4

KiCad's importer (reverse-engineered from hundreds of sample files, no Allegro tools used) provides verified field layouts for all block types across 7 major versions. This rewrite transliterates that knowledge into TypeScript.

## Reference

- **KiCad Allegro importer**: `pcbnew/pcb_io/allegro/` in [KiCad source](https://gitlab.com/kicad/code/kicad) (GPL-3.0)
- **KiCad FORMAT.md**: `pcbnew/pcb_io/allegro/FORMAT.md` — reverse-engineered binary format documentation
- **KiCad blog post**: [Three New Importers in KiCad 10](https://www.kicad.org/blog/2026/02/Three-New-Importers-in-KiCad-10-Allegro-PADS-and-gEDA/)

## Architecture

### Object DB Pattern

Three-phase pipeline:

```
ArrayBuffer → Parse → Object DB → Resolve refs → Assemble → BoardData
```

1. **Parse**: Read header, string table, then scan all blocks field-by-field. Each block becomes a typed object stored in `Map<number, Block>` keyed by its `m_Key`.
2. **Resolve**: Walk all objects, resolve key references to actual object pointers. Non-fatal: unresolvable refs logged, block marked invalid.
3. **Assemble**: Walk linked lists from header (footprint defs → instances → pads, nets → assignments) to produce `BoardData`.

### Module Structure

```
src/frontend/src/parsers/allegro/
├── allegro-stream.ts        # Binary reader (LE primitives, string reading, AllegroFloat)
├── allegro-types.ts         # Block data interfaces, FmtVer enum, BlockType enum, LayerInfo
├── allegro-header.ts        # Header parser (version detection, linked lists, units, layer map)
├── allegro-blocks.ts        # Per-block-type parser functions (one per type, ~35 total)
├── allegro-db.ts            # Object DB: Map<key, Block>, string table, ref resolution
├── allegro-assembler.ts     # Walks resolved DB → BoardData (parts, pins, nets, traces, outline)
├── allegro-brd-parser.ts    # Entry point: orchestrates pipeline, exports parseAllegroBrd()
└── allegro-brd-format.ts    # Format descriptor + detect() for registry
```

Old parser archived to `src/frontend/src/parsers/_archive/allegro-brd-parser.old.ts` for reference during development, deleted after validation.

## File Layout

```
Offset 0x0000: File Header (~4KB)
  - Magic number (4 bytes) → version detection
  - Object count (u32)
  - Linked lists: 22 descriptors for pre-V180, 28 for V180+ (each: head key + tail key)
  - Allegro version string (60 bytes)
  - Board units (1 byte: 0x01=Mils, 0x02=Inches, 0x03=MM, 0x04=CM, 0x05=UM)
  - Units divisor (u32)
  - String count (explicit pre-V180, embedded in V180 header)
  - Layer map (256 entries × 2 u32)

Offset 0x1200: String Table
  - Repeated: [u32 id] [null-terminated string] [word-align padding]

After strings: Object Blocks
  - Repeated: [1-byte type tag] [version-conditional fields]
  - V180 files may have zero-padded gaps between block groups
```

## Version Detection

Magic number (first 4 bytes), lower byte masked:

| Magic | FmtVer | Allegro Release |
|-------|--------|-----------------|
| `0x0013_0000` | V160 | 16.0 |
| `0x0013_0400` | V162 | 16.2 |
| `0x0013_0C00` | V164 | 16.4 |
| `0x0013_1000` | V165 | 16.5 |
| `0x0013_1500` | V166 | 16.6 |
| `0x0014_04xx`–`0x0014_07xx` | V172 | 17.2 |
| `0x0014_0900`, `0x0014_0E00` | V174 | 17.4 |
| `0x0014_1500` | V175 | 17.5 |
| `0x0015_0000` | V180 | 18.0+ |

Pre-v16 (`majorVer <= 0x0012`): fundamentally different format, reject with clear error.

Detection function (for format registry): check magic high word is 0x0013/0x0014/0x0015, AND bytes 8–11 equal 1 (distinguishes from obfuscated BRD format).

## Version-Conditional Fields

KiCad's key insight: no fixed-size table. Each field is always present or conditionally present based on version threshold.

```typescript
function readCond<T>(
  stream: AllegroStream, ver: FmtVer,
  threshold: FmtVer, dir: '>=' | '<',
  reader: () => T
): T | undefined {
  const present = dir === '>=' ? ver >= threshold : ver < threshold;
  return present ? reader() : undefined;
}
```

The most significant layout change is at V172. Many fields use `COND_GE(V172)` (present in >= 17.2) or `COND_LT(V172)` (present in < 17.2). V180 introduces header layout changes.

## Coordinate System

All integer coordinates stored in internal units:

```
mils = coord / unitsDivisor
```

`unitsDivisor` read from header (typically 100 for mil-based boards). Y-axis flipped for screen display (`flipY: true` in format descriptor).

Arc center/radius: IEEE 754 doubles stored as two big-endian 32-bit words:
```typescript
function readAllegroFloat(stream: AllegroStream): number {
  const a = stream.u32();
  const b = stream.u32();
  // Combine as big-endian double
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  view.setUint32(0, a, false); // big-endian
  view.setUint32(4, b, false);
  return view.getFloat64(0, false);
}
```

Rotation: millidegrees (÷1000 for degrees). Pad rotation in 0x0D is board-absolute; subtract footprint rotation for local.

## Block Types

All ~35 block types parsed field-by-field. Organized by function:

### Component Hierarchy
| Type | Struct | Purpose |
|------|--------|---------|
| 0x06 | COMPONENT | Component/symbol definition |
| 0x07 | COMPONENT_INST | Instance with refdes string ref |
| 0x08 | PIN_NUMBER | Pin number string ref |
| 0x0F | FUNCTION_SLOT | Function slot within symbol |
| 0x10 | FUNCTION_INST | Function instance |
| 0x11 | PIN_NAME | Pin name string ref |
| 0x12 | XREF | Cross-reference pointers |
| 0x2B | FOOTPRINT_DEF | Footprint template (linked list head) |
| 0x2D | FOOTPRINT_INST | Placed footprint (position, rotation, layer) |

### Connectivity
| Type | Struct | Purpose |
|------|--------|---------|
| 0x04 | NET_ASSIGN | Links net to pad/track |
| 0x1B | NET | Net definition + name |
| 0x2E | CONNECTION | Connection/ratsnest object |
| 0x32 | PLACED_PAD | Pad instance (bounds, net link, pin chain) |
| 0x33 | VIA | Via instance (bounds, net link) |

### Geometry
| Type | Struct | Purpose |
|------|--------|---------|
| 0x01 | ARC | Arc segment (center as AllegroFloat) |
| 0x05 | TRACK | Track segment collection |
| 0x0E | RECT | Shape/fill rectangle |
| 0x14 | GRAPHIC | Graphics container |
| 0x15/16/17 | SEGMENT | Line segments (H/diagonal/V) |
| 0x23 | RATLINE | Ratsnest line |
| 0x24 | RECT | Rectangle shape |
| 0x28 | SHAPE | Polygon shape (outline, zone, fill) |
| 0x34 | KEEPOUT | Keepout area |

### Padstack & Definitions
| Type | Struct | Purpose |
|------|--------|---------|
| 0x0C | PIN_DEF | Pin/drill definition |
| 0x0D | PAD | Pad geometry and placement |
| 0x1C | PADSTACK | Full padstack (variable-size: fixed slots + per-layer components) |
| 0x1F | PADSTACK_DIM | Padstack dimensions (variable-size) |
| 0x36 | DEF_TABLE | Font/misc definitions (heterogeneous substructs) |

### Infrastructure
| Type | Struct | Purpose |
|------|--------|---------|
| 0x03 | FIELD | Property/field reference (variable-size, subtypes 0x64–0x78 with string/int/array variants — parsed per KiCad's subtype switch) |
| 0x09 | FILL_LINK | Fill-to-shape link |
| 0x0A | DRC | DRC error marker |
| 0x1D | CONSTRAINT_SET | Physical constraints (variable-size) |
| 0x1E | SI_MODEL | Signal integrity model (variable-size) |
| 0x20 | UNKNOWN | Purpose unknown |
| 0x21 | BLOB | Headered block (variable-size) |
| 0x22 | UNKNOWN | Purpose unknown |
| 0x26 | MATCH_GROUP | Diff pair match group |
| 0x27 | CSTRMGR_XREF | Constraint manager blob (skip to x27End) |
| 0x29 | PIN | Pin instance (.dra files only) |
| 0x2A | LAYER_LIST | Layer names (variable-size entry list) |
| 0x2C | TABLE | Table/lookup structure |
| 0x2F | UNKNOWN | Unknown |
| 0x30 | STR_WRAPPER | Text object |
| 0x31 | SGRAPHIC | String graphic |
| 0x35 | FILE_REF | File reference paths |
| 0x37 | PTR_ARRAY | Pointer array (variable-size) |
| 0x38 | FILM | Film definition |
| 0x39 | FILM_LAYER_LIST | Film layer list |
| 0x3A | UNKNOWN | Unknown |
| 0x3B | UNKNOWN | Unknown |
| 0x3C | UNKNOWN | Unknown |

## Header Linked Lists

22 linked-list descriptors (pre-V180), each with head and tail keys. v16/v17 stores `[tail, head]`; v18 stores `[head, tail]`.

Key lists for boardview:

| List | Points to | Used for |
|------|-----------|----------|
| `LL_0x2B` | Footprint defs | Component enumeration |
| `LL_0x1B_Nets` | Net definitions | Net enumeration |
| `LL_0x04` | Net assignments | Net→pad/track linking |
| `LL_Shapes` | 0x28 shapes | Board outline, zones |
| `LL_0x14` | Graphics | Outline segments |
| `LL_0x06` | Components | Component definitions |

Walking: start at head key → look up in DB → follow `m_Next` → stop at tail key, key 0, or sentinel. Safety limit: 1,000,000 iterations.

## Layer Encoding

Each block has a 2-byte `LayerInfo`: class code + subclass code.

Key classes:
- `0x06` ETCH: copper layers (subclass 0..N-1 = stackup order, 0=top, N-1=bottom)
- `0x15` BOUNDARY: zone boundary outlines
- `0x01` BOARD_GEOMETRY: board-level features
- `0x09` PACKAGE_GEOMETRY: footprint geometry
- `0x0D` REF_DES: reference designator text

Outline detection: BOUNDARY class OR BOARD_GEOMETRY/DRAWING_FORMAT class with subclass 0xEA or 0xFD.

Layers off by default in the renderer — stored in BoardData but not activated unless user opts in.

## Assembly: Object DB → BoardData

### Components (parts[])
```
Header LL_0x2B → 0x2B footprint def chain
  └─ 0x2D instance chain (m_Instances)
       ├─ m_InstRef → 0x07 COMPONENT_INST → m_RefDesStrPtr → string table = refdes
       ├─ m_CoordX, m_CoordY / unitsDivisor = position in mils
       ├─ m_Rotation / 1000 = degrees
       └─ m_Layer: 0=top, 1=bottom
```

### Pins (pins[])
```
Each 0x2D footprint instance:
  └─ m_FirstPadPtr → 0x32 PLACED_PAD chain (follow m_NextInFp, NOT m_Next)
       ├─ m_NetAssign → 0x04 → m_Net → 0x1B → net name string
       ├─ m_PinNumber → 0x08 → m_PinNameStrPtr → string = pin number
       ├─ Position: from linked 0x0D PAD block (m_CoordsX/Y / unitsDivisor)
       │   Fallback: 0x32 m_Bounds midpoint / unitsDivisor
       └─ m_Bounds → pin radius calculation
```

### Nets (nets[])
```
Header LL_0x1B → 0x1B NET chain
  └─ m_NetName → string table = net name
Built by existing buildNets() helper from pin→net assignments.
```

### Traces (traces[])
```
0x05 TRACK blocks (ETCH class):
  └─ m_FirstSegPtr → segment chain (0x15/16/17 lines + 0x01 arcs)
       ├─ Line: m_StartX/Y, m_EndX/Y, m_Width (all / unitsDivisor)
       └─ Arc: start/end integers + center/radius as AllegroFloat
  Net from: m_NetAssignment → 0x04 → 0x1B
```

Arcs linearized to polyline points (N segments based on sweep angle).

### Vias
```
0x33 VIA blocks:
  ├─ Position: m_Bounds midpoint / unitsDivisor
  └─ Net from: m_NetAssign → 0x04 → 0x1B
```

### Board Outline
```
Header LL_Shapes → 0x28 SHAPE chain
  Filter: BOUNDARY class, or BOARD_GEOMETRY/DRAWING_FORMAT with subclass 0xEA/0xFD
  └─ m_FirstSegmentPtr → segment chain → closed contour point array
```

## Disposal of Old Code

- Old `allegro-brd-parser.ts` (1,427 lines): archived to `src/frontend/src/parsers/_archive/allegro-brd-parser.old.ts` during development, deleted after validation passes
- Old `docs/formats/ALLEGRO_BRD_FORMAT.md`: replaced entirely with new spec based on KiCad findings
- `allegro-brd-format.ts`: updated in place (same role, corrected magic ranges + v17.5/v18.0)

## Test Strategy

Existing test files in `samples/allegroBRD/`:
- Quanta Y0D (v16.5) — should yield 1000+ components
- Acer Z8IA (v17.2) — should yield meaningful component/pin counts
- Quanta Z8I (v17.2, largest) — stress test

Tests should verify:
- Component count ≥ previous parser output (regression gate)
- All pins have valid coordinates (no NaN, no zero for placed parts)
- Net names resolved (non-empty for assigned nets)
- Traces extracted with valid geometry
- Board outline is a closed polygon (first point ≈ last point)
- Format detection rejects non-Allegro .brd files (obfuscated BRD, random binary)

## Attribution

This implementation derives structural knowledge from KiCad's Allegro importer, licensed under GPL-3.0. The TypeScript implementation is original code for BoardRipper. KiCad attribution maintained in source comments and format spec.
