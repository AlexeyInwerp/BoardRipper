/**
 * Independent scroll slots (issue #40).
 *
 * Every browser turns Shift+wheel into a horizontal deltaX before the page
 * sees it — the OS's horizontal-scroll gesture. The board used to intercept
 * Shift for zoom whenever bare scroll panned, which took that gesture away.
 * The slots are independent now: Shift on Pan consumes the deltaX the browser
 * produced, ⌘ zooms, and an existing install keeps the layout it had.
 *
 * Uses the checked-in KiCad sample, so it always runs.
 */
import { test, expect, type Page } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const BOARD = path.resolve(here, '../../../samples/kicad/tomu-fpga.kicad_pcb');

const SETTINGS_KEY = 'boardripper-render-settings';
const PDF_KEY = 'boardripper-pdf-scroll-bindings';
const MARKER = 'boardripper-scroll-slots-v2';

type View = { x: number; y: number; scale: number };

async function openBoard(page: Page) {
  await page.getByTestId('file-input').setInputFiles(BOARD);
  await page.waitForFunction(() => !!(window as unknown as { __boardRenderer?: { board?: unknown } }).__boardRenderer?.board, null, { timeout: 30_000 });
  await page.waitForTimeout(500);
}

function view(page: Page): Promise<View> {
  return page.evaluate(() => {
    const v = (window as unknown as { __boardRenderer: { viewport: { x: number; y: number; scale: { x: number } } } }).__boardRenderer.viewport;
    return { x: v.x, y: v.y, scale: v.scale.x };
  });
}

/** Dispatch a wheel event the way the browser delivers Shift+wheel: the
 *  vertical motion already turned into a horizontal deltaX. */
function wheel(page: Page, init: WheelEventInit) {
  return page.evaluate((init) => {
    const canvas = document.querySelector('canvas')!;
    const r = canvas.getBoundingClientRect();
    canvas.dispatchEvent(new WheelEvent('wheel', {
      bubbles: true, cancelable: true,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
      ...init,
    }));
  }, init);
}

test.describe('board scroll slots', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
  });

  test('a fresh install gets Shift = Pan, ⌘ = Zoom', async ({ page }) => {
    await page.reload();
    const state = await page.evaluate((k) => ({
      marker: localStorage.getItem(k.MARKER),
      pdf: JSON.parse(localStorage.getItem(k.PDF_KEY) || 'null'),
    }), { MARKER, PDF_KEY });
    expect(state.marker).toBe('1');
    expect(state.pdf).toBeNull(); // defaults apply; nothing to write

    await openBoard(page);
    const before = await view(page);

    // Shift + wheel: the browser hands us deltaX. Must pan, not zoom.
    await wheel(page, { shiftKey: true, deltaX: 120, deltaY: 0 });
    await page.waitForTimeout(100);
    const afterShift = await view(page);
    expect(afterShift.scale).toBeCloseTo(before.scale, 6);
    expect(afterShift.x - before.x).toBeCloseTo(-120, 3);
    expect(afterShift.y).toBeCloseTo(before.y, 6);

    // ⌘ + wheel zooms.
    await wheel(page, { metaKey: true, deltaY: -200 });
    await page.waitForTimeout(600); // smooth-zoom tween settles
    const afterMeta = await view(page);
    expect(afterMeta.scale).toBeGreaterThan(before.scale * 1.05);
  });

  test('an existing install keeps Shift = Zoom until the user changes it', async ({ page }) => {
    // Settings that predate the slots: bare pans (default), no shift key, no marker.
    await page.evaluate((k) => {
      localStorage.setItem(k.SETTINGS_KEY, JSON.stringify({ twoFingerPan: true, wheelSmooth: 5 }));
    }, { SETTINGS_KEY });
    await page.reload();

    const migrated = await page.evaluate((k) => ({
      settings: JSON.parse(localStorage.getItem(k.SETTINGS_KEY) || '{}'),
      pdf: JSON.parse(localStorage.getItem(k.PDF_KEY) || 'null'),
      marker: localStorage.getItem(k.MARKER),
    }), { SETTINGS_KEY, PDF_KEY, MARKER });
    expect(migrated.settings.wheelShiftAction).toBe('zoom');
    expect(migrated.pdf).toEqual({ bare: 'pan', shift: 'zoom', meta: 'switch' });
    expect(migrated.marker).toBe('1');

    await openBoard(page);
    const before = await view(page);
    await wheel(page, { shiftKey: true, deltaX: 0, deltaY: -200 });
    await page.waitForTimeout(600);
    const after = await view(page);
    expect(after.scale, 'legacy layout: Shift still zooms').toBeGreaterThan(before.scale * 1.05);
  });

  test('a legacy mouse layout (bare = zoom) keeps Shift = Pan, and it pans both axes', async ({ page }) => {
    await page.evaluate((k) => {
      localStorage.setItem(k.SETTINGS_KEY, JSON.stringify({ twoFingerPan: false }));
    }, { SETTINGS_KEY });
    await page.reload();
    expect(await page.evaluate((k) => JSON.parse(localStorage.getItem(k) || '{}').wheelShiftAction, SETTINGS_KEY)).toBe('pan');

    await openBoard(page);
    const before = await view(page);
    await wheel(page, { shiftKey: true, deltaX: 40, deltaY: 30 });
    await page.waitForTimeout(100);
    const after = await view(page);
    expect(after.scale).toBeCloseTo(before.scale, 6);
    expect(after.x - before.x).toBeCloseTo(-40, 3);
    expect(after.y - before.y).toBeCloseTo(-30, 3);
  });

  test('Settings: clicking a pill cycles the slot, and the note appears only while Shift is not Pan', async ({ page }) => {
    await page.reload();
    await page.locator('[data-sidebar-tab="settings"]').click();
    await page.locator('.sidebar [data-settings-tab="input"]').click();
    // Sections start collapsed on a fresh profile.
    await page.locator('.sidebar button', { hasText: /^Navigation/ }).first().click();

    const shift = page.getByTestId('scroll-slot-board-shift');
    await expect(shift).toHaveAttribute('data-action', 'pan');
    await expect(page.getByTestId('scroll-note-board')).toHaveCount(0);

    await shift.click();
    await expect(shift).toHaveAttribute('data-action', 'zoom');
    await expect(page.getByTestId('scroll-note-board')).toContainText('horizontal scroll');
    expect(await page.evaluate((k) => JSON.parse(localStorage.getItem(k) || '{}').wheelShiftAction, SETTINGS_KEY)).toBe('zoom');

    await shift.click();
    await expect(shift).toHaveAttribute('data-action', 'pan');
    await expect(page.getByTestId('scroll-note-board')).toHaveCount(0);

    // Two slots may hold the same action: bare and Shift both Pan is legal.
    const bare = page.getByTestId('scroll-slot-board-bare');
    await expect(bare).toHaveAttribute('data-action', 'pan');
    await expect(shift).toHaveAttribute('data-action', 'pan');
  });
});
