/**
 * Minimap history: ‹ › on the map walk the navigation history, and this
 * session's visits on this board are marked on the map (Show history, on by
 * default). The trail only reads the history — it must not add entries.
 * Public sample, no backend.
 */
import { test, expect, type Page } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BOARD = path.resolve(HERE, '../public/samples/tomu-fpga.kicad_pcb');
const SHOT = process.env.MINIMAP_SHOT;

type W = { __boardStore: { selection: { partIndex: number | null }; board: { parts: { name: string }[] }; selectPart(i: number | null): void } };

async function open(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.setInputFiles('[data-testid="file-input"]', BOARD);
  const map = page.getByTestId('board-minimap');
  await expect(map).toHaveAttribute('data-visible', 'true');      // always on by default
  expect(errors).toEqual([]);
  return map;
}

const historyLength = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('boardripper-nav-history') || '{"entries":[]}').entries?.length ?? 0);

test('marks this session\'s visits and walks the history from the map', async ({ page }) => {
  const map = await open(page);
  const names = await page.evaluate(() => (window as unknown as W).__boardStore.board.parts.slice(0, 40).map(p => p.name));
  // Three parts far apart in the list, picked one after the other.
  const picks = [0, 15, 30];
  for (const i of picks) {
    await page.evaluate(n => (window as unknown as W).__boardStore.selectPart(n), i);
    await page.waitForTimeout(150);
  }
  await expect(map).toHaveAttribute('data-trail', '3');
  await page.waitForTimeout(400);
  const before = await historyLength(page);
  if (SHOT) await map.screenshot({ path: SHOT });

  // Back on the map goes to the part picked before; Forward returns.
  const back = page.getByTestId('minimap-history-back');
  await expect(back).toBeEnabled();
  await back.click();
  await expect.poll(() => page.evaluate(() => (window as unknown as W).__boardStore.selection.partIndex)).toBe(picks[1]);
  // The map press did not recentre the board on the button's spot.
  await page.getByTestId('minimap-history-forward').click();
  await expect.poll(() => page.evaluate(() => (window as unknown as W).__boardStore.selection.partIndex)).toBe(picks[2]);
  await expect(map).toHaveAttribute('data-trail', '3');
  expect(names.length).toBeGreaterThan(30);

  // Drawing and walking the trail adds nothing to the history.
  await page.waitForTimeout(400);
  expect(await historyLength(page)).toBeLessThanOrEqual(before + 2);   // back/forward may re-anchor, never per paint

  // Unticked, the trail goes; ticked, it comes back.
  await map.click({ button: 'right' });
  await page.getByTestId('minimap-show-history').click();
  await expect(map).toHaveAttribute('data-trail', '0');
  await map.click({ button: 'right' });
  await page.getByTestId('minimap-show-history').click();
  await expect(map).toHaveAttribute('data-trail', '3');
});
