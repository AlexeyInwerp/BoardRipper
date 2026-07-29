import { test, expect, type Page } from '@playwright/test';
import fs from 'fs';

// Info tab net tree: selecting a PIN fans that pin's net out beneath it;
// selecting only a COMPONENT does not. The tree never lists the selected part
// itself, always hangs as a row inside the pin table under the pin it belongs
// to, previews a few components behind a "+N more" spoiler, and skips ground.
const BOARD = '/Users/besitzer/Desktop/Boardviewer/samples/820-02016/820-02016.bvr';

/** Components shown before the "+N more" spoiler. Mirrors
 *  NET_TREE_PREVIEW_ROWS in NetBranchSection.tsx. */
const PREVIEW_ROWS = 3;

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
        // Ground rails deliberately get no tree, so they can never be a target.
        const u = net.toUpperCase();
        if (u.includes('GND') || u.includes('VSS')) continue;
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

  const target = await pickTarget(page, 3, PREVIEW_ROWS + 1);
  expect(target).not.toBeNull();
  await selectPin(page, target!);
  await expect(page.getByTestId('net-branch')).toBeVisible();

  // One row per OTHER component — the subject is the block above, not a row.
  await expect(page.getByTestId('net-branch-row')).toHaveCount(target!.comps - 1);
  await expect(
    page.locator(`[data-testid="net-branch-row"][data-refdes="${target!.refdes}"]`),
  ).toHaveCount(0);
});

test('the tree always hangs inside the pin table and names the net once', async ({ page }) => {
  test.skip(!fs.existsSync(BOARD), 'sample board not present');
  await openInfoTab(page);

  const target = await pickTarget(page, 2, 40);
  expect(target).not.toBeNull();
  await selectPin(page, target!);

  // A row inside the pin table, under its own pin — never a separate section.
  await expect(page.locator('.pin-table tr.net-slot [data-testid="net-branch"]')).toHaveCount(1);
  await expect(page.getByTestId('net-counts')).toBeVisible();
  // The pin row above already names it — no second copy underneath.
  await expect(page.getByTestId('net-branch-name')).toHaveCount(0);
});

test('a big net shows the first few and hides the rest behind "+N more"', async ({ page }) => {
  test.skip(!fs.existsSync(BOARD), 'sample board not present');
  await openInfoTab(page);

  const big = await pickTarget(page, PREVIEW_ROWS + 3, 40);
  test.skip(big === null, 'no net large enough on this board');
  await selectPin(page, big!);

  // Preview only — the pinout underneath must stay visible.
  await expect(page.getByTestId('net-branch-row')).toHaveCount(PREVIEW_ROWS);
  const more = page.getByTestId('net-branch-more');
  await expect(more).toBeVisible();
  await expect(more).toContainText(`${big!.comps - 1 - PREVIEW_ROWS} more`);

  await more.click();
  await expect(page.getByTestId('net-branch-row')).toHaveCount(big!.comps - 1);
  await expect(page.getByTestId('net-branch-more')).toHaveCount(0);
});

test('ground rails get no tree at all', async ({ page }) => {
  test.skip(!fs.existsSync(BOARD), 'sample board not present');
  await openInfoTab(page);

  const gnd = await page.evaluate(() => {
    const board: any = (window as any).__boardStore.board;
    for (let p = 0; p < board.parts.length; p++) {
      const part = board.parts[p];
      for (let i = 0; i < part.pins.length; i++) {
        if ((part.pins[i].net || '').toUpperCase() === 'GND') return { partIndex: p, pinIndex: i };
      }
    }
    return null;
  });
  test.skip(gnd === null, 'no GND net on this board');

  await selectPin(page, gnd!);
  // The component block still renders; the fan-out does not.
  await expect(page.getByTestId('component-info')).toBeVisible();
  await expect(page.getByTestId('net-branch')).toHaveCount(0);
});

