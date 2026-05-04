# Net Chain Adjacent Highlight Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a 4th step `chain-adjacent` to the net-line cycle that propagates the highlight from the selected net through 2-pin components to adjacent nets, drawing them in a distinct (default bluish) color.

**Architecture:** Pure helper `computeAdjacentNets()` in `parsers/types.ts` runs on click via `highlightNet()`/`cycleNetLineMode()` and stores results in `SelectionState.adjacentNets`. Renderer reads the union `{highlightedNet} ∪ adjacentNets` for net-line drawing, dim filtering, and ghost outlines. Single new color knob `adjacentNetLineColor`; all other line styling (width / alpha / dash / pulse) is reused.

**Tech Stack:** TypeScript, PixiJS v8, React (UI untouched), Playwright (tests).

**Spec:** [docs/superpowers/specs/2026-05-05-net-chain-adjacent-highlight-design.md](../specs/2026-05-05-net-chain-adjacent-highlight-design.md)

---

## File Map

- **Modify** `src/frontend/src/parsers/types.ts` — export `isPowerRail`, add `isGroundRail`, add `computeAdjacentNets`.
- **Modify** `src/frontend/src/store/board-store.ts` — extend `NetLineMode` type, `SelectionState`, `cycleNetLineMode`, `highlightNet`, `loadViewPrefs` migration, all `SelectionState` construction sites.
- **Modify** `src/frontend/src/store/render-settings.ts` — add `adjacentNetLineColor` knob with default + auto-serialise via existing loop.
- **Modify** `src/frontend/src/renderer/BoardRenderer.ts` — extend `lastRenderedSel` invalidation, multi-net `recomputeNetLineSegments`, per-segment color in `renderNetLines`, multi-net `effectiveNet`/dim/ghost-outline gathering, anonymous selection types in `updateElevatedLabels`/`updateSelectionOverlay` signatures.
- **Create** `src/frontend/tests/net-classification.spec.ts` — unit tests for `isGroundRail`, `isPowerRail`, `computeAdjacentNets` against synthetic boards.
- **Create** `src/frontend/tests/net-chain-adjacent.spec.ts` — Playwright E2E for the cycle and the visual outcome.

---

## Task 1: Net classification predicates

**Files:**
- Modify: `src/frontend/src/parsers/types.ts:485-505` (existing private `isPowerRail`)
- Create: `src/frontend/tests/net-classification.spec.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/frontend/tests/net-classification.spec.ts`:

```ts
import { test, expect } from '@playwright/test';

test.describe('net classification predicates', () => {
  test('isGroundRail matches GND family only', async () => {
    const { isGroundRail } = await import('../src/parsers/types');
    expect(isGroundRail('GND')).toBe(true);
    expect(isGroundRail('AGND')).toBe(true);
    expect(isGroundRail('DGND')).toBe(true);
    expect(isGroundRail('PGND')).toBe(true);
    expect(isGroundRail('EARTH')).toBe(true);
    expect(isGroundRail('CHASSIS')).toBe(true);
    expect(isGroundRail('GND_DIG')).toBe(true);
    expect(isGroundRail('gnd')).toBe(true);

    expect(isGroundRail('VCC')).toBe(false);
    expect(isGroundRail('VDD')).toBe(false);
    expect(isGroundRail('VSS')).toBe(false);
    expect(isGroundRail('+3V3')).toBe(false);
    expect(isGroundRail('VSENSE')).toBe(false);
    expect(isGroundRail('')).toBe(false);
  });

  test('isPowerRail still matches power + ground (existing behaviour)', async () => {
    const { isPowerRail } = await import('../src/parsers/types');
    expect(isPowerRail('GND')).toBe(true);
    expect(isPowerRail('VCC')).toBe(true);
    expect(isPowerRail('+3V3')).toBe(true);
    expect(isPowerRail('-5V')).toBe(true);
    expect(isPowerRail('VSENSE')).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src/frontend && npx playwright test net-classification.spec.ts --reporter=line`
Expected: FAIL — `isGroundRail` not exported, `isPowerRail` not exported.

- [ ] **Step 3: Add `isGroundRail` and export `isPowerRail`**

In `src/frontend/src/parsers/types.ts`, locate the existing `isPowerRail` (around line 485) and replace its declaration:

```ts
/**
 * Ground-rail nets only — GND and its aliases. Used by chain-adjacent net
 * highlighting to decide which nets to skip entirely (no propagation, no
 * highlight).
 */
export function isGroundRail(net: string): boolean {
  if (!net) return false;
  const upper = net.toUpperCase();
  return (
    upper === 'GND' ||
    upper === 'AGND' ||
    upper === 'DGND' ||
    upper === 'PGND' ||
    upper === 'EARTH' ||
    upper === 'CHASSIS' ||
    upper.startsWith('GND_')
  );
}

/**
 * Common power/ground rail-name patterns. Components that overlap with only
 * power-rail nets in common are usually heatsinks, EMI shields, or thermal
 * pads — physically valid stacks, not ghosts.
 */
export function isPowerRail(net: string): boolean {
```

