# Board Overlay Search + Customizer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Parts/Nets filter dropdowns and a selected-component-name label to the BoardViewer overlay, and a drag-and-drop customizer in Settings to reorder/hide every overlay slot.

**Architecture:** A slot-registry pattern: `OverlaySlot[]` is persisted in `renderSettingsStore`, the overlay row maps slot IDs to render-function components, and a Settings customizer mutates the array via native HTML5 drag-and-drop. Dropdowns use a shared popover scaffold and pre-computed natural-sorted indexes per board (`WeakMap<BoardData, …>`). NC nets are partitioned at index time using the existing `isNcNet` matcher. Selecting a part/net delegates to existing `boardStore.focusPart` / `boardStore.focusNet`, with a new 3× fit-to-board zoom cap inside `BoardRenderer.zoomToBounds`.

**Tech Stack:** React 19 + TypeScript, PixiJS v8 + pixi-viewport, Playwright (E2E only — no separate unit-test runner). Tests for pure logic call exposed `window.__test` hooks under `import.meta.env.DEV`, matching the existing `__boardStore` pattern.

**Spec:** [docs/superpowers/specs/2026-05-04-board-overlay-search-customizer-design.md](../specs/2026-05-04-board-overlay-search-customizer-design.md)

---

## File Structure

**New files:**

| Path | Responsibility |
|------|----------------|
| `src/frontend/src/store/overlay-layout.ts` | `OverlaySlotId` union, `OverlaySlot` type, `DEFAULT_OVERLAY_LAYOUT`, `KNOWN_SLOT_IDS`, `reconcileOverlayLayout()` |
| `src/frontend/src/components/overlay/natural-sort.ts` | `naturalCompare(a, b)` comparator |
| `src/frontend/src/components/overlay/get-overlay-index.ts` | `getOverlayIndex(board, ncPatterns)` memoized via `WeakMap` |
| `src/frontend/src/components/overlay/dropdown-popover.tsx` | Shared popover scaffold: filter input + virtualized list, keyboard nav |
| `src/frontend/src/components/overlay/SelectedNameLabel.tsx` | Renders `U21 · pin 3 → PP3V3_S0_REG` style label below overlay row |
| `src/frontend/src/components/overlay/slot-renderers.tsx` | `overlaySlotRenderers: Record<OverlaySlotId, (ctx) => ReactNode>` registry |
| `src/frontend/src/components/overlay/slots/PdfFollowButton.tsx` | Extracted from `BoardViewerPanel.tsx` — verbatim move |
| `src/frontend/src/components/overlay/slots/ScrollModeButton.tsx` | Extracted |
| `src/frontend/src/components/overlay/slots/FitBoardButton.tsx` | Extracted |
| `src/frontend/src/components/overlay/slots/HoverInfoButton.tsx` | Extracted |
| `src/frontend/src/components/overlay/slots/NetDimButton.tsx` | Extracted |
| `src/frontend/src/components/overlay/slots/NetLinesButton.tsx` | Extracted |
| `src/frontend/src/components/overlay/slots/GhostsButton.tsx` | Extracted |
| `src/frontend/src/components/overlay/slots/Separator.tsx` | Cosmetic spacer for `sep1` / `sep2` |
| `src/frontend/src/components/overlay/slots/PartsDropdown.tsx` | Parts filter dropdown |
| `src/frontend/src/components/overlay/slots/NetsDropdown.tsx` | Nets filter dropdown with NC partition |
| `src/frontend/src/panels/settings/OverlayCustomizer.tsx` | DnD customizer + visibility checkbox + on-select segmented controls |
| `src/frontend/tests/overlay-customizer.spec.ts` | E2E tests for dropdowns, customizer, persistence |

**Modified files:**

| Path | Change |
|------|--------|
| `src/frontend/src/store/render-settings.ts` | Add 4 new fields, defaults, hydrate-on-load reconciliation, expose `window.__overlayTest` in DEV |
| `src/frontend/src/renderer/BoardRenderer.ts` | Add 3× fit-to-board zoom cap inside `zoomToBounds`; add `panToPartIfOffscreen()` and `panToNetIfOffscreen()` |
| `src/frontend/src/panels/BoardViewerPanel.tsx` | Replace inline `board-status-indicators` JSX with the registry walker; render `SelectedNameLabel` below |
| `src/frontend/src/panels/SettingsPanel.tsx` | Register new `boardOverlay` section that renders `<OverlayCustomizer />` |
| `src/frontend/src/index.css` | Styles for `.overlay-sep`, `.overlay-dropdown-*`, `.overlay-customizer-*`, `.overlay-selected-name` |

---

## Conventions

- Each task ends with a commit. Use the existing project commit style: `feat(...)`, `fix(...)`, `refactor(...)`, etc., one short subject line, body with the **why**.
- Bump `PARSER_VERSION` in `board-cache.ts` is **not** required for this work (no parser-output changes).
- Preserve the `Co-Authored-By` footer — see other recent commits in `git log` for the pattern.
- Run `npm run lint` after each task before committing. CI will catch type/lint errors regardless, but local pre-commit saves a roundtrip.
- All file paths in this plan are absolute from the repo root.

---

## Phase 1 — Foundations: data model, persistence, renderer extensions

### Task 1: Overlay layout types + default + reconciliation

**Files:**
- Create: `src/frontend/src/store/overlay-layout.ts`

- [ ] **Step 1: Create the new file with types, default, and reconciler**

```ts
// src/frontend/src/store/overlay-layout.ts
/**
 * BoardViewer overlay slot model — single source of truth for the slot
 * registry, default order, and persistence reconciliation.
 *
 * The overlay (the floating row of buttons on the board canvas) is rendered
 * by walking `OverlaySlot[]` and looking each id up in slot-renderers.tsx.
 * Adding a new slot:
 *   1. add the id to OverlaySlotId
 *   2. add it to KNOWN_SLOT_IDS
 *   3. add it to DEFAULT_OVERLAY_LAYOUT (anywhere, with visible: true)
 *   4. add a renderer entry in slot-renderers.tsx
 * `reconcileOverlayLayout` will append it to existing users' saved layouts
 * automatically on next load.
 */

export type OverlaySlotId =
  | 'pdfFollow' | 'scrollMode' | 'fitBoard'
  | 'hoverInfo' | 'netDim' | 'netLines' | 'ghosts'
  | 'partsDropdown' | 'netsDropdown'
  | 'sep1' | 'sep2';

export interface OverlaySlot { id: OverlaySlotId; visible: boolean }

export const KNOWN_SLOT_IDS: ReadonlySet<OverlaySlotId> = new Set([
  'pdfFollow', 'scrollMode', 'fitBoard',
  'hoverInfo', 'netDim', 'netLines', 'ghosts',
  'partsDropdown', 'netsDropdown',
  'sep1', 'sep2',
]);

/**
 * Default order — reproduces today's UI byte-for-byte. The two `sep` slots
 * carry the visual gap between the existing button groups; without them
 * the overlay collapses to a single uninterrupted row.
 */
export const DEFAULT_OVERLAY_LAYOUT: OverlaySlot[] = [
  { id: 'pdfFollow',     visible: true },
  { id: 'scrollMode',    visible: true },
  { id: 'fitBoard',      visible: true },
  { id: 'sep1',          visible: true },
  { id: 'hoverInfo',     visible: true },
  { id: 'netDim',        visible: true },
  { id: 'netLines',      visible: true },
  { id: 'ghosts',        visible: true },
  { id: 'sep2',          visible: true },
  { id: 'partsDropdown', visible: true },
  { id: 'netsDropdown',  visible: true },
];

/**
 * Reconcile a saved OverlaySlot[] with the current known slot set.
 *
 *  • Keeps saved order
 *  • Drops slot ids we no longer recognise (forward-compat after a rename)
 *  • Appends any slot id from DEFAULT_OVERLAY_LAYOUT the user hasn't seen
 *    (covers upgrade paths where new buttons land after the user's layout
 *    was saved).
 *
 * Always returns a fresh array — never mutates the input.
 */
export function reconcileOverlayLayout(saved: unknown): OverlaySlot[] {
  const out: OverlaySlot[] = [];
  const seen = new Set<OverlaySlotId>();

  if (Array.isArray(saved)) {
    for (const raw of saved) {
      if (!raw || typeof raw !== 'object') continue;
      const id = (raw as { id?: unknown }).id;
      const visible = (raw as { visible?: unknown }).visible;
      if (typeof id !== 'string') continue;
      if (!KNOWN_SLOT_IDS.has(id as OverlaySlotId)) continue;
      const slotId = id as OverlaySlotId;
      if (seen.has(slotId)) continue;
      out.push({ id: slotId, visible: visible !== false });
      seen.add(slotId);
    }
  }

  for (const def of DEFAULT_OVERLAY_LAYOUT) {
    if (!seen.has(def.id)) out.push({ id: def.id, visible: true });
  }

  return out;
}
```

- [ ] **Step 2: Lint + typecheck the new file**

Run: `cd src/frontend && npm run lint -- src/store/overlay-layout.ts && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/frontend/src/store/overlay-layout.ts
git commit -m "$(cat <<'EOF'
feat(overlay): add slot-layout types, default, and reconciler

Defines OverlaySlot/OverlaySlotId and the canonical default order
that matches today's BoardViewer overlay UI exactly (including the
two visual gaps as sep1/sep2). reconcileOverlayLayout handles
forward-compat (drop unknown ids) and upgrade-compat (append new
default slots) so users never get stuck with a broken overlay
after an update.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Persist overlay settings in renderSettingsStore

**Files:**
- Modify: `src/frontend/src/store/render-settings.ts`

The store already persists to localStorage via JSON. We add four new fields, wire them through the persistence read path, and expose a DEV `window.__overlayTest` hook for Playwright unit-style tests on `reconcileOverlayLayout`.

- [ ] **Step 1: Read the existing file shape (orientation, do not edit yet)**

Run: `grep -n "interface RenderSettings\|defaultRenderSettings\|loadFromLocal\|saveToLocal\|class RenderSettingsStore" src/frontend/src/store/render-settings.ts`
Expected: prints the spots where the interface is declared, defaults are built, and persistence functions live. Use this to find the exact insertion lines for the additions in step 2.

- [ ] **Step 2: Add types, defaults, and reconciliation to render-settings.ts**

Add the following imports at the top of the file:

```ts
import {
  type OverlaySlot,
  DEFAULT_OVERLAY_LAYOUT,
  reconcileOverlayLayout,
} from './overlay-layout';
```

Inside the `RenderSettings` interface (find with grep above), append:

```ts
  /** BoardViewer overlay row — ordered slot list, persisted globally. */
  overlayLayout: OverlaySlot[];
  /** Whether the "selected component name" label below the overlay is visible. */
  overlaySelectedNameVisible: boolean;
  /** Action when picking a part from the Parts dropdown. */
  overlayPartsOnSelect: 'highlight' | 'panIfOffscreen' | 'panZoomFit';
  /** Action when picking a net from the Nets dropdown. */
  overlayNetsOnSelect: 'highlight' | 'panIfOffscreen' | 'panZoomFit';
```

Inside the defaults builder (the `defaultRenderSettings` const or the spread object inside the constructor — match what the file uses), append:

```ts
  overlayLayout: DEFAULT_OVERLAY_LAYOUT.map(s => ({ ...s })),
  overlaySelectedNameVisible: true,
  overlayPartsOnSelect: 'panZoomFit',
  overlayNetsOnSelect: 'panZoomFit',
