/**
 * Two optional ribbon slots, both hidden on a fresh install: the "?" legend
 * card (components/BoardLegend.tsx) and the one-click flip-axis toggle.
 * Public KiCad sample, no backend.
 */
import { test, expect, type Page } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(HERE, '../public/samples/tomu-fpga.kicad_pcb');

async function openFixture(page: Page) {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.setInputFiles('[data-testid="file-input"]', FIXTURE);
  await expect(page.getByTestId('board-overlay-bar')).toBeVisible();
}

/** Tick a slot on in the ribbon's right-click menu. */
async function enableSlot(page: Page, id: string) {
  await page.getByTestId('board-overlay-bar').click({ button: 'right', position: { x: 4, y: 4 } });
  await page.getByTestId(`bar-menu-slot-${id}`).click();
  // A check item keeps the menu open for the next tick; close it.
  if (await page.getByTestId('board-bar-menu').count()) await page.keyboard.press('Escape');
  await expect(page.getByTestId('board-bar-menu')).toHaveCount(0);
}

test.describe('optional ribbon slots: legend and flip axis', () => {
  test('both are off by default and can be switched on from the ribbon menu', async ({ page }) => {
    await openFixture(page);
    await expect(page.getByTestId('legend-btn')).toHaveCount(0);
    await expect(page.getByTestId('flip-axis-btn')).toHaveCount(0);
    await enableSlot(page, 'legend');
    await expect(page.getByTestId('legend-btn')).toBeVisible();
    await enableSlot(page, 'flipAxis');
    await expect(page.getByTestId('flip-axis-btn')).toBeVisible();
  });

  test('the legend opens, switches modes, and its pin counts add up to the board', async ({ page }) => {
    await openFixture(page);
    await enableSlot(page, 'legend');
    await page.getByTestId('legend-btn').click();
    const card = page.getByTestId('board-legend');
    await expect(card).toBeVisible();

    // Pins: every pin is counted exactly once.
    const counts = await card.locator('.lg-row .lg-n').allTextContents();
    const sum = counts.reduce((a, t) => a + Number(t.replace(/,/g, '')), 0);
    const pins = await page.evaluate(() => (window as any).__boardStore.activeTab.board.parts
      .reduce((a: number, p: { pins: unknown[] }) => a + p.pins.length, 0));
    expect(sum).toBe(pins);
    await expect(card.getByTestId('legend-pin-gnd')).toContainText(/\d/);

    for (const m of ['parts', 'readings', 'lines', 'keys'] as const) {
      await page.getByTestId(`legend-mode-${m}`).click();
      await expect(page.getByTestId(`legend-mode-${m}`)).toHaveAttribute('aria-selected', 'true');
    }
    await expect(card.getByTestId('legend-key-searchStep')).toContainText('N');
    await page.getByTestId('legend-mode-lines').click();
    await expect(card.getByTestId('legend-line-net')).toBeVisible();

    // The mode and the open state survive a reload.
    await page.reload();
    // The reload offers to reopen the last session; this test opens the file itself.
    const discard = page.getByTestId('session-discard');
    await discard.waitFor({ timeout: 5000 }).then(() => discard.click(), () => {});
    await page.setInputFiles('[data-testid="file-input"]', FIXTURE);
    await expect(page.getByTestId('board-legend')).toBeVisible();
    await expect(page.getByTestId('legend-mode-lines')).toHaveAttribute('aria-selected', 'true');

    await page.getByTestId('legend-btn').click();
    await expect(page.getByTestId('board-legend')).toHaveCount(0);
  });

  test('the flip-axis button toggles the axis and agrees with the ⋯ menu', async ({ page }) => {
    await openFixture(page);
    await enableSlot(page, 'flipAxis');
    const btn = page.getByTestId('flip-axis-btn');
    const before = await btn.getAttribute('data-axis');
    await btn.click();
    const after = await btn.getAttribute('data-axis');
    expect(after).not.toBe(before);
    await page.getByTestId('transform-menu').click();
    const checked = page.getByTestId(after === 'vertical' ? 'transform-flip-vertical' : 'transform-flip-horizontal');
    await expect(checked).toHaveAttribute('aria-checked', 'true');
  });
});
