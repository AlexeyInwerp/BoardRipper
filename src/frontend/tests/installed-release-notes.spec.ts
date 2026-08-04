import { test, expect, type Page } from '@playwright/test';

// "What's new" must survive the update that delivered it. Before this, the
// notes were gated on has_update, so they vanished the moment you were on the
// new version — the one moment you'd want to read them.

const NOTES = [
  '## v0.34.0 — 2026-08-05',
  '',
  'On an HDR display the selected outline can burn brighter than white.',
  '',
  '### HDR selection outline',
  '',
  '- **The selected outline, lit.** Not a glow blob behind the part.',
  '- **Turn it on where you will see it.** A card on the start page.',
  '- **It asks your eyes, not your monitor.** A patch beside reference white.',
  '- **Brightness is a baked ladder, not an opacity.** 24 tiles.',
  '- **Undock to an SDR monitor** and it tears itself down.',
].join('\n');

const PENDING_NOTES = '## v0.35.0\n\n- **Something newer.** Not yet installed.';

/** Serve a canned /api/update/* so the test needs no backend. */
async function seedBackend(page: Page, opts: { hasUpdate: boolean }) {
  const manifest = opts.hasUpdate
    ? { version: 'v0.35.0', notes: PENDING_NOTES, notes_url: 'https://example.invalid/n', released_at: '2026-08-06T00:00:00Z', important: false }
    : { version: 'v0.34.0', notes: NOTES, notes_url: 'https://example.invalid/n', released_at: '2026-08-05T00:00:00Z', important: false };
  const status = {
    current_version: 'v0.34.0',
    latest_version: manifest.version,
    has_update: opts.hasUpdate,
    docker_available: true,
    manifest,
  };
  await page.route('**/api/update/bootstrap', r => r.fulfill({ status: 200, body: '{}' }));
  await page.route('**/api/update/status', r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(status) }));
  await page.route('**/api/update/check', r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(status) }));
}

/** Pre-seed the cache the way a real update would have left it. */
async function seedInstalledCache(page: Page) {
  await page.addInitScript((notes) => {
    localStorage.setItem('boardripper.installed-release-notes', JSON.stringify({
      version: 'v0.34.0', notes, notes_url: 'https://example.invalid/n', released_at: '2026-08-05T00:00:00Z',
    }));
  }, NOTES);
}

test('up to date: the badge dropdown shows what the running version brought', async ({ page }) => {
  await seedBackend(page, { hasUpdate: false });
  await page.goto('/');
  await page.getByTestId('update-badge').click();

  const notes = page.getByTestId('update-installed-notes');
  await expect(notes).toBeVisible();
  await expect(notes).toContainText('v0.34.0');
  await notes.locator('summary').click();
  await expect(notes).toContainText('HDR selection outline');
  // The bold markers in the changelog must not reach the screen.
  await expect(notes).not.toContainText('**');
});

test('the running version’s notes are cached from the status manifest alone', async ({ page }) => {
  // No pre-seeded localStorage — the store must capture them itself because
  // the manifest's version equals the running version.
  await seedBackend(page, { hasUpdate: false });
  await page.goto('/');
  await expect.poll(() => page.evaluate(
    () => localStorage.getItem('boardripper.installed-release-notes') !== null,
  ), { timeout: 15000 }).toBe(true);
  const cached = await page.evaluate(
    () => JSON.parse(localStorage.getItem('boardripper.installed-release-notes')!),
  );
  expect(cached.version).toBe('v0.34.0');
  expect(cached.notes).toContain('HDR selection outline');
});

test('update available: both versions are shown, each labelled', async ({ page }) => {
  await seedInstalledCache(page);
  await seedBackend(page, { hasUpdate: true });
  await page.goto('/');
  await page.getByTestId('update-badge').click();

  const pending = page.getByTestId('update-whats-new');
  await expect(pending).toContainText('v0.35.0');
  await pending.locator('summary').click();
  await expect(pending).toContainText('Something newer');

  const installed = page.getByTestId('update-installed-notes');
  await expect(installed).toContainText('v0.34.0');
  await expect(installed).toContainText('yours');
  await installed.locator('summary').click();
  await expect(installed).toContainText('HDR selection outline');
});

test('no cached notes: no empty section, no crash', async ({ page }) => {
  // Manifest describes a DIFFERENT version than the one running and nothing is
  // cached, so there is nothing truthful to show for the running version.
  await page.route('**/api/update/bootstrap', r => r.fulfill({ status: 200, body: '{}' }));
  const status = {
    current_version: 'v0.34.0', latest_version: 'v0.35.0', has_update: true,
    docker_available: true,
    manifest: { version: 'v0.35.0', notes: PENDING_NOTES, important: false, released_at: '2026-08-06T00:00:00Z' },
  };
  for (const p of ['**/api/update/status', '**/api/update/check']) {
    await page.route(p, r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(status) }));
  }
  await page.goto('/');
  await page.getByTestId('update-badge').click();
  await expect(page.getByTestId('update-whats-new')).toBeVisible();
  await expect(page.getByTestId('update-installed-notes')).toHaveCount(0);
});

test('the start page card carries the notes too, clipped', async ({ page }) => {
  await seedInstalledCache(page);
  await seedBackend(page, { hasUpdate: false });
  await page.goto('/');

  const card = page.getByTestId('home-installed-notes');
  await expect(card).toBeVisible();
  await expect(card).toContainText('HDR selection outline');
  // Clipped at 6 lines behind a toggle; expanding reveals the tail.
  const toggle = card.getByRole('button', { name: /Show all/ });
  await expect(toggle).toBeVisible();
  await expect(card).not.toContainText('tears itself down');
  await toggle.click();
  await expect(card).toContainText('tears itself down');
});
