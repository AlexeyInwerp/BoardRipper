# BRD (Binary Obfuscated Boardview) File Format Specification

> Reverse-engineered with reference to the [OpenBoardView](https://github.com/OpenBoardView/OpenBoardView) source.
> Sample file: `820-02935-05.brd` (Apple MacBook Pro 820-02935 logic board, 1.2 MB).

---

## Overview

BRD is a proprietary obfuscated boardview format used in Apple/Mac logic board repair.
It is **not** the Autodesk Eagle XML `.brd` format — they share only a file extension.

The file is a standard ASCII text file that has been **byte-obfuscated**: each non-whitespace
byte is transformed through a simple bit-rotation + bitwise-NOT operation, making the raw file
appear binary. After decoding, the content is plain tab/space-separated text.

| Property | Value |
|----------|-------|
| Extension | `.brd` |
| Detection | First 4 bytes: `0x23 0xE2 0x63 0x28` |
| Line endings | `0x0A` (LF only; CR, LF, NUL are **not** transformed) |
| Field separator | Spaces / tabs (post-decode) |
| Coordinate unit | Mils (thousandths of an inch) — same as BVR |

---

## Byte-Obfuscation Encoding

Each non-whitespace byte is decoded with the following operation, replicating C signed-char
semantics (source: OpenBoardView `BRDFile.cpp`):

```c
// For every byte b in the file:
if (b != '\r' && b != '\n' && b != '\0') {
    int c = (signed char)b;          // sign-extend to int
    b = ~(((c >> 6) & 3) | (c << 2)); // bit-rotate + NOT
}
```

### In TypeScript / JavaScript

```typescript
const c = (b << 24) >> 24;          // replicates signed char cast in JS
decoded = (~(((c >> 6) & 3) | (c << 2))) & 0xFF;
```

### Properties

- **Stateless** — each byte is decoded independently; no state carried between bytes.
- **Invertible** — the same function is both encoder and decoder.
- **Whitespace-preserving** — CR (`0x0D`), LF (`0x0A`), and NUL (`0x00`) are unchanged.
- **Magic bytes** — the first 4 raw bytes `23 E2 63 28` decode to `str_` (start of `str_length:`).

### Example

Raw byte `0xEB` (= -21 as signed char):
```
c   = -21
c >> 6 = -1  →  (-1) & 3 = 3
c << 2 = -84 = 0xFFFFFFAC
3 | 0xFFFFFFAC = 0xFFFFFFAF
~0xFFFFFFAF & 0xFF = 0x50 = 'P'
```

---

## File Structure (After Decoding)

The decoded file contains **6 named sections**, each introduced by a header line ending with `:`:

```
str_length:
<max_part_name_len>   <max_net_name_len>

var_data:
<n_outline>  <n_parts>  <n_pins>  <n_nails>  <origin_x>  <origin_y>

Format:
<x>   <y>         ← one outline vertex per line

Pins1:
<name>   <flags>   <cumul_pins>   ← one part per line

Pins2:
<x>   <y>   <col2>   <part_1idx>   <net_name>   ← one pin per line

Nails:
<nail_idx>   <x>   <y>   <col3>   <net_name>    ← one test-point per line
```

Sample counts from `820-02935-05.brd`:

| Section | Lines | Content |
|---------|-------|---------|
| str_length | 1 | String field widths (metadata) |
| var_data | 1 | `574  6557  25528  1076  -240  -855` |
| Format | 574 | Board outline polygon |
| Pins1 | 6557 | Part catalogue |
| Pins2 | 25528 | Pin positions and nets |
| Nails | 1076 | Test-point positions and nets |

---

## Section: str_length

One data line: `<max_part_name_len>   <max_net_name_len>`

Used for buffer allocation in the original software. Not needed by this parser.

---

## Section: var_data

One data line with 6 whitespace-separated integers:

| Field | Example | Meaning |
|-------|---------|---------|
| 0 | `574` | Number of outline polygon vertices |
| 1 | `6557` | Number of parts (Pins1 rows) |
| 2 | `25528` | Number of pins (Pins2 rows) |
| 3 | `1076` | Number of nails (Nails rows) |
| 4 | `-240` | Board origin X offset (mils) |
| 5 | `-855` | Board origin Y offset (mils) |

The origin offset is available but not applied by this parser — all coordinates are used as-is.

---

## Section: Format (Board Outline)

One polygon vertex per line, two whitespace-separated integers:

| Column | Content |
|--------|---------|
| 0 | X coordinate (mils) |
| 1 | Y coordinate (mils) |

Consecutive duplicate vertices are common and should be skipped.

---

## Section: Pins1 (Part Catalogue)

One part entry per line, three whitespace-separated fields:

| Column | Example | Content |
|--------|---------|---------|
| 0 | `R0500` | Part reference designator (e.g. R, C, U, J...) |
| 1 | `5` | Side / type flags (see below) |
| 2 | `2` | Cumulative pin count through this part |

### Side / Type Flags (column 1)

The flags byte encodes component side as individual bits:

| Bit | Mask | Meaning |
|-----|------|---------|
| 0 | `0x01` | Component present on **top** side |
| 1 | `0x02` | Component present on **bottom** side |
| 2 | `0x04` | SMD component on top |
| 3 | `0x08` | SMD component on bottom |

Common values observed:
- `5` (`0b0101`) = top SMD — most common, ~31% of parts
- `10` (`0b1010`) = bottom SMD — most common overall, ~68% of parts
- `1` = top through-hole
- `2` = bottom through-hole

To determine side: `isTop = (flags & 1) != 0`, `isBottom = (flags & 2) != 0`.

### Cumulative Pin Count (column 2)

Encodes the running total of pins assigned to all parts up to and including this one.
Used to validate part-to-pin linkage but not needed directly — use Pins2 column 3 instead.

---

## Section: Pins2 (Pin Positions)

One pin per line, 5 whitespace-separated fields:

| Column | Example | Content |
|--------|---------|---------|
| 0 | `3469` | X coordinate (mils) |
| 1 | `6616` | Y coordinate (mils) |
| 2 | `491` | Unknown (net display hint? ratsnest endpoint?) |
| 3 | `1` | **Part index** (1-based, matches row order in Pins1) |
| 4 | `PP1V2_AWAKE` | Net name (plain ASCII, may contain spaces) |

**Part linkage**: column 3 is a 1-based index into Pins1. All Pins2 rows with the same
part-index value belong to the same part. This correctly reconstructs part-to-pin relationships.

```
Pins1 row 1: R0500   → part_1idx = 1
Pins2 rows with col3 = 1: pins of R0500 (2 rows for a 2-pin resistor)

Pins1 row 2: R0501   → part_1idx = 2
Pins2 rows with col3 = 2: pins of R0501
```

**Column 2 semantics**: 988 unique values observed; not decoded. Likely a net display offset
or ratsnest endpoint used by the original boardview software for connection-line drawing.
Common values: `6` (40% of pins), `-99` (26% of pins).

---

## Section: Nails (Test Points)

One test point per line, 5 whitespace-separated fields:

| Column | Example | Content |
|--------|---------|---------|
| 0 | `1` | Nail sequence index (1-based, sequential) |
| 1 | `697` | X coordinate (mils) |
| 2 | `13146` | Y coordinate (mils) |
| 3 | `2` | Unknown type code (constant `2` in sample) |
| 4 | `PPVBUS_USBC5` | Net name |

---

## Known Unknowns

| Item | Status |
|------|--------|
| Pins2 column 2 | Not decoded — 988 unique values, possibly ratsnest display hint |
| Nails column 3 | Constant `2` in sample — type code, not decoded |
| str_length fields | Metadata only, not needed |
| var_data origin offset | Stored but not applied — coordinates are board-relative |

---

## Parser Implementation

**Decoder:** `src/frontend/src/parsers/brd-parser.ts` → `decodeBRDBytes()`
**Parser:** `src/frontend/src/parsers/brd-parser.ts` → `parseBRD()`
**Format descriptor:** `src/frontend/src/parsers/brd-format.ts`

### Detection

Magic bytes `0x23 0xE2 0x63 0x28` must match the first 4 bytes of the file.
This reliably distinguishes BRD from:
- BVR formats (begin with `BVRAW_FORMAT_` in ASCII)
- Eagle XML (begins with `<?xml`)

### Limitations

- `Pins2` column 2 is ignored; not needed for board display.
- Part type is always reported as `smd` (through-hole distinction available via flags bits 2/3
  but not used in rendering).
- Net names are stored as plain strings — special characters in net names are not escaped.

---

## References

- **Sample file:** `samples/820-02935-05.brd` (Apple MacBook Pro 16" 2023, 820-02935 board)
- **Algorithm source:** OpenBoardView — https://github.com/OpenBoardView/OpenBoardView
- **Format community documentation:** OpenBoardView issue #212 / wiki `.brd-format`
