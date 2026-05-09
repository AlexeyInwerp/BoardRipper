/**
 * Game-style keyboard shortcuts (WSAD pan, Q/E rotate, Shift+W/S zoom,
 * Backquote library toggle). Verifies registration, dispatch, gating
 * (active panel + input focus), and behavior on board.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SAMPLES = path.resolve(__dirname, '../../../samples');
const BOARD = path.join(SAMPLES, '820-02016.bvr');

interface ViewportSnap {
  x: number;
  y: number;
  scaleX: number;
  rotation: number;
}

async function loadBoard(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles(BOARD);
  await expect(page.locator('.dv-tab', { hasText: '820-02016.bvr' })).toBeVisible({ timeout: 15000 });
  // Wait until the board parses
  await page.waitForFunction(() => {
    const s = (window as unknown as { __boardStore?: { activeTab?: { board: unknown } } }).__boardStore;
    return s?.activeTab?.board != null;
  }, undefined, { timeout: 15000 });
  // Wait for renderer dev-hook to be set AND viewport to be initialised
  // (viewport is created during the async init() call, after the constructor).
  // Also wait for layout to fully settle: _pendingFit is set true by the initial
  // board load and cleared after the ResizeObserver's 150 ms debounce fires a
  // re-fit. Without this wait, a Dockview panel resize can fire fitToBoard()
  // mid-test, briefly changing viewport.scale and producing a spurious
  // scale-equal assertion failure in the Shift+W/S zoom tests.
  await page.waitForFunction(() => {
    const r = (window as unknown as { __boardRenderer?: Record<string, unknown> }).__boardRenderer;
    if (r == null || r['viewport'] == null) return false;
    // _pendingFit = false AND _pendingFitTimer = null means layout has settled
    if (r['_pendingFit'] || r['_pendingFitTimer'] != null) return false;
    return true;
  }, undefined, { timeout: 15000 });
  // Click the canvas to ensure the board panel is the active dockview panel.
  // Click at (2,2) — near the canvas edge, very unlikely to land on a component
  // (which would trigger a follow-zoom animation that could interfere with the
  // viewport state the tests are about to assert on).
  const canvas = page.locator('canvas').first();
  await canvas.click({ position: { x: 2, y: 2 } });
  // Wait for dockview to register the canvas click as an active-panel switch
  // BEFORE any test issues a keypress. activePanelKind() in the hook gates on
  // this; without the wait, early keypresses are silently dropped.
  // Also wait for any follow-zoom animation (zoomAnim) to settle — a component
  // click would start a 400 ms animated zoom that overrides viewport.scale and
  // would make the Shift+W/S scale assertions flaky.
  await page.waitForFunction(() => {
    const w = window as unknown as { __dockviewApi?: { activePanel?: { id?: string } } };
    const id = w.__dockviewApi?.activePanel?.id ?? '';
    if (!id.startsWith('board-')) return false;
    const r = (window as unknown as { __boardRenderer?: Record<string, unknown> }).__boardRenderer;
    return r?.['zoomAnim'] == null;
  }, undefined, { timeout: 5000 });
}

async function readViewport(page: import('@playwright/test').Page): Promise<ViewportSnap> {
  return await page.evaluate(() => {
    const s = (window as unknown as { __boardStore?: { activeTab?: { rotation: number } } }).__boardStore;
    const renderer = (window as unknown as { __boardRenderer?: { viewport: { x: number; y: number; scale: { x: number } } } }).__boardRenderer;
    return {
      x: renderer?.viewport.x ?? 0,
      y: renderer?.viewport.y ?? 0,
      scaleX: renderer?.viewport.scale.x ?? 1,
      rotation: s?.activeTab?.rotation ?? 0,
    };
  });
}

test('W/A/S/D pan the board', async ({ page }) => {
  await loadBoard(page);
  const before = await readViewport(page);

  await page.keyboard.press('d'); // pan right → viewport.x decreases
  await page.waitForFunction((beforeX) => {
    const w = window as unknown as { __boardRenderer?: { viewport?: { x: number } } };
    const x = w.__boardRenderer?.viewport?.x ?? beforeX;
    return x < beforeX;
  }, before.x, { timeout: 5000 });
  const after = await readViewport(page);

  expect(after.x).toBeLessThan(before.x);
});

test('Q rotates CCW, E rotates CW', async ({ page }) => {
  await loadBoard(page);
  const before = await readViewport(page);

  await page.keyboard.press('e');
  await page.waitForFunction((beforeRotation) => {
    const w = window as unknown as { __boardStore?: { activeTab?: { rotation: number } } };
    const rotation = w.__boardStore?.activeTab?.rotation ?? beforeRotation;
    return rotation !== beforeRotation;
  }, before.rotation, { timeout: 5000 });
  const afterE = await readViewport(page);
  expect(afterE.rotation).not.toBe(before.rotation);

  await page.keyboard.press('q');
  await page.waitForFunction((targetRotation) => {
    const w = window as unknown as { __boardStore?: { activeTab?: { rotation: number } } };
    const rotation = w.__boardStore?.activeTab?.rotation ?? -1;
    return rotation === targetRotation;
  }, before.rotation, { timeout: 5000 });
  const afterQ = await readViewport(page);
  // Q should reverse the E rotation
  expect(afterQ.rotation).toBe(before.rotation);
});

test('Shift+W zooms in', async ({ page }) => {
  await loadBoard(page);
  const before = await readViewport(page);

  await page.keyboard.press('Shift+W');
  await page.waitForFunction((beforeScaleX) => {
    const w = window as unknown as { __boardRenderer?: { viewport?: { scale: { x: number } } } };
    const scaleX = w.__boardRenderer?.viewport?.scale.x ?? beforeScaleX;
    return scaleX > beforeScaleX;
  }, before.scaleX, { timeout: 5000 });
  const after = await readViewport(page);

  expect(after.scaleX).toBeGreaterThan(before.scaleX);
});

test('Shift+S zooms out', async ({ page }) => {
  await loadBoard(page);
  const before = await readViewport(page);

  await page.keyboard.press('Shift+S');
  await page.waitForFunction((beforeScaleX) => {
    const w = window as unknown as { __boardRenderer?: { viewport?: { scale: { x: number } } } };
    const scaleX = w.__boardRenderer?.viewport?.scale.x ?? beforeScaleX;
    return scaleX < beforeScaleX;
  }, before.scaleX, { timeout: 5000 });
  const after = await readViewport(page);

  expect(after.scaleX).toBeLessThan(before.scaleX);
});

test('bare W does not collide with Shift+W', async ({ page }) => {
  await loadBoard(page);
  const before = await readViewport(page);

  // Bare W should pan up only — scale should NOT change.
  // Poll for the y-change (pan) to confirm the keypress was processed, then
  // assert scale is still the same. This avoids a "no-change" polling dilemma
  // while still detecting early-settled presses.
  await page.keyboard.press('w');
  await page.waitForFunction((beforeY) => {
    const w = window as unknown as { __boardRenderer?: { viewport?: { y: number } } };
    return (w.__boardRenderer?.viewport?.y ?? beforeY) !== beforeY;
  }, before.y, { timeout: 5000 });
  const afterW = await readViewport(page);
  expect(afterW.scaleX).toBeCloseTo(before.scaleX, 5);
  expect(afterW.y).not.toBe(before.y);
});

test('Backquote toggles Library sidebar', async ({ page }) => {
  await loadBoard(page);
  // Read sidebar collapsed state from the global accessor
  const wasCollapsed = await page.evaluate(() => {
    const w = window as unknown as { __sidebar?: { isCollapsed: () => boolean; activeTab: () => string } };
    return w.__sidebar?.isCollapsed() ?? false;
  });

  await page.keyboard.press('Backquote');
  await page.waitForFunction((collapsed) => {
    const w = window as unknown as { __sidebar?: { isCollapsed: () => boolean } };
    return (w.__sidebar?.isCollapsed() ?? collapsed) !== collapsed;
  }, wasCollapsed, { timeout: 5000 });

  const isCollapsed = await page.evaluate(() => {
    const w = window as unknown as { __sidebar?: { isCollapsed: () => boolean; activeTab: () => string } };
    return w.__sidebar?.isCollapsed() ?? false;
  });

  expect(isCollapsed).not.toBe(wasCollapsed);
});

test('Shift+Backquote also toggles Library sidebar', async ({ page }) => {
  await loadBoard(page);
  // Read sidebar collapsed state from the global accessor
  const wasCollapsed = await page.evaluate(() => {
    const w = window as unknown as { __sidebar?: { isCollapsed: () => boolean; activeTab: () => string } };
    return w.__sidebar?.isCollapsed() ?? false;
  });

  await page.keyboard.press('Shift+Backquote');
  await page.waitForFunction((collapsed) => {
    const w = window as unknown as { __sidebar?: { isCollapsed: () => boolean } };
    return (w.__sidebar?.isCollapsed() ?? collapsed) !== collapsed;
  }, wasCollapsed, { timeout: 5000 });

  const isCollapsed = await page.evaluate(() => {
    const w = window as unknown as { __sidebar?: { isCollapsed: () => boolean; activeTab: () => string } };
    return w.__sidebar?.isCollapsed() ?? false;
  });

  expect(isCollapsed).not.toBe(wasCollapsed);
});

test('shortcut does not fire when search input is focused', async ({ page }) => {
  await loadBoard(page);
  const before = await readViewport(page);

  // Focus the toolbar search input (testid='search-input')
  const searchInput = page.getByTestId('search-input');
  await searchInput.focus();

  // Type W into the search box.
  // We intentionally keep waitForTimeout here: this test asserts that NO state
  // change occurs, so there is no positive condition to poll for. 200 ms is
  // enough for the shortcut dispatch to have fired (and been gated) if it were
  // going to fire at all.
  await page.keyboard.press('w');
  await page.waitForTimeout(200);

  const after = await readViewport(page);
  // Viewport should not have moved
  expect(after.x).toBeCloseTo(before.x, 3);
  expect(after.y).toBeCloseTo(before.y, 3);
  // The search input should now contain "w"
  await expect(searchInput).toHaveValue(/w/i);
});

// --- PDF-side shortcut tests ---

const PDF = path.join(SAMPLES, '820-02016.pdf');
const PDF_NAME = '820-02016.pdf';

/** Load a PDF and wait for the panel to be active and the test hooks to appear. */
async function loadPdf(page: import('@playwright/test').Page) {
  await page.goto('/');
  // The toolbar has a single unified file picker (data-testid="file-input") that
  // accepts both boards and PDFs — pdf-input was removed in this branch.
  await page.getByTestId('file-input').setInputFiles(PDF);
  await expect(page.locator('.dv-tab', { hasText: PDF_NAME })).toBeVisible({ timeout: 15000 });
  // Click the tab so the PDF panel is the active dockview panel.
  await page.locator('.dv-tab', { hasText: PDF_NAME }).click();
  // Wait for dockview to register the PDF panel as active.
  await page.waitForFunction(() => {
    const w = window as unknown as { __dockviewApi?: { activePanel?: { id?: string } } };
    return (w.__dockviewApi?.activePanel?.id ?? '').startsWith('pdf-');
  }, undefined, { timeout: 10000 });
  // Wait for the test hooks to be registered (they appear once the panel mounts).
  await page.waitForFunction((name: string) => {
    const w = window as unknown as { __pdfPanelTestHooks?: Record<string, { getPan: () => { x: number; y: number }; getZoom: () => number }> };
    return typeof w.__pdfPanelTestHooks?.[name]?.getPan === 'function';
  }, PDF_NAME, { timeout: 10000 });
}

