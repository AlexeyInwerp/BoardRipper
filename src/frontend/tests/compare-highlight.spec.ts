/**
 * "Highlight on board" — the compare tool's optional board overlay.
 *
 * Off by default, because it is a second persistent highlight competing with
 * the selection. When on, the compared part gets a standing outline and every
 * pin that is not a plain match gets a mark: red where the boards disagree,
 * amber where the net is the same one under a different name.
 *
 * Counting marks through the renderer's DEV probe is as close as an E2E can
 * get to "the right pins are red" without pixel comparison — so the numbers
 * here are the contract, and the colours themselves are your eyes on :1234.
 */
import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, '../../../samples/kicad/tomu-fpga.kicad_pcb');
const have = fs.existsSync(SRC);
const SUBJECT = 'SW2';
const SW2_BLOCK = /\(footprint "tomu-fpga:captouch-edge"[\s\S]*?\n {2}\)\n/;

let tmpDir = '';
let source = '';
test.beforeAll(() => {
  if (!have) return;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'br-hl-'));
  source = fs.readFileSync(SRC, 'utf8');
});
test.afterAll(() => { if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true }); });

function variant(name: string, transform: (s: string) => string): string {
  const p = path.join(tmpDir, `${name}.kicad_pcb`);
  fs.writeFileSync(p, transform(source), 'utf8');
  return p;
}

/** One pad rewired (a real difference) and one renamed (a partial match). */
function twoKinds(s: string): string {
  const m = s.match(SW2_BLOCK);
  if (!m) throw new Error('fixture drift: SW2 block not found');
  const patched = m[0]
    .replace('(net 20 "/TOUCH_1")', '(net 22 "/TOUCH_3")')      // rewired → differs
    .replace('(net 21 "/TOUCH_2")', '(net 900 "/TOUCH_2_ALT")'); // decorated → partial
  if (patched === m[0]) throw new Error('fixture drift: SW2 pad nets not found');
  return s.replace(m[0], patched);
}

/**
 * Hover a specific pin of the compared part.
 *
 * The pointer is driven to the pin's real screen position rather than swept
 * across the canvas: SW2's captouch pads are 0.1 mm, far too small to find by
 * scanning. `viewport.toScreen` returns DPR-scaled device pixels, so the
 * result is divided back to the CSS pixels Playwright's mouse speaks.
 */
async function hoverPin(page: Page, pinIndex: number): Promise<string | null> {
  const box = (await page.locator('canvas').first().boundingBox())!;
  const pt = await page.evaluate(({ name, idx }) => {
    const w = window as unknown as {
      __boardStore: { board: { parts: Array<{ name: string; pins: Array<{ position: { x: number; y: number } }> }> } };
      __boardRenderer: { viewport: { toScreen(x: number, y: number): { x: number; y: number } } };
    };
    const part = w.__boardStore.board.parts.find(p => p.name === name);
    const pin = part?.pins[idx];
    if (!pin) return null;
    const sp = w.__boardRenderer.viewport.toScreen(pin.position.x, pin.position.y);
    const dpr = window.devicePixelRatio || 1;
    return { x: sp.x / dpr, y: sp.y / dpr };
  }, { name: SUBJECT, idx: pinIndex });
  if (!pt) return null;

  await page.mouse.move(box.x + pt.x, box.y + pt.y);
  await page.waitForTimeout(200);
  if (!(await page.locator('.pin-net-tooltip').isVisible().catch(() => false))) return null;
  const line = page.locator('.pin-net-tooltip .pnt-compare');
  if (!(await line.isVisible().catch(() => false))) return '';
  return (await line.textContent()) ?? '';
}

/** Zoom to the compared part so its pins are on screen and far apart. */
async function focusSubject(page: Page) {
  await page.evaluate((n) => (window as unknown as
    { __boardStore: { focusPart(x: string): void } }).__boardStore.focusPart(n), SUBJECT);
  await page.waitForTimeout(1000);
}

async function marks(page: Page) {
  return page.evaluate(() =>
    (window as unknown as { __boardRenderer?: { lastCompareMarks?: unknown } })
      .__boardRenderer?.lastCompareMarks ?? null);
}

async function openCompared(page: Page) {
  await page.goto('/');
  await expect(page.getByTestId('toolbar')).toBeVisible({ timeout: 15000 });
  const input = page.getByTestId('file-input');
  await input.setInputFiles(variant('hl-a', s => s));
  await expect(page.getByTestId('statusbar')).toContainText('Components', { timeout: 20000 });
  await input.setInputFiles(variant('hl-b', twoKinds));
  await expect(page.locator('.dv-tab')).toHaveCount(2, { timeout: 20000 });
  // Checked only now: no renderer exists — and so no probe is registered —
  // until a board has been loaded.
  const devHooks = await page.evaluate(
    () => '__boardRenderer' in (window as unknown as Record<string, unknown>));
  test.skip(!devHooks, 'renderer probe is a DEV-only global');

  await page.locator('[data-sidebar-tab="tools"]').first().click();
  await page.getByTestId('tools-entry-partcompare').click();
  for (const which of ['a', 'b'] as const) {
    await page.getByTestId(`compare-board-${which}`).selectOption({ index: which === 'a' ? 1 : 2 });
    const field = page.getByTestId(`compare-part-${which}`);
    await field.fill(SUBJECT);
    await field.press('Enter');
  }
  await expect(page.getByTestId('compare-headline')).toBeVisible();
}

test.describe('compare highlight', () => {
  test.skip(!have, 'kicad sample not present');

  test('is off until asked for, and paints both kinds of mark when on', async ({ page }) => {
    await openCompared(page);

    const toggle = page.getByTestId('compare-highlight');
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(await marks(page)).toBeNull();

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => marks(page)).toEqual({ part: SUBJECT, differ: 1, partial: 1 });

    // Off again leaves nothing behind.
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(() => marks(page)).toBeNull();
  });

  test('the hover tooltip says what the pin differs to', async ({ page }) => {
    await openCompared(page);
    await page.getByTestId('compare-highlight').click();
    await expect.poll(() => marks(page)).not.toBeNull();
    await focusSubject(page);

    // The board on screen is the second one opened — the edited side. So the
    // line names what the *unedited* board has, which is the whole point: a
    // mark that only says "different" sends you hunting for the other value.
    // Pad 0 was rewired to TOUCH_3 here, so the other board still shows TOUCH_1.
    const differs = await hoverPin(page, 0);
    expect(differs, 'no tooltip on the rewired pad').toBeTruthy();
    expect(differs).toContain('hl-a');
    expect(differs).toContain('TOUCH_1');
    expect(differs).toContain('different net');

    // Pad 1 is TOUCH_2_ALT here and TOUCH_2 there — a spelling difference.
    const partial = await hoverPin(page, 1);
    expect(partial).toContain('TOUCH_2');
    expect(partial).toContain('spelled differently');
  });

  test('the compare line is absent while the highlight is off', async ({ page }) => {
    await openCompared(page);
    await focusSubject(page);
    const found = await hoverPin(page, 0);
    // A tooltip still appears (net + part) — but with no compare line in it.
    expect(found, 'compare line showed without the toggle').toBe('');
  });

  test('repaints when the other board becomes active', async ({ page }) => {
    await openCompared(page);
    await page.getByTestId('compare-highlight').click();
    await expect.poll(() => marks(page)).not.toBeNull();

    // Board A is the second tab's sibling; switching tabs must keep a mark set
    // (the projection resolves whichever side the active tab is).
    await page.locator('.dv-tab').first().click();
    await page.waitForTimeout(600);
    await expect.poll(() => marks(page)).not.toBeNull();
  });
});
