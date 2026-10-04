import { test, expect, type Page } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

// "Translate page" (Chrome/Edge) must not crash BoardRipper — issue #36.
//
// The translator replaces each text node it translates with
// <font><font>text</font></font> and keeps doing it to content added later.
// React still holds the original node, so its next insertBefore/removeChild
// against it threw: a panel crashed ("This panel crashed"), or, for the
// status bar and toasts, which sit outside every panel boundary, the whole
// app unmounted. Each case below is a crash reproduced on the public samples
// (investigation 2026-10-04); the fix is dom-translate-guard.ts plus the
// sites people see often, which render each text run in its own element.
//
// After Sean Johnson's original spec (b682b55), made continuous here.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BVR = path.resolve(HERE, '../public/samples/test-board.bvr');
const KICAD = path.resolve(HERE, '../public/samples/tomu-fpga.kicad_pcb');

function installTranslator() {
  const w = window as unknown as { __translate: () => void; __trOn: boolean };
  const SKIP = '[translate="no"], script, style, font, canvas, textarea, input, select, option';
  function translate(root: Node) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = n as Text;
      const p = t.parentElement;
      if (t.nodeValue?.trim() && p && !p.closest(SKIP)) nodes.push(t);
    }
    for (const t of nodes) {
      if (!t.parentNode) continue;
      const outer = document.createElement('font');
      const inner = document.createElement('font');
      inner.textContent = t.nodeValue;
      outer.appendChild(inner);
      t.parentNode.replaceChild(outer, t);
    }
  }
  w.__translate = () => translate(document.body);
  w.__trOn = false;
  let pending: Node[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const mo = new MutationObserver(recs => {
    if (!w.__trOn) return;
    for (const r of recs) {
      if (r.type === 'childList') r.addedNodes.forEach(n => pending.push(n));
      else if (r.target.parentNode) pending.push(r.target.parentNode);
    }
    clearTimeout(timer);
    timer = setTimeout(() => {
      const ps = pending; pending = [];
      for (const n of ps) {
        if (!n.isConnected) continue;
        if (n.nodeType === Node.TEXT_NODE) { if (n.parentNode) translate(n.parentNode); } else translate(n);
      }
    }, 30);
  });
  window.addEventListener('DOMContentLoaded', () =>
    mo.observe(document.body, { childList: true, subtree: true, characterData: true }));
}

type Store = {
  activeTab: { id: number; board: { parts: { pins: unknown[] }[] } };
  selectPart(i: number): void;
  selectPin(i: number, p: number): void;
  addToast(m: string, t: 'info' | 'error', a?: { label: string; run: () => void }): void;
};
const store = (page: Page) => ({
  call: <A extends unknown[]>(fn: keyof Store, ...args: A) =>
    page.evaluate(([f, a]) => {
      const s = (window as unknown as { __boardStore: Record<string, (...x: unknown[]) => void> }).__boardStore;
      s[f as string](...(a as unknown[]));
    }, [fn, args] as const),
});

async function boot(page: Page, errors: string[], file = BVR) {
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(installTranslator);
  await page.goto('/');
  const prompt = page.getByTestId('session-restore-prompt');
  if (await prompt.count()) await page.getByTestId('session-discard').click();
  await page.getByTestId('file-input').setInputFiles(file);
  await expect(page.getByTestId('statusbar')).toContainText('Components:', { timeout: 60000 });
  await page.evaluate(() => {
    const w = window as unknown as { __translate: () => void; __trOn: boolean };
    w.__translate(); w.__trOn = true;
  });
}

/** Nothing crashed: the app is mounted, no boundary fallback anywhere (hidden
 *  panels included), no uncaught DOM error. */
async function expectAlive(page: Page, errors: string[]) {
  await page.waitForTimeout(300);
  await expect(page.getByTestId('app')).toHaveCount(1);
  await expect(page.getByTestId('root-error-boundary')).toHaveCount(0);
  const crashed = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="panel-error-boundary"]')].map(e => e.textContent?.slice(0, 160)));
  expect(crashed).toEqual([]);
  expect(errors.filter(e => /insertBefore|removeChild|NotFoundError/.test(e))).toEqual([]);
}

test('Info tab: selecting pins after translation does not crash', async ({ page }) => {
  const errors: string[] = [];
  await boot(page, errors);
  await page.locator('.board-sidebar-toggle').first().click();
  await page.locator('[data-board-tab="info"]').click();
  const s = store(page);
  const parts = await page.evaluate(() =>
    (window as unknown as { __boardStore: Store }).__boardStore.activeTab.board.parts.map(p => p.pins.length));
  const pi = parts.findIndex(n => n >= 4);
  await s.call('selectPart', pi);
  // The caret and the pin/comp counts appear next to the net name.
  for (let pin = 0; pin < Math.min(parts[pi], 8); pin++) {
    await s.call('selectPin', pi, pin);
    await page.waitForTimeout(80);
  }
  await expect(page.getByTestId('net-caret').first()).toBeVisible();
  await expectAlive(page, errors);
});

test('the History list keeps working while selections add rows', async ({ page }) => {
  const errors: string[] = [];
  await boot(page, errors);
  const s = store(page);
  // "1 visit" → "2 visits" flips the footer next to a translated " · at N".
  for (let i = 0; i < 4; i++) { await s.call('selectPart', i); await page.waitForTimeout(80); }
  await page.locator('[data-sidebar-tab="history"]').first().click();
  for (let i = 4; i < 7; i++) { await s.call('selectPart', i); await page.waitForTimeout(80); }
  await expectAlive(page, errors);
});

test('Worklist: a find with no hit and New worklist', async ({ page }) => {
  const errors: string[] = [];
  await boot(page, errors);
  await page.locator('.board-sidebar-toggle').first().click();
  await page.locator('[data-board-tab="worklist"]').click();
  await page.getByTestId('worklist-find').click();
  const input = page.getByTestId('worklist-find-input');
  for (const q of ['N', 'No', 'No power', 'zzzz', '', 'No power']) { await input.fill(q); await page.waitForTimeout(80); }
  await page.getByTestId('worklist-new').click();
  await expectAlive(page, errors);
});

test('switching board tabs keeps the window and the status bar intact', async ({ page }) => {
  const errors: string[] = [];
  await boot(page, errors);
  // Loading a second board while translated also runs the load overlay's
  // phase rows from "running" to "done".
  await page.getByTestId('file-input').setInputFiles(KICAD);
  await expect(page.locator('.dv-tab')).toHaveCount(2, { timeout: 60000 });
  for (let i = 0; i < 4; i++) {
    await page.locator('.dv-tab').nth(i % 2).click();
    await page.waitForTimeout(250);
  }
  await expectAlive(page, errors);
  // The format reads once: the guard alone would leave a stale translated copy
  // beside the new text ("KICAD (…) (…) (…)").
  const fmt = await page.locator('[data-testid="statusbar"] [title="Board file format"]').first().innerText();
  expect(fmt.split('(').length - 1).toBeLessThanOrEqual(1);
});

test('a toast with an action survives translation', async ({ page }) => {
  const errors: string[] = [];
  await boot(page, errors);
  const s = store(page);
  await s.call('addToast', 'Saved', 'info', undefined);
  await page.waitForTimeout(150);
  await page.evaluate(() => (window as unknown as { __boardStore: Store }).__boardStore
    .addToast('Board loaded', 'info', { label: 'Undo', run: () => {} }));
  await page.waitForTimeout(150);
  await page.locator('.toast').first().click();
  await expectAlive(page, errors);
});
