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

What is **not yet confirmed** for v15 and is the subject of Phase 0.5 RE work:

- Header field layout between offset `0x14` and the version string at `0xF8`. The v16+ parser reads `objectCount` at `0x14` and `stringsCount` at `0x18`; in our v15 corpus those positions hold values that don't match those semantics (LA-7321P has `0x000A0D0A` = the bytes `\n\r\n\0` at `0x18`, not a count).
- String table format and offset.
- Block-table format, block-type opcode mapping, per-block-type field layouts.
- Linked-list ordering convention (v16/v17 store `(tail, head)`; v18 flipped to `(head, tail)`; v15 unknown).

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
