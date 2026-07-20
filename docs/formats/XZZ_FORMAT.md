# XZZ PCB (Encrypted Boardview) File Format Specification

> Reverse-engineered with reference to the [OpenBoardView](https://github.com/OpenBoardView/OpenBoardView) source.

---

## Overview

XZZ is an encrypted binary boardview format. The file contains DES-encrypted data blocks
for parts, pins, nets, and board outline geometry. The header may be XOR-obfuscated.

| Property | Value |
|----------|-------|
| Extension | `.pcb` |
| Detection | First 6 bytes = `XZZPCB` (plain or XOR-obfuscated) |
| Encryption | DES (FIPS PUB 46-3), ECB mode |
| DES key | `0xdcfc12ac00000000` (fixed, hardcoded) |
| Coordinate unit | Internal units ÷ 10000 = mils |
| XOR obfuscation key | Byte at offset `0x10` |

### `.pcb` extension collision — Mentor PADS Layout binary

The `.pcb` extension is also used by **Mentor PADS Layout (PowerPCB) native binary
design files**, which are an entirely different and unsupported format (the PADS
database, not a boardview). They begin with the 10-byte signature `00 FF 26 20`
followed by six zero bytes and carry PADS markers in the body (`DOC_PARTTYPES`,
`DOC_PADS`, `DOC_VIAS`, `STANDARDVIA`). `isPadsBinaryHeader()` recognises them so
both `XZZFormat.detect()` and `parseXZZ()` reject them up-front with a clear
"this is a PADS Layout binary, not a boardview" message — otherwise the `.pcb`
extension fallback would hand them to the XZZ parser, which XOR-mangles the bytes
(PADS files have a non-zero byte at `0x10`) and dies on "invalid header offsets".
Even FlexBV does not open these; the binary PADS database is left unsupported.

---

## File Structure

### Header

```
┌─────────────────────────┐
│ 6 bytes: "XZZPCB" magic │  (may be XOR-obfuscated)
├─────────────────────────┤
│ Header fields            │  file metadata, block offsets
│  (variable layout)       │
└─────────────────────────┘
```

#### XOR Obfuscation

If the first 6 bytes don't spell `XZZPCB` in plain text, the header is XOR-obfuscated:
- XOR key = byte at offset `0x10`
- Apply `byte ^ key` to each header byte to recover plain text
- Verify by checking if decoded bytes 0–5 = `XZZPCB`

### Data Blocks

After the header, the file contains sequential data blocks. Each block is DES-encrypted
and must be decrypted before parsing.

Block types:
- **Net block** — net index → net name mapping
- **Part blocks** — component data with embedded pin sub-blocks
- **Outline segments** — board outline geometry (line segments on layer 28)

---

## Encryption

### DES Parameters

- Algorithm: DES (Data Encryption Standard, FIPS PUB 46-3)
- Mode: ECB (each 8-byte block encrypted independently)
- Key: `0xdcfc12ac00000000` (64-bit, fixed)
- Decryption: standard 16-round Feistel network with reversed subkey order

### Block Decryption

Each data block is decrypted as a sequence of 8-byte DES blocks. Trailing bytes (< 8) are
left as-is.

---

## Data Structures

### Net Block

Sequential entries, each containing:

```
┌──────────────┐
│ u32: netSize  │  Total entry size in bytes
├──────────────┤
│ u32: netIndex │  Net identifier (referenced by pins)
├──────────────┤
│ name bytes    │  Null-terminated string (netSize - 8 bytes)
└──────────────┘
```

### Part Block

After DES decryption:

```
┌──────────────────┐
│ u32: partSize     │
├──────────────────┤
│ 18 bytes: unknown │
├──────────────────┤
│ u32: groupNameLen │
│ groupName bytes   │
├──────────────────┤
│ 0x06 marker byte  │
│ 30 bytes: unknown │
├──────────────────┤
│ u32: nameLen      │
│ partName bytes    │  Reference designator
├──────────────────┤
│ Pin sub-blocks... │  Sequential pin data
└──────────────────┘
```

### Pin Sub-Block

Within a part block, pins are encoded as typed sub-blocks:

```
┌──────────────────┐
│ u32: pinBlockSize │
├──────────────────┤
│ 4 bytes: unknown  │
├──────────────────┤
│ i32: x            │  Pin X position (÷ 10000 for mils)
│ i32: y            │  Pin Y position (÷ 10000 for mils)
├──────────────────┤
│ u32: zero         │  Constant 0
│ u32: padAngle     │  Pad rotation in degrees CCW (÷ 10000)
├──────────────────┤
│ u32: nameLen      │
│ name bytes        │  Pin name
├──────────────────┤
│ 27 bytes: pad geom│  3 × (u32 padW, u32 padH, u8 shape) — three identical
│                   │  copies (top/inner/bottom?); w/h ÷ 10000 for mils;
│                   │  shape 0x01 = round, 0x02 = rect
├──────────────────┤
│ 5 bytes: padding  │
├──────────────────┤
│ u32: netIndex     │  Reference into net block
└──────────────────┘
```

**Oblong pads (shape 0x01 with w ≠ h).** Shape `0x01` is not strictly a
circle: with w ≠ h it encodes a round-capped stroke (stadium) — `w` is the
pen width, `h` the stroke length, rotated by `padAngle` CCW. The surveyed
MECHREVO corpus (PL5TU1B) writes a constant 15-mil pen with lengths 1–350
mil. Renderer draws these as rotated capsules (`capsuleParams` in
`renderer/pad-capsule.ts`). Three caveats, handled by
`normalizeOblongPads` in the parser (run before the butterfly fold):

1. **Bogus lengths on BGA perimeter rings.** CPU1's outer 2–3 ball rings
   carry 15×300/350 entries that would cross a dozen neighbouring balls;
   the vendor's own assembly drawing shows plain 15-mil dots there
   (probably escape-stub metadata, not pad copper).
2. **One angle per part.** The exporter stamps a single `padAngle` on every
   pin of a part, but a QFP's top/bottom leads are physically perpendicular
   to its left/right leads (EC1: all 128 pins say 270°).
3. **Degenerate strokes** (h ≤ w, e.g. 15×1) — effectively dots drawn with
   the 15-mil pen.

The guard is physical — copper pads of different pins can never overlap:
an oblong is kept at its declared angle if it touches no same-part
neighbour's pen circle, else retried at +90° (fixes the QFP sides), else
collapsed to a pen-width round dot. A majority pass then collapses
gap-threading stragglers of a mostly-bogus (w, h) group (CPU1 pin W1).

**Placeholder pad geometry.** Some exports — all surveyed M2-era Apple board
files (820-02773, 820-02862, and the `-H`/`-L` CPU variants of 820-02098 /
820-02100 / 820-02382) — write the SAME pad geometry on every pin of the file:
12×12 mil, shape `round`, angle 0. This is exporter filler, not real pad data
(a 125-mil coil pad and a BGA ball get the identical 12-mil dot). Real-geometry
files carry 180+ distinct sizes, so the two populations are cleanly separable.
The parser detects the placeholder (≥100 geometry-carrying pins, every one
sharing a single identical `(w, h, shape, angle)`, shape round, w = h) and
drops pad geometry entirely for that file — pins fall back to the classic
radius-8 dot and the renderer synthesizes the classic FlexBV 2-pin pads.

---

## Board Outline

The outline is constructed from line segments on layer 28 (`OUTLINE_LAYER`).
Segments are chained into a polygon using a greedy nearest-neighbor algorithm:
1. Start with segment 0
2. For each subsequent segment, find the nearest unvisited endpoint
3. Append the far endpoint to the chain

---

## Coordinate System

- Raw coordinates are signed 32-bit integers
- Divide by 10000 (`XZZ_SCALE`) to get mils
- The `flipY` flag is enabled for this format

---

## Parser Notes

- Side detection: part side is inferred from sub-block type bytes within the part data.
- Pin radius defaults to 7 mils.
- The DES implementation uses precomputed SP (S-box + P permutation) lookup tables and
  byte-level IP/FP permutation tables for performance.
- BigInt is used only for one-time key schedule computation at module initialization.

---

## Diode-Value Channel (post-`v6` table)

XZZ ships companion `.pcb` files named `… Middle layer diode value-<board>.pcb`
that carry reference ("golden board") **diode-mode multimeter readings**. The
readings are **not** geometry — they live in a plaintext table appended after
the `v6v6555v6v6` XOR-boundary marker (so they are never XOR'd or DES'd), past
the net block.

```
v6v6555v6v6===<4 binary bytes>\n
=359=N47(21)
=0=N47(31)
=OL=N46(1)
=732=N47(7)
…
```

- Grammar: newline-delimited `=<value>=<partName>(<pinNumber>)`, **one record
  per pin**.
- Value classes: integer **millivolts** (e.g. `359`), `OL` (open / infinite),
  `0` (no reading / tied to ground). A rare malformed token like `312.` is
  tolerated (trailing dot stripped).
- Join key `PART(pinNumber)` maps 1:1 onto the parser's pins — this is why the
  parser now preserves the real pad number (`Pin.number`) instead of a 1-based
  index.

`parseDiodeSection()` returns `Map<"PART(PIN)", DiodeReading>`; the join stamps
`Pin.diode` and sets `BoardData.diodeReference` (counts + match diagnostics).
Normal boardviews have no marker → empty map → no channel. The readings are
surfaced on-pin (toggleable overlay), in the hover tooltip, and in the
ComponentInfo pin table; OpenBoardData provides a second, per-net source feeding
the same surfaces (see `store/diode-readings.ts`).
