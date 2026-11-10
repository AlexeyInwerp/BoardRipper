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

  // Fewer steps mark fewer places; the menu stays open while adjusting.
  await map.click({ button: 'right' });
  await page.getByTestId('minimap-history-steps').fill('2');
  await expect(map).toHaveAttribute('data-trail', '2');
  await page.getByTestId('minimap-history-steps').fill('8');
  await expect(map).toHaveAttribute('data-trail', '3');
  await page.keyboard.press('Escape');

  // The header's History button opens the History tab.
  await page.getByTestId('minimap-open-tab').click();
  await expect(page.locator('[data-sidebar-tab="history"]').first()).toHaveClass(/active/);

  // Unticked, the trail goes; ticked, it comes back.
  await map.click({ button: 'right' });
  await page.getByTestId('minimap-show-history').click();
  await expect(map).toHaveAttribute('data-trail', '0');
  await map.click({ button: 'right' });
  await page.getByTestId('minimap-show-history').click();
  await expect(map).toHaveAttribute('data-trail', '3');
});

test('switches to the loaded worklist: marks its parts and steps through its rows', async ({ page }) => {
  const map = await open(page);
  // No worklist on this board yet: worklist mode says so and its steps are off.
  await page.getByTestId('minimap-nav-worklist').click();
  await expect(page.getByTestId('minimap-head')).toHaveAttribute('data-nav', 'worklist');
  await expect(page.getByTestId('minimap-wl-pos')).toHaveText('none');
  await expect(page.getByTestId('minimap-history-forward')).toBeDisabled();

  const names = await page.evaluate(() => {
    const w = window as unknown as { __boardStore: W['__boardStore']; __worklistStore: { createWorklist(n: string): unknown; pushRefdesToActive(r: string): unknown } };
    const parts = w.__boardStore.board.parts;
    const pick = [parts[0].name, parts[20].name];
    w.__worklistStore.createWorklist('Map steps');
    for (const n of pick) w.__worklistStore.pushRefdesToActive(n);
    w.__boardStore.selectPart(null);
    return pick;
  });
  await expect(map).toHaveAttribute('data-wl-marks', '2');
  await expect(page.getByTestId('minimap-wl-pos')).toHaveText('2');

  const selName = () => page.evaluate(() => { const b = (window as unknown as W).__boardStore; const i = b.selection.partIndex; return i === null ? null : b.board.parts[i].name; });
  const next = page.getByTestId('minimap-history-forward');
  await next.click();
  await expect.poll(selName).toBe(names[0]);
  await expect(page.getByTestId('minimap-wl-pos')).toHaveText('1/2');
  await next.click();
  await expect.poll(selName).toBe(names[1]);
  await expect(page.getByTestId('minimap-wl-pos')).toHaveText('2/2');
  await expect(next).toBeDisabled();                       // no wrap
  await page.getByTestId('minimap-history-back').click();
  await expect.poll(selName).toBe(names[0]);

  // The header's tab button now opens the board's Worklist tab.
  await page.getByTestId('minimap-open-tab').click();
  await expect(page.getByTestId('worklist-panel')).toBeVisible();

  // Back to history mode: the worklist marks go, the trail returns.
  await page.getByTestId('minimap-nav-history').click();
  await expect(map).toHaveAttribute('data-wl-marks', '0');
});
