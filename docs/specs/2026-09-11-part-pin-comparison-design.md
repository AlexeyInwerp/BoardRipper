# Part pin comparison — design

**Date:** 2026-09-11
**Status:** shipped — the tool in v0.40.0, the board highlight, hover line and
refined name rules in v0.41.0
**Scope:** compare one component's pinout across two open boards, pin by pin, with
the differences called out.

---

## 1. The problem

Apple logic boards come in families. `820-00840` and `820-01598` share most of
their silicon; two dumps of *the same* board arrive from different sources with
different net naming (one delivery carries real names like `PPBUS_G3H`, the next
carries `N$21004`); an XZZ `.pcb` and a `.brd` of one model disagree about a
handful of pins. A repair tech's recurring question is:

> Is pin 12 of U1700 on *this* board wired the same way it is on *that* board?

Today that means opening two tabs, selecting the part twice, and reading two pin
tables by eye. Nothing in BoardRipper compares them.

Two properties of the data make the naive answer wrong:

1. **Pin numbers are not package pins.** `brd-parser.ts:284`,
   `bdv-parser.ts:235` and `xzz-parser.ts:1592/2264` all assign
   `number: String(i + 1)` — a running index in *file order*. Two deliveries of
   one board can enumerate the same package in a different order, and then
   "pin 12 vs pin 12" silently compares two unrelated pads. Only the iPhone-era
   XZZ JSON tail carries real designators (`xzz-parser.ts:2490`,
   `p.name || String(i+1)` — BGA pads like `M7`).
2. **Net names are not stable identities.** A name-only diff on a mixed-naming
   pair paints nearly every row red and tells the user nothing.

So the feature is not a `zip()` over two pin arrays. The two hard parts are
**alignment** (which pin corresponds to which) and **classification** (what kind
of difference this is).

---

## 2. Where it lives

**Sidebar ▸ Tools ▸ Part comparison** — a new entry in `panels/ToolsPanel.tsx`,
rendered as `panels/tools/PartCompareTool.tsx`, alongside the calculators and
Worklists.

It is a **full tool, not just a right-click result**: the user picks board A and
board B from the open tabs and looks up a component on each side independently.
The two sides do **not** have to carry the same refdes — a chip can sit at
`U1700` on one board and `U6800` on another, and comparing those is exactly the
interesting case once you leave one board family.

The board right-click menu is a *shortcut into* that tool, prefilling both sides
with the same refdes. It is not a second implementation.

### Width

The sidebar defaults to 320 px and resizes up to half the screen
(`Sidebar.utils.ts`: `DEFAULT_WIDTH = 320`, `MAX_WIDTH_RATIO = 0.5`). The tool
measures its own body with a `ResizeObserver` — the idiom the Settings tab strip
already uses — and sets `data-wide` at ≥ 520 px:

* **narrow** (default): one row per pin, left net on line 1, right net on line 2,
  Δ badge on the right edge.
* **wide**: true side-by-side columns, `# | net L | Δ | net R`, plus the diode
  pair when the boards have readings.

```
┌ Part comparison ────────────────┐   ┌ Part comparison (wide) ─────────────────────────┐
│ A [820-00840.brd      ▾]        │   │ A [820-00840.brd ▾]  ⇄  B [820-01598.brd ▾]     │
│   [U1700            ⌕]  42 pins │   │   [U1700   ⌕] 42 pins   [U1700   ⌕] 40 pins     │
│              ⇄                  │   ├─────────────────────────────────────────────────┤
│ B [820-01598.brd      ▾]        │   │ 40/42 matched · geometry · 3 differ · 2 renamed │
│   [U1700            ⌕]  40 pins │   │ ☑ only differences      [Auto ▾]      [Copy]    │
├─────────────────────────────────┤   ├────┬───────────┬────┬───────────┬───────────────┤
│ 40/42 matched · geometry        │   │ #  │ net A     │ Δ  │ net B     │ diode A / B   │
│ 3 differ · 2 renamed · 2 only A │   │ 1  │ PPBUS_G3H │ =  │ PPBUS_G3H │ 0.43 / 0.44   │
│ ☑ only differences   [Auto ▾]   │   │ 2  │ PP3V3_S5  │ ~  │ N$21004   │ 0.51 / 0.50   │
├─────────────────────────────────┤   │ 3  │ SMC_RST_L │ ≠  │ GND       │ 0.62 / 0.00   │
│ 2   PP3V3_S5                 ~  │   │ 4  │ PP1V8_S0  │ ◁  │ —         │ 0.49 / —      │
│     N$21004        same nbrs    │   └────┴───────────┴────┴───────────┴───────────────┘
│ 3   SMC_RST_L                ≠  │
│     GND                         │
│ 4   PP1V8_S0                 ◁  │
│     — (no match)                │
└─────────────────────────────────┘
```

