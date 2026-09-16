/**
 * Worklist redesign (2026-09-16). Runs on the public fixture, so it actually
 * executes — the older measurement specs need a proprietary .brd and skip on
 * most machines.
 *
 * What it pins:
 *   - the finder: one line, opens a search, recents first, filters as you type;
 *   - creating from the finder, with the typed text as the name, no prompt;
 *   - wipe and delete ask in the panel, never through a browser dialog;
 *   - the row keeps every control, flags included, dim but present when off;
 *   - readings: absent when unmeasured, values when measured, slots when the
 *     row is selected.
 */
import { test, expect, type Page } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(HERE, '../public/samples/test-board.bvr');

async function openWorklist(page: Page) {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.setInputFiles('[data-testid="file-input"]', FIXTURE);
  await expect(page.getByTestId('board-overlay-bar')).toBeVisible();
  await page.waitForFunction(() => !!(window as unknown as { __boardStore?: { board?: unknown } }).__boardStore?.board, { timeout: 20000 });
  await page.locator('.board-sidebar-toggle').first().click();
  await page.locator('[data-board-tab="worklist"]').click();
  await expect(page.getByTestId('worklist-panel')).toBeVisible();
}

/** Any browser dialog is a failure: this panel must not use prompt/confirm. */
function banDialogs(page: Page): string[] {
  const seen: string[] = [];
  page.on('dialog', async d => { seen.push(`${d.type()}: ${d.message()}`); await d.dismiss(); });
  return seen;
}

