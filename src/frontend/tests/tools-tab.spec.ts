import { test, expect } from '@playwright/test';

test.describe('Tools tab', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('Tools tab opens a calculator and returns via back', async ({ page }) => {
    // Open the Tools sidebar tab (button rendered from the TABS registry).
    await page.getByRole('button', { name: 'Tools', exact: true }).click();

    // Landing list shows the three calculators.
    await expect(page.getByTestId('tools-entry-resistor')).toBeVisible();
    await expect(page.getByTestId('tools-entry-smd')).toBeVisible();
    await expect(page.getByTestId('tools-entry-capacitor')).toBeVisible();

    // Open the SMD decoder and check a known readout (103 → 10 kΩ).
    await page.getByTestId('tools-entry-smd').click();
    const smdInput = page.getByTestId('smd-input');
    await smdInput.fill('103');
    await expect(page.getByTestId('smd-readout')).toContainText('10 kΩ');
    await smdInput.fill('4R7');
    await expect(page.getByTestId('smd-readout')).toContainText('4.7 Ω');

    // Back returns to the landing list.
    await page.getByTestId('tools-back').click();
    await expect(page.getByTestId('tools-entry-smd')).toBeVisible();
  });

  test('capacitor converter converts live across pF / nF / µF', async ({ page }) => {
    await page.getByRole('button', { name: 'Tools', exact: true }).click();
    await page.getByTestId('tools-entry-capacitor').click();
    // Type 100 nF → the other two units convert live.
    await page.getByTestId('cap-nf').fill('100');
    await expect(page.getByTestId('cap-pf')).toHaveValue('100000');
    await expect(page.getByTestId('cap-uf')).toHaveValue('0.1');
    // And the reverse direction: 1 µF → 1000 nF.
    await page.getByTestId('cap-uf').fill('1');
    await expect(page.getByTestId('cap-nf')).toHaveValue('1000');
  });

  test('resistor color-band shows a live readout', async ({ page }) => {
    await page.getByRole('button', { name: 'Tools', exact: true }).click();
    await page.getByTestId('tools-entry-resistor').click();
    // Default 4-band is brown-black-red-gold → 1 kΩ.
    await expect(page.getByTestId('rc-readout')).toContainText('1 kΩ');
  });

  test('Worklists catalog opens and renders its empty state', async ({ page }) => {
    await page.getByRole('button', { name: 'Tools', exact: true }).click();
    await page.getByTestId('tools-entry-worklists').click();
    // The catalog mounts regardless of whether any worklists are stored.
    await expect(page.getByTestId('tools-worklists')).toBeVisible();
    // With a clean profile there are no stored worklists.
    await expect(page.getByTestId('tools-worklists')).toContainText(/Worklists \(\d+\)/);
    // Back returns to the landing list.
    await page.getByTestId('tools-back').click();
    await expect(page.getByTestId('tools-entry-worklists')).toBeVisible();
  });
});
