import { test, expect, type Page } from '@playwright/test';
import fs from 'fs';

// Info tab net tree: selecting a PIN fans that pin's net out beneath it;
// selecting only a COMPONENT does not. The tree never lists the selected part
// itself, and it sits inline under its own pin row for small nets / below the
// pin table for large ones so a power rail can't bury the pinout.
const BOARD = '/Users/besitzer/Desktop/Boardviewer/samples/820-02016/820-02016.bvr';

/** Others hanging inline before the block moves below the table. Mirrors
 *  NET_TREE_INLINE_MAX in NetBranchSection.tsx. */
const INLINE_MAX = 3;

/** Load the sample board and open the sidebar's Info tab. */
async function openInfoTab(page: Page) {
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles(BOARD);
  await expect(page.getByTestId('statusbar')).toContainText('Components:', { timeout: 60000 });
  await page.locator('.board-sidebar-toggle').first().click();
  await page.locator('.board-sidebar-tab', { hasText: 'Info' }).click();
}

/** Pick a part+pin whose net carries a component count inside [min,max]
 *  (counting the part itself), so we can steer inline vs below placement. */
async function pickTarget(page: Page, min: number, max: number) {
  return page.evaluate(({ min, max }) => {
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
        if (parts.size >= min && parts.size <= max) {
          return { partIndex: p, pinIndex: i, net, refdes: part.name, comps: parts.size };
        }
      }
    }
    return null;
  }, { min, max });
}

const readSel = (page: Page) =>
  page.evaluate(() => {
    const s = (window as any).__boardStore.selection;
    return { partIndex: s.partIndex, pinIndex: s.pinIndex, net: s.highlightedNet };
  });

const selectPin = (page: Page, t: { partIndex: number; pinIndex: number }) =>
  page.evaluate((x) => (window as any).__boardStore.selectPin(x.partIndex, x.pinIndex), t);

test('component selection shows no net tree; pin selection does', async ({ page }) => {
  test.skip(!fs.existsSync(BOARD), 'sample board not present');
  await openInfoTab(page);

  const target = await pickTarget(page, 2, 12);
  expect(target, 'a net with 2..12 components should exist').not.toBeNull();

  // Component only → component block, no net tree.
  await page.evaluate((t) => (window as any).__boardStore.selectPart(t!.partIndex), target);
  await expect(page.getByTestId('component-info')).toContainText(target!.refdes);
  await expect(page.getByTestId('net-branch')).toHaveCount(0);

  // Pin → component block plus the fan for that pin's net.
  await selectPin(page, target!);
  await expect(page.getByTestId('net-branch')).toBeVisible();
});

test('the selected part is not listed as a branch of its own net', async ({ page }) => {
  test.skip(!fs.existsSync(BOARD), 'sample board not present');
  await openInfoTab(page);

  const target = await pickTarget(page, 3, 12);
  expect(target).not.toBeNull();
  await selectPin(page, target!);
  await expect(page.getByTestId('net-branch')).toBeVisible();

  // One row per OTHER component — the subject is the block above, not a row.
  await expect(page.getByTestId('net-branch-row')).toHaveCount(target!.comps - 1);
  await expect(
    page.locator(`[data-testid="net-branch-row"][data-refdes="${target!.refdes}"]`),
  ).toHaveCount(0);
});

test('small nets hang inline and name the net once; big nets sit below and name it', async ({ page }) => {
  test.skip(!fs.existsSync(BOARD), 'sample board not present');
  await openInfoTab(page);

  // Small: others <= INLINE_MAX → inline, nameless strip.
  const small = await pickTarget(page, 2, INLINE_MAX + 1);
  expect(small, 'a small net should exist').not.toBeNull();
  await selectPin(page, small!);
  await expect(page.getByTestId('net-branch')).toHaveAttribute('data-placement', 'inline');
  await expect(page.getByTestId('net-strip')).toBeVisible();
  // The pin row above already names it — no second copy underneath.
  await expect(page.getByTestId('net-branch-name')).toHaveCount(0);
  // The block is a row inside the pin table, under its own pin.
  await expect(page.locator('.pin-table tr.net-slot [data-testid="net-branch"]')).toHaveCount(1);

  // Big: others > INLINE_MAX → below the table, header names the net.
  const big = await pickTarget(page, INLINE_MAX + 3, 40);
  test.skip(big === null, 'no net large enough on this board');
  await selectPin(page, big!);
  await expect(page.getByTestId('net-branch')).toHaveAttribute('data-placement', 'below');
  await expect(page.getByTestId('net-branch-name')).toHaveText(big!.net);
  await expect(page.getByTestId('net-strip')).toHaveCount(0);
  // Not nested in the pin table — the pinout stays scannable end to end.
  await expect(page.locator('.pin-table tr.net-slot')).toHaveCount(0);
});

