import { test, expect, type Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Tracked synthetic fixture (10 parts: U1, R1-R4, C1-C3, U2, J1) — same file
// comprehensive.spec.ts uses. Not proprietary; ships in public/samples/.
const TEST_BVR1 = path.resolve(__dirname, '../public/samples/test-board.bvr');

/** Record every request whose path contains /api/, for the whole test. */
function trackApi(page: Page): string[] {
  const calls: string[] = [];
  page.on('request', (req) => {
    try {
      const u = new URL(req.url());
      if (u.pathname.includes('/api/')) calls.push(`${req.method()} ${u.pathname}`);
    } catch { /* non-URL scheme, ignore */ }
  });
  return calls;
}

/** Record every failed (>=400) response — catches /-rooted asset misses under the sub-path. */
function trackFailures(page: Page): string[] {
  const bad: string[] = [];
  page.on('response', (res) => {
    if (res.status() >= 400) bad.push(`${res.status()} ${res.url()}`);
  });
  return bad;
}

// NOTE: goto('.') everywhere — goto('/') would escape the sub-path baseURL of
// the lite-dist-subpath project.

test('cold load: zero /api requests, zero failed responses', async ({ page }) => {
  const api = trackApi(page);
  const bad = trackFailures(page);
  await page.goto('.');
  await page.waitForLoadState('networkidle');
  // Let mount effects and the first tick of any interval settle.
  await page.waitForTimeout(1500);
  expect(api, `unexpected /api calls: ${api.join(', ')}`).toEqual([]);
  expect(bad, `failed requests: ${bad.join(', ')}`).toEqual([]);
});

test('board opens locally and stays network-silent', async ({ page }) => {
  const api = trackApi(page);
  await page.goto('.');
  await page.waitForLoadState('networkidle');
  // Upload through the real hidden file input. Rename the fixture to an
  // Apple-style board number so the OBD board-open path (obdStore.loadMatches
  // from BoardViewerPanel) would fire if it were ungated.
  await page.getByTestId('file-input').setInputFiles({
    name: '820-00281.bvr',
    mimeType: 'application/octet-stream',
    buffer: fs.readFileSync(TEST_BVR1),
  });
  await expect(page.getByTestId('statusbar')).toContainText('Components:', { timeout: 15000 });
  await page.waitForTimeout(1000);
  expect(api, `unexpected /api calls after board open: ${api.join(', ')}`).toEqual([]);
});

test('backend-only UI is absent', async ({ page }) => {
  await page.goto('.');
  await page.waitForLoadState('networkidle');
  // Self-update badge — gated off in the lite build.
  await expect(page.getByTestId('update-badge')).toHaveCount(0);
  // The Library tab STAYS: the lite build has no server library, but it does
  // have the local-folder one (store/folder-library.ts).
  await expect(page.locator('[data-sidebar-tab="library"]')).toHaveCount(1);
  // Backend settings tabs — filtered out of TAB_ORDER (sidebar opens on the
  // Settings tab by default in the lite build, so the pills are rendered).
  await expect(page.locator('[data-settings-tab="integrations"]')).toHaveCount(0);
  await expect(page.locator('[data-settings-tab="library"]')).toHaveCount(0);
});

test('lite build offers the offline-copy download (where the update badge was)', async ({ page }) => {
  await page.goto('.');
  await page.waitForLoadState('networkidle');
  const dl = page.getByTestId('download-offline');
  await expect(dl).toHaveCount(1);
  await expect(dl).toHaveAttribute('href', './boardripper-lite.html');
  await expect(dl).toHaveAttribute('download', /boardripper-lite\.html/);
});

test('PWA manifest is linked', async ({ page }) => {
  await page.goto('.');
  await expect(page.locator('link[rel="manifest"]')).toHaveCount(1);
});

// ── Front door (2026-09-04 lite review) ──────────────────────────────────────
// The lite build has no Library and, on a tablet, no drag-and-drop — the home
// page must itself offer a way in, and must not open on Docker instructions.

test('home page offers Open + sample, and hides the Docker-only sections', async ({ page }) => {
  await page.goto('.');
  await page.waitForLoadState('networkidle');
  await expect(page.getByTestId('home-open-card')).toBeVisible();
  await expect(page.getByTestId('home-open-btn')).toBeVisible();
  const body = await page.locator('.home-instructions').innerText();
  expect(body).not.toContain('Run it in Docker');
  expect(body).not.toContain('The Library');
  expect(body).toContain('Upload');            // the no-drag-and-drop line
  // The fence markers themselves must never leak into the rendered text.
  expect(body).not.toContain('docker-only');
});

test('sample board opens from the bundled file (relative base) and stays network-silent', async ({ page }) => {
  const api = trackApi(page);
  const bad = trackFailures(page);
  await page.goto('.');
  await page.waitForLoadState('networkidle');
  await page.getByTestId('home-sample-btn').click();
  await expect(page.getByTestId('statusbar')).toContainText('Components: 52', { timeout: 60000 });
  expect(api).toEqual([]);
  expect(bad, `failed requests: ${bad.join(', ')}`).toEqual([]);
});

// ── Local-folder library ─────────────────────────────────────────────────
// The lite build's library is a folder this browser was pointed at. Chromium
// would use showDirectoryPicker() — a native dialog Playwright cannot drive —
// so these drive the `webkitdirectory` input every other browser uses, which
// is the same store call and the same scan.

/** Show the Library panel. Clicking the rail destination that is already
 *  active HIDES the panel (that is the contract), and the lite build now
 *  boots on Library — so click only when it is not already showing. */
async function openLibrary(page: Page) {
  const panel = page.locator('.library-panel');
  if (!(await panel.isVisible())) await page.locator('[data-sidebar-tab="library"]').click();
  await expect(panel).toBeVisible();
}

/** A throwaway folder with two boards in a subdirectory and one file that is
 *  neither a board nor a PDF. */
function makeLibraryFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'br-lib-'));
  fs.mkdirSync(path.join(root, 'macbook'));
  fs.copyFileSync(TEST_BVR1, path.join(root, 'macbook', '820-00281.bvr'));
  fs.copyFileSync(TEST_BVR1, path.join(root, 'loose-board.bvr'));
  fs.writeFileSync(path.join(root, 'readme.txt'), 'not a board');
  return root;
}

