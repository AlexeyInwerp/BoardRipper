/**
 * Shift+drag is drag-to-zoom. It must not also land as a shift+click and add
 * the part under the cursor to the worklist.
 *
 * Why this needs a test rather than being obvious from the code: committing a
 * drag-to-zoom calls `setPointerCapture` on the container div, which retargets
 * every later pointer event away from the canvas. PixiJS listens on the canvas,
 * concludes the pointer left, and emits `pointerupoutside`; pixi-viewport reads
 * that as the end of a gesture it believes never moved and fires `clicked`
 * **during** the drag, after a single move. So the stray click arrives before
 * any travel has accumulated and before the gesture's own pointerup cleanup —
 * neither a distance test nor the release-time latch can catch it alone.
 *
 * The controls matter as much as the fix: shift+click really does add to the
 * worklist, and that has to keep working, as does the very next ordinary click.
 */
import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const BOARD = path.resolve(here, '../../../samples/kicad/tomu-fpga.kicad_pcb');
const have = fs.existsSync(BOARD);

/** A part big enough on screen that a click at the canvas centre lands on it. */
const SUBJECT = 'U1';

async function worklistCount(page: Page): Promise<number> {
  return page.evaluate(() =>
    (window as unknown as { __worklistStore?: { activeWorklist?: { entries?: unknown[] } } })
      .__worklistStore?.activeWorklist?.entries?.length ?? 0);
}

async function selectedPart(page: Page): Promise<number | null> {
  return page.evaluate(() =>
    (window as unknown as { __boardStore: { selection: { partIndex: number | null } } })
      .__boardStore.selection.partIndex);
}

/** Load the board and centre `SUBJECT`, returning the canvas centre point. */
async function load(page: Page): Promise<{ x: number; y: number }> {
  await page.goto('/');
  await expect(page.getByTestId('toolbar')).toBeVisible({ timeout: 15000 });
  await page.getByTestId('file-input').setInputFiles(BOARD);
  await expect(page.getByTestId('statusbar')).toContainText('Components', { timeout: 20000 });
  await page.waitForTimeout(1500);
  await page.evaluate((name) =>
    (window as unknown as { __boardStore: { focusPart(n: string): void } }).__boardStore.focusPart(name),
    SUBJECT);
  await page.waitForTimeout(1200);
  const b = (await page.locator('canvas').first().boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

async function drag(
  page: Page, c: { x: number; y: number },
  steps: number, dx: number, dy: number, shift: boolean,
) {
  if (shift) await page.keyboard.down('Shift');
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) await page.mouse.move(c.x + i * dx, c.y + i * dy);
  await page.mouse.up();
  if (shift) await page.keyboard.up('Shift');
  await page.waitForTimeout(450);
}

test.describe('shift+drag', () => {
  test.skip(!have, 'kicad sample not present');

  // Shapes that used to fail differently: a long diagonal, a slow crawl of many
  // small steps (the one the first fix missed — it emits its stray click after
  // a single move), and the two axis-locked drags.
  for (const [label, steps, dx, dy] of [
    ['diagonal', 10, 8, 5],
    ['slow crawl', 40, 2, 1],
    ['vertical', 10, 0, 9],
    ['horizontal', 10, 9, 0],
  ] as [string, number, number, number][]) {
    test(`${label} does not touch the worklist`, async ({ page }) => {
      const c = await load(page);
      await drag(page, c, steps, dx, dy, true);
      expect(await worklistCount(page)).toBe(0);
    });
  }

  test('shift+click still adds, and adds again to remove', async ({ page }) => {
    const c = await load(page);
    await page.keyboard.down('Shift');
    await page.mouse.click(c.x, c.y);
    await page.keyboard.up('Shift');
    await page.waitForTimeout(450);
    expect(await worklistCount(page)).toBe(1);

    await page.keyboard.down('Shift');
    await page.mouse.click(c.x, c.y);
    await page.keyboard.up('Shift');
    await page.waitForTimeout(450);
    expect(await worklistCount(page)).toBe(0);
  });

  test('the next ordinary click still selects', async ({ page }) => {
    const c = await load(page);
    await page.evaluate(() =>
      (window as unknown as { __boardStore: { selectPart(i: number | null): void } })
        .__boardStore.selectPart(null));
    await drag(page, c, 10, 8, 5, true);
    expect(await worklistCount(page)).toBe(0);

    // The release-time latch must not stay armed and swallow this one.
    await page.mouse.click(c.x, c.y);
    await page.waitForTimeout(450);
    expect(await selectedPart(page)).not.toBeNull();
  });

  test('a plain drag pans without selecting', async ({ page }) => {
    const c = await load(page);
    await page.evaluate(() =>
      (window as unknown as { __boardStore: { selectPart(i: number | null): void } })
        .__boardStore.selectPart(null));
    await drag(page, c, 10, 8, 5, false);
    expect(await selectedPart(page)).toBeNull();

    await page.mouse.click(c.x + 80, c.y + 50);
    await page.waitForTimeout(450);
    expect(await selectedPart(page)).not.toBeNull();
  });
});