test('the inline block collapses so the pin list can be read uninterrupted', async ({ page }) => {
  test.skip(!fs.existsSync(BOARD), 'sample board not present');
  await openInfoTab(page);

  const small = await pickTarget(page, 2, INLINE_MAX + 1);
  expect(small).not.toBeNull();
  await selectPin(page, small!);
  await expect(page.getByTestId('net-branch-row').first()).toBeVisible();

  await page.getByTestId('net-strip-caret').click();
  await expect(page.getByTestId('net-branch-row')).toHaveCount(0);
  // The strip itself stays — it is the net's one line in the pin list.
  await expect(page.getByTestId('net-strip')).toBeVisible();

  await page.getByTestId('net-strip-caret').click();
  await expect(page.getByTestId('net-branch-row').first()).toBeVisible();
});

test('chevron opens a spoiler and single click previews — neither moves the selection', async ({ page }) => {
  test.skip(!fs.existsSync(BOARD), 'sample board not present');
  await openInfoTab(page);

  const target = await pickTarget(page, 3, 12);
  expect(target).not.toBeNull();
  await selectPin(page, target!);
  await expect(page.getByTestId('net-branch')).toBeVisible();
  const before = await readSel(page);

  const other = page.getByTestId('net-branch-row').first();
  const otherRefdes = await other.getAttribute('data-refdes');
  expect(otherRefdes).toBeTruthy();

  // Chevron: spoiler opens, selection untouched.
  await other.getByTestId('net-branch-chevron').click();
  await expect(other.locator('..').getByTestId('net-branch-detail')).toBeVisible();
  expect(await readSel(page)).toEqual(before);

  // Single click: previews on the board, inspector keeps its subject.
  await other.click();
  expect(await readSel(page)).toEqual(before);
  await expect(other).toHaveClass(/net-branch-row--preview/);
});

test('double click promotes the component AND keeps the net tree alive', async ({ page }) => {
  test.skip(!fs.existsSync(BOARD), 'sample board not present');
  await openInfoTab(page);

  const target = await pickTarget(page, 3, 12);
  expect(target).not.toBeNull();
  await selectPin(page, target!);
  await expect(page.getByTestId('net-branch')).toBeVisible();
  const before = await readSel(page);

  const other = page.getByTestId('net-branch-row').first();
  const otherRefdes = await other.getAttribute('data-refdes');

  await other.dblclick();

  const after = await readSel(page);
  expect(after.partIndex).not.toBe(before.partIndex);
  const movedTo = await page.evaluate(
    (idx) => (window as any).__boardStore.board.parts[idx].name,
    after.partIndex,
  );
  expect(movedTo).toBe(otherRefdes);

  // The regression this guards: promoting used to go through focusPart(),
  // which sets pinIndex = null, and ComponentInfoBody derives the tree from
  // pinIndex — so the net you were walking vanished from the panel while
  // staying lit on the board. Promotion must select a pin ON the net.
  expect(after.pinIndex).not.toBeNull();
  expect(after.net).toBe(before.net);
  await expect(page.getByTestId('net-branch')).toBeVisible();
  await expect(page.getByTestId('component-info')).toContainText(otherRefdes!);

  // ...and the part we came from is now a branch of the same net.
  await expect(
    page.locator(`[data-testid="net-branch-row"][data-refdes="${target!.refdes}"]`),
  ).toHaveCount(1);
});