test('the inline block collapses so the pin list can be read uninterrupted', async ({ page }) => {
  test.skip(!fs.existsSync(BOARD), 'sample board not present');
  await openInfoTab(page);

  const small = await pickTarget(page, 2, PREVIEW_ROWS + 1);
  expect(small).not.toBeNull();
  await selectPin(page, small!);
  await expect(page.getByTestId('net-branch-row').first()).toBeVisible();

  await page.getByTestId('net-caret').click();
  await expect(page.getByTestId('net-branch-row')).toHaveCount(0);
  // The strip itself stays — it is the net's one line in the pin list.
  await expect(page.getByTestId('net-counts')).toBeVisible();

  await page.getByTestId('net-caret').click();
  await expect(page.getByTestId('net-branch-row').first()).toBeVisible();
});

test('clicking another net in the pin list re-roots the tree on it, expanded', async ({ page }) => {
  test.skip(!fs.existsSync(BOARD), 'sample board not present');
  await openInfoTab(page);

  // A part carrying two DIFFERENT non-ground nets, so switching is possible.
  const pair = await page.evaluate(() => {
    const board: any = (window as any).__boardStore.board;
    const ok = (n: string) => {
      if (!n) return false;
      const u = n.toUpperCase();
      if (u.includes('GND') || u.includes('VSS')) return false;
      return (board.nets.get(n)?.pinIndices.length ?? 0) >= 2;
    };
    for (let p = 0; p < board.parts.length; p++) {
      const part = board.parts[p];
      const hits: { pinIndex: number; net: string }[] = [];
      const seen = new Set<string>();
      for (let i = 0; i < part.pins.length; i++) {
        const n = part.pins[i].net;
        if (!ok(n) || seen.has(n)) continue;
        seen.add(n);
        hits.push({ pinIndex: i, net: n });
        if (hits.length === 2) return { partIndex: p, first: hits[0], second: hits[1] };
      }
    }
    return null;
  });
  expect(pair, 'a part with two non-ground nets should exist').not.toBeNull();

  await selectPin(page, { partIndex: pair!.partIndex, pinIndex: pair!.first.pinIndex });
  await expect(page.getByTestId('net-branch')).toBeVisible();

  // Collapse, so we also prove the next net does NOT inherit the collapse.
  await page.getByTestId('net-caret').click();
  await expect(page.getByTestId('net-branch-row')).toHaveCount(0);

  const other = pair!.second;

  // Click the NET CELL of that row — not the row body.
  await page.locator(`.pin-table tr:nth-child(${other!.pinIndex + 1}) .pin-net`).click();

  const sel = await readSel(page);
  expect(sel.pinIndex).toBe(other!.pinIndex);
  expect(sel.net).toBe(other!.net);
  // Re-rooted AND expanded — the collapse did not carry over.
  await expect(page.getByTestId('net-branch')).toBeVisible();
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

test('preview marks the part: loud burst first, then a quiet beacon', async ({ page }) => {
  test.skip(!fs.existsSync(BOARD), 'sample board not present');
  test.slow(); // deliberately waits out the 5.5 s burst
  await openInfoTab(page);

  const target = await pickTarget(page, 3, 12);
  expect(target).not.toBeNull();
  await selectPin(page, target!);
  await expect(page.getByTestId('net-branch')).toBeVisible();

  const pulse = () => page.evaluate(() => (window as any).__boardStore.previewPulse);
  expect(await pulse(), 'nothing marked before previewing').toBeNull();

  const row = page.getByTestId('net-branch-row').first();
  const refdes = await row.getAttribute('data-refdes');
  await row.click();

  // Arrival: the loud one, aimed at the part we clicked.
  const burst = await pulse();
  expect(burst?.phase).toBe('burst');
  const marked = await page.evaluate(
    (i) => (window as any).__boardStore.board.parts[i].name, burst!.partIndex);
  expect(marked).toBe(refdes);

  // It decays into the beacon, and the beacon does NOT expire — the whole
  // point is that the part is still findable when you look back later.
  await expect.poll(async () => (await pulse())?.phase, { timeout: 12000 }).toBe('beacon');
  await page.waitForTimeout(2500);
  expect((await pulse())?.phase).toBe('beacon');

  // Promoting hands the part over to the selection's own treatment; two
  // markers on one component would read as a bug.
  await row.dblclick();
  expect(await pulse()).toBeNull();
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
