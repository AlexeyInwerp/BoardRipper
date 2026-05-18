# FZ (ASUS Boardview) File Format Specification

> Reverse-engineered with reference to the [OpenBoardView](https://github.com/OpenBoardView/OpenBoardView) source (`FZFile.cpp`).

---

## Overview

FZ is a proprietary boardview format used by ASUS motherboards. Files are RC6-encrypted and
zlib-compressed. After decryption and decompression, the content is `!`-delimited text with
named data blocks.

| Property | Value |
|----------|-------|
| Extension | `.fz` |
| Detection | Bytes 4–5 = zlib signature (`0x78 0x9C` / `0x78 0xDA`) when unencrypted |
| Encryption | RC6 stream cipher (modified byte-at-a-time, not standard block mode) |
| Compression | Zlib (deflate) |
| Key size | 44 × uint32 (176 bytes) |
| Coordinate unit | Mils (default) or millimeters (via `UNIT:` directive) |

---

## File Structure

### Binary Layout

```
┌──────────────────┐
│ 4 bytes: header   │  (purpose unknown — skipped)
├──────────────────┤
│ Content section   │  zlib-compressed `!`-delimited text
│  (variable size)  │
├──────────────────┤
│ Description sect. │  zlib-compressed tab-delimited BOM text
│  (variable size)  │
├──────────────────┤
│ 4 bytes: descSize │  uint32 LE — size of description section
└──────────────────┘
```

- **Content section**: starts at offset 4, ends at `fileSize - descSize`
- **Description section**: starts at `fileSize - descSize`, ends at `fileSize - 4`
- **descSize**: last 4 bytes of file (uint32 LE)

### Encryption

If the file is encrypted, the entire byte stream (after the 4-byte header) is RC6-encrypted.
Detection: if bytes 4–5 are NOT a valid zlib signature, assume encrypted.

The RC6 cipher uses a modified byte-at-a-time stream mode (not standard ECB/CBC block mode).

#### Key sourcing

BoardRipper **does not bundle the RC6 key**. The 44 × uint32 key required to
decrypt ASUS-produced `.fz` files is third-party material that we neither
authored nor reverse-engineered ourselves. Upstream OpenBoardView takes the
same position: `FZFile::getBuiltinKey()` returns an empty array, and the user
must supply the key at runtime.

When the parser encounters an encrypted file with no configured key (or a key
that fails to produce a valid zlib stream after decryption), it throws
`FZKeyError` and the UI opens the **FZ key dialog**. The dialog gives the user
two options:

1. **Fetch from GitHub** — one-click pull. The store tries each public mirror
   in `FZ_KEY_SOURCES` until one yields a parity-valid key:
   - `https://raw.githubusercontent.com/cryptonek/illegal-numbers/main/FZkey.md` (primary, since 2022)
   - `https://raw.githubusercontent.com/yliu-d/illegal-numbers/main/FZkey.md` (fork mirror)

   Note: `cyrozap/pcbrepair-rs/src/crypto.rs` also publishes a 44-word
   `FZ_EXPANDED_KEY` constant but its last word (`0x0945692e`) is corrupted
   — fails the parity fingerprint and won't decrypt — so it is intentionally
   excluded from the fallback list.
2. **Paste manually** — the user pastes 44 hex words from any source they
   trust.

Either path validates the input against the 44-bit parity fingerprint (the
same fingerprint that upstream OpenBoardView ships in `getKeyParity()`) before
persisting it to `localStorage` under the key `boardripper-fz-key`. A key that
fails parity is rejected with an inline error.

This puts the legal posture of distributing the key on the user, not on
BoardRipper. Users in jurisdictions where retrieving the key is restricted can
decline and continue using BoardRipper's other ten formats normally.

### Decompression

Both content and description sections are independently zlib-compressed. The description
section may be empty or malformed (non-fatal).

---

## Content Format

After decompression, the content is `!`-delimited text with block headers and data records.

### Block Structure

```
A!<block_name>!<field1>!<field2>!...    ← Block header
S!<value1>!<value2>!...                 ← Data records
S!<value1>!<value2>!...
```

- Lines starting with `A` define block headers (column names)
- Lines starting with `S` contain data records
- Fields are separated by `!`

### REFDES Block (Components)

```
A!REFDES!CIC!SNAME!MIRROR!ROTATE!
S!U1!IC1!QFP48!YES!90!
S!R1!RES1!0402!NO!0!
```

| Field | Description |
|-------|-------------|
| `REFDES` | Reference designator |
| `CIC` | Component instance class |
| `SNAME` | Shape/footprint name |
| `MIRROR` | `YES` = top side, `NO` = bottom side (inverted from typical convention) |
| `ROTATE` | Rotation angle in degrees |

### NET_NAME Block (Pins)

```
A!NET_NAME!REFDES!PIN_NUMBER!PIN_NAME!X!Y!TEST_POINT!RADIUS!
S!VCC!U1!1!VDD!1500!2000!0!50!
```

| Field | Description |
|-------|-------------|
| `NET_NAME` | Net this pin belongs to |
| `REFDES` | Parent component reference designator |
| `PIN_NUMBER` | Pin number (may be `0` for unnamed) |
| `PIN_NAME` | Pin function name |
| `X`, `Y` | Pin position (in current unit) |
| `TEST_POINT` | Test point flag |
| `RADIUS` | Pin radius (divided by 100, minimum 0.5, then multiplied by unit) |

### TESTVIA Block (Test Points / Nails)

```
A!TESTVIA!...
S!Y!GND!R1!1!PAD1!500!600!T!25!
```

| Field | Description |
|-------|-------------|
| `Y` | Always `Y` (confirmation flag) |
| `NET_NAME` | Net name |
| `REFDES`, `PIN_NUMBER`, `PIN_NAME` | Component reference |
| `X`, `Y` | Position |
| `LOCATION` | `T` = top, `B` = bottom |
| `RADIUS` | Nail radius |

---

## Description Section (BOM)

Tab-delimited text with component descriptions. After decompression:

```
<header line>
<column names>
<partno>\t<description>\t<quantity>\t<locations>\t<partno2>
```

- `locations` is a comma-separated list of reference designators
- Currently parsed but not displayed (BoardData has no BOM field)

---

## Units

The content may contain a `UNIT:<value>` directive:
- `UNIT:MILLIMETERS` — coordinates are in millimeters (multiplied by 25.4 to convert to mils)
- Default (no directive) — coordinates are in mils

Regional variants may use commas as decimal separators; the parser normalizes these to dots.

---

## Parser Notes

- No explicit board outline — generated from pin bounding box with 20-mil margin.
- The `flipY` flag is enabled for this format.
- Encrypted files fall through content-based detection; extension-based fallback handles them.
- RC6 key validation uses per-word parity check (44 hardcoded parity bits).
