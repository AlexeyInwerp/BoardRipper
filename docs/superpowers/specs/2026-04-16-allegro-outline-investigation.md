# Allegro BRD Outline Investigation — Quanta Y0D (and others)

**Date:** 2026-04-16
**Target file:** `samples/allegroBRD/Quanta Y0D DA0Y0DMBAF0 boardview .brd`
**Status:** Root cause identified, fix proposed, 3 of 4 Allegro samples affected (not just Y0D).

## 1. File fingerprints

| File | Size | Version | Parts | Traces | Outline (current) |
|---|---|---|---|---|---|
| Quanta Y0D (problem) | 21 MB | V_165 | 1762 | 39 830 | **0 pts** |
| Quanta Z8I | 68 MB | V_172 | 2984 | 60 560 | **0 pts** |
| Acer Z8IA | ~65 MB | V_172 | 3322 | 70 178 | **0 pts** |
| tvk336169 | — | (works) | 174 | 18 942 | 18 pts |

Block distribution in Y0D: `0x01`=15 971, `0x14`=84 071, `0x15/16/17`=170 331, `0x28`=6204, `0x2D`=1772 — healthy.

## 2. What `extractOutline()` finds in Y0D

Empty. `assembleBoard → extractOutline` walks `db.header.LL_Shapes` looking for `0x28` blocks whose layer is `BOUNDARY` or `BOARD_GEOMETRY/DRAWING_FORMAT` + subclass `0xEA/0xFD`.

`LL_Shapes` in Y0D contains exactly 41 entries (1 × `0x0E`, 40 × `0x28`). Classes of those 40 shapes are ROUTE_KEEPOUT, BOARD_GEOMETRY `0xF0/0xF1` (silkscreen, NOT outline), MANUFACTURING, etc. **Zero match the outline filter**, so `extractOutline()` returns `[]`.

Same story for Z8I (146 shapes in LL_Shapes, 0 match) and Z8IA (similar). Only `tvk336169` has BOUNDARY-class `0x28`s threaded onto LL_Shapes — which is why it "works" today.

The premise "other Allegro BRD files in the same folder work fine" is **false**: 3 of 4 samples silently return an empty outline. The bug is pre-existing and visible in three files; Y0D just made it obvious.

## 3. Where the outline actually IS

I scanned all `0x14 / 0x24 / 0x28` blocks in each file and filtered by the same outline-layer predicate KiCad uses (`IsOutlineLayer` = BOARD_GEOMETRY|DRAWING_FORMAT + subclass `0xEA|0xFD`). Results:

| File | 0x14 outline | 0x24 outline | 0x28 outline | Big 0x28 shape reachable via LL_Shapes? |
|---|---|---|---|---|
| Y0D | 3 (segs=1 each) | 0 | **1 × 208 segs** @ BG.0xFD | NO — `0x9b7dbb8` sits in the flat block pool, not in any of the 3 LLs |
| Z8I | 51 | 0 | **2 × 251 segs** (BG.0xFD + BG.0xEA) | NO |
| Z8IA | 1 | 0 | **2 × 250 segs** (BG.0xFD + BG.0xEA) | NO |
| tvk336169 | 2 | 0 | 6 × 4 segs (BG.0xFD) | Partially — the 4-seg 0xFD shapes are reached, plus many `BOUNDARY` 0x28s |

So the real board outline lives in a `0x28` BOARD_GEOMETRY/0xFD (and/or 0xEA) shape with 200+ linearised segments, but that shape is **not linked into `LL_Shapes`** in the three broken files. KiCad's reference importer (`allegro_builder.cpp`, `ScanForLayers`) walks **three** linked lists for shape/graphic scanning:

```cpp
simpleWalker( aDb.m_Header->m_LL_Shapes );
simpleWalker( aDb.m_Header->m_LL_0x24_0x28 );   // ← we don't walk this
simpleWalker( aDb.m_Header->m_LL_0x14 );        // ← nor this
```

Our `extractOutline` only walks the first. Additionally, even that isn't enough for Y0D/Z8I/Z8IA: the outline `0x28` is not in `LL_0x24_0x28` either (dumped walks confirm the big outline shape is absent from all three lists). But those files still return the outline by the simple-but-robust strategy of **iterating `db.blocks.values()` directly** — a flat scan — which finds the `0x28` BG.0xFD/0xEA shape with 200+ segments.

## 4. Proposed fix

