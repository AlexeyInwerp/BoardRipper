/**
 * Proposal C: the app bar is about the app, the board ribbon is about the
 * board. Side / butterfly / rotate / traces / more-transforms live in the
 * ribbon as slots; the toolbar keeps sidebar, Open, search, 2-window, about,
 * version. Same store actions, same shortcuts — only the home moved.
 * Public fixture, no backend.
 */
import { test, expect, type Page } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(HERE, '../public/samples/test-board.bvr');
const BAR = '[data-testid="board-overlay-bar"]';

async function openFixture(page: Page) {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.setInputFiles('[data-testid="file-input"]', FIXTURE);
  await expect(page.getByTestId('board-overlay-bar')).toBeVisible();
}

test.describe('board transforms in the ribbon', () => {
  test('the app bar no longer carries board controls; the ribbon does', async ({ page }) => {
    await openFixture(page);
    const toolbar = page.getByTestId('toolbar');
    await expect(toolbar.getByText('Top', { exact: true })).toHaveCount(0);
    await expect(toolbar.getByText('Bottom', { exact: true })).toHaveCount(0);
    await expect(toolbar.getByTestId('two-window-toggle')).toBeVisible();
    await expect(toolbar.getByTestId('open-btn')).toHaveText(/Open/);

    const bar = page.locator(BAR);
    await expect(bar.getByTestId('side-top')).toBeVisible();
    await expect(bar.getByTestId('side-bottom')).toBeVisible();
    await expect(bar.getByTestId('butterfly-btn')).toBeVisible();      // BVR: no layers
    await expect(bar.getByTestId('rotate-ccw')).toBeVisible();
    await expect(bar.getByTestId('rotate-cw')).toBeVisible();
    await expect(bar.getByTestId('transform-menu')).toBeVisible();
    await expect(bar.getByTestId('traces-btn')).toHaveCount(0);        // BVR: no traces
    // Transforms lead the row: Side comes before Follow PDF.
    const order = await bar.locator('[data-testid]').evaluateAll(els => els.map(e => e.getAttribute('data-testid')));
    expect(order.indexOf('side-top')).toBeLessThan(order.indexOf('overlay-collapse'));
  });

  test('side switch: click, both, and butterfly light the same way the toolbar did', async ({ page }) => {
    await openFixture(page);
    const top = page.getByTestId('side-top');
    const bottom = page.getByTestId('side-bottom');
    await expect(top).toHaveClass(/active/);
    await expect(bottom).not.toHaveClass(/active/);

    await bottom.click();
    await expect(bottom).toHaveClass(/active/);
    await expect(top).not.toHaveClass(/active/);

    await top.click({ modifiers: ['Shift'] });                          // both
    await expect(top).toHaveClass(/active/);
    await expect(bottom).toHaveClass(/active/);

    await page.getByTestId('butterfly-btn').click();
    await expect(page.getByTestId('butterfly-btn')).toHaveClass(/active/);
    await expect(top).toHaveClass(/active/);
    await expect(bottom).toHaveClass(/active/);
    await page.getByTestId('butterfly-btn').click();
    await expect(page.getByTestId('butterfly-btn')).not.toHaveClass(/active/);
  });

  test('rotate buttons and the transform menu act without errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    await openFixture(page);
    for (let i = 0; i < 4; i++) await page.getByTestId('rotate-cw').click();
    await page.getByTestId('rotate-ccw').click();

    await page.getByTestId('transform-menu').click();
    const menu = page.getByTestId('transform-menu-popup');
    await expect(menu).toBeVisible();
    await expect(menu.getByTestId('transform-rotate-180')).toBeVisible();
    await expect(menu.getByTestId('transform-mirror-h')).toBeVisible();
    await expect(menu.getByTestId('transform-mirror-v')).toBeVisible();
    // Flip axis is a two-way check; exactly one is ticked.
    const v = menu.getByTestId('transform-flip-vertical');
    const h = menu.getByTestId('transform-flip-horizontal');
    const vOn = (await v.getAttribute('aria-checked')) === 'true';
    expect(vOn !== ((await h.getAttribute('aria-checked')) === 'true')).toBeTruthy();
    await (vOn ? h : v).click();
    await expect(menu).toBeHidden();
    await page.getByTestId('transform-menu').click();
    await expect(page.getByTestId('transform-menu-popup').getByTestId('transform-flip-vertical'))
      .toHaveAttribute('aria-checked', vOn ? 'false' : 'true');
    await page.getByTestId('transform-mirror-h').click();
    await expect(page.getByTestId('transform-menu-popup')).toBeHidden();
    expect(errors).toEqual([]);
  });

  test('the new slots are editable like any other: hide Side from the ribbon menu, bring it back', async ({ page }) => {
    await openFixture(page);
    await page.click(BAR, { button: 'right' });
    await page.getByTestId('board-bar-menu').getByRole('menuitemcheckbox', { name: 'Side' }).click();
    await expect(page.getByTestId('side-top')).toHaveCount(0);
    await page.click(BAR, { button: 'right' });
    await page.getByTestId('board-bar-menu').getByRole('menuitemcheckbox', { name: 'Side' }).click();
    await expect(page.getByTestId('side-top')).toBeVisible();
  });

  test('Find part / Find net: inline fields in the row, icon triggers only in the column', async ({ page }) => {
    await openFixture(page);
    const bar = page.locator(BAR);
    // Row: the field is simply there, no button in front of it.
    await expect(bar.getByTestId('parts-filter-input')).toBeVisible();
    await expect(bar.getByTestId('nets-filter-input')).toBeVisible();
    await expect(bar.getByTestId('parts-search-btn')).toHaveCount(0);
    // Column: the field folds behind the magnifier and opens on click.
    await page.click(BAR, { button: 'right' });
    await page.getByTestId('bar-menu-vertical').click();
    await expect(bar.getByTestId('parts-search-btn')).toBeVisible();
    await expect(bar.getByTestId('parts-filter-input')).toHaveCount(0);       // no field until asked
    await bar.getByTestId('parts-search-btn').click();
    const input = bar.getByTestId('parts-filter-input');
    await expect(input).toBeVisible();
    await expect(input).toBeFocused();
    await input.fill('U');
    await expect(page.locator('.overlay-dropdown-popover')).toBeVisible();
    await input.press('Escape');
    await expect(bar.getByTestId('parts-filter-input')).toHaveCount(0);
    // Nets: same trigger, net glyph, same contract.
    await bar.getByTestId('nets-search-btn').click();
    await expect(bar.getByTestId('nets-filter-input')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(bar.getByTestId('nets-filter-input')).toHaveCount(0);
    await page.click(BAR, { button: 'right' });
    await page.getByTestId('board-bar-menu').getByRole('menuitemcheckbox', { name: 'Horizontal', exact: true }).click();
    await expect(bar.getByTestId('parts-filter-input')).toBeVisible();
  });

  test('the suggestion list never runs off the bottom of the window', async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 420 });
    await openFixture(page);
    // Park the ribbon low enough that 300px of list would not fit under it
    // (through the store: in a window this short the ribbon menu itself is
    // taller than the viewport).
    await page.evaluate(() => {
      const w = window as Window & { __renderSettings?: { setOverlayPosition: (p: string) => void; setOverlayFloatPos: (x: number, y: number) => void } };
      w.__renderSettings!.setOverlayPosition('floating');
      w.__renderSettings!.setOverlayFloatPos(40, 260);
    });
    await expect(page.locator(BAR)).toHaveAttribute('data-position', 'floating');
    const input = page.locator(BAR).getByTestId('parts-filter-input');
    await input.click();
    const list = page.locator('.overlay-dropdown-popover');
    await expect(list).toBeVisible();
    const box = (await list.boundingBox())!;
    const inputBox = (await input.boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(420);
    expect(box.y).toBeGreaterThanOrEqual(0);
    // Rows are still usable: the list is either under the field or above it, never over it.
    expect(box.y >= inputBox.y + inputBox.height || box.y + box.height <= inputBox.y).toBeTruthy();
    await page.keyboard.press('Escape');
    await page.evaluate(() => (window as Window & { __renderSettings?: { setOverlayPosition: (p: string) => void } }).__renderSettings!.setOverlayPosition('left'));
  });

  test('vertical column is one button wide: no side words, search pops out beside it', async ({ page }) => {
    await openFixture(page);
    await page.click(BAR, { button: 'right' });
    await page.getByTestId('bar-menu-vertical').click();
    const bar = page.locator(BAR);
    await expect(bar).toHaveClass(/vertical/);
    const w = (await bar.boundingBox())!.width;
    expect(w).toBeLessThan(60);
    await expect(bar.getByTestId('side-top').getByText('Top')).toBeHidden();
    await bar.getByTestId('nets-search-btn').click();
    const field = (await bar.getByTestId('nets-filter-input').boundingBox())!;
    const barBox = (await bar.boundingBox())!;
    expect(field.x).toBeGreaterThanOrEqual(barBox.x + barBox.width - 1);      // beside the column, not inside it
    await page.keyboard.press('Escape');
    await page.click(BAR, { button: 'right' });
    await page.getByTestId('board-bar-menu').getByRole('menuitemcheckbox', { name: 'Horizontal', exact: true }).click();
  });

  test('existing users get the transforms at the FRONT of a saved layout, not the end', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    const ids = await page.evaluate(() => {
      const w = window as Window & { __overlayTest?: { reconcileOverlayLayout: (saved: unknown) => Array<{ id: string }> } };
      // A pre-v0.39 layout: the twelve old slots, one of them hidden, in a user order.
      return w.__overlayTest!.reconcileOverlayLayout([
        { id: 'fitBoard', visible: true }, { id: 'pdfFollow', visible: true }, { id: 'scrollMode', visible: false }, { id: 'sep1', visible: true },
        { id: 'hoverInfo', visible: true }, { id: 'netDim', visible: true }, { id: 'netLines', visible: true }, { id: 'ghosts', visible: true },
        { id: 'diodeValues', visible: true }, { id: 'sep2', visible: true }, { id: 'partsDropdown', visible: true }, { id: 'netsDropdown', visible: true },
      ]).map(s => s.id);
    });
    expect(ids.slice(0, 6)).toEqual(['sideSwitch', 'butterfly', 'rotateCCW', 'rotateCW', 'transformMenu', 'sep0']);
    expect(ids.slice(6, 9)).toEqual(['fitBoard', 'pdfFollow', 'scrollMode']);   // the user's own order, untouched
    expect(ids.indexOf('traces')).toBe(ids.indexOf('diodeValues') + 1);
  });
});
