# Allegro v15.x BRD File Format Specification

> Reverse-engineered Cadence Allegro binary PCB format family (magic `0x00120000`–`0x0012FFFF`).
> Target versions: v15.0–v15.7. Sibling format to v16+ (magic `0x0013FFFF`), with divergent header and block-table layout.

---

## Overview

Allegro v15.x is a proprietary binary PCB database format used by Cadence Allegro PCB Editor in the v15.x family (release dates ~2004–2006). Unlike the v16+ family (which uses magic `0x0013XXXX`), v15 uses family code `0x0012` and employs a different header layout and block-table structure.

| Property | Value |
|----------|-------|
| Format family | Cadence Allegro (v15.x) |
| Magic codes | `0x0012XXXX` (family `0x0012`, minor version in lower word) |
| Detection | Bytes [0..3] contain `0x00120000`–`0x0012FFFF` |
| Encoding | Binary (little-endian u32/u16/u8 integers) |
| Coordinate unit | Mils (thousandths of an inch) |
| Supported shapes | Components (SMD + through-hole), pins, nets, board outline, traces, vias, test points |

---

## Known Limitations

- **v14 and earlier:** Not currently supported (different format family entirely). Conversion via Cadence Allegro v15+ to v16 is the documented workaround.
- **v18+:** Use existing v16+ parser (`allegro-parser.ts`); magic codes are `0x0014XXXX` and up, sharing the v16+ layout.
- **Encrypted sections:** Some proprietary regions may exist — currently treated as opaque (parser skips them gracefully).

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

## Reference

- **KiCad Allegro parser:** https://gitlab.com/kicad/code/kicad/-/blob/master/pcbnew/pcb_io/allegro/ (v16+ support only; v15 is absent)
- **OpenBoardView:** https://github.com/OpenBoardView/OpenBoardView (no v15 support documented)
- **Cadence Allegro official:** Proprietary; format specification available only under NDA to licensees