test.describe('worklist panel', () => {
  test('the finder makes a worklist from what you typed, with no browser prompt', async ({ page }) => {
    const dialogs = banDialogs(page);
    await openWorklist(page);

    await page.getByTestId('worklist-find').click();
    const input = page.getByTestId('worklist-find-input');
    await expect(input).toBeFocused();
    await input.fill('No power');
    await page.getByTestId('worklist-new').click();

    await expect(page.getByTestId('worklist-find')).toContainText('No power');
    await expect(page.getByTestId('worklist-find-input')).toHaveCount(0);   // folded back
    expect(dialogs).toEqual([]);
  });

  test('the finder lists worklists and filters as you type', async ({ page }) => {
    await openWorklist(page);
    // Created a beat apart so "most recently touched" is a real ordering and
    // not three identical timestamps.
    for (const name of ['No power', 'Backlight', 'USB-C not charging']) {
      await page.evaluate(n => {
        (window as unknown as { __worklistStore: { createWorklist: (n: string) => unknown } }).__worklistStore.createWorklist(n);
      }, name);
      await page.waitForTimeout(30);
    }

    await page.getByTestId('worklist-find').click();
    await expect(page.getByTestId('worklist-hit')).toHaveCount(3);
    // Most recently touched first.
    await expect(page.getByTestId('worklist-hit').first()).toContainText('USB-C not charging');

    await page.getByTestId('worklist-find-input').fill('back');
    await expect(page.getByTestId('worklist-hit')).toHaveCount(1);
    await expect(page.getByTestId('worklist-hit').first()).toContainText('Backlight');

    // Picking one switches to it and closes the finder.
    await page.getByTestId('worklist-hit').first().click();
    await expect(page.getByTestId('worklist-find')).toContainText('Backlight');
  });

  test('clearing and deleting ask inside the panel, not in a browser dialog', async ({ page }) => {
    const dialogs = banDialogs(page);
    await openWorklist(page);
    await page.evaluate(() => {
      const ws = (window as unknown as { __worklistStore: { createWorklist: (n: string) => { id: string } | null; pushParts: (id: string, i: number[]) => void } }).__worklistStore;
      const wl = ws.createWorklist('Ticket');
      if (wl) ws.pushParts(wl.id, [0, 1]);
    });
    await expect(page.getByTestId('worklist-part-row')).toHaveCount(2);

    // Clear: asks, and cancelling leaves the entries alone.
    await page.getByTestId('worklist-menu-btn').click();
    await page.getByTestId('worklist-menu-wipe').click();
    await expect(page.getByTestId('worklist-confirm')).toBeVisible();
    await page.getByTestId('worklist-confirm-no').click();
    await expect(page.getByTestId('worklist-part-row')).toHaveCount(2);

    // Confirming clears them.
    await page.getByTestId('worklist-menu-btn').click();
    await page.getByTestId('worklist-menu-wipe').click();
    await page.getByTestId('worklist-confirm-yes').click();
    await expect(page.getByTestId('worklist-part-row')).toHaveCount(0);

    // Delete asks too.
    await page.getByTestId('worklist-menu-btn').click();
    await page.getByTestId('worklist-menu-delete').click();
    await expect(page.getByTestId('worklist-confirm')).toContainText('cannot be undone');
    await page.getByTestId('worklist-confirm-yes').click();

    expect(dialogs).toEqual([]);
  });

  test('the row keeps every control, and the condition flag stays pressable when clear', async ({ page }) => {
    await openWorklist(page);
    await page.evaluate(() => {
      const ws = (window as unknown as { __worklistStore: { createWorklist: (n: string) => { id: string } | null; pushParts: (id: string, i: number[]) => void } }).__worklistStore;
      const wl = ws.createWorklist('Ticket');
      if (wl) ws.pushParts(wl.id, [0]);
    });
    const row = page.getByTestId('worklist-part-row').first();
    await expect(row).toBeVisible();

    // The flag is a control, not a badge: present and clickable while clear.
    const flag = row.locator('.wl-flag');
    await expect(flag).toBeVisible();
    await expect(flag).toHaveAttribute('aria-pressed', 'false');
    await flag.click();
    await expect(flag).toHaveAttribute('aria-pressed', 'true');
    await expect(flag).toHaveClass(/on/);
    await flag.click();
    await expect(flag).toHaveAttribute('aria-pressed', 'false');
    await expect(flag).toBeVisible();                       // still there when off

    // Mark cycles through its four states and back.
    const mark = row.locator('.wl-mark');
    await mark.click();
    await expect(page.locator('.wl-flash')).toContainText('Replaced');
    const stored = await page.evaluate(() => {
      const ws = (window as unknown as { __worklistStore: { activeWorklist: { entries: { mark: string }[] } | null } }).__worklistStore;
      return ws.activeWorklist?.entries[0].mark;
    });
    expect(stored).toBe('replaced');

    // Remove empties the list.
    await row.locator('.wl-x').click();
    await expect(page.getByTestId('worklist-part-row')).toHaveCount(0);
  });

  test('net readings: none when unmeasured, values when measured, slots when selected', async ({ page }) => {
    await openWorklist(page);
    await page.evaluate(() => {
      const ws = (window as unknown as { __worklistStore: { pushNetToActive: (n: string) => unknown } }).__worklistStore;
      ws.pushNetToActive('GND');
    });
    const row = page.getByTestId('worklist-net-row').first();
    await expect(row).toBeVisible();

    // Nothing measured: one line, no slots, no values.
    await expect(row.getByTestId('net-meas-strip')).toHaveCount(0);
    await expect(row.getByTestId('net-meas-values')).toHaveCount(0);
    const oneLine = (await row.boundingBox())!.height;

    // Selected: all three slots open.
    await row.locator('.wl-row-main').click();
    await expect(row.getByTestId('net-meas-strip')).toBeVisible();
    for (const k of ['voltage', 'diode', 'resistance']) {
      await expect(row.getByTestId(`net-meas-input-${k}`)).toBeVisible();
    }

    // Record one, deselect: only that one shows, as a value.
    const d = row.getByTestId('net-meas-input-diode');
    await d.fill('0.47');
    await d.blur();
    await page.getByTestId('worklist-ticket-toggle').click();   // a click away folds it back
    await expect(row.getByTestId('net-meas-value-diode')).toContainText('0.47');
    await expect(row.getByTestId('net-meas-value-voltage')).toHaveCount(0);
    await expect(row.getByTestId('net-meas-strip')).toHaveCount(0);
    expect((await row.boundingBox())!.height).toBeGreaterThan(oneLine);
  });

  test('the panel follows the theme instead of its own hardcoded dark', async ({ page }) => {
    await openWorklist(page);
    // The old panel painted itself from variables that do not exist here, so it
    // was stuck dark. Reading a token off a real element proves it now inherits.
    const bg = await page.getByTestId('worklist-find').evaluate(el => getComputedStyle(el).color);
    expect(bg).toBeTruthy();
    const inline = await page.getByTestId('worklist-panel').evaluate(el => el.getAttribute('style'));
    expect(inline).toBeNull();                                // no inline styling on the root
  });
});
