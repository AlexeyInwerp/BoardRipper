# Allegro v15.x BRD File Format Specification

> Reverse-engineered Cadence Allegro binary PCB format family (magic `0x00120000`–`0x0012FFFF`).
> Target versions: v15.0–v15.7. Sibling format to v16+ (magic `0x0013FFFF`), with divergent header and block-table layout.

---

## Overview

Allegro v15.x is the binary PCB database format used by Cadence Allegro PCB Editor v15. The version-string field in our corpus carries strings like `allv15-57/13/...` (Allegro 15.5.7), suggesting Cadence's mid-decade release line. The v16+ family (magic `0x0013XXXX`) added a refactored header layout and updated block-table; v15 (magic `0x0012XXXX`) is a different binary even though many block payloads are likely shared.

What we know for certain (confirmed from the dumper output and the existing v16+ parser):

| Property | Value |
|----------|-------|
| Format family | Cadence Allegro (v15.x) |
| Magic codes (observed) | `0x00120206` (`v13tl-0629`), `0x00120A06` (`COMPAL LA-7321P`) |
| Outer detection | Bytes [0..3] family `0x0012`, bytes [8..11] == `0x00000001` (same Allegro discriminator as v16+) |
| Encoding | Binary, little-endian u32/u16/u8, same as v16+ |
| Version string | Offset `0xF8`, 60-byte fixed field, NUL-padded — same offset as pre-v18 v16/v17 |
| Coordinate unit | Mils (assumed; matches every other known Allegro-family format) |

## Phase 0.5 Findings (2026-05-02)

The header and string table layout for v15 are **identical to v16/v17 pre-V172**. Only the post-string-table block region diverges. Verified by running the existing v16+ `parseHeader()` and `parseStringTable()` against both corpus files with the magic switch temporarily mapping `0x00120200` and `0x00120A00` → `FmtVer.V_166`.

### What works unchanged

| Region | v15 vs v16/v17 | Evidence |
|---|---|---|
| Magic + first 5 fixed fields (0x00..0x14) | Identical | `m_Unknown1a`=0x03, `m_FileRole`=0x01, `m_Unknown1b`=0x03, `m_WriterProgram`=0x09 in both v15 files |
| `m_ObjectCount` (0x14) | Identical | LA-7321P: 604,787; v13tl-0629: 674,856 — both plausible |
| `m_UnknownMagic` (0x18) | Identical, value `0x000A0D0A` | KiCad's `allegro_pcb_structs.h:299` documents this as a known constant `"This is always 0x000a0d0a?"`. Both v15 files match exactly. |
| `m_UnknownFlags` (0x1C) | Same field shape, value in observed range (0x05000000 / 0x00000000) | Within KiCad's documented range "0x01000000, 0x04000000, 0x06000000" |
| `m_Unknown2_preV18[7]` (0x20..0x3C) | Same shape, same documented invariants ([3]==[4], [5]≈[6]) | LA-7321P: [3]=[4]=0x7530, [5]=[6]=0x85; v13tl-0629: [3]=[4]=0x7530, [5]=0x228≈[6]=0x1BD |
| 22 linked-list pairs | Same shape, walks cleanly | Existing parser consumes them without bounds error |
| Version string (0xF8, 60 bytes, NUL-padded) | Identical | "allv15-57/13/allv15-55/9/2..." and "allv15-57/13/mbsv15-57/11/..." parse correctly |
| Layer map (25 × 2 u32 pairs near 0x428) | Identical | Existing parser walks to end of header without divergence |
| `m_StringCount_preV18` location | Identical | LA-7321P reads 1775; v13tl-0629 reads 2843 — both produce sane string counts |
| String table at 0x1200 | **Identical format** ([u32 id][cString][word-align padding]) | All strings parse to readable, real values. LA-7321P first 25 strings are net names from the .cad oracle (`LPC_CLK0`, `BATT_TEMP`, `DDR_A_D31`, …); v13tl-0629 first strings are drill-symbol names (`DRILLSYMB9`, …). |

**Implication:** the existing pre-V180 codepath in `parseHeader()` and `parseStringTable()` handles v15 unchanged. Phase 1 (magic registration) and Phase 2 (string table) of the implementation plan collapse to a 5-line change in `formatFromMagic`.

### Block region — per-type contiguous layout

v16+ stores blocks as a single interleaved stream `[type-byte][payload][type-byte][payload]...`. v15 stores blocks **per-type contiguously**: each linked-list group occupies a single contiguous file region, no inline type tag, fixed stride per region.

