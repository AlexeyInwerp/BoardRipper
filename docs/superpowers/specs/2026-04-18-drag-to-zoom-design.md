# Drag-to-Zoom — Design

**Date:** 2026-04-18
**Status:** Draft — awaiting user review
**Scope:** BoardViewer only. Additive; no existing behavior changes at the default setting.

## Problem

Left-click drag on the BoardViewer currently pans via pixi-viewport's `.drag()` plugin. Trackpad users already pan with two-finger scroll, so left-drag duplicates that gesture and adds no capability. Scroll-wheel/pinch already zoom — fine for small adjustments — but there is no direct-manipulation gesture to zoom over a wide range with a single continuous motion. PCB inspection workflows want that: click a chip, drag up to zoom in on it.

## Goals

1. Add drag-to-zoom as an alternate navigation gesture in BoardViewer.
2. Let the user choose whether left-drag or Shift + left-drag triggers it (mirroring the scroll-bindings architecture).
3. Default exactly matches today's behavior — no regression for existing users.
4. Keep pixi-viewport as the pan authority; do not reconfigure its drag plugin at runtime.

## Non-Goals

- PDF panel: not in scope. Its gesture system is separate and it already supports pan+zoom via its own handlers.
- Box-zoom (drag a rectangle, zoom to fit). Different mental model; can be added later as its own mode.
- A quick-toggle toolbar button. Settings-only surface for now, same decision we made initially for the scroll-mode toggle. If it proves useful, adding a button later follows the exact pattern we already established.
- Multi-button customization (right-drag, middle-drag). Only left button is bound.

## Design

### Single source of truth

New field in `RenderSettings` ([`src/frontend/src/store/render-settings.ts`](../../../src/frontend/src/store/render-settings.ts)):

```ts
/** When true, bare left-drag zooms (vertical delta) and Shift+left-drag pans.
 *  When false (default), bare left-drag pans via pixi-viewport and Shift+left-drag zooms. */
dragToZoom: boolean;
```

Default in `DEFAULTS`: `dragToZoom: false` — current behavior.

| `dragToZoom` | Bare left-drag | Shift + left-drag |
|---|---|---|
| `false` (default) | pan (pixi-viewport) | zoom (our handler) |
| `true` | zoom (our handler) | pan (pixi-viewport) |

### Input handling — BoardRenderer capture-phase handler

Install a capture-phase `pointerdown` listener on `containerEl`, analogous to the existing `installShiftWheelHandler` pattern:

1. Listen only for primary-button (`e.button === 0`) pointer events.
2. At pointerdown, resolve the drag action **once** from `renderSettingsStore.settings.dragToZoom` and `e.shiftKey`. Pressing or releasing Shift mid-drag does **not** change the active action — matches the scroll-bindings model (Shift+wheel resolves at event time, not continuously). Resolution:
   - `dragToZoom === e.shiftKey` → action = `pan`
   - `dragToZoom !== e.shiftKey` → action = `zoom`
3. **Pan branch:** return without `preventDefault` / `stopPropagation`. pixi-viewport's bubble-phase handler sees the event and pans normally. Existing behavior untouched.
4. **Zoom branch:** the handler takes over. Capture the pointer, record anchor, install `pointermove` / `pointerup` listeners, set cursor, run the zoom loop until release.

### Zoom gesture — vertical-delta, anchored

Mirror the math already used in `installShiftWheelHandler` so the feel is consistent with Shift+wheel:

```ts
// State captured at pointerdown (zoom branch)
const pointerDownX = e.clientX - containerRect.left;
const pointerDownY = e.clientY - containerRect.top;
const initialScale = viewport.scale.x;
const anchorWorld = viewport.toWorld(pointerDownX, pointerDownY);

// On each pointermove
const dy = e.clientY - startClientY; // positive = dragged down = zoom out
const factor = Math.pow(2, -dy / 200);
const newScale = clamp(initialScale * factor, 0.001, 10);
viewport.scale.set(newScale);
// Re-anchor: the world point clicked stays under the pointer
const anchorScreenNow = viewport.toScreen(anchorWorld.x, anchorWorld.y);
viewport.x += pointerDownX - anchorScreenNow.x;
viewport.y += pointerDownY - anchorScreenNow.y;
viewport.emit('moved', { viewport, type: 'drag-zoom' });
```

Sensitivity: `200 px / 2×` (200 px upward = 2× zoom in; 200 px down = 0.5× zoom out). Same ceiling/floor bounds as pixi-viewport's `clampZoom`.

### Click vs. drag threshold

