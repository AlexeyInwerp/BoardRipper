# Stacked / overlapping component selection — design

Date: 2026-07-06
Issue: #23 "selectability of stacked components"
Status: approved design, pending implementation plan

## Problem

Some boardviews place multiple components at the same location — alternates
sharing the same pads, a small part sitting on a large connector pad, a
component under a shield. Today only one of them is ever selectable, so the
others cannot be inspected, pinned to a worklist, or looked up.

## Current behavior

`BoardRenderer.hitTest(world)` ([BoardRenderer.ts:4542](../../src/frontend/src/renderer/BoardRenderer.ts#L4542)):

1. **Pin/pad pass** — over candidate parts near the pointer, pick the closest
   pin/pad within threshold; return that part + pin.
2. **Body pass** — return the **first** part (in spatial-hash iteration order,
   effectively arbitrary) whose render bounds contain the point.

When parts overlap, the body pass returns an arbitrary member and the rest are
unreachable by clicking. `handleClick` ([BoardRenderer.ts:4908](../../src/frontend/src/renderer/BoardRenderer.ts#L4908))
consumes the single hit; `handleDblClick` is a separate DOM handler that drives
PDF lookup.

## Design

### 1. Hit-test returns a ranked stack

Introduce `hitTestStack(world): Array<{ partIndex: number; pinIndex: number }>`
that collects **every** part under the point and ranks them **smallest
render-bounds area first** (smallest = most specific = most likely intended).
Ranking applies to both passes:

- **Pin/pad pass:** when several parts share pads at the point, order the hits
  by parent-part area ascending (tie-break by pin distance, as today).
- **Body pass:** order all containing bodies by area ascending.

Area is computed from `computePartRenderBounds(part, s)` (the same bounds the
body pass already uses). Ties fall back to the current spatial-hash order, so
behavior is deterministic and unchanged for non-overlapping parts.

`hitTest()` is redefined as "return `stack[cycleIndex]`" (default index 0), so
every existing caller keeps working; the stack is what the new cycle + menu
logic consumes. The cycle index is reset to 0 by pointer-move handling (see §2),
so the two non-click callers — the hover tooltip ([BoardRenderer.ts:4703](../../src/frontend/src/renderer/BoardRenderer.ts#L4703))
and the double-click PDF lookup — always resolve to the smallest part under the
cursor unless the user is mid-cycle at a stationary point.

Pure geometry only — no dependency on BOM-alternate/ghost cluster data. That
keeps it working on files without cluster detection and avoids coupling.

### 2. Left-click: smallest-wins default + cycle

State on the renderer: `clickCycle = { x, y, side, stackKey, index }`.

- **New spot** (pointer moved beyond a small screen-space tolerance since the
  last click, or the stack membership differs → new `stackKey`): select
  `stack[0]` (smallest) and set `index = 0`.
- **Same spot again:** `index = (index + 1) % stack.length` → select the next
  part, wrapping around.

The common "small part on a big pad/shield" case is fixed by the default alone;
cycling reaches parts fully hidden under larger ones.

**Cycle reset:** the pointer-move handler resets `index = 0` (and clears the
anchor) once the pointer moves beyond the tolerance from the last click point.
Clicking a new area always starts fresh at the smallest part there, and any
hover in between shows the smallest part.

### 3. Double-click stays PDF-lookup — never cycles

A browser double-click fires two viewport `clicked` events (→ two `handleClick`
calls) **before** the DOM `dblclick`. To keep double-click reserved for PDF
lookup:

- The cycle **advance** (the 2nd+ same-spot click) is **deferred** by the OS
  double-click interval and **cancelled** if a `dblclick` arrives first.
- First-click selection of `stack[0]` stays **immediate** (only the advance is
  deferred).

Resulting, intended behavior:

- *Fast* double at one spot → PDF lookup on the currently-selected part, **no
  cycle**. (Hard requirement.)
- Deliberate, spaced single-clicks at one spot → cycle.

### 4. Right-click menu + lookup: one action-row per overlapping part

When the context menu opens over a stack, the `.context-menu-header` "first
line" (name · pin-to-worklist · copy · web-lookup) is **repeated once per
overlapping part**, smallest-first. This lets the user pin *or* look up any
stacked part directly, without cycling.

- The per-part header rows carry the per-part actions (pin/copy/web-lookup),
  each bound to its own refdes.
- The lower action groups (hide / send-to-back / etc.) act on the
  currently-selected part (the one the left-click cycle landed on).
- "Component lookup" follows the same rule: each stacked part exposes its own
  lookup action via its header row; the double-click PDF lookup targets the
  currently-selected part.

The context menu must be told the full stack (list of refdes/partIndex),
smallest-first, instead of a single target.

## Non-goals / YAGNI

- No reuse of ghost/BOM-cluster data — pure geometry covers it.
- No persistent UI, no settings toggle, no "send to back changes pick order"
  (rejected in the issue discussion in favor of smallest-wins + cycle).
- No change to non-overlapping selection behavior.

## Testing

Playwright E2E (`tests/stacked-selection.spec.ts`), using a fixture or a board
known to contain overlapping parts (BOM alternates), plus `__boardStore` DEV
globals:

1. **Smallest-wins default:** clicking a point covered by a large and a small
   part selects the smaller one.
2. **Cycle:** repeated spaced clicks at the same point advance through the stack
   and wrap.
3. **Cycle reset:** moving the pointer and clicking elsewhere starts fresh.
4. **Double-click safety:** a fast double-click at a stacked point does **not**
   advance the cycle and drives PDF lookup on the selected part.
5. **Right-click menu:** opening the menu over a stack renders one header row per
   overlapping part; pinning a non-top part adds *that* refdes to the worklist.

## Files touched

- `src/frontend/src/renderer/BoardRenderer.ts` — `hitTestStack`, `hitTest`
  re-expressed, `handleClick` cycle logic + double-click-deferred advance,
  context-menu open passes the stack.
- `src/frontend/src/components/ContextMenu.tsx` — render one header row per
  stacked part; wire per-part pin/copy/web-lookup.
- Context-menu open plumbing / store that carries the target (single refdes →
  ordered stack).
- `src/frontend/tests/stacked-selection.spec.ts` — new E2E.
