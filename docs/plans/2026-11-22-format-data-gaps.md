# Format data gaps — what the files carry and we still drop

Started 2026-11-22 after the FZ MFG-code report (XPS 15 9530 LA-L663P). A
review of every parser against real samples found data the files carry that
never reached `BoardData`. Done in this round (commits `037ccb8b` … `33257b8e`):
FZ BOM, Allegro value / part number / rotation / ROOM, XZZ JSON part values,
footprint names and per-net readings, BVR3 ball sizes, pad outlines and body
outlines, GenCAD value cleanup / tolerance / rotation and the artwork-as-outline
bug, KiCad part number / rating / description / sheet, EAGLE part numbers,
Apple BRD SMD-vs-through-hole and pin nets from nails, Altium value /
description / sheet / height and the Regions6 crash, Mentor part numbers /
description / sheet. New `PartMeta.description` and `.sheet`.

## Todo

| Format | What | Where it would go | Notes |
|---|---|---|---|
| XZZ | `===电压` rail voltages (`PP3V3_G3H=3.373V`, 459 lines, 13 MacBook files) | new net-level map, e.g. `BoardData.netVoltages`; net info + Notes tab | deferred by Alexey 2026-11-22 |
| XZZ | `===原理图` — the schematic PDF's file name (24 files) | auto-bind hint | |
| XZZ | `===RFFE` bus maps (17 files, 50 buses) | Notes tab | low value |
| XZZ | JSON `pad[].alias` (9,281 pads) | ? | meaning unclear: BGA ball renames (`AU21→BB15`) or nets |
| GenCAD | `$BOARD ARTWORK` blocks as silkscreen | `BoardData.silkscreen` | must follow X-mirror, butterfly fold and shape recentring |
| Allegro | per-file user attributes on instances (P3HCJ `16012` = schematic page) | `meta.sheet` | attribute names are not in the file; id varies per file |
| Allegro v15 | part values | `meta.value` | v15 component fields not decoded |
| KiCad | `title_block` (title, rev, company); `(attr exclude_from_bom / board_only)` | board info; part flag | |
| EAGLE | net classes (`<class>`), package `<description>` | net metadata; `meta.description` | |
| Mentor | `COMPONENT_PLACEMENT_OUTLINE` (parsed, unused), `N_PROP NET_TYPE` | silkscreen; net metadata | |
| All OBV formats | nail ids, grid cells, pin→nail links (BVR1 PROBE, BDV nailIdx, ASC `$id`) | `Nail.id`, `Pin.probe` | no UI shows them yet |
| BVR3 | `PIN_SIDE O` → both; BDV part side 0 → both | side | OBV treats them as both; ours say top / bottom |
| BVR3 | 820-02016 pin outlines (pin on the pad edge, every pad) | pad geometry | ignored on purpose until the exporter's rule is understood |

## Samples fetched for this round (gitignored)

- `samples/incoming/fz/` — XPS 15 9530 LA-L663P (NAS `AL ZEUG/New Boards/Compal`)
- `samples/incoming/apple-brd/` — 10 Apple BRD boards, 820-2179 … 820-01598 (NAS `LogiCloud/Schematics-BV-EFI/Apple Boards By Number`)
- `samples/incoming/altium/` — KiCad QA boards HiFive1.B01, eDP_adapter_dvt1, Fastino_Ground_Isolator (`qa/data/pcbnew/plugins/altium`)
- `samples/incoming/mentor/RV415_AMD.cad` — NAS copy of the RV415 Mentor fixture
