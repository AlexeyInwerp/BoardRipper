# XZZ multi-board split and unfold — review and improvement plan

Date: 2026-09-05
Status: implemented 2026-09-05 (commit `c91f02a` + follow-up view fix):
Phases 1–3 and the pack part of Phase 5 (board names, swap sides) are in,
plus the touching-halves split of 2026-09-08 (97 single-loop Apple files); Phase 4 (point-in-polygon membership) and the survey
harness of Phase 0 (`scripts/xzz-survey`) remain. Section 2 is the evidence
the implementation rests on.
Scope: XZZ `.pcb` files that pack several physical boards (iPhone AP+BB, MB+SUB,
four-board packs) with each board stored as two side-by-side halves.

Evidence base: the parser was run from a scratch vitest harness over 136
iPhone `.pcb` files pulled from the NAS
(`AL ZEUG/XZZ/Phones/iPhone/…`, now under
`samples/XZZ PCB SAMPLES/nas-iphone/`, gitignored). Three deliveries exist per
model: "PCB layer" (single board, 8–10 copper layers of traces), "boardview" /
"YiDianTong" (packs, no traces), and "Mid/Middle level diode value" (sparse).

## 1. How it works today

The pipeline has two halves that were written at different times and do not
share code.

### 1.1 Parser (`src/frontend/src/parsers/xzz-parser.ts`)

1. Layer-28 segments are clustered by endpoint proximity (`clusterSegments`,
   1 mil) into outline components. Each gets a bbox and a segment count
   (`componentBBoxes`).
2. `findFoldAxis` decides whether to apply a **global** butterfly fold:
   - Gate: `isMultiBoardOutline` returns true when there are ≥ 4 components,
     an even number, and every `(round(w), round(h), segCount)` bucket has an
     even count ≥ 2. When true, no global fold happens at all.
   - Otherwise: exactly two components → fold between them
     (`detectOutlineComponentFold`); else a centroid-gap search validated by
     part balance (≥ 15 %) and outline-extent balance (≥ 0.4).
   - Side: the part with the most pins is "top" (CPU rule); test pads as a
     fallback; default lower = top.
3. When a global fold exists, the parser mirrors **everything** on the bottom
   half: pins, per-part silk lines, traces, vias, top-level silkscreen, and
   discards or clips the bottom outline.
4. After that a chirality pass (`detectXMirrorByPinDirection`) may flip the
   whole file, then coordinates are normalised to the origin.
5. Independently of the global decision, `groupComponentsByGeometry` buckets
   components by the same exact key. A bucket of exactly two components that
   are separated on one axis gets a fold axis midway between the bboxes with
   `lowerIsBottom: false` hard-coded (lower coordinate = top). This becomes
   `boardGroups`.

### 1.2 Store (`src/frontend/src/store/derive-board-view.ts`)

`deriveBoardView(board, foldMode, selectedBoardIndex)` builds the presented
board:

- Passthrough (default): raw layout, every part `side: 'top'`.
- Forward fold (a board is selected, mode "Suggested", group has a fold):
  parts whose origin is on the "bottom" side of the group axis are mirrored
  and tagged bottom; traces are mirrored by midpoint; the outline keeps only
  the top component's sub-paths. Parts outside the group's bboxes are
  `hidden`.
- Reverse fold / filter-only: for butterfly files and the "Show all sides"
  view.

Then `syncMirrorsToDerivedFold` recomputes rotation and flip axis.

## 2. What the corpus shows

### 2.1 Pairing outcome per file class

| Class | Files | Outcome today |
|---|---|---|
| Modern packs, 4 clean components (iPhone X–17 boardview/YiDianTong, PCB-layer packs) | ~30 | Pair correctly. |
| Packs with extra outline loops (iPhone 6/6s/6s Plus/8 intel: 10–30 components) | 8 | Main pair found, but 4–17 cutout/fiducial loops become extra "boards". Sidebar shows "Detected boards: 5–6". |
| Packs where one half has a different segment count (`iPhoneXSMAX boardview`, `iPhoneXS plug charging…`, `XR.pcb`, `iPhoneSE boardview`, `iPhone5 boardview`) | 5 | Halves never pair. Gate fails, control falls to the global path: `XR.pcb` and `iPhoneSE boardview` are **gap-folded across two physical boards** (the "collapsed slab" bug); `iPhoneXSMAX boardview` leaves the BB board unfoldable. |
| Nested outlines (`iPhone17Pro-Mid level diode value`: inner outline inside the board; `iPhone17-Mid level diode value`: 8 components, 4 "boards") | 2 | Every nested loop pair is reported as a board. |
| Mismatched halves (`iPhone15ProMax(USA) Middle layer diode value`: 2647 vs 2985 mil tall) | 1 | Folded as a butterfly anyway. |
| Single-board "PCB layer" / per-board YiDianTong deliveries (2 components) | ~60 | Global fold, CPU rule picks the side. |

