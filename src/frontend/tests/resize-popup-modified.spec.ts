import { test, expect } from '@playwright/test';

// Interactive Mode's handles write GLOBAL, persisted settings. A drag used to
// leave no trace: nothing said a value had moved, and the only undo was an
// undiscoverable double-click — so a stray drag read as a rendering bug.
// A changed row must say so and offer its own way back.

test('a changed handle is marked and can be put back', async ({ page }) => {
  // Tall enough that the pin group's eight rows plus the footer fit — the
  // popup scrolls internally otherwise and the footer sits below the fold.
  await page.setViewportSize({ width: 1200, height: 1000 });
  await page.goto('/');
  await page.evaluate(() => {
    (window as any).__resizeModeStore.setEnabled(true);
    (window as any).__resizeModeStore.openGroup('pin', 300, 200, 'pin');
  });

  const popup = page.getByTestId('resize-popup');
  await expect(popup).toBeVisible();

  // Nothing touched yet: no markers, and "Reset all" is inert.
  await expect(popup.getByTestId('resize-modified-dot')).toHaveCount(0);
  await expect(popup.getByTestId('resize-row-reset')).toHaveCount(0);
  await expect(popup.getByTestId('resize-reset-all')).toBeDisabled();
  await expect(popup).toContainText('Saved for every board');

  // Move the first handle the way a stray drag would.
  const before = await page.evaluate(() => (window as any).__resizeModeStore.valueOf('pinSizeScale'));
  const slider = popup.locator('input[type=range]').first();
  const box = (await slider.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height / 2);
  await page.mouse.up();

  const after = await page.evaluate(() => (window as any).__resizeModeStore.valueOf('pinSizeScale'));
  expect(after).not.toBe(before);

  // It now says so, in three places.
  await expect(popup.getByTestId('resize-modified-dot').first()).toBeVisible();
  await expect(popup.getByTestId('resize-row-reset').first()).toBeVisible();
  await expect(popup.getByTestId('resize-reset-all')).toBeEnabled();
  await expect(popup).toContainText('Changed — saved for every board');

  // And one click puts the whole group back.
  await popup.getByTestId('resize-reset-all').click();
  expect(await page.evaluate(() => (window as any).__resizeModeStore.valueOf('pinSizeScale'))).toBe(before);
  await expect(popup.getByTestId('resize-modified-dot')).toHaveCount(0);
  await expect(popup.getByTestId('resize-reset-all')).toBeDisabled();
});

test('the per-row ⟲ resets only its own handle', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 1000 });
  await page.goto('/');
  await page.evaluate(() => {
    const st = (window as any).__resizeModeStore;
    st.setEnabled(true);
    st.openGroup('pin', 300, 200, 'pin');
    st.commit('pinSizeScale', 2);
    st.commit('pinNumberScale', 2);
  });
  const popup = page.getByTestId('resize-popup');
  await expect(popup.getByTestId('resize-row-reset')).toHaveCount(2);

  await popup.getByTestId('resize-row-reset').first().click();
  const vals = await page.evaluate(() => ({
    size: (window as any).__resizeModeStore.valueOf('pinSizeScale'),
    num: (window as any).__resizeModeStore.valueOf('pinNumberScale'),
  }));
  expect(vals.size).toBe(1);   // reset
  expect(vals.num).toBe(2);    // untouched
  await expect(popup.getByTestId('resize-row-reset')).toHaveCount(1);

  // Leave global settings as we found them.
  await page.evaluate(() => (window as any).__resizeModeStore.resetKeys(['pinNumberScale']));
});
