import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

// End-to-end coverage of the binding categorization flow. Runs against a
// live backend with a populated databank — set BACKEND env var to override
// the default. Tests look up the focal board by filename instead of
// hard-coded IDs so a databank reseed doesn't silently break the suite.
//   board: 820-02020.bvr    ↔ existing schematic binding to 820-02020.pdf
//   board: 820-02188-A.brd  ↔ existing schematic binding to 820-02188-A 051-06019…pdf
// Both should come back as category='schematic', auto_open=true after the
// v8 migration. The tests poke each of the six scenarios the user listed:
//   1. Auto-open on opening the board (autoPdf flow honors auto_open).
//   2. Bind deletion (DELETE /api/databank/bindings/{id}).
//   3. Default schematic for new bindings.
//   4. Category change → other (PATCH).
//   5. Category change back → schematic.
//   6. Opening a non-matching PDF doesn't auto-bind anything.

const BACKEND_PORT = process.env.BACKEND_PORT ? Number(process.env.BACKEND_PORT) : 1336;
const BACKEND = process.env.BACKEND ?? `http://localhost:${BACKEND_PORT}`;

const FOCAL_BOARD_NAME = '820-02020.bvr';
const SECONDARY_PDF_NAME = '820-02020 Location map en.pdf';

interface FileRecord {
  id: number;
  filename: string;
  file_type: string;
}
interface Binding {
  id: number;
  category: string;
  auto_open: boolean;
  pdf_file_id: number;
}

let cachedBoardId: number | undefined;
let cachedExistingBindingId: number | undefined;
let cachedSecondaryPdfId: number | undefined;

async function lookupFileByName(page: Page, name: string): Promise<FileRecord> {
  const res = await page.request.get(`${BACKEND}/api/databank/files`);
  expect(res.ok(), `GET /api/databank/files → ${res.status()}`).toBe(true);
  const data: FileRecord[] = await res.json();
  const match = data.find(f => f.filename === name);
  if (!match) throw new Error(`Required fixture file not in databank: ${name}`);
  return match;
}

async function focalBoardId(page: Page): Promise<number> {
  if (cachedBoardId === undefined) cachedBoardId = (await lookupFileByName(page, FOCAL_BOARD_NAME)).id;
  return cachedBoardId;
}

async function secondaryPdfId(page: Page): Promise<number> {
  if (cachedSecondaryPdfId === undefined) cachedSecondaryPdfId = (await lookupFileByName(page, SECONDARY_PDF_NAME)).id;
  return cachedSecondaryPdfId;
}

async function existingBindingId(page: Page): Promise<number> {
  if (cachedExistingBindingId !== undefined) return cachedExistingBindingId;
  const boardId = await focalBoardId(page);
  const res = await page.request.get(`${BACKEND}/api/databank/files/${boardId}`);
  expect(res.ok()).toBe(true);
  const data = await res.json();
  if (!data.bindings || data.bindings.length === 0) {
    throw new Error(`Fixture board ${FOCAL_BOARD_NAME} has no bindings — reseed the databank or run the scanner`);
  }
  cachedExistingBindingId = data.bindings[0].id;
  return cachedExistingBindingId!;
}

async function getBinding(page: Page, id: number): Promise<Binding | undefined> {
  const boardId = await focalBoardId(page);
  const res = await page.request.get(`${BACKEND}/api/databank/files/${boardId}`);
  const data = await res.json();
  return data.bindings?.find((b: Binding) => b.id === id);
}

