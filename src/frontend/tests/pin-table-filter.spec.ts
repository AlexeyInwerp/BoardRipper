/**
 * Info panel pin table: filter field and sortable columns
 * (components/pin-order.ts). Public KiCad sample, no backend.
 */
import { test, expect, type Page } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(HERE, '../public/samples/tomu-fpga.kicad_pcb');

/** Open the sample, select its part with the most pins, show the Info tab. */
async function openBiggestPart(page: Page) {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.setInputFiles('[data-testid="file-input"]', FIXTURE);
  await expect(page.getByTestId('board-overlay-bar')).toBeVisible();
  const big = await page.evaluate(() => {
    const bs = (window as any).__boardStore;
    const parts = bs.activeTab.board.parts as { name: string; pins: { net: string }[] }[];
    let best = 0;
    parts.forEach((p, i) => { if (p.pins.length > parts[best].pins.length) best = i; });
    bs.selectPart(best);
    return { index: best, pins: parts[best].pins.length };
  });
  await page.locator('.board-sidebar-toggle').first().click();
  await page.locator('[data-board-tab="info"]').click();
  await expect(page.locator('.pin-table tbody tr')).toHaveCount(big.pins);
  return big;
}

test.describe('pin table filter and sort', () => {
  test('filters by net, counts what is left, and Escape restores the table', async ({ page }) => {
    const big = await openBiggestPart(page);
    const filter = page.getByTestId('pin-filter');
    await filter.fill('gnd');
    const rows = page.locator('.pin-table tbody tr');
    const n = await rows.count();
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThan(big.pins);
    for (const net of await rows.locator('td.pin-net').allTextContents()) expect(net.toUpperCase()).toContain('GND');
    await expect(page.getByTestId('pin-filter-count')).toHaveText(`${n} of ${big.pins}`);

    await filter.press('Escape');
    await expect(rows).toHaveCount(big.pins);
  });

  test('a filtered row still selects its own pin', async ({ page }) => {
    const big = await openBiggestPart(page);
    await page.getByTestId('pin-filter').fill('spi mosi');      // loose: SPI_MOSI
    const row = page.locator('.pin-table tbody tr').first();
    const net = (await row.locator('td.pin-net').textContent())!.trim();
    expect(net).toBe('SPI_MOSI');
    await row.locator('td').first().click();
    const sel = await page.evaluate(() => {
      const bs = (window as any).__boardStore;
      const s = bs.selection;
      return { part: s.partIndex, net: bs.activeTab.board.parts[s.partIndex].pins[s.pinIndex].net };
    });
    expect(sel).toEqual({ part: big.index, net: 'SPI_MOSI' });
  });

  test('a header click sorts, a second reverses, a third restores file order', async ({ page }) => {
    await openBiggestPart(page);
    const nets = () => page.locator('.pin-table tbody td.pin-net').allTextContents();
    const fileOrder = await nets();
    const head = page.getByTestId('pin-sort-net');
    await head.click();
    const asc = await nets();
    expect(asc).toEqual([...asc].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })));
    await head.click();
    expect(await nets()).toEqual([...asc].reverse());
    await head.click();
    expect(await nets()).toEqual(fileOrder);
  });
});
