/**
 * A split `.asc` board opens whole from the Library.
 *
 * The Tebo-ICT / eM-Test delivery is a folder of section files (Format /
 * Nails / Pins / Parts / Nets). Clicking one of them in the Library means
 * "open this board", so the app resolves the siblings from the same folder
 * and merges them — the OS picker's multi-select is no longer the only way in.
 *
 * These tests need a backend whose library holds such a folder. They skip
 * when the running stack has none, so a plain `npx playwright test` against
 * the default fixture library stays green.
 *
 * Key DOM / dev-hook facts (verified against source):
 *   - `window.__databankStore` / `window.__boardStore` — DEV-only hooks.
 *   - Tree nodes in Folders view: `.library-tree-node`.
 *   - Toasts: `.toast` (see components/Toast).
 */
import { test, expect } from '@playwright/test';

interface DbFile { id: number; path: string; filename: string; file_type: string }
interface MinimalDatabank {
  loadStatus: string;
  files: DbFile[];
  setViewMode: (m: string) => void;
  setBrowseMode: (m: string) => void;
}
interface MinimalBoardStore {
  tabs: { id: number; fileName: string }[];
  activeTab?: {
    fileName: string;
    board?: { parts: { pins: unknown[] }[]; nets: Map<string, unknown>; outline: unknown[]; nails: unknown[] };
  };
}

async function ready(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.waitForFunction(() => {
    const w = window as unknown as { __databankStore?: MinimalDatabank };
    const s = w.__databankStore?.loadStatus;
    return s === 'loaded' || s === 'error';
  }, undefined, { timeout: 20000 });
  // loadStatus flips before the file rows finish streaming in; the tests read
  // `files` directly, so wait for the stream rather than sampling it empty.
  await page.waitForFunction(() => {
    const w = window as unknown as { __databankStore?: MinimalDatabank };
    return (w.__databankStore?.files.length ?? 0) > 0;
  }, undefined, { timeout: 20000 }).catch(() => { /* empty library — tests skip */ });
}

/** The indexed `.asc` section files, grouped by folder. */
async function ascFolders(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const w = window as unknown as { __databankStore?: MinimalDatabank };
    const byDir: Record<string, DbFile[]> = {};
    for (const f of w.__databankStore?.files ?? []) {
      if (!/\.asc$/i.test(f.filename)) continue;
      const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
      (byDir[dir] ??= []).push(f);
    }
    return Object.entries(byDir).filter(([, fs]) => fs.length > 1);
  }) as Promise<Array<[string, DbFile[]]>>;
}

test.describe('split .asc delivery', () => {
  test('clicking one section in the Library opens the whole board', async ({ page }) => {
    await ready(page);
    const folders = await ascFolders(page);
    test.skip(folders.length === 0, 'no multi-file .asc folder in this stack’s library');

    const [, files] = folders[0];
    // Click the section that carries no geometry at all — on its own it used
    // to fail outright, so it is the strongest evidence the merge happened.
    const target = files.find(f => /nets/i.test(f.filename)) ?? files[0];

    const result = await page.evaluate(async (fileId) => {
      const mod = await import('/src/store/file-actions.ts');
      const w = window as unknown as { __databankStore?: MinimalDatabank; __boardStore?: MinimalBoardStore };
      await mod.openLibraryFileById(fileId);
      const b = w.__boardStore?.activeTab?.board;
      return {
        tabs: w.__boardStore?.tabs.length ?? 0,
        name: w.__boardStore?.activeTab?.fileName ?? '',
        parts: b?.parts.length ?? 0,
        pins: b?.parts.reduce((n, p) => n + p.pins.length, 0) ?? 0,
        nets: b?.nets.size ?? 0,
        outline: b?.outline.length ?? 0,
        nails: b?.nails.length ?? 0,
      };
    }, target.id);

    // One tab, holding every section's data — not five tabs, not a fragment.
    expect(result.tabs).toBe(1);
    expect(result.parts).toBeGreaterThan(0);
    expect(result.pins).toBeGreaterThan(0);
    expect(result.nets).toBeGreaterThan(0);
    expect(result.outline).toBeGreaterThan(0);
    expect(result.nails).toBeGreaterThan(0);

    // And it says so, rather than silently opening files nobody clicked.
    await expect(page.locator('.toast').filter({ hasText: 'as one board' })).toBeVisible();
  });

  test('a lone section from the file picker offers the missing ones', async ({ page }) => {
    await ready(page);
    const folders = await ascFolders(page);
    test.skip(folders.length === 0, 'no multi-file .asc folder in this stack’s library');

    const [, files] = folders[0];
    const pins = files.find(f => /pins/i.test(f.filename));
    test.skip(!pins, 'no pins section in the library folder');

    // Feed the board store a single File the way the OS picker does — no
    // folder to resolve siblings from, so the app must offer the picker.
    await page.evaluate(async (path) => {
      const res = await fetch(`/api/files/path/${encodeURIComponent(path)}`);
      const buf = await res.arrayBuffer();
      const name = path.slice(path.lastIndexOf('/') + 1);
      const w = window as unknown as { __boardStore?: { loadFiles: (f: File[]) => Promise<void> } };
      await w.__boardStore!.loadFiles([new File([buf], name, { type: 'text/plain' })]);
    }, pins!.path);

    const toast = page.locator('.toast').filter({ hasText: 'split ASC board' });
    await expect(toast).toBeVisible();

    // Taking the offer replaces the partial tab with the merged board rather
    // than leaving the fragment open beside it.
    const chooser = page.waitForEvent('filechooser');
    await toast.getByRole('button', { name: 'Add sections…' }).click();
    const rest = files.filter(f => f.id !== pins!.id);
    await (await chooser).setFiles(await Promise.all(rest.map(async f => ({
      name: f.filename,
      mimeType: 'text/plain',
      buffer: Buffer.from(await (await fetch(
        `${test.info().project.use.baseURL}/api/files/path/${encodeURIComponent(f.path)}`,
      )).arrayBuffer()),
    }))));

    // The partial tab carried parts but no outline; the merged one has both.
    await expect.poll(async () => page.evaluate(() => {
      const w = window as unknown as { __boardStore?: MinimalBoardStore };
      const b = w.__boardStore?.activeTab?.board;
      return {
        tabs: w.__boardStore?.tabs.length ?? 0,
        parts: (b?.parts.length ?? 0) > 0,
        outline: (b?.outline.length ?? 0) > 0,
        nails: (b?.nails.length ?? 0) > 0,
      };
    }), { timeout: 30000 }).toEqual({ tabs: 1, parts: true, outline: true, nails: true });
  });
});
