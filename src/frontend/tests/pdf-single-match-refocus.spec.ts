/**
 * A single search hit must re-centre on every step (2026-09-29).
 *
 * The match-zoom effect ran only when `activeMatchIndex` or the `matches`
 * array changed. With exactly one hit, Enter / ↑↓ / ⌘F step to the same
 * index, so after panning away nothing brought the hit back — with two or
 * more hits it worked, because the index moved. The store now bumps a
 * navigation counter on every explicit step and the effect keys on it.
 *
 * Two more causes sat behind the same symptom: the drag's inertia glide kept
 * adding velocity to the pan the recentre had just written (now stopped at
 * every programmatic jump), and ⌘F stepped only the field registered for
 * Dockview's active panel, so a focused field elsewhere ran a fresh search.
 *
 * Runs on the checked-in fixture; `J4900` occurs exactly once in it.
 */
import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PDF = path.resolve(here, 'fixtures/two-page-text.pdf');

function parse(t: string): { x: number; y: number; s: number } {
  const tr = /translate\(([-\d.]+)px(?:,\s*([-\d.]+)px)?\)/.exec(t);
  const sc = /scale\(([-\d.]+)/.exec(t);
  return { x: tr ? Number(tr[1]) : 0, y: tr && tr[2] ? Number(tr[2]) : 0, s: sc ? Number(sc[1]) : 1 };
}

const transform = (page: Page) => page.evaluate(() =>
  (document.querySelector('.pdf-page-wrapper') as HTMLElement | null)?.style.transform ?? '');

async function dragMouse(page: Page, from: { x: number; y: number }, dx: number, dy: number) {
  const ev = (type: string, x: number, y: number, buttons: number) => page.evaluate(({ type, x, y, buttons }) => {
    document.querySelector('.pdf-touch-surface')!.dispatchEvent(new PointerEvent(type, {
      pointerId: 1, pointerType: 'mouse', isPrimary: true, clientX: x, clientY: y, button: 0, buttons, bubbles: true, cancelable: true,
    }));
  }, { type, x, y, buttons });
  await ev('pointerdown', from.x, from.y, 1);
  for (let i = 1; i <= 6; i++) await ev('pointermove', from.x + (dx * i) / 6, from.y + (dy * i) / 6, 1);
  await ev('pointerup', from.x + dx, from.y + dy, 0);
  await page.waitForTimeout(400);
}

for (const [label, dx, dy, settle] of [
  ['same page', -320, 0, 900],
  ['from the next page', -320, -260, 2500],
] as [string, number, number, number][]) {
  test(`Enter and ⌘F on a lone hit bring it back after the user panned away (${label})`, async ({ page }) => {
    test.setTimeout(60000);
    await page.goto('/');
    await expect(page.getByTestId('toolbar')).toBeVisible({ timeout: 15000 });
    await page.getByTestId('file-input').setInputFiles(PDF);
    await expect(page.locator('.pdf-canvas-container')).toBeVisible({ timeout: 20000 });
    await page.waitForTimeout(2000);

    const field = page.locator('.pdf-search-input');
    await field.click();
    await field.fill('J4900');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(900);
    await expect(page.locator('.pdf-search-counter')).toHaveText('1/1');
    const home = parse(await transform(page));

    const b = (await page.locator('.pdf-canvas-container').boundingBox())!;
    await dragMouse(page, { x: b.x + b.width / 2, y: b.y + b.height / 2 }, dx, dy);
    const away = parse(await transform(page));
    expect(Math.hypot(away.x - home.x, away.y - home.y)).toBeGreaterThan(150);

    // Enter with the same query: a step onto the same, only hit.
    await field.focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(settle);
    const back = parse(await transform(page));
    expect(Math.hypot(back.x - home.x, back.y - home.y)).toBeLessThan(4);
    expect(Math.abs(back.s - home.s)).toBeLessThan(1e-3);

    // And again through ⌘F (the find shortcut steps when the field holds text).
    await dragMouse(page, { x: b.x + b.width / 2, y: b.y + b.height / 2 }, -dx, -dy);
    expect(Math.hypot(parse(await transform(page)).x - home.x, parse(await transform(page)).y - home.y)).toBeGreaterThan(150);
    await field.focus();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+f' : 'Control+f');
    await page.waitForTimeout(settle);
    const back2 = parse(await transform(page));
    expect(Math.hypot(back2.x - home.x, back2.y - home.y)).toBeLessThan(4);
  });
}