File: `src/frontend/src/parsers/allegro/allegro-assembler.ts`
Function: `extractOutline(db, _ver, div)`

Replace the `db.walkLinkedList(db.header.LL_Shapes, …)` traversal with a flat iteration over `db.blocks.values()`, keeping the existing filter (`BOUNDARY` or `BOARD_GEOMETRY/DRAWING_FORMAT` + subclass `0xEA/0xFD`). Choose the shape with the greatest segment count to avoid stub edges, and break on first non-trivial result (e.g., > 8 segments) — this matches the "biggest BG.0xFD polygon is the board edge" heuristic.

Pseudocode:

```ts
let best: { shape: Blk0x28Shape; segCount: number } | null = null;
for (const b of db.blocks.values()) {
  if (b.blockType !== 0x28) continue;
  const s = b as Blk0x28Shape;
  const cc = s.layer.classCode, sc = s.layer.subclass;
  const isOutline =
    cc === LayerClass.BOUNDARY ||
    ((cc === LayerClass.BOARD_GEOMETRY || cc === LayerClass.DRAWING_FORMAT)
      && (sc === 0xEA || sc === 0xFD));
  if (!isOutline) continue;
  const pts = walkSegmentChain(db, s.firstSegmentPtr, div);
  if (!best || pts.length > best.segCount) best = { shape: s, segCount: pts.length };
}
```

Accept `best`'s walked points as the outline. Prefer `0xEA` (`BGEOM_OUTLINE`) over `0xFD` (`BGEOM_DESIGN_OUTLINE`) as a tiebreaker if both exist with similar point counts — matches KiCad's conceptual distinction.

**Optional secondary pass** (graphics-based outline): if no `0x28` match, iterate `0x14 GRAPHIC` blocks with the same outline predicate and collect all their segment-chain points. Less common but matches KiCad's three-list scan.

## 5. Risk assessment

Low risk.

- **Filter stays identical** — the same `BOUNDARY | BG/DFMT + 0xEA/0xFD` predicate. No new file will start matching that wasn't already intended to match.
- **Flat iteration is already used** for traces (`0x05`), vias (`0x33`), and net-assignment map (`0x04`) in the same file. Consistent idiom; no linked-list-specific semantics are lost — the outline doesn't care about chain order.
- **Worst case for "working" files:** the picked shape might be a different matching polygon (e.g., the 63-seg `BOUNDARY.0x02` on tvk336169 vs a 4-seg `BG.0xFD`). Picking the **largest** segment count is the best default. In tvk336169 the current code's "first match in LL" returns 18 points; the flat+largest strategy would pick a 63-segment BOUNDARY shape (class 0x15, subclass 0x02) — likely a better outline than today's 18-point result. Visually inspect once to confirm.
- **No changes** to block parsing, DB construction, or reference resolution — this is purely an assembler-layer heuristic change.

## Appendix — key diagnostic output

Run: `npx tsx /tmp/allegro-diag2.ts` from `src/frontend`:

```
PROBLEM: Quanta Y0D      outline=0   parts=1762  traces=39830
WORKING: Quanta Z8I      outline=0   parts=2984  traces=60560    ← also broken
WORKING: Acer Z8IA       outline=0   parts=3322  traces=70178    ← also broken
WORKING: tvk336169       outline=18  parts=174   traces=18942
```

LL_Shapes walk on Y0D (41 blocks, 40 × 0x28): 0 match outline filter. Largest in-LL shape is a 343-seg ROUTE_KEEPOUT (wrong class). The real 208-seg BG.0xFD outline `0x9b7dbb8` exists in `db.blocks` but is absent from `LL_Shapes`, `LL_0x24_0x28`, and `LL_0x14`.

## Appendix B — Top/Bottom side detection

**TL;DR:** Our parser matches KiCad's authoritative implementation exactly. `inst.layer != 0 → bottom` IS correct. No fix required to the side-detection logic itself. If users see misplaced parts, the root cause is coordinate/mirroring downstream of side assignment, not the side field.

### Evidence — `inst.layer` histograms (from `/tmp/allegro-side-diag.ts`)

| File | fmtVer | layer=0 | layer=1 | layer=0 pads | layer=1 pads |
|---|---|---|---|---|---|
| Y0D        | V_165 | 288  | 1484 | 553   | 5972 |
| Z8I        | V_172 | 1790 | 1204 | 4205  | 5851 |
| Z8IA       | V_172 | 1982 | 1350 | —     | —    |
| tvk336169  | V_166 | 177  | 0    | 1347  | 0    |