/** Read pan and zoom directly from the dev hooks. */
async function readPdfState(page: import('@playwright/test').Page): Promise<{ x: number; y: number; zoom: number }> {
  return page.evaluate((name: string) => {
    const w = window as unknown as { __pdfPanelTestHooks?: Record<string, { getPan: () => { x: number; y: number }; getZoom: () => number }> };
    const hooks = w.__pdfPanelTestHooks![name];
    const pan = hooks.getPan();
    return { x: pan.x, y: pan.y, zoom: hooks.getZoom() };
  }, PDF_NAME);
}

test('D pans the PDF right', async ({ page }) => {
  await loadPdf(page);

  // Zoom in so the page is wider than the container (clampPan centers
  // the page when it fits exactly, so X panning only works zoomed in).
  await page.keyboard.press('Shift+W');
  await page.waitForFunction(
    (name: string) => {
      const w = window as unknown as { __pdfPanelTestHooks?: Record<string, { getZoom: () => number }> };
      const z = w.__pdfPanelTestHooks?.[name]?.getZoom();
      return z != null && z > 1;
    },
    PDF_NAME,
    { timeout: 5000 },
  );

  const before = await readPdfState(page);

  await page.keyboard.press('d'); // pan right → panRef.x decreases
  await page.waitForFunction(
    ({ name, beforeX }: { name: string; beforeX: number }) => {
      const w = window as unknown as { __pdfPanelTestHooks?: Record<string, { getPan: () => { x: number; y: number } }> };
      const pan = w.__pdfPanelTestHooks?.[name]?.getPan();
      return pan != null && pan.x < beforeX;
    },
    { name: PDF_NAME, beforeX: before.x },
    { timeout: 5000 },
  );
  const after = await readPdfState(page);
  expect(after.x).toBeLessThan(before.x);
});

test('Shift+W zooms the PDF in', async ({ page }) => {
  await loadPdf(page);
  const before = await readPdfState(page);

  await page.keyboard.press('Shift+W');
  await page.waitForFunction(
    ({ name, beforeZoom }: { name: string; beforeZoom: number }) => {
      const w = window as unknown as { __pdfPanelTestHooks?: Record<string, { getZoom: () => number }> };
      const zoom = w.__pdfPanelTestHooks?.[name]?.getZoom();
      return zoom != null && zoom > beforeZoom;
    },
    { name: PDF_NAME, beforeZoom: before.zoom },
    { timeout: 5000 },
  );
  const after = await readPdfState(page);
  expect(after.zoom).toBeGreaterThan(before.zoom);
});

test('Q does not rotate the PDF (no-op)', async ({ page }) => {
  await loadPdf(page);
  const before = await readPdfState(page);

  await page.keyboard.press('q');
  // No positive condition to poll — use a fixed wait, then assert unchanged.
  await page.waitForTimeout(150);

  const after = await readPdfState(page);
  expect(after.x).toBeCloseTo(before.x, 3);
  expect(after.y).toBeCloseTo(before.y, 3);
  expect(after.zoom).toBeCloseTo(before.zoom, 5);
});