```

In the load-from-localStorage path (find the function that parses saved JSON into a settings object), reconcile the layout. Look for an existing pattern like `if (parsed.partTypes) merged.partTypes = parsed.partTypes;` and add alongside it:

```ts
  merged.overlayLayout = reconcileOverlayLayout(parsed.overlayLayout);
  if (typeof parsed.overlaySelectedNameVisible === 'boolean') {
    merged.overlaySelectedNameVisible = parsed.overlaySelectedNameVisible;
  }
  if (
    parsed.overlayPartsOnSelect === 'highlight' ||
    parsed.overlayPartsOnSelect === 'panIfOffscreen' ||
    parsed.overlayPartsOnSelect === 'panZoomFit'
  ) {
    merged.overlayPartsOnSelect = parsed.overlayPartsOnSelect;
  }
  if (
    parsed.overlayNetsOnSelect === 'highlight' ||
    parsed.overlayNetsOnSelect === 'panIfOffscreen' ||
    parsed.overlayNetsOnSelect === 'panZoomFit'
  ) {
    merged.overlayNetsOnSelect = parsed.overlayNetsOnSelect;
  }
```

If the load path always reconciles (no `parsed.overlayLayout` check) then ALWAYS call `reconcileOverlayLayout` — it handles `undefined` cleanly by returning the defaults.

At the bottom of the file (search for `import.meta.env.DEV` — there's likely a similar `__pdfStore` exposure for PdfStore; if no DEV-export block exists yet, create one), add **two** exposures: the `__renderSettings` ref the customizer tests rely on, and the `__overlayTest` namespace for pure-logic unit coverage. Match the `__boardStore` pattern in `board-store.ts:1486`:

```ts
if (typeof window !== 'undefined' && import.meta.env.DEV) {
  (window as Window & {
    __renderSettings?: typeof renderSettingsStore;
    __overlayTest?: { reconcileOverlayLayout: typeof reconcileOverlayLayout };
  }).__renderSettings = renderSettingsStore;
  (window as Window & {
    __overlayTest?: { reconcileOverlayLayout: typeof reconcileOverlayLayout };
  }).__overlayTest = { reconcileOverlayLayout };
}
```

If `__renderSettings` is already exposed elsewhere (grep for `__renderSettings`), keep that exposure and only add the `__overlayTest` line.

- [ ] **Step 3: Add a Playwright test for reconciliation**

Create `src/frontend/tests/overlay-customizer.spec.ts` with the imports, the shared `loadBoard` helper (matches `comprehensive.spec.ts`'s pattern), and the first test group (more cases appended in later tasks):

```ts
import { test, expect, type Page } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REAL_BVR3 = path.resolve(__dirname, '../../../samples/820-02016.bvr');

/** Load a sample board into the active panel and wait for the renderer to settle. */
async function loadBoard(page: Page, filePath: string = REAL_BVR3) {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.getByTestId('file-input').setInputFiles(filePath);
  await expect(page.getByTestId('statusbar')).toContainText('parts', { timeout: 15000 });
}

test.describe('Overlay layout reconciliation', () => {
  test('returns full default layout when nothing is saved', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const result = await page.evaluate(() => {
      const win = window as Window & {
        __overlayTest?: { reconcileOverlayLayout: (saved: unknown) => Array<{ id: string; visible: boolean }> };
      };
      return win.__overlayTest!.reconcileOverlayLayout(undefined);
    });

    expect(result.map(s => s.id)).toEqual([
      'pdfFollow', 'scrollMode', 'fitBoard', 'sep1',
      'hoverInfo', 'netDim', 'netLines', 'ghosts', 'sep2',
      'partsDropdown', 'netsDropdown',
    ]);
    expect(result.every(s => s.visible)).toBe(true);
  });

  test('drops unknown slot ids and preserves saved order', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const result = await page.evaluate(() => {
      const win = window as Window & {
        __overlayTest?: { reconcileOverlayLayout: (saved: unknown) => Array<{ id: string; visible: boolean }> };
      };
      return win.__overlayTest!.reconcileOverlayLayout([
        { id: 'fitBoard', visible: false },
        { id: 'unknownLegacySlot', visible: true },
        { id: 'pdfFollow', visible: true },
      ]);
    });

    expect(result.find(s => s.id === 'unknownLegacySlot')).toBeUndefined();
    expect(result.slice(0, 2)).toEqual([
      { id: 'fitBoard', visible: false },
      { id: 'pdfFollow', visible: true },
    ]);
    expect(result.find(s => s.id === 'partsDropdown')?.visible).toBe(true);
  });

  test('appends new default slots that are missing from saved layout', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const result = await page.evaluate(() => {
      const win = window as Window & {
        __overlayTest?: { reconcileOverlayLayout: (saved: unknown) => Array<{ id: string; visible: boolean }> };
      };
      return win.__overlayTest!.reconcileOverlayLayout([
        { id: 'pdfFollow', visible: true },
        { id: 'fitBoard', visible: true },
      ]);
    });

    const ids = result.map(s => s.id);
    expect(ids[0]).toBe('pdfFollow');
    expect(ids[1]).toBe('fitBoard');
    expect(ids).toContain('partsDropdown');
    expect(ids).toContain('netsDropdown');
    expect(ids).toContain('sep1');
  });
});
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `cd src/frontend && npx playwright test overlay-customizer.spec.ts --project=chromium`
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/frontend/src/store/render-settings.ts src/frontend/tests/overlay-customizer.spec.ts
git commit -m "$(cat <<'EOF'
feat(overlay): persist layout, visibility, and on-select settings

Adds overlayLayout, overlaySelectedNameVisible, overlayPartsOnSelect,
and overlayNetsOnSelect to renderSettingsStore. Reconciliation runs
on load so saved layouts survive future slot additions/removals.
DEV builds expose window.__overlayTest.reconcileOverlayLayout for
Playwright-driven unit coverage.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: 3× fit-to-board zoom cap in BoardRenderer.zoomToBounds

**Files:**
- Modify: `src/frontend/src/renderer/BoardRenderer.ts`

`zoomToBounds` already has an absolute 6× cap. We add a relative 3×-fit-to-board cap on top so that zooming to a tiny component stays in context.

- [ ] **Step 1: Add a `computeFitToBoardScale()` helper near `fitToBoard`**

Find `fitToBoard(board?: BoardData)` (around line 3929). Above it, add:

```ts
  /**
   * Returns the viewport scale magnitude that `fitToBoard()` would set right
   * now, without actually changing the viewport. Used by the focus-zoom cap
   * so we never zoom in more than 3× the whole-board view.
   * Returns 0 if the board or container size is unknown — caller must guard.
   */
  private computeFitToBoardScale(): number {
    const b = this.board?.bounds;
    if (!b) return 0;
    const cw = this.containerEl.clientWidth;
    const ch = this.containerEl.clientHeight;
    if (cw === 0 || ch === 0) return 0;
    const pad = renderSettingsStore.settings.fitPadding;
    const bw = b.maxX - b.minX;
    const bh = b.maxY - b.minY;
    if (bw <= 0 || bh <= 0) return 0;
    const fitW = bw + pad * 2;
    const fitH = bh + pad * 2;
    return Math.min(cw / fitW, ch / fitH);
  }
```

- [ ] **Step 2: Apply the relative cap inside `zoomToBounds`**

Find `zoomToBounds` (around line 1939). Replace the `targetMag` calculation:

```ts
    // Target scale magnitude — part should fill ~viewFraction of the smaller
    // screen dimension. Cap at 6 (= 600%) so tiny components (0402, 0201) don't
    // zoom past the practical pin-pick limit, where sub-pixel pan jitter makes
    // it hard to click an already-selected pin.
    const maxDim = Math.max(bw, bh, 1);
    const targetMag = Math.min((Math.min(sw, sh) * viewFraction) / maxDim, 6);
```

with:

```ts
    // Target scale magnitude — part should fill ~viewFraction of the smaller
    // screen dimension. Two caps:
    //   • absolute 6× (= 600%): hard ceiling — sub-pixel pan jitter past this
    //     makes pin-picking unreliable on tiny components.
    //   • relative 3× fit-to-board: keeps surrounding context visible when
    //     zooming to a 0402-sized passive. If fit-to-board scale is unknown
    //     (board not loaded yet), the relative cap is skipped.
    const maxDim = Math.max(bw, bh, 1);
    const naturalMag = (Math.min(sw, sh) * viewFraction) / maxDim;
    const fitScale = this.computeFitToBoardScale();
    const relCap = fitScale > 0 ? 3 * fitScale : Infinity;
    const targetMag = Math.min(naturalMag, relCap, 6);
```

- [ ] **Step 3: Lint + typecheck**

Run: `cd src/frontend && npm run lint -- src/renderer/BoardRenderer.ts && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Manual smoke check (no automated test — visual change)**

Run: `cd src/frontend && npm run dev`
Open a board (any sample under `samples/`), open the right sidebar's Search tab, find a small 0402 capacitor by name, click to focus it.
Expected: the board zooms to the part but you can still see surrounding components — not a giant blurry rectangle that fills the screen.

- [ ] **Step 5: Commit**

```bash
git add src/frontend/src/renderer/BoardRenderer.ts
git commit -m "$(cat <<'EOF'
feat(renderer): cap focus-zoom at 3x fit-to-board scale

Tiny components (0402, 0201) used to zoom to ~50x and erase all
context. Adds a relative cap on top of the existing absolute 6x
ceiling so surroundings stay visible. Fit-to-board scale is
computed on demand without touching viewport state.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: panToPartIfOffscreen and panToNetIfOffscreen helpers

**Files:**
- Modify: `src/frontend/src/renderer/BoardRenderer.ts`

These are used when the user picks the `panIfOffscreen` mode in Settings — translate the camera only, no zoom change.

- [ ] **Step 1: Add the helpers near the `fitToBoard` method**

Below `fitToBoard` (around line 3966), append:

```ts
  /**
   * Returns true if the entire bbox is comfortably visible in the viewport.
   * Uses a small inset margin so the bbox never sits flush against the edge.
   */
  private bboxOnScreen(bounds: { minX: number; minY: number; maxX: number; maxY: number }, root?: Container): boolean {
    const sw = this.containerEl.clientWidth;
    const sh = this.containerEl.clientHeight;
    if (sw === 0 || sh === 0) return false;
    const insetPx = 24;
    const tl = this.sceneToWorld({ x: bounds.minX, y: bounds.minY }, root);
    const br = this.sceneToWorld({ x: bounds.maxX, y: bounds.maxY }, root);
    const screenTL = this.viewport.toScreen(tl.x, tl.y);
    const screenBR = this.viewport.toScreen(br.x, br.y);
    const minSX = Math.min(screenTL.x, screenBR.x);
    const maxSX = Math.max(screenTL.x, screenBR.x);
    const minSY = Math.min(screenTL.y, screenBR.y);
    const maxSY = Math.max(screenTL.y, screenBR.y);
    return minSX >= insetPx && maxSX <= sw - insetPx
        && minSY >= insetPx && maxSY <= sh - insetPx;
  }

  /**
   * Pan-only: translate the viewport so the bbox center lands at the screen
   * center. Scale is unchanged. Animated via the existing zoomAnim slot.
   */
  private panToBounds(bounds: { minX: number; minY: number; maxX: number; maxY: number }, root?: Container) {
    const sw = this.containerEl.clientWidth;
    const sh = this.containerEl.clientHeight;
    if (sw === 0 || sh === 0) return;
    const center = this.sceneToWorld({
      x: (bounds.minX + bounds.maxX) / 2,
      y: (bounds.minY + bounds.maxY) / 2,
    }, root);
    const toScaleX = this.viewport.scale.x;
    const toScaleY = this.viewport.scale.y;
    const toPosX = -center.x * toScaleX + sw / 2;
    const toPosY = -center.y * toScaleY + sh / 2;

    this.zoomAnim = {
      fromX: this.viewport.position.x,
      fromY: this.viewport.position.y,
      fromScaleX: toScaleX,
      fromScaleY: toScaleY,
      toX: toPosX,
      toY: toPosY,
      toScaleX,
      toScaleY,
      elapsed: 0,
      duration: 300,
    };
    if (!this.app.ticker.started) this.app.ticker.start();
  }

  /**
   * Pan to a part if any part of its bbox is outside the viewport. Otherwise
   * no-op. Used by the Parts dropdown when on-select = panIfOffscreen.
   */
  panToPartIfOffscreen(partIndex: number) {
    const part = this.board?.parts[partIndex];
    if (!part) return;
    const root = this.rootForPart(part);
    if (this.bboxOnScreen(part.bounds, root)) return;
    this.panToBounds(part.bounds, root);
  }

  /**
   * Pan to a net if its pin bbox is fully off-screen. Otherwise no-op.
   * Used by the Nets dropdown when on-select = panIfOffscreen.
   */
  panToNetIfOffscreen(netName: string) {
    if (!this.board) return;
    const net = this.board.nets.get(netName);
    if (!net || net.pinIndices.length === 0) return;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const { partIndex, pinIndex } of net.pinIndices) {
      const pin = this.board.parts[partIndex]?.pins[pinIndex];
      if (!pin) continue;
      if (pin.position.x < minX) minX = pin.position.x;
      if (pin.position.y < minY) minY = pin.position.y;
      if (pin.position.x > maxX) maxX = pin.position.x;
      if (pin.position.y > maxY) maxY = pin.position.y;
    }
    if (!isFinite(minX)) return;

    const bounds = { minX, minY, maxX, maxY };
    if (this.bboxOnScreen(bounds)) return;
    this.panToBounds(bounds);
  }
```

