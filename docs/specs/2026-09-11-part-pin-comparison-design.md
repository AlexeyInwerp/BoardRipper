# Part pin comparison — design

**Date:** 2026-09-11
**Status:** proposed
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

Four strategies, each producing an `Alignment`; `auto` runs all of them and
keeps the highest `score`, breaking ties in the order **name > number >
geometry > order** (prefer a semantic key over a positional one). The chosen
mode and its score are always shown in the summary strip, and the user can pin
a mode with the selector — an automatic choice the user cannot see or override
is exactly how this kind of feature earns mistrust.

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
| `bulk` | both sides are ground/power-class nets | `≈` neutral |
| `differs` | names and topology both differ | `≠` red |
| `only-a` / `only-b` | pin exists on one side only | `◁` / `▷` red |
| `nc` | both sides unconnected | `·` grey, not a difference |

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

**Bulk nets are excluded before the set is ever built.** `pinIndices.length` is
the cheap pre-check: if a net has more than `BULK_LIMIT` (40) member parts, or
`isGroundNet(settings, name)` says so (`render-settings.ts:519`), it is a rail.
Two rails compare as `bulk` when their member counts are within ±20 % of each
other, `differs` otherwise. Fingerprinting a 3000-pin GND would be both
expensive and uninformative.

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
and differ by more than **50 mV or 15 %**, whichever is larger, is flagged amber
independently of the net status — a matching net with a diverging diode reading
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
* **`[Copy]`** — TSV of the visible rows to the clipboard, following
  `store/worklist-clipboard.ts`.

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
| `src/frontend/src/store/board-store.ts` | `selectPinInTab()` — additive |
| `src/frontend/src/index.css` | `.part-compare-*` |
| `src/frontend/tests/part-compare.spec.ts` | **new** — Playwright |

Nothing existing changes behaviour: the board store gains one method, the tools
panel's local state moves out unchanged, the context menu gains one group.

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
* Diode delta threshold at the 50 mV / 15 % boundary.

**E2E (`part-compare.spec.ts`)**:

1. **Identity baseline** — copy a fixture to a second filename, open both
   (`boardStore` dedups by filename, so the copy is required), compare the same
   part: every row `same`, zero differences. Anything else is a bug in the
   kernel, and this catches it without a hand-authored expectation table.
2. **Seeded difference** — a plain-text fixture (`samples/kicad/starfish.kicad_pcb`
   is editable, unlike the obfuscated Apple formats) with exactly one net name
   changed → exactly one `differs` row, and `only differences` shows exactly
   that row.
3. **Right-click path** — the menu group appears, click opens Tools ▸ Part
   comparison with both sides filled.

---

## 8. Phasing

* **Phase 1** — kernel + tool + pickers + right-click entry + tests. Everything
  above.
* **Phase 2** (not now, listed so phase 1 doesn't paint itself into a corner):
  compare against a board that is *not* open (load from the Library on demand);
  a whole-board part diff ("which components does A have that B doesn't");
  an MCP tool `compare_part` over the same kernel — trivial once the kernel is
  pure and store-free, which is why it is.

---

## 9. Known risks

* **Geometric alignment on non-cardinal placement** is not handled. The score
  readout makes that visible rather than silent, and the user can fall back to
  `number`/`order`.
* **`renamed` is a heuristic.** Two different nets with coincidentally identical
  neighbour sets would read as a rename. On a real board that means the two nets
  touch exactly the same components, which is itself worth seeing; the row still
  prints both names.
* **Cross-family comparison** (different board models) will legitimately produce
  many `differs` rows. That is the answer, not a failure — but the summary must
  not imply otherwise, hence the explicit alignment score and package-size
  warning.