Each v15 block record has a 4-byte prefix `[0x00][typeTag][subType][0x00]` followed by the same field layout KiCad documents for the equivalent v16 pre-V172 struct (the v16 struct's 1-byte type-tag + 2-byte filler maps to v15's 4-byte prefix).

**Block-type signatures observed (byte 1 of prefix = v15 type tag):**

| Tag (b1) | KiCad type | Stride | Count (LA-7321P) | Count (v13tl-0629) |
|---|---|---|---|---|
| `0x18` | `BLK_0x06_COMPONENT` | 36 | 158 | 443 |
| `0xAC` | `BLK_0x2B_FOOTPRINT_DEF` | 68 | 219 | 703 |
| `0xB4` | `BLK_0x2D_FOOTPRINT_INST` (placed) | 60 | 1909 | 1368 |
| `0xB6` | sibling of `0xB4` (placement variant) | 60 | small | small |
| `0x32` `0x52` `0x6C` `0x70` `0xC0` `0xDC` etc. | unmapped — future RE | varies | n/a | n/a |

(Counts vs. CAD oracle: 1909 / 1914 placements = 99.7% match for LA-7321P.)

### Key↔offset addend

Each "key pool" in the file has a constant addend such that `m_Key = file_offset + addend`. We've identified one pool that contains LL_0x06, LL_0x2B, LL_0x1B_Nets, LL_0x1C, LL_0x1D_0x1E_0x1F: addend = `LL_0x06.head − string_table_end_offset`. For LA-7321P this is `0x07AD8140`; for v13tl-0629 it's `0x081E174C`.

Other LLs (`LL_0x04`, `LL_0x14`, `LL_0x24_0x28`, `LL_0x03_0x30`, `LL_0x0A`, `LL_0x38`, `LL_0x2C`, `LL_0x0C_2`) have **different** addends — v15 appears to use multiple memory pools. Per-pool addend can be discovered by searching the file for the head-key u32 pattern; the location at offset `O+4` (where `O+0..O+3` is a valid prefix) gives a record's m_Key, so `addend = head_key − O`.

### Verified record layouts

**`BLK_0x06_COMPONENT` (36 bytes):**
```
+0x00  prefix `00 18 0X 00`
+0x04  m_Key             (u32)
+0x08  m_Next            (u32)
+0x0C  m_CompDeviceType  (u32, → string)
+0x10  m_SymbolName      (u32, → string; same value as DeviceType in observed records)
+0x14  m_FirstInstPtr    (u32, → BLK_0x07; cross-pool pointer)
+0x18  m_PtrFunctionSlot (u32)
+0x1C  m_PtrPinNumber    (u32, → BLK_0x08)
+0x20  m_Fields          (u32, → BLK_0x03)
```
Sample resolved DeviceType strings from LA-7321P: `SI7840DP-T1-E3_SO8`, `PD10943-T7_SOD323-2`, `R0603_SHORT`, `M25P80-VMW6TP_SO8`.

**`BLK_0x2B_FOOTPRINT_DEF` (68 bytes):**
```
+0x00  prefix `00 ac 01 00`
+0x04  m_Key
+0x08  m_FpStrRef        (u32, → string for footprint name)
+0x0C  m_Unknown1
+0x10  m_Coords[4]       (4× s32, signed footprint-local bbox)
+0x20  m_Next
+0x24  m_FirstInstPtr    (u32, → BLK_0x2D)
+0x28..0x40  7×u32 unknown pointers (last 2 typically 0)
```
Sample resolved footprint names: `KC_FBMA-L10-160808-301LMT_2P`, `AO4712L_SO8`, `MX25L1606EM2I-12G_SO8`.

