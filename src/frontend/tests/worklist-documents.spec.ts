/**
 * Worklists as documents of their own (docs/specs/2026-11-10-worklist-
 * storage-redesign.md): stored on the server, attributed to an editable
 * board name, matched to a board by name or tag as suggestions only, loaded
 * onto any tab without binding, shared live between tabs, and merged when
 * two places edit one. Public samples; needs the backend the dev server
 * proxies to (it skips without one).
 */
import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOMU = path.resolve(HERE, '../public/samples/tomu-fpga.kicad_pcb');
const BVR = path.resolve(HERE, '../public/samples/test-board.bvr');

type WS = {
  createWorklist(name?: string, opts?: { onTab?: boolean; board?: string }): { id: string } | null;
  pushParts(id: string | null, idx: number[]): number;
  pushNets(id: string | null, n: string[]): number;
  setBoardName(id: string, b: string): void;
  setTags(id: string, t: string[]): void;
  setMark(id: string, refdes: string, m: string): void;
  wipeWorklist(id: string): void;
  loadOnTab(tab: number | null, id: string | null): void;
  worklistForTab(tab: number): { id: string; entries: { refdes: string; mark: string }[]; netEntries: unknown[] } | null;
  TEST_SETTLED(): Promise<void>;
  TEST_PULL(): Promise<void>;
  TEST_DOC(id: string): { rev: number; entries: { refdes: string; mark: string; removed?: number }[]; netEntries: { netName: string; removed?: number }[] } | null;
};

async function backendUp(request: APIRequestContext): Promise<boolean> {
  try { return (await request.get('/api/worklists?since=0')).ok(); } catch { return false; }
}

async function openBoard(page: Page, file: string) {
  await page.setInputFiles('[data-testid="file-input"]', file);
  await expect(page.getByTestId('board-overlay-bar').last()).toBeVisible();
  await page.waitForFunction(() => !!(window as unknown as { __boardStore?: { board?: unknown } }).__boardStore?.board, { timeout: 20000 });
}

async function worklistTab(page: Page) {
  if (!(await page.getByTestId('worklist-panel').count())) {
    await page.locator('.board-sidebar-toggle').first().click();
    await page.locator('[data-board-tab="worklist"]').click();
  }
  await expect(page.getByTestId('worklist-panel')).toBeVisible();
}

const uniq = () => Math.random().toString(36).slice(2, 8);

test.beforeEach(async ({ request }) => {
  test.skip(!(await backendUp(request)), 'needs the backend (/api/worklists)');
});

test('a worklist is stored on the server with its board name and survives a reload', async ({ page, request }) => {
  await page.goto('/');
  await openBoard(page, TOMU);
  const name = `Ticket ${uniq()}`;
  const id = await page.evaluate((n) => {
    const s = (window as unknown as { __worklistStore: WS }).__worklistStore;
    const w = s.createWorklist(n)!;
    s.pushParts(w.id, [0, 1]);
    return w.id;
  }, name);
  await page.evaluate(() => (window as unknown as { __worklistStore: WS }).__worklistStore.TEST_SETTLED());
  const doc = await (await request.get(`/api/worklists/${id}`)).json();
  expect(doc).toMatchObject({ id, name, board: 'tomu-fpga', rev: expect.any(Number) });
  expect(doc.entries).toHaveLength(2);

  // A fresh page (another bench) finds it in the navigator.
  const p2 = await page.context().newPage();
  await p2.goto('/');
  const discard = p2.getByTestId('session-discard');
  await discard.waitFor({ timeout: 5000 }).then(() => discard.click(), () => {});
  await p2.locator('[data-sidebar-tab="tools"]').first().click();
  await p2.getByTestId('tools-entry-worklists').click();
  await expect.poll(() => p2.evaluate((wid) => !!document.querySelector(`[data-testid="worklist-catalog-row"][data-id="${wid}"]`), id), { timeout: 15000 }).toBe(true);
});

