# XZZ PCB (Encrypted Boardview) File Format Specification

> Reverse-engineered with reference to the [OpenBoardView](https://github.com/OpenBoardView/OpenBoardView) source.

---

## Overview

XZZ is a partly encrypted binary boardview format. Only the part blocks (which carry the
pins) are DES-encrypted; nets, outline, traces, vias, test pads and text are plaintext.
`parseXZZ` also undoes a single-byte XOR over everything before the `v6v6555v6v6` marker
when byte `0x10` is non-zero (see [XOR Obfuscation](#xor-obfuscation)).

| Property | Value |
|----------|-------|
| Extension | `.pcb` |
| Detection | First 6 bytes = `XZZPCB` (plain or XOR-obfuscated). All 9,113 library files read begin with the 11 bytes `XZZPCB V1.0` (see [Survey sample](#survey-sample)) |
| Encryption | DES (FIPS PUB 46-3), ECB mode |
| DES key | `0xdcfc12ac00000000` (fixed, hardcoded) |
| Coordinate unit | Internal units ÷ 10000 = mils |
| XOR obfuscation key | Byte at offset `0x10` |

### `.pcb` extension collision — Mentor PADS Layout binary

The `.pcb` extension is also used by **Mentor PADS Layout (PowerPCB) native binary
design files**, which are an entirely different and unsupported format (the PADS
database, not a boardview). They begin with the 10-byte signature `00 FF 26 20`
followed by six zero bytes and carry PADS markers in the body (`DOC_PARTTYPES`,
`DOC_PADS`, `DOC_VIAS`, `STANDARDVIA`). `isPadsBinaryHeader()` recognises them so
both `XZZFormat.detect()` and `parseXZZ()` reject them up-front with a clear
"this is a PADS Layout binary, not a boardview" message — otherwise the `.pcb`
extension fallback would hand them to the XZZ parser, which XOR-mangles the bytes
(PADS files have a non-zero byte at `0x10`) and dies on "invalid header offsets".
Even FlexBV does not open these; the binary PADS database is left unsupported.

---

## File Structure

### Header

The file is five regions in this order: header, main block stream, image block, net
block, and — optionally — the plaintext tail after `v6v6555v6v6`.

```
0x00  char[11]  "XZZPCB V1.0" on all 9,113 library files read
0x10  u8        XOR key as parseXZZ reads it; 0 on all 9,113
0x20  u32       main block stream start, relative to 0x20
0x24  u32       image block start, relative to 0x20
0x28  u32       net block start, relative to 0x20
0x40  u32       main block stream size (a copy; see below)
```

At the stream start sits a `u32` size, then the blocks. On all of the 338 sample files
the image block starts exactly where the stream ends, and the net block exactly where
the image block ends. `0x20` holds `0x20` on 337 of 338 sample files (9,078 of the
9,113 library files), which is why reading the
stream at a hard-coded `0x44` usually works; the exception (`jianguo PRO2S-MMR500070
YiDianTong`, 739,625) is also the one file where the size at `0x40` disagrees with the
size at the stream start. Read the offset, then the size there — `parseXZZ` does.

#### XOR Obfuscation

When byte `0x10` is non-zero, `parseXZZ` treats it as a single-byte XOR key and applies it
to **every byte before the `v6v6555v6v6` marker** (the whole file when there is no marker),
not just the header, and leaves the tail after the marker alone. This describes the
parser, not measured files: byte `0x10` is 0 on all 9,113 library files read, so no file
in the library exercises it.

### Image Block

`u32 size`, then `size` bytes of entries: 3 bytes, two `u32`, `u32 nameLen`,
`char name[nameLen]`. What the first five fields mean is unknown. Each name is a Windows
path to an image file, GB2312-encoded (e.g. `D:\…\M1.jpg`): 1,323 of the 1,325 names
in the sample end in `.jpg` and 2 in `.bmp`. Empty (`size = 0`) on 190 of 338 files; on
the other 148 the entries fill exactly the declared size, so the block holds the names
and no image data. `parseXZZ` never reads this block; it jumps to the net block by offset.

### Data Blocks

The main stream is a sequence of `[u8 type][u32 size][size bytes]` blocks. Only type
`0x07` (part) is DES-encrypted; every other block is plaintext. The walk ends exactly at
the stream's declared end on all 338 sample files — no padding or `0x00` bytes between
blocks.

Block types (counts over the sample):
- **Part blocks (`0x07`)** — component data with embedded pin sub-blocks (561,596)
- **Test pad block (`0x09`)** (12,657). See [Test Pad Block](#test-pad-block-0x09)
- **`0x03`** — 36 bytes, 176 blocks in the sample, not read by the parser. See [Block `0x03`](#block-0x03)
- No other block type occurs in the sample.
- **Net block** — not a main block; a separate region located by the header offset
- **Arc block (`0x01`)** — arc geometry on any layer: outline (28), silkscreen (17), copper (1–16). See [Arc Block](#arc-block-0x01)
- **Line block (`0x05`)** — straight segment on any layer, same layer routing as arcs
- **Via block (`0x02`)** (656,846). See [Via Block](#via-block-0x02)
- **Text block (`0x06`)** (10,014) — free board text. See [Text Block](#text-block-0x06)

---

## Encryption

### DES Parameters

- Algorithm: DES (Data Encryption Standard, FIPS PUB 46-3)
- Mode: ECB (each 8-byte block encrypted independently)
- Key: `0xdcfc12ac00000000` (64-bit, fixed)
- Decryption: standard 16-round Feistel network with reversed subkey order

### Block Decryption

Each **part** block's payload (after the 5-byte type/size header) is decrypted as a
sequence of 8-byte DES blocks. Trailing bytes (< 8) are left as-is. No other block is
encrypted: read plain, they produce the layouts below on every sample file.

---

## Data Structures

### Net Block

Sequential entries, each containing:

```
┌──────────────┐
│ u32: netSize  │  Total entry size in bytes, including these 8
├──────────────┤
│ u32: netIndex │  Net identifier (referenced by pins)
├──────────────┤
│ name bytes    │  netSize − 8 bytes. NOT null-terminated
└──────────────┘
```

Over the sample's 314,453 names, **none** ends in (or contains) a NUL — the length is
the terminator; `rstr`'s `replace(/\0/g, '')` is what made "null-terminated" look
plausible. Indices run 1, 2, 3, … without gaps on 332 of 338 files. No entry uses index
0 (0 of 314,453), so a `netIndex` of 0 means "no net".

### Text encoding

Every string in the file — net names, part names, footprint names, pin names, labels,
board text — is GB2312 on files from Chinese tooling and UTF-8 elsewhere, and nothing in
the file says which. Over the sample's net names, footprint names, part-body labels and
board text, the non-ASCII strings are: **1,090** valid only as GB2312, **125** valid as
both, **0** valid only as UTF-8. (Part and pin names were not included in this count.)

Validity alone therefore cannot decide it. Of the 125, 117 are GB2312 that happens to be
valid UTF-8 — 丝印 (`CB BF D3 A1`) reads as `˿ӡ`, 芯片 (`D0 BE C6 AC`) as `оƬ` — and 8
are genuine UTF-8 `×` (`C3 97`) in footprint names on `IQOO15 Ultra-ET3211AM`, which
GB18030 would read as 脳. `decodeXzzText` keeps the UTF-8 reading only when it is made of
characters these files contain (ASCII, Latin-1 symbols such as × ° ±, Greek such as Ω μ,
punctuation, math symbols, CJK), and otherwise decodes as GB18030 — right on all 125. The
character set was chosen from this sample, so a file in another script could need it
widened.

Until PARSER_VERSION 97 every string went through a lenient UTF-8 decode. Chinese came out
as U+FFFD, and `isPlausiblePartValue` then discarded the whole label: on DJI T40 battery
board `PP00266604` 282 of 623 parts had a value, now 574 — 270 more are `Ω` resistor
values; the other 22 contain Chinese text, such as `LAD8C05 L01丝印BB` and
`力特自恢复保险丝 N6 1206L010/60WR`.

### Board packs — split, pair, fold

A `.pcb` draws every board twice: the top side as seen from above and the
bottom side as seen from below, each a closed loop on layer 28, placed side
by side about 20 mil apart (up to ~280 mil on iPhone 4/5-era exports). iPhone
deliveries pack two or three physical boards into one file ("AP+BB",
"MB+SUB"), and older exports add cutout loops (SIM slot, camera hole — up to
28 on the iPhone 6s), fiducials, and the odd sheet-border rectangle. The
parser turns that into `BoardData.boards` in four steps
(`foldBoardPack` in `xzz-parser.ts`, geometry in `xzz-boards.ts`):

1. **Classify loops.** A loop nested inside a larger one is a *cutout* and
   belongs to that board; a 4-segment rectangle enclosing two or more boards
   is a *frame* and is dropped; a tiny empty loop, or an empty plain
   rectangle, is a *fragment*. The rest are board-sized.
2. **Pair halves** by score: bbox dimensions within 3 mil (or 0.2 %), no
   overlap on the separation axis, ≥ 80 % overlap on the other, gap ≤ 300 mil
   or 30 % of the short side. Greedy by score, so two identical boards next
   to each other still pair with their own neighbour. An exact
   `(w, h, segCount)` key is not used: halves differ by one segment on the
   iPhone 5 boardview and by a notch on the XS Max.
3. **Decide the top half.**
   - *Copper* when the file has traces (the "PCB layer" deliveries): a
     half's routed pins all have a trace endpoint on the first copper layer
     or all on the last, never mixed. Decisive at ≥ 20 pins and a 4:1 margin.
   - Otherwise the *layout rule*: the left half (lower x) is the design's
     top; for vertically stacked pairs the upper half (higher y — the raw
     frame is y-up). Verified against copper on 78 of 78 trace-carrying
     files, MacBook and iPhone, including files whose pin winding says they
     are stored mirrored — mirroring changes the winding, not where the
     exporter puts the halves.
   - The most-pinned part's half (the old CPU rule) is right on MacBooks and
     a coin flip on iPhone sandwich boards (the SoC sits on the design's L1
     on iPhone 14/16/17 and on the last layer on X/XS/11/12/13/15). It is
     logged when it disagrees, never obeyed. The sidebar's per-board
     "Swap sides" is the override, persisted per file.
4. **Fold and slide.** Every bottom-half item — pins, per-part silk lines,
   top-level silk, traces, vias, test pads — is mirrored across the pair's
   axis; the bottom half's loops (and its cutouts) are dropped from the
   outline; on a pack the folded boards are slid next to each other.
   `Part.boardIndex`, `boards[i].bounds` (final coordinates),
   `boards[i].fold.axis` (in `rawOutline` coordinates) and `boards[i].shift`
   let the store undo it for the raw-layout view.

**Touching halves (one loop).** The 2008–2015 Apple laptop and iMac exports
draw the two halves edge to edge, so their loops share vertices along the
seam and cluster into one loop; parts run right up to the seam, so no gap
exists either. What gives them away: the loop is its own mirror image about
the seam (92 of 94 single-loop corpus files, never a real single board), and
the pin winding of each half is uniform. `splitSymmetricLoop` cuts the loop
at the symmetric centre line (seam vertices, then the longer side, break a
tie on square-ish loops), keeps the seam segments with the top half, and
hands the halves to the pair path. The winding also says how to fold: a
chip's pins wind counter-clockwise seen from its own side and clockwise seen
through the board, so halves that wind the *same* way are each drawn face-on
and the bottom **mirrors** across the seam (K90I / A1278, A1286, A1398,
A1419 …), while halves that wind *opposite* ways have one half drawn through
the board in the other's frame and the bottom **translates** onto the top
(`fold.mode = 'translate'`, `fold.offset`; the 2008–2013 iMac, Mac mini and
Retina rectangles: 820-2494, 820-2347, 820-2641, 820-3476 …). Which half was
the reference view is then settled by the file-wide chirality pass. Mixed
winding within a half means a single board with both sides overlaid, and is
left alone (A1425 820-3190). On this family the side comes from the CPU rule
(most-pinned part on top, ≥ 500 pins): there is no copper, the stacking order
is not consistent (20 of 89 put the CPU in the lower half), and every
copper-verified Apple board has its CPU on the design's top.

There is **no side field** in the file. The 18 + 30 unknown header bytes of
the part block decode to `[u32 flag][i32 x][i32 y][u32 angle?][u8][u8]` and an
ordinary `0x06` label sub-block whose first `u32` is its own size (see
[Part Block](#part-block)); the pin sub-block's three pad records are
identical copies; the JSON tail carries only names and diode readings.
OpenBoardView hard-codes `mounting_side = Top`.

The file-wide mirror correction stays with the pin-direction detector, run
after the fold: on a folded pack its top-side votes come from one side only,
which removed the false flip on `iPhoneX Qualcomm PCB layer` (the raw pack
had both sides voting at once).

### Outline integrity — the butterfly fold must not eat the loop

The board outline is a set of **closed** loops: the perimeter plus one loop per
cutout. Downstream this is not decorative — the renderer fills each sub-path,
so an open loop is filled by joining its two loose ends with a straight line,
and a broken outline shows up as black wedges laid across the board rather
than as a missing line somewhere.

Two facts make this fragile, and both were learned the hard way:

1. **Arc-sampled corners produce very short segments.** Every outline arc is
   linearised into 9 pieces, so a 90° fillet of r = 14.6 mil steps 0.8 mil at
   a time. Any tolerance-based reasoning about outline segments has to stay
   well under that, or it cannot tell a segment from its own neighbour.
2. **The butterfly fold rewrites the segment list.** It discards the half it
   is not keeping; anything else it removes comes straight out of the visible
   outline.

The bug that taught this (fixed 2026-08-07): the fold's duplicate-edge guard
compared endpoints with a fixed **1-mil** epsilon. Both endpoints of a 0.8-mil
segment lie within 1 mil of both endpoints of the segment it is joined to, so
every arc-sampled fillet was deleted as a "duplicate" of its own neighbour.
The loop was cut open at each rounded corner: on A2485-820-02100-A the outline
went from one closed 767-point loop to **18 open fragments** with end gaps up
to 5,934 mil on a 4,924-mil-wide board. Eight of the 32 corpus files were
affected — the "PCB layer" and YiDianTong AP/BB exports, which are the ones
with fine-sampled arcs.

Two invariants worth keeping:

- **A duplicate is a coincident edge, not a nearby one.** XZZ coordinates are
  integers ÷ 10000 and identical arcs sample to identical floats, so real
  duplicates are exactly equal; `dedupeCoincidentSegments` keys on endpoints
  quantised to 0.01 mil, which is two orders of magnitude below the shortest
  real segment. Duplicate and neighbour are then distinguishable by
  construction rather than by a tuned threshold.
- **Check the pre-fold geometry before blaming the file.** `BoardData.rawOutline`
  holds the un-folded outline. Every corpus file chains into closed loops
  there, so a broken final outline means the fold did it.

For reference, OpenBoardView's `XZZPCBFile.cpp` neither deduplicates, chains,
nor folds — it draws the layer-28 segments as a flat list. Chaining, filling
and the butterfly fold are BoardRipper's own, so their correctness is ours to
own; there is no upstream behaviour to defer to here.

Residual known gap: `SM-G930F S7 YiDianTong` carries a genuine 1.03-mil
discontinuity in its own outline, 3% beyond the chain walker's 1-mil vertex
tolerance. It renders as closed (the fill spans 1 mil invisibly) and the
tolerance is deliberately **not** widened to absorb it — a tuned threshold is
what caused the bug above.

### Part Block

After DES decryption:

```
┌──────────────────┐
│ u32: partSize     │
├──────────────────┤
│ u32: flag         │  1 (558,385 parts) or 16 (3,211)
│ i32: x, y         │  a position (÷ 10000); see below
│ u32: angle?       │  values read as degrees × 10000; see below
│ u8, u8            │  1/0 (547,907/13,689) and 0/1 (558,297/3,299); meaning unknown
├──────────────────┤
│ u32: groupNameLen │
│ groupName bytes   │
├──────────────────┤
│ 0x06 label        │  the refdes — an ordinary label sub-block:
│  u32 size         │    size = 30 + nameLen on all 561,596 sample parts
│  26 bytes         │    same fields as a body label (see Label Sub-Block)
│  u32: nameLen     │
│  partName bytes   │  Reference designator
├──────────────────┤
│ Sub-blocks...     │  0x09 pin, 0x05 line, 0x06 label, 0x01 arc
└──────────────────┘
```

What the "18 unknown" bytes hold, measured over the sample's 561,596 parts. The `u32`
after `x, y` is a whole multiple of 10000 on all but 178 parts. Divided by 10000 it is
0, 90, 180, 270 or 360 on 556,436 parts, and 45, 135, 225, 315, 230 or 310 on 4,396,
which reads as a rotation in degrees; nothing in the parser uses it. `x, y` is within
1 mil of the pins' centroid on 497,165 parts and outside the pins' bounding box on
56,233, so it is not a substitute for the centroid the parser derives.

The refdes is not a dedicated field. `parsePartBlock` reads it at "`0x06` + skip 30 →
`nameLen`" and body labels at "size + skip 26 → `nameLen`"; those are one layout, and the
4-byte difference is the size prefix the header copy is read past inline. Measured: the
`u32` after the `0x06` equals `30 + nameLen` on 561,596 of 561,596 sample parts.

Sub-block counts across the sample: 2,027,462 pins, 1,767,697 lines, 561,790 further
labels, 572 arcs. `parsePartBlock` skips the arcs.

### Label Sub-Block (`0x06`) — component value

A part body may carry `0x06` sub-blocks: silkscreen **text** elements placed
on the part. Same framing as the part header's own `0x06`, minus 4 bytes —
a body sub-block spends those on its own size prefix:

```
┌──────────────────┐
│ 0x06 marker byte  │
├──────────────────┤
│ u32: size         │  Payload length
├──────────────────┤
│ u32: layer        │  17 on 557,851 sample labels, 18 on 3,938, 1 once
│ 12 bytes          │  not measured
│ u32: unknown      │
│ u32: angle?       │  a multiple of 900000 (90° × 10000) on all but
│                   │  160 of 561,790 labels
│ u8, u8            │  1–3 and 0/1; meaning unknown
├──────────────────┤
│ u32: textLen      │  0 when the element carries no string
│ text bytes        │
└──────────────────┘
```

**What the text holds is exporter-specific**, and this is the whole
difficulty of the field:

- MSI (and other Cadence/PADS re-exports) write the **BOM value** — `22uF`
  under `C757`, `1nF` under `C905`. That is the useful case: the parser
  lifts it into `Part.meta.value`, which the Info pane, net branch list and
  MCP part search all already render.
- Apple's exporter writes a **serialised placeholder** — `Device1`,
  `Device2`, … one per part, never repeated. Seven boards in the local
  corpus do this, up to 4,955 labels on a single board.
- Most boards (iPhone, Samsung, iPad, MECHREVO) write `textLen = 0`.

The parser therefore takes the first body label that isn't the refdes, then
applies a **board-level placeholder guard** before committing any of them: a
value column that is ≥95% distinct across ≥20 parts *and* ≥80% alphabetic-
then-numeric (`Device1`, `Part207`) is exporter scaffolding, not a BOM — a
board full of passives repeats `100nF` and `10K` constantly — so the whole
channel is dropped and no part gets a value. Real values lead with the
magnitude (`22uF`, `10K`, `0R`) and so never match the serial pattern.
Logged under `(pcb values)` either way.

### Pin Sub-Block

Within a part block, pins are encoded as typed sub-blocks:

```
┌──────────────────┐
│ u32: pinBlockSize │
├──────────────────┤
│ u32: flag         │
├──────────────────┤
│ i32: x            │  Pin X position (÷ 10000 for mils)
│ i32: y            │  Pin Y position (÷ 10000 for mils)
├──────────────────┤
│ u32: drill        │  Through-hole drill diameter (÷ 10000 for mils);
│                   │  0 on an SMD pin. See below.
│ u32: padAngle     │  Pad rotation in degrees CCW (÷ 10000)
├──────────────────┤
│ u32: nameLen      │
│ name bytes        │  Pin name
├──────────────────┤
│ 27 bytes: pad geom│  3 × (u32 padW, u32 padH, u8 shape) — three identical
│                   │  copies (top/inner/bottom?); w/h ÷ 10000 for mils;
│                   │  shape 0x01 = round, 0x02 = rect
├──────────────────┤
│ 5 bytes: zero     │  terminator of the pad-record list (see below)
├──────────────────┤
│ u32: netIndex     │  Reference into net block
├──────────────────┤
│ optional:         │
│ u32: readingLen   │  a short string stored on the pin,
│ reading bytes     │  e.g. "OL", "142"
│ 4 bytes           │
└──────────────────┘
```

**After the net index.** On 1,711,805 of the sample's 2,027,462 pins, 8 bytes follow the
net index: `u32 readingLen = 0` and four more bytes. 314,332 pins end at the net index.
The other 1,325 pins, all in one file (`Y93-PD1818 YiDianTong`), have `readingLen` 1–3,
the string, and four more bytes. The strings are values like `OL`, `0`, `142` and `358`,
the same form as the diode readings in the tail; that they are readings is an inference.
`parsePinSubBlock` ignores this section, which is harmless for the geometry because it
reads positionally and stops at the net index.

**Drill diameter.** This field was documented as a constant zero for a long
time, because the boards surveyed first are SMD-only. It is a drill: non-zero
means the pin is through-hole, and the value is the hole diameter on the usual
÷10000 = mils scale. Evidence, gathered independently on two disjoint corpora
(Sean Johnson, [@sjohnson1021](https://github.com/sjohnson1021), issue #32 —
Switch / PS5 / MSI; and 32 local `.pcb` files, 415,520 pins):

- **The annular-ring relation never breaks.** The value is always strictly
  smaller than both pad dimensions — 253 non-zero readings here, zero
  inversions. A flag field has no reason to respect a physical constraint.
- **It is sparse and it lands where through-holes live.** 0.03–0.43% of pins
  per file, on connector legs, headers and mounting pins. (This bullet used to
  add "never on a top-level `0x09` test pad". That held for the 32-file corpus
  but not for the 338-file sample: 1,978 test pads in 38 files carry a
  drill — 1,486 of them on five Xbox 360 boards, the other 492 spread over 33
  files — and on 1,964 of those it is smaller than both pad dimensions.)
- **One drill spans two pad shapes on the same part.** `N2494` on
  A2442-820-02098-A carries drill 10.5 on both its 20×26 oblong pads and its
  round ones — what you would expect of a bit diameter, not of anything
  derived from pad geometry.
- Only the "PCB layer" export family populates it; the "boardview" variants of
  the very same Apple boards leave it zero.

Parsed into `Pin.drill` / `Pad.drill`, and any part with a drilled pin is
typed `throughhole` instead of the blanket `smd` every XZZ part used to claim.

**Slots.** The hole in an oblong pad is the *same capsule at a smaller
radius*, not a circle centred in it: a stadium is every point within `r` of a
line segment, so the pad is that segment inflated by `min(w,h)/2` and the slot
is the same segment inflated by `drill/2`. The copper ring is then uniform all
the way round, caps included, with no margin to tune. The renderer gets this
for free by drawing the pad shape at a negative `grow` of `−(min(w,h) − drill)/2`,
since `grow` is a true geometric offset and cancels out of the centre→cap
distance. Square pads degenerate to exactly `circle(drill/2)`; non-round shapes
keep a plain circle, because a shrunken rectangle is not a drill.

**Pad-geometry record list.** The 27 bytes after the pin name are documented
above as three fixed chunks. They are really a terminated record list —
`(w, h, type)` records until a `type` byte of `0x00`, then a 5-byte terminator
— and "read the first, skip 32" is only correct because every pin carries
exactly 3 records. That holds for all 415,520 pins here, across the issue
#32 corpus (Sean Johnson, @sjohnson1021), and for all 2,027,462 pins of the
338-file sample, so there is nothing to fix against; a file with 1, 2 or 4+
records would silently misalign the `netIndex` read rather than fail loudly.

A caution for anyone who does switch to the terminated reading: the terminator
test ("`u32 = 0` and next byte `= 0`") also matches a pad record whose width is 0,
such as a **0 × 0 pad** (`00000000 00000000 01`). On 366 sample pins in nine files
(`V372_71`: 295) the scan stops at the first record, and the net index it then reads
disagrees with the one at the fixed offset, which every other pin agrees on.

**Oblong pads (shape 0x01 with w ≠ h).** Shape `0x01` is not strictly a
circle: with w ≠ h it encodes a round-capped stroke (stadium). The pen width
is whichever dimension is **shorter** and the stroke length whichever is
longer — there is no fixed axis, either field can be the pen — rotated by
`padAngle` CCW. The surveyed
MECHREVO corpus (PL5TU1B) writes a constant 15-mil pen with lengths 1–350
mil. Renderer draws these as rotated capsules (`capsuleParams` in
`renderer/pad-capsule.ts`). Three caveats, handled by
`normalizeOblongPads` in the parser (run before the butterfly fold):

1. **Bogus lengths on BGA perimeter rings.** CPU1's outer 2–3 ball rings
   carry 15×300/350 entries that would cross a dozen neighbouring balls;
   the vendor's own assembly drawing shows plain 15-mil dots there
   (probably escape-stub metadata, not pad copper).
2. **One angle per part.** The exporter stamps a single `padAngle` on every
   pin of a part, but a QFP's top/bottom leads are physically perpendicular
   to its left/right leads (EC1: all 128 pins say 270°).
3. **Degenerate strokes** (h ≤ w, e.g. 15×1) — effectively dots drawn with
   the 15-mil pen.

The guard is physical — copper pads of different pins can never overlap:
an oblong is kept at its declared angle if it touches no same-part
neighbour's pen circle, else retried at +90° (fixes the QFP sides), else
collapsed to a pen-width round dot. A majority pass then collapses
gap-threading stragglers of a mostly-bogus (w, h) group (CPU1 pin W1).

**Placeholder pad geometry.** Some exports — all surveyed M2-era Apple board
files (820-02773, 820-02862, and the `-H`/`-L` CPU variants of 820-02098 /
820-02100 / 820-02382) — write the SAME pad geometry on every pin of the file:
12×12 mil, shape `round`, angle 0. This is exporter filler, not real pad data
(a 125-mil coil pad and a BGA ball get the identical 12-mil dot). Real-geometry
files carry 180+ distinct sizes, so the two populations are cleanly separable.
The parser detects the placeholder (≥100 geometry-carrying pins, every one
sharing a single identical `(w, h, shape, angle)`, shape round, w = h) and
drops pad geometry entirely for that file — pins fall back to the classic
radius-8 dot and the renderer synthesizes the classic FlexBV 2-pin pads.

---

## Arc Block (`0x01`)

Eight `u32` fields. Multi-layer files write all eight (32 bytes); older files stop after the
six geometry fields (24 bytes), so width and net index are read only when present. (All
68,558 sample arcs are 32 bytes.) The net index is not only a copper field: 23,595 of
23,763 copper arcs and 23,967 of 44,795 non-copper arcs carry one, and every non-zero
value resolves in the net block.

```
┌───────────────────┐
│ u32: layer        │  28 = outline, 17 = silkscreen, 1–16 = copper / mask
│ i32: cx           │  centre X (÷ 10000 → mils)
│ i32: cy           │  centre Y
│ i32: r            │  radius
│ i32: angStart     │  start angle, degrees × 10000
│ i32: angEnd       │  end angle, degrees × 10000
│ u32: width        │  trace width (÷ 10000), copper arcs only; optional
│ u32: netIdx       │  net index into the Net block; optional
└───────────────────┘
```

Angles share the coordinate scale (÷ 10000), not ÷ 10. The wrong divisor wraps every arc
through `cos`/`sin` and paints star-burst geometry over the outline.

### Arc direction — the sweep is always counter-clockwise from `angStart` to `angEnd`

A `(centre, radius, start, end)` record names **two** arcs: the counter-clockwise one and
the clockwise one. Both share their endpoints exactly, so normalising the sweep is not
angle hygiene. It is the choice of which arc gets drawn, and no endpoint check can see a
wrong choice. Only the midpoint tells them apart.

XZZ arcs run counter-clockwise from `angStart` to `angEnd`. The parser lifts a negative
difference by 360° and never reduces:

```ts
sweep = end - start
if (sweep < 0) sweep += 360        // lift; never reduce into ±180
```

The rule that must **not** be used is the shortest-arc rule (swap the endpoints so
`start < end`, then clamp the sweep to ≤ 180°). That rule replaces every arc over 180°
with its complement, so every notch, slot mouth and re-entrant corner fillet in the board
edge renders as an outward lobe of the same radius, anchored at the same two points.
This was the shipped behaviour until v0.36.1 (issue #33).

Evidence for the convention comes from the files, not from a spec: exporters mirror arcs
about the board axis by reflecting each angle **and** swapping start/end. An undirected
chord would have no reason to reorder its endpoints, so the stored order carries the
direction. GenCAD, Allegro and Altium use the same convention (see `CAD_FORMAT.md`).

The rule only differs from the shortest-arc rule for arcs sweeping 180° or more. Over a
96-board corpus, 276 of 19,964 arcs (1.4%) move, all of them ≥ 180°, and no arc below
180° changes at all.

**Test vector** — `Mini4 Pro-PP003675.04 MB PCB layer.pcb`, layer 28, raw integer units.
Midpoint = `(cx + r·cos(a0 + sweep/2), cy + r·sin(a0 + sweep/2))`. The endpoints are
identical under either rule; the midpoint is the check.

| id | centre (x, y) | r | start | end | sweep | correct midpoint | shortest-arc midpoint |
|----|---------------|---|-------|-----|-------|------------------|-----------------------|
| A | 532474990, 531872990 | 307610 | 1130129 | 3472309 | 234.218° | 532277764, 531636927 | 532672216, 532109053 |
| B | 518264289, 531735380 | 331240 | 1615879 | 516079 | 250.020° | 518358909, 531417942 | 518169669, 532052818 |
| C | 515725710, 531735380 | 331240 | 1283920 | 184120 | 250.020° | 515631090, 531417942 | 515820330, 532052818 |
| D | 501515009, 531872990 | 307610 | 1927690 | 669870 | 234.218° | 501712235, 531636927 | 501317783, 532109053 |
| E | 508875000, 533275000 | 235000 | 0 | 900000 | 90° | 509041170, 533441170 | same |
| F | 500995000, 501069060 | 519060 | 2250000 | 2700000 | 45° | 500796364, 500589511 | same |

A and D fail the clamp half of the shortest-arc rule; B, C fail the swap half. Removing only
one of the two lines fixes one arc in four, which is enough to look like a fix. The unit test
is `src/frontend/tests/arc-sweep.spec.ts`; the rule lives in `xzzArcSweepDeg`.

### Linearisation

Every arc is sampled into 9 straight segments (10 points, matching OpenBoardView) before it
leaves the parser. Each segment gets its own endpoint objects. Later passes (butterfly
mirror, mirror-detect flip, origin normalisation) mutate endpoints in place, so a point
object shared between two adjacent segments would be transformed twice per pass and land
far off the board.

---

## Line Block (`0x05`)

28 bytes on all 5,131,279 sample lines: `u32 layer, i32 x1, y1, x2, y2, u32 width,
u32 netIndex`. Layer 1–16 is copper (5,035,541), 17 silkscreen, 28 outline. The last
field is the net index, which `parseXZZ` already reads: non-zero on 5,034,572 copper
lines, and every non-zero value (copper or not) resolves in the net block. Non-copper
lines carry one too: 38,046 of the 95,738 in the sample have a non-zero net index.

## Via Block (`0x02`)

```
i32  x, y
i32  pad      annular ring diameter (÷ 10000)
i32  drill    hole diameter
u32  layerFrom, layerTo
u32  netIndex
u32  textLen  0 or 1
char text[textLen]   always "0" when present
```

32 bytes (324,654 vias) or 33 (332,191); `textLen` accounts for the difference on all
but one (a single 28-byte via, which stops before `textLen`). `pad ≥ drill` on every
via, strictly greater on all but 72 — all in `PP00266604`, where the two are equal.
`layerFrom < layerTo` on all 656,846; the net resolves on 656,843. The comment on
`parseViaBlock` calls bytes 28–32 padding: it is `textLen`.

## Test Pad Block (`0x09`)

A top-level `0x09` is a test pad. It has the same layout as a part's pin sub-block —
`u32 padNumber, i32 x, y, u32 drill, u32 padAngle, u32 nameLen, name`, three
`(w, h, shape)` records, a 5-byte terminator, `u32 netIndex` — followed, when the block
is longer than `60 + nameLen`, by `u32 readingLen, char reading[readingLen]` and 4 more
bytes (on all 6,003 that have it).

**The net index is at `24 + nameLen + 32`, not in the last 4 bytes.** 6,003 of the
sample's 12,657 test pads carry the trailing section. Read at the structural offset, the
net resolves on 9,405 pads and is 0 (no net) on the other 3,252 — never a dangling
index. Read from the last 4 bytes — what `parseTestPadBlock` did until
PARSER_VERSION 94 — it resolves on 6,570. The two disagree on 2,835 pads: on every one,
the structural offset resolves and the last 4 bytes are 0, so each of them lost its net.
After the fix, iPadAir3 820-01531 YiDianTong goes from 0 of 538
test pads with a net to 530, and the other 8 are on `NC`, which nails deliberately blank. The trailing
string is empty on 5,960 pads; the other 43 are all in `Y93-PD1818 YiDianTong`, with values
like `OL` and `375`.

## Block `0x03`

36 bytes on all 176 blocks in the sample; not read by the parser, and its layout is
unknown. The first `u32` is 17 on 169 blocks, 22 on 4, 1 on 2 and 18 once.

## Text Block (`0x06`)

A top-level `0x06` is free board text — not to be confused with the `0x06`
label sub-block inside a part body. Plaintext, never DES'd.

```
u32  layer       18, 29, 17, 1 or 21 (see below)
i32  x, y        ×10000, same frame as every other coordinate
u32  size?       read as text height ×10000; the table code relies on it
u32  unknown     48 distinct values, most often 100, 2000, 4000, 100000
u32  angle?      read as degrees ×10000 (values below)
u8   unknown     1–4
u8   unknown     0 or 1
u32  len
char text[len]   GB2312 on files from Chinese tooling, else UTF-8
```

Laid out like a part's `0x06` label sub-block. Over the 10,014 text records
in a 338-file sample of the XZZ library (all 11 "Common problems" boards plus up
to 12 files per second-level folder): `block_size − 30 − len` is 0 on every one,
so nothing trails the string.
Layers: 18 on 6,016, 29 on 2,551, 17 on 1,245, 1 on 141, 21 on 61. The angle field
divided by 10000 is 0 on 7,303, 360 on 2,352, 270 on 271, 180 on 59, 90 on 23, and
18, 30, 210, 225 (twice) and 359.555 once each.

**Encoding.** Decoded like every other string in the file (see
[Text encoding](#text-encoding)). Of the sample's 603 non-ASCII text records, 601 are
valid only as GB2312; the other 2 are valid as both and are GB2312 too — 芯片, which
UTF-8 would read as `оƬ`, on the iPhone 6 and 6 Plus "Common problems" boards.

**What it carries.** On the "Common problems" boards it carries a repair table —
fault symptom, fault point, fix — drawn as loose text over a handful of ruled
silkscreen lines, plus short values drawn as text. iPhoneXSMAX Common problems:

| layer | size (mils) | count | content |
|---|---|---|---|
| 17 | 4–200 | 29 | table caption, header and cells (26 Chinese, 2 net names); one 4-mil board label (`R1403_K`) |
| 1 | 40–100 | 4 | designators inside table cells (`J3200`, `U3900`, `U2900`) |
| 18 | 2 | 520 | short values (`OL`, `582`, `696`, …) |

### Annotation tables

The ruled lines do not delimit the text (every label on iPhoneXSMAX sits in
one drawn column band), so `parsers/annotation-tables.ts` rebuilds the table
from coordinates, in the file's own frame before any fold:

1. **Collect** every non-Latin label, then ASCII labels inside their box set at
   ≥ half the median non-Latin size. Size is what keeps silkscreen out of an
   over-the-board table: on iPhone6Plus the box holds 2,204 ASCII texts, of
   which the 83 at table size (30 and 60 mils, against 1 for the rest) belong.
2. **Drop to notes** anything below a quarter of the median. Without this, three
   1-mil legend labels on iPhone6Plus become a table's caption, and one 2.5-mil
   label on iPhone6S merges its two tables into one 7-column table.
3. **Split side by side** at an x gap of 1,500 mils. Column gaps inside a table
   reach 900 (iPhone7Plus Qualcomm); gaps between tables run 1,532 (iPhone6S) to
   4,987 (iPhoneX Qualcomm) — a thin margin on the low side.
4. **Rows** by an Otsu split of the vertical gaps. On the 17 tables it lands at
   43–86 mils; a fixed 67 would give different rows on two of them (iPhone8Plus
   and iPhoneX Qualcomm).
5. **Reject** a group whose largest row holds > 40 % of its labels (the iPhone12
   flowchart: 24 of 31; real tables 4–39 %, the 39 % on iPhone6SP — close to the
   limit) or whose header has fewer than 3
   columns (the iPhoneXS flowchart; every real table has 3 or 4). Its labels
   become notes.
6. **Caption** is a run of up to three lone labels at the top; the next row is
   the header, whose x positions anchor the columns; every other label goes
   to its nearest anchor.

Measured on the 13 boards in the XZZ library that carry such text: all 11
iPhone "Common problems" files give 1 or 2 tables (17 in all, 2–22 rows,
3 or 4 columns) and both repair flowcharts give none.

The result is `BoardData.annotations`: `tables` (caption, header, rows of
multi-line cells, relative column weights, `rawBounds` in the pre-fold frame)
and `notes`, the annotation-language labels no table took.

## Board Outline

The outline is built from line blocks and linearised arc blocks on layer 28
(`OUTLINE_LAYER`). `chainByComponent` first groups segments into connected components by
shared endpoints (`clusterSegments`), then chains each component into its own sub-path,
separated from the next by a NaN point. A single greedy chain across the whole layer
jumped between unrelated loops. See [Outline integrity](#outline-integrity--the-butterfly-fold-must-not-eat-the-loop)
for duplicate removal.

---

## Coordinate System

- Raw coordinates are signed 32-bit integers
- Divide by 10000 (`XZZ_SCALE`) to get mils
- The `flipY` flag is enabled for this format

---

## Parser Notes

- Side: `parsePartBlock` returns `'top'` for every part. The side is assigned afterwards
  by the fold (see [Board packs](#board-packs--split-pair-fold)); the file has no side field.
- Pin radius is half the smaller pad dimension (0.5 mil floor); a file with placeholder
  pad geometry falls back to an 8-mil dot.
- The DES implementation uses precomputed SP (S-box + P permutation) lookup tables and
  byte-level IP/FP permutation tables for performance.
- BigInt is used only for one-time key schedule computation at module initialization.

---

## Annotation Section (post-`v6` tail)

Everything after the `v6v6555v6v6` XOR-boundary marker is plaintext — it is
never XOR'd or DES'd — and sits past the net block. It carries reference
("golden board") **diode-mode multimeter readings**, and, in the newer
encoding, the rename tables XZZ's own viewer uses for part designators and net
names. None of it is geometry.

### Sections

The tail is line-oriented and split by `===<name>` marker lines. The name is
**GB2312**, so a UTF-8 or latin-1 dump shows it as a few "binary bytes": the
"4 binary bytes" in encoding A below are `D7 E8 D6 B5`, 阻值, and the JSON
banner's are `B8 BD BC D3`, 附加. A marker may carry its payload on the same
line, so the name runs only to the first `{` or `[`.

Of the 338 sample files, 138 have a tail. Its line breaks are LF on 122 and CRLF on 16.
Section markers seen, by number of files:

| section | files | content | read by the parser |
|---|---|---|---|
| `===PCB附加` | 113 | encoding B, one JSON line | yes |
| `===阻值` | 56 | encoding A — but see below | yes |
| `===信号` | 12 | net glossary, `NETNAME=description` | yes: `netDescriptions` |
| `===原理图` | 6 | one line: a PDF file name (6 of 6) | no |
| `===` (no name) | 4 | whitespace-separated fields: 3 on 5,637 of 5,640 lines | no |
| `===阻值表` | 3 | `NETNAME=value` lines, e.g. `PP3V0_TRISTAR=379` | no |
| `===阻值图`, `===电压`, `===RFFE` | 1 each | `NETNAME=value` (e.g. `I2C1_AP_TO_MIC2_SCL=395`); `NETNAME=voltage` (e.g. `PP1V8=1.8V`); one line starting `[{"BusName"` | no |

**Encoding A pins are not all numbers.** Of the 23,821 `=value=PART(pin)` lines under
`===阻值`, 8,833 (37 %) name a BGA pad — `N485(D9)`, `N489(AM14)`. Until PARSER_VERSION
95 the legacy record regex required `\d+` and silently dropped every one of them; it now
takes the same `[A-Za-z0-9_]+` as the part name, which matches exactly the old 14,988
records plus these 8,833 and nothing else. On `iPhone14 Pro_ProMAX Boardview
820-02588-10 820-02672-12` that is 1,007 → 3,956 readings on pins (all of its 3,963
records but 7 repeated keys). Another 685 lines under
`===阻值` have the per-net form `NETNAME=value`, and one is two of those run together on
a single line.

**Net glossary (`===信号`).** One `NETNAME=description` per line up to the
next marker. The description is Chinese prose ("CPU到显示屏接口MIPI总线数据1").
Split on the **first** `=`, because descriptions contain their own (15 of 531
lines on iPhoneXSMAX Common problems). A net may be listed twice (26 repeats on
that file, all word for word), and the last one wins. Decode line by line, because
one tail can mix encodings (GB2312 markers and prose, UTF-8 JSON). The glossary is
written for the whole board, so it names nets a partial file does not carry: 421 of
that file's 505 described nets are in its net block, and 420 reach a parsed net.
Surfaced as `BoardData.netDescriptions`, keyed by the net's final name (after
`netAliases`); nothing renders it yet.

There are **two encodings** of the diode readings, and a tail can carry both.
`parseXzzTailAnnotations()` reads both encodings, by content rather than by file name:

- **Legacy records** are scanned for over the whole tail, always.
- **The JSON document** is located by its `===PCB<GB2312>` banner and parsed from the
  first `{` after it **to the next `===` marker**, not to the end of the tail.
- **On a key both define, JSON wins.**

Until PARSER_VERSION 96 the parser tried JSON at the first `{` within the tail's first
4 KB and, if that parsed, returned it alone. Three things went wrong, all on real files
(32 of the 138 tail-carrying files in the sample yield readings from both encodings):

1. Legacy records before the JSON were discarded. iPadAir3 820-01531 YiDianTong has 158,
   and the JSON has 2; 2 readings reached the pins, now 160.
2. JSON past the first 4 KB was never found. On iPhone14 Pro_ProMAX Boardview the JSON
   starts 67 KB in, behind 3,963 legacy records; its 44 extra readings now arrive
   (3,956 → 4,000).
3. JSON followed by another section (`===原理图` and a PDF name) failed `JSON.parse` and
   was dropped whole, rename tables included. MI 12-35100L3MOA now gets its 40 net
   renames.

Only 48 pins in the sample carry a reading in both encodings. On 44 of them the values
differ — legacy `24`, JSON `240`; pins 119/120 swapped on iPhone13 boardview(Diode
value). The file does not say which is right; the parser prefers JSON.

### Encoding A — legacy records

Older companion files named `… Middle layer diode value-<board>.pcb`. Diode
values only.

```
v6v6555v6v6===<4 binary bytes>\n
=359=N47(21)
=0=N47(31)
=OL=N46(1)
=732=N47(7)
…
```

- Grammar: newline-delimited `=<value>=<partName>(<pinName>)`, **one record
  per pin**.
- Value classes: integer **millivolts** (e.g. `359`), `OL` (open / infinite),
  `0` (no reading / tied to ground). A rare malformed token like `312.` is
  tolerated (trailing dot stripped).
- Join key `PART(pin)` maps 1:1 onto the parser's pins — this is why the
  parser now preserves the real pad number (`Pin.number`) instead of a 1-based
  index.

### Encoding B — JSON document

Current deliveries (iPhone-era boards; first seen on iPhone16_16Plus) put a
single JSON document there instead, after a **GB2312** banner line — decode the
banner as UTF-8 at your peril, and locate the `{` on the raw bytes:

```
v6v6555v6v6\n===PCB<4 GB2312 bytes>\n
{"part":[
  {"reference":"N02615","alias":"J10600","pad":[
     {"name":"22","diode":"538"},{"name":"10","diode":"OL"}]},
  {"reference":"C343","alias":"C10602"}],
 "net":[{"name":"Net21","alias":"PP_VDD_MAIN"}],
 "bitmap":{"x":50000,"y":50000}}
```

- `part[].pad[].diode` — same value classes as encoding A. Pad names here are
  **not** `\d+`-only: BGA pads appear as `M7`, `L9`, … which the legacy record
  grammar cannot express at all.
- `part[].reference` — the internal id; `part[].alias` — the designator XZZ's
  viewer displays. Which of the two the *binary* blocks use **varies between
  deliveries of the same board**, so the diode join tries both keys and the
  rename is applied only where the binary named the part by `reference`.
- `net[].name` → `net[].alias` — same idea for net names.
- `part[].value` — a free-text component value on a minority of parts. Parsed
  over, not consumed.
- `bitmap` — a coordinate origin for XZZ's own bitmap overlay. Ignored.

A JSON tail can carry the rename tables and **no `pad[]` at all**: that file
genuinely has no diode data. The two deliveries of iPhone16_16Plus are exactly
this pair — `AP+BB Boardview.pcb` has 4750 readings, `AP+BB YiDianTong.pcb`
has none, and both are otherwise the same board.

### Joining and applying

`parseXzzTailAnnotations()` returns the diode table keyed both ways, plus the
two rename maps; `parseDiodeSection()` is the thin wrapper that returns just
the readings. The join stamps `Pin.diode` and sets `BoardData.diodeReference`
(counts + match diagnostics). Normal boardviews have no marker → everything
empty → no channel.

Both renames refuse to merge two distinct entities into one name. A target
collides only when an *existing* name is not itself being vacated by another
rename, so a chain of renames still goes through while a genuine clash is
skipped and logged. Net renames run before `buildNets`, because net identity in
this codebase **is** the string.

The readings are surfaced on-pin (a three-state overlay button: off → on →
diode-only, the last hiding pin numbers and net names board-wide), in the hover
tooltip, and in the ComponentInfo pin table; OpenBoardData provides a second,
per-net source feeding the same surfaces (see `store/diode-readings.ts`).

---

## Survey sample

Figures in this document marked as coming from the "338-file sample" were measured on
files drawn from a mirror of the XZZ library (9,131 `.pcb` files): all 11 "Common
problems" files, plus up to 12 files per second-level folder (`Phones/iPhone`,
`Computers/1 Laptop`, `Game Consoles/XBOX`, …), picked with a fixed seed. Totals: 561,596
parts, 2,027,462 pins, 5,131,279 lines, 68,558 arcs, 656,846 vias, 12,657 test pads,
10,014 text records, 314,453 net names. The files are not redistributable; every figure
is given in full so it can be re-derived from any copy.

The header figures (signature, byte `0x10`, the offset at `0x20`) were also read from
every `.pcb` file in the mirror's manifest: 9,113 of its 9,131 entries could be opened;
the other 18 are not on disk under their listed name.

Where a figure is not from the
sample, the text says where it comes from (the parser's code, or a named file).

## Validation fixtures

Local-only (`samples/` is gitignored), in `samples/XZZ PCB SAMPLES/`.
`src/frontend/tests/xzz-diode-json-tail.spec.ts` and
`tests/diode-only-labels.spec.ts` skip rather than fail when they are absent.

### `iPhone16_16Plus/` — the annotation-tail pair

Two deliveries of **one** board (Apple 820-03296 AP + 820-03297 BB, rendered as
two board groups). The pair is the fixture: same PCB, both carrying a JSON
tail, and only one of them carrying diode data. A parser that reports "no
readings" for both — what shipped before v0.37.1 — and one that reports them
for both are equally wrong, so neither file proves anything on its own.

| | `AP+BB Boardview.pcb` | `AP+BB YiDianTong.pcb` |
|---|---|---|
| bytes | 2 283 339 | 2 061 270 |
| parts / of which single-pin | 4686 / 2346 | 4645 / 2341 |
| pins · nets · pads · silk paths | 14521 · 1302 · 14521 · 9518 | 14444 · 1300 · 14444 · 9335 |
| outline points · board groups | 2565 · 2 | 2565 · 2 |
| tail encoding | `json` | `json` |
| diode records → pins stamped | **4750 → 4195** | **0 → 0** |
| value / OL split | 3300 / 1450 | — |
| part aliases · net aliases | 2301 · 38 | 2301 · 0 |
| part renames applied | 3 (172 skipped) | 2297 (4 skipped) |

Reading the asymmetries, all of which are the point of keeping both files:

- **Renames.** The Boardview binary already names parts by the designator, so
  its 2301-entry alias table is almost entirely a no-op (3 applied). The
  YiDianTong binary names them by internal id (`C356_1`), so nearly the whole
  table applies (2297). Same table, opposite effect — which is why the diode
  join tries both the `reference` and the `alias` key rather than picking one.
- **Net aliases.** 38 in the Boardview file, and **0 of them apply**: they name
  `NetNN` ids this parser does not produce (its nets come from the net block
  with real names already). The collision guard no-ops correctly; a future file
  whose ids do match will exercise the other branch.
- **567 unmatched readings** are pre-existing parse gaps, not join misses:
  331 belong to parts absent from the board, 236 to connector/BGA pins not
  emitted (`U4000` parses as **1** pin against 88 JSON pads; `J10400` has 26
  parsed pins against 22 JSON pads that only partly line up). Treat a drop
  below ~4180 stamped pins as a regression; treat a rise as progress on the
  pin-extraction side, not on the tail parser.
- **2346 single-pin parts** (half the board) is why diode-only mode has to
  suppress single-pin designators: those are drawn *on* the pin, not on a body.

Served by the dev container at <http://localhost:1234> (see
`docs/RELEASE_RUNBOOK.md` ▸ "Before a release"), which mounts `samples/` as its
whole library — this pair is the fastest way to eyeball the diode channel.
