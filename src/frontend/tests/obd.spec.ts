import { test, expect } from '@playwright/test';

// OBD (OpenBoardData) integration tests.
//
// Strategy: stub all backend API routes so these tests run without a real
// Go backend.  Navigation follows the same pattern as library-panel.spec.ts:
//   1) goto('/') and wait for .library-tabs-row
//   2) click the "Board #" tab (metadata view) — it shows files grouped by
//      manufacturer → board number → FileRow
//   3) stub /api/databank/files to return one board file with a board_number
//   4) stub /api/databank/files/1 to return the FileDetail
//   5) expand manufacturer node → board-number node → click the FileRow
//      (single-click calls onSelectFile → fetchFileDetail → ObdSection mounts)
//
// ObdSection renders when:
//   - selectedFileDetail is set (file_type=board, board_number set)
//   - AND either indexSynced=true OR matches.length > 0
// So Test A asserts the section is ABSENT, Test B asserts it renders.

const MOCK_FILE = {
  id: 1,
  path: '/data/820-00045.brd',
  filename: '820-00045.brd',
  extension: 'brd',
  file_type: 'board',
  size: 123456,
  mod_time: 1714500000,
  scan_time: 1714500001,
  board_number: '820-00045',
  manufacturer: 'Apple',
  model: 'MacBook Pro',
  format_id: 'BRD',
  part_count: 100,
  net_count: 50,
  donor_pool: false,
  has_preview: false,
  board_manufacturer: 'Apple',
  resolution_status: 'resolved',
};

const MOCK_DETAIL = {
  ...MOCK_FILE,
  bindings: [],
};

const MOCK_STATS = { board_count: 1, pdf_count: 0 };
const MOCK_SCAN_STATUS = {
  running: false, scanned: 1, total: 1, added: 0, updated: 0, deleted: 0,
  errors: 0, duration_ms: 0, pdf_running: false, pdf_scanned: 0, pdf_total: 0,
  pdf_duration_ms: 0, last_file: '', pdf_current: '',
};
const MOCK_CONFIG = { library_dir: '/data', _scan_root: '/data' };

/** Register all backend stubs that the Library panel fetches on mount.
 *
 *  IMPORTANT: Playwright routes are matched in LIFO order (last registered =
 *  highest priority).  Register the catch-all FIRST so specific routes
 *  registered afterwards can shadow it.
 */
async function stubBackend(page: import('@playwright/test').Page) {
  // Catch-all for any other /api/* route the app issues (update/status, etc.)
  // — registered first so it has lowest priority.
  await page.route('**/api/**', route => route.fulfill({ json: {} }));

  // Specific routes — registered after, so they win over the catch-all.
  await page.route('**/api/config', route =>
    route.fulfill({ json: MOCK_CONFIG }));
  await page.route('**/api/databank/scan/status', route =>
    route.fulfill({ json: MOCK_SCAN_STATUS }));
  await page.route('**/api/databank/stats', route =>
    route.fulfill({ json: MOCK_STATS }));
  // files/1 must be registered before files (more specific path wins).
  await page.route('**/api/databank/files/1', route =>
    route.fulfill({ json: MOCK_DETAIL }));
  await page.route('**/api/databank/files', route =>
    route.fulfill({ json: [MOCK_FILE] }));
}

/** Navigate to Library panel and switch to the "Board #" (metadata) tab.
 *  Then expand the manufacturer node and board-number node so the FileRow
 *  becomes visible.  Returns without clicking the file row itself. */
async function navigateToMetadataTab(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.waitForSelector('.library-tabs-row');

  // Switch to Board # (metadata) view — matches the tab label used in the
  // existing library-panel.spec.ts: `{ hasText: 'Board #' }`.
  await page.locator('.library-tab', { hasText: 'Board #' }).click();

  // Wait for the file list to be populated (the stubbed /api/databank/files
  // response) and the manufacturer group node to appear.
  await page.waitForSelector('.library-tree-mfr');

  // Expand manufacturer node (Apple).
  await page.locator('.library-tree-mfr', { hasText: 'Apple' }).click();

  // Expand board-number node (820-00045).
  await page.locator('.library-tree-board-num', { hasText: '820-00045' }).click();
}

// ─────────────────────────────────────────────────────────────────────────────
// Test A: OBD section hidden when index is not synced and no matches
// ─────────────────────────────────────────────────────────────────────────────
test('OBD section is hidden when index is not synced', async ({ page }) => {
  await stubBackend(page);

  // OBD match returns no matches + unsynced index.
  await page.route('**/api/obd/match**', route =>
    route.fulfill({
      json: {
        matches: [],
        index: { synced: false, board_count: 0 },
      },
    }),
  );

  await navigateToMetadataTab(page);

  // Click the file row (single-click → onSelectFile → fetchFileDetail).
  await page.locator('.library-file-row', { hasText: '820-00045.brd' }).click();

  // Wait for FileDetailPane to appear (board_number text is rendered inside it).
  await page.waitForSelector('text=Board: 820-00045');

  // ObdSection must NOT render when index is unsynced and matches is empty.
  await expect(page.getByTestId('obd-section')).toHaveCount(0);
});

// ─────────────────────────────────────────────────────────────────────────────
// Test B: OBD chip + table render after fetch
// ─────────────────────────────────────────────────────────────────────────────
test('OBD chip and measurement table render after fetch', async ({ page }) => {
  await stubBackend(page);

  const BPATH = 'laptops/apple/820-00045';

  // OBD match returns one match + synced index.
  await page.route('**/api/obd/match**', route =>
    route.fulfill({
      json: {
        matches: [
          {
            bpath: BPATH,
            brand: 'apple',
            category: 'laptops',
            fetched: false,
            fetched_at: null,
          },
        ],
        index: {
          synced: true,
          synced_at: '2026-05-01T00:00:00Z',
          board_count: 1,
        },
      },
    }),
  );

  // OBD fetch returns parsed ObdData with one net.
  await page.route('**/api/obd/fetch**', route =>
    route.fulfill({
      json: {
        bpath: BPATH,
        source_url: `https://openboarddata.org/data/${BPATH}.obdata`,
        fetched_at: '2026-05-01T00:00:00Z',
        header: {
          timestamp: '2026-05-01',
          id: '820-00045',
          brand: 'apple',
          category: 'laptops',
          comment: null,
        },
        diagnosis: '',
        components: [],
        nets: [
          {
            name: 'PP3V3_S0_REG',
            qualifier: 'Default',
            diode: '0.450',
            voltage: '3.30',
            resistance: null,
            aliases: [],
            comments: [],
          },
        ],
      } satisfies import('../src/store/obd-store').ObdData,
    }),
  );

  await navigateToMetadataTab(page);

  // Click the file row to select it and trigger fetchFileDetail.
  await page.locator('.library-file-row', { hasText: '820-00045.brd' }).click();

  // Wait for FileDetailPane.
  await page.waitForSelector('text=Board: 820-00045');

  // OBD section must be visible (index is synced, matches present).
  await expect(page.getByTestId('obd-section')).toBeVisible();

  // Click the chip to fetch OBD data (POST /api/obd/fetch).
  await page.getByTestId('obd-chip-820-00045').click();

  // After fetch completes, the measurement table must appear and contain the net.
  const table = page.getByTestId('obd-table');
  await expect(table).toBeVisible();
  await expect(table).toContainText('PP3V3_S0_REG');
});
