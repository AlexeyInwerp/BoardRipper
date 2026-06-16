/**
 * Custom theme editor — store-level behaviour.
 *
 * The editor UI is a thin layer over themeStore; the settings panel's open
 * path is exercised elsewhere, so here we drive the store directly (via a
 * dynamic import in-page, the same technique themes-smoke uses) to verify the
 * load-bearing contracts:
 *   - create seeds from the active theme and is selectable + persists,
 *   - board-colour edits apply to the live --board-* / --canvas-bg vars,
 *   - pin-colour edits flow through boardOverrides into the EFFECTIVE render
 *     settings (the "global settings + overrides if set" model) and clear back,
 *   - delete falls back to the default theme.
 */
import { test, expect } from '@playwright/test';

async function boot(page: import('@playwright/test').Page) {
  // Each Playwright test gets an isolated context with empty localStorage, so
  // no clearing is needed — and crucially we must NOT clear via addInitScript,
  // which would re-run on reload and wipe the persisted custom theme mid-test.
  await page.goto('/');
  await expect(page.getByTestId('toolbar')).toBeVisible({ timeout: 10000 });
}

const readVar = (page: import('@playwright/test').Page, name: string) =>
  page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);

test('create custom theme, edit a board colour, and persist across reload', async ({ page }) => {
  await boot(page);

  await page.evaluate(async () => {
    const mod = await import('/src/store/themes.ts');
    mod.themeStore.ensureCustom();
    mod.themeStore.setTheme('custom');
    mod.themeStore.updateCustom({ board: { canvasBackground: '#123456' } });
  });
  await page.waitForTimeout(50);

  expect((await readVar(page, '--canvas-bg')).toLowerCase()).toBe('#123456');

  const activeId = await page.evaluate(async () => {
    const mod = await import('/src/store/themes.ts');
    return mod.themeStore.activeId;
  });
  expect(activeId).toBe('custom');

  // Persist across reload.
  await page.reload();
  await expect(page.getByTestId('toolbar')).toBeVisible({ timeout: 10000 });
  expect((await readVar(page, '--canvas-bg')).toLowerCase()).toBe('#123456');
  const afterId = await page.evaluate(async () => {
    const mod = await import('/src/store/themes.ts');
    return mod.themeStore.activeId;
  });
  expect(afterId).toBe('custom');
});

test('pin-colour override flows into effective render settings and clears back', async ({ page }) => {
  await boot(page);

  const result = await page.evaluate(async () => {
    const themes = await import('/src/store/themes.ts');
    const rs = await import('/src/store/render-settings.ts');
    themes.themeStore.ensureCustom();
    themes.themeStore.setTheme('custom');

    const globalTop = rs.renderSettingsStore.globalSettings.defaultPinColorTop;

    themes.themeStore.setCustomOverride('defaultPinColorTop', '#abcdef');
    const overridden = rs.renderSettingsStore.settings.defaultPinColorTop;

    themes.themeStore.setCustomOverride('defaultPinColorTop', null);
    const reverted = rs.renderSettingsStore.settings.defaultPinColorTop;

    return { globalTop, overridden, reverted };
  });

  // Override wins while set; clearing it falls back to the global setting.
  expect(result.overridden.toLowerCase()).toBe('#abcdef');
  expect(result.reverted.toLowerCase()).toBe(result.globalTop.toLowerCase());
});

test('deleting the custom theme falls back to default', async ({ page }) => {
  await boot(page);

  const state = await page.evaluate(async () => {
    const mod = await import('/src/store/themes.ts');
    mod.themeStore.ensureCustom();
    mod.themeStore.setTheme('custom');
    mod.themeStore.resetCustom();
    return { activeId: mod.themeStore.activeId, custom: mod.themeStore.customTheme };
  });
  expect(state.activeId).toBe('default');
  expect(state.custom).toBeNull();

  // And it's gone after reload too.
  await page.reload();
  await expect(page.getByTestId('toolbar')).toBeVisible({ timeout: 10000 });
  const persisted = await page.evaluate(async () => {
    const mod = await import('/src/store/themes.ts');
    return mod.themeStore.customTheme;
  });
  expect(persisted).toBeNull();
});