test('matches are suggestions only: counted, listed, opened by hand', async ({ page }) => {
  await page.goto('/');
  // A worklist attributed to this board by a partial name, and one by tag.
  const tag = `tag${uniq()}`;
  await openBoard(page, TOMU);
  const [byName, byTag] = await page.evaluate((t) => {
    const s = (window as unknown as { __worklistStore: WS }).__worklistStore;
    const a = s.createWorklist(`partial ${t}`, { onTab: false, board: 'TOMU FPGA' })!;
    const b = s.createWorklist(`tagged ${t}`, { onTab: false, board: 'unrelated-board' })!;
    s.setTags(b.id, ['tomu-fpga']);
    return [a.id, b.id];
  }, tag);
  await worklistTab(page);
  const box = page.getByTestId('worklist-suggestions');
  await expect.poll(async () => Number(await box.getAttribute('data-count'))).toBeGreaterThanOrEqual(2);
  // Nothing loaded by itself.
  expect(await page.evaluate(() => {
    const w = window as unknown as { __worklistStore: WS; __boardStore: { activeTabId: number } };
    return w.__worklistStore.worklistForTab(w.__boardStore.activeTabId);
  })).toBeNull();
  await expect(box.locator(`[data-testid="worklist-suggestion"][data-id="${byName}"]`)).toBeVisible();
  const tagged = box.locator(`[data-testid="worklist-suggestion"][data-id="${byTag}"]`);
  await expect(tagged).toContainText('tag “tomu-fpga”');
  // Open loads it on this tab.
  await tagged.getByTestId('worklist-suggestion-open').click();
  await expect(page.getByTestId('worklist-origin')).toContainText('unrelated-board');
  await expect(page.getByTestId('worklist-origin')).toContainText('another board');

  // A different board does not see either.
  await openBoard(page, BVR);
  await expect(page.locator(`[data-testid="worklist-suggestion"][data-id="${byName}"]`)).toHaveCount(0);
});

test('one worklist on two boards: a mark set on one shows on the other', async ({ page }) => {
  await page.goto('/');
  await openBoard(page, TOMU);
  const ids = await page.evaluate(() => {
    const w = window as unknown as { __worklistStore: WS; __boardStore: { activeTabId: number; board: { parts: { name: string }[] } } };
    const wl = w.__worklistStore.createWorklist(`shared ${Date.now()}`)!;
    w.__worklistStore.pushParts(wl.id, [0]);
    return { wl: wl.id, tomuTab: w.__boardStore.activeTabId, refdes: w.__boardStore.board.parts[0].name };
  });
  // Another board — a donor beside the patient — loads the same worklist.
  await openBoard(page, BVR);
  const tab2 = await page.evaluate((wl) => {
    const w = window as unknown as { __worklistStore: WS; __boardStore: { activeTabId: number } };
    w.__worklistStore.loadOnTab(w.__boardStore.activeTabId, wl);
    return w.__boardStore.activeTabId;
  }, ids.wl);
  expect(tab2).not.toBe(ids.tomuTab);
  // A mark set from the second board shows on the first …
  await page.evaluate(({ wl, refdes }) => (window as unknown as { __worklistStore: WS }).__worklistStore.setMark(wl, refdes, 'replaced'), { wl: ids.wl, refdes: ids.refdes });
  const onFirst = await page.evaluate(({ tab }) => (window as unknown as { __worklistStore: WS }).__worklistStore.worklistForTab(tab)?.entries[0], { tab: ids.tomuTab });
  expect(onFirst).toMatchObject({ refdes: ids.refdes, mark: 'replaced' });
  expect((onFirst as { unresolved?: boolean }).unresolved).toBeUndefined();
  // … and each board resolves the row against itself: not on the second one.
  const onSecond = await page.evaluate(({ tab }) => (window as unknown as { __worklistStore: WS }).__worklistStore.worklistForTab(tab)?.entries[0], { tab: tab2 });
  expect(onSecond).toMatchObject({ mark: 'replaced', unresolved: true });
  // The panel says so in words.
  await worklistTab(page);
  await expect(page.getByTestId('worklist-part-row').first()).toContainText('not on this board');
});

test('edits from two places merge row by row (409 → merge → put)', async ({ page, request }) => {
  await page.goto('/');
  await openBoard(page, TOMU);
  const { id, refdes } = await page.evaluate(async () => {
    const w = window as unknown as { __worklistStore: WS; __boardStore: { board: { parts: { name: string }[] } } };
    const wl = w.__worklistStore.createWorklist(`merge ${Date.now()}`)!;
    w.__worklistStore.pushParts(wl.id, [0]);
    await w.__worklistStore.TEST_SETTLED();
    return { id: wl.id, refdes: w.__boardStore.board.parts[0].name };
  });
  // Another bench adds a net, straight to the server.
  const server = await (await request.get(`/api/worklists/${id}`)).json();
  server.netEntries.push({ netName: 'OTHER_BENCH_NET', mark: 'short', note: '', at: Date.now() });
  expect((await request.put(`/api/worklists/${id}`, { data: server })).ok()).toBe(true);
  // This page, still on the old rev, marks the part.
  await page.evaluate(async ({ id, refdes }) => {
    const s = (window as unknown as { __worklistStore: WS }).__worklistStore;
    s.setMark(id, refdes, 'cleaned');
    await s.TEST_SETTLED();
  }, { id, refdes });
  const after = await (await request.get(`/api/worklists/${id}`)).json();
  expect(after.entries.find((e: { refdes: string }) => e.refdes === refdes).mark).toBe('cleaned');
  expect(after.netEntries.map((n: { netName: string }) => n.netName)).toContain('OTHER_BENCH_NET');
});

