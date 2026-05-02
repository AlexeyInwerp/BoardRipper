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

### What diverges — block region

After the string table ends, the v16+ parser expects byte 0 of the next u32 to be a block-type tag in `0x01..0x3C`. In our v15 files, the byte at that position is `0x00`, which the parser interprets as "end of objects" and stops with `blocks.size = 0`.

Raw bytes at the start of the v15 block region for LA-7321P (string table ends at file offset `0x7EE0`):

```
0x7ee0:  00 18 02 00  20 00 ae 07  44 00 ae 07  43 2b 3f 05
0x7ef0:  43 2b 3f 05  d8 4a ae 07  58 16 ae 07  d8 ca 57 09
0x7f00:  00 00 00 00  00 18 03 00  44 00 ae 07  68 00 ae 07
0x7f10:  2e 2b 3f 05  2e 2b 3f 05  18 4b ae 07  ac 16 ae 07
0x7f20:  a8 cc 56 09  00 00 00 00  00 18 03 00  68 00 ae 07
```

Compare to v17 Quanta Z8I's block region start:
```
06 00 02 00  08 80 94 26  11 80 94 26  d2 2f 6c 7b ...
```

v17's first byte `0x06` = `BLK_0x06_COMPONENT`. v15 starts with `0x00`, then `0x18 0x02 0x00`, which doesn't match any documented block-type tag.

The repeating pattern in v15 (`00 18 0X 00 ...` every ~32–36 bytes, separated by `00 00 00 00`) suggests fixed-size records with a leading 4-byte header where the third byte (0x02, 0x03, …) is a counter or sub-type. **This is a v15-specific data structure that does not exist in v16+ and is the only remaining RE target.**

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
