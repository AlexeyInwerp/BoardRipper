/**
 * Minimap placement from its right-click menu: left, centre, right, or float
 * (the map follows the pointer and a click puts it down). Also: the PDF page
 * scrubber is off unless switched on. Public samples, no backend.
 */
import { test, expect, type Page } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BOARD = path.resolve(HERE, '../public/samples/tomu-fpga.kicad_pcb');
const LONG_PDF = path.resolve(HERE, 'fixtures/many-page-text.pdf');

async function openBoardWithMap(page: Page) {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.setInputFiles('[data-testid="file-input"]', BOARD);
  const btn = page.getByTestId('minimap-toggle');
  await expect(btn).toBeVisible();
  await btn.click();                                   // while panning → always on
  await expect(btn).toHaveAttribute('data-mode', 'always');
  const map = page.getByTestId('board-minimap');
  await expect(map).toHaveAttribute('data-visible', 'true');
  return map;
}

async function pickPosition(page: Page, id: 'left' | 'center' | 'right' | 'floating') {
  await page.getByTestId('board-minimap').click({ button: 'right' });
  await page.getByTestId(`minimap-pos-${id}`).click();
  await expect(page.getByTestId('minimap-menu')).toHaveCount(0);
}

test.describe('minimap placement', () => {
  test('left, centre and right from the right-click menu', async ({ page }) => {
    const map = await openBoardWithMap(page);
    const panel = (await page.locator('.board-panel-root').first().boundingBox())!;
    const centre = (await map.boundingBox())!;
    expect(Math.abs(centre.x + centre.width / 2 - (panel.x + panel.width / 2))).toBeLessThan(4);

    await pickPosition(page, 'left');
    await expect(map).toHaveAttribute('data-position', 'left');
    await expect.poll(async () => (await map.boundingBox())!.x - panel.x).toBeLessThan(20);

    await pickPosition(page, 'right');
    await expect(map).toHaveAttribute('data-position', 'right');
    await expect.poll(async () => { const b = (await map.boundingBox())!; return panel.x + panel.width - (b.x + b.width); }).toBeLessThan(20);

    await pickPosition(page, 'center');
    await expect(map).toHaveAttribute('data-position', 'center');
  });

  test('opacity from the right-click menu: live, full under the pointer and while panning (unless unticked), survives a reload', async ({ page }) => {
    const map = await openBoardWithMap(page);
    const opacity = () => map.evaluate(el => Number(getComputedStyle(el).opacity));
    await expect.poll(opacity).toBe(1);
    await map.click({ button: 'right' });
    const slider = page.getByTestId('minimap-opacity');
    await slider.fill('40');
    // The menu stays open while the slider is used, and the map follows live.
    await expect(page.getByTestId('minimap-menu')).toBeVisible();
    await expect(page.getByTestId('minimap-menu')).toContainText('40 %');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('minimap-menu')).toHaveCount(0);
    await page.mouse.move(5, 5);
    await expect.poll(opacity).toBeCloseTo(0.4, 2);
    await map.hover();
    await expect.poll(opacity).toBe(1);
    await page.mouse.move(5, 5);
    await expect.poll(opacity).toBeCloseTo(0.4, 2);

    // Panning the board brings it to full strength, and it fades back after.
    const panel = (await page.locator('.board-panel-root').first().boundingBox())!;
    const panBoard = async () => {
      const x = panel.x + panel.width * 0.3, y = panel.y + panel.height * 0.7;
      await page.mouse.move(x, y);
      await page.mouse.down();
      for (let i = 1; i <= 8; i++) await page.mouse.move(x + i * 12, y - i * 6);
    };
    await panBoard();
    await expect.poll(opacity).toBe(1);
    await page.mouse.up();
    await page.mouse.move(5, 5);
    await expect.poll(opacity, { timeout: 4000 }).toBeCloseTo(0.4, 2);

    // Unticked, the chosen opacity holds while panning.
    await map.click({ button: 'right' });
    await page.getByTestId('minimap-opaque-active').click();
    await page.mouse.move(5, 5);
    await panBoard();
    await page.waitForTimeout(300);
    expect(await opacity()).toBeCloseTo(0.4, 2);
    await page.mouse.up();
    await page.mouse.move(5, 5);

    await page.reload();
    const discard = page.getByTestId('session-discard');
    await discard.waitFor({ timeout: 5000 }).then(() => discard.click(), () => {});
    await page.setInputFiles('[data-testid="file-input"]', BOARD);
    await expect(map).toHaveAttribute('data-visible', 'true');
    await expect.poll(opacity).toBeCloseTo(0.4, 2);
  });

  test('float follows the pointer, a click puts it down, and the place survives a reload', async ({ page }) => {
    const map = await openBoardWithMap(page);
    const panel = (await page.locator('.board-panel-root').first().boundingBox())!;
    await pickPosition(page, 'floating');
    await expect(map).toHaveAttribute('data-placing', 'true');
    const tx = panel.x + 250, ty = panel.y + panel.height - 200;
    await page.mouse.move(tx, ty, { steps: 6 });
    await page.mouse.click(tx, ty);
    await expect(map).toHaveAttribute('data-placing', 'false');
    await expect(map).toHaveAttribute('data-position', 'floating');
    // Centred on the click once the show/hide slide has finished.
    await expect.poll(async () => { const r = (await map.boundingBox())!; return Math.abs(r.x + r.width / 2 - tx) + Math.abs(r.y + r.height / 2 - ty); }).toBeLessThan(4);
    const b = (await map.boundingBox())!;
    // The settling click selected nothing on the board under it.
    expect(await page.evaluate(() => (window as any).__boardStore.selection.partIndex)).toBeNull();

    await page.reload();
    const discard = page.getByTestId('session-discard');
    await discard.waitFor({ timeout: 5000 }).then(() => discard.click(), () => {});
    await page.setInputFiles('[data-testid="file-input"]', BOARD);
    await expect(map).toHaveAttribute('data-visible', 'true');
    await page.waitForTimeout(500);                      // the slide-in transition
    // Same place in the panel (the panel itself may sit elsewhere after a reload).
    const panel2 = (await page.locator('.board-panel-root').first().boundingBox())!;
    const b2 = (await map.boundingBox())!;
    expect(Math.abs((b2.x - panel2.x) - (b.x - panel.x))).toBeLessThan(3);
    expect(Math.abs((b2.y - panel2.y) - (b.y - panel.y))).toBeLessThan(3);
  });

  test('Escape while floating leaves the map where it was', async ({ page }) => {
    const map = await openBoardWithMap(page);
    await pickPosition(page, 'right');
    await page.waitForTimeout(400);                      // let the slide-in transition finish
    const before = (await map.boundingBox())!;
    await pickPosition(page, 'floating');
    await page.mouse.move(before.x - 300, before.y + 200, { steps: 4 });
    await page.keyboard.press('Escape');
    await expect(map).toHaveAttribute('data-placing', 'false');
    await expect(map).toHaveAttribute('data-position', 'right');
    await expect.poll(async () => Math.abs((await map.boundingBox())!.x - before.x)).toBeLessThan(3);
  });
});

test.describe('PDF page scrubber', () => {
  test('is off by default and appears when switched on', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.getByTestId('file-input').setInputFiles(LONG_PDF);
    await expect(page.locator('.pdf-touch-surface')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.pdf-scrubber')).toHaveCount(0);
    await page.evaluate(() => {
      const rs = (window as any).__renderSettings;
      rs.applyGlobal({ ...rs.globalSnapshot(), pdfPageScrubber: true });
    });
    await expect(page.locator('.pdf-scrubber')).toHaveCount(1);
  });
});