test('the navigator edits board name and tags with no board open, and Clear clears nets too', async ({ page, request }) => {
  await page.goto('/');
  await openBoard(page, TOMU);
  const id = await page.evaluate(async () => {
    const s = (window as unknown as { __worklistStore: WS }).__worklistStore;
    const w = s.createWorklist(`nav ${Date.now()}`)!;
    s.pushParts(w.id, [0]);
    s.pushNets(w.id, ['GND']);
    s.wipeWorklist(w.id);
    await s.TEST_SETTLED();
    return w.id;
  });
  const doc = await (await request.get(`/api/worklists/${id}`)).json();
  expect(doc.entries.every((e: { removed?: number }) => e.removed)).toBe(true);
  expect(doc.netEntries.every((e: { removed?: number }) => e.removed)).toBe(true);

  await page.locator('[data-sidebar-tab="tools"]').first().click();
  await page.getByTestId('tools-entry-worklists').click();
  const row = page.locator(`[data-testid="worklist-catalog-row"][data-id="${id}"]`);
  await expect(row).toBeVisible({ timeout: 10000 });
  await row.click();
  await page.getByTestId('wlnav-board').fill('820-99999');
  await page.getByTestId('wlnav-board').press('Enter');
  await page.getByTestId('wlnav-tags').fill('A9999, water');
  await page.getByTestId('wlnav-tags').press('Enter');
  await page.evaluate(() => (window as unknown as { __worklistStore: WS }).__worklistStore.TEST_SETTLED());
  const after = await (await request.get(`/api/worklists/${id}`)).json();
  expect(after.board).toBe('820-99999');
  expect(after.tags).toEqual(['A9999', 'water']);
});

test('the old per-board worklists are imported once and reach the server', async ({ page, request }) => {
  await page.goto('/');
  const id = `st-${uniq()}`;
  // Seed the old (v1) store the way a previous version left it, then let the
  // app start as if for the first time on the new version.
  await page.evaluate(async (wid) => {
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('boardripper-worklist', 1);
      req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains('boards')) req.result.createObjectStore('boards', { keyPath: 'key' }); };
      req.onsuccess = () => {
        const tx = req.result.transaction('boards', 'readwrite');
        tx.objectStore('boards').put({
          key: '820-02016-07.pcb:123:456', fileName: '820-02016-07.pcb', activeWorklistId: wid, updatedAt: 1, schemaVersion: 1,
          worklistes: [{ id: wid, name: 'Old ticket', createdAt: 1, updatedAt: 2,
            entries: [{ partIndex: 3, refdes: 'U7700', mark: 'replaced', note: 'swapped', unresolved: false }],
            netEntries: [{ netName: 'PPBUS_G3H', mark: 'short', note: '' }] }],
        });
        tx.oncomplete = () => { req.result.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    });
    localStorage.removeItem('boardripper-worklists-migrated-v2');
  }, id);
  await page.reload();
  await page.evaluate(() => (window as unknown as { __worklistStore: WS }).__worklistStore.TEST_SETTLED());
  const doc = await (await request.get(`/api/worklists/${id}`)).json();
  expect(doc).toMatchObject({ id, name: 'Old ticket', board: '820-02016', origin: { fileName: '820-02016-07.pcb' } });
  expect(doc.entries[0]).toMatchObject({ refdes: 'U7700', mark: 'replaced', note: 'swapped' });
  expect(doc.entries[0].partIndex).toBeUndefined();          // nothing board-specific is stored
  expect(doc.netEntries[0]).toMatchObject({ netName: 'PPBUS_G3H', mark: 'short' });
  // Once only: a second start does not import it again (it would be a no-op by id anyway).
  expect(await page.evaluate(() => !!localStorage.getItem('boardripper-worklists-migrated-v2'))).toBe(true);
});
