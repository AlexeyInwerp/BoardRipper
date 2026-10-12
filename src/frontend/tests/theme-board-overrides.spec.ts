/**
 * Per-board overrides under a palette scheme.
 *
 * A palette scheme (Light here) is an overlay on the render settings, never
 * part of them. Board-mode Apply used to diff the *effective* settings —
 * palette included — against global, so the whole palette was saved as the
 * board's overrides and stayed on that board after switching back to
 * BoardRipper Default. Only the edited key may be stored.
 *
 * Uses the checked-in KiCad sample, so it always runs.
 */
import { test, expect, type Page } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const BOARD = path.resolve(here, '../../../samples/kicad/tomu-fpga.kicad_pcb');

type Store = {
  activeBoard: string;
  settings: Record<string, unknown>;
  globalSettings: Record<string, unknown>;
  getBoardOverrides(f: string): Record<string, unknown>;
};

async function openBoard(page: Page) {
  await page.getByTestId('file-input').setInputFiles(BOARD);
  await page.waitForFunction(() => !!(window as unknown as { __boardRenderer?: { board?: unknown } }).__boardRenderer?.board, null, { timeout: 30_000 });
  await page.waitForTimeout(500);
}

function setTheme(page: Page, id: string) {
  return page.evaluate(async (id) => {
    const mod = await import('/src/store/themes.ts');
    mod.themeStore.setTheme(id);
  }, id);
}

test('board-mode Apply on a palette scheme stores only the edited key', async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('tbo-init')) return;
    sessionStorage.setItem('tbo-init', '1');
    localStorage.clear();
    localStorage.setItem('boardripper-welcome-done', '1');
  });
  await page.goto('/');
  await setTheme(page, 'light');
  await openBoard(page);
  // The palette is really on: the effective settings differ from global.
  const paletteOn = await page.evaluate(() => {
    const s = (window as unknown as { __renderSettings: Store }).__renderSettings;
    return s.settings.ambientDim === false
      && s.settings.defaultPinColorTop !== s.globalSettings.defaultPinColorTop;
  });
  expect(paletteOn).toBe(true);

  const file = await page.evaluate(() => (window as unknown as { __renderSettings: Store }).__renderSettings.activeBoard);
  expect(file).toBeTruthy();

  await page.locator('[data-sidebar-tab="settings"]').first().click();
  await page.locator('.sidebar [data-settings-tab="board"]').click();
  await page.locator('.settings-mode-btn', { hasText: 'Board' }).click();
  const header = page.locator('button.settings-section-header:has-text("Pins / Pads")');
  if ((await header.locator('.settings-section-chevron').innerText()).includes('▸')) await header.click();

  const slider = page.getByTestId('range-pinAlpha');
  await expect(slider).toBeVisible();
  await slider.focus();
  await page.keyboard.press('ArrowLeft');
  await page.locator('.settings-apply-btn').click();

  const afterApply = await page.evaluate((f) => {
    const s = (window as unknown as { __renderSettings: Store }).__renderSettings;
    return { ov: s.getBoardOverrides(f), pinAlpha: s.globalSettings.pinAlpha };
  }, file);
  expect(Object.keys(afterApply.ov)).toEqual(['pinAlpha']);
  expect(afterApply.ov.pinAlpha).not.toBe(afterApply.pinAlpha);

  await setTheme(page, 'default');
  await page.waitForTimeout(100);

  const r = await page.evaluate((f) => {
    const s = (window as unknown as { __renderSettings: Store }).__renderSettings;
    return {
      ov: s.getBoardOverrides(f),
      pinGroupsEqual: JSON.stringify(s.settings.pinGroups) === JSON.stringify(s.globalSettings.pinGroups),
      partTypesEqual: JSON.stringify(s.settings.partTypes) === JSON.stringify(s.globalSettings.partTypes),
      ambientDim: s.settings.ambientDim,
      globalAmbientDim: s.globalSettings.ambientDim,
    };
  }, file);
  expect(Object.keys(r.ov)).toEqual(['pinAlpha']);
  expect(r.pinGroupsEqual).toBe(true);
  expect(r.partTypesEqual).toBe(true);
  expect(r.ambientDim).toBe(r.globalAmbientDim);
});