Segment counts differ between halves by as little as one (`iPhone5 boardview`,
386 vs 387), which is enough to break the exact key.

### 2.2 The copper oracle, and what it says about sides

On every "PCB layer" delivery each pin was tested for a trace endpoint at its
position on the first copper layer (L1) or the last (L8/L10). On the pack-style
PCB-layer files, where no fold has been applied, the result is clean: **every
outline component has all of its routed pins on L1 or all on the last layer,
never mixed** (for example iPhone 11: C0 551/0, C1 512/0, C2 0/1, C3 0/431).
Side per component is therefore knowable with certainty whenever traces exist.

Two invariants fall out of 14 pack files with copper:

1. **The exporter places the design's L1 half at the lower coordinate of each
   pair** (left for X-separated pairs). No exceptions once the app's own
   chirality flip is discounted. This is a file-independent rule that also
   covers boardview/YiDianTong deliveries, which carry no traces.
2. **The SoC is not reliably on the design's top.** U1000 sits on L1 for
   iPhone 14, 15 Pro, 16, 16E, 16 Pro, 17, 17 Air and on the last layer for
   iPhone X, XS, 11, 12, 13, 15/15 Plus, 15 Pro Max (USA), 17 Pro, 17 Pro Max.
   The BB boards split the same way.

Consequence: the per-board default (`lowerIsBottom: false`) matches the
exporter's convention, while the **global** path's CPU rule disagrees with it
on roughly half the boards. The same physical board therefore comes out with
opposite sides in its two deliveries: `iPhone16_16Plus BB PCB layer` puts the
modem half on top (CPU rule), the `AP+BB Boardview` pack puts the transceiver
half on top (exporter rule). Users comparing the two files see one of them
"upside down".

### 2.3 Chirality correction on packs

The file-wide mirror fix fired on 8 pack files before the change. On the
raw pack the detector's top-side votes come from parts of both sides at
once, so its verdict there was noise (`iPhoneX Qualcomm PCB layer` was
flipped although its layout obeys the exporter rule). Copper cannot replace
the detector: on all 78 trace-carrying files the design's top half sits at
the lower coordinate, whether or not the pins wind clockwise — mirroring
changes the winding, not where the exporter puts the halves. What the pack
pass changed is the detector's input: it now votes on folded boards with
real sides. Net effect on the corpus: 7 files no longer flip (the iPhone 14
packs, 17 Air, flex cables), 4 newly flip (13 Pro AP deliveries, iPhone 5,
8 Qualcomm "Common problems"), 33 unchanged.

### 2.4 Other observations

- 122 nets in the iPhone 16 pack span all four halves and 90 span three. Net
  names are shared across physical boards, so per-board views must rebuild
  nets from visible pins (the store already does).
- The two deliveries of one board store part rotations 180° apart (270° vs 90°
  on the same 902 two-pin parts). Orientation conventions differ per
  delivery; nothing can be hard-coded per model.
- Pin names are empty in every iPhone file. Any oracle built on BGA row and
  column names is unavailable here.
- `iPhone17Air` packs are MB+SUB with both boards folding on the same axis.
  `XR.pcb` has 105 parts outside every outline component after its bad fold.

## 3. Defects, ranked

### D1. Two side conventions, neither validated

The per-board path hard-codes lower coordinate = top; the global path uses the
CPU rule. The copper shows the first matches the exporter and the second is
wrong about half the time, so single-board and pack deliveries of one board
disagree, and nothing checks either against the copper when it is available.
There is no per-board override.

### D2. The store's forward fold transforms only parts, traces, and outline

`deriveBoardView` mirrors parts and traces and filters the outline. It leaves
`board.pads` (bounds, drawn by their own geometry), `board.silkscreen`
(9,518 paths on the iPhone 16 pack, including every per-part body outline),
`board.vias`, and `board.nails` untouched. After selecting a board the
bottom-side pads and silk stay at their raw positions on the other half, or
vanish off the kept outline. The parser's global fold handles all of these;
the store re-implements a subset.

### D3. Pairing by exact `(round(w), round(h), segCount)` is brittle