- [ ] **Step 2: Lint + typecheck**

Run: `cd src/frontend && npm run lint -- src/renderer/BoardRenderer.ts && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/frontend/src/renderer/BoardRenderer.ts
git commit -m "$(cat <<'EOF'
feat(renderer): add panToPart/NetIfOffscreen helpers

Used by the upcoming Parts/Nets dropdowns when the user picks the
'pan if off-screen' mode in Settings — translate without changing
zoom. No-ops when the bbox is already comfortably in view.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 2 — Slot extraction + registry walker (no behavior change)

This phase is a pure refactor: lift the existing toggle buttons out of `BoardViewerPanel.tsx` into one component file each, build the registry, swap in the registry walker. The user-visible UI is byte-identical at the end of this phase. Existing E2E tests act as regression guards.

### Task 5: Extract the seven toggle buttons into individual slot components

**Files:**
- Create: `src/frontend/src/components/overlay/slots/PdfFollowButton.tsx` and 6 siblings.
- Modify: `src/frontend/src/panels/BoardViewerPanel.tsx` (imports added; JSX unchanged this task)

The plan is: lift each `<button>` body verbatim into a small component, accepting a typed `ctx` prop. The components are not yet rendered via the registry — that swap happens in Task 7.

- [ ] **Step 1: Define the shared SlotCtx type**

Create `src/frontend/src/components/overlay/slot-ctx.ts`:

```ts
// src/frontend/src/components/overlay/slot-ctx.ts
import type React from 'react';
import type { BoardRenderer } from '../../renderer/BoardRenderer';

/**
 * Context handed to every overlay slot renderer. Keep this minimal — slots
 * that need anything else should import directly (stores are global anyway).
 */
export interface SlotCtx {
  tabId: number;
  thisTab: {
    netLineMode: 'off' | 'star' | 'chain';
    showNetDim: boolean;
    showHoverInfo: boolean;
    showGhosts: boolean;
    followPdf: boolean;
    pdfFileNames: readonly string[];
    fileName: string;
  };
  rendererRef: React.RefObject<BoardRenderer | null>;
  bareAction: 'pan' | 'zoom';
}
```

The structural-typed `thisTab` field lets us pass either a real `BoardTab` or a synthesised stub from the Settings preview without coupling.

- [ ] **Step 2: Create each slot component file**

For each of the seven, copy the existing `<button>` JSX from `BoardViewerPanel.tsx` (lines 230–298) verbatim, replacing local hooks/refs with `ctx.…` lookups.

`src/frontend/src/components/overlay/slots/PdfFollowButton.tsx`:

```tsx
import { boardStore } from '../../../store/board-store';
import type { SlotCtx } from '../slot-ctx';

export function PdfFollowButton({ ctx }: { ctx: SlotCtx }) {
  const { followPdf, pdfFileNames } = ctx.thisTab;
  return (
    <button
      className={`board-netlines-toggle ${followPdf ? 'active' : ''}`}
      onClick={() => boardStore.toggleFollowPdf()}
      disabled={pdfFileNames.length === 0}
      title={followPdf ? 'PDF follow: ON' : 'PDF follow: OFF'}
    >
      ⇶
    </button>
  );
}
```

`src/frontend/src/components/overlay/slots/ScrollModeButton.tsx`:

```tsx
import { IconHandMove, IconZoomIn } from '@tabler/icons-react';
import { invertScrollBindings } from '../../../store/scroll-mode';
import type { SlotCtx } from '../slot-ctx';

export function ScrollModeButton({ ctx }: { ctx: SlotCtx }) {
  return (
    <button
      className="board-netlines-toggle"
      onClick={invertScrollBindings}
      title={ctx.bareAction === 'pan'
        ? 'Scroll: Pan · Shift+Scroll: Zoom — click to swap'
        : 'Scroll: Zoom · Shift+Scroll: Pan — click to swap'}
    >
      {ctx.bareAction === 'pan' ? <IconHandMove size={16} /> : <IconZoomIn size={16} />}
    </button>
  );
}
```

`src/frontend/src/components/overlay/slots/FitBoardButton.tsx`:

```tsx
import { IconObjectScan } from '@tabler/icons-react';
import type { SlotCtx } from '../slot-ctx';

export function FitBoardButton({ ctx }: { ctx: SlotCtx }) {
  return (
    <button
      className="board-netlines-toggle"
      onClick={() => ctx.rendererRef.current?.fitToBoard()}
      title="Zoom to fit board"
    >
      <IconObjectScan size={16} />
    </button>
  );
}
```

`src/frontend/src/components/overlay/slots/HoverInfoButton.tsx`:

```tsx
import { IconTooltip } from '@tabler/icons-react';
import { boardStore } from '../../../store/board-store';
import type { SlotCtx } from '../slot-ctx';

export function HoverInfoButton({ ctx }: { ctx: SlotCtx }) {
  const { showHoverInfo } = ctx.thisTab;
  return (
    <button
      className={`board-netlines-toggle ${showHoverInfo ? 'active' : ''}`}
      onClick={() => boardStore.toggleHoverInfo()}
      title={showHoverInfo ? 'Hover info: ON' : 'Hover info: OFF'}
    >
      <IconTooltip size={16} />
    </button>
  );
}
```

`src/frontend/src/components/overlay/slots/NetDimButton.tsx`:

```tsx
import { boardStore } from '../../../store/board-store';
import type { SlotCtx } from '../slot-ctx';

export function NetDimButton({ ctx }: { ctx: SlotCtx }) {
  const { showNetDim } = ctx.thisTab;
  return (
    <button
      className={`board-netlines-toggle ${showNetDim ? 'active' : ''}`}
      onClick={() => boardStore.toggleNetDim()}
      title={showNetDim ? 'Selection dimming: ON' : 'Selection dimming: OFF'}
    >
      ◐
    </button>
  );
}
```

`src/frontend/src/components/overlay/slots/NetLinesButton.tsx`:

```tsx
import { IconHierarchy, IconHierarchyOff, IconChartDots3 } from '@tabler/icons-react';
import { boardStore } from '../../../store/board-store';
import type { SlotCtx } from '../slot-ctx';

export function NetLinesButton({ ctx }: { ctx: SlotCtx }) {
  const { netLineMode } = ctx.thisTab;
  return (
    <button
      className={`board-netlines-toggle ${netLineMode !== 'off' ? 'active' : ''}`}
      onClick={() => boardStore.cycleNetLineMode()}
      title={
        netLineMode === 'off'
          ? 'Net lines: off (click for star)'
          : netLineMode === 'star'
          ? 'Net lines: star — radiate from selected part (click for chain)'
          : 'Net lines: chain — nearest-neighbor MST (click to turn off)'
      }
    >
      {netLineMode === 'off' ? (
        <IconHierarchyOff size={16} />
      ) : netLineMode === 'star' ? (
        <IconHierarchy size={16} />
      ) : (
        <IconChartDots3 size={16} />
      )}
    </button>
  );
}
```

`src/frontend/src/components/overlay/slots/GhostsButton.tsx`:

```tsx
import { IconGhost2 } from '@tabler/icons-react';
import { boardStore } from '../../../store/board-store';
import type { SlotCtx } from '../slot-ctx';

export function GhostsButton({ ctx }: { ctx: SlotCtx }) {
  const { showGhosts } = ctx.thisTab;
  return (
    <button
      className={`board-netlines-toggle ${showGhosts ? 'active' : ''}`}
      onClick={() => boardStore.toggleGhosts()}
      title={showGhosts ? 'Hidden-side ghosts: ON' : 'Hidden-side ghosts: OFF'}
    >
      <IconGhost2 size={16} />
    </button>
  );
}
```

- [ ] **Step 3: Lint + typecheck**

Run: `cd src/frontend && npm run lint -- src/components/overlay && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/frontend/src/components/overlay/
git commit -m "$(cat <<'EOF'
refactor(overlay): extract toggle buttons into per-slot components

Lifts the seven board-status-indicators buttons out of
BoardViewerPanel into individual files under
components/overlay/slots/. Pure code-move — JSX is verbatim,
behavior is unchanged. Sets up the registry walker landing in a
follow-up commit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Add the Separator slot component

**Files:**
- Create: `src/frontend/src/components/overlay/slots/Separator.tsx`
- Modify: `src/frontend/src/index.css`

- [ ] **Step 1: Create the Separator component**

```tsx
// src/frontend/src/components/overlay/slots/Separator.tsx
export function Separator() {
  return <div className="overlay-sep" aria-hidden />;
}
```

- [ ] **Step 2: Add the CSS**

Find the `.board-status-indicators` rule in `src/frontend/src/index.css` (search with grep). Below it, add:

```css
.overlay-sep {
  width: 12px;
  flex-shrink: 0;
}
```

- [ ] **Step 3: Lint**

Run: `cd src/frontend && npm run lint -- src/components/overlay`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/frontend/src/components/overlay/slots/Separator.tsx src/frontend/src/index.css
git commit -m "$(cat <<'EOF'
feat(overlay): add Separator slot component

Cosmetic 12px spacer used by sep1/sep2 to reproduce the existing
visual gaps between overlay button groups.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Slot renderers registry + swap BoardViewerPanel to use it

**Files:**
- Create: `src/frontend/src/components/overlay/slot-renderers.tsx`
- Modify: `src/frontend/src/panels/BoardViewerPanel.tsx`

This is the only behavior-affecting commit in Phase 2. After this task, the overlay is rendered by walking `overlayLayout` instead of hand-written JSX, but the result is byte-identical because `DEFAULT_OVERLAY_LAYOUT` matches today's order. The new `partsDropdown` / `netsDropdown` slots render a placeholder `null` for now — the real components land in Phase 3.

- [ ] **Step 1: Create the registry**

