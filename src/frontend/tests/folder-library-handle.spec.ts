import { test, expect, type Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname_ = path.dirname(fileURLToPath(import.meta.url));
/** The tracked synthetic board every lite spec opens — real bytes, so a
 *  failure here is the folder library's, not a hand-written file's. */
const BOARD_TEXT = fs.readFileSync(path.resolve(__dirname_, '../public/samples/test-board.bvr'), 'utf8');

/**
 * The Chromium directory-handle path — the one `web-lite.spec.ts` cannot
 * reach, because its `webkitdirectory` input has no handle and no
 * permission, and because Playwright cannot drive a native picker.
 *
 * Two substitutions, both faithful:
 *
 * - `showDirectoryPicker()` returns an **OPFS** directory handle. OPFS
 *   handles are the same `FileSystemDirectoryHandle` interface the picker
 *   returns, structured-cloneable into IndexedDB exactly the same way, so
 *   everything after the dialog is the real code on a real handle.
 * - `queryPermission` / `requestPermission` are stubbed per test, because
 *   the states that matter — a grant that Chromium revoked when the last
 *   tab closed, a user who denies the re-request — cannot be produced on
 *   demand otherwise. This is where the reported "nothing happens after a
 *   reload" lives, so it is the part that must be pinned down.
 */

type PermState = 'granted' | 'prompt' | 'denied';

/** Install the stubs before any app code runs. `perm` is the answer
 *  `queryPermission` gives; `grantOnRequest` decides `requestPermission`. */
async function stubFileSystem(page: Page, opts: { perm: PermState; grantOnRequest?: boolean; files?: string[] }) {
  await page.addInitScript(({ perm, grantOnRequest, files, board }) => {
    // State lives in sessionStorage, not on `window`: these tests reload the
    // page, and an init script runs again on every navigation — a counter or
    // a permission held on `window` would silently reset to its start value
    // mid-test, which is a way to make a broken reload look fine.
    const S = sessionStorage;
    if (S.getItem('perm') === null) S.setItem('perm', perm);
    const bump = (k: string) => S.setItem(k, String(Number(S.getItem(k) ?? '0') + 1));

    const proto = (window as unknown as { FileSystemHandle: { prototype: Record<string, unknown> } }).FileSystemHandle.prototype;
    proto.queryPermission = async function () { return S.getItem('perm'); };
    proto.requestPermission = async function () {
      bump('requests');
      if (grantOnRequest) S.setItem('perm', 'granted');
      return S.getItem('perm');
    };
    (window as unknown as Record<string, unknown>).showDirectoryPicker = async () => {
      bump('pickerCalls');
      const root = await navigator.storage.getDirectory();
      const lib = await root.getDirectoryHandle('bench', { create: true });
      for (const rel of files ?? []) {
        const parts = rel.split('/');
        let dir = lib;
        while (parts.length > 1) dir = await dir.getDirectoryHandle(parts.shift()!, { create: true });
        const fh = await dir.getFileHandle(parts[0], { create: true });
        const wr = await fh.createWritable();
        // The real fixture for boards, anything for the files that must be
        // ignored — a hand-written board would fail to parse and read as a
        // folder-library bug.
        await wr.write(rel.endsWith('.bvr') ? board : 'not a board');
        await wr.close();
      }
      return lib;
    };
  }, { ...opts, board: BOARD_TEXT });
}

/** Read one of the stub's session counters. */
const counter = (page: Page, key: string) =>
  page.evaluate((k) => Number(sessionStorage.getItem(k) ?? '0'), key);

/** Put the handle in the state a closed tab leaves it in: still stored, no
 *  longer granted. */
const revoke = (page: Page) => page.evaluate(() => sessionStorage.setItem('perm', 'prompt'));

async function openLibrary(page: Page) {
  const panel = page.locator('.library-panel');
  if (!(await panel.isVisible())) await page.locator('[data-sidebar-tab="library"]').click();
  await expect(panel).toBeVisible();
}

const FILES = ['loose.bvr', 'macbook/820-00281.bvr', 'macbook/notes.txt'];

test('picking a folder indexes it and the chip reports what was found', async ({ page }) => {
  await stubFileSystem(page, { perm: 'granted', files: FILES });
  await page.goto('.');
  await page.waitForLoadState('networkidle');
  await openLibrary(page);

  await page.getByTestId('pick-library-folder').click();

  const chip = page.getByTestId('folder-library-chip');
  await expect(chip).toContainText('bench');
  // notes.txt is neither a board nor a PDF.
  await expect(chip.locator('.folder-lib-chip-count')).toHaveText('2');
  await expect(chip).not.toContainText('needs permission');
});

test('a folder with nothing supported in it says so, instead of looking broken', async ({ page }) => {
  await stubFileSystem(page, { perm: 'granted', files: ['readme.txt', 'photo.jpg'] });
  await page.goto('.');
  await page.waitForLoadState('networkidle');
  await openLibrary(page);

  await page.getByTestId('pick-library-folder').click();
  await expect(page.locator('.toast-container')).toContainText(/No boards or PDFs/i);
});

test('a dismissed picker explains which folders the browser refuses', async ({ page }) => {
  await stubFileSystem(page, { perm: 'granted' });
  // A cancel and a blocked folder are the same AbortError to us.
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).showDirectoryPicker = async () => {
      throw new DOMException('The user aborted a request.', 'AbortError');
    };
  });
  await page.goto('.');
  await page.waitForLoadState('networkidle');
  await openLibrary(page);

  await page.getByTestId('pick-library-folder').click();
  await expect(page.locator('.toast-container')).toContainText(/home folder, Desktop, Documents/i);
});

