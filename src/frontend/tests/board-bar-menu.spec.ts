/**
 * Editing the board ribbon where it lives, and in Settings.
 *   - right-click the bar → a menu lists every named slot with a tick;
 *     unticking hides it from the bar at once, ticking brings it back
 *   - the menu also sets row position, folds, resets, and jumps to Settings
 *   - Settings ▸ Board overlay is one labelled list: eye, arrows, × on separators
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

function layoutIds(page: Page) {
  return page.evaluate(() => {
    const w = window as Window & { __renderSettings?: { settings: { overlayLayout: Array<{ id: string; visible: boolean }> } } };
    return w.__renderSettings!.settings.overlayLayout;
  });
}

test.describe('board ribbon editing', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      if (sessionStorage.getItem('bar-menu-spec-init')) return;
      sessionStorage.setItem('bar-menu-spec-init', '1');
      localStorage.removeItem('boardripper-overlay-collapsed');
      localStorage.removeItem('boardripper-render-settings-global');
    });
  });

  test('right-click menu lists slots by name and toggles them live', async ({ page }) => {
    await openFixture(page);
    // Fit board is on the bar by default.
    await expect(page.locator(BAR).getByTitle('Zoom to fit board')).toHaveCount(1);

    await page.click(BAR, { button: 'right' });
    const menu = page.getByTestId('board-bar-menu');
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitemcheckbox', { name: 'Fit board' })).toHaveAttribute('aria-checked', 'true');
    await expect(menu.getByRole('menuitemcheckbox', { name: 'Find part' })).toBeVisible();
    // Separators are not offered — they are layout, not controls.
    await expect(menu.getByRole('menuitemcheckbox', { name: 'Separator' })).toHaveCount(0);

    await menu.getByRole('menuitemcheckbox', { name: 'Fit board' }).click();
    await expect(menu).toBeHidden();
    await expect(page.locator(BAR).getByTitle('Zoom to fit board')).toHaveCount(0);
    expect((await layoutIds(page)).find(s => s.id === 'fitBoard')?.visible).toBe(false);

    await page.click(BAR, { button: 'right' });
    await expect(page.getByTestId('board-bar-menu').getByRole('menuitemcheckbox', { name: 'Fit board' })).toHaveAttribute('aria-checked', 'false');
    await page.getByTestId('board-bar-menu').getByRole('menuitemcheckbox', { name: 'Fit board' }).click();
    await expect(page.locator(BAR).getByTitle('Zoom to fit board')).toHaveCount(1);
  });

  test('row position, fold and reset from the menu', async ({ page }) => {
    await openFixture(page);
    await page.click(BAR, { button: 'right' });
    await page.getByTestId('board-bar-menu').getByRole('menuitemcheckbox', { name: 'Centred' }).click();
    await expect(page.locator(BAR)).toHaveClass(/center/);

    await page.click(BAR, { button: 'right' });
    await page.getByTestId('board-bar-menu').getByRole('menuitem', { name: 'Fold controls' }).click();
    await expect(page.locator(BAR)).toHaveAttribute('data-collapsed', 'true');
    // Folded, the menu still opens from the nub and offers Unfold.
    await page.click(BAR, { button: 'right' });
    await page.getByTestId('board-bar-menu').getByRole('menuitem', { name: 'Unfold controls' }).click();
    await expect(page.locator(BAR)).toHaveAttribute('data-collapsed', 'false');

    await page.click(BAR, { button: 'right' });
    await page.getByTestId('bar-menu-reset').click();
    await expect(page.locator(BAR)).not.toHaveClass(/center/);
    const ids = (await layoutIds(page)).map(s => s.id);
    expect(ids[0]).toBe('pdfFollow');
    expect(ids.length).toBe(12);
  });

  test('"Customise…" opens Settings on the Board overlay editor', async ({ page }) => {
    await openFixture(page);
    await page.click(BAR, { button: 'right' });
    await page.getByTestId('bar-menu-customise').click();
    await expect(page.locator('[data-testid="activity-rail"] [data-sidebar-tab="settings"]')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('overlay-customizer-list')).toBeVisible();
  });

  test('Settings editor: names, eye, arrows, separators', async ({ page }) => {
    await openFixture(page);
    await page.click('[data-testid="activity-rail"] [data-sidebar-tab="settings"]');
    await page.locator('.sidebar [data-settings-tab="board"]').click();
    // Open the section if it is collapsed.
    const header = page.locator('button.settings-section-header:has-text("Board overlay")');
    if (await page.getByTestId('overlay-customizer-list').count() === 0) await header.click();
    const list = page.getByTestId('overlay-customizer-list');
    await expect(list).toBeVisible();

    // Every row is named.
    await expect(list.getByText('Spotlight', { exact: true })).toBeVisible();
    await expect(list.getByText('Find net', { exact: true })).toBeVisible();

    // Eye hides Hover info on the live bar; row dims.
    await page.getByTestId('overlay-slot-eye-hoverInfo').click();
    await expect(page.getByTestId('overlay-slot-row-hoverInfo')).toHaveClass(/is-hidden/);
    await expect(page.locator(BAR).getByTitle(/Hover info/)).toHaveCount(0);
    await page.getByTestId('overlay-slot-eye-hoverInfo').click();
    await expect(page.locator(BAR).getByTitle(/Hover info/)).toHaveCount(1);

    // Arrows reorder: move scrollMode up above pdfFollow.
    await page.getByTestId('overlay-slot-up-scrollMode').click();
    expect((await layoutIds(page)).map(s => s.id).slice(0, 2)).toEqual(['scrollMode', 'pdfFollow']);
    await expect(page.getByTestId('overlay-slot-up-scrollMode')).toBeDisabled();       // now first

    // Separators: add one, remove it.
    const before = (await layoutIds(page)).length;
    await page.getByTestId('overlay-add-separator-btn').click();
    const after = await layoutIds(page);
    expect(after.length).toBe(before + 1);
    const newSep = after.map(s => s.id).find(id => /^sep\d+$/.test(id) && id !== 'sep1' && id !== 'sep2')!;
    await page.getByTestId(`overlay-slot-remove-${newSep}`).click();
    expect((await layoutIds(page)).length).toBe(before);
    // Named slots have no remove button.
    await expect(page.getByTestId('overlay-slot-remove-fitBoard')).toHaveCount(0);

    // Reset layout puts scrollMode back and leaves selection behaviour alone.
    await page.getByTestId('overlay-reset-layout-btn').click();
    expect((await layoutIds(page)).map(s => s.id)[0]).toBe('pdfFollow');
  });
});
