/**
 * Desktop app smoke test.
 *
 * The desktop build ships the same frontend bundle as the web app, loaded
 * from file:// by Electron with no backend (MCP off by default). Things that
 * pass on the web can still break here: an asset referenced by an absolute
 * path, a control hidden behind a backend gate, a boot crash in main.js.
 * This launches the real app and drives the board the way a user would.
 *
 * Build the bundle first (`npm run build:desktop-webapp`, or any
 * desktop/build-all.mjs run); the test skips when desktop/webapp is absent.
 */
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(HERE, '../../../desktop');
const WEBAPP = path.join(DESKTOP, 'webapp');
const FIXTURE = path.resolve(HERE, '../public/samples/test-board.bvr');

const require_ = createRequire(path.join(DESKTOP, 'package.json'));
const built = fs.existsSync(path.join(WEBAPP, 'index.html'));

test.describe('desktop app', () => {
  test.skip(!built, 'desktop/webapp not built — run desktop/build-all.mjs first');

  let app: ElectronApplication;
  let page: Page;
  let userDataDir = '';
  const errors: string[] = [];

  test.beforeAll(async () => {
    // ELECTRON_RUN_AS_NODE must not leak in: VS Code's extension host sets it
    // in its integrated terminal, and with it Electron runs main.js as plain
    // Node, where `app` is undefined and the launch dies before any window.
    const env: Record<string, string> = { NODE_ENV: 'production' };
    for (const [k, v] of Object.entries(process.env)) {
      if (k === 'ELECTRON_RUN_AS_NODE' || v === undefined) continue;
      env[k] = v;
    }
    // A throwaway user-data dir: the real one carries the developer's own
    // sidebar state and open session, which would decide what a click does.
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'br-electron-'));
    app = await electron.launch({
      executablePath: require_('electron') as string,
      args: [DESKTOP, `--user-data-dir=${userDataDir}`],
      env,
    });
    page = await app.firstWindow();
    page.on('pageerror', e => errors.push(e.message.split('\n')[0]));
    page.on('console', m => { if (/render crash|_gpuData/.test(m.text())) errors.push(m.text().slice(0, 200)); });
    // Any asset that 404s under file:// is a packaging bug — an absolute URL
    // that only resolves on the root-mounted NAS build, say. Backend polls are
    // the one expected failure: the desktop app runs without one unless MCP is
    // switched on, and the app is built to carry on.
    page.on('requestfailed', r => {
      const url = r.url();
      if (url.includes('/api/')) return;
      errors.push(`asset failed: ${r.failure()?.errorText} ${url}`);
    });
    await page.waitForLoadState('domcontentloaded');
  });

  test.afterAll(async () => {
    await app?.close();
    if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  test('boots, shows the app chrome, and loads a board into the new ribbon', async () => {
    // The window came up with the app in it, not a blank/error page.
    await expect(page.getByTestId('toolbar')).toBeVisible({ timeout: 30000 });
    await expect(page.getByTestId('activity-rail')).toBeVisible();
    await expect(page.getByTestId('open-btn')).toBeVisible();

    // A board opens and the board ribbon carries the controls that moved
    // there in v0.39 — the change most likely to break a packaged build.
    await page.getByTestId('file-input').waitFor({ state: 'attached' });
    const discard = page.getByTestId('session-discard');
    if (await discard.count()) await discard.click();
    await page.setInputFiles('[data-testid="file-input"]', FIXTURE);
    const bar = page.getByTestId('board-overlay-bar');
    await expect(bar).toBeVisible({ timeout: 30000 });
    for (const id of ['side-top', 'side-bottom', 'butterfly-btn', 'rotate-cw', 'transform-menu', 'overlay-collapse']) {
      await expect(bar.getByTestId(id)).toBeVisible();
    }

    // The controls actually act, and the renderer survives it.
    await bar.getByTestId('side-bottom').click();
    await expect(bar.getByTestId('side-bottom')).toHaveClass(/active/);
    await bar.getByTestId('butterfly-btn').click();
    await expect(bar.getByTestId('butterfly-btn')).toHaveClass(/active/);
    await bar.getByTestId('rotate-cw').click();
    await page.waitForTimeout(600);
    await bar.getByTestId('butterfly-btn').click();

    // The sidebar rail navigates: Settings is reachable with no backend.
    // Clicking the destination that is already open hides the panel, so bring
    // it back if this click landed on the active one.
    const rail = page.locator('[data-testid="activity-rail"]');
    await rail.locator('[data-sidebar-tab="settings"]').click();
    if (await page.locator('.sidebar').isHidden()) await rail.locator('[data-sidebar-tab="settings"]').click();
    await expect(page.locator('.sidebar [data-settings-tab]').first()).toBeVisible();
    await expect(page.locator('.sidebar [data-settings-tab]')).not.toHaveCount(0);

    // Fold the ribbon away and bring it back (persisted state, file:// origin).
    await page.getByTestId('overlay-collapse').click();
    await expect(bar).toHaveAttribute('data-collapsed', 'true');
    await page.getByTestId('overlay-collapse').click();
    await expect(bar).toHaveAttribute('data-collapsed', 'false');

    expect(errors).toEqual([]);
  });

  test('no update UI in the desktop build, and 2-window mode toggles', async () => {
    // The bundled backend carries no update ldflags, so the Docker self-update
    // UI must not appear here.
    await expect(page.getByTestId('update-badge')).toHaveCount(0);

    // 2-window mode is offered on desktop (it is hidden only in the single-file
    // offline build and on touch screens). The button arms the mode — a second
    // window appears when a panel is then dragged out — so what is checked here
    // is that it toggles and stays toggled.
    const toggle = page.getByTestId('two-window-toggle');
    await expect(toggle).toBeVisible();
    const wasActive = await toggle.evaluate(el => el.classList.contains('active'));
    await toggle.click();
    await expect(toggle).toHaveClass(wasActive ? /^(?!.*\bactive\b).*$/ : /active/);
    await toggle.click();
    await expect(toggle).toHaveClass(wasActive ? /active/ : /^(?!.*\bactive\b).*$/);
  });
});