**`BLK_0x2D_FOOTPRINT_INST` (60 bytes):**
```
+0x00  prefix `00 b4 0X 00`  (0X is per-instance sub-type / index)
+0x04  m_Key
+0x08  unknown (zero in head record; nonzero in others — possibly m_Flags + m_Rotation)
+0x0C  unknown
+0x10  m_CoordX (s32, board-absolute, mils × divisor)
+0x14  m_CoordY (s32)
+0x18  m_FpDefRef        (u32, → BLK_0x2B parent footprint definition)
+0x1C  m_CompDefRef      (u32, → BLK_0x06 component definition)
+0x20  ?                  (u32, pool-1 — possibly m_GraphicPtr or m_InstRef → BLK_0x07)
+0x24  ?                  (u32, pool 0x086 — different pool)
+0x28  ?                  (u32, pool 0x088 — possibly m_FirstPadPtr → BLK_0x32)
+0x2C  zero
+0x30  ?                  (u32, pool 0x087 — possibly m_TextPtr → BLK_0x30)
+0x34..0x38  zero
```
Records are NOT grouped per-footprint within their region; consecutive records reference different `m_FpDefRef` values. Walker scans sequentially with stride 60, validating prefix shape `00 b4 ?? 00`. Records of the same parent footprint can be discovered post-hoc by grouping on `m_FpDefRef`.

### BLK_0x32 placed-pad region — partial RE lead

`BLK_0x2D` field `+0x28` (cross-pool pointer) for the head record (`m_Key=0x07b20784`, `CoordY=-83450`) holds value `0x0881a6e4`. The file contains this u32 at offset `0xb9e8c0`. The 8 bytes immediately following (`+0x04` and `+0x08` from that offset) are:

```
0xb9e8c0:  e4 a6 81 08   ← m_Key = 0x0881a6e4 ✓
0xb9e8c4:  2a d3 fd ff   ← i32 = -147670  (looks like x_min of a pad bbox)
0xb9e8c8:  06 ba fe ff   ← i32 = -83450   (matches BLK_0x2D #1 CoordY exactly)
```

The matching CoordY is strong evidence this is the placed-pad record for BLK_0x2D #1's first pin. However, bytes immediately preceding (`0xb9e8bc`) are `74 eb 73 08` — *not* the `00 XX YY 00` v15 prefix shape we see on BLK_0x06/2B/2D. KiCad's `BLK_0x32` struct begins with `u8 m_Type` + `LAYER_INFO` (2 bytes) before `m_Key`, so v15 BLK_0x32 may use a 3-byte prefix (matching the v16 layout) instead of the 4-byte aligned prefix used by other v15 block types. The bytes at `0xb9e8bd..0xb9e8bf` (= `eb 73 08`) would then be `m_Type=0xEB`, `LAYER_INFO classCode=0x73, subclass=0x08`. Those values are plausible Allegro layer codes.

This means BLK_0x32's prefix and offset math differs from the rest of pool 1. Needs a dedicated probe + walker — deferred to follow-up.