`tvk336169` (the "known-good" reference) is a **single-sided** test board — all 177 parts are layer=0. It does **not** exercise the bottom-side branch, so the fact that it "works" gives zero evidence about bottom detection. Conversely, Y0D's bottom-heavy distribution (1484 bottom, 288 top) is plausible for a dense laptop motherboard.

### Evidence — KiCad uses the same check

`/tmp/kicad-src/pcbnew/pcb_io/allegro/allegro_builder.cpp:2862`:
```cpp
const bool backSide = ( aFpInstance.m_Layer != 0 );
```

`convert/allegro_pcb_structs.h:1945-1947`:
```cpp
uint8_t  m_UnknownByte1;
uint8_t  m_Layer;         // 0 = top (F_Cu), 1 = bottom (B_Cu)
uint8_t  m_UnknownByte2;
```

Byte order, offsets, and interpretation are identical to our `parseBlock0x2D`.

### Evidence — alternate signals are NOT reliable

- **Pad ETCH layer** — USELESS. All 0x32 `Blk0x32PlacedPad.layer` entries in all four files have `classCode = 0x0C (PIN)`, never `ETCH`. The pad's physical copper side lives in the padstack (0x1C) per-layer component table, not on the placed pad. Using pad-layer majority for side is not a viable shortcut.
- **`inst.flags` bit 0x10000** — UNCORRELATED with layer. Z8I: `layer0={set:799, clr:985}, layer1={set:557, clr:643}`. Y0D: `layer0={set:262, clr:20}, layer1={set:1433, clr:47}` (bit is set for *most* instances regardless of side). Z8IA: bit is mostly clear on both sides. Not a side indicator.
- **Rotation** — natural quadrant distribution on both sides; no mirror-only-on-bottom pattern.
- **`unknownByte1` / `unknownByte2`** — always 0 in all sampled instances. No signal.

### Proposed fix

**None.** `inst.layer === 0 ? 'top' : 'bottom'` in `extractComponents` (allegro-assembler.ts:182) and `extractPins` (:264) is the correct and canonical Allegro signal, per KiCad.

If downstream users report visual misclassification on Y0D/Z8I, the follow-up investigation should look at:

1. **Y-axis / mirror transform in the renderer.** KiCad applies `fp->Flip(fpPos, FLIP_DIRECTION::LEFT_RIGHT)` *after* placing pads, because Allegro stores bottom-side pad coordinates in board-absolute form. BoardRipper's renderer/BoardData model assumes pad coords are already board-absolute and does NOT flip — which is fine for display — but if users compare against a reference viewer that flips bottom parts, the side label will *appear* wrong even though it's mathematically correct.
2. **Ground-truth source.** Confirm the user isn't comparing against a BDV/PDF/`.pcb` file that was itself re-exported with a convention mismatch.

### Risk assessment

Changing the side-detection heuristic at this point would create divergence from KiCad's importer and would almost certainly *introduce* bugs on files currently working correctly (e.g. the Acer Z8IA sample already has reasonable layer0/layer1 ratios). Do not modify `allegro-assembler.ts` without first obtaining an independent per-refdes ground-truth list (a BDV or `.pcb` boardview of the same board identifying which refdes are top vs bottom) and showing a concrete per-refdes disagreement between our output and that truth. Until such disagreement is demonstrated, the current code is correct.

## Appendix C — Side detection follow-up (2026-04-16)

User reports Y0D/Z8I viewer shows the CPU side when labeled "BOTTOM" and the back side when labeled "TOP" — geometry renders correctly, only the label is swapped. Appendix B said "don't change without ground truth"; this appendix provides the ground truth.

### Big-part evidence — `/tmp/allegro-side-check.ts`

CPUs, PCH chipsets, GPUs, VRAM and DIMM connectors sit on the **top** of a laptop motherboard. Dump of the 10 largest footprint instances by pin count:

| File | Top 3 biggest refdes : pins : `inst.layer` | layer0 pins | layer1 pins |
|---|---|---|---|
| **Y0D**  | `U10=1168 L1`, `PU4=203 L1`, `U20=178 L1` (CPU + PMIC + VRAM on layer 1) | 553 | 6140 |
| **Z8I**  | `U1=1528 L1`, `U8=595 L1`, `JDIM1=264 L1` (CPU + PCH + DIMM on layer 1) | 4205 | 6379 |
| **Z8IA** | `U6539=1449 L1`, `U8=595 L1`, `JDIM02=264 L1` (same pattern) | 4679 | 6544 |
| **tvk336169** (reference) | all 174 parts on layer 0, `X1=80 L0`, ... | 1347 | 0 |

