import { test, expect } from '@playwright/test';
import fs from 'fs';

// Interactive Mode popup regression: the popup used to be mounted once per
// BoardViewerPanel. Every open board tab keeps a panel mounted, so N boards
// meant N popups portaled onto document.body — each with its own document
// mousedown "clicked outside → close" listener. Pressing a slider inside one
// popup is "outside" the others, so they called close() on the SHARED store
// and the whole popup vanished the moment you touched a handle.
const A = '/Users/besitzer/Desktop/Boardviewer/samples/820-02016/820-02016.bvr';
const B = '/Users/besitzer/Desktop/Boardviewer/samples/820-00165/820-00165.brd';

test('the resize popup survives using its handles with several boards open', async ({ page }) => {
  test.skip(!fs.existsSync(A) || !fs.existsSync(B), 'sample boards not present');

  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles(A);
  await expect(page.getByTestId('statusbar')).toContainText('Components:', { timeout: 60000 });
  await page.getByTestId('file-input').setInputFiles(B);
  await expect
    .poll(() => page.evaluate(() => (window as any).__boardStore.tabs.length), { timeout: 60000 })
    .toBe(2);

  await page.evaluate(() => {
    (window as any).__resizeModeStore.setEnabled(true);
    (window as any).__resizeModeStore.openGroup('pin', 300, 200, 'pin');
  });

  // Exactly one popup, however many boards are open.
  const popup = page.getByTestId('resize-popup');
  await expect(popup).toHaveCount(1);

  const popupOpen = () =>
    page.evaluate(() => !!(window as any).__resizeModeStore.snapshot().popup);
  const firstValue = () =>
    page.evaluate(() => (window as any).__resizeModeStore.valueOf('pinSizeScale'));

  // Dragging a slider handle edits the setting and keeps the popup open.
  const before = await firstValue();
  const slider = popup.locator('input[type=range]').first();
  const box = (await slider.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.75, box.y + box.height / 2);
  await page.mouse.up();
  await page.waitForTimeout(200);

  expect(await popupOpen(), 'popup must stay open while its handle is used').toBe(true);
  expect(await firstValue(), 'the drag must have changed the setting').not.toBe(before);

  // The +/− buttons are the same story (they are also inside the popup).
  await popup.getByTitle(/^\+/).first().click();
  await page.waitForTimeout(150);
  expect(await popupOpen(), 'popup must stay open after a nudge button').toBe(true);

  // A press genuinely outside still closes it.
  await page.mouse.click(5, 5);
  await page.waitForTimeout(150);
  expect(await popupOpen(), 'an outside click still closes the popup').toBe(false);
});
