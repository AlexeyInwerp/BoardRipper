/**
 * Part comparison — Tools ▸ Part comparison, end to end.
 *
 * The fixtures are built here rather than checked in: each is `tomu-fpga`
 * with one deliberate edit, which makes the expected answer a property of the
 * edit instead of a number someone once observed. In particular the identity
 * case — the same board under two filenames — must report zero differences,
 * and that assertion needs no hand-authored expectation table at all.
 *
 * The subject is SW2, a 4-pad captouch footprint on /TOUCH_1../TOUCH_4.
 *
 * Design: docs/specs/2026-09-11-part-pin-comparison-design.md
 */
import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, '../../../samples/kicad/tomu-fpga.kicad_pcb');
const have = fs.existsSync(SRC);

const SUBJECT = 'SW2';
/** The SW2 footprint block, so an edit can be scoped to this part alone. */
const SW2_BLOCK = /\(footprint "tomu-fpga:captouch-edge"[\s\S]*?\n {2}\)\n/;

let tmpDir = '';
let source = '';

test.beforeAll(() => {
  if (!have) return;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'br-compare-'));
  source = fs.readFileSync(SRC, 'utf8');
});
test.afterAll(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

function variant(name: string, transform: (s: string) => string): string {
  const p = path.join(tmpDir, `${name}.kicad_pcb`);
  fs.writeFileSync(p, transform(source), 'utf8');
  return p;
}

/** Rename one net everywhere — the two-deliveries-of-one-board case. */
function renameNet(s: string): string {
  const out = s.split('"/TOUCH_2"').join('"/TOUCH_2_RENAMED"');
  if (out === s) throw new Error('fixture drift: /TOUCH_2 not found');
  return out;
}

/** Swap the nets on SW2's pads 1 and 2 — a real wiring difference. */
function swapPads(s: string): string {
  const m = s.match(SW2_BLOCK);
  if (!m) throw new Error('fixture drift: SW2 footprint block not found');
  const patched = m[0]
    .replace('(net 20 "/TOUCH_1")', '(net 999 "__TMP__")')
    .replace('(net 21 "/TOUCH_2")', '(net 20 "/TOUCH_1")')
    .replace('(net 999 "__TMP__")', '(net 21 "/TOUCH_2")');
  if (patched === m[0]) throw new Error('fixture drift: SW2 pad nets not found');
  return s.replace(m[0], patched);
}

/** Decorate SW2's pad-2 net so only that pad changes — the old name is
 *  contained in the new one, but the net it now names touches nothing else, so
 *  topology abstains and the name is the only evidence left. */
function suffixPadNet(s: string): string {
  const m = s.match(SW2_BLOCK);
  if (!m) throw new Error('fixture drift: SW2 footprint block not found');
  const patched = m[0].replace('(net 21 "/TOUCH_2")', '(net 900 "/TOUCH_2_ALT")');
  if (patched === m[0]) throw new Error('fixture drift: SW2 pad 2 net not found');
  return s.replace(m[0], patched);
}

async function openBoards(page: Page, a: string, b: string) {
  await page.goto('/');
  await expect(page.getByTestId('toolbar')).toBeVisible({ timeout: 15000 });
  const input = page.getByTestId('file-input');
  await input.setInputFiles(a);
  await expect(page.getByTestId('statusbar')).toContainText('Components', { timeout: 20000 });
  await input.setInputFiles(b);
  // Two tabs = both parsed. Waiting on the statusbar alone would race, since
  // both boards produce identical stats.
  await expect(page.locator('.dv-tab')).toHaveCount(2, { timeout: 20000 });
}

/** Open the tool and point both sides at `SUBJECT`. */
async function compareSubject(page: Page) {
  await page.locator('[data-sidebar-tab="tools"]').first().click();
  await page.getByTestId('tools-entry-partcompare').click();
  await expect(page.getByTestId('part-compare')).toBeVisible();

  for (const which of ['a', 'b'] as const) {
    // Option 0 is the "pick a board" placeholder; 1 and 2 are the two tabs.
    await page.getByTestId(`compare-board-${which}`)
      .selectOption({ index: which === 'a' ? 1 : 2 });
    const field = page.getByTestId(`compare-part-${which}`);
    await field.fill(SUBJECT);
    await field.press('Enter');
    await expect(page.getByTestId(`compare-pins-${which}`)).toHaveText('4 pins');
  }
  await expect(page.getByTestId('compare-headline')).toBeVisible();
}

test.describe('part comparison', () => {
  test.skip(!have, 'kicad sample not present');

  test('the same board under two names reports zero differences', async ({ page }) => {
    await openBoards(page, variant('identity-a', s => s), variant('identity-b', s => s));
    await compareSubject(page);

    await expect(page.getByTestId('compare-difference-count')).toHaveText('0');
    await expect(page.getByTestId('compare-row')).toHaveCount(4);
    for (const status of await page.getByTestId('compare-row').all()) {
      await expect(status).toHaveAttribute('data-status', 'same');
    }
    // Nothing survives the "only differences" filter, and the tool says so
    // rather than rendering an empty list.
    await page.getByTestId('compare-only-diffs').check();
    await expect(page.getByTestId('compare-row')).toHaveCount(0);
    await expect(page.getByTestId('part-compare')).toContainText('No differences');
  });

  test('a renamed net reads as a rename, not as a difference', async ({ page }) => {
    await openBoards(page, variant('rename-a', s => s), variant('rename-b', renameNet));
    await compareSubject(page);

    // The whole point: the name changed, the wiring did not.
    await expect(page.getByTestId('compare-difference-count')).toHaveText('0');
    await expect(page.getByTestId('compare-headline')).toContainText('1 renamed');
    await expect(page.getByTestId('compare-row').filter({ has: page.locator('[data-status]') }))
      .toHaveCount(4);
    await expect(page.locator('[data-testid="compare-row"][data-status="renamed"]')).toHaveCount(1);
  });

  test('two swapped pads read as two real differences', async ({ page }) => {
    await openBoards(page, variant('swap-a', s => s), variant('swap-b', swapPads));
    await compareSubject(page);

    await expect(page.getByTestId('compare-difference-count')).toHaveText('2');
    await expect(page.locator('[data-testid="compare-row"][data-status="differs"]')).toHaveCount(2);

    // The filter leaves exactly the two rows that disagree.
    await page.getByTestId('compare-only-diffs').check();
    await expect(page.getByTestId('compare-row')).toHaveCount(2);
  });

  test('a decorated net name reads as partial, with the shared text marked', async ({ page }) => {
    await openBoards(page, variant('partial-a', s => s), variant('partial-b', suffixPadNet));
    await compareSubject(page);

    const row = page.locator('[data-testid="compare-row"][data-status="partial"]');
    await expect(row).toHaveCount(1);
    await expect(page.getByTestId('compare-headline')).toContainText('1 partial');
    // Not counted against the board — a different spelling is not a fault.
    await expect(page.getByTestId('compare-difference-count')).toHaveText('0');

    // Both sides mark the run they share, which is what makes the leftover
    // "_ALT" the thing your eye lands on. (The KiCad parser drops the leading
    // "/" of a hierarchical net name, so the displayed name has no slash.)
    const marks = row.locator('.pc-shared');
    await expect(marks).toHaveCount(2);
    await expect(marks.first()).toHaveText('TOUCH_2');
    await expect(marks.last()).toHaveText('TOUCH_2');
    await expect(row).toContainText('TOUCH_2_ALT');
  });

  test('with exactly two boards open the pickers fill themselves in', async ({ page }) => {
    await openBoards(page, variant('auto-a', s => s), variant('auto-b', s => s));

    await page.locator('[data-sidebar-tab="tools"]').first().click();
    await page.getByTestId('tools-entry-partcompare').click();
    await expect(page.getByTestId('part-compare')).toBeVisible();

    // Neither select was touched, and neither is on the placeholder.
    const a = page.getByTestId('compare-board-a');
    const b = page.getByTestId('compare-board-b');
    await expect(a).not.toHaveValue('');
    await expect(b).not.toHaveValue('');
    expect(await a.inputValue()).not.toBe(await b.inputValue());

    // The components stay blank — which chip to compare is the real question.
    await expect(page.getByTestId('compare-part-a')).toHaveValue('');
    await expect(page.getByTestId('compare-part-a')).toBeEnabled();
  });

  test('the board right-click fills both sides in', async ({ page }) => {
    await openBoards(page, variant('menu-a', s => s), variant('menu-b', s => s));

    // `__contextMenuStore` is exposed only under `import.meta.env.DEV`, so this
    // test cannot run against a production bundle (BASE_URL pointed at the dev
    // container). Skip rather than fail — the other three cases do exercise the
    // shipped build.
    const hasHook = await page.evaluate(
      () => '__contextMenuStore' in (window as unknown as Record<string, unknown>),
    );
    test.skip(!hasHook, 'context-menu store is a DEV-only global');

    // Drive the context-menu store directly: placing a real right-click on a
    // specific 0.1 mm captouch pad would be testing hit-testing, not this.
    await page.evaluate((refdes) => {
      // @ts-expect-error DEV-only global
      window.__contextMenuStore.showBoard(200, 200, refdes, null, null, [refdes]);
    }, SUBJECT);

    const entry = page.getByTestId('compare-pins-entry').first();
    await expect(entry).toContainText(SUBJECT);
    await expect(entry).toContainText('4 ↔ 4 pins');
    await entry.click();

    // One click lands on the tool with both sides resolved.
    await expect(page.getByTestId('part-compare')).toBeVisible();
    await expect(page.getByTestId('compare-pins-a')).toHaveText('4 pins');
    await expect(page.getByTestId('compare-pins-b')).toHaveText('4 pins');
    await expect(page.getByTestId('compare-difference-count')).toHaveText('0');
  });
});
