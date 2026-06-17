/**
 * Pin-group colour model — matcher, resolver, and theme-carry.
 *
 * Drives the render-settings + themes modules in-page (Vite serves them) to
 * verify the net-class classification and that a theme can carry its own
 * pinGroups via boardOverrides (so editing pin colours per theme works).
 */
import { test, expect } from '@playwright/test';

test('pin-group resolver classifies nets per the default groups', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('toolbar')).toBeVisible({ timeout: 10000 });

  const r = await page.evaluate(async () => {
    const rs = await import('/src/store/render-settings.ts');
    const D = rs.DEFAULTS;
    const hex = (n: number) => '#' + n.toString(16).padStart(6, '0');
    const col = (net: string) => hex(rs.resolvePinColor(D, net, 'top'));
    const outline = (net: string) => rs.isOutlineOnlyNet(D, net);
    return {
      gnd: col('GND'),
      agnd: col('AGND'),     // separate/analog ground == VSS shade
      vss: col('VSS'),
      vcc: col('VCC'),
      vccio: col('VCCIO'),   // substring → power
      pp: col('PP3V3'),      // PP rule (substring; not VDD/VCC)
      sda: col('SDA'),
      spi: col('SPI_CLK'),
      pci: col('PCIE_RX'),
      ddr: col('DDR0_DQ5'),
      en: col('PWR_EN'),
      sw: col('SW1'),        // SW# digit wildcard
      onoff: col('ONOFF'),
      defaultTop: col('SOME_RANDOM_SIGNAL'),
      ncOutline: outline('NC'),
      ncuOutline: outline('NC_PAD'),
      syncOutline: outline('SYNC'),   // must NOT be treated as NC
      gndOutline: outline('GND'),
    };
  });

  expect(r.gnd).toBe('#666666');
  expect(r.agnd).toBe('#9a9a9a');           // analog ground gets the separate shade
  expect(r.vss).toBe('#9a9a9a');
  expect(r.agnd).toBe(r.vss);               // AGND ≡ VSS per spec
  expect(r.vcc).toBe('#dd3333');
  expect(r.vccio).toBe('#dd3333');
  expect(r.pp).toBe('#dd6633');
  expect(r.sda).toBe('#d96bb0');
  expect(r.spi).toBe('#d96bb0');
  expect(r.pci).toBe('#3a7bd5');
  expect(r.ddr).toBe('#6fa8e0');
  expect(r.en).toBe('#3aa6a0');
  expect(r.sw).toBe('#3aa6a0');
  expect(r.onoff).toBe('#9a6bd9');
  expect(r.defaultTop).toBe('#44cc44');     // no group → per-side default

  expect(r.ncOutline).toBe(true);
  expect(r.ncuOutline).toBe(true);
  expect(r.syncOutline).toBe(false);        // SYNC is not a no-connect
  expect(r.gndOutline).toBe(false);
});

test('a theme can carry its own pinGroups (override flows into effective settings)', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('toolbar')).toBeVisible({ timeout: 10000 });

  const r = await page.evaluate(async () => {
    const themes = await import('/src/store/themes.ts');
    const rs = await import('/src/store/render-settings.ts');
    themes.themeStore.ensureCustom();
    themes.themeStore.setTheme('custom');

    const before = rs.resolvePinColor(rs.renderSettingsStore.settings, 'GND', 'top');

    // Theme overrides the whole pinGroups array: recolour Ground to pure black.
    const groups = structuredClone(rs.DEFAULTS.pinGroups);
    const ground = groups.find(g => g.id === 'ground');
    ground.rules.forEach(rule => { rule.color = '#000000'; });
    themes.themeStore.setCustomOverride('pinGroups', groups);

    const after = rs.resolvePinColor(rs.renderSettingsStore.settings, 'GND', 'top');
    return { before: before.toString(16), after: after.toString(16) };
  });

  expect(r.before).toBe('666666');
  expect(r.after).toBe('0');   // #000000 → 0
});

test('Landrex is fully monochrome — greyscale pins, no net colours, readable', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('toolbar')).toBeVisible({ timeout: 10000 });

  const r = await page.evaluate(async () => {
    const themes = await import('/src/store/themes.ts');
    const rs = await import('/src/store/render-settings.ts');
    themes.themeStore.setTheme('landrex');
    const t = themes.themeStore.activeTheme();
    const s = rs.renderSettingsStore.settings;
    return {
      canvas: t.board.canvasBackground,
      boardFill: t.board.boardFill,
      labelText: t.board.labelText,
      showComponentColors: s.showComponentColors,
      groups: s.pinGroups.length,
      vcc: rs.resolvePinColor(s, 'VCC', 'top').toString(16),
      gnd: rs.resolvePinColor(s, 'GND', 'top').toString(16),
    };
  });
  // No net-class colour: VCC/GND fall to the greyscale default pin colour.
  expect(r.groups).toBe(0);
  expect(r.showComponentColors).toBe(false);
  expect(r.vcc).toBe('cfcfcf');   // greyscale top-pin default, not power-red
  expect(r.gnd).toBe('cfcfcf');
  // Readable, not white-on-white: black board fill under white pin labels.
  expect(r.canvas).toBe('#000000');
  expect(r.boardFill).toBe('#000000');
  expect(r.labelText).toBe('#ffffff');
});

test('net-label background colour + opacity are theme-carried', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('toolbar')).toBeVisible({ timeout: 10000 });

  const r = await page.evaluate(async () => {
    const themes = await import('/src/store/themes.ts');
    themes.themeStore.ensureCustom();
    themes.themeStore.setTheme('custom');
    const before = { ...themes.themeStore.activeTheme().board };
    themes.themeStore.updateCustom({ board: { netLabelBg: '#123456', netLabelBgOpacity: 0.4 } });
    const after = { ...themes.themeStore.activeTheme().board };
    return {
      beforeBg: before.netLabelBg, beforeOp: before.netLabelBgOpacity,
      afterBg: after.netLabelBg, afterOp: after.netLabelBgOpacity,
    };
  });
  expect(r.beforeBg).toBeTruthy();           // default seeded from active theme
  expect(r.afterBg.toLowerCase()).toBe('#123456');
  expect(r.afterOp).toBe(0.4);
});
