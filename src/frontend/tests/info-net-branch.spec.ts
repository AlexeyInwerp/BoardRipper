import { test, expect, type Page } from '@playwright/test';
import fs from 'fs';

// Info tab net branch: selecting a PIN adds a net section listing every
// component on that net; selecting only a COMPONENT does not.
const BOARD = '/Users/besitzer/Desktop/Boardviewer/samples/820-02016/820-02016.bvr';

/** Load the sample board and open the sidebar's Info tab. */
async function openInfoTab(page: Page) {
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles(BOARD);
  await expect(page.getByTestId('statusbar')).toContainText('Components:', { timeout: 60000 });
  await page.locator('.board-sidebar-toggle').first().click();
  await page.locator('.board-sidebar-tab', { hasText: 'Info' }).click();
}

/** Pick a part+pin whose net carries at least two distinct components, so the
 *  branch has a neighbour to expand. */
async function pickTarget(page: Page) {
  return page.evaluate(() => {
    const bs: any = (window as any).__boardStore;
    const board = bs.board;
    for (let p = 0; p < board.parts.length; p++) {
      const part = board.parts[p];
      for (let i = 0; i < part.pins.length; i++) {
        const net = part.pins[i].net;
        if (!net) continue;
        const entry = board.nets.get(net);
        if (!entry) continue;
        const parts = new Set(entry.pinIndices.map((r: any) => r.partIndex));
        if (parts.size >= 2 && parts.size <= 12) {
          return { partIndex: p, pinIndex: i, net, refdes: part.name, comps: parts.size };
        }
      }
    }
    return null;
  });
}

test('component selection shows no net branch; pin selection does', async ({ page }) => {
  test.skip(!fs.existsSync(BOARD), 'sample board not present');
  await openInfoTab(page);

  const target = await pickTarget(page);
  expect(target, 'a net with 2..12 components should exist').not.toBeNull();

  // Component only → component block, no net branch.
  await page.evaluate((t) => (window as any).__boardStore.selectPart(t!.partIndex), target);
  await expect(page.getByTestId('component-info')).toContainText(target!.refdes);
  await expect(page.getByTestId('net-branch')).toHaveCount(0);

  // Pin → component block plus the net branch for that pin's net.
  await page.evaluate(
    (t) => (window as any).__boardStore.selectPin(t!.partIndex, t!.pinIndex),
    target,
  );
  await expect(page.getByTestId('net-branch')).toBeVisible();
  await expect(page.getByTestId('net-branch-name')).toHaveText(target!.net);
  await expect(page.getByTestId('net-branch-row')).toHaveCount(target!.comps);
});

test('chevron opens a spoiler without changing the selection; the row selects', async ({ page }) => {
  test.skip(!fs.existsSync(BOARD), 'sample board not present');
  await openInfoTab(page);

  const target = await pickTarget(page);
  expect(target).not.toBeNull();
  await page.evaluate(
    (t) => (window as any).__boardStore.selectPin(t!.partIndex, t!.pinIndex),
    target,
  );
  await expect(page.getByTestId('net-branch')).toBeVisible();

  const readSel = () =>
    page.evaluate(() => {
      const s = (window as any).__boardStore.selection;
      return { partIndex: s.partIndex, pinIndex: s.pinIndex, net: s.highlightedNet };
    });
  const before = await readSel();

  // A row belonging to some OTHER component than the selected one.
  const other = page
    .locator(`[data-testid="net-branch-row"]:not([data-refdes="${target!.refdes}"])`)
    .first();
  const otherRefdes = await other.getAttribute('data-refdes');
  expect(otherRefdes).toBeTruthy();

  // Chevron: spoiler opens, selection untouched.
  await other.getByTestId('net-branch-chevron').click();
  await expect(other.locator('..').getByTestId('net-branch-detail')).toBeVisible();
  expect(await readSel()).toEqual(before);

  // Row body: selection moves to that component.
  await other.click();
  const after = await readSel();
  expect(after.partIndex).not.toBe(before.partIndex);
  const movedTo = await page.evaluate(
    (idx) => (window as any).__boardStore.board.parts[idx].name,
    after.partIndex,
  );
  expect(movedTo).toBe(otherRefdes);
});
