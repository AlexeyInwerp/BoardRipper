/**
 * RangeControl in on/off mode (Settings ▸ Board ▸ Pins ▸ "Pin numbers").
 * Click the thumb → off (value kept, row greyed); click the row name → on;
 * drag the track → value changes and turns it on; keyboard steps; the plain
 * slider next to it has no toggle. The Board tab edits a draft (applied with
 * the Apply button), so state is read from the control itself: `data-on` and
 * the row's readout.
 */
import { test, expect, type Page } from '@playwright/test';

async function readout(page: Page, field: string): Promise<number> {
  const row = page.getByTestId(`range-${field}`).locator('xpath=ancestor::div[contains(@class,"settings-row")][1]');
  return parseFloat((await row.locator('.settings-value').innerText()).trim());
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem('boardripper-welcome-done', '1'); });
  await page.goto('/');
  await page.locator('.sidebar [data-settings-tab="board"]').or(page.locator('[data-sidebar-tab="settings"]')).first().click();
  await page.locator('.sidebar [data-settings-tab="board"]').click();
  const header = page.locator('button.settings-section-header:has-text("Pins / Pads")');
  if ((await header.locator('.settings-section-chevron').innerText()).includes('▸')) await header.click();
  await expect(page.getByTestId('range-pinNumberScale')).toBeVisible();
});

test('thumb click toggles off and keeps the value; name click toggles on', async ({ page }) => {
  const rc = page.getByTestId('range-pinNumberScale');
  const row = rc.locator('xpath=ancestor::div[contains(@class,"settings-row")][1]');
  const before = await readout(page, 'pinNumberScale');
  await rc.locator('.rc-thumb').click();
  await expect(rc).toHaveAttribute('data-on', 'false');
  await expect(row).toHaveClass(/settings-row-off/);
  expect(await readout(page, 'pinNumberScale')).toBe(before);   // value kept while off

  await row.locator('.settings-label-btn').click();
  await expect(rc).toHaveAttribute('data-on', 'true');
  await expect(row).not.toHaveClass(/settings-row-off/);
});

test('dragging the track sets the value and turns the row on', async ({ page }) => {
  const rc = page.getByTestId('range-pinNumberScale');
  await rc.locator('.rc-thumb').click();
  await expect(rc).toHaveAttribute('data-on', 'false');
  const box = (await rc.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.9, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(rc).toHaveAttribute('data-on', 'true');
  expect(await readout(page, 'pinNumberScale')).toBeGreaterThan(3);
});

test('keyboard: arrows step, Space toggles; a plain slider has no toggle', async ({ page }) => {
  const rc = page.getByTestId('range-pinNumberScale');
  await rc.focus();
  const v0 = await readout(page, 'pinNumberScale');
  await page.keyboard.press('ArrowRight');
  expect(await readout(page, 'pinNumberScale')).toBeCloseTo(v0 + 0.1, 5);
  await page.keyboard.press('Space');
  await expect(rc).toHaveAttribute('data-on', 'false');
  await page.keyboard.press('Space');
  await expect(rc).toHaveAttribute('data-on', 'true');

  const plain = page.getByTestId('range-pinAlpha');
  await expect(plain).not.toHaveAttribute('data-on', /.*/);
  const a0 = await readout(page, 'pinAlpha');
  await plain.locator('.rc-thumb').click();
  expect(await readout(page, 'pinAlpha')).toBe(a0);   // a click on a plain thumb changes nothing
});
