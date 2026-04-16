# Pan/Zoom Quick-Toggle — Design

**Date:** 2026-04-16
**Status:** Draft — awaiting user review
**Scope:** Small, additive UI change. No refactors. The existing 3-slot binding editor in Settings is left untouched; a single new checkbox ("Mouse wheel detection") is added adjacent to it in the same subsection.

## Problem

BoardViewer and PDF viewer have **opposite defaults** for what bare scroll does:

- BoardViewer ([render-settings.ts:268](../../../src/frontend/src/store/render-settings.ts#L268)): `twoFingerPan: true` → bare scroll = **pan**, Shift+scroll = zoom
- PDF ([PdfViewerPanel.tsx:53](../../../src/frontend/src/panels/PdfViewerPanel.tsx#L53)): `DEFAULT_SCROLL_BINDINGS = { bare: 'zoom', shift: 'pan', meta: 'switch' }` → bare scroll = **zoom**

The only way to change either is to open Settings. That is too far for a setting users sometimes flip multiple times per session — e.g. a laptop trackpad with a broken pinch gesture is suddenly unusable for zoom and the user wants scroll-to-zoom *now*.

## Goals

1. Make the two viewers' **defaults** consistent.
2. Give the user a **one-click inverter** in both the BoardViewer toolbar and the PDF toolbar that swaps the bare and shift slots in place.
3. Do not disturb the existing Settings editor or the PDF's 3-slot binding model — the editor stays the source of truth for the *shape* of the binding; the button only *inverts* what is configured.
4. Keep the change small enough that the button can be removed or relocated later without disruption.

## Non-Goals

- Changing the `BoardScrollBindingsEditor` ([SettingsPanel.tsx:760](../../../src/frontend/src/panels/SettingsPanel.tsx#L760)) or the 3-slot PDF binding UI itself. One sibling checkbox row is added in the same subsection for the wheel-detection toggle — no edits to the existing editor component.
- Unifying the two storage mechanisms (`twoFingerPan` in render-settings vs. `boardripper-pdf-scroll-bindings` localStorage key). Two stores remain; the button writes to both.
- New keyboard shortcut (can be added later).
- Introducing a "canonical pair" concept. The button is an **inverter**, not a preset.
- Per-event device profiling beyond a conservative "looks like a classic mouse wheel" heuristic (see Safety net below).

## Design

### Button semantics — inverter, not setter

The button does one thing: **swap `bare` ↔ `shift`**.

- BoardViewer: `twoFingerPan` is a two-state boolean; toggling it *is* a bare↔shift swap in the board's world.
- PDF: `bare` and `shift` slots in `ScrollBindings` are exchanged; `meta` is **never touched** by the button, preserving user customization (e.g. `meta: 'switch'` or any alternate assignment the user configured in Settings).

If a user has set up an unusual binding like `{ bare: 'switch', shift: 'pan', meta: 'zoom' }`, clicking the button yields `{ bare: 'pan', shift: 'switch', meta: 'zoom' }`. The settings editor remains the right tool for reshaping the binding; the button only flips what is currently on `bare` with what is currently on `shift`.

The swap is persisted (written back to render-settings / localStorage), not transient. Next session starts from the last-inverted state, consistent with "this is just another way to edit the setting".

**Note on edge-case divergence:** if a user has configured PDF `bare='switch'` via the Settings editor, a single click swaps PDF `bare`↔`shift` (producing e.g. `bare='pan', shift='switch'`) while simultaneously toggling board `twoFingerPan`. The two stores can end up describing different things because they started from different shapes. This is accepted: the button serves the common pan↔zoom use case, and the Settings editor is the right place to reshape exotic bindings.

### Default alignment

Change PDF's `DEFAULT_SCROLL_BINDINGS` from `{ bare: 'zoom', shift: 'pan', meta: 'switch' }` to **`{ bare: 'pan', shift: 'zoom', meta: 'switch' }`** so a fresh install starts with both viewers in pan-on-bare. One-line change, only affects users who have never customized PDF bindings. Existing customized installs are untouched because `loadScrollBindings()` reads from localStorage first.

Rationale for picking pan-on-bare as the shared default: matches the existing BoardViewer default (no regression for current board users), trackpad-friendly, and is the primary laptop use case for BoardRipper.

### The toggle helper

**Shared helper** lives in a new small file `store/scroll-mode.ts` to keep render-settings free of PDF concerns:

```ts
import { renderSettingsStore } from './render-settings';
import {
  loadScrollBindings,
  SCROLL_BINDINGS_KEY,
  type ScrollBindings,
} from '../panels/PdfViewerPanel';

/**
 * Current "bare" scroll action. Derived from board `twoFingerPan` — board is
 * authoritative for the icon state because it only has two possible values
 * (pan | zoom) while PDF can also have `switch` on bare (edge case, handled
 * by the button tooltip but not the icon).
 */
export function getBareScrollAction(): 'pan' | 'zoom' {
  return renderSettingsStore.globalSettings.twoFingerPan ? 'pan' : 'zoom';
}

/** Swap bare and shift in BOTH stores. Preserves meta on the PDF side. */
export function invertScrollBindings() {
  // 1. Board side — boolean toggle is the swap.
  const cur = renderSettingsStore.globalSnapshot();
  renderSettingsStore.applyGlobal({ ...cur, twoFingerPan: !cur.twoFingerPan });

  // 2. PDF side — literal bare↔shift swap. meta untouched.
  const b = loadScrollBindings();
  const next: ScrollBindings = { bare: b.shift, shift: b.bare, meta: b.meta };
  localStorage.setItem(SCROLL_BINDINGS_KEY, JSON.stringify(next));
  window.dispatchEvent(new CustomEvent('pdf-scroll-bindings-changed', { detail: next }));
}
```

Implementation notes:
- `applyGlobal(full)` is the real mutator on `RenderSettingsStore`; there is no partial updater, so we snapshot-and-spread. Same pattern as the Settings panel draft-commit.
- Read side uses `twoFingerPan` only. This is intentional: the button's icon is a one-bit indicator, and the board cannot hold `switch` on bare. If a PDF power user has `bare='switch'` configured, the icon still reflects board state; the tooltip clarifies.

### Button UI

**Two-state icon, icon-only, tooltip carries the explanation** (matches the existing toolbar rhythm — the surrounding buttons are icon-only too).

| `twoFingerPan` | Icon | Tooltip |
|---|---|---|
| `true` (bare = pan) | `IconHandMove` | `"Scroll: Pan · Shift+Scroll: Zoom — click to swap"` |
| `false` (bare = zoom) | `IconZoomIn` | `"Scroll: Zoom · Shift+Scroll: Pan — click to swap"` |

The button is **not** rendered as `active`/highlighted — both states are equally valid, it is an indicator + inverter, not a mode-on/mode-off affordance.

### Placements

Both viewers render the same button wired to `invertScrollBindings()`. Both re-render when state changes (BoardViewer subscribes to render-settings; PDF listens to `pdf-scroll-bindings-changed`; both events fire on each click).

**BoardViewer** — inside the existing `board-status-indicators` row ([BoardViewerPanel.tsx:203-255](../../../src/frontend/src/panels/BoardViewerPanel.tsx#L203-L255)), **immediately after the `IconObjectScan` fit-to-board button**:

```tsx
<button
  className="board-netlines-toggle"
  onClick={invertScrollBindings}
  title={tooltip}
>
  {bareAction === 'pan' ? <IconHandMove size={16} /> : <IconZoomIn size={16} />}
</button>
```

Reusing the `board-netlines-toggle` class keeps it visually uniform with its neighbors.

**PDF** — inside `pdf-toolbar` ([PdfViewerPanel.tsx:2792-2799](../../../src/frontend/src/panels/PdfViewerPanel.tsx#L2792-L2799)), **immediately left of the `pdf-zoom-group` fit-to-width button**:

```tsx
<button
  className="pdf-toolbar-btn"
  onClick={invertScrollBindings}
  title={tooltip}
>
  {bareAction === 'pan' ? <IconHandMove size={14} /> : <IconZoomIn size={14} />}
</button>
```

14px icon to match the other `pdf-toolbar-btn` buttons.

### Safety net for mouse-wheel events

Pan-on-bare on a physical mouse wheel produces jerky 100px-per-notch pan jumps — the "looks and acts very dumb" case. To prevent it without weakening the explicit toggle, a narrow per-event heuristic can override pan→zoom only for events that unmistakably look like a classic mouse wheel.

**New setting:** `wheelDetection: boolean` added to `RenderSettings` in [render-settings.ts](../../../src/frontend/src/store/render-settings.ts). Default: `true`. Persisted with the rest of render-settings.

**Heuristic (single utility function):**

```ts
// Returns true if the event has the signature of a classic mouse wheel —
// large, integer, single-axis, no pinch modifier. Fine-grained scroll wheels
// (Logitech MX, Magic Mouse) and trackpad two-finger gestures do NOT match.
export function looksLikeMouseWheel(e: WheelEvent): boolean {
  return (
    !e.ctrlKey &&
    e.deltaX === 0 &&
    Math.abs(e.deltaY) >= 50 &&
    Number.isInteger(e.deltaY)
  );
}
```

**Application rule** (in both wheel handlers):
- If `wheelDetection === false` → never override, honor the configured binding exactly.
- If `wheelDetection === true` and the resolved action is `pan` and `looksLikeMouseWheel(e)` → treat this single event as `zoom` instead.
- Zoom mode is never overridden. Trackpad pinch (`ctrlKey=true`) is never overridden (the existing hard-coded pinch-always-zooms rule in PDF stays as-is).
- The override does not write anything back to settings; it only reinterprets a single event.

**Where the hook lives:**
- **PDF**: inside the existing `handleWheel` in [PdfViewerPanel.tsx:2067](../../../src/frontend/src/panels/PdfViewerPanel.tsx#L2067), after `action` is resolved from bindings. If the safety net fires, substitute `'zoom'` for the switch branch.
- **BoardViewer**: pixi-viewport's `.drag({ wheel: true })` + `.wheel()` plugins handle the wheel event internally. The existing `installShiftWheelHandler` in [BoardRenderer](../../../src/frontend/src/renderer/BoardRenderer.ts#L1980) pattern (capture-phase interceptor) is extended: when `twoFingerPan && wheelDetection && looksLikeMouseWheel(e)`, the interceptor swallows the event and forwards it to pixi-viewport's zoom handler directly, or applies zoom manually via `viewport.zoomPercent`. Concrete wiring is an implementation detail for the plan phase.

**Settings-panel checkbox** — sibling row inside the existing "Scroll wheel behavior" subsection ([SettingsPanel.tsx:1239-1241](../../../src/frontend/src/panels/SettingsPanel.tsx#L1239-L1241)):

```tsx
<div className="settings-subsection-label">Scroll wheel behavior</div>
<p className="settings-hint">Drag pills between slots to reassign scroll actions.</p>
<BoardScrollBindingsEditor twoFingerPan={draft.twoFingerPan} onUpdate={updateDraft} />
<Toggle
  label="Mouse wheel detection"
  value={draft.wheelDetection}
  field="wheelDetection"
  onUpdate={updateDraft}
  title="When scroll is set to pan, override mouse-wheel events to zoom instead. Avoids jerky single-axis pan with a physical scroll wheel. Trackpads and fine-grained wheels are unaffected."
/>
```

Uses the existing `Toggle` component — no new UI primitives.

### Reactivity

- BoardViewer already reads render-settings through its existing subscription — no new wiring needed beyond consuming `twoFingerPan`.
- A tiny `useBareScrollAction()` hook wraps the two reactivity sources into one React value:
  - Subscribe to the render-settings store (for `twoFingerPan` changes made from anywhere: button, Settings panel, board).
  - Since board is authoritative for read, one subscription is sufficient. The `pdf-scroll-bindings-changed` event is fired by the inverter for PDF's own listeners (`PdfViewerPanel`) — the button itself doesn't need it.

## Testing

1. **Playwright**: open a board and a PDF side-by-side, click the PDF button, verify (a) the board toolbar icon also flips, (b) scroll wheel on the board switches behavior, (c) scroll wheel on the PDF switches behavior.
2. **Manual (preservation)**: in Settings, configure PDF bindings to `{ bare: 'pan', shift: 'switch', meta: 'zoom' }`. Click the button. Expect `{ bare: 'switch', shift: 'pan', meta: 'zoom' }` — `meta` untouched.
3. **Fresh install**: clear `localStorage` + render-settings store, reload; both viewers start in pan-on-bare; single click on either button flips both to zoom-on-bare.
4. **Settings-editor coexistence**: change binding via Settings editor → button icon updates. Click button → Settings editor shows swapped values if reopened.
5. **Wheel detection ON (default)**: pan mode + a synthesized wheel event with `deltaY: 100, deltaX: 0` → zooms (override fires). Pan mode + `deltaY: 8.3, deltaX: 2` → pans (override skipped, trackpad-like).
6. **Wheel detection OFF**: uncheck the setting. Pan mode + `deltaY: 100, deltaX: 0` → pans (override disabled, user's explicit choice honored).
7. **Trackpad pinch**: event with `ctrlKey: true` → always zooms regardless of mode or detection setting (existing hard rule, unchanged).

## Rollout

Single small PR. No migration, no version gate. If the button proves redundant, revert of the specific files removes it; the underlying stores and the Settings editor stay intact.

## Open questions

None outstanding. Ready to plan implementation.