### Why not a Dockview panel

A dockable panel would be wider, but the comparison is a *lookup* the user does
while working on a board, in the same place they already reach for the worklist
and the calculators — and the sidebar is resizable, so the wide layout is one
drag away. If the 400-pin BGA case proves cramped in practice, the same
component can be mounted in a Dockview panel later without touching the store or
the compare kernel; that is why all logic sits outside the component.

---

## 3. Alignment

`store/part-compare.ts` — a pure module, no React, no stores, unit-tested.

```ts
type AlignMode = 'auto' | 'name' | 'number' | 'order' | 'geometry';

interface Alignment {
  mode: Exclude<AlignMode, 'auto'>;
  pairs: Array<{ a: number | null; b: number | null }>;  // pin indices
  matched: number;
  score: number;   // matched / max(|A|, |B|)
}
```

Four strategies, each producing an `Alignment`. The chosen mode and its score
are always shown in the summary strip, and the user can pin a mode with the
selector — an automatic choice the user cannot see or override is exactly how
this kind of feature earns mistrust.

> **Revised during implementation.** The draft ranked strategies by their own
> `score` (matched / max pins). That is not a quality measure: `number`
> alignment matches 100 % of pins whenever the two parts have the same pin
> count, which says the files have the same pad count, not that the pairing is
> right — so it beat geometry on every shuffled delivery. Ranking now scores
> **every** candidate pairing, however it was produced, by the same two
> independent kinds of evidence:
>
> * **net agreement** — do paired pins carry the same net name?
> * **geometric agreement** — do paired pins sit in the same place under one
>   rigid transform?
>
> Coverage is a gate (within a 5 % band counts as tied, so one unmatched pad
> does not cost geometry a comparison it otherwise explains completely), then
> net agreement, then geometric agreement, then the preference order
> **name > number > geometry > order**. Net agreement leads because it is the
> stronger claim; geometric agreement decides the case the feature exists for —
> a delivery where every net has been renamed and only the copper is
> comparable.

1. **`name`** — key `pin.name.trim().toUpperCase()`. Eligible only when both
   parts have non-empty names on ≥ 50 % of pins **and** the names are unique
   within each part. This is the BGA-designator case (`M7`).
2. **`number`** — key `pin.number.trim().toUpperCase()`. On the Apple formats
   this is the running file index, so it is correct exactly when both files
   enumerate the package the same way — common for two deliveries of one board,
   not guaranteed.
3. **`order`** — index *i* ↔ index *i*. The floor; always available, always
   scores `min/max`.
4. **`geometry`** — the one that makes cross-delivery comparison actually work.

### Geometric alignment

Pins are positioned in mils in both files, so the same package has the same
pitch on both sides. Normalise each part into its own local frame and match by
proximity:

* **Anchor**: the **centroid of the part's pins**, not `part.origin`. `origin`
  means different things in different parsers; the pin centroid is defined
  identically everywhere and is directly comparable.
* **Orientation**: `part.angleDeg` is optional and absent on most Apple formats,
  and the two boards may place the chip on opposite sides. So do not trust a
  single transform — evaluate **8 candidates** (4 cardinal rotations × mirrored
  or not), plus a 9th built from `Δ angleDeg` when both sides carry it, and keep
  the transform with the most matches. Non-cardinal placement differences are
  out of scope for phase 1; the score tells the user the alignment is poor.
* **No rescaling.** A pitch mismatch means these are not the same package —
  surfacing that is the point. When the pin-bbox diagonals differ by > 20 % the
  summary says *"different package size — alignment may be meaningless"*.
