import { test, expect } from '@playwright/test';

// Status-bar memory stat (useMemoryStat + COOP/COEP isolation headers).
// The vite dev server (and the Go server in prod) send
// Cross-Origin-Opener-Policy: same-origin + Cross-Origin-Embedder-Policy:
// credentialless, which makes the page cross-origin isolated and unlocks
// the precise performance.measureUserAgentSpecificMemory() path — the stat
// must render WITHOUT the "≈" approximate marker.

test('page is cross-origin isolated and shows a precise memory stat', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/');

  const isolated = await page.evaluate(() => crossOriginIsolated);
  expect(isolated, 'COOP/COEP headers missing — page not cross-origin isolated').toBe(true);

  // The stat must render either way (≈ fallback or precise).
  const mem = page.getByTestId('statusbar-mem');
  await expect(mem).toBeVisible({ timeout: 15_000 });
  await expect(mem).toHaveText(/^Mem( ≈|:) \d+(\.\d+)? (MB|GB)$/);

  // Precise path: headless Chromium's shell rejects
  // measureUserAgentSpecificMemory with SecurityError even when isolated
  // (verified 2026-07-12) — assert the precise label only where the API
  // actually works (headed runs / real Chrome).
  const preciseAvailable = await page.evaluate(async () => {
    try {
      await (performance as unknown as { measureUserAgentSpecificMemory: () => Promise<unknown> })
        .measureUserAgentSpecificMemory();
      return true;
    } catch { return false; }
  });
  if (preciseAvailable) {
    await expect
      .poll(async () => (await mem.textContent()) ?? '', { timeout: 60_000 })
      .toMatch(/^Mem: \d+(\.\d+)? (MB|GB)$/); // no "≈"
  } else {
    // Fallback must at least be wired: ≈ label present with a numeric value.
    await expect(mem).toHaveText(/^Mem ≈ \d+(\.\d+)? (MB|GB)$/);
  }
});