test('a still-granted folder comes back by itself after a reload', async ({ page }) => {
  await stubFileSystem(page, { perm: 'granted', files: FILES });
  await page.goto('.');
  await page.waitForLoadState('networkidle');
  await openLibrary(page);
  await page.getByTestId('pick-library-folder').click();
  await expect(page.getByTestId('folder-library-chip')).toContainText('bench');

  await page.reload();
  await page.waitForLoadState('networkidle');
  await openLibrary(page);

  const chip = page.getByTestId('folder-library-chip');
  await expect(chip).toContainText('bench');
  await expect(chip).not.toContainText('needs permission');
  // Readable, not just listed: the rescan rebuilt the id → handle map, and
  // the picker was not opened a second time.
  expect(await counter(page, 'pickerCalls'), 'the picker must not open again').toBe(1);
  await page.locator('[data-library-tab="folders"]').click();
  await page.locator('.library-tree').getByText('loose.bvr').first().dblclick();
  await expect(page.getByTestId('statusbar')).toContainText('Components:', { timeout: 20000 });
});

test('a revoked grant lists the library and asks for access on the first open', async ({ page }) => {
  await stubFileSystem(page, { perm: 'granted', grantOnRequest: true, files: FILES });
  await page.goto('.');
  await page.waitForLoadState('networkidle');
  await openLibrary(page);
  await page.getByTestId('pick-library-folder').click();
  await expect(page.getByTestId('folder-library-chip')).toContainText('bench');

  // Chromium drops the grant when the last tab of the origin closes; the
  // handle in IndexedDB survives. This is that state.
  await revoke(page);
  await page.reload();
  await page.waitForLoadState('networkidle');
  await openLibrary(page);

  const chip = page.getByTestId('folder-library-chip');
  await expect(chip).toContainText('bench');
  await expect(chip).toContainText('needs permission');
  // The index is still browsable — the whole point of persisting it.
  await page.locator('[data-library-tab="folders"]').click();
  await expect(page.locator('.library-tree')).toContainText('loose.bvr');

  // Opening a file is a user gesture, so it re-requests rather than failing.
  await page.locator('.library-tree').getByText('loose.bvr').first().dblclick();
  await expect(page.getByTestId('statusbar')).toContainText('Components:', { timeout: 20000 });
  expect(await counter(page, 'requests'), 'opening a file must re-request access').toBeGreaterThan(0);
  await expect(page.getByTestId('folder-library-chip')).not.toContainText('needs permission');
});

test('the Reconnect button restores access without a second trip to the picker', async ({ page }) => {
  await stubFileSystem(page, { perm: 'granted', grantOnRequest: true, files: FILES });
  await page.goto('.');
  await page.waitForLoadState('networkidle');
  await openLibrary(page);
  await page.getByTestId('pick-library-folder').click();
  await expect(page.getByTestId('folder-library-chip')).toContainText('bench');

  await revoke(page);
  await page.reload();
  await page.waitForLoadState('networkidle');
  await openLibrary(page);

  await page.getByTestId('reconnect-library-folder').click();
  await expect(page.getByTestId('folder-library-chip')).not.toContainText('needs permission');
  expect(await counter(page, 'pickerCalls'), 'Reconnect must not reopen the picker').toBe(1);
});

test('a denied re-request says so and leaves the index intact', async ({ page }) => {
  await stubFileSystem(page, { perm: 'granted', grantOnRequest: false, files: FILES });
  await page.goto('.');
  await page.waitForLoadState('networkidle');
  await openLibrary(page);
  await page.getByTestId('pick-library-folder').click();
  await expect(page.getByTestId('folder-library-chip')).toContainText('bench');

  await page.evaluate(() => sessionStorage.setItem('perm', 'denied'));
  await page.reload();
  await page.waitForLoadState('networkidle');
  await openLibrary(page);

  await page.getByTestId('reconnect-library-folder').click();
  await expect(page.locator('.toast-container')).toContainText(/did not restore access/i);
  await expect(page.getByTestId('folder-library-chip')).toContainText('bench');
});