* **Tolerance**: `0.4 × median nearest-neighbour pitch of A`, clamped to
  `[2, 20]` mils.
* **Matching**: mutual nearest neighbour over a uniform grid — a pin pairs only
  if each is the other's nearest within tolerance. Greedy one-directional
  matching collapses two pins onto one on dense BGAs; mutual-best does not.
* **Symmetry is the hard part, and it was missed in the draft.** Most packages
  are geometrically symmetric — a two-row SOIC pad field maps onto itself under
  180° and under a mirror, a square BGA under all four rotations. Match count
  alone therefore cannot orient the package, and taking the first transform
  that ties would pair pin 1 with pin 40 without saying so. Transforms are
  ranked by (pins matched, then net agreement); when the top two still tie, the
  alignment is flagged `ambiguous` and the UI says the pairing is a guess.
* **Cost**: 9 transforms × grid lookup over ≤ ~1200 pins. Milliseconds, computed
  once per comparison, memoised on `(tabId, partName, tabId, partName, mode)`.

---

## 4. Δ classification

For each aligned pair, the status is one of:

| status | meaning | shown as |
|---|---|---|
| `same` | net names equal after normalisation | `=` neutral |
| `renamed` | names differ, **neighbour sets identical** | `~` amber |
| `similar` | names differ, Jaccard ≥ 0.6 | `~` amber + score |
| `partial` | names differ, but the name rules below relate them | `≈` amber |
| `bulk` | both sides are ground/power-class nets **of comparable size** | `≡` neutral |
| `differs` | names and topology both differ | `≠` red |
| `only-a` / `only-b` | pin exists on one side only | `◁` / `▷` red |
| `nc` | both sides unconnected, with nothing contradicting that they are the same thing | `·` grey, not a difference |

Name normalisation: trim, uppercase; `''`, `NC` and `UNCONNECTED` all mean *no
net* (the XZZ parser already folds the latter two to `''` —
`xzz-parser.ts:2468`).

### Topology fingerprint

This is what separates "someone renamed the nets" from "this pin is wired
somewhere else", and on Apple boards it is the difference between a useful diff
and a wall of red.

```
fingerprint(board, netName) =
  sorted unique uppercase refdes of parts touching the net,
  minus the subject part itself
```

Built from `board.nets.get(name).pinIndices → board.parts[partIndex].name`
(`parsers/types.ts:164`). Memoised per `(board, netName)`.

**The size rule only ever confirms a match, never denies one.** Two rails
within ±20 % of each other are `bulk`; when the sizes disagree the branch falls
through to the name rules like every other place topology abstains. It used to
return `differs` outright, which meant no rail could ever be a partial match —
`PP3V8_AON_VDDMAIN` against `PP3V8_AON_MPMU_ISNS_VIN` stayed red across ~50
rows of a real comparison even after the prefix rule existed, because the name
rules were never reached. Across two *different* boards a rail's fanout differs
by design, so its size is not evidence either way.

**Bulk nets are excluded before the set is ever built.** `pinIndices.length` is
the cheap pre-check: if a net has more than `BULK_LIMIT` (40) member parts, or
`isGroundNet(settings, name)` says so (`render-settings.ts:519`), it is a rail.
Two rails compare as `bulk` when their member counts are within ±20 % of each
other, `differs` otherwise. Fingerprinting a 3000-pin GND would be both
expensive and uninformative.

### Partial name match

A second, independent kind of evidence that two nets are one net: what they are
*called*. Consulted only after topology has had its say, so a `renamed` never
gets downgraded.

The rule is **containment**, not a similarity score, and that distinction is the
whole of it. A score cannot separate

* `PPBUS_G3H` / `PPBUS_G3H_R` — one name decorated, one net; from
* `SMC_RST_L` / `SMC_RST_R`, `STUB_A` / `STUB_B` — one character *substituted*,
  two sibling nets that must never be folded together.

Both score about the same. Only the first has the shorter name inside the longer
one. So `partial` requires the shared run to be one of the names in full, at
least 3 characters, and at least half the longer name (which is what stops `GND`
pairing with `PP_GND_SENSE`). A second door covers separator-only variation
(`PPBUS_G3H` vs `PPBUS-G3H`), which containment misses because the difference
sits mid-string: equal after stripping non-alphanumerics.

