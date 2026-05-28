import { test, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';

const SAMPLES = {
  bvr3: 'samples/820-02016.bvr',
  brd:  'samples/820-02935-05.brd',
};

// Skip (not fail) when the gitignored, proprietary samples/ fixtures are absent
// — same idiom as ci-smoke.spec.ts. Resolved exactly as loadBoard() resolves
// them so the guard matches the file the test would actually open.
const haveSample = (rel: string) => fs.existsSync(path.resolve(rel));

/** Load a board file and wait for stats to appear */
async function loadBoard(page: import('@playwright/test').Page, filePath: string) {
  const fileInput = page.getByTestId('file-input');
  await fileInput.setInputFiles(path.resolve(filePath));
  await expect(page.getByTestId('statusbar')).toContainText('Components', { timeout: 15000 });
}

test.describe('Parser → Store → Renderer Pipeline', () => {

  test('BVR3: load → parse → render → search → info panel connected', async ({ page }) => {
    test.skip(!haveSample(SAMPLES.bvr3), `${SAMPLES.bvr3} not present (proprietary fixture)`);
    await page.goto('/');
    await loadBoard(page, SAMPLES.bvr3);

    // Verify canvas rendered
    const canvas = page.getByTestId('board-canvas').locator('canvas');
    await expect(canvas).toBeVisible();

    // Verify HUD shows zoom % (renderer is alive)
    const hud = page.locator('.board-hud').first();
    await expect(hud).toContainText('%', { timeout: 5000 });

    // Verify info panel is connected (regression from session 1b9ead3a)
    const infoPanel = page.getByTestId('component-info');
    await expect(infoPanel).not.toContainText('no board loaded');

    // Search for a known component
    const searchInput = page.getByTestId('search-input');
    await searchInput.fill('U');
    await expect(page.getByTestId('search-results')).not.toBeEmpty();
  });

  test('BRD: top/bottom layer buttons visible and toggleable', async ({ page }) => {
    test.skip(!haveSample(SAMPLES.brd), `${SAMPLES.brd} not present (proprietary fixture)`);
    await page.goto('/');
    await loadBoard(page, SAMPLES.brd);

    // Verify layer toggle buttons exist (actual selectors from Toolbar.tsx)
    const topBtn = page.locator('.toolbar-btn', { hasText: 'Top' });
    const bottomBtn = page.locator('.toolbar-btn', { hasText: 'Bottom' });
    await expect(topBtn).toBeVisible();
    await expect(bottomBtn).toBeVisible();

    // Toggle top off and on — should not crash
    await topBtn.click();
    await page.waitForTimeout(300);
    await topBtn.click();
    await expect(page.getByTestId('board-canvas').locator('canvas')).toBeVisible();
  });

  test('Multi-tab: opening second board does not break first', async ({ page }) => {
    test.skip(!haveSample(SAMPLES.bvr3) || !haveSample(SAMPLES.brd), 'proprietary BVR3/BRD fixtures not present');
    await page.goto('/');

    // Load first board
    await loadBoard(page, SAMPLES.bvr3);

    // Load second board
    await loadBoard(page, SAMPLES.brd);
    await page.waitForTimeout(1000);

    // Switch back to first tab via Dockview tab (actual selector)
    const bvrTab = page.locator('.dv-tab', { hasText: '820-02016.bvr' }).first();
    await bvrTab.click();
    await page.waitForTimeout(500);

    // First board should still show stats
    await expect(page.getByTestId('statusbar')).toContainText('Components', { timeout: 5000 });

    // Canvas should still be rendered
    await expect(page.getByTestId('board-canvas').locator('canvas')).toBeVisible();
  });
});