Without guard: a single click + release accidentally triggers a zero-distance zoom-drag loop. Gate with a 3-pixel threshold before the zoom logic runs:

- Track `didExceedThreshold: boolean`, initially `false`.
- On pointermove, if not yet exceeded, check `|dx| + |dy| >= 3`. Once true, commit to drag mode.
- If the pointer comes up before the threshold is crossed, treat it as a click — fall through to the existing selection path (which is on pointerup / click, not our concern).

Because we `preventDefault` only once we've committed to zoom, pixi-viewport still sees a sub-threshold pointerdown+pointerup as a click and does not start a drag either. Single-click selection is preserved.

### Cursor feedback

- At pointerdown (zoom branch, after threshold crossed): `containerEl.style.cursor = 'zoom-in'`.
- If `dy > 0` (zooming out): `'zoom-out'`.
- On pointerup (or pointercancel): restore to previous cursor (or clear — pixi-viewport will set its own on next interaction).

Pan branch is unchanged — pixi-viewport sets `grab` / `grabbing` as it does today.

### Settings UI

New `BoardDragBindingsEditor` component in [`src/frontend/src/panels/SettingsPanel.tsx`](../../../src/frontend/src/panels/SettingsPanel.tsx). Copy of `BoardScrollBindingsEditor` at line 760 with:

- Modifier keys: `['bare', 'shift'] as const` — labels `"Left-drag"` and `"Shift + Left-drag"`.
- Actions: `['pan', 'zoom']` with the same colors used by the scroll editor.
- Drop handler writes `updateDraft({ dragToZoom: targetSlot === 'bare' && action === 'zoom' })`.

Placement: inside the existing "Scroll wheel behavior" `CollapsibleSection` (Navigation group), under a new `settings-subsection-label` of `"Mouse drag behavior"`. Rendered immediately after `BoardScrollBindingsEditor` and its `wheelDetection` toggle (so the whole input-binding UI reads top-to-bottom as one stack).

### Reactivity

- BoardRenderer subscribes to `renderSettingsStore` already. Its capture-phase pointerdown handler reads `renderSettingsStore.settings.dragToZoom` + `e.shiftKey` **at pointerdown time** (fresh lookup per gesture, no need for memoization).
- No React hook needed in BoardRenderer — the handler is class-scoped.
- `onSettingsUpdate` fast-path: add `dragToZoom` to the `INTERACTION_ONLY` allowlist introduced in [`commit 4fe1cee`](../../../src/frontend/src/renderer/BoardRenderer.ts#L2030) so toggling this field never triggers a scene rebuild.

### What explicitly does not change

- `twoFingerPan`, scroll bindings, `wheelDetection`, `installShiftWheelHandler` — untouched.
- pixi-viewport's `.drag({ wheel: twoFingerPan })` plugin config is not reconfigured at runtime. The plugin runs in bubble phase and sees only the events our capture handler declined to consume (i.e. pan drags), which is exactly the same set of events it sees today when no modifier is held.
- Part/pin selection on click-release — untouched (sub-threshold pointerdown + pointerup is treated as a click by both our handler and pixi-viewport).
- Right-click context menu, double-click zoom-to-fit — untouched.
- Trackpad two-finger pan is **not** affected. Trackpad 2-finger produces `wheel` events, not pointerdown+drag. Our new handler listens to pointerdown only.

## Testing

1. **Default behavior unchanged:** fresh install (`dragToZoom` unset → falls back to `false`). Bare left-drag pans. Shift + left-drag zooms (anchored). Click-release selects parts.
2. **Toggle via Settings:** swap pills so `bare=zoom`. Bare left-drag zooms; shift + left-drag pans.
3. **Sub-threshold click:** press + release within 3 px, in both modes. Click selection still fires. No zoom jitter.
4. **Cursor feedback:** during zoom-drag, cursor is `zoom-in` (dy < 0) or `zoom-out` (dy > 0). Pan-drag cursor unchanged (grab/grabbing).
5. **Scene rebuild:** toggle the setting while a large board is open — no multi-second freeze (fast path catches `dragToZoom` as interaction-only).
6. **Middle / right button:** middle-button drag and right-button drag behave exactly as today (right = context menu, middle = nothing special). Our handler only engages on `e.button === 0`.

## Rollout

Single small PR. No migration. If the feature proves redundant, revert is localized: one new setting field, one new settings editor component, one new BoardRenderer handler method. The `INTERACTION_ONLY` allowlist entry is a one-word addition.

## Open questions

None outstanding. Ready to plan implementation.
