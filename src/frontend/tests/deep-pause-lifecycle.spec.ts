import { test, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Uses the tracked, non-proprietary fixture so it runs everywhere.
const FIXTURE = path.resolve(__dirname, '../public/samples/test-board.bvr');

// Deep-pause (F5): a board tab that is hidden long enough releases its GPU
// context + scene graph via teardownForReinit(); re-activating it rebuilds the
// Application through the tested reinitApp() path. This verifies the full
// hide → deepPause → reactivate → reinit cycle does not crash and restores the
// board. We shorten the 45s delay via the DEV-only __deepPauseDelayMs seam.
test('deep-pause releases a hidden board tab and reinit restores it on return', async ({ page }) => {
  const renderLogs: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (msg) => { if (msg.text().includes('deepPause')) renderLogs.push(msg.text()); });
  page.on('pageerror', (err) => pageErrors.push(err.message));

  // Shorten the deep-pause delay before the app boots.
  await page.addInitScript(() => {
    (window as unknown as { __deepPauseDelayMs?: number }).__deepPauseDelayMs = 300;
  });

  await page.goto('/');

  // A second distinct board file (a copy) so it opens as its own tab rather
  // than focusing the first.
  const secondFixture = path.join(os.tmpdir(), 'test-board-2.bvr');
  fs.copyFileSync(FIXTURE, secondFixture);

  const fileInput = page.getByTestId('file-input');

  // Reads the leading "N%" zoom from the visible board HUD. This is a pixel
  // proxy: if the rebuilt board doesn't restore its fitted viewport it comes back
  // at 100% with content off-screen (blank) — a bare toBeVisible() misses that.
  const readZoom = async () => {
    const txt = (await page.locator('.board-hud:visible').first().textContent()) || '';
    return (txt.match(/(\d+)%/)?.[1]) ?? '';
  };

  // Tab 1
  await fileInput.setInputFiles(FIXTURE);
  await expect(page.getByTestId('statusbar')).toContainText('Components:', { timeout: 15000 });
  await expect(page.locator('.dv-tab', { hasText: 'test-board.bvr' })).toBeVisible();
  await page.waitForTimeout(1200); // let the initial fit-to-board settle
  const zoomBefore = await readZoom();
  expect(zoomBefore, 'board should be fitted (well below 100%) before deep-pause').not.toBe('100');

  // Tab 2 — becomes active; tab 1 is now hidden → deep-pause armed on tab 1.
  await fileInput.setInputFiles(secondFixture);
  await expect(page.locator('.dv-tab', { hasText: 'test-board-2.bvr' })).toBeVisible({ timeout: 15000 });

  // Wait for the shortened deep-pause to fire on the hidden tab 1.
  await expect.poll(() => renderLogs.some((l) => l.includes('deepPause')), {
    timeout: 5000,
    message: 'expected a hidden board tab to deep-pause',
  }).toBe(true);

  // Return to tab 1 → resume() → reinitApp() rebuilds the released Application.
  await page.locator('.dv-tab', { hasText: 'test-board.bvr' }).first().click();

  // The board is intact and a live canvas is back — no crash on the reinit path.
  await expect(page.getByTestId('statusbar')).toContainText('Components:', { timeout: 15000 });
  await expect(page.getByTestId('board-canvas').locator('canvas')).toBeVisible({ timeout: 15000 });

  // Pixel proxy: the rebuilt board must restore its fitted viewport, not come
  // back at default 100% with content off-screen (the blank-render regression).
  await page.waitForTimeout(1200);
  const zoomAfter = await readZoom();
  expect(zoomAfter, `deep-paused board must restore its fitted zoom (was ${zoomBefore}%, got ${zoomAfter}%) — 100% means it rendered blank`).toBe(zoomBefore);

  // No PixiJS teardown/rebuild corruption. Includes the "reading 'resize'"
  // race: the ResizeObserver firing during reinitApp() before app.init()
  // finished threw "Cannot read properties of undefined (reading 'resize')"
  // and left the rebuilt board blank — a real regression this spec must catch,
  // so we match undefined AND null property access, not just 'null'.
  const critical = pageErrors.filter((e) =>
    e.includes('batchPool') ||
    e.includes('_DefaultBatcher') ||
    e.includes('GlobalResourceRegistry') ||
    e.includes("reading 'resize'") ||
    /Cannot read properties of (null|undefined)/.test(e),
  );
  expect(critical, `critical renderer errors: ${critical.join('; ')}`).toHaveLength(0);

  fs.rmSync(secondFixture, { force: true });
});
