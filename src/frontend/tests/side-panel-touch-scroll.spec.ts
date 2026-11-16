/**
 * A finger scrolling a side panel must scroll it — and nothing the board
 * renderer does on window-level pointer events may pull the panel back.
 *
 * Reported from an iPad (2026-11-16): "in touch, the scrolling of text is
 * broken in side panels". The cause is touch-only. When a finger that landed
 * on a scrollable element starts to move, the browser takes the touch for the
 * scroll and fires `pointercancel` for it — iPadOS and Chromium alike.
 * `BoardRenderer` listens for `pointercancel` on *window* (it has to: iPadOS
 * cancels a board finger before the second finger's pointerdown arrives) and
 * wrote one Debug-log line per cancel, for every pointer in the window, not
 * only the ones that began on the board. The Debug panel follows its newest
 * entry when the view sits at the bottom, so every touch scroll in the log
 * began with an entry that threw the view back to the bottom under the
 * finger: the log could not be scrolled up by touch at all.
 *
 * Real touches through CDP, so the browser's own scroll + pointercancel
 * pipeline is what runs. Chromium only (CDP), public KiCad sample, no backend.
 */
import { test, expect, type CDPSession, type Page } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const BOARD = path.resolve(here, '../public/samples/tomu-fpga.kicad_pcb');

// A short viewport so every panel under test has more content than room.
test.use({ hasTouch: true, viewport: { width: 1194, height: 480 } });

type Pt = { x: number; y: number };

async function touch(cdp: CDPSession, type: string, points: Pt[]) {
  await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map((p, i) => ({ x: p.x, y: p.y, id: i })) });
}

/** One finger down at `from`, moved by `dy` over twelve frames, lifted. A
 *  positive `dy` moves the finger down the screen (the content scrolls up). */
async function fingerDrag(cdp: CDPSession, page: Page, from: Pt, dy: number) {
  await touch(cdp, 'touchStart', [from]);
  for (let i = 1; i <= 12; i++) {
    await touch(cdp, 'touchMove', [{ x: from.x, y: from.y + dy * i / 12 }]);
    await page.waitForTimeout(16);
  }
  await touch(cdp, 'touchEnd', []);
  await page.waitForTimeout(400);
}

async function openBoard(page: Page) {
  await page.goto('/');
  await expect(page.getByTestId('toolbar')).toBeVisible({ timeout: 15000 });
  await page.getByTestId('file-input').setInputFiles(BOARD);
  await expect(page.getByTestId('statusbar')).toContainText('Components', { timeout: 20000 });
  await page.waitForTimeout(1500);
  // A dev server that re-optimises its dependencies reloads the page once;
  // the session prompt then offers the board back.
  const prompt = page.getByTestId('session-restore-prompt');
  if (await prompt.count()) {
    await prompt.getByRole('button', { name: 'Reopen' }).click();
    await expect(page.getByTestId('statusbar')).toContainText('Components', { timeout: 20000 });
    await page.waitForTimeout(1500);
  }
  const devHooks = await page.evaluate(() => '__boardStore' in (window as unknown as Record<string, unknown>));
  test.skip(!devHooks, 'board store is a DEV-only global');
}

const scrollState = (el: Element) => ({ top: el.scrollTop, max: el.scrollHeight - el.clientHeight });

test.describe('side panels scroll under a finger', () => {
  test('the Debug log scrolls up by touch and is not pulled back to its newest entry', async ({ page }) => {
    await openBoard(page);
    const cdp = await page.context().newCDPSession(page);

    await page.locator('[data-sidebar-tab="debug"]').click();
    // Every scope on, so the log is long and carries the renderer's `ui` lines.
    for (const box of await page.locator('.debug-filter-scope input').all()) await box.check();
    const log = page.locator('.debug-panel-log');
    await expect.poll(() => log.evaluate(e => e.scrollHeight - e.clientHeight)).toBeGreaterThan(120);
    // Sitting at the bottom, as a log view does: that is when the panel
    // follows new entries.
    await log.evaluate(e => { e.scrollTop = e.scrollHeight; });
    await page.waitForTimeout(300);
    const before = await log.evaluate(scrollState);
    expect(before.top).toBe(before.max);
    const entriesBefore = await log.locator('.debug-log-message').count();

    const box = (await log.boundingBox())!;
    const travel = Math.round(box.height * 0.6);
    await fingerDrag(cdp, page, { x: box.x + box.width / 2, y: box.y + box.height * 0.2 }, travel);

    const after = await log.evaluate(scrollState);
    // The finger moved the content up by about `travel`; the view must be
    // that far from the bottom, not back at it.
    expect(after.max - after.top).toBeGreaterThan(travel * 0.5);
    // And the scroll itself must not have produced a log entry.
    expect(await log.locator('.debug-log-message').count()).toBe(entriesBefore);
    await expect(log.locator('.debug-log-message').last()).not.toContainText('pointercancel');
  });

  test('the Settings list in the left sidebar scrolls by touch', async ({ page }) => {
    await openBoard(page);
    const cdp = await page.context().newCDPSession(page);
    await page.locator('[data-sidebar-tab="settings"]').click();
    const list = page.locator('.sidebar .settings-scroll');
    await expect(list).toBeVisible();
    // Open a few sections so the list is longer than the short viewport.
    const headers = page.locator('.sidebar .settings-section-header');
    for (let i = 0; i < 3; i++) await headers.nth(i).click();
    await expect.poll(() => list.evaluate(e => e.scrollHeight - e.clientHeight)).toBeGreaterThan(120);

    const box = (await list.boundingBox())!;
    await fingerDrag(cdp, page, { x: box.x + box.width / 2, y: box.y + box.height * 0.8 }, -Math.round(box.height * 0.6));
    expect(await list.evaluate(e => e.scrollTop)).toBeGreaterThan(40);
  });

  test("the board sidebar's Info pin table scrolls by touch", async ({ page }) => {
    await openBoard(page);
    const cdp = await page.context().newCDPSession(page);
    // U5 has the most pins on this board (30), so its table does not fit.
    await page.evaluate(() => (window as unknown as { __boardStore: { focusPart(n: string): void } }).__boardStore.focusPart('U5'));
    await page.locator('.board-sidebar-toggle').click();
    await page.locator('[data-board-tab="info"]').click();
    const table = page.locator('.board-sidebar .pin-table-container');
    await expect(table).toBeVisible();
    await expect.poll(() => table.evaluate(e => e.scrollHeight - e.clientHeight)).toBeGreaterThan(80);

    const box = (await table.boundingBox())!;
    await fingerDrag(cdp, page, { x: box.x + box.width / 2, y: box.y + box.height * 0.8 }, -Math.round(box.height * 0.6));
    expect(await table.evaluate(e => e.scrollTop)).toBeGreaterThan(40);
  });
});
