/**
 * Worklist ‹ › stepping: walk the rows in order — parts, then nets — taking
 * the board to each, with a net row's reading slots open. Public fixture.
 */
import { test, expect, type Page } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(HERE, '../public/samples/test-board.bvr');

type Stores = {
  __worklistStore: { createWorklist: (n: string) => { id: string } | null; pushParts: (id: string, i: number[]) => void; pushNets: (id: string, n: string[]) => void };
  __boardStore: { board: { parts: { name: string; pins: { net: string }[] }[] }; selection: { partIndex: number | null; highlightedNet: string | null } };
};

async function setup(page: Page) {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.setInputFiles('[data-testid="file-input"]', FIXTURE);
  await page.waitForFunction(() => !!(window as unknown as { __boardStore?: { board?: unknown } }).__boardStore?.board, { timeout: 20000 });
  await page.locator('.board-sidebar-toggle').first().click();
  await page.locator('[data-board-tab="worklist"]').click();
  return page.evaluate(() => {
    const w = window as unknown as Stores;
    const parts = w.__boardStore.board.parts;
    const net = parts.flatMap(p => p.pins.map(pin => pin.net)).find(n => n && n !== 'GND')!;
    const wl = w.__worklistStore.createWorklist('Round')!;
    w.__worklistStore.pushParts(wl.id, [0, 1]);
    w.__worklistStore.pushNets(wl.id, [net]);
    return { p0: parts[0].name, p1: parts[1].name, net };
  });
}

const sel = (page: Page) => page.evaluate(() => {
  const w = window as unknown as Stores;
  const s = w.__boardStore.selection;
  return { part: s.partIndex === null ? null : w.__boardStore.board.parts[s.partIndex].name, net: s.highlightedNet };
});

test('‹ › walk the worklist: parts, then nets, and stop at the ends', async ({ page }) => {
  const t = await setup(page);
  const prev = page.getByTestId('worklist-prev');
  const next = page.getByTestId('worklist-next');
  const pos = page.getByTestId('worklist-step-pos');
  await expect(pos).toHaveText('3');                       // nothing selected yet: the count

  await next.click();
  await expect(pos).toHaveText('1/3');
  expect((await sel(page)).part).toBe(t.p0);
  await expect(page.locator('.wl-row.sel')).toHaveAttribute('data-wl-key', 'p:' + t.p0);
  await expect(prev).toBeDisabled();

  await next.click();
  expect((await sel(page)).part).toBe(t.p1);

  await next.click();
  await expect(pos).toHaveText('3/3');
  expect((await sel(page)).net).toBe(t.net);
  await expect(next).toBeDisabled();
  // A net row steps open with its reading slots, ready for a value.
  await expect(page.locator('.wl-row.sel [data-testid="net-meas-input-diode"]')).toBeVisible();

  await prev.click();
  await expect(pos).toHaveText('2/3');
  expect((await sel(page)).part).toBe(t.p1);
});