`U10` (1168 pins, Y0D) and `U1`/`U6539` (1500+ pins, Z8I/Z8IA) are unambiguously the main SoC/CPU packages. DIMM sockets (`JDIM*`) are also always on the top side — they have to be accessible for memory replacement. Both sit on `inst.layer===1` in all three laptop boards.

### Conclusion: the current code IS inverted for Y0D/Z8I/Z8IA

Appendix B's reasoning ("KiCad's `m_Layer != 0` means bottom") was correct *as an Allegro-convention statement* but wrong as a UI-semantics statement for these files. In Y0D/Z8I/Z8IA, Allegro's `m_Layer=0` layer corresponds to the **"TOP" string layer name** in the layer table but physically the CPU/DIMM/PCH live on `m_Layer=1`. Either (a) these boards were authored with `TOP`/`BOTTOM` layer names mapped to the *opposite* `m_Layer` byte convention Quanta/Acer expect, or (b) the Allegro layer-name table is an independent labeling from the `m_Layer` byte and our parser is assuming they line up 1:1 when they don't.

tvk336169 doesn't disprove anything: it's single-sided (layer=0 only), so it cannot distinguish "layer 0 = top" from "layer 0 = whichever side parts are on".

Appendix B's "alternate signals are not reliable" remains correct — pad ETCH class is useless (always `PIN`), `inst.flags` bit 0x10000 is uncorrelated, rotation is uniform. The reliable signal is the **pin-count majority**: on a populated double-sided laptop motherboard the side with the SoC is always the side with more total pins.

### OpenBoardView cross-reference

`gh api repos/OpenBoardView/OpenBoardView/contents/src/openboardview/FileFormats/BRDAllegroFile.h` — OpenBoardView has no Allegro parser; `BRDAllegroFile` is a stub that refuses the file with an error message. No upstream to borrow a flip hint from.

### Header-level hints checked

Every scalar field in `FileHeader` was dumped for all four files. The only systematic differences between tvk336169 (single-sided, "works") and the three dual-sided files are size/counts and version. No field named or positioned like a global "mirror" or "primary side" flag exists in the header or the layerMap (entries 0–14 look structurally identical across files). `allegroVersion` strings differ in build number only. There is **no boolean file-level flip flag** we can read.

### Recommended heuristic (not implemented — report only)

Per-file, after loading the DB and before emitting `Part.side`, compute pin counts per `inst.layer`:

```
pins_by_layer = Map<layer, int>
for inst in footprint_instances:
  pins_by_layer[inst.layer] += inst.pinCount
top_layer_byte = argmax(pins_by_layer)     // 0 or 1
// Assign sides:
side = (inst.layer === top_layer_byte) ? 'top' : 'bottom'
```

For tvk336169 (only layer 0): `top_layer_byte=0`, assignment is unchanged (everything is top).
For Y0D/Z8I/Z8IA: `top_layer_byte=1`, current assignment flips → matches user's physical observation.

Edge case: a board where both sides have near-equal pin counts (rare; placeholder populated boards only). Guard: require a clear majority (e.g. > 55%) before trusting the heuristic; fall back to `inst.layer === 0 → top` if ambiguous.

### Alternative hypothesis worth ruling out first

Before implementing the flip, verify the issue is labeling and not a downstream Y-axis mirror in the renderer. Take any refdes that appears on both top and bottom physically (e.g. U8 on Z8I is on layer 1), check whether the BoardViewer shows it on the correct *geometric* side (left vs right of the board in a known orientation). The user's description — "in TOP mode I see the BACK of the physical board" — is ambiguous between "side label is swapped" and "viewer is mirrored when switching sides". If geometry is correct and only the label is wrong, the pin-count heuristic is the right fix. If the renderer mirrors the wrong axis on side-switch, the heuristic would mask that bug rather than solve it.

### Status

No code change made. Evidence strongly supports inverted `inst.layer → side` assignment for Y0D/Z8I/Z8IA. Recommended next step: user confirmation that fixing the labels (without changing geometry) resolves the complaint, then implement the pin-count-majority heuristic in `extractComponents` / `extractPins`.