```tsx
// src/frontend/src/components/overlay/slot-renderers.tsx
import { Fragment, type ReactNode } from 'react';
import type { OverlaySlotId } from '../../store/overlay-layout';
import type { SlotCtx } from './slot-ctx';
import { PdfFollowButton }  from './slots/PdfFollowButton';
import { ScrollModeButton } from './slots/ScrollModeButton';
import { FitBoardButton }   from './slots/FitBoardButton';
import { HoverInfoButton }  from './slots/HoverInfoButton';
import { NetDimButton }     from './slots/NetDimButton';
import { NetLinesButton }   from './slots/NetLinesButton';
import { GhostsButton }     from './slots/GhostsButton';
import { Separator }        from './slots/Separator';

/**
 * Returns the rendered ReactNode for a given slot id. Returns null for
 * slots that are not yet implemented (partsDropdown / netsDropdown land
 * in a follow-up commit). Used by both the live overlay walker and the
 * Settings customizer preview.
 */
export function renderOverlaySlot(id: OverlaySlotId, ctx: SlotCtx): ReactNode {
  switch (id) {
    case 'pdfFollow':     return <PdfFollowButton  ctx={ctx} />;
    case 'scrollMode':    return <ScrollModeButton ctx={ctx} />;
    case 'fitBoard':      return <FitBoardButton   ctx={ctx} />;
    case 'hoverInfo':     return <HoverInfoButton  ctx={ctx} />;
    case 'netDim':        return <NetDimButton     ctx={ctx} />;
    case 'netLines':      return <NetLinesButton   ctx={ctx} />;
    case 'ghosts':        return <GhostsButton     ctx={ctx} />;
    case 'sep1':          return <Separator />;
    case 'sep2':          return <Separator />;
    case 'partsDropdown': return null;  // implemented in Phase 3
    case 'netsDropdown':  return null;  // implemented in Phase 3
  }
}

export function renderOverlayLayout(
  layout: ReadonlyArray<{ id: OverlaySlotId; visible: boolean }>,
  ctx: SlotCtx,
): ReactNode[] {
  return layout
    .filter(s => s.visible)
    .map(s => <Fragment key={s.id}>{renderOverlaySlot(s.id, ctx)}</Fragment>);
}
```

- [ ] **Step 2: Replace `board-status-indicators` JSX in BoardViewerPanel**

Open `src/frontend/src/panels/BoardViewerPanel.tsx`. Replace the entire `<div className="board-status-indicators">…</div>` block (around lines 229–298) with:

```tsx
      <div className="board-status-indicators">
        {renderOverlayLayout(renderSettings.overlayLayout, slotCtx)}
      </div>
```

Add to the imports at the top of the file:

```tsx
import { renderOverlayLayout } from '../components/overlay/slot-renderers';
import { useRenderSettings } from '../hooks/useRenderSettings';
import type { SlotCtx } from '../components/overlay/slot-ctx';
```

(If `useRenderSettings` doesn't exist yet, use the bare `renderSettingsStore.settings` import and `useSyncExternalStore` shim — check the `useBoardStore` pattern at the top of the file. Either way, the component must re-render when overlay layout changes.)

Inside the component body, before the `return`, add:

```tsx
  const renderSettings = useRenderSettings();
  const slotCtx: SlotCtx = {
    tabId: tabId!,
    thisTab: {
      netLineMode,
      showNetDim,
      showHoverInfo,
      showGhosts,
      followPdf,
      pdfFileNames: linkedPdfs,
      fileName: tabFileName,
    },
    rendererRef,
    bareAction,
  };
```

(Place this right before the `if (tabId == null)` early return so all the variables it references are already in scope.)

- [ ] **Step 3: Create useRenderSettings hook**

`useRenderSettings` does not exist yet — create it using the existing `createStoreHook` factory (same pattern as `useBoardStore.ts`):

```ts
// src/frontend/src/hooks/useRenderSettings.ts
import { renderSettingsStore } from '../store/render-settings';
import { createStoreHook } from './createStoreHook';
import type { RenderSettings } from '../store/render-settings';

/**
 * Hook returning the current effective render settings. Snapshot is rebuilt
 * only when the store notifies, courtesy of createStoreHook's version
 * counter (satisfies useSyncExternalStore's stable-reference requirement).
 */
export const useRenderSettings = createStoreHook<RenderSettings>(
  renderSettingsStore,
  () => renderSettingsStore.settings,
);
```

If `renderSettingsStore.settings` is not exported as a getter that returns the stable `_effective` object, expose it now (look near `globalSnapshot()` — `settings` should already exist as a getter; if it returns `structuredClone(this._effective)` instead of `this._effective`, change it to return the cached object since `createStoreHook` handles caching itself). Confirm `RenderSettings` is exported from `render-settings.ts`; if not, export it.

- [ ] **Step 4: Run the existing E2E tests as a regression check**

Run: `cd src/frontend && npx playwright test --project=chromium`
Expected: all existing tests still pass. The overlay buttons must look and behave identically to before this task.

- [ ] **Step 5: Commit**

```bash
git add src/frontend/src/components/overlay/slot-renderers.tsx \
        src/frontend/src/panels/BoardViewerPanel.tsx \
        src/frontend/src/hooks/useRenderSettings.ts  # only if newly created
git commit -m "$(cat <<'EOF'
refactor(overlay): render board overlay via slot registry

BoardViewerPanel no longer hand-writes the seven toggle buttons —
they're walked from renderSettings.overlayLayout via the
renderOverlaySlot registry. UI is byte-identical (default layout
matches the old hardcoded order). Sets up Phase 3 to drop in the
Parts/Nets dropdowns without further BoardViewerPanel edits.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 3 — Search dropdowns + selected-name label

### Task 8: Natural-sort comparator

**Files:**
- Create: `src/frontend/src/components/overlay/natural-sort.ts`
- Modify: `src/frontend/src/store/render-settings.ts` (extend the `__overlayTest` exposure)
- Modify: `src/frontend/tests/overlay-customizer.spec.ts`

- [ ] **Step 1: Write the comparator**

```ts
// src/frontend/src/components/overlay/natural-sort.ts
/**
 * Natural-order string comparator: split each input into runs of digits
 * and runs of non-digits, compare runs pairwise (digits as numbers,
 * non-digits as case-insensitive strings). Yields R1 < R2 < R10.
 *
 * Locale-agnostic. Stable for inputs that differ only in case (uses
 * lowercased compare). For long inputs the regex split runs once per
 * call — caller is responsible for memoizing if hot.
 */
export function naturalCompare(a: string, b: string): number {
  if (a === b) return 0;
  const al = a.toLowerCase();
  const bl = b.toLowerCase();
  const re = /(\d+)|(\D+)/g;
  const aTokens = al.match(re) ?? [];
  const bTokens = bl.match(re) ?? [];
  const len = Math.min(aTokens.length, bTokens.length);
  for (let i = 0; i < len; i++) {
    const ai = aTokens[i];
    const bi = bTokens[i];
    const aNum = /^\d+$/.test(ai);
    const bNum = /^\d+$/.test(bi);
    if (aNum && bNum) {
      const an = parseInt(ai, 10);
      const bn = parseInt(bi, 10);
      if (an !== bn) return an - bn;
      // equal numbers but different padding — fall back to string compare
      if (ai !== bi) return ai < bi ? -1 : 1;
    } else if (aNum !== bNum) {
      // digit run sorts before alpha run
      return aNum ? -1 : 1;
    } else {
      if (ai !== bi) return ai < bi ? -1 : 1;
    }
  }
  return aTokens.length - bTokens.length;
}
```

- [ ] **Step 2: Expose to DEV window for tests**

In `src/frontend/src/store/render-settings.ts`, find the `__overlayTest` exposure added in Task 2. Extend it:

```ts
import { naturalCompare } from '../components/overlay/natural-sort';
// ...
if (typeof window !== 'undefined' && import.meta.env.DEV) {
  (window as Window & { __overlayTest?: {
    reconcileOverlayLayout: typeof reconcileOverlayLayout;
    naturalCompare: typeof naturalCompare;
  } }).__overlayTest = { reconcileOverlayLayout, naturalCompare };
}
```

- [ ] **Step 3: Add Playwright tests for the comparator**

Append to `src/frontend/tests/overlay-customizer.spec.ts`:

```ts
test.describe('Natural sort comparator', () => {
  test('sorts refdes-style names numerically', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    const sorted = await page.evaluate(() => {
      const win = window as Window & { __overlayTest?: { naturalCompare: (a: string, b: string) => number } };
      return ['R10', 'R1', 'R2', 'R100'].sort(win.__overlayTest!.naturalCompare);
    });
    expect(sorted).toEqual(['R1', 'R2', 'R10', 'R100']);
  });

  test('mixes alpha prefixes correctly', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    const sorted = await page.evaluate(() => {
      const win = window as Window & { __overlayTest?: { naturalCompare: (a: string, b: string) => number } };
      return ['U21', 'C1', 'R10', 'C2', 'U1'].sort(win.__overlayTest!.naturalCompare);
    });
    expect(sorted).toEqual(['C1', 'C2', 'R10', 'U1', 'U21']);
  });

  test('handles all-numeric and all-alpha inputs', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    const result = await page.evaluate(() => {
      const win = window as Window & { __overlayTest?: { naturalCompare: (a: string, b: string) => number } };
      const cmp = win.__overlayTest!.naturalCompare;
      return [cmp('100', '20'), cmp('GND', 'VCC'), cmp('R1', 'R1')];
    });
    expect(result[0]).toBeGreaterThan(0);
    expect(result[1]).toBeLessThan(0);
    expect(result[2]).toBe(0);
  });
});
```

- [ ] **Step 4: Run the tests**

Run: `cd src/frontend && npx playwright test overlay-customizer.spec.ts --project=chromium`
Expected: all 6 tests pass (3 from Task 2 + 3 new).

- [ ] **Step 5: Commit**

```bash
git add src/frontend/src/components/overlay/natural-sort.ts \
        src/frontend/src/store/render-settings.ts \
        src/frontend/tests/overlay-customizer.spec.ts
git commit -m "$(cat <<'EOF'
feat(overlay): natural-sort comparator for refdes/net names

R1 < R2 < R10. Handles digit-only, alpha-only, and mixed runs.
Exposed via window.__overlayTest for Playwright coverage.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Pre-computed parts/nets index per board

**Files:**
- Create: `src/frontend/src/components/overlay/get-overlay-index.ts`

- [ ] **Step 1: Implement the memoized index builder**

```ts
// src/frontend/src/components/overlay/get-overlay-index.ts
import type { BoardData } from '../../parsers/types';
import { isNcNet } from '../../store/render-settings';
import { naturalCompare } from './natural-sort';

export interface OverlayIndexRow { name: string; nameLower: string }

export interface OverlayIndex {
  parts: OverlayIndexRow[];
  netsNormal: OverlayIndexRow[];
  netsNc: OverlayIndexRow[];
}

interface CacheEntry { ncSig: string; index: OverlayIndex }

/**
 * Cache keyed by the BoardData object identity. WeakMap so cache is
 * automatically reclaimed when boards are unloaded. Recomputes when
 * `ncPatterns` change (cheap stringify check) — the user can edit NC
 * patterns in Settings and the dropdown updates on next open.
 */
const cache = new WeakMap<BoardData, CacheEntry>();

function buildIndex(board: BoardData, ncPatterns: readonly string[]): OverlayIndex {
  const parts: OverlayIndexRow[] = board.parts.map(p => ({
    name: p.name,
    nameLower: p.name.toLowerCase(),
  }));
  parts.sort((a, b) => naturalCompare(a.name, b.name));

  const netsNormal: OverlayIndexRow[] = [];
  const netsNc: OverlayIndexRow[] = [];
  for (const name of board.nets.keys()) {
    const row = { name, nameLower: name.toLowerCase() };
    (isNcNet(name.toUpperCase(), ncPatterns) ? netsNc : netsNormal).push(row);
  }
  netsNormal.sort((a, b) => naturalCompare(a.name, b.name));
  netsNc.sort((a, b) => naturalCompare(a.name, b.name));

  return { parts, netsNormal, netsNc };
}

/**
 * Returns a pre-sorted, NC-partitioned, lowercase-paired index of the
 * board's parts and nets. Rebuilt only when the board reference changes
 * or the NC patterns differ from last call for that board.
 */
export function getOverlayIndex(board: BoardData, ncPatterns: readonly string[]): OverlayIndex {
  const sig = ncPatterns.join('');
  const hit = cache.get(board);
  if (hit && hit.ncSig === sig) return hit.index;
  const index = buildIndex(board, ncPatterns);
  cache.set(board, { ncSig: sig, index });
  return index;
}
```

