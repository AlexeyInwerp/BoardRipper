# Net Chain Adjacent Highlight — Design

**Date:** 2026-05-05
**Status:** Design complete, awaiting user review
**Scope:** Frontend only (renderer + store + render-settings). No backend, no parser changes.

## Summary

Add a new net-line visualisation mode, `chain-adjacent`, that extends the
existing `chain` mode by also highlighting *adjacent* nets reachable from the
selected net through 2-pin components (resistors, capacitors, inductors,
ferrite beads). The selected net keeps its existing yellow treatment;
adjacent nets render in a configurable bluish colour with the same line and
pin styling otherwise.

The feature targets the common board-repair workflow of "follow the signal
through pull-ups, series resistors, decoupling caps". Depth is hardcoded to
1 hop for v1; the algorithm is parameterised so a depth knob can be exposed
later without touching the data flow.

## Motivation

When tracing a signal on the board today, a user clicks a pin to highlight
its net, then must repeatedly click each pin of every series component to
follow the chain through to the next net. For trivial passive components
(2-pin resistor / capacitor / inductor) the next net is obvious from
context, but the click-by-click navigation is tedious. `chain-adjacent`
collapses the common case into a single click.

## Mode shape

The existing `NetLineMode` cycle becomes 4 steps:

```
off → star → chain → chain-adjacent → off
```

Type extension in `src/frontend/src/store/board-store.ts`:

```ts
export type NetLineMode = 'off' | 'star' | 'chain' | 'chain-adjacent';
```

Updates required:

- `cycleNetLineMode()` extended for the 4-state cycle.
- `loadViewPrefs()` legacy migration accepts `'chain-adjacent'` as a valid
  value; unknown strings still fall back to `'off'` (existing pattern at
  `board-store.ts:362`).
- The toolbar button reuses the existing icon-cycle pattern; tooltip text
  grows by one entry. No new toggles.

## Net classification

Two predicates exported from `src/frontend/src/parsers/types.ts`:

```ts
export function isGroundRail(net: string): boolean;
export function isPowerRail(net: string): boolean;  // existing — promoted from private
```

`isGroundRail` matches: `GND`, `AGND`, `DGND`, `PGND`, `EARTH`, `CHASSIS`,
and anything starting with `GND_`.

`isPowerRail` keeps its current definition (`isGroundRail` cases plus
`VCC`, `VDD`, `VSS`, `VEE`, `VCC_*`, `VDD_*`, `VSS_*`, `+/-N…` voltage
patterns). `isGroundRail(net)` implies `isPowerRail(net)`.

Adjacency rule per hop, where `S` is the current net, `P` is a 2-pin part
on `S`, and `N` is the net of `P`'s other pin:

| `N` is…                                | Add to adjacent set | Recurse from `N` |
|----------------------------------------|---------------------|------------------|
| ground (`isGroundRail`)                | no                  | n/a              |
| power rail (`isPowerRail` && !ground)  | **yes**             | no (terminator)  |
| signal                                 | yes                 | yes (≤ depth)    |

`VSS` stays under power for now (matches existing `isPowerRail` grouping);
revisit if a real-world board misclassifies.

If the *initially selected* net is itself ground or power,
`computeAdjacentNets` returns an empty set and `chain-adjacent` degrades
silently to plain `chain`. This avoids the whole-board explosion when a
user clicks a GND or VCC pin.

## Visual treatment

Adjacent nets receive the **full** treatment, identical to the selected
net except for line / pin colour:

- Chain lines are drawn across all pins of each adjacent net using
  `adjacentNetLineColor`.
- Components that have any pin on an adjacent net are excluded from the
  ambient dim filter (`showNetDim`).
- The bottom-side ghost-outline pass runs once for each member of
  `{highlightedNet} ∪ adjacentNets`.

Justification: the user explicitly confirmed they want full visibility for
adjacent rails because intermediate "power-like" rails (e.g. `VBAT_GATE`,
`SW_NODE`, MOSFET drain rails) often feed only a few components and the
"too noisy" failure mode is rare in practice.

### New render-settings knob

Single addition to `src/frontend/src/store/render-settings.ts`:

```ts
adjacentNetLineColor: number;   // default 0x4488ff (bluish)
```

`netLineWidth`, `netLineAlpha`, `netLineDashed`, `netLineDashLength`, and
`netLinePulse` are reused — the adjacent and selected lines share the same
geometric/animation styling and only differ in colour. This keeps the draw
pass uniform and exposes a customiser hook for free (the existing settings
panel already iterates these knobs).

The pin / pad highlight colour for parts on adjacent nets reuses
`adjacentNetLineColor` directly; no separate "adjacent pin colour" knob in
v1.

## Algorithm — Approach A

`SelectionState` extended in `board-store.ts`:

```ts
export interface SelectionState {
  partIndex: number | null;
  pinIndex: number | null;
  highlightedNet: string | null;
  adjacentNets: Set<string>;   // empty unless mode is chain-adjacent
}
```

Pure helper colocated with the predicates in `parsers/types.ts`:

```ts
export function computeAdjacentNets(
  board: BoardData,
  anchorNet: string,
  depth: number,
): Set<string>;
```

