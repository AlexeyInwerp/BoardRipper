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

### byte1=0x48 = candidate BLK_0x32 (placed pad header)

**Strong signal**: counting all `00 48 ?? 00` prefix occurrences in the file yields **7715 records**, almost exactly matching the .cad oracle's 7714 total pin count for LA-7321P. This is the placed-pad block group.

First record at file offset `0xd416c`:
```
+0x00  prefix `00 48 00 00`
+0x04  m_Key       = 0x07bac448
+0x08  pointer     = 0x07b07428  (m_Next in pad chain? or back-ref?)
+0x0c  pointer     = 0x07c099bc
+0x10  pointer     = 0x07bac460  (= the m_Key of an immediately-following BLK_0xC8 record)
+0x14  zero
```
Total fixed-stride: **24 bytes**.

**Layout pattern**: each 0x48 record is followed by one or more BLK_0xC8 detail records (count 11091 ≈ 1.4× pin count) that contain the actual pad geometry. Distances between consecutive 0x48 records vary (24, 56, 64, 84, 116, 120, 132, 160, 208 bytes) because the intermediate space is occupied by these detail records. The 0x48 record's `+0x10` field points to its first 0xC8 detail.

**Open**: identify the BLK_0xC8 record layout and where coordinates live within it. The 0xC8 record at `0xd4184` (immediately after the head 0x48 record) shows ~16 u32 fields followed by 4 i32 values that look like coords (`-442744, 102800, -442192, 105712` — a pad bbox in the same coordinate scale as BLK_0x2D's CoordX/CoordY).

**BLK_0x2D → BLK_0x48 link is NOT direct.** Searched all 1909 BLK_0x2D records for any field containing a BLK_0x48 m_Key — found ZERO real matches across all 12 candidate field offsets (0x08–0x38).

**BLK_0x06.m_PtrPinNumber → byte1=0x20 → BLK_0x48 ALSO NOT direct.** Probed the byte1=0x20 record at file offset 0x1368e48 (target of BLK_0x06 #0's m_PtrPinNumber). Its outgoing pointers (`0x0957ca70`, `0x0957cb0c`) point into pool 0x095 — NOT to any BLK_0x48 key. Across all 3711 byte1=0x20 records in the file, scanning every 4-byte aligned field 0x04..0x3C found only 3 hits matching BLK_0x48 keys. Effectively no link.

### BLK_0xC8 record layout corrected (2026-05-03 push 4)

Field-by-field probe of PQ306's pin 1 BLK_0xC8 record at file offset `0x1368f84` shows:
```
+0x00  prefix `00 c8 0c 00`
+0x04  m_Key
+0x08..+0x18  6 cross-pool pointers (BLK_0x07/2D/etc)
+0x18  pointer
+0x1C  pointer
+0x20  back-ref to BLK_0x48
+0x24  zero
+0x28  pointer (pool 0x095)
+0x2C  pointer (pool 0x095)
+0x30  pointer (pool 0x095)
+0x34  zero
+0x38  i32 — pad bbox X1 (= -501850 in our PQ306 example)
+0x3C  i32 — pad bbox Y1 (= -79450)
+0x40  i32 — pad bbox X2 (= -496450)
+0x44  i32 — pad bbox Y2 (= -76650)
+0x48  next record's prefix (= record size is 72 bytes)
```

So my earlier code read `+0x34..+0x40` which gave one zero plus 3 of the 4 coords. **Correct offsets are `+0x38..+0x44`.**

With corrected offsets, PQ306 pin 1's bbox is:
- bbox: `(-501850, -79450) to (-496450, -76650)` → with /100: `(-5018.5, -794.5)..(-4964.5, -766.5)`
- size: **54 × 28 mils** — exactly correct for an SO8 pad! ✓
- center: `(-4991.5, -780.5)`

**But the absolute position is still wrong**: PQ306's oracle pin 1 is at `(-3970.94, -1513.65)`. The bbox center `(-4991.5, -780.5)` is ~1500 mils away. Not a simple offset to apply.

PQ306 origin (CAD): `(-4072.61, -1438.65)`.
Bbox center distance from CAD origin: `dx=-918.89, dy=+658.15`. Not zero, not a simple multiple.

**This means the BLK_0xC8 bbox is in a different coordinate frame** (footprint-local with rotation/mirror, OR a different scale, OR coords are deltas from an unknown anchor). Solving requires:
- Find the transform anchor (likely BLK_0x2D or BLK_0x2B carries it; possibly a field we currently treat as zero/unknown)
- OR identify a different field in BLK_0xC8 that holds true board-absolute coords

### Pad coord interpretation — STILL OPEN

End-to-end chain walk for PQ306 (8-pin SO8 MOSFET, .cad oracle confirmed) yielded these BLK_0xC8 coords:
```
pin 1 (cad: -3970.94, -1513.65, GND):  [0, -501850, -79450, -496450]
pin 2 (cad: -3970.94, -1463.65, GND):  detail record missing
pin 3 (cad: -3970.94, -1413.65, GND):  [0, -501850, -64450, -496450]
pin 4 (cad: -3970.94, -1363.65, LG_5V):[0, -501850, -69450, -496450]
pin 5 (cad: -4174.29, -1363.65, LX_5V):[0, -501850, -74450, -496450]
```

**Patterns:**
- `coords[0]` always `0` — not a real X
- `coords[1]` always `-501850` (= -5018.5 in /100 units) — constant across ALL PQ306 pads
- `coords[3]` always `-496450` — also constant
- `coords[2]` varies by 5000 between adjacent pins (= 50 mils with /100 scaling) — matches SO8 pin spacing

The 50-mil delta confirms `coords[2]` carries pin-position info, but the values are NOT pin X positions in any obvious frame. PQ306 oracle pins span X = `-4174.29..-3970.94` (203 mils wide), but our `coords[2]` values are `-794.5..-644.5`. No additive or scale offset gets from one to the other.

**Hypotheses (for next probe with .cad oracle):**
1. `coords[2]` is a packed value — high bits = layer/flags, low bits = position offset in the footprint's pad table (index, not coord)
2. The record at `+0x34..+0x40` is NOT the bbox — pad coords live elsewhere in BLK_0xC8 (perhaps earlier in the record, e.g. `+0x18..+0x24`)
3. Each pad's actual position requires combining the BLK_0xC8 record with the parent BLK_0x2D's `coordX/coordY + rotation` plus a footprint-local offset stored elsewhere

The chain (BLK_0x07 → byte1=0x40 → BLK_0x48 → BLK_0xC8) is the right traversal — verified by the consistent stride and chain termination. Only the COORD FIELD interpretation in BLK_0xC8 is open.

### THE PAD-ATTRIBUTION CHAIN (verified 2026-05-03)

**byte1=0x40 records are the missing link.** 1922 records in LA-7321P (≈ 1909 placements). Each one has:

```
+0x00  prefix `00 40 00 00`
+0x04  m_Key (own key, pool 0x07B)
+0x08  inline 8-byte string  (manufacturer part number, e.g. "TF-89682")
+0x10  zero
+0x14..0x24  zeros / unused
+0x28  → BLK_0x07.m_Key  (links this record to a placed component instance)
+0x2C  → BLK_0x48.m_Key  (FIRST PAD pointer — VERIFIED 1921/1922 hits!)
+0x30  → another pointer (BLK_0x07-related, possibly m_PtrFunctionSlot mirror)
+0x34  zero
+0x38  prefix of NEXT record `00 40 00 00`  (records are 56 bytes contiguous)
```

**Stride: 56 bytes.** Records are sequential (verified by `+0x38` showing the next prefix). 

**Complete chain to attribute pads to placements:**

```
BLK_0x2D placement (the part's position + rotation)
  ↓ via +0x1C
BLK_0x07 component instance (carries the inline refdes)
  ↑ via +0x28
byte1=0x40 record (per-placement MPN + pad-list head)
  ↓ via +0x2C
BLK_0x48 first pad header (24 bytes)
  ↓ via m_Next field (still TBD — some +0x?? in BLK_0x48)
BLK_0x48 next pad header
  ...
For each BLK_0x48:
  ↓ via +0x10
BLK_0xC8 pad geometry detail (~68 bytes, with 4 i32 coords at +0x34..+0x40)
```

**Implementation recipe (next session):**
1. Walk byte1=0x40 records sequentially (stride 56 from first occurrence ~0x2A818) — store a Map<BLK_0x07.m_Key, firstPadKey> from `+0x28 → +0x2C`.
2. Walk byte1=0x48 records sequentially (variable stride — start at 0xd416c) — store as Map<m_Key, {detailKey: +0x10}>.
3. Walk byte1=0xC8 records — store as Map<m_Key, {coords: [i32×4 at +0x34..+0x40]}>.
4. For each BLK_0x2D, look up its BLK_0x07.m_Key in the byte1=0x40 map → get firstPadKey → walk BLK_0x48 chain → for each, look up BLK_0xC8 → emit a Pin with center = (coords[0]+coords[2])/2, (coords[1]+coords[3])/2 in BLK_0x2D's local frame, then transform by part's CoordX/Y + rotation.

**BLK_0x48 m_Next is at +0x08 (CONFIRMED).** Verified by following PQ306's chain from its byte1=0x40 record's +0x2C pointer to the first pad, then checking if +0x08 holds another BLK_0x48 key — it does (0x957cca8 is a valid BLK_0x48 m_Key, while +0x0C's 0x957c96c is not).

Final BLK_0x48 layout (24 bytes):
```
+0x00  prefix `00 48 00 00`
+0x04  m_Key
+0x08  m_Next  → next BLK_0x48 in this part's pad chain (0 = end)
+0x0C  unknown pointer (possibly previous-pad or net ref)
+0x10  → BLK_0xC8 m_Key (pad geometry detail)
+0x14  zero
```

**The chain is fully decoded.** Next session can directly implement:
```ts
// Pseudocode for v15 pin extraction
const blk40Map = new Map<blk07Key, firstPadKey>();  // walk byte1=0x40 records
for (const part of blk2dParts) {
  const blk07Key = part.instRef16x;        // already in BLK_0x2D
  let padKey = blk40Map.get(blk07Key);
  while (padKey !== 0) {
    const pad48 = blk48Map.get(padKey);    // walk to find this
    const padC8 = blkC8Map.get(pad48.detailKey);
    const padCenter = bbox_center(padC8.coords);
    part.pins.push({position: padCenter, ...});
    padKey = pad48.next;
  }
}
```


- Possibly via BLK_0x07 (component instance) → BLK_0x48 chain
- Or via BLK_0x2B (footprint def) → BLK_0x48 chain (each footprint type has a pad list, then placements share that geometry)
- Or via the m_PtrPinNumber field in BLK_0x06 → byte1=0x20 record (the "pin number list head" at file offset 0x1368e48) → ... → BLK_0x48

The BLK_0x06 → m_PtrPinNumber → byte1=0x20 record path is the most plausible: BLK_0x06 (component definition) carries the pin/pad layout for that part type, then BLK_0x2D placements reference both BLK_0x06 (via +0x1C) and the placement-specific pad locations (BLK_0x48). Walking BLK_0x06.m_PtrPinNumber → byte1=0x20 record → its outgoing pointers should reach the BLK_0x48 chain. Future RE: probe what the byte1=0x20 record at 0x1368e48 points to.

### byte1=0xC8 record (pad detail / geometry)

11091 records in LA-7321P. Layout starts at file offset `0xd4184`:
```
+0x00  prefix `00 c8 0c 00`
+0x04  m_Key (= preceding 0x48 record's +0x10 pointer)
+0x08  pointer
+0x0c  pointer
+0x10  pointer
+0x14  pointer (== +0x10 — duplicated in head record)
+0x18  pointer
+0x1c  pointer
+0x20  pointer (back-ref to parent 0x48 record)
+0x24  pointer (cross-pool)
+0x28  pointer (cross-pool)
+0x2c  pointer (cross-pool)
+0x30  zero
+0x34  i32 x_min  (-442744 in head record)
+0x38  i32 y_min  (102800)
+0x3c  i32 x_max  (-442192)
+0x40  i32 y_max  (105712)
```
Total: ~68 bytes (need to confirm by walking sequential records).

**Validation lead**: the head 0xC8 record has bbox center ≈ (−442468, 104256). With div=100, that's (−4424.68, 1042.56) mils. We need to map this back to a specific part instance via the back-ref pointer at +0x20 to validate.

### Multi-layer connectors (JHDD1, JODD1, JLAN1, JHDMI1) — nested chain

128 of 1909 parts (6.7%) have no pins decoded. These are large connector parts whose pad chain doesn't terminate at a BLK_0xC8.

Trace of JHDD1's first pad (key `0x7bf77b8`):
```
step 0: BLK_0x48 @ 0x11e2f8  m_Key=0x7bf77b8  +0x10(detail)=0x7bf7518
step 1: byte1=0x01 @ 0x14aaff8  m_Key=0x7bf7518  +0x10=0x98dfcec
step 2: byte1=0x8c @ 0x14aafac  m_Key=0x98dfcec  +0x10=0x7eb6848
step 3: byte1=0x01 @ 0x14aafb8  m_Key=0x7eb6848  +0x10=0x98dfcac
step 4: byte1=0x8c @ 0x14aaf6c  m_Key=0x98dfcac  +0x10=0x7eb62dc
... continues alternating byte1=0x01 ↔ byte1=0x8c
```

The chain alternates between `byte1=0x01` (prefix shape `00 01 00 01` — note the non-zero byte 3!) and `byte1=0x8c` records. Likely per-layer records: each connector pin spans multiple copper/mask layers, so the geometry is layered.

The byte1=0x01 records have a 4-i32 candidate-coord set at +0x18..+0x24: `(-26771, -480776, -163550, -5310)` for JHDD1's first chain. The Y-span (-480776 to -5310 = 475466 units = 4754 mils) is way too large to be a pad bbox.

The byte1=0x8c records also have 4 i32 values at +0x18..+0x24, similarly suspicious.

**Hypothesis for next session**: the connector chain represents PADSTACK definitions (one layered stack per pin). Each layer has its own bbox; the FINAL board-absolute pad position needs to be computed from the per-layer bbox + the connector's BLK_0x2D origin/rotation. This is the v15 equivalent of v16+'s BLK_0x1C_PADSTACK + BLK_0x32 PLACED_PAD layered relationship.

### byte1=0x10 NetAssign — DECODED (2026-05-03)

Field-pool histogram across all 4257 byte1=0x10 records on COMPAL LA-7321P:

| Offset | Pool that field's u32 most often resolves to | Coverage |
|--------|-----------------------------------------------|----------|
| `+0x04` | byte1=0x10 (own m_Key)                       | 100%     |
| `+0x0C` | byte1=0x6c (BLK_0x1B net record)             | 97.2%    |
| `+0x10` | byte1=0xc8 (BLK_0xC8 pad geometry)           | 62.3%    |
| `+0x10` | byte1=0x01 (multi-layer connector pad)       | 20.7%    |
| `+0x10` | byte1=0x14 (alt placement pool)              | 10.9%    |
| `+0x18`/`+0x1C` | byte1=0x10 (next/prev NetAssign chain)| ~65%     |

So a NetAssign record asserts `(padGeometry, net)`; the previous walker
read `peekU32(off)` (the prefix `0x00001000`, not a key), which gave 0%
end-to-end resolution.

Coverage on COMPAL LA-7321P:
- 2025 / 2652 NetAssigns whose `+0x10` lands in BLK_0xC8 resolve to a named net (76%).
- That covers 2025 / 11088 BLK_0xC8 records — only 18% — because each
  BLK_0xC8 typically represents one *layer* of a pad-stack; many layers
  share a single NetAssign.

### Routes 2 + 3 — multi-layer connector pad nets

byte1=0x10 alone leaves ~74% of pads unnamed. Two more byte1 prefixes
also link C8 → net (probe: scan every byte1 pool for records that hold
a u32 in BLK_0xC8 *and* a u32 in byte1=0x6c):

| byte1   | hits | C8 fields                                  | net field |
|---------|------|--------------------------------------------|-----------|
| `0x01`  | 1127 / 3206 | `+0x04, +0x0c, +0x14, +0x18, +0x20, +0x2c, +0x38` | `+0x3c` |
| `0x8c`  | 529 / 2143  | `+0x10, +0x18, +0x20, +0x24, +0x28`          | `+0x08` |
| `0x10`  | (decoded above) | `+0x10`                                | `+0x0c` |

byte1=0x01 is the multi-layer connector pad record (the chain that
alternates with byte1=0x8c — see "JHDD1 pin chain" above). Each holds
up to 7 layered C8 references and a single shared net pointer at +0x3c.

Combined coverage (LA-7321P):
- byte1=0x10:  2025 mappings
- byte1=0x01:  1874 new mappings
- byte1=0x8c:    66 new mappings
- **Total: 3965 / 11088 BLK_0xC8 (35.8%)**, **3960 / 7350 pins (53.9%)**

Spot-checks against `.cad` oracle:
- PQ306 pin1 → GND (oracle: GND) ✓
- U41 pin1 → +3VS (oracle: +3VS) ✓
- L124 pin1 → DMIC_CLK (oracle: DMIC_CLK) ✓

**Pin-numbering caveat**: chain order ≠ physical pin index. The
BLK_0x48 chain visits pads in placement order. The mapping from
chain position N to silkscreen pin number requires decoding BLK_0x32
(per-pad pin-name string) — still pending.

**Remaining ~46% gap (next):**
- Many simple two-pin pads (R/C/L) reach BLK_0xC8 but have no NetAssign
  record at all — likely a fourth route via byte1=0x04 (9113 records;
  4 layered i32 coord fields suggest pad-data, but no clean C8↔net link
  in current probe). Probe needs to scan u32 fields beyond +0x40.
- Pin-numbering mismatch means even pads we *do* net are mis-ordered
  in `ComponentInfo`. Resolving via BLK_0x32 will fix both: correct
  pin numbers AND likely point to the missing pad/net link records.

### byte3 ∈ {0x00, 0x01} relaxation — DECODED (2026-05-03 push 4)

The strict prefix shape `00 [byte1] ?? 00` (byte 3 = 0x00) MISSES a
second prefix variant that byte1=0x01 and byte1=0x8c records use:

| byte1 | byte3=0x00 | byte3=0x01 | Total |
|-------|------------|------------|-------|
| 0x01  | 3206       | 1111       | 4317  |
| 0x8c  | 2143       | 2730       | 4873  |

The byte3=0x01 records are the alternating-chain variant from the JHDD1
trace (chain step 0: `00 01 00 01`, step 1: `00 8c 00 01`, …). Both
shapes carry the same field semantics — relaxing the catalog filter
to `byte3 ∈ {0, 1}` finds them. Other byte1 prefixes (0x10 NetAssign,
0x6c net record, 0xc8 pad geometry, 0x48 pad header, 0x40 component
head) do NOT have byte3=0x01 variants — keep the strict filter for
those.

### Route priority — byte1=0x10 is authoritative

byte1=0x10 NetAssign records have a clean (padGeometry, net) shape
(one pad ↔ one net). The +0x3c "net" pointer in byte1=0x01 records is
**dual-purpose**: in 26% of records it points to a real BLK_0x6c
(named net); in 74% it's a chain link to the next byte1=0x01 record's
pool-0x096 m_Key. Treating Route 2 as authoritative caused a regression
where L124 pin1 was mis-assigned APU_HDMI_TX1P instead of the correct
DMIC_CLK. Fix: parse Route 1 first, mark assigned C8s; Routes 2/3 fill
un-netted C8s only.

### v13tl-0629 has different NetAssign density

The two v15 samples diverge in byte1=0x10 prevalence:

| File             | byte1=0x10 records | Route 1 mappings | E2E coverage |
|------------------|--------------------|------------------|--------------|
| COMPAL LA-7321P  | 4257               | 2025             | 4629 / 7350 = **63.0%** |
| v13tl-0629       | (smaller)          | 221              | 2759 / 6673 = **41.3%** |

v13tl-0629 is a slightly older v15 sub-variant that uses the byte1=0x01
pad-pad chain almost exclusively for net assignment. Routes 2/3 are
load-bearing for it — without them, coverage would drop below 5%.
Cross-validated CN5 connector pins 5–8 against `.cad` oracle:
`/CL_VREF0_ICH`, `/CN_HDD_LED#`, `/CN_NUM_LED#`, `/CN_BT_LED#`. ✓

### Connectivity-graph propagation — feasible but deferred

byte1=0x01 and byte1=0x8c records can also be read as **edges** between
two BLK_0xC8 keys (`+0x04↔+0x0c` and `+0x10↔+0x18` respectively). On
LA-7321P this graph has 1345 connected components. Of those:
- 535 have exactly one direct net (clean — propagation safe)
- 800 have multiple direct nets (conflict — graph over-connects)
- 10 have no direct net at all

Propagating "one direct net" components to their unnetted members adds
~235 new mappings (+3% pin coverage). The 800 conflict components
suggest some fraction of byte1=0x01/0x8c edges connect pads on
*different* nets (perhaps trace branch points or layer transitions
counted as edges). Cleaning this up requires distinguishing "intra-net"
edges from "topology" edges — non-trivial. Deferred until a clearer
edge-type signal is found.

### Route 5 — BLK_0xC8 back-link (2026-05-03 push 5)

The breakthrough that flipped LA-7321P from 5.4% to 92.7% perfect
components: **each BLK_0xC8 record's `+0x0C` field points back to its
owning byte1=0x10 NetAssign.** Route 1 (forward link byte1=0x10 +0x10
→ C8) catches one C8 per NetAssign — typically the "primary" copper
layer — but every BLK_0xC8 in the same pad-stack stores the same
back-link to the NetAssign. So the back-link covers ALL layers of every
pad with a single per-stack NetAssign.

```
                        ┌─ BLK_0xC8 (top-copper)  +0x0C ──┐
byte1=0x10 NetAssign ◀──┼─ BLK_0xC8 (mid-copper)  +0x0C ──┤
   m_Key, +0x0C → net   ├─ BLK_0xC8 (bot-copper)  +0x0C ──┤
                        └─ BLK_0xC8 (anti-pad)    +0x0C ──┘

Route 1 catches one of these per stack via the FORWARD +0x10 → C8 link.
Route 5 catches all of them via the BACKWARD +0x0C → byte1=0x10 link.
```

Per-component oracle results on COMPAL LA-7321P (1914 components,
CAD = ground truth):

| Routes        | Maps | Perfect comps | Correct nets | False positives |
|---------------|------|---------------|--------------|-----------------|
| R1 only       | 2025 |   104 (5.4%)  |       1625   |        0        |
| R1 + R5       | 6708 |  1775 (92.7%) |       5343   |        0        |

The 280 still-missed nets concentrate on 6 connector parts (JHDD1,
JCRT1, JLAN1, JHDMI1, JODD1, PJP2) where the BLK_0x07 → BLK_0x48 →
BLK_0xC8 chain doesn't reach a real C8 record at all — separate
pin-geometry bug, see "JHDD1 pin chain" above.

### Variant split: 15.5.7 vs 15.5.2 — net routes magic-gated

Both v15 sub-variants in our corpus have the same overall block-type
catalog (BLK_0x07 components, BLK_0x2D placements, byte1=0x10/0x6c/0xc8
relationships) but the **byte1=0x10 record SEMANTICS differ between
them**:

| Sub-variant | Magic        | Sample          | byte1=0x10 records | Per-pad NetAssign? |
|-------------|--------------|-----------------|---------------------|---------------------|
| 15.5.7      | `0x00120A06` | COMPAL LA-7321P | 4257                | YES — Routes 1+5 work |
| 15.5.2      | `0x00120206` | v13tl-0629      | 1644                | NO — Routes 1+5 give 0 correct, 221+ FP |

On 15.5.7, byte1=0x10 records are 1:1 with pad-stack NetAssigns. On
15.5.2, byte1=0x10 records exist with the same prefix shape and a
similar field histogram but **the +0x10 padK / +0x0C netK pair is not
a per-pad NetAssign**. Multiple BLK_0xC8 records share a single +0x0C
back-pointer (typically the ground-plane's record), so applying R5
naively attributes every pad on a power-plane layer to GND.

Verification on v13tl-0629 CN5 connector:
- All 5 oracle pins should be `/+V5S, /CN_WLAN_LED#, /CN_BT_LED#, /CN_HDD_LED#, /CN_CAPS_LED#`.
- All 5 BLK_0xC8 records' +0x0C → the same byte1=0x10 record → "DGND".
- Naive R5 → all 5 pins reported as DGND. Wrong.

Production parser disables BOTH Route 1 and Route 5 on 15.5.2 magic.
Better to ship pure pad geometry with no net assignments than ship
incorrect ones. The 15.5.2 per-pad mechanism is undecoded — next-session
RE target.

### Per-component oracle harness

A `/tmp/oracle-harness.mjs` probe (not shipped) parses the .cad sibling,
walks parser pins per component, and reports precision / recall / FP
samples per refdes. Use it to validate any new route candidate before
shipping:

```
node oracle-harness.mjs <BRD> <CAD>
→ reports: total comps, perfect components, correct nets, FP, missed
→ top-15 worst components with FP samples
```

Any new route MUST keep `False positives = 0` on the harness. CAD is
source of truth.

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
