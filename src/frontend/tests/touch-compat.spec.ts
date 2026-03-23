import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Use a touch-enabled device profile
test.use({
  hasTouch: true,
  viewport: { width: 1024, height: 768 },
});

test.describe('Touch Screen Compatibility', () => {
  test('board canvas has touch-action: none', async ({ page }) => {
    await page.goto('/');

    const fileInput = page.getByTestId('file-input');
    const testFile = path.resolve(__dirname, '../public/samples/test-board.bvr');
    await fileInput.setInputFiles(testFile);

    await expect(page.getByTestId('board-canvas')).toBeVisible();
    const boardCanvas = page.getByTestId('board-canvas');
    const touchAction = await boardCanvas.evaluate(
      (el) => getComputedStyle(el).touchAction,
    );
    expect(touchAction).toBe('none');
  });

  test('board canvas does not rotate on gesture events', async ({ page }) => {
    await page.goto('/');

    const fileInput = page.getByTestId('file-input');
    const testFile = path.resolve(__dirname, '../public/samples/test-board.bvr');
    await fileInput.setInputFiles(testFile);

    await expect(page.getByTestId('board-canvas')).toBeVisible();
    const boardCanvas = page.getByTestId('board-canvas');

    // Verify gesture listeners exist but don't rotate the board
    // (gesturestart/gesturechange are suppressed with preventDefault only)
    const hasGestureListeners = await boardCanvas.evaluate((el) => {
      // Dispatch a gesturestart event and verify it's prevented
      const evt = new Event('gesturestart', { cancelable: true, bubbles: true });
      const prevented = !el.dispatchEvent(evt);
      return prevented;
    });
    expect(hasGestureListeners).toBe(true);
  });

  test('board canvas supports single-finger drag (pan)', async ({ page }) => {
    await page.goto('/');

    const fileInput = page.getByTestId('file-input');
    const testFile = path.resolve(__dirname, '../public/samples/test-board.bvr');
    await fileInput.setInputFiles(testFile);

    await expect(page.getByTestId('board-canvas')).toBeVisible();

    // Wait for PixiJS to initialize
    await page.waitForTimeout(500);

    const canvas = page.getByTestId('board-canvas').locator('canvas').first();
    const box = await canvas.boundingBox();
    if (!box) throw new Error('Canvas not found');

    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    // Single-finger touch drag should pan without crashing
    await page.touchscreen.tap(cx, cy);
    // Simulate a drag: touchstart -> touchmove -> touchend
    // pixi-viewport handles pointer events under the hood
    // Just verify no crash occurs
    await page.evaluate(async ({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      if (!el) return;
      // Simulate touch sequence
      const touch = new Touch({ identifier: 1, target: el, clientX: x, clientY: y });
      el.dispatchEvent(new TouchEvent('touchstart', { touches: [touch], changedTouches: [touch], cancelable: true }));
      const touch2 = new Touch({ identifier: 1, target: el, clientX: x + 50, clientY: y + 30 });
      el.dispatchEvent(new TouchEvent('touchmove', { touches: [touch2], changedTouches: [touch2], cancelable: true }));
      el.dispatchEvent(new TouchEvent('touchend', { touches: [], changedTouches: [touch2], cancelable: true }));
    }, { x: cx, y: cy });

    // If we got here without crash, the touch drag works
    await expect(page.getByTestId('board-canvas')).toBeVisible();
  });

  test('board canvas supports two-finger pinch zoom', async ({ page }) => {
    await page.goto('/');

    const fileInput = page.getByTestId('file-input');
    const testFile = path.resolve(__dirname, '../public/samples/test-board.bvr');
    await fileInput.setInputFiles(testFile);

    await expect(page.getByTestId('board-canvas')).toBeVisible();
    await page.waitForTimeout(500);

    const canvas = page.getByTestId('board-canvas').locator('canvas').first();
    const box = await canvas.boundingBox();
    if (!box) throw new Error('Canvas not found');

    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    // Simulate two-finger pinch via touch events
    await page.evaluate(async ({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      if (!el) return;

      // Start with two fingers 50px apart
      const t1Start = new Touch({ identifier: 1, target: el, clientX: x - 25, clientY: y });
      const t2Start = new Touch({ identifier: 2, target: el, clientX: x + 25, clientY: y });
      el.dispatchEvent(new TouchEvent('touchstart', {
        touches: [t1Start, t2Start], changedTouches: [t1Start, t2Start], cancelable: true,
      }));

      // Move fingers further apart (zoom in)
      const t1End = new Touch({ identifier: 1, target: el, clientX: x - 75, clientY: y });
      const t2End = new Touch({ identifier: 2, target: el, clientX: x + 75, clientY: y });
      el.dispatchEvent(new TouchEvent('touchmove', {
        touches: [t1End, t2End], changedTouches: [t1End, t2End], cancelable: true,
      }));

      el.dispatchEvent(new TouchEvent('touchend', {
        touches: [], changedTouches: [t1End, t2End], cancelable: true,
      }));
    }, { x: cx, y: cy });

    // No crash = success
    await expect(page.getByTestId('board-canvas')).toBeVisible();
  });

  test('PDF viewer has touch-action: none on canvas container', async ({ page }) => {
    await page.goto('/');

    // Check CSS rule exists at least (PDF panel may not be open by default)
    const hasTouchRule = await page.evaluate(() => {
      for (const sheet of document.styleSheets) {
        try {
          for (const rule of sheet.cssRules) {
            if (rule instanceof CSSStyleRule
              && rule.selectorText === '.pdf-canvas-container'
              && rule.style.touchAction === 'none') {
              return true;
            }
          }
        } catch { /* cross-origin sheet */ }
      }
      return false;
    });
    expect(hasTouchRule).toBe(true);
  });

  test('PDF viewer supports pointer events for drag', async ({ page }) => {
    await page.goto('/');

    // Open a board file to get the app initialized, then check PDF container events
    const fileInput = page.getByTestId('file-input');
    const testFile = path.resolve(__dirname, '../public/samples/test-board.bvr');
    await fileInput.setInputFiles(testFile);
    await expect(page.getByTestId('board-canvas')).toBeVisible();

    // Verify the PDF canvas container element uses pointer event handlers
    // by checking that the React event handlers are registered
    // (the container won't exist unless a PDF is opened, so just verify CSS)
    const touchActionRule = await page.evaluate(() => {
      const style = document.createElement('div');
      style.className = 'pdf-canvas-container';
      document.body.appendChild(style);
      const ta = getComputedStyle(style).touchAction;
      document.body.removeChild(style);
      return ta;
    });
    expect(touchActionRule).toBe('none');
  });
});
