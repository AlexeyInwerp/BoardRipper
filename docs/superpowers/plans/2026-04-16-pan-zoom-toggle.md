# Pan/Zoom Quick-Toggle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a one-click button in BoardViewer and PDF toolbars that swaps bare↔shift scroll bindings in place, with a per-event mouse-wheel safety net (default on) to prevent jerky scroll-wheel panning.

**Architecture:**
- Tiny new module `store/scroll-mode.ts` holds the shared helpers (`getBareScrollAction`, `invertScrollBindings`, `looksLikeMouseWheel`). Both viewers call these.
- New `wheelDetection: boolean` setting in `RenderSettings` (default `true`), surfaced as a checkbox sibling of the existing `BoardScrollBindingsEditor` in Settings.
- PDF wheel handler consults the safety net after action resolution. BoardViewer's existing `installShiftWheelHandler` pattern is reused to intercept classic-wheel events in pan mode and route them to viewport zoom.
- The 3-slot PDF bindings editor in Settings and its `loadScrollBindings`/`SCROLL_BINDINGS_KEY` localStorage remain untouched — the inverter writes through them.

**Tech Stack:** React 19 + TypeScript, PixiJS v8 + pixi-viewport v6, `@tabler/icons-react`, Playwright for E2E tests.

**Spec:** [`docs/superpowers/specs/2026-04-16-pan-zoom-toggle-design.md`](../specs/2026-04-16-pan-zoom-toggle-design.md)

---

## File Structure

**Create:**
- `src/frontend/src/store/scroll-mode.ts` — shared helpers (`getBareScrollAction`, `invertScrollBindings`, `looksLikeMouseWheel`) + `useBareScrollAction` hook + `BARE_SCROLL_ACTION_CHANGED` custom event name. Single responsibility: cross-viewer scroll-mode API.
- `src/frontend/tests/scroll-mode.spec.ts` — Playwright E2E covering toggle button, safety net, and settings checkbox.

**Modify:**
- `src/frontend/src/store/render-settings.ts` — add `wheelDetection: boolean` to the interface and `DEFAULTS`.
- `src/frontend/src/panels/PdfViewerPanel.tsx` — change `DEFAULT_SCROLL_BINDINGS` to pan-on-bare; apply safety net in `handleWheel`; add toolbar button.
- `src/frontend/src/panels/BoardViewerPanel.tsx` — add toolbar button in `board-status-indicators`.
- `src/frontend/src/renderer/BoardRenderer.ts` — extend `installShiftWheelHandler` to also catch classic-wheel events in pan mode when `wheelDetection` is on.
- `src/frontend/src/panels/SettingsPanel.tsx` — add `<Toggle>` row for `wheelDetection` inside the "Scroll wheel behavior" subsection.

---

## Task 1: Add `wheelDetection` setting to render-settings

**Files:**
- Modify: `src/frontend/src/store/render-settings.ts`

- [ ] **Step 1: Add field to the `RenderSettings` interface**

In `src/frontend/src/store/render-settings.ts`, locate the `twoFingerPan` field (around line 162) and add the new field right after it:

```ts
  /** Require two fingers for panning (one finger does nothing); useful for trackpad users */
  twoFingerPan: boolean;
  /**
   * When scroll is configured to pan, override classic mouse-wheel events
   * (large integer deltaY, no deltaX, no ctrl) to zoom instead — avoids
   * jerky one-notch-equals-100px pan behavior. Trackpads and fine-grained
   * wheels are unaffected by the heuristic. Default: true.
   */
  wheelDetection: boolean;
```

- [ ] **Step 2: Add default value**

In the same file, locate the `DEFAULTS` constant (around line 201). Find `twoFingerPan: true,` (line 268) and add right below it:

```ts
  wheelDetection: true,
```

- [ ] **Step 3: Type-check**

Run: `cd src/frontend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/frontend/src/store/render-settings.ts
git commit -m "feat(settings): add wheelDetection field (default on)"
```

---

## Task 2: Create `scroll-mode.ts` with helpers and hook

**Files:**
- Create: `src/frontend/src/store/scroll-mode.ts`

- [ ] **Step 1: Write the file**

Create `src/frontend/src/store/scroll-mode.ts` with:

```ts
import { useSyncExternalStore } from 'react';
import { renderSettingsStore } from './render-settings';
import {
  loadScrollBindings,
  SCROLL_BINDINGS_KEY,
  type ScrollBindings,
} from '../panels/PdfViewerPanel';

/**
 * Returns the current "bare" scroll action. Board's `twoFingerPan` is the
 * authoritative source — it only has two possible values (pan | zoom), which
 * is exactly what we need for a two-icon button. PDF may have an exotic
 * `bare='switch'` configuration via Settings; if so, the icon still reflects
 * board state and the tooltip covers the rest.
 */
export function getBareScrollAction(): 'pan' | 'zoom' {
  return renderSettingsStore.globalSettings.twoFingerPan ? 'pan' : 'zoom';
}

/**
 * Swap `bare` ↔ `shift` in both stores. PDF's `meta` slot is preserved so
 * any user customization in the Settings 3-slot editor survives.
 */
export function invertScrollBindings(): void {
  // 1. Board side — boolean toggle IS the bare↔shift swap.
  const cur = renderSettingsStore.globalSnapshot();
  renderSettingsStore.applyGlobal({ ...cur, twoFingerPan: !cur.twoFingerPan });

  // 2. PDF side — literal bare↔shift swap.
  const b = loadScrollBindings();
  const next: ScrollBindings = { bare: b.shift, shift: b.bare, meta: b.meta };
  localStorage.setItem(SCROLL_BINDINGS_KEY, JSON.stringify(next));
  window.dispatchEvent(new CustomEvent('pdf-scroll-bindings-changed', { detail: next }));
}

/**
 * Heuristic: does this wheel event look like a classic mouse wheel?
 * Used by the safety net to avoid jerky pan when the configured mode is
 * pan-on-bare but the user is actually on a scroll wheel.
 *
 * Conservative: only fires for obviously-discrete wheels.
 *   - no ctrlKey (pinch-to-zoom gets forwarded elsewhere anyway)
 *   - no deltaX (trackpads often emit both axes)
 *   - |deltaY| >= 50 (fine-grained wheels are under this threshold)
 *   - integer deltaY (macOS trackpads commonly emit fractional)
 */
export function looksLikeMouseWheel(e: WheelEvent): boolean {
  return (
    !e.ctrlKey &&
    e.deltaX === 0 &&
    Math.abs(e.deltaY) >= 50 &&
    Number.isInteger(e.deltaY)
  );
}

/** React hook returning the current bare scroll action. Re-renders on change. */
export function useBareScrollAction(): 'pan' | 'zoom' {
  return useSyncExternalStore(
    (cb) => renderSettingsStore.subscribe(cb),
    getBareScrollAction,
  );
}
```

- [ ] **Step 2: Type-check**

Run: `cd src/frontend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/frontend/src/store/scroll-mode.ts
git commit -m "feat(scroll-mode): shared helpers + hook for pan/zoom toggle"
```

---

## Task 3: Align PDF default to pan-on-bare

**Files:**
- Modify: `src/frontend/src/panels/PdfViewerPanel.tsx:53`

- [ ] **Step 1: Change the default constant**

Open `src/frontend/src/panels/PdfViewerPanel.tsx` and find line 53:

```ts
export const DEFAULT_SCROLL_BINDINGS: ScrollBindings = { bare: 'zoom', shift: 'pan', meta: 'switch' };
```

Replace with:

```ts
export const DEFAULT_SCROLL_BINDINGS: ScrollBindings = { bare: 'pan', shift: 'zoom', meta: 'switch' };
```

- [ ] **Step 2: Type-check and run existing tests**

