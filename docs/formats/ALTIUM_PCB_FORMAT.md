# Altium PCB Format

## Overview

Altium Designer `.PcbDoc` (and the sister Circuit Maker `.CMPcbDoc` / Circuit Studio `.CSPcbDoc` extensions) is the binary PCB design-file format produced by Altium Designer 6.0 and later (2005 → present). Files are **Microsoft Compound File Binary** (CFB / MS-CFBF) containers with ~45 named streams holding board metadata, component placements, copper geometry, layer stackup, design rules, and embedded 3D models.

BoardRipper supports two flavours:

- **Binary** — the default save format. CFB container with magic `D0 CF 11 E0 A1 B1 1A E1`.
- **ASCII Version 5.0** — opt-in text export (File → Save Copy As → PCB ASCII), same `.PcbDoc` extension, identical record set, no CFB envelope.

## Lineage

- Altium Designer 6.0 introduced the `6`-suffixed stream-name convention (`Board6`, `Components6`, …). Files saved by 6.0+ use these names exclusively.
- Older **Protel 99SE** `.PCB` files use a different container and stream layout — **not supported**.
- Stream layouts evolve across major Altium releases. The `FileVersionInfo/Data` stream stores a feature-evolution log (one entry per release that introduced format-affecting features). BoardRipper does not gate on this — the parser ignores unknown keys, matching KiCad's permissive approach.

## P1 (current) coverage

The parser produces a standard `BoardData` (parts + pins + nets + outline) from the following streams:

| Stream | Encoding | Purpose |
|---|---|---|
| `FileHeader` | Binary | Magic + version sniff |
| `Board6/Data` | Property bag | Origin, layer stackup, board name |
| `Components6/Data` | Property bag | Component instances |
| `Pads6/Data` | Binary records | Pin pads + through-hole pads |
| `Nets6/Data` | Property bag | Net name table (index → name) |
| `Classes6/Data` | Property bag | Net/component classes |
| `WideStrings6/Data` | Binary | Unicode string pool |

Multi-layer copper (`Tracks6`, `Vias6`, `Arcs6`, `Fills6`, `Regions6`, `Polygons6`) is parsed in Phase 2; annotations and mechanical bodies in Phase 3.

### P1 known limitations
- Pads with complex shape mode (Altium "PADMODE" != SIMPLE — typical BGA pad stackups) are decoded with `xsize=0, ysize=0` because the size table lives in subrecord 6 (`APAD6_SIZE_AND_SHAPE`) which P1 skips. These render as zero-size points. THT detection (`layer === MULTI_LAYER`) still works for them. Will be addressed in Phase 2.
- Pad shape mapping collapses to round-or-rect; octagon, roundrect, custom-shape pads land as rect with correct bounding rectangle but lose shape detail. Phase 2 will surface the full `PadShape` enum.

## Coordinate system

Altium stores positions as `int32` in **1/10000 mil** units. Origin is bottom-left, Y-axis up. BoardRipper converts to plain mils with Y-axis down via `parsers/altium/altium-units.ts` — this is the **only** module performing coordinate or unit transformation.

## Property-bag format

Text-format streams encode each record as ASCII `|KEY=VALUE|KEY=VALUE|…`. Records are length-prefixed by a `uint32` byte count. Boolean values are `TRUE`/`FALSE`. Unicode strings are referenced by index into `WideStrings6`.

```
|RECORD=Component|SOURCEDESIGNATOR=R1|PATTERN=0603|LAYER=TOP|X=100000|Y=200000|ROTATION=0|
```

## Binary record format

Each record in a binary stream starts with:

- `uint8` record-type tag (typically `0x02` for primitives)
- One or more subrecords, each prefixed by `uint32` byte length

Pads6 records have 5 subrecords: name (short Pascal), three skipped padding subrecords, and the main body. Main-body fields have fixed offsets with version-conditional trailing fields — the parser uses the declared subrecord length to skip the tail safely.

## Sources & references

| Source | Description | License |
|---|---|---|
| [KiCad PCB importer](https://github.com/KiCad/kicad-source-mirror/tree/master/pcbnew/pcb_io/altium) | Canonical reference. Covers ~45 streams. Actively maintained. | GPL-2.0+ / one file GPL-3.0+ |
| [thesourcerer8/altium2kicad](https://github.com/thesourcerer8/altium2kicad) | Long-running Perl converter. Cross-reference value; issue #28 documents stream layouts. | GPL-2.0 |
| [issus/AltiumSharp](https://github.com/issus/AltiumSharp) | C#/.NET active fork. Read+write `.PcbDoc`. | Apache-2.0 |
| [SheetJS/js-cfb](https://github.com/SheetJS/js-cfb) | OLE CFB parser. Used by BoardRipper for the container layer. | Apache-2.0 |

## Local fixtures

- `samples/altium/PCB.PcbDoc` — Altium Designer 16.0+ small demo (~915 KB)
- `samples/altium/ESD_GW1N_4L.PcbDoc` — Altium Designer 15.1+ 4-layer Gowin FPGA dev board (~1.3 MB)

Both files are local-only (`samples/` is gitignored).