`partial` is amber and does **not** count as a difference.

`longestCommonRun` returns the shared run as offsets into each side's own
string, so the UI can mark it without re-deriving anything — which is why it
compares case-insensitively per character rather than uppercasing both first
(`'ß'.toUpperCase()` is two characters and would slide every later offset).
The run is **contiguous**, not a subsequence: a subsequence LCS would call
`PP3V3_S5` and `PP1V8_S0` a 6-character match by picking letters out of the
middle.

The UI marks the run the two names **share**, not the part that differs — on
`PPBUS_G3H` / `PPBUS_G3H_R` that leaves the eye on the unmarked tail, which is
the character or two that actually changed. `nameMatch` is attached to every row
whose names differ and overlap at all, `differs` rows included.

### State markers and rails (refined 2026-09-13)

Measured against a real pair — the PMU of 820-02016 (M1 Air) against 820-02020
(M1 Pro). That comparison exposes the case the topology fingerprint cannot
help with at all: **two different boards**, where refdes differ by design, so
almost no neighbour set matches and the names are the only evidence there is.

Three rules, in order, after topology has abstained:

1. **State markers are not identity.** A leading `NC` / `RSVD` / `TPT` / `TP` /
   `DNU` / `NU` / `RESERVED` is stripped before two names are compared, so
   `NC_GPU_TRIGGER1_L` and `RSVD_GPU_TRIGGER1_L` are one signal, as are
   `NC_MPMU_NAND0_RESET_L` and `TPT_MPMU_NAND0_RESET_L`. Only a *leading*
   token counts — `PP3V8_NC_SENSE` is not a marked net.
2. **Two no-connects, handled by how much they actually agree.** `NC`, `RSVD`,
   `DNU`, `NU`, `RESERVED` mean the pin is unused. `TP`/`TPT` are deliberately
   **not** in that set: a test point is connected; it labels identity, not
   state. How far "both unused" goes depends on whether the names agree about
   *what* the pin is:
   * same signal under two markers (`NC_GPU_TRIGGER1_L` /
     `RSVD_GPU_TRIGGER1_L`), or a blank net against a named no-connect — `nc`,
     nothing disagrees.
   * **different signals** (`NC_FAN_PWR_EN` / `NC_MPMU_GPIO26`) — `partial`,
     not `nc`. That both are unused is safe to say; that the two boards mean
     the same by the pin is not, and it may have been repurposed between
     models. A first cut called these `nc` and was rejected on review: it reads
     as "no difference", which is a claim the names do not support. `partial`
     is exactly the "related, decide for yourself" bucket — amber, not counted
     as a difference, and kept by the "only differences" filter, which hides
     only `same` and `nc`.
3. **A rail extends its prefix.** Two names sharing ≥2 leading tokens covering
   ≥40 % of the shorter, **with tails of different length**, read as the same
   rail: `PP3V8_AON_VDDMAIN` against `PP3V8_AON_MPMU_ISNS_VIN`, which was ~50
   rows of one real comparison. The differing-tail condition is what keeps this
   from undoing the containment work: `SMC_RST_L` / `SMC_RST_R` and
   `PP1V8_S0_A` / `PP1V8_S0_B` share two leading tokens too, but *substitute*
   at one position, which is how sibling nets look. It is reported as "same
   `PP3V8_AON` prefix", never as "the same net" — on two boards those may be
   opposite ends of a sense resistor.

What deliberately stays red: `VSS_ANA_MPMU` against `PP1V5_VLDOINT_MPMU`
(ground against a rail), `IPD_PWR_EN` against `MPMU_GPIO6` (a function against
a bare GPIO — a real design difference), and `P3V8AON_IMEAS` against
`P3V8AON_HS_ISENSE`, where one shared token is not enough to claim anything.

The rule that fired is carried on the row as `nameReason` and shown in both the
row title and the board tooltip — an amber pin that does not say *why* is only
marginally better than a red one that does not say what it differs to.

### Summary line

The header states the shape of the result, not just a count:

> `40/42 matched · geometry · 3 differ · 18 renamed (topology identical) · 2 only in A`

A high `renamed` count is itself the finding — it says the two files are the
same design under two naming conventions, which is the moment the user stops
worrying about the amber rows.