(Keep the body of `isPowerRail` unchanged — just promote the keyword from the implicit private `function` to `export function`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src/frontend && npx playwright test net-classification.spec.ts --reporter=line`
Expected: 2 PASSED.

- [ ] **Step 5: Run typecheck to confirm no regressions**

Run: `cd src/frontend && npx tsc -b --noEmit`
Expected: no errors. (`isPowerRail` was used internally via the private declaration; `export` does not change behaviour.)

- [ ] **Step 6: Commit**

```bash
git add src/frontend/src/parsers/types.ts src/frontend/tests/net-classification.spec.ts
git commit -m "$(cat <<'EOF'
feat(types): export isPowerRail, add isGroundRail

Promotes isPowerRail from private to exported, adds sibling isGroundRail
that matches only GND/AGND/DGND/PGND/EARTH/CHASSIS/GND_*. Used by
upcoming net-chain-adjacent highlight to distinguish "skip entirely"
(ground) from "highlight but terminate" (power).
EOF
)"
```

---

## Task 2: `computeAdjacentNets` BFS helper

**Files:**
- Modify: `src/frontend/src/parsers/types.ts` (append after `isPowerRail`)
- Modify: `src/frontend/tests/net-classification.spec.ts` (extend)

- [ ] **Step 1: Write the failing tests**

Append to `src/frontend/tests/net-classification.spec.ts`:

```ts
test.describe('computeAdjacentNets', () => {
  // Helper: build a minimal BoardData from a parts spec.
  // Each "part" is { name, pinNets: string[] } — pin positions are stubbed.
  type PartSpec = { name: string; pinNets: string[] };
  async function buildBoard(parts: PartSpec[]) {
    const { buildNets } = await import('../src/parsers/types');
    const built = parts.map((p, i) => ({
      name: p.name,
      side: 'top' as const,
      type: 'smd' as const,
      origin: { x: i * 100, y: 0 },
      pins: p.pinNets.map((net, pi) => ({
        name: String(pi + 1),
        number: String(pi + 1),
        position: { x: i * 100 + pi * 10, y: 0 },
        radius: 5,
        side: 'top' as const,
        net,
      })),
      bounds: { minX: i * 100, minY: -5, maxX: i * 100 + (p.pinNets.length - 1) * 10, maxY: 5 },
    }));
    return {
      format: 'TEST',
      outline: [],
      parts: built,
      nails: [],
      nets: buildNets(built),
      bounds: { minX: 0, minY: -10, maxX: 1000, maxY: 10 },
    };
  }

  test('pull-up: VSENSE → R12(2-pin) → VCC ⇒ adjacent = {VCC}', async () => {
    const { computeAdjacentNets } = await import('../src/parsers/types');
    const board = await buildBoard([
      { name: 'U1', pinNets: ['VSENSE'] },
      { name: 'R12', pinNets: ['VSENSE', 'VCC'] },
      { name: 'U2', pinNets: ['VCC'] },  // VCC fan-out — must not be added under depth=1
    ]);
    const adj = computeAdjacentNets(board, 'VSENSE', 1);
    expect([...adj].sort()).toEqual(['VCC']);
  });

  test('GND stitch: RAIL → R5(2-pin) → GND ⇒ adjacent = {} (ground skipped)', async () => {
    const { computeAdjacentNets } = await import('../src/parsers/types');
    const board = await buildBoard([
      { name: 'U1', pinNets: ['RAIL'] },
      { name: 'R5', pinNets: ['RAIL', 'GND'] },
    ]);
    const adj = computeAdjacentNets(board, 'RAIL', 1);
    expect([...adj]).toEqual([]);
  });

  test('MOSFET 3-pin Q1 does not bridge from GATE', async () => {
    const { computeAdjacentNets } = await import('../src/parsers/types');
    const board = await buildBoard([
      { name: 'U1', pinNets: ['GATE'] },
      { name: 'Q1', pinNets: ['GATE', 'DRAIN', 'SOURCE'] },
    ]);
    const adj = computeAdjacentNets(board, 'GATE', 1);
    expect([...adj]).toEqual([]);
  });

  test('series signal: NET_A → R1 → NET_B at depth 1', async () => {
    const { computeAdjacentNets } = await import('../src/parsers/types');
    const board = await buildBoard([
      { name: 'U1', pinNets: ['NET_A'] },
      { name: 'R1', pinNets: ['NET_A', 'NET_B'] },
      { name: 'R2', pinNets: ['NET_B', 'NET_C'] },
    ]);
    const adj = computeAdjacentNets(board, 'NET_A', 1);
    expect([...adj].sort()).toEqual(['NET_B']);
  });

  test('series signal: depth=2 reaches NET_C', async () => {
    const { computeAdjacentNets } = await import('../src/parsers/types');
    const board = await buildBoard([
      { name: 'U1', pinNets: ['NET_A'] },
      { name: 'R1', pinNets: ['NET_A', 'NET_B'] },
      { name: 'R2', pinNets: ['NET_B', 'NET_C'] },
    ]);
    const adj = computeAdjacentNets(board, 'NET_A', 2);
    expect([...adj].sort()).toEqual(['NET_B', 'NET_C']);
  });

  test('power rail does not propagate even at depth=2', async () => {
    const { computeAdjacentNets } = await import('../src/parsers/types');
    const board = await buildBoard([
      { name: 'U1', pinNets: ['VSENSE'] },
      { name: 'R12', pinNets: ['VSENSE', 'VCC'] },
      { name: 'R13', pinNets: ['VCC', 'OTHER'] },
    ]);
    const adj = computeAdjacentNets(board, 'VSENSE', 2);
    expect([...adj].sort()).toEqual(['VCC']);
  });

  test('anchor is GND ⇒ empty set', async () => {
    const { computeAdjacentNets } = await import('../src/parsers/types');
    const board = await buildBoard([
      { name: 'R1', pinNets: ['SIG', 'GND'] },
    ]);
    const adj = computeAdjacentNets(board, 'GND', 1);
    expect([...adj]).toEqual([]);
  });

  test('anchor is VCC ⇒ empty set', async () => {
    const { computeAdjacentNets } = await import('../src/parsers/types');
    const board = await buildBoard([
      { name: 'R1', pinNets: ['SIG', 'VCC'] },
    ]);
    const adj = computeAdjacentNets(board, 'VCC', 1);
    expect([...adj]).toEqual([]);
  });

  test('anchor net not found in nets map ⇒ empty set', async () => {
    const { computeAdjacentNets } = await import('../src/parsers/types');
    const board = await buildBoard([
      { name: 'U1', pinNets: ['NET_A'] },
    ]);
    const adj = computeAdjacentNets(board, 'NONEXISTENT', 1);
    expect([...adj]).toEqual([]);
  });

  test('depth=0 returns empty set', async () => {
    const { computeAdjacentNets } = await import('../src/parsers/types');
    const board = await buildBoard([
      { name: 'U1', pinNets: ['NET_A'] },
      { name: 'R1', pinNets: ['NET_A', 'NET_B'] },
    ]);
    const adj = computeAdjacentNets(board, 'NET_A', 0);
    expect([...adj]).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src/frontend && npx playwright test net-classification.spec.ts --reporter=line`
Expected: 10 FAILED in the `computeAdjacentNets` describe — function not exported.

- [ ] **Step 3: Implement `computeAdjacentNets`**

Append to `src/frontend/src/parsers/types.ts` (after `isPowerRail`, before `detectGhostComponents`):

```ts
/**
 * BFS over the connectivity graph induced by 2-pin components, starting from
 * `anchorNet`. Returns the set of adjacent net names reachable within
 * `depth` hops. The anchor itself is never included.
 *
 * Pruning rules per hop into a candidate net `N`:
 *   - If `isGroundRail(N)`: skip entirely (not added, not recursed).
 *   - If `isPowerRail(N)` (and not ground): add to result, but do not
 *     recurse from `N` (terminator).
 *   - Otherwise: add to result and recurse from `N` (subject to depth).
 *
 * If the anchor itself is a power rail (incl. ground), returns an empty
 * set — clicking GND or VCC must not produce a whole-board explosion.
 */
export function computeAdjacentNets(
  board: BoardData,
  anchorNet: string,
  depth: number,
): Set<string> {
  const result = new Set<string>();
  if (depth <= 0) return result;
  if (!anchorNet) return result;
  if (isPowerRail(anchorNet)) return result;
  if (!board.nets.has(anchorNet)) return result;

  // BFS frontier: nets to expand at the current depth level.
  let frontier: string[] = [anchorNet];
  const visited = new Set<string>([anchorNet]);

  for (let d = 0; d < depth && frontier.length > 0; d++) {
    const next: string[] = [];
    for (const netName of frontier) {
      const net = board.nets.get(netName);
      if (!net) continue;
      // Walk every 2-pin part on this net; cross over to the other pin's net.
      const seenParts = new Set<number>();
      for (const ref of net.pinIndices) {
        if (seenParts.has(ref.partIndex)) continue;
        seenParts.add(ref.partIndex);
        const part = board.parts[ref.partIndex];
        if (!part || part.pins.length !== 2) continue;
        const otherPin = part.pins[1 - ref.pinIndex];
        if (!otherPin) continue;
        const otherNet = otherPin.net;
        if (!otherNet || otherNet === netName || visited.has(otherNet)) continue;
        if (isGroundRail(otherNet)) continue;          // skip entirely
        visited.add(otherNet);
        result.add(otherNet);
        if (!isPowerRail(otherNet)) next.push(otherNet); // recurse only signals
      }
    }
    frontier = next;
  }

  return result;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src/frontend && npx playwright test net-classification.spec.ts --reporter=line`
Expected: 12 PASSED.

- [ ] **Step 5: Commit**

```bash
git add src/frontend/src/parsers/types.ts src/frontend/tests/net-classification.spec.ts
git commit -m "$(cat <<'EOF'
feat(types): add computeAdjacentNets BFS helper

Pure function for chain-adjacent net highlight: BFS from anchor net
through 2-pin components, skipping ground entirely and treating power
rails as terminators. Tested against pull-up, GND-stitch, MOSFET 3-pin
non-bridge, multi-hop signal chain, depth=0 edge case, and rail-anchor
short-circuit.
EOF
)"
```

---

## Task 3: Extend `NetLineMode` type and the cycle

**Files:**
- Modify: `src/frontend/src/store/board-store.ts:19-29` (type + doc)
- Modify: `src/frontend/src/store/board-store.ts:358-386` (`loadViewPrefs` sanitize)
- Modify: `src/frontend/src/store/board-store.ts:1243-1253` (`cycleNetLineMode`)

- [ ] **Step 1: Update the `NetLineMode` type and its doc comment**

Replace lines 19-29 (the doc comment + `export type NetLineMode = …`) with:

```ts
/**
 * Net-line visualization mode. Cycles via the toolbar button:
 *   off            → no connecting lines drawn
 *   star           → lines radiate from the selected pin/part to nearest
 *                    pin on every other part on the net (anchor required)
 *   chain          → greedy minimum-spanning tree across all parts on the
 *                    selected net
 *   chain-adjacent → chain mode + propagate the highlight one hop through
 *                    2-pin components to adjacent nets (drawn in
 *                    `adjacentNetLineColor`); ground nets are skipped,
 *                    power rails terminate (no further recursion)
 */
export type NetLineMode = 'off' | 'star' | 'chain' | 'chain-adjacent';
```

- [ ] **Step 2: Update `loadViewPrefs` sanitize check**

Replace line 371-373 in `loadViewPrefs`:

```ts
      if (
        merged.netLineMode !== 'off' &&
        merged.netLineMode !== 'star' &&
        merged.netLineMode !== 'chain' &&
        merged.netLineMode !== 'chain-adjacent'
      ) {
        merged.netLineMode = 'off';
      }
```

- [ ] **Step 3: Update `cycleNetLineMode` to a 4-step cycle**

Replace lines 1243-1253:

```ts
  /** Cycle the net-line visualization: off → star → chain → chain-adjacent → off. */
  cycleNetLineMode() {
    const tab = this.activeTab;
    if (!tab) return;
    const next: NetLineMode =
      tab.netLineMode === 'off' ? 'star' :
      tab.netLineMode === 'star' ? 'chain' :
      tab.netLineMode === 'chain' ? 'chain-adjacent' : 'off';
    this.updateActiveTab({ netLineMode: next });
    this._saveCurrentViewPrefs();
    this.notify();
  }
```

- [ ] **Step 4: Run typecheck**

Run: `cd src/frontend && npx tsc -b --noEmit`
Expected: typecheck succeeds. The renderer's existing `mode === 'off'` / `mode === 'star'` / `mode === 'chain'` checks all remain valid (no exhaustive-switch usage).

- [ ] **Step 5: Run existing test suite to confirm no regressions**

Run: `cd src/frontend && npx playwright test ci-smoke.spec.ts --reporter=line`
Expected: PASS — smoke test still loads.

- [ ] **Step 6: Commit**

```bash
git add src/frontend/src/store/board-store.ts
git commit -m "$(cat <<'EOF'
feat(store): extend NetLineMode with chain-adjacent

Adds 4th step to the net-line cycle. cycleNetLineMode loops
off → star → chain → chain-adjacent → off; loadViewPrefs sanitizes the
new value. No behaviour change yet — chain-adjacent currently renders
the same as chain until adjacency wiring lands in subsequent commits.
EOF
)"
```

---

## Task 4: Extend `SelectionState` with `adjacentNets`

**Files:**
- Modify: `src/frontend/src/store/board-store.ts:13-17` (interface)
- Modify: `src/frontend/src/store/board-store.ts:649-660` (`emptySelection` if defined here, or wherever it appears)
- Modify: `src/frontend/src/store/board-store.ts:859, 870, 1479, 1516` (construction sites)
- Modify: `src/frontend/src/renderer/BoardRenderer.ts:287` (`lastRenderedSel` cache)
- Modify: `src/frontend/src/renderer/BoardRenderer.ts:3146, 3307` (anonymous selection types)

- [ ] **Step 1: Find `emptySelection`**

Run: `cd src/frontend && grep -n "emptySelection" src/store/board-store.ts`
Expected: shows 1-2 occurrences. Note the line of the *definition* (a `const emptySelection = { … }` or similar) and any usage sites.

- [ ] **Step 2: Extend the `SelectionState` interface**

Replace lines 13-17 in `board-store.ts`:

```ts
export interface SelectionState {
  partIndex: number | null;
  pinIndex: number | null;
  highlightedNet: string | null;
  /** Nets reachable from `highlightedNet` through 2-pin components, populated
   *  only when `netLineMode === 'chain-adjacent'`. Empty otherwise. Derived
   *  state — recomputed in `highlightNet()` and `cycleNetLineMode()`,
   *  not persisted. */
  adjacentNets: Set<string>;
}
```

- [ ] **Step 3: Update `emptySelection`**

Replace its definition with:

```ts
const emptySelection: SelectionState = {
  partIndex: null,
  pinIndex: null,
  highlightedNet: null,
  adjacentNets: new Set<string>(),
};
```

If `emptySelection` is spread (`{ ...emptySelection }`) in tab init, that pattern keeps working — but each tab now gets its own fresh Set via the spread *only because* the spread copies the reference. To avoid two tabs sharing the same Set instance, change the spread sites to:

```ts
selection: { ...emptySelection, adjacentNets: new Set<string>() },
```

Find all `{ ...emptySelection }` sites: `cd src/frontend && grep -n "...emptySelection" src/store/board-store.ts` and update each to the form above.

- [ ] **Step 4: Update the four `selection: { partIndex, … }` literal sites**

For each of these lines, replace the literal with one that includes `adjacentNets`:

Line 859 (the `selectPart` path — `selectPin` upstream):
```ts
      selection: { partIndex, pinIndex: null, highlightedNet: null, adjacentNets: new Set<string>() },
```

Line 870 (the pin-selection path — `selectPin`):
```ts
      selection: { partIndex, pinIndex, highlightedNet: pin?.net || null, adjacentNets: new Set<string>() },
```

Line 880 (`highlightNet`):
```ts
      selection: { ...tab.selection, highlightedNet: netName, adjacentNets: new Set<string>() },
```

(Task 5 will replace this hard-coded empty set with a real `computeAdjacentNets` call when the mode is `chain-adjacent`.)

Line 1479:
```ts
      selection: { partIndex: idx, pinIndex: null, highlightedNet: keepNet ? prevNet : null, adjacentNets: new Set<string>() },
```

Line 1516:
```ts
      selection: { partIndex: null, pinIndex: null, highlightedNet: name, adjacentNets: new Set<string>() },
```

(Task 5 will replace 880 and 1516 with adjacency-aware factories. Lines 859, 870, 1479 reset adjacency to empty because they don't change `highlightedNet` to a value the user has explicitly selected for chain-adjacent — they reset selection state.)

- [ ] **Step 5: Update the renderer's `lastRenderedSel` cache shape**

In `src/frontend/src/renderer/BoardRenderer.ts` around line 287, replace:

```ts
  private lastRenderedSel = { partIndex: null as number | null, pinIndex: null as number | null, highlightedNet: null as string | null, searchLen: 0, board: null as BoardData | null, dimMode: 'dim' as 'off' | 'dim' | 'darklight', butterfly: false, showTop: true, showBottom: true, showGhosts: true, searchSelectionActive: false };
```

with:

```ts
  private lastRenderedSel = { partIndex: null as number | null, pinIndex: null as number | null, highlightedNet: null as string | null, adjacentNetsKey: '' as string, searchLen: 0, board: null as BoardData | null, dimMode: 'dim' as 'off' | 'dim' | 'darklight', butterfly: false, showTop: true, showBottom: true, showGhosts: true, searchSelectionActive: false };
```

Then at the assignment site around line 1919, replace the `this.lastRenderedSel = { … }` literal so it captures `adjacentNetsKey` from the current selection:

```ts
        this.lastRenderedSel = { partIndex: sel.partIndex, pinIndex: sel.pinIndex, highlightedNet: sel.highlightedNet, adjacentNetsKey: [...sel.adjacentNets].sort().join(','), searchLen, board: this.board, dimMode: boardStore.dimMode, butterfly: boardStore.butterfly, showTop: boardStore.showTop, showBottom: boardStore.showBottom, showGhosts: boardStore.showGhosts, searchSelectionActive: boardStore.searchSelectionActive };
```

And at the dirty check around line 1909, add an adjacent-set comparison. Locate:

```ts
        || sel.highlightedNet !== lrs.highlightedNet
```

Append a sibling line:

```ts
        || [...sel.adjacentNets].sort().join(',') !== lrs.adjacentNetsKey
```

(Sorting + joining is fine here — the set rarely exceeds a few entries; per-frame cost is negligible. The comparison runs only on the dirty-check path, not the draw path.)

- [ ] **Step 6: Update anonymous selection types in renderer signatures**

In `BoardRenderer.ts`, update the two function signatures that destructure `sel`:

Line 3146 (`updateElevatedLabels`):
```ts
  private updateElevatedLabels(
    sel: { partIndex: number | null; pinIndex: number | null; highlightedNet: string | null; adjacentNets: Set<string> },
    s: import('../store/render-settings').RenderSettings,
  ) {
```

Line 3307 (`updateSelectionOverlay`):
```ts
  private updateSelectionOverlay(
    sel: { partIndex: number | null; pinIndex: number | null; highlightedNet: string | null; adjacentNets: Set<string> },
    s: import('../store/render-settings').RenderSettings,
  ) {
```

(Both functions still only use `partIndex`/`pinIndex`/`highlightedNet` internally; the type widening is just to satisfy `SelectionState` callers without any cast.)

- [ ] **Step 7: Run typecheck**

Run: `cd src/frontend && npx tsc -b --noEmit`
Expected: succeeds. If it complains about an `emptySelection`-derived selection missing `adjacentNets`, find the leftover spread and fix it as in Step 3.

- [ ] **Step 8: Run smoke test**

Run: `cd src/frontend && npx playwright test ci-smoke.spec.ts --reporter=line`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/frontend/src/store/board-store.ts src/frontend/src/renderer/BoardRenderer.ts
git commit -m "$(cat <<'EOF'
feat(store): add adjacentNets to SelectionState

Adds a Set<string> field to SelectionState carrying nets reachable
from highlightedNet through 2-pin components. Initialized empty at
every construction site; renderer's lastRenderedSel cache now
invalidates when the set changes. No behaviour change — population
logic lands in the next commit.
EOF
)"
```

---

## Task 5: Wire `highlightNet` and `cycleNetLineMode` to populate `adjacentNets`

**Files:**
- Modify: `src/frontend/src/store/board-store.ts:876-884` (`highlightNet`)
- Modify: `src/frontend/src/store/board-store.ts:1244-1253` (`cycleNetLineMode`)
- Modify: `src/frontend/src/store/board-store.ts:1510-1520` (the second `highlightNet`-like site at line 1516, if it's a separate method — verify with grep)

- [ ] **Step 1: Add the import**

At the top of `src/frontend/src/store/board-store.ts`, the import already covers `parsers/types`:

```ts
import { computeBBox, generateSyntheticOutline, detectGhostComponents } from '../parsers/types';
```

Extend it to include `computeAdjacentNets`:

```ts
import { computeBBox, generateSyntheticOutline, detectGhostComponents, computeAdjacentNets } from '../parsers/types';
```

- [ ] **Step 2: Add a private adjacency-resolver helper on the store**

Inside the `BoardStore` class, add a private method (a good location is just above `highlightNet`):

```ts
  /** Compute adjacentNets for the active tab's current board+net combination,
   *  using the current netLineMode. Returns an empty set unless mode is
   *  'chain-adjacent', the board is loaded, and the anchor net is set. */
  private _resolveAdjacentNets(netName: string | null): Set<string> {
    const tab = this.activeTab;
    if (!tab || !tab.board || !netName) return new Set<string>();
    if (tab.netLineMode !== 'chain-adjacent') return new Set<string>();
    return computeAdjacentNets(tab.board, netName, 1);
  }
```

- [ ] **Step 3: Update `highlightNet`**

Replace lines 876-884:

```ts
  highlightNet(netName: string | null) {
    const tab = this.activeTab;
    if (!tab) return;
    this.updateActiveTab({
      selection: {
        ...tab.selection,
        highlightedNet: netName,
        adjacentNets: this._resolveAdjacentNets(netName),
      },
      searchSelectionActive: false,
    });
    this.notify();
  }
```

- [ ] **Step 4: Update `cycleNetLineMode` to (re)compute or clear the set on transitions**

Replace the `cycleNetLineMode` body:

```ts
  cycleNetLineMode() {
    const tab = this.activeTab;
    if (!tab) return;
    const next: NetLineMode =
      tab.netLineMode === 'off' ? 'star' :
      tab.netLineMode === 'star' ? 'chain' :
      tab.netLineMode === 'chain' ? 'chain-adjacent' : 'off';
    // Recompute adjacency on transitions into/out of chain-adjacent.
    let adjacentNets = tab.selection.adjacentNets;
    if (next === 'chain-adjacent') {
      adjacentNets = tab.board && tab.selection.highlightedNet
        ? computeAdjacentNets(tab.board, tab.selection.highlightedNet, 1)
        : new Set<string>();
    } else if (tab.netLineMode === 'chain-adjacent') {
      adjacentNets = new Set<string>();
    }
    this.updateActiveTab({
      netLineMode: next,
      selection: { ...tab.selection, adjacentNets },
    });
    this._saveCurrentViewPrefs();
    this.notify();
  }
```

- [ ] **Step 5: Audit the other `highlightedNet` assignment sites for adjacency**

Verify line 1516 (the search-result selection path) by:

```bash
cd src/frontend && grep -n "selection: { partIndex: null, pinIndex: null, highlightedNet:" src/store/board-store.ts
```

If that site receives a freshly chosen net (not a reset), replace `adjacentNets: new Set<string>()` with `adjacentNets: this._resolveAdjacentNets(name)` (using the local `name` variable from that site's surrounding code).

The reset-style sites at 859, 870, 1479 keep `adjacentNets: new Set<string>()` — they're not anchoring the user on a deliberate net for chain tracing.

- [ ] **Step 6: Run typecheck**

Run: `cd src/frontend && npx tsc -b --noEmit`
Expected: succeeds.

- [ ] **Step 7: Run smoke test**

Run: `cd src/frontend && npx playwright test ci-smoke.spec.ts --reporter=line`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/frontend/src/store/board-store.ts
git commit -m "$(cat <<'EOF'
feat(store): populate adjacentNets in highlightNet & cycleNetLineMode

When netLineMode is 'chain-adjacent', highlightNet() and cycleNetLineMode()
call computeAdjacentNets(board, anchor, depth=1) to populate
SelectionState.adjacentNets. Cycling out of chain-adjacent clears the
set. Hover does not trigger — separate hoverNet field on the renderer.
EOF
)"
```

---

## Task 6: Add `adjacentNetLineColor` render-settings knob

**Files:**
- Modify: `src/frontend/src/store/render-settings.ts:100-106` (type)
- Modify: `src/frontend/src/store/render-settings.ts:297-302` (default)

- [ ] **Step 1: Add the field to the `RenderSettings` interface**

Locate the existing block at line 100-106 and append `adjacentNetLineColor`:

```ts
  netLineWidth: number;
  netLineAlpha: number;
  netLineColor: number;
  /** Color used for chain-adjacent net lines (the propagated nets reached
   *  from the selected net through 2-pin components). Default bluish. */
  adjacentNetLineColor: number;
  netLineDashed: boolean;
  netLineDashLength: number;
  netLinePulse: boolean;
```

- [ ] **Step 2: Add the default value**

Locate line 297-302 (the default-net-line block) and add:

```ts
  netLineWidth: 3.5,
  netLineAlpha: 0.6,
  netLineColor: 0xffff44,
  adjacentNetLineColor: 0x4488ff,
  netLineDashed: false,
  netLineDashLength: 8,
  netLinePulse: false,
```

(The serialiser at line 1170-1178 auto-handles new keys, including the hex format for color keys via the `key.toLowerCase().includes('color') && val > 255` check.)

- [ ] **Step 3: Run typecheck**

Run: `cd src/frontend && npx tsc -b --noEmit`
Expected: succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/frontend/src/store/render-settings.ts
git commit -m "$(cat <<'EOF'
feat(settings): add adjacentNetLineColor knob

Bluish (0x4488ff) default for the upcoming chain-adjacent net-line
mode. All other line styling (width / alpha / dash / pulse) reused
from the existing knobs to keep adjacent and selected lines visually
consistent except for hue.
EOF
)"
```

---

## Task 7A: Renderer — multi-net chain-line drawing

**Files:**
- Modify: `src/frontend/src/renderer/BoardRenderer.ts:3336-3461` (`recomputeNetLineSegments`)
- Modify: `src/frontend/src/renderer/BoardRenderer.ts:3463-3505` (`renderNetLines`)

This task only changes the **chain-line drawing** layer. Pin/part highlight and ghost gathering are extended in Tasks 7B and 7C.

- [ ] **Step 1: Extend the `netLineSegments` shape with a per-segment color**

Find the current declaration of `netLineSegments`. Run:
```bash
cd src/frontend && grep -n "netLineSegments\b" src/renderer/BoardRenderer.ts | head -5
```

It's declared as a private field, used as `Array<{ start: Point; end: Point }>`. Replace its declaration with:

```ts
  private netLineSegments: Array<{ start: Point; end: Point; color: number }> = [];
```

(Search results will show the exact line.)

- [ ] **Step 2: Refactor `recomputeNetLineSegments` to loop over multiple nets**

The existing function (lines 3339-3461) computes segments for `sel.highlightedNet` only. Wrap the body so the per-net work runs once per net in the active set, tagging every pushed segment with the corresponding color.

Replace the function body with:

```ts
  /** Recompute cached net line segments (start/end points + color) when selection or viewport changes */
  private recomputeNetLineSegments() {
    this.netLineSegments = [];
    this.netLineFadeDist = 0;
    this.netLinesDirty = false;

    const mode = boardStore.netLineMode;
    if (!this.board || mode === 'off') return;

    const sel = boardStore.selection;
    if (!sel.highlightedNet) return;

    const s = renderSettingsStore.settings;

    type NetEntry = { name: string; color: number };
    const activeNets: NetEntry[] = [{ name: sel.highlightedNet, color: s.netLineColor }];
    if (mode === 'chain-adjacent') {
      for (const adj of sel.adjacentNets) {
        activeNets.push({ name: adj, color: s.adjacentNetLineColor });
      }
    }

    for (const entry of activeNets) {
      this.appendNetLineSegmentsFor(entry.name, entry.color, mode, sel, s);
    }
  }

  /** Build segments for a single net and append them to `netLineSegments`,
   *  tagging each with `color`. Extracted from the original
   *  recomputeNetLineSegments body. */
  private appendNetLineSegmentsFor(
    netName: string,
    color: number,
    mode: NetLineMode,
    sel: SelectionState,
    s: import('../store/render-settings').RenderSettings,
  ) {
    if (!this.board) return;
    const net = this.board.nets.get(netName);
    if (!net) return;

    // Skip GND/NC nets — GND connects too many components, NC is not a real net.
    const netUpper = netName.toUpperCase();
    if (netUpper.includes('GND') || isNcNet(netUpper, s.ncNetPatterns)) return;

    // For chain-adjacent, force chain topology on adjacent nets even if the
    // primary selection prefers star — star requires a part anchor that the
    // adjacent net does not have. The selected net keeps its mode.
    const isPrimary = netName === sel.highlightedNet;
    const effectiveMode: NetLineMode = isPrimary ? mode : 'chain';

    if (effectiveMode === 'star' && sel.partIndex !== null && isPrimary) {
      // ── Star topology from selected part to all others on the net ──
      const selectedPartIdx = sel.partIndex;
      const selectedPart = this.board.parts[selectedPartIdx];
      if (!selectedPart) return;

      const selectedRoot = this.rootForPart(selectedPart);
      const selEB = computePartRenderBounds(selectedPart, s);
      const selectedPin = sel.pinIndex !== null ? selectedPart.pins[sel.pinIndex] : null;
      const selCenterW = selectedPin
        ? this.sceneToWorld(selectedPin.position, selectedRoot)
        : this.sceneToWorld({ x: selEB.px + selEB.pw / 2, y: selEB.py + selEB.ph / 2 }, selectedRoot);

      const partNetPins = new Map<number, number[]>();
      for (const ref of net.pinIndices) {
        if (ref.partIndex === sel.partIndex) continue;
        let arr = partNetPins.get(ref.partIndex);
        if (!arr) { arr = []; partNetPins.set(ref.partIndex, arr); }
        arr.push(ref.pinIndex);
      }

      let targetCount = 0;
      for (const [partIndex, pinIndices] of partNetPins) {
        const part = this.board.parts[partIndex];
        if (!part) continue;
        const isGhost = !this.isPartVisible(part) && this.crossSideGhostParts.includes(partIndex);
        if (!this.isPartVisible(part) && !isGhost) continue;

        const root = isGhost ? this.activeScene?.root : this.rootForPart(part);

        let bestPin: Point | null = null;
        let bestDist = Infinity;
        for (const pi of pinIndices) {
          const pin = part.pins[pi];
          if (!pin) continue;
          const pw = this.sceneToWorld(pin.position, root);
          const dx = pw.x - selCenterW.x;
          const dy = pw.y - selCenterW.y;
          const d = dx * dx + dy * dy;
          if (d < bestDist) { bestDist = d; bestPin = pw; }
        }

        if (bestPin) {
          const start = this.clipToRectEdge(selCenterW, bestPin, selEB, selectedRoot);
          this.netLineSegments.push({ start, end: bestPin, color });
        }
        targetCount++;
      }

      const vpScale = Math.abs(this.viewport.scale.x);
      this.netLineFadeDist = Math.max(this.netLineFadeDist, targetCount > 8 ? 60 / vpScale : 0);
    } else {
      // ── Chain mode: greedy MST connecting every part on this net ──
      type NetPartInfo = { partIndex: number; center: Point; eb: ReturnType<typeof computePartRenderBounds>; root: Container | undefined };
      const netParts: NetPartInfo[] = [];
      const seenParts = new Set<number>();
      for (const ref of net.pinIndices) {
        if (seenParts.has(ref.partIndex)) continue;
        seenParts.add(ref.partIndex);
        const part = this.board.parts[ref.partIndex];
        if (!part) continue;
        const isGhost = !this.isPartVisible(part) && this.crossSideGhostParts.includes(ref.partIndex);
        if (!this.isPartVisible(part) && !isGhost) continue;
        const root = isGhost ? this.activeScene?.root : this.rootForPart(part);
        const eb = computePartRenderBounds(part, s);
        const center = this.sceneToWorld({ x: eb.px + eb.pw / 2, y: eb.py + eb.ph / 2 }, root);
        netParts.push({ partIndex: ref.partIndex, center, eb, root });
      }
      if (netParts.length < 2) return;

      const connected = new Set<number>([0]);
      const remaining = new Set<number>();
      for (let i = 1; i < netParts.length; i++) remaining.add(i);

      while (remaining.size > 0) {
        let bestI = -1, bestJ = -1, bestDist = Infinity;
        for (const ci of connected) {
          const a = netParts[ci].center;
          for (const ri of remaining) {
            const b = netParts[ri].center;
            const dx = b.x - a.x, dy = b.y - a.y;
            const d = dx * dx + dy * dy;
            if (d < bestDist) { bestDist = d; bestI = ci; bestJ = ri; }
          }
        }
        if (bestJ < 0) break;
        connected.add(bestJ);
        remaining.delete(bestJ);

        const a = netParts[bestI], b = netParts[bestJ];
        const start = this.clipToRectEdge(a.center, b.center, a.eb, a.root);
        const end = this.clipToRectEdge(b.center, a.center, b.eb, b.root);
        this.netLineSegments.push({ start, end, color });
      }
    }
  }
```

(`SelectionState` is defined in the store; import or `import type` it at the top of `BoardRenderer.ts` if not already in scope. Check with `grep -n "SelectionState" src/renderer/BoardRenderer.ts` — if absent, add `import type { SelectionState } from '../store/board-store';`.)

- [ ] **Step 3: Update `renderNetLines` to draw per-segment colors**

Replace the body of `renderNetLines` (lines 3463-3505):

```ts
  private renderNetLines() {
    this.needsRender = true;
    this.netLinesGfx.clear();

    if (this.netLinesDirty) this.recomputeNetLineSegments();
    if (this.netLineSegments.length === 0) return;

    const s = renderSettingsStore.settings;
    const vpScale = Math.abs(this.viewport.scale.x);
    const lineW = s.netLineWidth / vpScale;

    const pulseT = s.netLinePulse ? (Math.sin(this.netLinePulsePhase * Math.PI * 2) + 1) / 2 : 0;
    const pulseColor = 0xcc2222;

    const dashLen = s.netLineDashLength / vpScale;
    const dashOffset = s.netLineDashed ? (this.netLinePulsePhase * dashLen * 2) : 0;

    const useFade = this.netLineFadeDist > 0;
    const fadeDist = useFade ? 60 / vpScale : 0;

    // Group segments by base color so we can keep the fast batched-stroke path
    // when fade/dash are off. The grouping cost is O(N) and tiny for typical N.
    const byColor = new Map<number, Array<{ start: Point; end: Point }>>();
    for (const seg of this.netLineSegments) {
      let arr = byColor.get(seg.color);
      if (!arr) { arr = []; byColor.set(seg.color, arr); }
      arr.push({ start: seg.start, end: seg.end });
    }

    for (const [baseColor, segs] of byColor) {
      const color = s.netLinePulse ? this.lerpColor(baseColor, pulseColor, pulseT) : baseColor;
      if (!useFade && !s.netLineDashed) {
        for (const { start, end } of segs) {
          this.netLinesGfx.moveTo(start.x, start.y);
          this.netLinesGfx.lineTo(end.x, end.y);
        }
        this.netLinesGfx.stroke({ width: lineW, color, alpha: s.netLineAlpha });
      } else {
        for (const { start, end } of segs) {
          if (useFade) {
            this.drawNetLineWithFade(start, end, fadeDist, lineW, color, s.netLineAlpha, s.netLineDashed, dashLen, dashOffset);
          } else {
            this.drawDashedLine(start, end, dashLen, dashOffset, lineW, color, s.netLineAlpha);
          }
        }
      }
    }
  }
```

- [ ] **Step 4: Run typecheck**

Run: `cd src/frontend && npx tsc -b --noEmit`
Expected: succeeds.

- [ ] **Step 5: Run smoke tests**

Run: `cd src/frontend && npx playwright test ci-smoke.spec.ts --reporter=line`
Expected: PASS — chain-line drawing now multi-color but otherwise unchanged for star/chain modes.

- [ ] **Step 6: Commit**

```bash
git add src/frontend/src/renderer/BoardRenderer.ts
git commit -m "$(cat <<'EOF'
feat(renderer): per-segment color in net-line draw

recomputeNetLineSegments loops over {highlightedNet} ∪ adjacentNets,
tagging each segment with netLineColor or adjacentNetLineColor.
renderNetLines groups by color and keeps the batched-stroke fast path
when fade/dash are off. Adjacent nets always render with chain
topology (star requires a pin anchor that adjacents don't have).
EOF
)"
```

---

## Task 7B: Renderer — extend dim filter & per-pin highlight to adjacent nets

**Files:**
- Modify: `src/frontend/src/renderer/BoardRenderer.ts:2755-3104` (the `if (effectiveNet) { … }` highlight pipeline)

The existing block at 2837 is keyed on a single `effectiveNet`. Wrap it so the **per-net work** (part outlines, pin glow, label re-clone) runs once per net in the active set, with the **once-per-frame work** (dim overlay rect, trace highlight, via highlight, ghost finalisation) hoisted out. Adjacent nets get a different glow color but otherwise identical treatment.

Per the spec, traces and vias are highlighted **only for the primary (selected) net** — not for adjacents — to avoid the visual blow-up on shared rails like VCC.

- [ ] **Step 1: Build the active net set near the existing `effectiveNet` declaration**

In `BoardRenderer.ts` around line 2765, replace the existing block:

```ts
    const effectiveNet = sel.highlightedNet
      || (s.ambientDim && showDim && boardStore.showHoverInfo ? this.hoverNet : null);
```

with:

```ts
    const primaryNet = sel.highlightedNet
      || (s.ambientDim && showDim && boardStore.showHoverInfo ? this.hoverNet : null);
    // Set of nets that count as "highlighted" for this frame. For
    // chain-adjacent, includes both the primary and all adjacents; for
    // other modes only the primary. Empty when nothing is selected.
    const activeNets: Array<{ name: string; glowColor: number }> = [];
    if (primaryNet) {
      activeNets.push({ name: primaryNet, glowColor: COLORS.netHighlight });
      if (boardStore.netLineMode === 'chain-adjacent' && sel.highlightedNet) {
        for (const adj of sel.adjacentNets) {
          activeNets.push({ name: adj, glowColor: renderSettingsStore.settings.adjacentNetLineColor });
        }
      }
    }
    // Kept for the dim/spotlight gating which only cares about "any net active".
    const effectiveNet = primaryNet;
```

- [ ] **Step 2: Replace `if (effectiveNet) { const net = … }` with a loop over `activeNets`**

The block from line 2837 currently looks like:

```ts
    if (effectiveNet) {
      const net = this.board.nets.get(effectiveNet);
      if (net) {
        // dim overlay rect
        if (showDim) { /* … draw rect once … */ }

        // part outlines, ghost gathering
        const seenParts = new Set<number>();
        const topPartOutlines: (() => void)[] = [];
        const botPartOutlines: (() => void)[] = [];
        const ghostPartIndices: number[] = [];
        const netUpper = effectiveNet!.toUpperCase();
        const skipGhosts = netUpper.includes('GND') || isNcNet(netUpper, s.ncNetPatterns);

        for (const ref of net.pinIndices) { /* … gather outlines + ghosts … */ }

        // draw outlines (top + bottom strokes)
        // re-clone affected labels
        // pin glow loop (line 2939: another for-of net.pinIndices)
        // trace highlight (uses effectiveNet directly)
        // via highlight (uses effectiveNet directly)
        this.crossSideGhostParts = ghostPartIndices;
      }
    }
```

Restructure as follows (replacement for lines 2837 through 3103, *inclusive*):

```ts
    // Hoisted accumulators — populated per-net inside the loop, drained once.
    const seenParts = new Set<number>();
    const ghostPartIndices: number[] = [];
    const seenGhosts = new Set<number>();
    const topPartOutlines: (() => void)[] = [];
    const botPartOutlines: (() => void)[] = [];
    const topByColor = new Map<number, (() => void)[]>();
    const botByColor = new Map<number, (() => void)[]>();
    // Highlight glow draw fns, grouped by glow color so adjacent nets render
    // their pads in adjacentNetLineColor while the primary net stays yellow.
    const topHighlightsByColor = new Map<number, (() => void)[]>();
    const botHighlightsByColor = new Map<number, (() => void)[]>();
    const affectedTopNames = new Set<string>();
    const affectedBotNames = new Set<string>();

    if (primaryNet) {
      // ── Dim overlay (once per frame, not per-net) ─────────────────────
      if (showDim) {
        const b = this.board.bounds;
        const bw = b.maxX - b.minX;
        const bh = b.maxY - b.minY;
        const pad = Math.max(bw, bh) * 5;
        const cx = (b.minX + b.maxX) / 2;
        const cy = (b.minY + b.maxY) / 2;
        this.netDimGfx.rect(cx - pad, cy - pad, pad * 2, pad * 2);
        this.netDimGfx.fill({ color: 0x000000, alpha: s.dimOverlayAlpha });
      }

      // ── Per-net highlight loop ───────────────────────────────────────
      for (const { name: netName, glowColor } of activeNets) {
        const net = this.board.nets.get(netName);
        if (!net) continue;

        const netUpper = netName.toUpperCase();
        const skipGhosts = netUpper.includes('GND') || isNcNet(netUpper, s.ncNetPatterns);

        // Part outlines + ghost gathering for this net.
        for (const ref of net.pinIndices) {
          if (seenParts.has(ref.partIndex)) continue;
          seenParts.add(ref.partIndex);
          const part = this.board.parts[ref.partIndex];
          if (!part) continue;
          if (!this.isPartVisible(part)) {
            if (!butterfly && !skipGhosts && boardStore.showGhosts && !seenGhosts.has(ref.partIndex)) {
              seenGhosts.add(ref.partIndex);
              ghostPartIndices.push(ref.partIndex);
            }
            continue;
          }

          const gfx = gfxFor(part);
          const outlines = gfx === this.butterflySelectionGfx ? botPartOutlines : topPartOutlines;
          if (part.pins.length === 1) {
            const pin = part.pins[0];
            const r = computePinRadius(s, pin.radius) + s.selectionPadding;
            outlines.push(() => gfx.circle(pin.position.x, pin.position.y, r));
          } else {
            outlines.push(() => drawPartOutline(gfx, part, s.selectionPadding));
          }
        }

        // Pin glow + dim-redraw collectors for this net.
        for (const ref of net.pinIndices) {
          const part = this.board.parts[ref.partIndex];
          const pin = part?.pins[ref.pinIndex];
          if (!pin || !part || !this.isPartVisible(part)) continue;

          const gfx = gfxFor(part);
          const isBotGfx = gfx === this.butterflySelectionGfx;

          const isPin1 = ref.pinIndex === 0 && part.pins.length > 2;
          const pinColor = (isPin1 && s.showPin1Marker) ? COLORS.pin1 : resolvePinColor(s, pin.net, pin.side);

          // Affected names for label re-clone.
          if (part.side === 'bottom') affectedBotNames.add(part.name);
          else affectedTopNames.add(part.name);

          // Resolve pad geometry once.
          const storedPads = part.pins.length === 2 ? this.activeScene?.twoPinPadPolys.get(ref.partIndex) : null;
          const pb = pin.padBounds;
          const pushDim = (fn: () => void) => {
            if (!showDim) return;
            const map = isBotGfx ? botByColor : topByColor;
            let arr = map.get(pinColor);
            if (!arr) { arr = []; map.set(pinColor, arr); }
            arr.push(fn);
          };
          const pushGlow = (fn: () => void) => {
            const map = isBotGfx ? botHighlightsByColor : topHighlightsByColor;
            let arr = map.get(glowColor);
            if (!arr) { arr = []; map.set(glowColor, arr); }
            arr.push(fn);
          };

          if (storedPads && storedPads[ref.pinIndex]) {
            const padPoly = storedPads[ref.pinIndex];
            pushDim(() => drawPoly(gfx, padPoly));
            pushGlow(() => drawPoly(gfx, padPoly));
          } else if (pb) {
            const grow = s.netHighlightGrow;
            const padGeom: PadGeometry = {
              bounds: pb,
              shape: pin.padShape,
              width: pin.padWidth,
              height: pin.padHeight,
              angleDeg: pin.padAngleDeg,
              cornerRadius: pin.padCornerRadius,
            };
            pushDim(() => drawPadShape(gfx, padGeom));
            pushGlow(() => drawPadShape(gfx, padGeom, grow));
          } else {
            const clamp = this.activeScene?.pinRadiusClamp.get(ref.partIndex) ?? Infinity;
            const r = Math.min(computePinRadius(s, pin.radius), clamp);
            pushDim(() => gfx.circle(pin.position.x, pin.position.y, r));
            pushGlow(() => gfx.circle(pin.position.x, pin.position.y, r + s.netHighlightGrow));
          }
        }
      }

      // ── Drain accumulated outlines + glow (once per frame) ───────────
      for (const fn of topPartOutlines) fn();
      if (topPartOutlines.length > 0) {
        this.selectionGfx.fill({ color: BOARD_COLORS.labelPin, alpha: s.selectionFillAlpha });
        this.selectionGfx.stroke({ width: s.selectionWidth, color: COLORS.netHighlight, alpha: 0.7 });
      }
      for (const fn of botPartOutlines) fn();
      if (botPartOutlines.length > 0) {
        this.butterflySelectionGfx.fill({ color: BOARD_COLORS.labelPin, alpha: s.selectionFillAlpha });
        this.butterflySelectionGfx.stroke({ width: s.selectionWidth, color: COLORS.netHighlight, alpha: 0.7 });
      }

      // Re-clone affected labels above the dim overlay.
      if (showDim && this.activeScene) {
        const selectedPartName = sel.partIndex !== null ? this.board.parts[sel.partIndex]?.name : null;
        if (this.isTopVisible) {
          for (const srcLabel of this.activeScene.topLabels) {
            if (!srcLabel.visible || !affectedTopNames.has(srcLabel.text)) continue;
            if (selectedPartName && srcLabel.text === selectedPartName) continue;
            this.acquireNetLabel(srcLabel);
          }
        }
        if (this.isBottomVisible && !butterfly) {
          for (const srcLabel of this.activeScene.bottomLabels) {
            if (!srcLabel.visible || !affectedBotNames.has(srcLabel.text)) continue;
            if (selectedPartName && srcLabel.text === selectedPartName) continue;
            this.acquireNetLabel(srcLabel);
          }
        }
      }

      // Pin redraws above dim, grouped by pin color (full alpha).
      for (const [color, fns] of topByColor) {
        for (const fn of fns) fn();
        this.selectionGfx.fill({ color, alpha: 1.0 });
      }
      for (const [color, fns] of botByColor) {
        for (const fn of fns) fn();
        this.butterflySelectionGfx.fill({ color, alpha: 1.0 });
      }

      // Highlight glow on top, per glow color (yellow for primary, bluish
      // for adjacents). Each color group flushes its own fill.
      for (const [glowColor, fns] of topHighlightsByColor) {
        for (const fn of fns) fn();
        this.selectionGfx.fill({ color: glowColor, alpha: s.netHighlightAlpha });
      }
      for (const [glowColor, fns] of botHighlightsByColor) {
        for (const fn of fns) fn();
        this.butterflySelectionGfx.fill({ color: glowColor, alpha: s.netHighlightAlpha });
      }

      // ── Trace highlight (PRIMARY net only) ───────────────────────────
      if (this.board.traces && this.board.traces.length > 0 && boardStore.showTraces) {
        const netName = primaryNet;
        const { layerStates } = boardStore;
        const traceByColor = new Map<number, { sx: number; sy: number; ex: number; ey: number }[]>();
        for (const t of this.board.traces) {
          if (t.net !== netName) continue;
          let color: number = COLORS.netHighlight;
          if (t.layer != null && t.layer < layerStates.length) {
            color = layerStates[t.layer].color;
          }
          let arr = traceByColor.get(color);
          if (!arr) { arr = []; traceByColor.set(color, arr); }
          arr.push({ sx: t.start.x, sy: t.start.y, ex: t.end.x, ey: t.end.y });
        }
        for (const [c, segs] of traceByColor) {
          for (const s2 of segs) {
            this.selectionGfx.moveTo(s2.sx, s2.sy);
            this.selectionGfx.lineTo(s2.ex, s2.ey);
          }
          this.selectionGfx.stroke({ width: 3, color: c as number & 0xffffff, alpha: 0.9, join: 'round', cap: 'round' });
        }
      }

      // ── Via highlight (PRIMARY net only) ─────────────────────────────
      if (this.board.vias && this.board.vias.length > 0 && boardStore.showVias && this.activeScene) {
        const netName = primaryNet;
        const { layerStates } = boardStore;
        const connMap = this.activeScene.viaConnectedLayers;
        const selectedPart = sel.partIndex !== null ? this.board.parts[sel.partIndex] : null;
        const sourceLayer = selectedPart?.layer ?? -1;
        const byColor = new Map<number, { x: number; y: number }[]>();

        for (let vi = 0; vi < this.board.vias.length; vi++) {
          const via = this.board.vias[vi];
          if (via.net !== netName) continue;
          const connected = connMap[vi] ?? [];
          let color: number = COLORS.netHighlight;
          if (connected.length >= 2 && layerStates.length > 0) {
            let targetIdx: number;
            if (connected[0] === sourceLayer) {
              targetIdx = connected[connected.length - 1];
            } else if (connected[connected.length - 1] === sourceLayer) {
              targetIdx = connected[0];
            } else {
              targetIdx = Math.abs(connected[0] - sourceLayer) > Math.abs(connected[connected.length - 1] - sourceLayer)
                ? connected[0]
                : connected[connected.length - 1];
            }
            if (targetIdx < layerStates.length) color = layerStates[targetIdx].color;
          } else if (connected.length === 1 && layerStates.length > 0) {
            const idx = connected[0];
            if (idx < layerStates.length) color = layerStates[idx].color;
          }
          let arr = byColor.get(color);
          if (!arr) { arr = []; byColor.set(color, arr); }
          arr.push(via.position);
        }
        for (const [c, positions] of byColor) {
          for (const { x, y } of positions) {
            this.selectionGfx.moveTo(x - 12, y).lineTo(x + 12, y);
            this.selectionGfx.moveTo(x, y - 12).lineTo(x, y + 12);
            this.selectionGfx.circle(x, y, 10);
          }
          this.selectionGfx.stroke({ width: 2.5, color: c as number & 0xffffff, alpha: 0.95 });
        }
      }

      this.crossSideGhostParts = ghostPartIndices;
    }
```

- [ ] **Step 3: Run typecheck**

Run: `cd src/frontend && npx tsc -b --noEmit`
Expected: succeeds. If it complains about `affectedTopNames` / `affectedBotNames` already declared further down, that's fine — the original `if (showDim && this.activeScene) { … }` block had its own locally-scoped `const affectedTopNames = new Set<string>();` that we replaced. Search and remove any stale duplicate declarations in the surrounding code.

- [ ] **Step 4: Run smoke + comprehensive tests**

Run: `cd src/frontend && npx playwright test ci-smoke.spec.ts comprehensive.spec.ts --reporter=line`
Expected: PASS — primary-net highlight pipeline behaviour preserved.

- [ ] **Step 5: Commit**

```bash
git add src/frontend/src/renderer/BoardRenderer.ts
git commit -m "$(cat <<'EOF'
feat(renderer): per-net highlight loop in selection pipeline

Wraps the previously single-net 'effectiveNet' block into a loop over
{primary} ∪ adjacents, with dim overlay / trace / via / ghost
finalisation hoisted out so each runs once per frame. Per-net work
(part outlines, pin glow, label re-clone) runs per active net; glow
color is yellow for the primary net and adjacentNetLineColor for
adjacents. Traces and vias are highlighted only for the primary net
to avoid visual blow-up on shared rails like VCC.
EOF
)"
```

---

## Task 7C: Renderer — quick verification that adjacents un-dim correctly

**Files:**
- No code changes; this task validates Task 7B against a real board.

- [ ] **Step 1: Boot the dev server**

Run: `cd src/frontend && npm run dev` (in a separate shell or background).

- [ ] **Step 2: Manually verify with `samples/820-02016.bvr`**

Drag-drop the sample, click a 2-pin chain pin (any small resistor connecting a signal to a power rail), and verify with the toolbar:

- Mode `chain` (3rd step): only the selected net's lines + pins glow yellow.
- Mode `chain-adjacent` (4th step): the selected net stays yellow; the resistor's other pin and the rail's pins now glow blueish (`adjacentNetLineColor`); the bottom-side ghost outlines pulse for both nets; components on adjacent nets are not dimmed.

If anything looks wrong, walk back to Task 7B and inspect the per-net loop — common slips are (a) accidental yellow glow on adjacents (means `glowColor` not threaded into `pushGlow`), (b) traces lighting up on adjacents (means trace highlight didn't get gated to `primaryNet`).

- [ ] **Step 3: No commit — visual verification only**

If the manual check passes, proceed to Task 8. If a code fix is needed, amend Task 7B's commit only if the fix is small (1–2 lines); otherwise create a follow-up commit.

---

## Task 8: Playwright E2E for chain-adjacent

**Files:**
- Create: `src/frontend/tests/net-chain-adjacent.spec.ts`

- [ ] **Step 1: Write the E2E test**

Create `src/frontend/tests/net-chain-adjacent.spec.ts`:

```ts
import { test, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test.describe('chain-adjacent net mode', () => {
  test('cycle: off → star → chain → chain-adjacent → off via toolbar', async ({ page }) => {
    await page.goto('/');
    // Drag-drop a known-good BVR sample.
    const sampleAbs = path.resolve(__dirname, '../../../samples/820-02016.bvr');
    if (!fs.existsSync(sampleAbs)) test.skip();
    const buf = fs.readFileSync(sampleAbs);
    await page.evaluate(async ({ data, name }) => {
      const file = new File([new Uint8Array(data)], name, { type: 'application/octet-stream' });
      const dt = new DataTransfer();
      dt.items.add(file);
      const target = document.body;
      const ev = new DragEvent('drop', { bubbles: true, dataTransfer: dt });
      target.dispatchEvent(ev);
    }, { data: Array.from(buf), name: '820-02016.bvr' });

    // Wait for the board to load.
    await page.waitForSelector('canvas');
    await page.waitForFunction(() => {
      const w = window as any;
      return w.__boardStore?.activeTab?.board?.parts?.length > 0;
    }, { timeout: 10_000 });

    // Read mode through window-exposed store across cycles.
    const readMode = () => page.evaluate(() => (window as any).__boardStore.netLineMode);
    const cycle = () => page.evaluate(() => (window as any).__boardStore.cycleNetLineMode());

    expect(await readMode()).toBe('off');
    await cycle(); expect(await readMode()).toBe('star');
    await cycle(); expect(await readMode()).toBe('chain');
    await cycle(); expect(await readMode()).toBe('chain-adjacent');
    await cycle(); expect(await readMode()).toBe('off');
  });

  test('chain-adjacent populates adjacentNets when a 2-pin chain exists', async ({ page }) => {
    await page.goto('/');
    // Use an in-memory synthetic board to avoid sample-file dependency.
    await page.evaluate(async () => {
      const w = window as any;
      const { buildNets } = await import('/src/parsers/types.ts');
      const parts = [
        {
          name: 'U1', side: 'top', type: 'smd',
          origin: { x: 0, y: 0 },
          pins: [{ name: '1', number: '1', position: { x: 0, y: 0 }, radius: 5, side: 'top', net: 'VSENSE' }],
          bounds: { minX: -5, minY: -5, maxX: 5, maxY: 5 },
        },
        {
          name: 'R12', side: 'top', type: 'smd',
          origin: { x: 50, y: 0 },
          pins: [
            { name: '1', number: '1', position: { x: 40, y: 0 }, radius: 5, side: 'top', net: 'VSENSE' },
            { name: '2', number: '2', position: { x: 60, y: 0 }, radius: 5, side: 'top', net: 'VCC' },
          ],
          bounds: { minX: 40, minY: -5, maxX: 60, maxY: 5 },
        },
      ];
      const board = {
        format: 'TEST', outline: [], parts, nails: [], nets: buildNets(parts),
        bounds: { minX: -10, minY: -10, maxX: 70, maxY: 10 },
      };
      w.__boardStore.openBoardFromMemory?.('synth.bvr', board) ?? w.__boardStore.openBoardFromData?.('synth.bvr', board);
    });

    // Set chain-adjacent mode and select VSENSE.
    await page.evaluate(() => {
      const s = (window as any).__boardStore;
      while (s.netLineMode !== 'chain-adjacent') s.cycleNetLineMode();
      s.highlightNet('VSENSE');
    });

    const adj = await page.evaluate(() => {
      const tab = (window as any).__boardStore.activeTab;
      return [...(tab?.selection?.adjacentNets ?? [])];
    });
    expect(adj.sort()).toEqual(['VCC']);
  });

  test('chain-adjacent leaves adjacentNets empty when anchor is GND', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(async () => {
      const w = window as any;
      const { buildNets } = await import('/src/parsers/types.ts');
      const parts = [
        {
          name: 'R5', side: 'top', type: 'smd', origin: { x: 0, y: 0 },
          pins: [
            { name: '1', number: '1', position: { x: -10, y: 0 }, radius: 5, side: 'top', net: 'RAIL' },
            { name: '2', number: '2', position: { x: 10, y: 0 }, radius: 5, side: 'top', net: 'GND' },
          ],
          bounds: { minX: -15, minY: -5, maxX: 15, maxY: 5 },
        },
      ];
      const board = {
        format: 'TEST', outline: [], parts, nails: [], nets: buildNets(parts),
        bounds: { minX: -20, minY: -10, maxX: 20, maxY: 10 },
      };
      w.__boardStore.openBoardFromMemory?.('synth-gnd.bvr', board) ?? w.__boardStore.openBoardFromData?.('synth-gnd.bvr', board);
    });

    await page.evaluate(() => {
      const s = (window as any).__boardStore;
      while (s.netLineMode !== 'chain-adjacent') s.cycleNetLineMode();
      s.highlightNet('GND');
    });

    const adj = await page.evaluate(() =>
      [...((window as any).__boardStore.activeTab?.selection?.adjacentNets ?? [])]
    );
    expect(adj).toEqual([]);
  });
});
```

- [ ] **Step 2: Verify a test entrypoint exists for synthetic boards**

The test calls `__boardStore.openBoardFromMemory` or `openBoardFromData`. Check whether the store already exposes a method that takes an in-memory `BoardData`:

```bash
cd src/frontend && grep -n "openBoardFromMemory\|openBoardFromData\|loadBoardData\b" src/store/board-store.ts
```

If none exists, two options:

- **Option A (preferred — minimal change):** add a public method on `BoardStore` for tests:
  ```ts
  /** Open a tab from an in-memory BoardData (test/dev helper). */
  openBoardFromData(fileName: string, board: BoardData) {
    const id = ++this._nextTabId;
    const tab: BoardTab = {
      ...this._defaultTabFields(),  // or inline whatever the existing tab-creation path does
      id, fileName, board, cacheKey: '',
    };
    this._tabs.push(tab);
    this._activeTabId = id;
    this.notify();
  }
  ```
  Find an existing tab-creation path (likely inside the file-drop handler) and copy its initialisation pattern verbatim — this method is a thin shortcut that skips parsing.

- **Option B:** rewrite the synthetic tests to drag-drop a tiny generated `.bvr` file via `DataTransfer`. More code per test but no store API addition.

Pick Option A unless the existing store layer makes inserting a tab via API messy.

- [ ] **Step 3: Run the new spec**

Run: `cd src/frontend && npx playwright test net-chain-adjacent.spec.ts --reporter=line`
Expected: 3 PASSED (one cycles modes; two verify the adjacent set on synthetic boards).

- [ ] **Step 4: Run the broader smoke set to confirm no regressions**

Run: `cd src/frontend && npx playwright test ci-smoke.spec.ts boardripper.spec.ts net-classification.spec.ts net-chain-adjacent.spec.ts --reporter=line`
Expected: all PASSED.

- [ ] **Step 5: Commit**

```bash
git add src/frontend/tests/net-chain-adjacent.spec.ts src/frontend/src/store/board-store.ts
git commit -m "$(cat <<'EOF'
test(net-adjacent): playwright e2e for cycle and adjacency

Three specs: full mode-cycle from off through chain-adjacent and back;
adjacentNets populates correctly on a VSENSE→R12→VCC pull-up; empty
when anchor is GND. Adds openBoardFromData store helper for in-memory
synthetic boards in tests (skips parsing).
EOF
)"
```

---

## Self-Review

- ✅ Spec coverage:
  - Mode shape — Task 3
  - Net classification predicates — Task 1
  - `computeAdjacentNets` algorithm — Task 2
  - `SelectionState` extension — Task 4
  - Wire `highlightNet` / `cycleNetLineMode` — Task 5
  - `adjacentNetLineColor` knob — Task 6
  - Renderer chain-line draw — Task 7A
  - Renderer dim filter + per-pin glow + ghost gathering across active set — Task 7B
  - Manual visual verification — Task 7C
  - Playwright E2E — Task 8
  - Hover does not trigger — inherited from existing `hoverNet` separation; documented in spec, no code change needed
  - Persistence — covered by Task 3 sanitize step (no separate `adjacentNets` persistence by design)
- ✅ Type consistency: `computeAdjacentNets(board, net, depth) → Set<string>`, `adjacentNets: Set<string>`, `adjacentNetLineColor: number` — names match across tasks.
- ✅ Trace + via highlight: spec leaves them implicit; plan explicitly scopes them to the primary net (Task 7B) to match the design's "avoid visual blow-up" intent. Mention this back to the user if the choice is wrong.
