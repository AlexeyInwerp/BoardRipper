# Cadence Allegro BRD Binary Format

Proprietary binary PCB design format from Cadence. All information here comes from
community reverse engineering — primarily the [brd_parser](https://github.com/bernayigit/brd_parser)
project by Jeff Wheeler.

## Version Detection

First 4 bytes (uint32 LE) encode the Allegro software version:

| Magic           | Version  |
|-----------------|----------|
| `0x00130000/02` | 16.0     |
| `0x00130402`    | 16.2     |
| `0x00130C03`    | 16.4     |
| `0x00131003`    | 16.5     |
| `0x0013150x`    | 16.6     |
| `0x001404xx`    | 17.2     |
| `0x001409xx`    | 17.4     |

Pattern: high word `0x0013` = v16.x, `0x0014` = v17.x.
Additional check: bytes 8–11 as uint32 LE = 1 (distinguishes from obfuscated BRD).

## File Layout

```
Offset     Content
──────────────────────────────────────
0x0000     Header (~936 bytes)
           ├─ magic (u32): version
           ├─ object_count (u32)
           ├─ 25 linked-list head/tail pairs
           ├─ allegro_version[60]: ASCII string
           ├─ max_key (u32)
           ├─ x27_end_offset (u32)
           └─ strings_count (u32)
~0x03C0    Layer map: 25 × 2 × u32 pairs
0x1200     Strings table
           ├─ id (u32) + null-terminated string + word padding
           └─ Repeated strings_count times
variable   Record stream
           ├─ Type byte (0x01–0x3C)
           ├─ Version-dependent fixed or variable size
           ├─ x27 "jump" skips large design data blob
           └─ Null gaps (padding, up to 50KB)
EOF        End of records (0x00 byte)
```

## Encoding

- **Byte order**: Little-endian throughout
- **Alignment**: All records and strings word-aligned (4-byte boundaries)
- **Coordinates**: Signed 32-bit integers. Divide by 100 for mils.
- **Rotation**: Unsigned 32-bit, millidegrees (divide by 1000 for degrees)
- **String obfuscation**: Some variants use bit-rotation: `x = ~(((c >> 6) & 3) | (c << 2))`

## Key Record Types

| Type | Name | Data Extracted |
|------|------|----------------|
| x06  | Component definition | String refs (name, footprint) |
| x07  | Instance | refdes_string_ref → component name |
| x0D  | Pin definition | str_ptr → pin name |
| x1B  | Net | net_name → strings table |
| x04  | Net/shape pair | Links nets to shapes/pins |
| x2A  | Layer names | Layer list with properties (top/bottom/signal/power) |
| x2D  | Placed symbol | Position, layer, rotation, first pin pointer |
| x32  | Symbol pin | Position (bbox), net link, pin chain |
| x28  | Shape | Board outline (bounding box) |
| x15/x16/x17 | Line segments | Copper traces with width |

## Record Size Tables

Sizes vary by version. Empirically verified against complete files.

### v16.5 (485K records, 100% coverage)

```
x01=80  x02=36  x04=20  x05=60  x06=36  x07=40  x08=24  x09=44
x0A=68  x0C=56  x0D=40  x0E=60  x0F=56  x10=32  x11=24  x12=28
x14=32  x15=40  x16=40  x17=40  x1B=56  x20=40  x22=40  x23=84
x26=20  x28=68  x2B=72  x2C=36  x2D=64  x2E=36  x2F=32  x30=44
x32=76  x33=72  x34=32  x37=428 x38=64  x39=60  x3A=16
```

### v17.2 (14K+ records, 98%+ coverage)

```
x02=72  x05=72  x06=40  x07=48  x09=48  x0A=44  x0B=72  x0C=72
x0D=44  x0E=68  x0F=60  x10=36  x11=28  x12=28  x14=36  x1B=60
x23=88  x2B=76  x2D=72  x33=76  x34=36  x3A=16
```

## Data Extraction Chain

```
x2D (placed symbol)
 ├─ layer byte → component side (top/bottom)
 ├─ coords[2] → position (÷100 for mils)
 ├─ inst_ref → x07 (instance)
 │   └─ refdes_string_ref → strings table → "U1", "R42", etc.
 └─ first_pad_ptr → x32 (pin chain)
      ├─ coords[4] → pin bounding box (÷100 for mils)
      ├─ ptr1 → x04 → x1B → net name
      ├─ ptr5 → x0D → pin name
      └─ next → next x32 (or x2D/x2B = end of chain)
```

## Limitations

- ~96% of the file is the x27 design data blob. The sequential parser extracts
  components/layers from the pre-x27 region but pins/nets are mostly in the blob.
- No official documentation exists — all knowledge is reverse-engineered.
- Record sizes change across versions; untested versions may parse incorrectly.

## References

- [brd_parser](https://github.com/bernayigit/brd_parser) — C++ parser (MIT license)
- [KiCad 10 Allegro importer](https://gitlab.com/kicad/code/kicad) — Production C++ parser
- [OpenBoardView Issue #62](https://github.com/OpenBoardView/OpenBoardView/issues/62)