- [ ] **Step 2: Lint + typecheck**

Run: `cd src/frontend && npm run lint -- src/components/overlay && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/frontend/src/components/overlay/get-overlay-index.ts
git commit -m "$(cat <<'EOF'
feat(overlay): memoized parts/nets index for dropdowns

WeakMap-keyed by BoardData. Pre-sorts naturally, lowercases once,
and partitions NC nets via the existing isNcNet matcher. Rebuilds
when NC patterns change so Settings edits stay live.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Shared dropdown popover scaffold

**Files:**
- Create: `src/frontend/src/components/overlay/dropdown-popover.tsx`
- Modify: `src/frontend/src/index.css`

- [ ] **Step 1: Implement the scaffold**

```tsx
// src/frontend/src/components/overlay/dropdown-popover.tsx
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { OverlayIndexRow } from './get-overlay-index';

const MAX_RENDERED_ROWS = 500;

export interface DropdownPopoverRow {
  /** The actual list entry; passed back on selection */
  row: OverlayIndexRow;
  /** Reduced-opacity styling (e.g. NC nets) */
  dimmed?: boolean;
}

export interface DropdownPopoverGroup {
  /** Optional header string — null hides the divider, useful when only one group is rendered. */
  header: string | null;
  rows: DropdownPopoverRow[];
}

export interface DropdownPopoverProps {
  /** Builds the list groups from the current filter (already lower-cased). Pure. */
  buildGroups: (queryLower: string) => DropdownPopoverGroup[];
  /** Called with the picked row's name (original case). */
  onSelect: (name: string) => void;
  /** Closes the popover. Called on Esc, outside click, or after selection. */
  onClose: () => void;
  /** Placeholder text in the filter input. */
  placeholder?: string;
}

/**
 * Filter input + grouped list with keyboard navigation. Used by Parts and
 * Nets dropdowns. Caps rendered rows at MAX_RENDERED_ROWS — anything past
 * shows a "… and N more — refine your search" footer.
 */