### Diode column

When either board carries `board.diodeReference` or has an OBD match, the row
shows both readings via the existing `formatDiode`
(`store/diode-readings.ts:21`). A pair where both sides have a `value` reading
and differ by more than **50 mV or 10 %**, whichever is larger, is flagged amber
independently of the net status (the draft said 15 %, at which the relative term
swallows the absolute floor for every ordinary junction reading — 0.43 V vs
0.50 V went unflagged) — a matching net with a diverging diode reading
is precisely what a tech is hunting for.

---

## 5. Interaction

* **Row click** — selects that pin on **both** boards. The side that is the
  active tab updates visibly; the other tab's selection is set so switching to
  it lands on the right pin. Needs one small public addition to `board-store`:
  `selectPinInTab(tabId, partName, pinIndex)`, mirroring what `focusPart`
  (`board-store.ts:2205`) does for the active tab — side flip, selection, focus
  request. `updateActiveTab` is private and stays that way.
* **`→A` / `→B` buttons** per row — `switchTab` + focus, to jump.
* **`☑ only differences`** — hides `same` and `nc` rows.
* **`⇄`** — swap the two sides.
* **Auto-fill** — with exactly two boards open and neither side chosen, both
  board pickers fill themselves in; there is only one comparison on offer.
  Guarded on *both* sides being empty, so clearing one side to re-pick it is not
  overruled on the next render. Components stay blank — which chip to compare is
  the real question, and guessing would be noise.
* **`[Copy]`** — TSV of the visible rows to the clipboard, following
  `store/worklist-clipboard.ts`.

### Highlight on board (v0.41.0)

A toggle in the controls row, **off by default** — it is a second persistent
highlight competing with the selection, so it appears only when asked for.
While on, the compared part carries a standing outline and every pin that is
not a plain match is marked: red for `differs` / `only-a` / `only-b`, amber for
`renamed` / `similar` / `partial`. `same`, `bulk` and `nc` are deliberately
**unmarked** — on a 400-pin BGA where 390 agree, painting those buries the ten
that matter, and the outline already says which part is under comparison.

Drawn by `BoardRenderer.drawCompareHighlight` into the **existing**
`multiHighlightGfx` — the layer the cyan multi-select and worklist marks use.
Same kind of persistent, store-driven overlay, already in
`invalidateAllScenes`'s detach list; a new Graphics is precisely the bug shape
that took out the halo sprite and `butterflyDimGfx`. Pin marks reuse the
net-highlight's shape resolution (`drawPadShape` / `drawPinShape`, the
`showPads` gate, the per-part `pinRadiusClamp`) so a mark traces the pin as
drawn, and are grouped one `stroke()` per colour because a Graphics flushes its
path on every stroke.

`comparePart` moved behind `partCompareStore.result`, memoised on both sides,
the mode **and board identity** (a reload or `deriveBoardView` yields a fresh
`BoardData`). The renderer needs the same answer the panel shows, and computing
it in two places would let them drift. `highlightFor(tabId)` resolves which
side a tab is, so the renderer never has to know.

Like the cyan multi-select, it has **no butterfly top/bottom split**.

### The hover line (v0.41.0)

A red pin that does not say what it differs *to* only raises a question. While
the highlight is on, hovering any pin of the compared part adds a line naming
the other board and its net — `↔ 820-01598: PPBUS_G3H — renamed, same
connections` — coloured by the same three-way split as the marks. It reads the
identical `highlightFor` projection the overlay draws from, so the colour under
the cursor and the words in the tooltip cannot disagree. Gated on the same
toggle, so the tooltip is untouched for anyone not comparing.

It shows on **every** pin of the compared part, matching ones included (`same
net`): silence on a matching pin would be ambiguous with "not part of the
comparison".

The trailing note is added only where the two names and the colour do not
already say why — "unused on one board", "same `PP3V8_AON` prefix", "renamed,
same connections". Not for `differs` (the mark is red and the net is named),
nor for containment or punctuation-only matches, which the two strings show
side by side.

### Right-click entry

A new `Compare pins` group in `ContextMenu.renderBoardBody`, below the existing
`Other Boards` group (`components/ContextMenu.tsx:592`), reusing the same
`otherBoardTabs` list that group already computes:

* One row per other open board carrying the same refdes:
  `820-01598 — U1700 · 42 ↔ 40 pins`. Click prefills both sides and opens the
  tool.
* Boards without that refdes render disabled: `820-01598 — no U1700`.
* Always one final row `Compare part…`, which opens the tool with the left side
  prefilled and the right side empty, so the user can look up a differently
  named component — the case the picker exists for.

### Tools navigation must be lifted

`ToolsPanel` currently holds `activeTool` in local `useState`. A deep link from
the context menu cannot reach that. Extract it to
`panels/tools/tools-nav.ts` — module state + emitter + `useActiveTool()`,
following `Sidebar.utils.ts`'s pattern of state-outside-the-component. Then
`openPartCompare(left, right)` is: set the compare store, `setActiveTool('partcompare')`,
`showSidebarTab('tools')`.

---

## 6. Files

| file | what |
|---|---|
| `src/frontend/src/store/part-compare.ts` | **new** — pure kernel: alignment, fingerprints, classification |
| `src/frontend/src/store/part-compare.test.ts` | **new** — vitest |
| `src/frontend/src/store/part-compare-store.ts` | **new** — `{left, right, mode, onlyDiffs}` + `openPartCompare()`; session-scoped, not persisted |
| `src/frontend/src/panels/tools/PartCompareTool.tsx` | **new** — pickers, summary, table |
| `src/frontend/src/panels/tools/tools-nav.ts` | **new** — lifted `activeTool` |
| `src/frontend/src/panels/ToolsPanel.tsx` | entry + `ToolId` + `TOOL_TITLES`; read nav from module |
| `src/frontend/src/components/ContextMenu.tsx` | `Compare pins` group |
| `src/frontend/src/store/board-store.ts` | `selectPinInTab()` — additive; `_resolveAdjacentNets` split into a tab-scoped `_adjacentNetsFor` |
| `src/frontend/src/panels/tools/part-compare-open.ts` | **new** — the one deep link (store + tool nav + sidebar tab) |
| `src/frontend/src/index.css` | `.part-compare-*` |
| `src/frontend/src/renderer/BoardRenderer.ts` | `drawCompareHighlight`, the `.pnt-compare` tooltip line, `formatCompareForPin` |
| `src/frontend/src/store/part-compare-store.test.ts` | **new** — vitest for the projection and the off-by-default contract |
| `src/frontend/tests/part-compare.spec.ts` | **new** — Playwright |
| `src/frontend/tests/compare-highlight.spec.ts` | **new** — Playwright for the toggle, the marks and the hover line |

Nothing existing changes behaviour: the board store gains one method, the tools
panel's local state moves out unchanged, the context menu gains one group.

One latent bug fell out of it. `_resolveAdjacentNets` resolved the chain
against **the active tab's** board; `selectPinInTab` can target a background
tab, where that would have walked the wrong netlist. It is now split into a
tab-scoped `_adjacentNetsFor`, with the active-tab form delegating to it.

---

## 7. Tests

**Unit (`part-compare.test.ts`)** — the kernel is where the risk is:

* `name` alignment on BGA designators; rejected when names are sparse or
  duplicated.
* `number`/`order` alignment on equal and unequal pin counts.
* Geometry: same part rotated 90°, rotated 180°, mirrored to the bottom side,
  and with pin arrays shuffled — all must recover the same pairing.
* Geometry on a genuinely different package → low score, size warning.
* `renamed` vs `differs`: identical neighbour sets under different names →
  `renamed`; one neighbour swapped → `differs`.
* Bulk rule: a 3000-member GND never builds a fingerprint; two rails of similar
  size → `bulk`.
* `nc` handling for `''`, `NC`, `UNCONNECTED`.
* Diode delta threshold at the 50 mV / 10 % boundary.
* The **M1 PMU corpus**: every pair from a real 820-02016 vs 820-02020
  comparison, as a table of expected relations — the list that drove the state
  markers, no-connect and rail-prefix rules, kept as their specification.
* Sibling nets that must never fold: `SMC_RST_L` / `SMC_RST_R`,
  `PP1V8_S0_A` / `PP1V8_S0_B`, `MPMU_GPIO6` / `MPMU_GPIO10`.