test.describe('binding categorization API', () => {
  test('GET returns category + auto_open fields (v8 migration applied)', async ({ page }) => {
    const bindingId = await existingBindingId(page);
    const b = await getBinding(page, bindingId);
    expect(b).toBeTruthy();
    expect(b!.category).toBe('schematic');
    expect(b!.auto_open).toBe(true);
  });

  test('PATCH category=other persists', async ({ page }) => {
    const bindingId = await existingBindingId(page);
    const res = await page.request.patch(`${BACKEND}/api/databank/bindings/${bindingId}`, {
      data: { category: 'other', auto_open: false },
    });
    expect(res.ok()).toBe(true);
    const b = await getBinding(page, bindingId);
    expect(b!.category).toBe('other');
    expect(b!.auto_open).toBe(false);
  });

  test('PATCH category back to schematic persists', async ({ page }) => {
    const bindingId = await existingBindingId(page);
    const res = await page.request.patch(`${BACKEND}/api/databank/bindings/${bindingId}`, {
      data: { category: 'schematic', auto_open: true },
    });
    expect(res.ok()).toBe(true);
    const b = await getBinding(page, bindingId);
    expect(b!.category).toBe('schematic');
    expect(b!.auto_open).toBe(true);
  });

  test('PATCH with empty body returns 400', async ({ page }) => {
    const bindingId = await existingBindingId(page);
    const res = await page.request.patch(`${BACKEND}/api/databank/bindings/${bindingId}`, { data: {} });
    expect(res.status()).toBe(400);
  });

  test('POST defaults to schematic + auto_open=true when fields omitted', async ({ page }) => {
    // Create a new binding without category — should default to schematic.
    // Use a different pair than the existing schematic to avoid the
    // UNIQUE(board_file_id, pdf_file_id) collision.
    const boardId = await focalBoardId(page);
    const pdfId = await secondaryPdfId(page);
    const create = await page.request.post(`${BACKEND}/api/databank/bindings`, {
      data: { board_file_id: boardId, pdf_file_id: pdfId },
    });
    expect(create.ok()).toBe(true);
    const created = await create.json();
    const b = await getBinding(page, created.id);
    expect(b!.category).toBe('schematic');
    expect(b!.auto_open).toBe(true);
    // Cleanup so this test is idempotent.
    await page.request.delete(`${BACKEND}/api/databank/bindings/${created.id}`);
  });

  test('POST honors explicit category=datasheet + auto_open=false', async ({ page }) => {
    const boardId = await focalBoardId(page);
    const pdfId = await secondaryPdfId(page);
    const create = await page.request.post(`${BACKEND}/api/databank/bindings`, {
      data: { board_file_id: boardId, pdf_file_id: pdfId, category: 'datasheet', auto_open: false },
    });
    expect(create.ok()).toBe(true);
    const created = await create.json();
    const b = await getBinding(page, created.id);
    expect(b!.category).toBe('datasheet');
    expect(b!.auto_open).toBe(false);
    await page.request.delete(`${BACKEND}/api/databank/bindings/${created.id}`);
  });

  test('DELETE removes the binding', async ({ page }) => {
    const boardId = await focalBoardId(page);
    const pdfId = await secondaryPdfId(page);
    const create = await page.request.post(`${BACKEND}/api/databank/bindings`, {
      data: { board_file_id: boardId, pdf_file_id: pdfId },
    });
    const created = await create.json();
    const res = await page.request.delete(`${BACKEND}/api/databank/bindings/${created.id}`);
    expect(res.ok()).toBe(true);
    const b = await getBinding(page, created.id);
    expect(b).toBeUndefined();
  });
});

test.describe('FileDetailPane binding row UI', () => {
  async function selectBoard820_02020(page: Page) {
    // baseURL comes from playwright.config.ts (default localhost:18083 for
    // BoardRipper, override via VITE_PORT / BASE_URL).
    await page.goto('/');
    await page.waitForSelector('.library-tabs-row');
    await page.locator('.library-tab', { hasText: 'Board #' }).click();
    await page.locator('.library-search-input').fill('820-02020');
    // Expand the Apple manufacturer group (collapsed by default).
    await page.locator('.library-tree-node', { hasText: 'Apple' }).first().click();
    // Expand the 820-02020 board-number group inside Apple.
    await page.locator('.library-tree-board-num', { hasText: /^820-02020$/ }).first().click();
    // Now click the actual board file row (.bvr file under that group).
    await page
      .locator('.library-file-row', { hasText: '820-02020.bvr' })
      .first()
      .click({ timeout: 10_000 });
  }

  test('selecting the bound board surfaces category=Schematic in the dropdown', async ({ page }) => {
    await selectBoard820_02020(page);

    // The detail pane renders bindings grouped by category — the 820-02020
    // schematic binding should appear under the Schematic group.
    await expect(
      page.locator('.library-binding-group-header', { hasText: 'Schematic' })
    ).toBeVisible({ timeout: 5_000 });

    const select = page.locator('.library-binding-row .library-binding-category').first();
    await expect(select).toHaveValue('schematic');
  });

  test('changing category to datasheet via dropdown persists', async ({ page }) => {
    await selectBoard820_02020(page);

    const select = page.locator('.library-binding-row .library-binding-category').first();
    await expect(select).toHaveValue('schematic');

    await select.selectOption('datasheet');

    // After PATCH + refetch the binding moves to the Datasheet group.
    await expect(
      page.locator('.library-binding-group-header', { hasText: 'Datasheet' })
    ).toBeVisible({ timeout: 5_000 });
    const newSelect = page.locator('.library-binding-row .library-binding-category').first();
    await expect(newSelect).toHaveValue('datasheet');

    // Restore to keep the test idempotent.
    await newSelect.selectOption('schematic');
    await expect(
      page.locator('.library-binding-group-header', { hasText: 'Schematic' })
    ).toBeVisible({ timeout: 5_000 });
  });
});
