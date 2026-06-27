import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname2 = path.dirname(fileURLToPath(import.meta.url));
const BRD = path.resolve(__dirname2, '../../../samples/820-02935-05 Kopie.brd');
const haveBrd = fs.existsSync(BRD);

// Store-level tests drive the DEV-exposed worklist store directly (no board UI).
test('NetMeasurement type + units table exist', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('toolbar')).toBeVisible({ timeout: 10000 });
  const units = await page.evaluate(() => {
    // @ts-expect-error DEV global
    return window.__worklistStore?.NET_MEASUREMENT_UNITS_PROBE?.();
  });
  expect(units).toEqual({ voltage: 'V', diode: 'V', resistance: 'Ω' });
});

test('migration: legacy net-targeted measurement moves onto the net row; part target → relay', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('toolbar')).toBeVisible({ timeout: 10000 });
  const out = await page.evaluate(() => {
    // @ts-expect-error DEV global
    const ws = window.__worklistStore;
    const w = {
      id: 'w1', name: 't', createdAt: 1, entries: [{ refdes: 'D4200', mark: 'none', note: '' }],
      netEntries: [{ netName: 'PPBUS_AON', mark: 'none', note: '' }],
      measurements: [
        { id: 'm1', target: 'PPBUS_AON', kind: 'voltage', prompt: 'measure', value: '12.4', unit: 'V', status: 'answered', source: 'agent', requestedAt: 1, answeredAt: 2 },
        { id: 'm2', target: 'D4200', kind: 'diode', prompt: 'diode drop?', status: 'pending', source: 'agent', requestedAt: 1 },
      ],
    };
    ws.MIGRATE_PROBE(w);
    return { net: w.netEntries[0].measurements?.voltage, msgs: (w.messages ?? []).length, hasArray: 'measurements' in w };
  });
  expect(out.net).toMatchObject({ kind: 'voltage', value: '12.4', unit: 'V', status: 'recorded', source: 'agent' });
  expect(out.msgs).toBe(1);        // D4200 (part) → relay message
  expect(out.hasArray).toBe(false); // array deleted
});

test('store: user records a net measurement; agent requests one; clear removes it', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('toolbar')).toBeVisible({ timeout: 10000 });
  const out = await page.evaluate(() => {
    // @ts-expect-error DEV global
    const ws = window.__worklistStore;
    const id = ws.TEST_NEW_WORKLIST('case');     // helper below
    ws.setNetMeasurement(id, 'PP3V3', 'resistance', '47', 'Ω');
    ws.requestNetMeasurement('PPBUS', { kind: 'voltage', prompt: 'main rail?' });
    const snap = ws.aiSnapshot();
    ws.clearNetMeasurement(id, 'PP3V3', 'resistance');
    const after = ws.aiSnapshot();
    return { snap, afterHasPP3V3Meas: (after.netEntries.find((n: any) => n.netName === 'PP3V3')?.measurements?.length ?? 0) > 0 };
  });
  const pp3v3 = out.snap.netEntries.find((n: any) => n.netName === 'PP3V3');
  const ppbus = out.snap.netEntries.find((n: any) => n.netName === 'PPBUS');
  expect(pp3v3.measurements[0]).toMatchObject({ kind: 'resistance', value: '47', unit: 'Ω', status: 'recorded', source: 'user' });
  expect(ppbus.measurements[0]).toMatchObject({ kind: 'voltage', status: 'requested', source: 'agent' });
  expect('measurements' in out.snap).toBe(false);
  expect(out.afterHasPP3V3Meas).toBe(false);
});

test('bidirectional: user reading is visible via aiSnapshot with source user', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('toolbar')).toBeVisible({ timeout: 10000 });
  const found = await page.evaluate(() => {
    // @ts-expect-error DEV global
    const ws = window.__worklistStore;
    const id = ws.TEST_NEW_WORKLIST('c');
    ws.setNetMeasurement(id, 'PP1V8', 'voltage', '1.79');
    const snap = ws.aiSnapshot();
    const n = snap.netEntries.find((x: any) => x.netName === 'PP1V8');
    return n?.measurements?.[0]?.source;
  });
  expect(found).toBe('user');
});

