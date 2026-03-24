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
│ 8 bytes: unknown  │
├──────────────────┤
│ u32: nameLen      │
│ name bytes        │  Pin name
├──────────────────┤
│ 32 bytes: unknown │
├──────────────────┤
│ u32: netIndex     │  Reference into net block
└──────────────────┘
```

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
