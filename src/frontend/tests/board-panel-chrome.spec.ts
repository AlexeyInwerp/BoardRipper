/**
 * Board panel chrome after the v0.38 consistency pass:
 *   - the overlay control bar rolls up into its left-edge handle (persisted)
 *   - the board sidebar's tabs are the shared icon-tab cell (icons stay put,
 *     only the open tab is captioned), located by data-board-tab
 *   - the sidebar opacity slider is gone
 *
 * Uses the public fixture so no backend or proprietary samples are needed.
 */
import { test, expect, type Page } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(HERE, '../public/samples/test-board.bvr');

async function openFixture(page: Page) {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.setInputFiles('[data-testid="file-input"]', FIXTURE);
  await expect(page.getByTestId('board-overlay-bar')).toBeVisible();
}

test.describe('board panel chrome', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      if (sessionStorage.getItem('board-chrome-spec-init')) return;
      sessionStorage.setItem('board-chrome-spec-init', '1');
      localStorage.removeItem('boardripper-overlay-collapsed');
    });
  });

  test('overlay bar collapses into its handle, persists, and expands again', async ({ page }) => {
    await openFixture(page);
    const bar = page.getByTestId('board-overlay-bar');
    const handle = page.getByTestId('overlay-collapse');
    await expect(bar).toHaveAttribute('data-collapsed', 'false');
    await expect(bar.getByTitle(/click to swap/)).toHaveCount(1);          // a real slot is there
    const openBox = await bar.boundingBox();

    await handle.click();
    await expect(bar).toHaveAttribute('data-collapsed', 'true');
    await expect(bar.getByTitle(/click to swap/)).toHaveCount(0);          // slots gone
    await expect(handle).toBeVisible();                                     // the handle stays
    const shutBox = await bar.boundingBox();
    expect(openBox && shutBox && shutBox.width < openBox.width / 4 && Math.abs(shutBox.x - openBox.x) <= 1).toBeTruthy();

    // Persists across a reload (the board has to be reopened; the bar state does not).
    await page.reload();
    // Not 'networkidle': with no backend the app keeps retrying, so idle may never come.
    await page.waitForLoadState('domcontentloaded');
    await page.getByTestId('file-input').waitFor({ state: 'attached' });
    // The session-restore dialog offers the previous board back; decline and reopen the fixture.
    const restore = page.getByTestId('session-discard');
    if (await restore.count()) await restore.click();
    await page.setInputFiles('[data-testid="file-input"]', FIXTURE);
    await expect(page.getByTestId('board-overlay-bar')).toHaveAttribute('data-collapsed', 'true');

    await page.getByTestId('overlay-collapse').click();
    await expect(page.getByTestId('board-overlay-bar')).toHaveAttribute('data-collapsed', 'false');
    await expect(page.getByTestId('board-overlay-bar').getByTitle(/click to swap/)).toHaveCount(1);
  });

  test('auto-hide overlay starts below the tab strip, and the tab stays clickable with the panel open', async ({ page }) => {
    await openFixture(page);
    await page.evaluate(() => (window as unknown as { __sidebar: { setAutoHide: (v: boolean) => void } }).__sidebar.setAutoHide(true));
    await expect(page.locator('.sidebar')).toBeHidden();
    await page.click('[data-testid="activity-rail"] [data-sidebar-tab="library"]');
    const panel = page.locator('.sidebar');
    await expect(panel).toHaveClass(/sidebar-overlay/);
    const strip = page.locator('.dv-tabs-and-actions-container').first();
    const [p, t] = await Promise.all([panel.boundingBox(), strip.boundingBox()]);
    expect(p && t && p.y >= t.y + t.height - 1).toBeTruthy();                 // below the strip, not over it
    // The board tab is really reachable: the element under its centre is the tab, not the panel.
    const tab = page.locator('.dv-tab').first();
    const tb = (await tab.boundingBox())!;
    const hit = await page.evaluate(([x, y]) => {
      const el = document.elementFromPoint(x, y);
      return el ? !!el.closest('.dv-tab') && !el.closest('.sidebar') : false;
    }, [tb.x + tb.width / 2, tb.y + tb.height / 2]);
    expect(hit).toBe(true);
    await page.evaluate(() => (window as unknown as { __sidebar: { setAutoHide: (v: boolean) => void } }).__sidebar.setAutoHide(false));
  });

  test('board sidebar tabs use the icon-tab cell; icons stay put; no opacity slider', async ({ page }) => {
    await openFixture(page);
    await page.locator('.board-sidebar-toggle').first().click();
    const tabs = page.locator('.board-sidebar [data-board-tab]');
    await expect(tabs).toHaveCount(4);                                      // info, layers/view, search, worklist
    for (let i = 0; i < 4; i++) await expect(tabs.nth(i)).toHaveClass(/icon-tab/);

    // Only the open tab carries a caption.
    await expect(page.locator('.board-sidebar [data-board-tab] .icon-tab-caption')).toHaveCount(1);
    await expect(page.locator('.board-sidebar [data-board-tab="info"] .icon-tab-caption')).toHaveText('Info');

    const before = await tabs.evaluateAll(els => els.map(e => Math.round(e.getBoundingClientRect().x)));
    await page.locator('[data-board-tab="worklist"]').click();
    const after = await tabs.evaluateAll(els => els.map(e => Math.round(e.getBoundingClientRect().x)));
    expect(after).toEqual(before);
    await expect(page.locator('.board-sidebar [data-board-tab="worklist"] .icon-tab-caption')).toHaveText('Worklist');
    await expect(page.locator('.board-sidebar [data-board-tab] .icon-tab-caption')).toHaveCount(1);

    // The opacity slider is retired: the ☰ toggles the panel and nothing else appears.
    await expect(page.locator('.board-sidebar-opacity-slider')).toHaveCount(0);
    await expect(page.locator('.board-sidebar-slider-wrap')).toHaveCount(0);
  });
});