**Layout probe attempt (failed but informative):** Tried KiCad's pre-V172 `BLK_0x32_PLACED_PAD` layout starting at `0xb9e8bd` (3-byte prefix `eb 73 08` = m_Type + layerClass + layerSub, then m_Key at +3). Most decoded fields are nonsense — but the nonsense is *itself* a clue:
- `m_ParentFp` decodes to `0xfb11c400` — should be `0x07b20784` (BLK_0x2D #1's key) if parent
- `m_NextInFp` decodes to `0x0079616b` — those are ASCII bytes `kay\0`
- `m_NextInCompInst` decodes to `0x54524150` — ASCII `PART`
- Bytes at +0x2c through +0x33 spell `"PART#\0\0\0\0"` — a pin/pad name fragment

**The ASCII fragments are pin names embedded inline** (similar to how BLK_0x07 inlines refdes). v15 `BLK_0x32` likely has a *variable-length* record with one or more NUL-terminated pin-name strings — not the fixed-stride layout v16+ uses with string-table pointers. A walker for v15 BLK_0x32 needs to:
1. Read fixed-width header fields (m_Key, padCoordX, padCoordY, flags)
2. Read inline pin-name string(s), advancing past the NUL terminator
3. Resume reading fixed fields after string padding

The first BLK_0x32 record's `padCoordY = -83450` matches L124's CoordY exactly, confirming the region IS pad data — just stored differently than the v16+ layout.

The bytes around offset `0xb9e8bd` clearly contain pad-related data (CoordY match is exact, embedded ASCII suggests pin name like `PART#`), but the field-to-byte mapping differs from KiCad's v16+ struct. v15 BLK_0x32 may have:
- A different prefix size (not 3 bytes, not 4 bytes — something else)
- Inline string fields (vs v16's pointer-based name lookup)
- A reordered or expanded set of fields

Identifying the correct layout requires either:
- More v15 sample diversity (e.g. find a sample where pin coordinates exactly match a known board's drawn coords from the .cad oracle, then back-solve)
- Or comparison with a v15.x source (Cadence Allegro Free Physical Viewer, if it can export pin data)

### Verified additional layouts (2026-05-03 push 2)

**`BLK_0x07_COMPONENT_INST` (64 bytes):**
```
+0x00  prefix `00 1c 00 00`
+0x04  m_Key
+0x08  m_RefDes (32-byte inline NUL-padded ASCII string — v15 inlines refdes
        directly; v16+ uses a string-table pointer)
+0x28  back-pointer to BLK_0x06 (component def)
+0x2C..0x3C  4 more pointers (unknown role)
```
**Verified**: first 5 records resolve to `L124, CLRP1, PQ306, U11, U32` — exact match with the .cad oracle's first 5 part refdes for LA-7321P. Same exact match for v13tl-0629's first 10: `CN5, CN1008, CN6, C1361, C1360, C1359, C1358, C1357, C1356, C1355`.

**BLK_0x2D refinement — layer + rotation decoded:**
- Prefix byte 2 (the "sub-type counter") is the layer flag: `0x00` = top, `0x01` = bottom. Verified by population split — LA-7321P 1178/731 = 62%/38% top/bottom; v13tl-0629 619/749 = 45%/55%. Realistic for motherboards.
- `+0x0C u32` = rotation in millidegrees (matches KiCad's pre-V172 m_Rotation semantics). Recognizable values: `0x0002BF20 = 180000 = 180°`, `0x00015F90 = 90000 = 90°`, `0x00041EB0 = 270000 = 270°`.
- `+0x1C` is the `m_InstRef` pointer to BLK_0x07 — verified by traversing the link and getting the matching refdes.

**LL_0x14 partial probe:**

Head record at file offset `0x47F44C` (LA-7321P). Layout differs from BLK_0x06/2B/2D — first u32 is a back-pointer (not a `00 XX YY 00` prefix), m_Key is at `+0x04`. Stride needs more investigation. Visible coord-like fields:
- `+0x10`, `+0x14` = signed i32 (e.g. `-120392, 50111`) — likely line segment endpoint
- `+0x18`, `+0x1C` = signed i32 (e.g. `-120498, 50038`) — second endpoint
- Coords don't match board coordinate scale (board is ~7800 × 7500 mils, these values are 15× larger) — possibly nanometer-scaled or in a footprint-local scale.

LL_Shapes head `0x0958f3b0` is in yet another pool with addend not yet decoded.

### byte1=0x32 record probe

A v15 record with prefix byte 1 = `0x32` exists at file offset `0x47A28` for LA-7321P. Layout:
- prefix `00 32 00 00`
- +0x04 m_Key = `0x07b1fb90` (pool 1 keys but addend doesn't match — this record's m_Key/offset relation differs from BLK_0x06/2B/2D/0x07)
- +0x08 = `0x07b3ca38` (pointer)
- +0x28 begins a BLK_0x2B record (`0003ac00` prefix), implying byte1=0x32 record is exactly 40 bytes

These records do NOT form contiguous runs (search found only this single occurrence). Probably scattered as sub-records or pre-amble entries. **Not the same as BLK_0x32_PLACED_PAD** despite the matching byte1.

### byte1=0x20 record probe (BLK_0x06.m_PtrPinNumber destination)

BLK_0x06 #0's `m_PtrPinNumber = 0x0957cad8` resolves at file offset `0x1368e48` to a record with prefix `00 20 00 00`. Bytes after m_Key contain `0x32 = 50` — possibly pin count (though SI7840DP_SO8 is an 8-pin part, so 50 doesn't fit as count for that specific component). Could be a "pin number list" header pointing to BLK_0x08 records elsewhere. Pool 0x095 — different addend from pool 1.

### Open questions (deferred RE)

1. **m_Layer** — none of the BLK_0x2D fields decoded so far carry a `top/bottom` byte. KiCad's pre-V172 BLK_0x2D has `m_Layer` as the second byte of the record header; v15's prefix bytes are all `0x00 0xb4 ?? 0x00`. May be encoded in the sub-type byte (varies per record), or in one of the `?` fields, or in a parallel record.
2. **BLK_0x32 (placed pads) location** — pin geometry. Cross-pool pointers from BLK_0x2D's `+0x24/+0x28/+0x30` fields land in pools 0x086/0x087/0x088, which suggests a separate region with its own addend. Identification requires a search-and-validate probe per candidate pool.
3. **BLK_0x07 (component instances) location** — needed for real refdes (currently synthesized as `<fpName>_<index>`).
4. **LL_0x1B_Nets walking** — same key pool as LL_0x06 (verified); record layout TBD.
5. **Outline + silkscreen** — `LL_Shapes` and `LL_0x14` LL_0x14 head 0x07fbdb50 lands in a different addend (file offset 0x47F44C, pool addend 0x07B5E704).

### Probe methodology used

To validate the header/string table claim:
1. Temporarily added `case 0x00120200: case 0x00120A00: return FmtVer.V_166;` to `formatFromMagic`.
2. Suppressed the V_PRE_V16 friendly-error throw.
3. Ran the existing `new AllegroDb(buffer)` against both v15 files via `tsx`.
4. Inspected the parsed `header` and `strings` against the .cad oracle.
5. Reverted both edits — no production code modified.

This methodology should be re-used for any future v15 sub-RE: hack the magic switch in a worktree, run the existing parser against a candidate sample, inspect `db.header.*` and `db.strings.*`, revert.

---

## Ground-Truth Oracle (sibling .cad files)

The two v15 `.brd` files in our corpus have GenCAD 1.4 sibling exports from the same source. The `.cad` parser is mature and trusted; its output is the reference target the v15 `.brd` parser must converge on.

### COMPAL LA-7321P
- File: `samples/BROKEN/brd new set/COMPAL LA-7321P.cad`
- Parts: 1914
- Nets: 1305
- Total pins: 7714
- Outline vertices: 4
- First 10 part refdes: `L124`, `CLRP1`, `PQ306`, `U11`, `U32`, `PC218`, `L57`, `L54`, `U41`, `U39`
- First 10 net names: `DMIC_CLK`, `DMIC_CLK_CODEC`, `+RTCVCC`, `GND`, `LG_5V`, `LX_5V`, `+3VALW`, `+3V_SPI`, `FCH_SPICS#/FSEL#_R`, `FCH_SPICLK_R`

### v13tl-0629
- File: `samples/BROKEN/brd new set/v13tl-0629.cad`
- Parts: 1367
- Nets: 1160
- Total pins: 6777
- Outline vertices: 4
- First 10 part refdes: `CN5`, `CN1008`, `CN6`, `C1361`, `C1360`, `C1359`, `C1358`, `C1357`, `C1356`, `C1355`
- First 10 net names: `/+V5S`, `/CN_WLAN_LED#`, `/CN_BT_LED#`, `/CN_HDD_LED#`, `/CN_CAPS_LED#`, `/CN_SCROLL_LED#`, `/CN_NUM_LED#`, `/CN_3G_LED#`, `DGND`, `/USB_P8-`

---

## Upstream Audit

Audited 2026-05-02 to determine whether any open-source v15 parser exists that we could port.

- **KiCad** (`pcbnew/pcb_io/allegro/convert/allegro_parser.cpp` @ master, 2910 lines): No v15 support. `allegro_pcb_structs.h:138` defines `FMT_VER::V_PRE_V16` solely as a "this file is too old" sentinel. `allegro_parser.cpp:184` returns it for `majorVer <= 0x0012`, and `allegro_parser.cpp:2861-2872` immediately throws *"This file was created with %s, which uses a binary format that predates Allegro 16.0 and is not supported by this importer. To import this design, open it in Cadence Allegro PCB Editor version 16.0 or later and re-save…"* — the same workaround we surface in [allegro-header.ts:89-99](../../src/frontend/src/parsers/allegro/allegro-header.ts#L89-L99). KiCad ships zero v15 parsing code; nothing to port.
- **OpenBoardView** (`src/openboardview/Boards/FileFormats/`): No Cadence Allegro reader at all. OBV's `.brd` parser handles only the Apple/Mac obfuscated format (magic `23 E2 63 28`). No v15 starting point there either.
- **Cadence Allegro official spec:** Proprietary, NDA-only.

**Implication:** v15 RE is genuinely from-scratch. There is no upstream code to port. This will be the first known open-source v15 parser. Plan task 0.5 should expect to derive every field offset and block layout from binary inspection of our two-file corpus.

## Reference Files

- **KiCad Allegro parser (v16+ only):** https://gitlab.com/kicad/code/kicad/-/blob/master/pcbnew/pcb_io/allegro/
- **Existing v16+ TS parser in this repo:** `src/frontend/src/parsers/allegro/`
- **Structure dumper (RE tool):** `scripts/allegro-dump.mjs`