Algorithm: BFS up to `depth` levels over the connectivity graph induced by
parts with exactly 2 pins. At each frontier node, enumerate parts on that
net via `board.nets.get(name)?.pinIndices`, and for each part check
`part.pins.length === 2` before crossing to the other pin's net. Apply the
section-3 table: skip ground, add-but-don't-recurse for power, recurse for
signal. The anchor itself is never added to the result set; the renderer
already handles it via `highlightedNet`.

Hardcoded `depth=1` at all call sites for v1; the signature carries the
parameter so the eventual depth-N UI is a single-line change.

### Recompute triggers

The set is (re)computed in these places only:

1. `highlightNet(name)` — when `name` changes *and* current mode is
   `chain-adjacent`.
2. `cycleNetLineMode()` — when the cycle lands on `chain-adjacent`,
   recompute against the current `highlightedNet`. When the cycle leaves
   `chain-adjacent` (any other transition), clear the set to empty.
3. Board reload / revision switch — `BoardTab.selection` is already reset
   in those paths, so the empty set falls out naturally.

Tab switch does **not** trigger a recompute: each `BoardTab` owns its own
`selection` (including `adjacentNets`), so the set persists per-tab across
switches as long as the session is alive. Across page reload the set is
empty until the user re-selects (only `netLineMode` is persisted, not
selection).

The renderer reads `selection.adjacentNets` once per net-line draw and
once per dim-filter pass — same access pattern as `highlightedNet` today.

### Hover does not trigger

Hover today uses a separate `BoardRenderer.hoverNet` field
(`BoardRenderer.ts:223`, `setHoverNet` at `BoardRenderer.ts:3800`) that
only feeds the ambient dim. It never touches `boardStore.highlightNet()`.
Approach A inherits the right behaviour automatically: BFS only runs in
`highlightNet()`, so hover never produces a chain-adjacent expansion. No
additional plumbing needed.

## Edge cases

- **Anchor is rail:** empty set, mode degrades to `chain`. No toast.
- **Click on adjacent (blueish) pin:** re-anchors via `highlightNet()` to
  that net; adjacency recomputes from the new anchor. No special case.
- **3+ pin parts:** never bridge. Heuristics (R-arrays, MOSFET S/D pairs)
  are out of scope for v1.
- **Cache:** `BoardData` shape unchanged → no `PARSER_VERSION` bump.
- **PDF lookup chain:** PDF lookups call `highlightNet()` like any other
  caller, so they pick up adjacency automatically when mode is on. No
  special path.
- **Search highlight:** unaffected; search highlights are a separate
  state lane.

## Persistence

`netLineMode` already persists via `saveViewPrefs` /
`view-prefs:loadViewPrefs`. The new `'chain-adjacent'` value rides the
existing path. The `adjacentNets` set is derived state and is **not**
persisted.

`adjacentNetLineColor` persists via the existing render-settings serialiser
(`writeRenderSettings` iterates known keys; the new field is added there).

## Test plan

**Unit tests** for `computeAdjacentNets` against a fixture board:

- Pull-up: `VSENSE → R12 → VCC` ⇒ adjacent = `{VCC}` (terminator).
- GND stitch: `RAIL → R5 → GND` ⇒ adjacent = `{}`.
- MOSFET 3-pin: `GATE → Q1 → ?` ⇒ adjacent = `{}` (3 pins, not a bridge).
- Series resistor: `NET_A → R1 → NET_B` (both signal) ⇒ adjacent =
  `{NET_B}` at depth 1; `{NET_B, NET_C}` at depth 2 if `NET_B → R2 → NET_C`.
- Anchor is GND ⇒ adjacent = `{}`.
- Anchor is VCC ⇒ adjacent = `{}`.

**Playwright E2E** on a real BVR sample:

- Cycle modes off → star → chain → chain-adjacent → off; verify class /
  data attribute on the toolbar button at each step.
- Click a pin known to sit on a 2-pin chain to a power rail; verify the
  rail's pins render in the adjacent colour and that adjacent-net
  components are not dimmed.
- Click a GND pin; verify no adjacency expansion occurs.

## Out of scope (deferred)

- Depth > 1 UI (parameter exists; control does not).
- Multi-pin bridging heuristics (R-arrays, MOSFET pairs, jumpers).
- Per-depth colour gradients.
- Adjacent-net pin colour as a separate knob.
- "Trace a power rail" power-distribution mode (requires different
  pruning rules and is a distinct feature).

## Files touched

- `src/frontend/src/parsers/types.ts` — export `isPowerRail`, add
  `isGroundRail`, add `computeAdjacentNets`.
- `src/frontend/src/store/board-store.ts` — extend `NetLineMode`,
  `SelectionState`; update `cycleNetLineMode`, `highlightNet`,
  `loadViewPrefs` migration.
- `src/frontend/src/store/render-settings.ts` — add
  `adjacentNetLineColor` knob with default + serialiser entry.
- `src/frontend/src/renderer/BoardRenderer.ts` — read `adjacentNets` in
  net-line draw, dim filter, ghost-outline pass; honour
  `adjacentNetLineColor`.
- `src/frontend/src/renderer/board-scene.ts` — propagate adjacent-net
  styling into the shared scene builder so the `SettingsMockup` mirrors
  the real renderer (existing convention per `CLAUDE.md`).
- `src/frontend/src/components/BoardSidebar.tsx` /
  `src/frontend/src/panels/ComponentInfoPanel.tsx` — only if the cycle
  tooltip text needs updating (no behaviour change).
- Tests: new unit-test file for `computeAdjacentNets`; one Playwright
  spec extension.