test('highlight: worklist outlines only when toggle on; button relabeled', async ({ page }) => {
  test.skip(!haveBrd, 'sample brd missing');
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles(BRD);
  await expect(page.locator('.dv-tab', { hasText: '.brd' }).first()).toBeVisible({ timeout: 15000 });
  // Wait for board parse to complete before touching the store.
  await page.waitForFunction(() => !!(window as any).__boardStore?.board, { timeout: 20000 });
  // Create a worklist and add the first board part (index 0 always exists).
  await page.evaluate(() => {
    /* @ts-expect-error */
    const ws = window.__worklistStore;
    const wl = ws.createWorklist('Test');
    if (wl) ws.pushParts(wl.id, [0]);
  });
  await page.locator('.board-sidebar-toggle').first().click();
  await page.locator('.board-sidebar-tab', { hasText: 'Worklist' }).click();
  const btn = page.getByRole('button', { name: 'Highlight' });
  await expect(btn).toBeVisible();
  const on = await page.evaluate(() => { /* @ts-expect-error */ return window.__boardStore.connectionHighlight; });
  expect(on).toBe(false); // off by default
  await btn.click();
  const on2 = await page.evaluate(() => { /* @ts-expect-error */ return window.__boardStore.connectionHighlight; });
  expect(on2).toBe(true);
});

test('net row: records V + diode + Ω independently (three values coexist)', async ({ page }) => {
  test.skip(!haveBrd, 'sample brd missing');
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles(BRD);
  await expect(page.locator('.dv-tab', { hasText: '.brd' }).first()).toBeVisible({ timeout: 15000 });
  // Wait for board data to be in the store (parse completes after tab appears).
  await page.waitForFunction(() => !!(window as any).__boardStore?.board, { timeout: 20000 });
  // Seed a net entry via the store, open the worklist tab.
  await page.evaluate(() => {
    // @ts-expect-error DEV global
    const ws = window.__worklistStore;
    const r = ws.pushNetToActive('GND');   // existing API; auto-creates worklist
    return r;
  });
  await page.locator('.board-sidebar-toggle').first().click();
  await page.locator('.board-sidebar-tab', { hasText: 'Worklist' }).click();
  const netRow = page.locator('[data-testid="worklist-net-row"]', { hasText: 'GND' }).first();
  await expect(netRow).toBeVisible();
  // Fill all three slots independently — they coexist (no type switch).
  const vIn = netRow.locator('[data-testid="net-meas-input-voltage"]');
  const dIn = netRow.locator('[data-testid="net-meas-input-diode"]');
  const rIn = netRow.locator('[data-testid="net-meas-input-resistance"]');
  await vIn.fill('12.6'); await vIn.blur();
  await dIn.fill('0.5'); await dIn.blur();
  await rIn.fill('47'); await rIn.blur();
  await expect(vIn).toHaveValue('12.6');
  await expect(dIn).toHaveValue('0.5');
  await expect(rIn).toHaveValue('47');
  const stored = await page.evaluate(() => {
    // @ts-expect-error DEV global
    return window.__worklistStore.aiSnapshot().netEntries
      .find((x: any) => x.netName === 'GND').measurements.map((m: any) => `${m.kind}:${m.value}`).sort();
  });
  expect(stored).toEqual(['diode:0.5', 'resistance:47', 'voltage:12.6']);
});

test('net row: diode chip shows the circuit-diode icon, not the word "Diode"', async ({ page }) => {
  test.skip(!haveBrd, 'sample brd missing');
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles(BRD);
  await expect(page.locator('.dv-tab', { hasText: '.brd' }).first()).toBeVisible({ timeout: 15000 });
  await page.waitForFunction(() => !!(window as any).__boardStore?.board, { timeout: 20000 });
  await page.evaluate(() => {
    // @ts-expect-error DEV global
    window.__worklistStore.pushNetToActive('GND');
  });
  await page.locator('.board-sidebar-toggle').first().click();
  await page.locator('.board-sidebar-tab', { hasText: 'Worklist' }).click();
  const netRow = page.locator('[data-testid="worklist-net-row"]', { hasText: 'GND' }).first();
  await expect(netRow).toBeVisible();
  const diodeChip = netRow.locator('[data-testid="net-meas-chip-diode"]');
  await expect(diodeChip.locator('svg.tabler-icon-circuit-diode')).toBeVisible();
  await expect(diodeChip).not.toContainText('Diode');
  await expect(netRow.locator('[data-testid="net-meas-chip-voltage"]')).toHaveText('V');
  await expect(netRow.locator('[data-testid="net-meas-chip-resistance"]')).toHaveText('Ω');
});