export function DropdownPopover({ buildGroups, onSelect, onClose, placeholder }: DropdownPopoverProps) {
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const onDocMouseDown = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [onClose]);

  const groups = buildGroups(query.toLowerCase().trim());
  const flatRows: DropdownPopoverRow[] = groups.flatMap(g => g.rows);
  const overflow = flatRows.length > MAX_RENDERED_ROWS;
  const cappedFlat = overflow ? flatRows.slice(0, MAX_RENDERED_ROWS) : flatRows;

  // Re-clamp highlight when filter shrinks the list
  useEffect(() => {
    if (highlight >= cappedFlat.length) setHighlight(0);
  }, [cappedFlat.length, highlight]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      const r = cappedFlat[highlight];
      if (r) { onSelect(r.row.name); onClose(); }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight(h => Math.min(h + 1, cappedFlat.length - 1));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight(h => Math.max(h - 1, 0));
    }
  };

  // Scroll highlight into view
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-row-idx="${highlight}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [highlight]);

  // Build the rendered list with group headers + flat indices for highlight tracking
  const rendered: ReactNode[] = [];
  let flatIdx = 0;
  for (let g = 0; g < groups.length; g++) {
    const group = groups[g];
    if (group.rows.length === 0) continue;
    if (group.header && g > 0) {
      rendered.push(
        <div key={`hdr-${g}`} className="overlay-dropdown-group-header">{group.header}</div>
      );
    }
    for (const r of group.rows) {
      if (flatIdx >= MAX_RENDERED_ROWS) break;
      const i = flatIdx;
      rendered.push(
        <button
          key={`${group.header ?? ''}-${r.row.name}`}
          data-row-idx={i}
          className={`overlay-dropdown-row${r.dimmed ? ' dimmed' : ''}${i === highlight ? ' highlighted' : ''}`}
          onMouseEnter={() => setHighlight(i)}
          onClick={() => { onSelect(r.row.name); onClose(); }}
        >
          {r.row.name}
        </button>
      );
      flatIdx++;
    }
    if (flatIdx >= MAX_RENDERED_ROWS) break;
  }

  return (
    <div ref={popoverRef} className="overlay-dropdown-popover" onKeyDown={onKeyDown}>
      <input
        ref={inputRef}
        className="overlay-dropdown-input"
        type="text"
        value={query}
        onChange={e => setQuery(e.target.value)}
        placeholder={placeholder ?? 'Filter…'}
      />
      <div ref={listRef} className="overlay-dropdown-list">
        {rendered.length === 0
          ? <div className="overlay-dropdown-empty">No matches</div>
          : rendered}
        {overflow && (
          <div className="overlay-dropdown-overflow">
            … and {flatRows.length - MAX_RENDERED_ROWS} more — refine your search
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add CSS for the popover**

Append to `src/frontend/src/index.css`:

```css
.overlay-dropdown-popover {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  width: 280px;
  max-height: 400px;
  display: flex;
  flex-direction: column;
  background: var(--bg-secondary, #1a1a2e);
  border: 1px solid var(--border-primary, #333);
  border-radius: 4px;
  box-shadow: 0 4px 16px rgba(0,0,0,0.4);
  z-index: 100;
}
.overlay-dropdown-input {
  flex: 0 0 auto;
  margin: 6px;
  padding: 6px 8px;
  background: var(--bg-primary, #0f0f1a);
  color: var(--text-primary, #ddd);
  border: 1px solid var(--border-primary, #333);
  border-radius: 3px;
  font-size: 12px;
  outline: none;
}
.overlay-dropdown-input:focus {
  border-color: var(--accent, #88f);
}
.overlay-dropdown-list {
  flex: 1 1 auto;
  overflow-y: auto;
  padding: 0 0 4px;
}
.overlay-dropdown-row {
  display: block;
  width: 100%;
  text-align: left;
  padding: 4px 12px;
  background: transparent;
  border: 0;
  color: var(--text-primary, #ddd);
  font-size: 12px;
  cursor: pointer;
}
.overlay-dropdown-row.highlighted {
  background: var(--bg-hover, rgba(255,255,255,0.06));
}
.overlay-dropdown-row.dimmed {
  opacity: 0.45;
}
.overlay-dropdown-group-header {
  padding: 6px 12px 2px;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-muted, #888);
  border-top: 1px solid var(--border-primary, #333);
  margin-top: 4px;
}
.overlay-dropdown-empty,
.overlay-dropdown-overflow {
  padding: 8px 12px;
  font-size: 11px;
  color: var(--text-muted, #888);
  font-style: italic;
}
```

- [ ] **Step 3: Lint + typecheck**

Run: `cd src/frontend && npm run lint -- src/components/overlay && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/frontend/src/components/overlay/dropdown-popover.tsx \
        src/frontend/src/index.css
git commit -m "$(cat <<'EOF'
feat(overlay): shared dropdown popover scaffold

Filter input + scrollable grouped list + keyboard nav (↑/↓/Enter/
Esc). Caps rendered rows at 500 with overflow footer. Used by both
Parts and Nets dropdowns.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: PartsDropdown component

**Files:**
- Create: `src/frontend/src/components/overlay/slots/PartsDropdown.tsx`
- Modify: `src/frontend/src/components/overlay/slot-renderers.tsx`

- [ ] **Step 1: Implement the dropdown**

```tsx
// src/frontend/src/components/overlay/slots/PartsDropdown.tsx
import { useRef, useState } from 'react';
import { boardStore } from '../../../store/board-store';
import { renderSettingsStore } from '../../../store/render-settings';
import { useBoardStore } from '../../../hooks/useBoardStore';
import { useRenderSettings } from '../../../hooks/useRenderSettings';
import { DropdownPopover, type DropdownPopoverGroup } from '../dropdown-popover';
import { getOverlayIndex } from '../get-overlay-index';
import type { SlotCtx } from '../slot-ctx';

export function PartsDropdown({ ctx }: { ctx: SlotCtx }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const { tabs } = useBoardStore();
  const settings = useRenderSettings();
  const tab = tabs.find(t => t.id === ctx.tabId);
  const board = tab?.board;

  if (!board) {
    return <button className="board-netlines-toggle" disabled title="No board loaded">Parts ▾</button>;
  }

  const idx = getOverlayIndex(board, settings.ncNetPatterns);

  const buildGroups = (q: string): DropdownPopoverGroup[] => {
    const rows = q
      ? idx.parts.filter(p => p.nameLower.includes(q))
      : idx.parts;
    return [{ header: null, rows: rows.map(row => ({ row })) }];
  };

  const onSelect = (name: string) => {
    const mode = renderSettingsStore.settings.overlayPartsOnSelect;
    if (mode === 'panZoomFit') {
      boardStore.focusPart(name);
      return;
    }
    const partIdx = board.parts.findIndex(p => p.name === name);
    if (partIdx < 0) return;
    boardStore.selectPart(partIdx);
    if (mode === 'panIfOffscreen') {
      ctx.rendererRef.current?.panToPartIfOffscreen(partIdx);
    }
  };

  return (
    <div ref={wrapRef} className="overlay-dropdown-wrap">
      <button
        className={`board-netlines-toggle ${open ? 'active' : ''}`}
        onClick={() => setOpen(v => !v)}
        title="Find part by name"
        data-testid="parts-dropdown-button"
      >
        Parts ▾
      </button>
      {open && (
        <DropdownPopover
          buildGroups={buildGroups}
          onSelect={onSelect}
          onClose={() => setOpen(false)}
          placeholder="Filter parts…"
        />
      )}
    </div>
  );
}
```

- [ ] **Step 2: Wire into the registry**

Edit `src/frontend/src/components/overlay/slot-renderers.tsx`:

- Add `import { PartsDropdown } from './slots/PartsDropdown';` near the other slot imports.
- Replace `case 'partsDropdown': return null;` with `case 'partsDropdown': return <PartsDropdown ctx={ctx} />;`.

- [ ] **Step 3: Add CSS for the wrap**

Append to `src/frontend/src/index.css`:

```css
.overlay-dropdown-wrap {
  position: relative;
  display: inline-block;
}
```

- [ ] **Step 4: Add an E2E test**

Append to `src/frontend/tests/overlay-customizer.spec.ts`:

```ts
test.describe('Parts dropdown', () => {
  test('opens, filters, and focuses a part on selection', async ({ page }) => {
    await loadBoard(page);
    await page.waitForSelector('[data-testid="parts-dropdown-button"]');

    await page.click('[data-testid="parts-dropdown-button"]');
    await page.waitForSelector('.overlay-dropdown-popover');

    await page.fill('.overlay-dropdown-input', 'U1');
    // First match should be U1, U10, U100... — Enter selects the highlighted (top) row.
    await page.keyboard.press('Enter');

    // Selected name should be reflected in the StatusBar
    const status = await page.locator('.statusbar').textContent();
    expect(status).toMatch(/Selected:\s*U1\b/);
  });
});
```

If the project lacks a `?sample=` query loader, replace the `page.goto(...)` with whatever the existing test specs use to open a board (search `tests/comprehensive.spec.ts` for the pattern). Keep the test focused on dropdown → selection — board loading is a precondition.

- [ ] **Step 5: Run the test**

Run: `cd src/frontend && npx playwright test overlay-customizer.spec.ts --project=chromium`
Expected: the new "Parts dropdown" test passes alongside the existing 6.

- [ ] **Step 6: Commit**

```bash
git add src/frontend/src/components/overlay/slots/PartsDropdown.tsx \
        src/frontend/src/components/overlay/slot-renderers.tsx \
        src/frontend/src/index.css \
        src/frontend/tests/overlay-customizer.spec.ts
git commit -m "$(cat <<'EOF'
feat(overlay): Parts filter dropdown

Click the Parts ▾ button in the overlay, type a refdes substring,
press Enter or click a row to focus that part. Honors the
overlayPartsOnSelect mode (highlight / panIfOffscreen / panZoomFit).
Default panZoomFit reuses boardStore.focusPart so behavior matches
the existing PDF search lookup.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: NetsDropdown component (with NC partition)

**Files:**
- Create: `src/frontend/src/components/overlay/slots/NetsDropdown.tsx`
- Modify: `src/frontend/src/components/overlay/slot-renderers.tsx`

- [ ] **Step 1: Implement the dropdown**

```tsx
// src/frontend/src/components/overlay/slots/NetsDropdown.tsx
import { useRef, useState } from 'react';
import { boardStore } from '../../../store/board-store';
import { renderSettingsStore } from '../../../store/render-settings';
import { useBoardStore } from '../../../hooks/useBoardStore';
import { useRenderSettings } from '../../../hooks/useRenderSettings';
import { DropdownPopover, type DropdownPopoverGroup } from '../dropdown-popover';
import { getOverlayIndex } from '../get-overlay-index';
import type { SlotCtx } from '../slot-ctx';

export function NetsDropdown({ ctx }: { ctx: SlotCtx }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const { tabs } = useBoardStore();
  const settings = useRenderSettings();
  const tab = tabs.find(t => t.id === ctx.tabId);
  const board = tab?.board;

  if (!board) {
    return <button className="board-netlines-toggle" disabled title="No board loaded">Nets ▾</button>;
  }

  const idx = getOverlayIndex(board, settings.ncNetPatterns);

  const buildGroups = (q: string): DropdownPopoverGroup[] => {
    const normalRows = (q ? idx.netsNormal.filter(n => n.nameLower.includes(q)) : idx.netsNormal)
      .map(row => ({ row }));
    const ncRows = (q ? idx.netsNc.filter(n => n.nameLower.includes(q)) : idx.netsNc)
      .map(row => ({ row, dimmed: true }));
    const groups: DropdownPopoverGroup[] = [];
    if (normalRows.length > 0) groups.push({ header: null, rows: normalRows });
    if (ncRows.length > 0)     groups.push({ header: 'No connect', rows: ncRows });
    return groups;
  };

  const onSelect = (name: string) => {
    const mode = renderSettingsStore.settings.overlayNetsOnSelect;
    if (mode === 'panZoomFit') {
      boardStore.focusNet(name);
      return;
    }
    boardStore.highlightNet(name);
    if (mode === 'panIfOffscreen') {
      ctx.rendererRef.current?.panToNetIfOffscreen(name);
    }
  };

  return (
    <div ref={wrapRef} className="overlay-dropdown-wrap">
      <button
        className={`board-netlines-toggle ${open ? 'active' : ''}`}
        onClick={() => setOpen(v => !v)}
        title="Find net by name"
        data-testid="nets-dropdown-button"
      >
        Nets ▾
      </button>
      {open && (
        <DropdownPopover
          buildGroups={buildGroups}
          onSelect={onSelect}
          onClose={() => setOpen(false)}
          placeholder="Filter nets…"
        />
      )}
    </div>
  );
}
```

- [ ] **Step 2: Wire into the registry**

Edit `src/frontend/src/components/overlay/slot-renderers.tsx`:

- Add `import { NetsDropdown } from './slots/NetsDropdown';`.
- Replace `case 'netsDropdown': return null;` with `case 'netsDropdown': return <NetsDropdown ctx={ctx} />;`.

- [ ] **Step 3: Add an E2E test**

Append to `src/frontend/tests/overlay-customizer.spec.ts`:

```ts
test.describe('Nets dropdown', () => {
  test('NC nets render at end with reduced opacity', async ({ page }) => {
    await loadBoard(page);
    await page.waitForSelector('[data-testid="nets-dropdown-button"]');

    await page.click('[data-testid="nets-dropdown-button"]');
    await page.waitForSelector('.overlay-dropdown-popover');

    // The NC group header should appear after at least one normal row
    const headerExists = await page.locator('.overlay-dropdown-group-header').count();
    if (headerExists > 0) {
      const dimmedCount = await page.locator('.overlay-dropdown-row.dimmed').count();
      expect(dimmedCount).toBeGreaterThan(0);

      // Confirm dimmed rows appear AFTER non-dimmed rows in DOM order
      const order = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('.overlay-dropdown-row')) as HTMLElement[];
        return rows.map(r => r.classList.contains('dimmed'));
      });
      const lastNormal = order.lastIndexOf(false);
      const firstDimmed = order.indexOf(true);
      expect(firstDimmed).toBeGreaterThan(lastNormal);
    }
  });

  test('selecting a net highlights it', async ({ page }) => {
    await loadBoard(page);
    await page.waitForSelector('[data-testid="nets-dropdown-button"]');

    await page.click('[data-testid="nets-dropdown-button"]');
    await page.fill('.overlay-dropdown-input', 'GND');
    await page.keyboard.press('Enter');

    const status = await page.locator('.statusbar').textContent();
    expect(status).toMatch(/Net:\s*GND\b/i);
  });
});
```

- [ ] **Step 4: Run the tests**

Run: `cd src/frontend && npx playwright test overlay-customizer.spec.ts --project=chromium`
Expected: the two new "Nets dropdown" tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/frontend/src/components/overlay/slots/NetsDropdown.tsx \
        src/frontend/src/components/overlay/slot-renderers.tsx \
        src/frontend/tests/overlay-customizer.spec.ts
git commit -m "$(cat <<'EOF'
feat(overlay): Nets filter dropdown with NC partition

NC-matching nets (per renderSettings.ncNetPatterns) are routed to
a trailing 'No connect' group rendered at reduced opacity. Default
panZoomFit mode delegates to boardStore.focusNet — same behavior
as the PDF search lookup path.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: SelectedNameLabel component

**Files:**
- Create: `src/frontend/src/components/overlay/SelectedNameLabel.tsx`
- Modify: `src/frontend/src/panels/BoardViewerPanel.tsx`
- Modify: `src/frontend/src/index.css`

- [ ] **Step 1: Implement the label**

```tsx
// src/frontend/src/components/overlay/SelectedNameLabel.tsx
import { useBoardStore } from '../../hooks/useBoardStore';

export function SelectedNameLabel() {
  const { selectedPart, selectedPin, selection } = useBoardStore();
  const highlightedNet = selection.highlightedNet;

  let text: string | null = null;
  if (selectedPin && selectedPart) {
    text = `${selectedPart.name} · pin ${selectedPin.name} → ${selectedPin.net || '(unconnected)'}`;
  } else if (selectedPart) {
    text = selectedPart.name;
  } else if (highlightedNet) {
    text = highlightedNet;
  }

  if (!text) return null;
  return <div className="overlay-selected-name" data-testid="overlay-selected-name">{text}</div>;
}
```

- [ ] **Step 2: Render the label below the overlay row in BoardViewerPanel**

In `src/frontend/src/panels/BoardViewerPanel.tsx`, find the `<div className="board-status-indicators">…</div>` block. Below it (still inside the panel root), add:

```tsx
      {renderSettings.overlaySelectedNameVisible && <SelectedNameLabel />}
```

Add the import at the top:

```tsx
import { SelectedNameLabel } from '../components/overlay/SelectedNameLabel';
```

- [ ] **Step 3: Add CSS matching the existing overlay text styling**

Append to `src/frontend/src/index.css`:

```css
.overlay-selected-name {
  position: absolute;
  /* Align with the .board-status-indicators row above. The exact top
     value depends on the existing overlay row height — match by
     measuring or grepping the .board-status-indicators rule. */
  top: calc(var(--overlay-row-height, 36px) + 6px);
  left: 8px;
  padding: 2px 8px;
  font-size: 11px;
  color: var(--text-primary, #ddd);
  background: rgba(0, 0, 0, 0.55);
  border-radius: 3px;
  pointer-events: none;
  z-index: 5;
  white-space: nowrap;
}
```

If `.board-status-indicators` already defines its own `top` and `height`, eyeball the actual pixel offset by running the dev server and adjusting `top:` so the label sits flush below the buttons.

- [ ] **Step 4: Add an E2E test**

Append to `src/frontend/tests/overlay-customizer.spec.ts`:

```ts
test.describe('Selected-name label', () => {
  test('label appears when a part is selected and hides when cleared', async ({ page }) => {
    await loadBoard(page);
    await page.waitForSelector('[data-testid="parts-dropdown-button"]');

    await expect(page.locator('[data-testid="overlay-selected-name"]')).toHaveCount(0);

    await page.click('[data-testid="parts-dropdown-button"]');
    await page.fill('.overlay-dropdown-input', 'U1');
    await page.keyboard.press('Enter');

    await expect(page.locator('[data-testid="overlay-selected-name"]')).toContainText(/U1\b/);
  });
});
```

- [ ] **Step 5: Run the tests**

Run: `cd src/frontend && npx playwright test overlay-customizer.spec.ts --project=chromium`
Expected: new "Selected-name label" test passes.

- [ ] **Step 6: Commit**

```bash
git add src/frontend/src/components/overlay/SelectedNameLabel.tsx \
        src/frontend/src/panels/BoardViewerPanel.tsx \
        src/frontend/src/index.css \
        src/frontend/tests/overlay-customizer.spec.ts
git commit -m "$(cat <<'EOF'
feat(overlay): selected-component-name label below toolbar

Renders the current part / pin / highlighted net in the overlay,
right under the button row. Visibility gated by
overlaySelectedNameVisible (default true). StatusBar duplicate
display intentional — the overlay label is a near-the-cursor
glance.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 4 — Settings customizer

### Task 14: Settings section shell + visibility checkbox + on-select segmented controls

**Files:**
- Create: `src/frontend/src/panels/settings/OverlayCustomizer.tsx`
- Modify: `src/frontend/src/panels/SettingsPanel.tsx`
- Modify: `src/frontend/src/store/render-settings.ts`

This task adds the "Board overlay" section with two of the three subsections. The DnD customizer lands in Task 15.

- [ ] **Step 1: Add setter methods to RenderSettingsStore**

The store already uses `_global` + `saveToStorage(this._global)` + `recomputeEffective()` + `notify()` for global mutations (see `applyGlobal` and `resetGlobal`). Add five sibling setters in the "Global settings mutations" section, alongside `applyGlobal`:

```ts
  setOverlayLayout(layout: OverlaySlot[]) {
    this._global = { ...this._global, overlayLayout: layout.map(s => ({ ...s })) };
    saveToStorage(this._global);
    this.recomputeEffective();
    this.notify();
  }

  setOverlaySelectedNameVisible(v: boolean) {
    this._global = { ...this._global, overlaySelectedNameVisible: v };
    saveToStorage(this._global);
    this.recomputeEffective();
    this.notify();
  }

  setOverlayPartsOnSelect(mode: 'highlight' | 'panIfOffscreen' | 'panZoomFit') {
    this._global = { ...this._global, overlayPartsOnSelect: mode };
    saveToStorage(this._global);
    this.recomputeEffective();
    this.notify();
  }

  setOverlayNetsOnSelect(mode: 'highlight' | 'panIfOffscreen' | 'panZoomFit') {
    this._global = { ...this._global, overlayNetsOnSelect: mode };
    saveToStorage(this._global);
    this.recomputeEffective();
    this.notify();
  }

  resetOverlayDefaults() {
    this._global = {
      ...this._global,
      overlayLayout: DEFAULT_OVERLAY_LAYOUT.map(s => ({ ...s })),
      overlaySelectedNameVisible: true,
      overlayPartsOnSelect: 'panZoomFit',
      overlayNetsOnSelect: 'panZoomFit',
    };
    saveToStorage(this._global);
    this.recomputeEffective();
    this.notify();
  }
```

Add the import at the top of the file: `import { type OverlaySlot, DEFAULT_OVERLAY_LAYOUT } from './overlay-layout';` (already added in Task 2 — confirm it's still there).

- [ ] **Step 2: Implement the OverlayCustomizer component (no DnD yet)**

```tsx
// src/frontend/src/panels/settings/OverlayCustomizer.tsx
import { renderSettingsStore } from '../../store/render-settings';
import { useRenderSettings } from '../../hooks/useRenderSettings';

const ON_SELECT_MODES = [
  { v: 'highlight'      as const, label: 'Just highlight' },
  { v: 'panIfOffscreen' as const, label: 'Pan if off-screen' },
  { v: 'panZoomFit'     as const, label: 'Pan & zoom to fit' },
];

export function OverlayCustomizer() {
  const s = useRenderSettings();

  return (
    <div className="overlay-customizer">
      {/* Customizer DnD lands in Task 15 — placeholder marker for now */}
      <div className="overlay-customizer-placeholder" data-testid="overlay-customizer-dnd-placeholder">
        Drag-and-drop customizer (coming next task)
      </div>

      <div className="settings-row">
        <label>
          <input
            type="checkbox"
            checked={s.overlaySelectedNameVisible}
            onChange={e => renderSettingsStore.setOverlaySelectedNameVisible(e.target.checked)}
          />
          {' '}Show selected component name below overlay
        </label>
      </div>

      <div className="settings-subsection-label">When you pick a part</div>
      <div className="settings-row" role="radiogroup" aria-label="On-select behavior for parts">
        {ON_SELECT_MODES.map(m => (
          <label key={m.v} style={{ marginRight: 12 }}>
            <input
              type="radio"
              name="overlay-parts-on-select"
              checked={s.overlayPartsOnSelect === m.v}
              onChange={() => renderSettingsStore.setOverlayPartsOnSelect(m.v)}
            />
            {' '}{m.label}
          </label>
        ))}
      </div>

      <div className="settings-subsection-label">When you pick a net</div>
      <div className="settings-row" role="radiogroup" aria-label="On-select behavior for nets">
        {ON_SELECT_MODES.map(m => (
          <label key={m.v} style={{ marginRight: 12 }}>
            <input
              type="radio"
              name="overlay-nets-on-select"
              checked={s.overlayNetsOnSelect === m.v}
              onChange={() => renderSettingsStore.setOverlayNetsOnSelect(m.v)}
            />
            {' '}{m.label}
          </label>
        ))}
      </div>

      <button
        className="settings-reset-btn"
        onClick={() => renderSettingsStore.resetOverlayDefaults()}
        data-testid="overlay-reset-btn"
      >
        ↺ Reset to defaults
      </button>
    </div>
  );
}
```

- [ ] **Step 3: Register the new section in SettingsPanel**

In `src/frontend/src/panels/SettingsPanel.tsx`:

1. Find the `SectionId` type union and add `'boardOverlay'`.
2. Find the `sectionToTab` (or similarly-named) map and add `boardOverlay: 'render'` (or whichever tab the existing render-related sections live under — match the convention).
3. Find `sectionRefsMapRef` and add `boardOverlay: useRef(null)`.
4. Find the JSX sequence rendering existing sections (search for `<CollapsibleSection` calls). Append a new section, modeled on the others:

```tsx
      <CollapsibleSection
        id="boardOverlay"
        title="Board overlay"
        isOpen={openSections.has('boardOverlay')}
        onToggle={toggleSection}
        sectionRef={sectionRefsMapRef.current.boardOverlay}
        isFocused={focusedSection === 'boardOverlay'}
      >
        <OverlayCustomizer />
      </CollapsibleSection>
```

5. Add the import: `import { OverlayCustomizer } from './settings/OverlayCustomizer';`

- [ ] **Step 4: Run existing tests as regression check**

Run: `cd src/frontend && npx playwright test --project=chromium`
Expected: all tests pass. Open the dev server manually and verify the new "Board overlay" section appears in Settings, the checkbox toggles the label, and the radios change the dropdowns' on-select behavior.

- [ ] **Step 5: Commit**

```bash
git add src/frontend/src/panels/settings/OverlayCustomizer.tsx \
        src/frontend/src/panels/SettingsPanel.tsx \
        src/frontend/src/store/render-settings.ts
git commit -m "$(cat <<'EOF'
feat(settings): Board overlay section with visibility + on-select controls

Adds the new 'Board overlay' collapsible section. Subsections:
  • Show selected component name (checkbox)
  • When you pick a part — radio (highlight/pan/fit)
  • When you pick a net  — radio (highlight/pan/fit)
  • ↺ Reset to defaults
DnD customizer for slot order/visibility lands in the next task.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 15: Drag-and-drop customizer for overlay slots

**Files:**
- Modify: `src/frontend/src/panels/settings/OverlayCustomizer.tsx`
- Modify: `src/frontend/src/index.css`
- Modify: `src/frontend/tests/overlay-customizer.spec.ts`

The customizer renders Visible and Hidden zones. Dragging chips between them flips `visible`; dragging within a zone reorders. The chip rendering reuses `renderOverlaySlot` so chips look identical to the live overlay buttons. Native HTML5 DnD; no library dep.

- [ ] **Step 1: Replace the placeholder with the DnD customizer**

In `OverlayCustomizer.tsx`, replace the import block and the entire component body with:

```tsx
import { useState, type DragEvent, type ReactNode } from 'react';
import { renderSettingsStore } from '../../store/render-settings';
import { useRenderSettings } from '../../hooks/useRenderSettings';
import type { OverlaySlot, OverlaySlotId } from '../../store/overlay-layout';
import { renderOverlaySlot } from '../../components/overlay/slot-renderers';
import type { SlotCtx } from '../../components/overlay/slot-ctx';

const ON_SELECT_MODES = [
  { v: 'highlight'      as const, label: 'Just highlight' },
  { v: 'panIfOffscreen' as const, label: 'Pan if off-screen' },
  { v: 'panZoomFit'     as const, label: 'Pan & zoom to fit' },
];

const DRAG_MIME = 'application/x-overlay-slot';

/**
 * Render the chip for a slot. Reuses the live slot renderer so the chip
 * looks identical to the real button. Wrapped in a non-interactive overlay
 * that intercepts pointer events so clicking a chip never fires the
 * underlying action.
 */
function SlotChip({ slot, ctx }: { slot: OverlaySlot; ctx: SlotCtx }) {
  const inner: ReactNode = renderOverlaySlot(slot.id, ctx);
  return (
    <div className="overlay-customizer-chip" title="Drag to reorder · drag to other zone to hide/show">
      <div className="overlay-customizer-chip-inner" aria-hidden>
        {inner}
      </div>
      <div className="overlay-customizer-chip-mask" />
    </div>
  );
}

export function OverlayCustomizer() {
  const s = useRenderSettings();
  const [dragSlot, setDragSlot] = useState<OverlaySlotId | null>(null);

  // Dummy ctx for chip rendering. The mask layer prevents real interactions,
  // and slots that read board state (PartsDropdown / NetsDropdown disabled
  // states) gracefully no-op when board is null.
  const ctx: SlotCtx = {
    tabId: -1,
    thisTab: {
      netLineMode: 'off',
      showNetDim: false,
      showHoverInfo: false,
      showGhosts: false,
      followPdf: false,
      pdfFileNames: [],
      fileName: '',
    },
    rendererRef: { current: null },
    bareAction: 'pan',
  };

  const visibleSlots = s.overlayLayout.filter(x => x.visible);
  const hiddenSlots  = s.overlayLayout.filter(x => !x.visible);

  function commitMove(opts: {
    movedId: OverlaySlotId;
    targetVisible: boolean;
    insertBeforeId: OverlaySlotId | null;  // null = append at end of target zone
  }) {
    const { movedId, targetVisible, insertBeforeId } = opts;
    const without = s.overlayLayout.filter(x => x.id !== movedId);
    const moved: OverlaySlot = { id: movedId, visible: targetVisible };

    if (insertBeforeId === null) {
      // Append into the target zone — for "visible: append at end of visible block",
      // for hidden: just push at the end. Hidden ordering is informational only.
      const inserted: OverlaySlot[] = [];
      let placed = false;
      if (targetVisible) {
        // Walk and find the last visible slot, insert after it
        let lastVisibleIdx = -1;
        for (let i = 0; i < without.length; i++) if (without[i].visible) lastVisibleIdx = i;
        for (let i = 0; i < without.length; i++) {
          inserted.push(without[i]);
          if (i === lastVisibleIdx) { inserted.push(moved); placed = true; }
        }
        if (!placed) inserted.push(moved);
      } else {
        inserted.push(...without, moved);
      }
      renderSettingsStore.setOverlayLayout(inserted);
      return;
    }

    const out: OverlaySlot[] = [];
    for (const slot of without) {
      if (slot.id === insertBeforeId) out.push(moved);
      out.push(slot);
    }
    if (!out.includes(moved)) out.push(moved);
    renderSettingsStore.setOverlayLayout(out);
  }

  // ── DnD handlers ────────────────────────────────────────────────────
  const onDragStart = (id: OverlaySlotId) => (e: DragEvent) => {
    e.dataTransfer.setData(DRAG_MIME, id);
    e.dataTransfer.effectAllowed = 'move';
    setDragSlot(id);
  };
  const onDragEnd = () => setDragSlot(null);
  const onDragOver = (e: DragEvent) => {
    if (e.dataTransfer.types.includes(DRAG_MIME)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    }
  };
  const onZoneDrop = (targetVisible: boolean) => (e: DragEvent) => {
    e.preventDefault();
    const movedId = e.dataTransfer.getData(DRAG_MIME) as OverlaySlotId;
    if (!movedId) return;
    commitMove({ movedId, targetVisible, insertBeforeId: null });
  };
  const onChipDrop = (insertBeforeId: OverlaySlotId, targetVisible: boolean) => (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const movedId = e.dataTransfer.getData(DRAG_MIME) as OverlaySlotId;
    if (!movedId || movedId === insertBeforeId) return;
    commitMove({ movedId, targetVisible, insertBeforeId });
  };

  const renderZone = (slots: OverlaySlot[], targetVisible: boolean) => (
    <div
      className={`overlay-customizer-zone ${targetVisible ? 'visible-zone' : 'hidden-zone'}`}
      onDragOver={onDragOver}
      onDrop={onZoneDrop(targetVisible)}
      data-testid={targetVisible ? 'overlay-customizer-visible' : 'overlay-customizer-hidden'}
    >
      {slots.length === 0 && (
        <div className="overlay-customizer-empty">
          {targetVisible ? 'All slots are hidden — drag from below to restore' : 'Drag a button here to hide it'}
        </div>
      )}
      {slots.map(slot => (
        <div
          key={slot.id}
          className={`overlay-customizer-chip-wrap${dragSlot === slot.id ? ' dragging' : ''}`}
          draggable
          onDragStart={onDragStart(slot.id)}
          onDragEnd={onDragEnd}
          onDragOver={onDragOver}
          onDrop={onChipDrop(slot.id, targetVisible)}
          data-slot-id={slot.id}
        >
          <SlotChip slot={slot} ctx={ctx} />
        </div>
      ))}
    </div>
  );

  return (
    <div className="overlay-customizer">
      <div className="settings-subsection-label">Visible (drag to reorder, drag down to hide)</div>
      {renderZone(visibleSlots, true)}

      <div className="settings-subsection-label">Hidden (drag up to restore)</div>
      {renderZone(hiddenSlots, false)}

      <div className="settings-row">
        <label>
          <input
            type="checkbox"
            checked={s.overlaySelectedNameVisible}
            onChange={e => renderSettingsStore.setOverlaySelectedNameVisible(e.target.checked)}
          />
          {' '}Show selected component name below overlay
        </label>
      </div>

      <div className="settings-subsection-label">When you pick a part</div>
      <div className="settings-row" role="radiogroup" aria-label="On-select behavior for parts">
        {ON_SELECT_MODES.map(m => (
          <label key={m.v} style={{ marginRight: 12 }}>
            <input
              type="radio"
              name="overlay-parts-on-select"
              checked={s.overlayPartsOnSelect === m.v}
              onChange={() => renderSettingsStore.setOverlayPartsOnSelect(m.v)}
            />
            {' '}{m.label}
          </label>
        ))}
      </div>

      <div className="settings-subsection-label">When you pick a net</div>
      <div className="settings-row" role="radiogroup" aria-label="On-select behavior for nets">
        {ON_SELECT_MODES.map(m => (
          <label key={m.v} style={{ marginRight: 12 }}>
            <input
              type="radio"
              name="overlay-nets-on-select"
              checked={s.overlayNetsOnSelect === m.v}
              onChange={() => renderSettingsStore.setOverlayNetsOnSelect(m.v)}
            />
            {' '}{m.label}
          </label>
        ))}
      </div>

      <button
        className="settings-reset-btn"
        onClick={() => renderSettingsStore.resetOverlayDefaults()}
        data-testid="overlay-reset-btn"
      >
        ↺ Reset to defaults
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Add CSS for the customizer**

Append to `src/frontend/src/index.css`:

```css
.overlay-customizer-zone {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 44px;
  padding: 6px 8px;
  margin: 4px 0 12px;
  background: var(--bg-primary, #0f0f1a);
  border: 1px dashed var(--border-primary, #333);
  border-radius: 4px;
  flex-wrap: wrap;
}
.overlay-customizer-zone.hidden-zone {
  opacity: 0.85;
}
.overlay-customizer-chip-wrap {
  position: relative;
  cursor: grab;
}
.overlay-customizer-chip-wrap.dragging {
  opacity: 0.4;
}
.overlay-customizer-chip {
  position: relative;
  display: inline-block;
}
.overlay-customizer-chip-inner {
  pointer-events: none;
}
.overlay-customizer-chip-mask {
  position: absolute;
  inset: 0;
}
.overlay-customizer-empty {
  flex: 1;
  text-align: center;
  font-size: 11px;
  color: var(--text-muted, #888);
  font-style: italic;
}
.settings-reset-btn {
  background: transparent;
  border: 0;
  color: var(--accent, #88f);
  font-size: 11px;
  cursor: pointer;
  padding: 0;
  margin-top: 8px;
}
.settings-reset-btn:hover {
  text-decoration: underline;
}
```

- [ ] **Step 3: Add E2E tests for the customizer**

Append to `src/frontend/tests/overlay-customizer.spec.ts`:

```ts
test.describe('Overlay customizer', () => {
  test('reset link restores defaults', async ({ page }) => {
    await loadBoard(page);

    // Mutate the layout via store
    await page.evaluate(() => {
      const win = window as Window & { __renderSettings?: { setOverlayLayout: (l: unknown) => void } };
      win.__renderSettings!.setOverlayLayout([{ id: 'pdfFollow', visible: false }]);
    });

    // Open Settings via the existing toolbar gear (button with text "Settings"
    // or icon "⚙" — whichever matches the project's pattern) and reveal the
    // Board overlay section.
    const settingsBtn = page.locator('.toolbar-btn', { hasText: 'Settings' }).first();
    await settingsBtn.click();
    await page.click('button:has-text("Board overlay")');
    await page.click('[data-testid="overlay-reset-btn"]');

    // Verify all default slots are visible again
    const layout = await page.evaluate(() => {
      const win = window as Window & { __renderSettings?: { settings: { overlayLayout: Array<{ id: string; visible: boolean }> } } };
      return win.__renderSettings!.settings.overlayLayout;
    });
    expect(layout.length).toBe(11);
    expect(layout.every(s => s.visible)).toBe(true);
    expect(layout.map(s => s.id)).toEqual([
      'pdfFollow', 'scrollMode', 'fitBoard', 'sep1',
      'hoverInfo', 'netDim', 'netLines', 'ghosts', 'sep2',
      'partsDropdown', 'netsDropdown',
    ]);
  });

  test('hiding a slot via store removes it from the live overlay', async ({ page }) => {
    await loadBoard(page);
    await page.waitForSelector('[data-testid="parts-dropdown-button"]');

    await page.evaluate(() => {
      const win = window as Window & { __renderSettings?: { setOverlayLayout: (l: unknown) => void; settings: { overlayLayout: unknown } } };
      const cur = win.__renderSettings!.settings.overlayLayout as Array<{ id: string; visible: boolean }>;
      win.__renderSettings!.setOverlayLayout(cur.map(s =>
        s.id === 'partsDropdown' ? { ...s, visible: false } : s
      ));
    });

    await expect(page.locator('[data-testid="parts-dropdown-button"]')).toHaveCount(0);
  });
});
```

(If the dev environment lacks an `[data-testid="open-settings-btn"]`, replace with whatever opens Settings — the rest of the test stands.)

- [ ] **Step 4: Run the full test suite**

Run: `cd src/frontend && npx playwright test --project=chromium`
Expected: all overlay-customizer tests pass; existing tests still pass.

- [ ] **Step 5: Manual DnD smoke test**

Run: `cd src/frontend && npm run dev`
Open Settings → Board overlay. Drag a Visible chip down into the Hidden zone. Verify the chip moves and the live overlay (above) loses the corresponding button. Drag back up — verify it returns to the Visible row at the drop position. Verify dragging within Visible reorders.

- [ ] **Step 6: Commit**

```bash
git add src/frontend/src/panels/settings/OverlayCustomizer.tsx \
        src/frontend/src/index.css \
        src/frontend/tests/overlay-customizer.spec.ts
git commit -m "$(cat <<'EOF'
feat(settings): drag-and-drop overlay customizer

Visible / Hidden zones with native HTML5 DnD. Chips reuse the live
slot renderers so they look identical to real buttons; a mask
layer absorbs clicks so chip clicks never fire the underlying
toggle. Reordering works within Visible; dragging across zones
toggles the slot's visibility flag.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 16: Final verification + memory update

**Files:**
- Create: `/Users/besitzer/.claude/projects/-Users-besitzer-Desktop-Boardviewer/memory/project_overlay_customizer.md` (memory note)
- Modify: `/Users/besitzer/.claude/projects/-Users-besitzer-Desktop-Boardviewer/memory/MEMORY.md` (index entry)

- [ ] **Step 1: Run the entire E2E suite**

Run: `cd src/frontend && npx playwright test --project=chromium`
Expected: all tests pass, including the new `overlay-customizer.spec.ts` cases.

- [ ] **Step 2: Lint + typecheck the whole frontend**

Run: `cd src/frontend && npm run lint && npx tsc --noEmit`
Expected: zero errors.

- [ ] **Step 3: Manual end-to-end walk-through**

Run: `cd src/frontend && npm run dev` and verify:
1. Default UI matches today's overlay byte-for-byte (button order, gaps).
2. `Parts ▾` and `Nets ▾` open popovers; typing filters; Enter selects; pan-zoom respects the 3× cap.
3. Selected-name label appears below the overlay row when a part/net is selected.
4. Settings → Board overlay shows the customizer; DnD between Visible / Hidden flips visibility; reorder within Visible works; Reset restores defaults.
5. Reload the dev server: layout changes persist via localStorage.
6. Open browser console: no errors logged.

- [ ] **Step 4: Add a memory note for future-Claude**

Create `/Users/besitzer/.claude/projects/-Users-besitzer-Desktop-Boardviewer/memory/project_overlay_customizer.md`:

```markdown
---
name: Overlay Customizer
description: Slot-registry pattern in BoardViewer overlay — also used by Settings DnD customizer
type: project
---

The BoardViewer overlay (the floating button row on the canvas) is a
data-driven slot registry, not hand-written JSX. To add or change an
overlay button:

1. Add the slot id to OverlaySlotId in `src/frontend/src/store/overlay-layout.ts`.
2. Add it to KNOWN_SLOT_IDS and DEFAULT_OVERLAY_LAYOUT in the same file.
3. Add a renderer entry in `src/frontend/src/components/overlay/slot-renderers.tsx`.
4. Implement the slot component in `src/frontend/src/components/overlay/slots/`.

Saved layouts auto-reconcile on load (drop unknown ids, append new
defaults). The Settings → Board overlay customizer reuses the live
slot renderers so chips look identical to real buttons — a mask layer
absorbs clicks so chip clicks never fire the underlying toggle.

The Parts/Nets dropdowns share `dropdown-popover.tsx` and read a
WeakMap-memoized index from `get-overlay-index.ts` (pre-sorted with
`naturalCompare`, NC nets partitioned via `isNcNet`).

Selecting a part/net delegates to existing `boardStore.focusPart` /
`boardStore.focusNet` for the default `panZoomFit` mode — same flow
as the PDF search lookup. The 3× fit-to-board zoom cap inside
`BoardRenderer.zoomToBounds` applies to all callers, including the
existing PDF lookup path.

Spec: `docs/superpowers/specs/2026-05-04-board-overlay-search-customizer-design.md`
```

Append to `MEMORY.md`:

```markdown
- [Overlay Customizer](project_overlay_customizer.md) — slot-registry + DnD customizer for the BoardViewer overlay
```

- [ ] **Step 5: Commit memory note + final wrap**

```bash
cd /Users/besitzer/.claude/projects/-Users-besitzer-Desktop-Boardviewer/memory/ && \
  ls project_overlay_customizer.md MEMORY.md
# Memory directory is not a git repo — no commit. Files are auto-loaded.

cd /Users/besitzer/Desktop/Boardviewer && \
  git log --oneline -16
# Verify the 15 implementation commits + this one are all present.
```

---

## Summary of commits

| # | Subject |
|---|---------|
| 1 | feat(overlay): add slot-layout types, default, and reconciler |
| 2 | feat(overlay): persist layout, visibility, and on-select settings |
| 3 | feat(renderer): cap focus-zoom at 3x fit-to-board scale |
| 4 | feat(renderer): add panToPart/NetIfOffscreen helpers |
| 5 | refactor(overlay): extract toggle buttons into per-slot components |
| 6 | feat(overlay): add Separator slot component |
| 7 | refactor(overlay): render board overlay via slot registry |
| 8 | feat(overlay): natural-sort comparator for refdes/net names |
| 9 | feat(overlay): memoized parts/nets index for dropdowns |
| 10 | feat(overlay): shared dropdown popover scaffold |
| 11 | feat(overlay): Parts filter dropdown |
| 12 | feat(overlay): Nets filter dropdown with NC partition |
| 13 | feat(overlay): selected-component-name label below toolbar |
| 14 | feat(settings): Board overlay section with visibility + on-select controls |
| 15 | feat(settings): drag-and-drop overlay customizer |