test('a picked folder becomes the library, and opens boards from it', async ({ page }) => {
  const api = trackApi(page);
  const root = makeLibraryFixture();
  await page.goto('.');
  await page.waitForLoadState('networkidle');

  await openLibrary(page);
  await expect(page.getByTestId('pick-library-folder')).toBeVisible();

  await page.getByTestId('folder-library-input').setInputFiles(root);

  // Two boards indexed, the .txt ignored.
  const chip = page.getByTestId('folder-library-chip');
  await expect(chip).toContainText(path.basename(root));
  await expect(chip.locator('.folder-lib-chip-count')).toHaveText('2');

  // The board opens from the folder — no /api anywhere on the way. Folders
  // view: the root is expanded, so the board sitting at the root is one
  // double-click away without walking the Board# groupings.
  await page.locator('[data-library-tab="folders"]').click();
  await page.locator('.library-tree').getByText('loose-board.bvr').first().dblclick();
  await expect(page.getByTestId('statusbar')).toContainText('Components:', { timeout: 20000 });
  expect(api, `unexpected /api calls: ${api.join(', ')}`).toEqual([]);

  fs.rmSync(root, { recursive: true, force: true });
});

test('the folder index survives a reload, and says so when the bytes do not', async ({ page }) => {
  const root = makeLibraryFixture();
  await page.goto('.');
  await page.waitForLoadState('networkidle');
  await openLibrary(page);
  await page.getByTestId('folder-library-input').setInputFiles(root);
  await expect(page.getByTestId('folder-library-chip')).toContainText(path.basename(root));

  await page.reload();
  await page.waitForLoadState('networkidle');
  await openLibrary(page);

  // A webkitdirectory FileList cannot be revived, so the index comes back
  // detached: the library still lists, and opening asks for the folder.
  const chip = page.getByTestId('folder-library-chip');
  await expect(chip).toContainText(path.basename(root));
  await expect(chip).toContainText('index only');
  await expect(page.getByTestId('change-library-folder')).toHaveText(/Choose folder/);

  fs.rmSync(root, { recursive: true, force: true });
});

test('after a reload, opening a board asks for the folder and then opens it', async ({ page }) => {
  const root = makeLibraryFixture();
  // Input mode is what Firefox, Safari and the iPad get. Chromium has a
  // directory picker and would re-pick through that instead (a dialog
  // Playwright cannot answer), so take it away and test the path these
  // browsers really run.
  await page.addInitScript(() => {
    delete (window as unknown as Record<string, unknown>).showDirectoryPicker;
  });
  await page.goto('.');
  await page.waitForLoadState('networkidle');
  await openLibrary(page);
  await page.getByTestId('folder-library-input').setInputFiles(root);
  await expect(page.getByTestId('folder-library-chip')).toContainText(path.basename(root));

  await page.reload();
  await page.waitForLoadState('networkidle');
  await openLibrary(page);
  await expect(page.getByTestId('folder-library-chip')).toContainText('index only');

  // The dead end this replaces: the board was unopenable and the message
  // said "reconnect", which an input-mode library can never do — there is
  // no handle to re-request. A double-click is a user gesture, so it can
  // ask for the folder itself and carry on with the board that was asked
  // for. Playwright answers the dialog the way a user would.
  page.on('filechooser', (chooser) => { void chooser.setFiles(root); });
  await page.locator('[data-library-tab="folders"]').click();
  await page.locator('.library-tree').getByText('loose-board.bvr').first().dblclick();

  await expect(page.getByTestId('statusbar')).toContainText('Components:', { timeout: 20000 });
  await expect(page.getByTestId('folder-library-chip')).not.toContainText('index only');

  fs.rmSync(root, { recursive: true, force: true });
});

test('a re-pick the user dismisses reports it, and does not leave the open hanging', async ({ page }) => {
  const root = makeLibraryFixture();
  await page.goto('.');
  await page.waitForLoadState('networkidle');
  await openLibrary(page);
  await page.getByTestId('folder-library-input').setInputFiles(root);
  await expect(page.getByTestId('folder-library-chip')).toContainText(path.basename(root));

  // Dismissing the dialog is the common case, and the open that started it
  // awaits a promise: every exit from the pick has to settle that promise
  // or the board is stuck loading with nothing on screen and no message.
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).showDirectoryPicker = async () => {
      throw new DOMException('The user aborted a request.', 'AbortError');
    };
  });
  await page.reload();
  await page.waitForLoadState('networkidle');
  await openLibrary(page);
  await page.locator('[data-library-tab="folders"]').click();
  await page.locator('.library-tree').getByText('loose-board.bvr').first().dblclick();

  await expect(page.locator('.toast-container')).toContainText(/No folder opened/i, { timeout: 5000 });
  // Still usable: the index is there and the folder can be chosen again.
  await expect(page.getByTestId('change-library-folder')).toBeEnabled();

  fs.rmSync(root, { recursive: true, force: true });
});
