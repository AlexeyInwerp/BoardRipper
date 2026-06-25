/**
 * update-whats-new.spec.ts
 *
 * Proves that the "What's new" spoiler inside the update-badge dropdown:
 *   1. Appears (with geometry in-viewport) and shows the manifest notes
 *      when `has_update: true` and `manifest.notes` is populated.
 *   2. Is absent when the manifest carries no notes field.
 *
 * All backend calls are intercepted via page.route so the test is
 * backend-independent. Routes are registered BEFORE page.goto so the mocks
 * are in place for the initial status fetch that fires on mount.
 *
 * The badge click triggers updateStore.check() (POST /api/update/check),
 * which overwrites store state with the response — so that mock must also
 * return the full rich state. Bootstrap (/api/update/bootstrap) is a
 * fire-and-forget POST; we acknowledge it with a 200 to avoid a thrown error.
 */
import { test, expect, type Page } from '@playwright/test';

const NOTES_TEXT = '## v0.31.27\n\n### Features\n- Shiny new thing\n- Another improvement';

const STATUS_WITH_NOTES = {
  current_version: 'v0.31.26',
  latest_version: 'v0.31.27',
  has_update: true,
  docker_available: true,
  manifest: {
    version: 'v0.31.27',
    counter: 61,
    released_at: '2026-06-25T00:00:00Z',
    not_after: '2026-09-25T00:00:00Z',
    important: false,
    notes_url: 'https://www.ripperdoc.de/boardripper/changelog.html#v0.31.27',
    notes: NOTES_TEXT,
    tarball: { url_primary: '', sha256: '', size_bytes: 0 },
    image: { registry: '', tag: 'v0.31.27', digest: '' },
  },
};

const STATUS_NO_NOTES = {
  ...STATUS_WITH_NOTES,
  manifest: { ...STATUS_WITH_NOTES.manifest, notes: undefined },
};

/** Register all update-related route mocks before navigation. */
async function mockUpdateRoutes(page: Page, statusPayload: object) {
  const body = JSON.stringify(statusPayload);

  // Bootstrap: fire-and-forget POST called before every update fetch.
  await page.route('**/api/update/bootstrap', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));

  // Status: initial fetch on mount from updateStore.fetchStatus().
  await page.route('**/api/update/status', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body }));

  // Check: POST triggered by badge click (updateStore.check()).
  // Must return the same rich state so the store has notes when the
  // dropdown opens.
  await page.route('**/api/update/check', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body }));
}

/** Click the update badge to open its dropdown, then wait for the dropdown
 *  to be in the DOM. The click fires check() asynchronously; we wait for
 *  the dropdown container to appear rather than sleeping. */
async function openDropdown(page: Page) {
  const badge = page.getByTestId('update-badge');
  await badge.waitFor({ state: 'visible' });
  await badge.click();
  // Wait for the dropdown header to confirm the dropdown rendered.
  await page.locator('.update-dropdown').waitFor({ state: 'visible' });
}

test.describe('update What\'s-new spoiler', () => {

  test('shows the spoiler with notes when manifest.notes is set', async ({ page }) => {
    await mockUpdateRoutes(page, STATUS_WITH_NOTES);
    await page.goto('/');

    await openDropdown(page);

    const spoiler = page.getByTestId('update-whats-new');
    await expect(spoiler).toBeVisible();

    // Geometry check: the spoiler must be within the viewport (not off-screen
    // via position:fixed clip or similar). Allow 1px rounding on right edge.
    const box = await spoiler.boundingBox();
    expect(box, 'spoiler must have a bounding box').not.toBeNull();
    const vp = page.viewportSize()!;
    expect(box!.x, 'left edge ≥ 0').toBeGreaterThanOrEqual(0);
    expect(box!.y, 'top edge ≥ 0').toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width, 'right edge ≤ viewport width').toBeLessThanOrEqual(vp.width + 1);

    // The <details> is collapsed by default — expand it then assert content.
    await spoiler.locator('summary').click();
    await expect(spoiler).toContainText('Shiny new thing');
    await expect(spoiler).toContainText('Another improvement');
  });

  test('no spoiler when manifest has no notes', async ({ page }) => {
    await mockUpdateRoutes(page, STATUS_NO_NOTES);
    await page.goto('/');

    await openDropdown(page);

    // The spoiler element must not exist at all (bodyLines.length === 0).
    await expect(page.getByTestId('update-whats-new')).toHaveCount(0);
  });

});
