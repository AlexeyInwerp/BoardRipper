/**
 * The "?" legend card (components/BoardLegend.tsx, slot `legendHelp`) and the
 * flip-axis toggle between Top and Bottom (slot `sideFlipAxis`), both on by
 * default. Public KiCad sample, no backend.
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

/** Tick a slot in the ribbon's right-click menu (on if off, off if on). */
async function toggleSlot(page: Page, id: string) {
  await page.getByTestId('board-overlay-bar').click({ button: 'right', position: { x: 4, y: 4 } });
  await page.getByTestId(`bar-menu-slot-${id}`).click();
  // A check item keeps the menu open for the next tick; close it.
  if (await page.getByTestId('board-bar-menu').count()) await page.keyboard.press('Escape');
  await expect(page.getByTestId('board-bar-menu')).toHaveCount(0);
}

test.describe('optional ribbon slots: legend and flip axis', () => {
  test('the legend button is on by default and can be switched off from the ribbon menu', async ({ page }) => {
    await openFixture(page);
    await expect(page.getByTestId('legend-btn')).toBeVisible();
    await toggleSlot(page, 'legendHelp');
    await expect(page.getByTestId('legend-btn')).toHaveCount(0);
  });

  test('flip axis sits between Top and Bottom by default and can be switched off', async ({ page }) => {
    await openFixture(page);
    const order = await page.getByTestId('side-switch').locator('button').evaluateAll(
      els => els.map(e => e.getAttribute('data-testid')));
    expect(order).toEqual(['side-top', 'flip-axis-btn', 'side-bottom']);
    await toggleSlot(page, 'sideFlipAxis');                     // a tick on a lit item turns it off
    await expect(page.getByTestId('flip-axis-btn')).toHaveCount(0);
    await expect(page.getByTestId('side-top')).toBeVisible();
  });

  test('the legend opens, switches modes, and its pin counts add up to the board', async ({ page }) => {
    await openFixture(page);
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
    const btn = page.getByTestId('flip-axis-btn');
    const before = await btn.getAttribute('data-axis');
    await btn.click();
    const after = await btn.getAttribute('data-axis');
    expect(after).not.toBe(before);
    await page.getByTestId('transform-menu').click();
    const checked = page.getByTestId(after === 'vertical' ? 'transform-flip-vertical' : 'transform-flip-horizontal');
    await expect(checked).toHaveAttribute('aria-checked', 'true');
  });

  test('the legend drags by its header, stays where it was put, and a double-click puts it back', async ({ page }) => {
    await openFixture(page);
    await page.getByTestId('legend-btn').click();
    const card = page.getByTestId('board-legend');
    await expect(card).toHaveAttribute('data-placed', 'corner');
    const b0 = (await card.boundingBox())!;
    const grip = page.getByTestId('legend-grip');
    const g = (await grip.boundingBox())!;
    // Grab it by a mode tab: the tabs fill the header, and a press there only
    // becomes a drag once it moves.
    const tab = (await page.getByTestId('legend-mode-readings').boundingBox())!;
    const gx = tab.x + tab.width / 2, gy = tab.y + tab.height / 2;
    await page.mouse.move(gx, gy);
    await page.mouse.down();
    await page.mouse.move(gx - 200, gy - 60, { steps: 8 });
    await page.mouse.up();
    await expect(card).toHaveAttribute('data-placed', 'moved');
    // The drag did not count as a click on the tab it started on.
    await expect(page.getByTestId('legend-mode-pins')).toHaveAttribute('aria-selected', 'true');
    const b1 = (await card.boundingBox())!;
    expect(b1.x).toBeLessThan(b0.x - 150);
    expect(b1.y).toBeLessThan(b0.y - 40);
    // A drag must not pan the board underneath: the grip keeps the pointer.
    // And the place survives a reload.
    await page.reload();
    const discard = page.getByTestId('session-discard');
    await discard.waitFor({ timeout: 5000 }).then(() => discard.click(), () => {});
    await page.setInputFiles('[data-testid="file-input"]', FIXTURE);
    await expect(card).toBeVisible();
    const b2 = (await card.boundingBox())!;
    expect(Math.abs(b2.x - b1.x)).toBeLessThan(3);
    expect(Math.abs(b2.y - b1.y)).toBeLessThan(3);
    await grip.dblclick({ position: { x: 8, y: g.height / 2 } });       // on the grip icon
    await expect(card).toHaveAttribute('data-placed', 'corner');
  });
});