**E2E (`part-compare.spec.ts`)**:

1. **Identity baseline** — copy a fixture to a second filename, open both
   (`boardStore` dedups by filename, so the copy is required), compare the same
   part: every row `same`, zero differences. Anything else is a bug in the
   kernel, and this catches it without a hand-authored expectation table.
2. **Renamed net** — `samples/kicad/tomu-fpga.kicad_pcb` (plain text, unlike the
   obfuscated Apple formats) with one net renamed globally → **zero**
   differences and one `renamed` row. This is the fingerprint path end to end
   on real data.
3. **Seeded difference** — the same fixture with two pads' nets swapped inside
   the subject footprint → exactly two `differs` rows, and `only differences`
   shows exactly those two.
4. **Right-click path** — the menu group appears, click opens Tools ▸ Part
   comparison with both sides filled.

**E2E (`compare-highlight.spec.ts`)** — off by default, then both kinds of mark
on a fixture with exactly one rewired pad and one renamed net; the hover line
naming the other board's net; the line absent while the toggle is off. Mark
counts come through a DEV-only renderer probe, which is as close as a test gets
to "the right pins are red" without pixel comparison — the colours themselves
are checked by eye. Both this spec and `shift-drag-worklist.spec.ts` skip
against a production bundle, where the DEV globals they drive do not exist.

Fixtures are generated in the test from one checked-in sample by a named edit,
so the expected answer is a property of the edit rather than a number someone
once observed. Subject: `SW2`, a 4-pad captouch footprint on `/TOUCH_1../TOUCH_4`.

---

## 8. Phasing

* **Phase 1** (v0.40.0) — kernel + tool + pickers + right-click entry + tests.
* **Phase 1.5** (v0.41.0) — the opt-in board highlight, the hover line, and the
  name rules refined against a real cross-model pair. Two bugs surfaced only
  once real data was run through it: the prefix rule was unreachable for rails,
  because the bulk branch returned `differs` before the names were consulted;
  and two differently-named no-connects were being called "no difference",
  which the names do not support.
* **Phase 2** (not now, listed so the earlier phases don't paint themselves
  into a corner):
  compare against a board that is *not* open (load from the Library on demand);
  a whole-board part diff ("which components does A have that B doesn't");
  an MCP tool `compare_part` over the same kernel — trivial once the kernel is
  pure and store-free, which is why it is.

---

## 9. Known risks

* **A symmetric package with fully renamed nets is genuinely ambiguous** — there
  is no evidence left to orient it. Reported as such rather than guessed
  silently, but the user has to pin a mode.
* **Geometric alignment on non-cardinal placement** is not handled. The score
  readout makes that visible rather than silent, and the user can fall back to
  `number`/`order`.
* **`renamed` is a heuristic.** Two different nets with coincidentally identical
  neighbour sets would read as a rename. On a real board that means the two nets
  touch exactly the same components, which is itself worth seeing; the row still
  prints both names.
* **Cross-family comparison** (different board models) is the case topology
  cannot help with: refdes differ by design, so neighbour sets almost never
  match and the name rules carry nearly the whole load. That is why those rules
  were tuned against a real cross-model pair rather than invented.
* **The rail-prefix rule is a claim about prefixes, not about nets.**
  `PP3V8_AON_VDDMAIN` and `PP3V8_AON_MPMU_ISNS_VIN` may be opposite ends of a
  sense resistor. It is reported as "same `PP3V8_AON` prefix" and coloured
  amber for exactly that reason; it must never be worded as "the same net".
* **The marker list is fixed, not configurable.** `NC` / `RSVD` / `TPT` / `TP` /
  `DNU` / `NU` / `RESERVED` cover the Apple corpus; another vendor's convention
  would need the list extended, and a board that uses `NC_` to mean something
  else would be read wrongly.
* **Repeated identical pairs are repeated rows.** One rail against one rail
  filled ~50 rows of a real comparison with the same two names. Collapsing
  identical pairs into a single row with a pin count would cut that list to
  about twenty — not done, and the obvious next improvement to the table.
* **No butterfly top/bottom split** in the board highlight, matching the cyan
  multi-select it is drawn alongside.
