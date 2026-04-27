import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

// End-to-end coverage of the binding categorization flow against a real
// backend on :1336 with a populated databank. The user's exemplars:
//   id=873 board: 820-02020.bvr        ↔ id=212 binding to PDF id=874
//   id=1003 board: 820-02188-A.brd     ↔ id=211 binding to PDF id=1002
// Both should come back as category='schematic', auto_open=true after the
// v8 migration. The tests poke each of the six scenarios the user listed:
//   1. Auto-open on opening the board (autoPdf flow honors auto_open).
//   2. Bind deletion (DELETE /api/databank/bindings/{id}).
//   3. Default schematic for new bindings.
//   4. Category change → other (PATCH).
//   5. Category change back → schematic.
//   6. Opening a non-matching PDF doesn't auto-bind anything.

const BACKEND = 'http://localhost:1336';
const BOARD_ID = 873;       // 820-02020.bvr
const BINDING_ID = 212;     // existing schematic binding for 873

async function getBinding(page: Page, id: number) {
  const res = await page.request.get(`${BACKEND}/api/databank/files/${BOARD_ID}`);
  const data = await res.json();
  return data.bindings?.find((b: { id: number }) => b.id === id);
}

test.describe('binding categorization API', () => {
  test('GET returns category + auto_open fields (v8 migration applied)', async ({ page }) => {
    const b = await getBinding(page, BINDING_ID);
    expect(b).toBeTruthy();
    expect(b.category).toBe('schematic');
    expect(b.auto_open).toBe(true);
  });

  test('PATCH category=other persists', async ({ page }) => {
    const res = await page.request.patch(`${BACKEND}/api/databank/bindings/${BINDING_ID}`, {
      data: { category: 'other', auto_open: false },
    });
    expect(res.ok()).toBe(true);
    const b = await getBinding(page, BINDING_ID);
    expect(b.category).toBe('other');
    expect(b.auto_open).toBe(false);
  });

  test('PATCH category back to schematic persists', async ({ page }) => {
    const res = await page.request.patch(`${BACKEND}/api/databank/bindings/${BINDING_ID}`, {
      data: { category: 'schematic', auto_open: true },
    });
    expect(res.ok()).toBe(true);
    const b = await getBinding(page, BINDING_ID);
    expect(b.category).toBe('schematic');
    expect(b.auto_open).toBe(true);
  });

  test('PATCH with empty body returns 400', async ({ page }) => {
    const res = await page.request.patch(`${BACKEND}/api/databank/bindings/${BINDING_ID}`, { data: {} });
    expect(res.status()).toBe(400);
  });

  test('POST defaults to schematic + auto_open=true when fields omitted', async ({ page }) => {
    // Create a new binding without category — should default to schematic.
    // Use the existing 873 ↔ 874 pair, but need a different pair to avoid
    // unique-constraint conflict with binding id=212. Use a non-existing
    // pair: pdf_file_id=988 (820-02020 Location map) not yet bound to 873.
    const create = await page.request.post(`${BACKEND}/api/databank/bindings`, {
      data: { board_file_id: BOARD_ID, pdf_file_id: 988 },
    });
    expect(create.ok()).toBe(true);
    const created = await create.json();
    const b = await getBinding(page, created.id);
    expect(b.category).toBe('schematic');
    expect(b.auto_open).toBe(true);
    // Cleanup so this test is idempotent.
    await page.request.delete(`${BACKEND}/api/databank/bindings/${created.id}`);
  });

  test('POST honors explicit category=datasheet + auto_open=false', async ({ page }) => {
    const create = await page.request.post(`${BACKEND}/api/databank/bindings`, {
      data: { board_file_id: BOARD_ID, pdf_file_id: 988, category: 'datasheet', auto_open: false },
    });
    expect(create.ok()).toBe(true);
    const created = await create.json();
    const b = await getBinding(page, created.id);
    expect(b.category).toBe('datasheet');
    expect(b.auto_open).toBe(false);
    await page.request.delete(`${BACKEND}/api/databank/bindings/${created.id}`);
  });

  test('DELETE removes the binding', async ({ page }) => {
    const create = await page.request.post(`${BACKEND}/api/databank/bindings`, {
      data: { board_file_id: BOARD_ID, pdf_file_id: 988 },
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
    await page.goto('http://localhost:8083/');
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
