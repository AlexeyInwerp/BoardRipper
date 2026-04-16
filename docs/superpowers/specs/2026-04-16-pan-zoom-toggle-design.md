# Pan/Zoom Quick-Toggle — Design

**Date:** 2026-04-16
**Status:** Draft — awaiting user review
**Scope:** Small, additive UI change. No refactors. The existing Settings-panel binding editor is left untouched.

## Problem

BoardViewer and PDF viewer have **opposite defaults** for what bare scroll does:

- BoardViewer ([render-settings.ts:268](../../../src/frontend/src/store/render-settings.ts#L268)): `twoFingerPan: true` → bare scroll = **pan**, Shift+scroll = zoom
- PDF ([PdfViewerPanel.tsx:53](../../../src/frontend/src/panels/PdfViewerPanel.tsx#L53)): `DEFAULT_SCROLL_BINDINGS = { bare: 'zoom', shift: 'pan', meta: 'switch' }` → bare scroll = **zoom**

The only way to change either is to open Settings. That is too far for a setting users sometimes flip multiple times per session (e.g. reviewing a schematic on a mouse, then switching to a trackpad).

## Goals

1. Make the two viewers' defaults consistent.
2. Give the user a **one-click toggle** in both the BoardViewer toolbar and the PDF toolbar that flips between "scroll = pan" and "scroll = zoom".
3. Do not disturb the existing Settings editor or the PDF's 3-slot binding model — advanced users can still configure `switch` placement etc. there.
4. Keep the change small enough that the button can be removed or relocated later without disruption.

## Non-Goals

- Changing the Settings-panel `BoardScrollBindingsEditor` ([SettingsPanel.tsx:760](../../../src/frontend/src/panels/SettingsPanel.tsx#L760)) or the 3-slot PDF binding UI.
- Unifying the two storage mechanisms (`twoFingerPan` in render-settings vs. `boardripper-pdf-scroll-bindings` localStorage key). Two stores remain, the toggle writes to both.
- New keyboard shortcut (can be added later).

## Design

### Single source of "mode"

Two canonical pairs, represented by one boolean:

| Mode | BoardViewer (`twoFingerPan`) | PDF `ScrollBindings` |
|---|---|---|
| **Pan mode** | `true` → bare=pan, shift=zoom | `{ bare: 'pan', shift: 'zoom', meta: 'switch' }` |
| **Zoom mode** | `false` → bare=zoom, shift=pan | `{ bare: 'zoom', shift: 'pan', meta: 'switch' }` |

PDF's `meta` slot stays `'switch'` in both pairs. If a user has customized `meta` elsewhere, this button leaves `meta` alone and only rewrites `bare`/`shift`.

### Default alignment

Change PDF's `DEFAULT_SCROLL_BINDINGS` from `{ bare: 'zoom', shift: 'pan', meta: 'switch' }` to **`{ bare: 'pan', shift: 'zoom', meta: 'switch' }`** so a fresh install starts with both viewers in pan mode. This is a one-line change and only affects users who have never customized PDF bindings (i.e. their `loadScrollBindings()` returns the default). Existing customized installs are untouched.

Rationale for picking pan-on-bare as the shared default: matches the existing BoardViewer default (no regression for current board users), trackpad-friendly, and is the primary laptop use case for BoardRipper.

### The toggle button

**Shared helper** in `store/render-settings.ts` (or a small sibling file `store/scroll-mode.ts`):

```ts
// Effective "mode" read from the two existing stores
export function getScrollMode(): 'pan' | 'zoom' {
  // Board is authoritative for read — single boolean, no ambiguity
  return renderSettingsStore.globalSettings.twoFingerPan ? 'pan' : 'zoom';
}

// Flip both stores to the canonical pair
export function toggleScrollMode() {
  const cur = renderSettingsStore.globalSnapshot();
  const next: 'pan' | 'zoom' = cur.twoFingerPan ? 'zoom' : 'pan';

  // 1. Board side — full settings object required by applyGlobal
  renderSettingsStore.applyGlobal({ ...cur, twoFingerPan: next === 'pan' });

  // 2. PDF side — preserve meta, rewrite bare/shift
  const bindings = loadScrollBindings();
  const newBindings: ScrollBindings = {
    ...bindings,
    bare: next,
    shift: next === 'pan' ? 'zoom' : 'pan',
  };
  localStorage.setItem(SCROLL_BINDINGS_KEY, JSON.stringify(newBindings));
  window.dispatchEvent(new CustomEvent('pdf-scroll-bindings-changed', { detail: newBindings }));
}
```

Implementation note: the store exposes `applyGlobal(full)` not a partial updater, so we take a `globalSnapshot()` and spread it. This is the same pattern the Settings panel already uses when committing draft settings.

- Read side is deliberately simple: the button reflects `twoFingerPan`. If a user has manually set PDF `bare='zoom'` while board is in pan mode, the button shows "pan" (board state). This is acceptable because the button's job is to flip to the opposite canonical pair; it is not an indicator of PDF-specific state.
- Write side updates both stores atomically so the two viewers stay in sync after a click.

### Button UI

**Two-state icon, icon-only, tooltip carries the explanation** (matches the existing toolbar rhythm — no visible text, the surrounding buttons are icon-only too).

| State | Icon | Tooltip |
|---|---|---|
| Pan mode active | `IconHandMove` from `@tabler/icons-react` | `"Scroll: Pan · Shift+Scroll: Zoom — click to switch to Zoom"` |
| Zoom mode active | `IconZoomIn` from `@tabler/icons-react` | `"Scroll: Zoom · Shift+Scroll: Pan — click to switch to Pan"` |

The button is **not** rendered as `active`/highlighted — it is a mode indicator, both states are equally valid.

### Placements

Both viewers get the button wired to the same `toggleScrollMode()`. Both re-render when the state changes (BoardViewer already subscribes to render-settings; PDF already listens to `pdf-scroll-bindings-changed`).

**BoardViewer** — inside the existing `board-status-indicators` row ([BoardViewerPanel.tsx:203-255](../../../src/frontend/src/panels/BoardViewerPanel.tsx#L203-L255)), **immediately after the `IconObjectScan` fit-to-board button**:

```tsx
<button
  className="board-netlines-toggle"
  onClick={toggleScrollMode}
  title={...}
>
  {scrollMode === 'pan' ? <IconHandMove size={16} /> : <IconZoomIn size={16} />}
</button>
```

Reusing the `board-netlines-toggle` CSS class keeps it visually uniform with its neighbors (size, padding, hover state).

**PDF** — inside `pdf-toolbar` ([PdfViewerPanel.tsx:2792-2799](../../../src/frontend/src/panels/PdfViewerPanel.tsx#L2792-L2799)), **immediately left of the `pdf-zoom-group` fit-to-width button**:

```tsx
<button
  className="pdf-toolbar-btn"
  onClick={toggleScrollMode}
  title={...}
>
  {scrollMode === 'pan' ? <IconHandMove size={14} /> : <IconZoomIn size={14} />}
</button>
```

14px icon to match the other `pdf-toolbar-btn` buttons.

### Reactivity

- BoardViewer reads `twoFingerPan` via the existing render-settings subscription — no new hook needed.
- PDF already listens to `pdf-scroll-bindings-changed`. The button reads state via a small `useSyncExternalStore`-based hook over the same event, or by polling `loadScrollBindings()` on toolbar mount plus re-rendering on the event. Simplest: a tiny `useScrollMode()` hook that returns `'pan' | 'zoom'` derived from `twoFingerPan`.

## Testing

1. **Playwright**: open a board and a PDF side-by-side, click the PDF toggle, verify the board toolbar icon also flips; verify actual scroll wheel behavior changes in both.
2. **Manual**: customize PDF bindings in Settings (e.g. put `switch` on `shift`); confirm the toggle preserves `meta` but rewrites `bare`/`shift`.
3. **Fresh install**: clear localStorage, reload; both viewers start in pan mode; scroll wheel pans in both.

## Rollout

Single small PR. No migration, no version gate. If the button proves redundant, removing it is a straightforward revert of these specific files — the underlying stores stay intact.

## Open questions

None outstanding. Ready to plan implementation.
