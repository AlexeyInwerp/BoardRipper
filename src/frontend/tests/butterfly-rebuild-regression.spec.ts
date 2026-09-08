/**
 * Butterfly + scene rebuild must not kill the renderer.
 *
 * butterflyDimGfx is a persistent Graphics mounted into butterflyRoot. Until
 * 2026-09-08 invalidateAllScenes detached its sibling butterflySelectionGfx
 * but not it, so butterflyRoot.destroy({children:true}) destroyed it and the
 * next rebuild re-added a dead object — `_gpuData` / `instructions` of null,
 * ticker stopped, every button "unclickable". Two cases: a real visual
 * setting (forces a rebuild, proves the detach) and a ribbon layout change
 * (must not rebuild at all).
 */
import { test, expect, type Page } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(HERE, '../public/samples/test-board.bvr');
const BAR = '[data-testid="board-overlay-bar"]';

function watch(page: Page) {
  const errs: string[] = [];
  page.on('pageerror', e => errs.push(e.message.split('\n')[0]));
  page.on('console', m => { if (/render crash|_gpuData|onSettingsUpdate crashed/.test(m.text())) errs.push(m.text().slice(0, 160)); });
  return errs;
}

async function openButterfly(page: Page) {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.setInputFiles('[data-testid="file-input"]', FIXTURE);
  await page.getByTestId('butterfly-btn').click();
  await expect(page.getByTestId('butterfly-btn')).toHaveClass(/active/);
  await page.waitForTimeout(300);
}

test.describe('butterfly + rebuild', () => {
  test('a visual settings change with Butterfly on rebuilds without a render crash, twice', async ({ page }) => {
    const errs = watch(page);
    await openButterfly(page);
    for (const w of [2, 3, 1]) {
      await page.evaluate(v => {
        const rs = (window as Window & { __renderSettings?: { settings: Record<string, unknown>; applyGlobal: (s: Record<string, unknown>) => void } }).__renderSettings!;
        rs.applyGlobal({ ...rs.settings, partBorderWidth: v });
      }, w);
      await page.waitForTimeout(700);                      // scheduleRebuild debounce + a few frames
    }
    await page.getByTestId('side-bottom').click();          // the renderer still answers
    await expect(page.getByTestId('side-bottom')).toHaveClass(/active/);
    expect(errs).toEqual([]);
  });

  test('re-orienting and moving the ribbon with Butterfly on never crashes the renderer', async ({ page }) => {
    const errs = watch(page);
    await openButterfly(page);
    await page.click(BAR, { button: 'right' });
    await page.getByTestId('bar-menu-vertical').click();
    await page.waitForTimeout(700);
    await page.click(BAR, { button: 'right' });
    await page.getByTestId('board-bar-menu').getByRole('menuitemcheckbox', { name: 'Horizontal', exact: true }).click();
    await page.waitForTimeout(700);
    await page.click(BAR, { button: 'right' });
    await page.getByTestId('bar-menu-floating').click();
    await page.waitForTimeout(700);
    await page.getByTestId('butterfly-btn').click();
    await expect(page.getByTestId('butterfly-btn')).not.toHaveClass(/active/);
    expect(errs).toEqual([]);
    await page.click(BAR, { button: 'right' });
    await page.getByTestId('board-bar-menu').getByRole('menuitemcheckbox', { name: 'Left', exact: true }).click();
  });
});