Seen in the corpus: a one-segment difference between halves (`iPhone5`),
a bottom half with extra outline features (`iPhoneXSMAX boardview`, 431 vs
340), internal cutouts and fiducial loops reported as boards (iPhone 6/6s/8),
nested outlines reported as boards (`17Pro Mid level`). Not yet seen but
possible: two boards with identical outlines landing in one bucket of four.

### D4. The multi-board gate is all-or-nothing

One unpaired component and `findFoldAxis` proceeds to the centroid-gap search
on a multi-board file. `XR.pcb` and `iPhoneSE boardview` are folded across two
physical boards today; this is the bug `e75188c` fixed for iPhone 14 Pro,
still reachable on any file the exact key does not fully pair.

### D5. Part-to-board membership is by bbox containment

`belongsToKept` tests part origins against component bboxes. Boards with
L-shaped or interleaved outlines have overlapping bboxes, so parts leak into
the neighbouring board's view. Cutout bboxes sit inside the board bbox and
match twice. The parser has the chained outline polygons and could decide
membership once, precisely.

### D6. Chirality correction is unreliable on packs

See §2.3. No per-board mirror check exists after a forward fold, and the
file-wide pass can mirror a correct pack.

### D7. Default view is the raw pack with every part on "top"

On load, `selectedBoardIndex` is null and the file renders as four flat
halves. The Top/Bottom toggle does nothing, and nothing in the canvas
suggests that a fold is available; the control is a radio group in the
sidebar. To a user this reads as "unfold is broken".

### D8. Boards are anonymous

"Board 1 / Board 2" with dimensions. The file name carries `AP+BB`, and the
largest part identifies the board unambiguously.

### D9. Duplicate clustering code

`detectOutlineComponentFold` carries its own O(n²) union-find that
`clusterSegments` already does with a spatial hash.

### D10. Test coverage

`xzz-parser.spec.ts` only checks that `boardGroups`, if present, has valid
shape. Nothing asserts pairing, axis, or side on a fixture, and the corpus
survey that produced this review lives in a scratch directory.

## 4. Side signals: what the format offers

The unknown part-header bytes were decoded to look for an explicit side field.

- `unk1` (18 bytes): `u32 = 1`, `i32 x`, `i32 y`, `u32 rotation × 10000`,
  `u16 = 1`. Part placement, no side.
- `unk2` (30 bytes after the `0x06` marker): a label element:
  `u32 style (34–40)`, `u32 layer = 17`, `i32 x`, `i32 y`, `u32 height`,
  `u32 stroke`, `u32 rotation × 10000`, `u8 = 2`, `u8 flag`. The flag byte
  correlates one-to-one with two-pin parts at one rotation, so it is a
  label-orientation bit, not a side.
- Pin sub-block: the `u32` after the size is 1 (34 on eight parts); the three
  pad records are identical copies. No side.
- JSON tail: `part[{reference, alias, pad[]}]`, `net[{name, alias}]`,
  `bitmap{x, y}`. No side.
- OpenBoardView's `XZZPCBFile.cpp` hard-codes `mounting_side = Top` and skips
  the same bytes, so there is no upstream decode to borrow.

Usable evidence, strongest first:

1. **Copper oracle** (traces at pin positions on L1 versus the last layer):
   absolute and clean per component on every PCB-layer delivery.
2. **Exporter layout invariant**: within a pair, the lower-coordinate half is
   the design's L1 side. Holds on every pack with copper, and it is the only
   signal available on boardview/YiDianTong packs.
3. **Companion file**: a pack's PCB-layer sibling usually sits in the same
   folder and carries the copper; optional cross-check.
4. **CPU rule**: demote to a tiebreaker for files that are neither packs nor
   carry copper, and log when it is the deciding signal.
5. **User override**, persisted per file.

A pin-order handedness probe (walk direction of pins within BGAs) gave a weak
split that agreed with the copper on some boards and not others; it does not
earn a vote.

## 5. Improvement plan

### Phase 0 — corpus harness (half done)

- Promote the scratch survey into `src/frontend/scripts/xzz-survey.mjs` (or a
  vitest entry) that parses every `.pcb` under `samples/XZZ PCB SAMPLES` or
  `$XZZ_CORPUS` and prints per file: components (bbox, segs, parts, pins,
  largest part), groups, fold decision, copper verdict per component,
  chirality verdict.
- Commit `docs/formats/xzz-corpus-expectations.json` with expectations per
  file: pair membership, which component is the design's top, board names.
  Seed it from the copper oracle for PCB-layer files and from the layout
  invariant for their pack siblings. Proprietary geometry stays out; only
  counts and indices go in.
- Make the survey a test that skips when the corpus is absent, matching the
  fixture-guard idiom in `xzz-parser.spec.ts`.

