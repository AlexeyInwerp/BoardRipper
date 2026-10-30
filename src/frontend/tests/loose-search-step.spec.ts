/**
 * Loose search in the ribbon finds, and N / Shift+N stepping through
 * results (store/loose-match.ts, store/search-step.ts). Public KiCad sample,
 * no backend.
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

type Sel = { partIndex: number | null; pinIndex: number | null; highlightedNet: string | null };
const selection = (page: Page) => page.evaluate(() => {
  const s = (window as unknown as { __boardStore: { selection: Sel } }).__boardStore.selection;
  return { partIndex: s.partIndex, pinIndex: s.pinIndex, highlightedNet: s.highlightedNet };
});
const selectedName = (page: Page) => page.evaluate(() => {
  const st = (window as unknown as { __boardStore: { selection: Sel; activeTab: { board: { parts: { name: string; pins: unknown[] }[] } } } }).__boardStore;
  const i = st.selection.partIndex;
  return i === null ? null : { name: st.activeTab.board.parts[i].name, pins: st.activeTab.board.parts[i].pins.length };
});

test.describe('loose search and N stepping', () => {
  test('Find net lists names the substring test misses under "Similar names"', async ({ page }) => {
    await openFixture(page);
    const input = page.getByTestId('nets-filter-input');
    await input.fill('usb pu');                       // words out of order, no separator
    const list = page.locator('.overlay-dropdown-popover');
    await expect(list.locator('.overlay-dropdown-group-header')).toHaveText(['Similar names']);
    await expect(list.locator('.overlay-dropdown-row', { hasText: 'PU_CTRL_USBP' })).toBeVisible();

    await input.fill('spi');                          // plain substring: no similar group
    await expect(list.locator('.overlay-dropdown-row', { hasText: 'SPI_MOSI' })).toBeVisible();
    await expect(list.locator('.overlay-dropdown-group-header', { hasText: 'Similar names' })).toHaveCount(0);

    await input.fill('spimosi');                      // separators ignored
    await expect(list.locator('.overlay-dropdown-row')).toHaveText(['SPI_MOSI']);
  });

  test('N walks the parts on a picked net, small parts first, and Shift+N walks back', async ({ page }) => {
    await openFixture(page);
    const input = page.getByTestId('nets-filter-input');
    await input.fill('+3V3');
    await input.press('Enter');
    await expect.poll(async () => (await selection(page)).highlightedNet).toBe('+3V3');

    const seen: string[] = [];
    let pins: number[] = [];
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press('n');
      const s = await selection(page);
      expect(s.highlightedNet).toBe('+3V3');           // stays on the net
      expect(s.pinIndex).not.toBeNull();               // stops at the pin on it
      const p = (await selectedName(page))!;
      seen.push(p.name); pins.push(p.pins);
    }
    expect(new Set(seen).size).toBe(4);
    expect(pins[0]).toBeLessThanOrEqual(3);            // probe-friendly parts lead
    pins = [];
    await page.keyboard.press('Shift+N');
    expect((await selectedName(page))!.name).toBe(seen[2]);
  });

  test('N steps through a part search when no net is lit', async ({ page }) => {
    await openFixture(page);
    const input = page.getByTestId('parts-filter-input');
    await input.fill('C1');                           // C1, C10, C11 … in natural order
    await input.press('Escape');
    await page.keyboard.press('n');
    const first = (await selectedName(page))!.name;
    await page.keyboard.press('n');
    const second = (await selectedName(page))!.name;
    expect(first).not.toBe(second);
    expect(first).toMatch(/C1/i);
    await page.keyboard.press('Shift+N');
    expect((await selectedName(page))!.name).toBe(first);
  });

  test('N typed into a text field is text, not a step', async ({ page }) => {
    await openFixture(page);
    const input = page.getByTestId('parts-filter-input');
    await input.click();
    await page.keyboard.type('n');
    await expect(input).toHaveValue('n');
    expect((await selection(page)).partIndex).toBeNull();
  });
});
