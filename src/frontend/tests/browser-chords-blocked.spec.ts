/**
 * The browser's own keyboard chords never reach the browser (2026-10-22):
 * ⌘F opened the browser's find bar when the key went down inside an element
 * that stops propagation (the slide sheet's text boxes). The block runs in
 * the capture phase on the window, ahead of any such element.
 */
import { test, expect } from '@playwright/test';

const MOD = process.platform === 'darwin' ? 'metaKey' : 'ctrlKey';

test('⌘F / ⌘S / ⌘D / ⌘P are default-prevented even from an element that stops propagation', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('toolbar')).toBeVisible({ timeout: 15000 });
  const results = await page.evaluate((mod) => {
    const el = document.createElement('input');
    document.body.appendChild(el);
    el.addEventListener('keydown', e => e.stopPropagation());
    const out: Record<string, boolean> = {};
    for (const key of ['f', 's', 'd', 'p', 'g', '0', '=']) {
      const ev = new KeyboardEvent('keydown', { key, [mod]: true, bubbles: true, cancelable: true });
      el.dispatchEvent(ev);
      out[key] = ev.defaultPrevented;
    }
    // A plain letter is left alone.
    const plain = new KeyboardEvent('keydown', { key: 'f', bubbles: true, cancelable: true });
    el.dispatchEvent(plain);
    out.plain = plain.defaultPrevented;
    el.remove();
    return out;
  }, MOD);
  for (const key of ['f', 's', 'd', 'p', 'g', '0', '=']) expect(results[key], key).toBe(true);
  expect(results.plain).toBe(false);
});