### Phase 1 — one fold implementation, in the parser

- Extract the global fold's mutation block into
  `applyFold(fold, scope)` that transforms parts, pins, per-part silk, top-level
  silk, traces, vias, test pads, pads, and outline, where `scope` is the set of
  outline components the fold applies to.
- Introduce a board-pack model in `BoardData`:
  `boards: [{ name, top: componentIdx, bottom?: componentIdx, fold?, bounds }]`,
  `part.boardIndex`, and a per-board summary in `parserNotes`.
- The parser folds every board in place, so the raw `BoardData` already has
  correct sides, mirrored pads and silk, and a working Top/Bottom toggle.
  `deriveBoardView` shrinks to selection and layout: which boards to show,
  and where to place them. "Show all sides" keeps using `rawOutline` and the
  pre-fold snapshot.
- Fixes D2, D9, and unifies the two side conventions (D1).

### Phase 2 — robust component classification and pairing

- Classify components: **major** (area ≥ 20 % of the largest), **cutout**
  (bbox fully inside a major component's bbox), **fragment** (everything
  else). Cutouts attach to their enclosing major component as holes; fragments
  are ignored for pairing and logged.
- Pair major components by a score, not an exact key: dimension delta ≤ 2 mil,
  mirror-image test (mirror the candidate's chained outline across the
  candidate axis and take the Hausdorff distance to the partner, tolerance a
  few mil), and adjacency along the separation axis. Greedy best match;
  unmatched majors become single-sided boards.
- Replace `isMultiBoardOutline` with "two or more major pairs, or three or
  more majors, means multi-board". Never fall through to the centroid-gap
  search when three or more majors exist.
- Fixes D3, D4. Unit tests with synthetic outlines: identical twin boards,
  unequal segment counts, a SIM-slot cutout, an eight-component pack, a
  nested outline, and a loop opened by a 1.2 mil gap. Fixture tests on
  `XR.pcb`, `iPhoneSE boardview`, `iPhoneXSMAX boardview`, `iPhone6s`.

### Phase 3 — side determination per board

- Implement the copper oracle and use it wherever routing exists.
- Otherwise apply the layout invariant (lower coordinate = design top).
- Use the CPU rule only when neither applies, and log the decision chain per
  board (`(pcb board AP) side=copper:L1 | fold x@5109 | top=C0 bottom=C1`).
- Run the chirality pass per board after its fold, and cross-check its verdict
  against the copper on PCB-layer files before letting it flip a pack.
- Add per-board "swap sides" and "mirror" overrides in the sidebar, persisted
  per file with the existing view-preference storage.
- Decide the display policy explicitly: the design's top (exporter's L1) is
  the default "Top"; the CPU rule is no longer the definition. Document it in
  `docs/formats/XZZ_FORMAT.md`.
- Fixes D1, D6.

### Phase 4 — precise membership

- Compute part, trace, via, pad, and silk membership by point-in-polygon
  against the chained component outline (holes included), computed once in
  the parser. Fallback: nearest outline component by centroid.
- Fixes D5.

### Phase 5 — presentation

- Default view for packs: every board folded and laid side by side, sides
  working, boards labelled on the canvas. Selecting a board isolates it.
- Board names: tokens from the file name (`AP`, `BB`, `MB`, `SUB`) matched
  to boards by largest-part heuristics, falling back to "Board N".
- Keep "Show all sides" as the raw-layout escape hatch.
- Fixes D7, D8.

### Phase 6 — tests

- Fixture test on `iPhone16_16Plus`: pairs are `{C0,C1}` and `{C2,C3}`, the
  AP board's L1 half is C0, the BB board's L1 half is C3, both boards have
  pads and silk inside their folded outline.
- Cross-delivery consistency test: for each model, the PCB-layer file and the
  pack agree on which half is top.
- E2E: open a pack, confirm the default folded layout, toggle Top/Bottom,
  select one board, swap its sides.
- Corpus survey test from Phase 0 asserting the expectations file.

## 6. Open questions for the maintainer

- Confirm the display policy: should "Top" mean the design's L1 (what XZZ's
  own viewer presumably shows first) or the SoC side? The corpus shows these
  differ on about half the iPhone boards. A screenshot from XZZ's viewer of
  one AP+BB pack settles it.
- `iPhone8 Qualcomm` and `iPhoneX Qualcomm` disagree about whether the mirror
  fix helps or hurts; both need a look in XZZ's viewer.
- Are there four-board packs in the library beyond the iPhone 17 Air MB+SUB?
  None turned up in the iPhone folder.