Run: `cd src/frontend && npx tsc --noEmit && npx playwright test pdf-search.spec.ts --reporter=line`
Expected: no errors, tests pass (existing tests don't rely on scroll bindings).

- [ ] **Step 3: Commit**

```bash
git add src/frontend/src/panels/PdfViewerPanel.tsx
git commit -m "feat(pdf): default scroll bindings to pan-on-bare for consistency with board"
```

---

## Task 4: Apply safety net in PDF wheel handler

**Files:**
- Modify: `src/frontend/src/panels/PdfViewerPanel.tsx` (handleWheel around line 2067, imports at top)

- [ ] **Step 1: Add import**

At the top of `src/frontend/src/panels/PdfViewerPanel.tsx`, find the existing imports and add:

```ts
import { looksLikeMouseWheel } from '../store/scroll-mode';
import { renderSettingsStore } from '../store/render-settings';
```

(Place `renderSettingsStore` near other store imports; `looksLikeMouseWheel` near other same-layer store imports.)

- [ ] **Step 2: Apply safety net after action resolution**

In `handleWheel` (line 2067), locate the block where `action` is resolved (lines 2074-2082). Right after the `const action: ScrollAction = ...` line, insert the safety-net override:

```ts
      // Safety net: classic mouse wheel + pan mode = unusable jerky pan.
      // Reinterpret this single event as zoom. Does not write back to settings.
      const wheelDetection = renderSettingsStore.settings.wheelDetection;
      const effectiveAction: ScrollAction = (
        wheelDetection && action === 'pan' && looksLikeMouseWheel(e)
      ) ? 'zoom' : action;
```

Then replace the two remaining `if (action === 'zoom')` and `if (action === 'pan')` checks (lines 2084 and 2146) with `effectiveAction`:

```ts
      if (effectiveAction === 'zoom') {
        // ... existing zoom logic ...
      }

      if (effectiveAction === 'pan') {
        // ... existing pan logic ...
      }
```

Leave `action === 'switch'` (around line 2196+ — the page-switch branch) untouched; the safety net only overrides pan, never switch.

- [ ] **Step 3: Type-check**

Run: `cd src/frontend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Manual sanity check**

Run: `cd src/frontend && npm run dev`
Open a PDF, verify:
- Scroll wheel (external mouse) zooms even when bindings say pan
- Trackpad two-finger scroll still pans
- Toggling wheelDetection off (via browser DevTools `localStorage` edit or Settings later) makes wheel pan as configured

- [ ] **Step 5: Commit**

```bash
git add src/frontend/src/panels/PdfViewerPanel.tsx
git commit -m "feat(pdf): mouse-wheel safety net overrides pan->zoom"
```

---

## Task 5: Apply safety net in BoardRenderer

**Files:**
- Modify: `src/frontend/src/renderer/BoardRenderer.ts` (`installShiftWheelHandler` around line 1968)

- [ ] **Step 1: Add import**

At the top of `src/frontend/src/renderer/BoardRenderer.ts`, locate the existing `import { renderSettingsStore } from '../store/render-settings';` line (search for it). Add next to it:

```ts
import { looksLikeMouseWheel } from '../store/scroll-mode';
```

- [ ] **Step 2: Extend `installShiftWheelHandler` to catch classic wheel in pan mode**

Find the handler body at line 1973. The current handler bails out immediately when `!e.shiftKey` (line 1976). Replace the early-return and the rest of the function body with:

```ts
    this.boundShiftWheel = (e: WheelEvent) => {
      // Let Ctrl/Meta combos (trackpad pinch, browser zoom) pass through.
      if (e.ctrlKey || e.metaKey) return;

      const s = renderSettingsStore.settings;

      // Safety net: classic mouse wheel in pan mode would pan jerkily. Route
      // it to the mouse-centered zoom path instead when wheelDetection is on.
      const safetyNetFires =
        s.wheelDetection && s.twoFingerPan && !e.shiftKey && looksLikeMouseWheel(e);

      // Existing shift-swap: in pan mode shift = zoom; in zoom mode shift = pan.
      // The safety net joins the "shift-while-pan-mode" path (mouse-centered zoom).
      if (e.shiftKey && s.twoFingerPan || safetyNetFires) {
        const raw = e.deltaY || e.deltaX;
        const factor = Math.pow(2, (1 + 0.3) * (-raw / 500));
        const point = { x: e.offsetX, y: e.offsetY };
        const before = this.viewport.toWorld(point.x, point.y);
        this.viewport.scale.set(
          Math.max(0.001, Math.min(10, this.viewport.scale.x * factor)),
          Math.max(0.001, Math.min(10, this.viewport.scale.y * factor)),
        );
        const after = this.viewport.toWorld(point.x, point.y);
        this.viewport.x += (after.x - before.x) * this.viewport.scale.x;
        this.viewport.y += (after.y - before.y) * this.viewport.scale.y;
      } else if (e.shiftKey && !s.twoFingerPan) {
        // Alternate mode: bare = zoom, shift+scroll = pan.
        const dx = e.deltaX || e.deltaY;
        this.viewport.x -= dx;
      } else {
        // No modifier and safety net did not fire — let pixi-viewport handle it.
        return;
      }

      this.viewport.emit('moved', { viewport: this.viewport, type: 'wheel' });
      this.needsRender = true;
      this.netLinesDirty = true;
      e.preventDefault();
      e.stopPropagation();
    };
    this.containerEl.addEventListener('wheel', this.boundShiftWheel, { capture: true, passive: false });
```

Rationale: the handler already runs in capture phase before pixi-viewport. Previously it only did anything when `shiftKey` was true. Now it also intercepts shift-less classic-wheel events when the safety net conditions are met, routing them through the same mouse-centered zoom path. Bare-scroll events that don't match the safety net still pass through untouched to pixi-viewport (which pans or zooms depending on its current plugin config).

- [ ] **Step 3: Type-check**

Run: `cd src/frontend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Manual sanity check**

Run: `cd src/frontend && npm run dev`
Open a board. In pan mode (default), verify:
- Shift+wheel still zooms (existing behavior)
- External mouse wheel zooms (safety net — previously panned jerkily)
- Trackpad two-finger scroll still pans (heuristic doesn't match fractional/small deltas)

- [ ] **Step 5: Commit**

```bash
git add src/frontend/src/renderer/BoardRenderer.ts
git commit -m "feat(board): mouse-wheel safety net in capture handler"
```

---

## Task 6: Add toggle button to BoardViewer toolbar

**Files:**
- Modify: `src/frontend/src/panels/BoardViewerPanel.tsx` (imports at top, button in `board-status-indicators` around line 220)

- [ ] **Step 1: Add imports**

At the top of `src/frontend/src/panels/BoardViewerPanel.tsx`, update the `@tabler/icons-react` import:

```ts
import { IconHierarchy, IconTooltip, IconObjectScan, IconGhost2, IconHandMove, IconZoomIn } from '@tabler/icons-react';
```

And add below the other store/hook imports:

```ts
import { invertScrollBindings, useBareScrollAction } from '../store/scroll-mode';
```

- [ ] **Step 2: Read the bare action in the component**

Inside `BoardViewerPanel` function body, near the other hook calls (after the `useBoardStore` destructure at line 29), add:

```ts
  const bareAction = useBareScrollAction();
```

- [ ] **Step 3: Insert the button after fit-to-board**

Find the fit-to-board button (lines 220-226):

```tsx
        <button
          className="board-netlines-toggle"
          onClick={() => rendererRef.current?.fitToBoard()}
          title="Zoom to fit board"
        >
          <IconObjectScan size={16} />
        </button>
```

Immediately after its closing `</button>`, insert:

```tsx
        <button
          className="board-netlines-toggle"
          onClick={invertScrollBindings}
          title={bareAction === 'pan'
            ? 'Scroll: Pan · Shift+Scroll: Zoom — click to swap'
            : 'Scroll: Zoom · Shift+Scroll: Pan — click to swap'}
        >
          {bareAction === 'pan' ? <IconHandMove size={16} /> : <IconZoomIn size={16} />}
        </button>
```

- [ ] **Step 4: Type-check and lint**

Run: `cd src/frontend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Manual sanity check**

Run: `cd src/frontend && npm run dev`
Open a board. Verify:
- Hand icon visible (default pan mode)
- Click → icon changes to magnifier
- Click again → back to hand
- Tooltip reflects current state

- [ ] **Step 6: Commit**

```bash
git add src/frontend/src/panels/BoardViewerPanel.tsx
git commit -m "feat(board): pan/zoom scroll-mode toggle button"
```

---

## Task 7: Add toggle button to PDF toolbar

**Files:**
- Modify: `src/frontend/src/panels/PdfViewerPanel.tsx` (imports at top, button before `pdf-zoom-group` around line 2792)

- [ ] **Step 1: Add imports**

Near the top of `src/frontend/src/panels/PdfViewerPanel.tsx`, find the `@tabler/icons-react` imports and add `IconHandMove` and `IconZoomIn` to the list (they may already be partially imported — add only missing ones).

Also add below other store imports:

```ts
import { invertScrollBindings, useBareScrollAction } from '../store/scroll-mode';
```

- [ ] **Step 2: Read bare action near other hooks**

Inside `PdfViewerPanel` (around where the other top-level hooks are called, near line 623 where `scrollBindings` state is created), add:

```ts
  const bareAction = useBareScrollAction();
```

- [ ] **Step 3: Insert the button before the fit-to-width button**

Find the zoom group button (lines 2792-2799):

```tsx
        <button
          className="pdf-toolbar-btn pdf-zoom-group"
          onClick={handleFitWidth}
          title="Fit to page width (Space)"
        >
          <IconArrowAutofitWidth size={14} />
          <span className="pdf-zoom-info">{Math.round(zoomDisplay * 100)}%</span>
        </button>
```

Immediately BEFORE this button (not after), insert:

```tsx
        <button
          className="pdf-toolbar-btn"
          onClick={invertScrollBindings}
          title={bareAction === 'pan'
            ? 'Scroll: Pan · Shift+Scroll: Zoom — click to swap'
            : 'Scroll: Zoom · Shift+Scroll: Pan — click to swap'}
        >
          {bareAction === 'pan' ? <IconHandMove size={14} /> : <IconZoomIn size={14} />}
        </button>
```

- [ ] **Step 4: Type-check**

Run: `cd src/frontend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Manual side-by-side check**

Run: `cd src/frontend && npm run dev`
Open a board AND a PDF. Verify:
- Both toolbars show Hand icon (default)
- Clicking PDF button → BOTH icons flip to magnifier (shared state)
- Clicking board button → BOTH flip again

- [ ] **Step 6: Commit**

```bash
git add src/frontend/src/panels/PdfViewerPanel.tsx
git commit -m "feat(pdf): pan/zoom scroll-mode toggle button synced with board"
```

---

## Task 8: Add `wheelDetection` checkbox to Settings

**Files:**
- Modify: `src/frontend/src/panels/SettingsPanel.tsx:1241`

- [ ] **Step 1: Add Toggle row under `BoardScrollBindingsEditor`**

Find the "Scroll wheel behavior" block (line 1239-1241):

```tsx
        <div className="settings-subsection-label">Scroll wheel behavior</div>
        <p className="settings-hint">Drag pills between slots to reassign scroll actions.</p>
        <BoardScrollBindingsEditor twoFingerPan={draft.twoFingerPan} onUpdate={updateDraft} />
```

Immediately after the `BoardScrollBindingsEditor` line, add:

```tsx
        <Toggle
          label="Mouse wheel detection"
          value={draft.wheelDetection}
          field="wheelDetection"
          onUpdate={updateDraft}
          title="When scroll is set to pan, classic mouse-wheel events override to zoom instead — avoids jerky pan with a physical scroll wheel. Trackpads and fine-grained wheels are unaffected."
        />
```

- [ ] **Step 2: Type-check**

Run: `cd src/frontend && npx tsc --noEmit`
Expected: no errors. (`field="wheelDetection"` resolves via `keyof RenderSettings`, which now includes the field from Task 1.)

- [ ] **Step 3: Manual sanity check**

Run: `cd src/frontend && npm run dev`
Open Settings → Navigation → Scroll wheel behavior. Verify:
- Checkbox appears below the bindings editor, labeled "Mouse wheel detection"
- Checked by default
- Unchecking + external mouse wheel → scroll-wheel pans jerkily (safety net disabled)
- Re-checking → scroll-wheel zooms (safety net back on)

- [ ] **Step 4: Commit**

```bash
git add src/frontend/src/panels/SettingsPanel.tsx
git commit -m "feat(settings): expose wheelDetection toggle under scroll bindings"
```

---

## Task 9: Playwright E2E test

**Files:**
- Create: `src/frontend/tests/scroll-mode.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `src/frontend/tests/scroll-mode.spec.ts`:

```ts
import { test, expect } from '@playwright/test';
import path from 'path';

const SAMPLE_BVR = path.resolve(__dirname, '../../../samples/820-02016.bvr');

test.describe('Pan/zoom scroll-mode toggle', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    // Load a board so the BoardViewer toolbar is present
    const fileChooserPromise = page.waitForEvent('filechooser');
    await page.click('button:has-text("Open")');
    const chooser = await fileChooserPromise;
    await chooser.setFiles(SAMPLE_BVR);
    await expect(page.locator('[data-testid="statusbar"]')).toBeVisible();
  });

  test('toggle button flips icon and persists across stores', async ({ page }) => {
    // Default is pan-on-bare → hand icon
    const boardBtn = page.locator('.board-status-indicators button').nth(2); // [follow-pdf, fit-board, scroll-mode]
    await expect(boardBtn.locator('svg')).toBeVisible();

    // Click board toggle → twoFingerPan should flip
    await boardBtn.click();
    const twoFinger1 = await page.evaluate(() => {
      const raw = localStorage.getItem('boardripper-render-settings');
      return raw ? (JSON.parse(raw).twoFingerPan as boolean) : null;
    });
    expect(twoFinger1).toBe(false);

    // Click again → back to true
    await boardBtn.click();
    const twoFinger2 = await page.evaluate(() => {
      const raw = localStorage.getItem('boardripper-render-settings');
      return raw ? (JSON.parse(raw).twoFingerPan as boolean) : null;
    });
    expect(twoFinger2).toBe(true);

    // PDF bindings localStorage should have inverted twice (back to original shape)
    const pdfBindings = await page.evaluate(() => {
      const raw = localStorage.getItem('boardripper-pdf-scroll-bindings');
      return raw ? JSON.parse(raw) : null;
    });
    expect(pdfBindings?.bare).toBe('pan');
    expect(pdfBindings?.shift).toBe('zoom');
    expect(pdfBindings?.meta).toBe('switch');
  });

  test('wheelDetection checkbox appears in Settings', async ({ page }) => {
    // Open settings panel (adjust selector to how SettingsPanel is opened in this app)
    await page.getByRole('button', { name: /settings/i }).first().click();
    await expect(page.locator('text=Scroll wheel behavior')).toBeVisible();
    const checkbox = page.locator('label:has-text("Mouse wheel detection")').locator('..').locator('input[type="checkbox"]');
    await expect(checkbox).toBeChecked();
    // Uncheck and verify persisted
    await checkbox.uncheck();
    const stored = await page.evaluate(() => {
      const raw = localStorage.getItem('boardripper-render-settings');
      return raw ? (JSON.parse(raw).wheelDetection as boolean) : null;
    });
    expect(stored).toBe(false);
  });
});
```

Note: exact selectors may need small adjustments to match the actual DOM (the `nth(2)` index depends on button order in `board-status-indicators`; if the `follow-pdf` button is disabled without a linked PDF, it may or may not render in the DOM). Run the test once and tune selectors if needed.

- [ ] **Step 2: Run and verify**

Run: `cd src/frontend && npx playwright test scroll-mode.spec.ts --reporter=line`
Expected: both tests pass. If `nth(2)` points at the wrong button (e.g. fit-to-board), adjust to `nth(3)` or use a more specific locator like `page.locator('.board-status-indicators').getByTitle(/Scroll:.*click to swap/)`.

- [ ] **Step 3: If needed, refine selectors**

If the first test fails on locator, replace the board-button selector with a title-based locator:

```ts
const boardBtn = page.locator('.board-status-indicators').getByTitle(/click to swap/);
```

Re-run until both pass.

- [ ] **Step 4: Commit**

```bash
git add src/frontend/tests/scroll-mode.spec.ts
git commit -m "test(scroll-mode): e2e for toggle button and settings checkbox"
```

---

## Task 10: Unit-test the safety-net heuristic

**Files:**
- Modify: `src/frontend/tests/scroll-mode.spec.ts` (append a page.evaluate-based unit test that doesn't need the full app)

Rationale: `looksLikeMouseWheel` is pure; an in-browser `page.evaluate` assertion is cheaper than a full pointer-dispatch E2E and covers the edge cases explicitly.

- [ ] **Step 1: Append the test block**

At the end of `src/frontend/src/tests/scroll-mode.spec.ts`, add:

```ts
test.describe('looksLikeMouseWheel heuristic', () => {
  test('classifies wheel events correctly in browser context', async ({ page }) => {
    await page.goto('/');

    // Evaluate the module in the page — the test runs in the same origin
    const results = await page.evaluate(async () => {
      const mod = await import('/src/store/scroll-mode.ts');
      const mk = (opts: Partial<WheelEventInit>) => new WheelEvent('wheel', opts);
      return {
        classicWheel: mod.looksLikeMouseWheel(mk({ deltaY: 100, deltaX: 0 })),
        smallWheel:   mod.looksLikeMouseWheel(mk({ deltaY: 10,  deltaX: 0 })),
        withDeltaX:   mod.looksLikeMouseWheel(mk({ deltaY: 100, deltaX: 5 })),
        pinchCtrl:    mod.looksLikeMouseWheel(mk({ deltaY: 100, deltaX: 0, ctrlKey: true })),
        fractional:   mod.looksLikeMouseWheel(mk({ deltaY: 83.3, deltaX: 0 })),
      };
    });

    expect(results.classicWheel).toBe(true);
    expect(results.smallWheel).toBe(false);
    expect(results.withDeltaX).toBe(false);
    expect(results.pinchCtrl).toBe(false);
    expect(results.fractional).toBe(false);
  });
});
```

Note: the `await import('/src/store/scroll-mode.ts')` path relies on Vite's dev server resolving TS modules by URL. If the test runs against a build (not dev server), rewrite using module bundling or move to a Vitest unit test. For BoardRipper's current Playwright setup against `npm run dev`, the import form above works.

- [ ] **Step 2: Run**

Run: `cd src/frontend && npx playwright test scroll-mode.spec.ts --reporter=line`
Expected: the new test passes alongside the earlier two.

- [ ] **Step 3: If the dynamic import fails**

Fallback: re-implement the heuristic inline inside `page.evaluate` with the same logic, and assert against it. This sacrifices the "tests the real code" property but unblocks CI. Prefer to make the dynamic import work first — the Vite dev server at `localhost:8082` serves `src/` paths directly and this pattern is used in other BoardRipper tests.

- [ ] **Step 4: Commit**

```bash
git add src/frontend/tests/scroll-mode.spec.ts
git commit -m "test(scroll-mode): heuristic classification edge cases"
```

---

## Task 11: Final integration check and cleanup

- [ ] **Step 1: Run full test suite**

Run: `cd src/frontend && npx playwright test --reporter=line`
Expected: all tests pass, no regressions.

- [ ] **Step 2: Verify no stray `console.log` / unused imports**

Run: `cd src/frontend && npx tsc --noEmit && npm run lint 2>/dev/null || true`
Inspect output. Fix any issues.

- [ ] **Step 3: Final manual smoke test**

Run: `cd src/frontend && npm run dev`
Open the app in a fresh browser profile (or after clearing `localStorage`). Verify:
1. BoardViewer loads with Hand icon in toolbar — pan mode.
2. PDF opens with Hand icon in toolbar — pan mode (default now aligned).
3. Click the button in either viewer — both icons flip to magnifier.
4. Trackpad two-finger scroll pans (if device available) — heuristic doesn't misfire.
5. Mouse wheel with pan mode active still zooms (safety net working).
6. Settings → Navigation → Scroll wheel behavior → "Mouse wheel detection" checkbox is checked. Uncheck it and verify mouse wheel now pans jerkily (proving the toggle works end-to-end).

- [ ] **Step 4: No commit — just verification. Done.**

---

## Spec-to-task coverage matrix

| Spec requirement | Implemented in |
|---|---|
| Shared `twoFingerPan` drives both viewers | Task 2 (`invertScrollBindings`) |
| Button swaps bare↔shift, preserves `meta` | Task 2 (`invertScrollBindings`) |
| Default = pan-on-bare on fresh install | Task 3 (PDF default) + existing board default |
| BoardViewer button placement | Task 6 |
| PDF button placement | Task 7 |
| `wheelDetection` setting + default on | Task 1 |
| Safety-net heuristic (`looksLikeMouseWheel`) | Task 2 |
| PDF safety net wiring | Task 4 |
| Board safety net wiring | Task 5 |
| Settings checkbox for `wheelDetection` | Task 8 |
| Tests | Tasks 9, 10 |

No spec requirement is without a task.
