/**
 * pdf.js's data files (CMaps, standard fonts, wasm decoders) must be reachable
 * at the URLs pdf-store.ts hands to getDocument(). Until 2026-09 they were
 * derived from the worker asset's hashed name and resolved to nothing in
 * every production build, while `vite dev` happened to work — so this checks
 * the served tree from inside the page, where `document.baseURI` and
 * BASE_URL are the real ones, not a path on disk.
 */
import { test, expect } from '@playwright/test';

const FILES = [
  ['cmaps/Adobe-Japan1-UCS2.bcmap', 'application/octet-stream'],
  ['standard_fonts/LiberationSans-Regular.ttf', 'font/ttf'],
  ['wasm/openjpeg.wasm', 'application/wasm'],
  ['wasm/qcms_bg.wasm', 'application/wasm'],
  ['wasm/jbig2.wasm', 'application/wasm'],
] as const;

test('pdf.js cmaps, standard fonts and wasm decoders are served next to the app', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.toolbar').first()).toBeVisible();
  for (const [rel, type] of FILES) {
    const r = await page.evaluate(async (p) => {
      const res = await fetch(new URL('./pdfjs/' + p, document.baseURI).href);
      return { ok: res.ok, status: res.status, type: res.headers.get('content-type') ?? '', size: (await res.arrayBuffer()).byteLength };
    }, rel);
    expect(r.ok, `${rel} → ${r.status}`).toBe(true);
    expect(r.size, `${rel} is empty`).toBeGreaterThan(64);
    expect(r.type, `${rel} content-type`).toContain(type.split('/')[1]);
  }
});
