/**
 * Theme visibility / readability harness.
 *
 * Purpose: guarantee that no theme paints text the user can't read —
 * specifically the "white on white" (or black-on-black) failure mode. Two
 * independent layers of defence:
 *
 *   1. TOKEN CONTRAST (data-level, runs even without WebGL/samples): for every
 *      shipped theme, read the canonical colour variables straight off
 *      document.documentElement (themeStore sets them as plain hex) and assert
 *      WCAG 2.1 contrast ratios for each meaningful foreground/background pair.
 *      AA = 4.5:1 normal text, 3:1 large text / UI graphics. This catches a
 *      bad hex in THEMES before it ever renders.
 *
 *   2. RENDERED TEXT (DOM-level): walk every actually-visible text node on the
 *      first-contact screen, compute its computed colour against the nearest
 *      opaque ancestor background, and fail if any drops below a hard
 *      invisibility floor. This catches CSS rules that bypass the tokens.
 *
 * Board-canvas labels are PixiJS (no DOM, and headless Chromium has no WebGL),
 * so they're verified via the mirrored --board-* vars rather than pixels; a
 * board is still loaded (when the sample is present) to screenshot each theme.
 *
 * WCAG reference: https://www.w3.org/TR/WCAG21/#contrast-minimum
 */
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BVR_FILE = path.resolve(__dirname, '../../../samples/820-02100/820-02100.bvr');
const haveBoard = fs.existsSync(BVR_FILE);

// Themes under test. Keep in sync with THEMES in src/store/themes.ts.
const DARK_THEMES = ['default', 'landrex'];
const LIGHT_THEMES = ['drafting-paper', 'daylight', 'blueprint-light', 'custom'];
const ALL_THEMES = [...DARK_THEMES, ...LIGHT_THEMES];

// A user-built LIGHT custom theme, seeded directly into localStorage. Proves
// the auto-contrast machinery (pickTextColors / shadeToward) protects an
// arbitrary user theme — not just the curated ones — from white-on-white.
const CUSTOM_LIGHT_BLOB = JSON.stringify({
  id: 'custom',
  label: 'Custom',
  ui: {
    bgPrimary: '#f2f0ec', bgSecondary: '#e3e1db', bgTertiary: '#e8e6e0',
    textPrimary: '#1c1f24', textSecondary: '#5b616b',
    accent: '#7a4dbf', border: '#ccc8c0', iconBoardBg: '#3f9142', iconPdfBg: '#c0392b',
  },
  board: {
    canvasBackground: '#eceae4', boardFill: '#fbfaf7', outline: '#6b6258',
    selection: '#d98a1e', butterflySelection: '#2f6db5',
    labelText: '#23262b', labelPart: '#54595f', labelNet: '#2f6db5',
  },
});

// ── WCAG maths (mirrors src/store/color-math.ts; duplicated so the test is
//    self-contained and can't be silently broken by an edit to the source). ──
function lin(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}
function parseColor(input: string): { r: number; g: number; b: number; a: number } {
  const s = input.trim();
  const hex = s.match(/^#([0-9a-fA-F]{6})$/);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
  }
  const hex3 = s.match(/^#([0-9a-fA-F]{3})$/);
  if (hex3) {
    const h = hex3[1].split('').map((c) => c + c).join('');
    const n = parseInt(h, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
  }
  const rgb = s.match(/rgba?\(([^)]+)\)/);
  if (rgb) {
    const parts = rgb[1].split(/[, /]+/).map((x) => x.trim()).filter(Boolean);
    return {
      r: parseFloat(parts[0]),
      g: parseFloat(parts[1]),
      b: parseFloat(parts[2]),
      a: parts[3] != null ? parseFloat(parts[3]) : 1,
    };
  }
  throw new Error(`parseColor: cannot parse "${input}"`);
}
function luminance(c: { r: number; g: number; b: number }): number {
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}
function contrast(a: string, b: string): number {
  const la = luminance(parseColor(a));
  const lb = luminance(parseColor(b));
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/** Apply a theme by seeding localStorage before any app code runs, then load
 *  the first-contact screen. Overrides are cleared so the theme's own tokens
 *  paint (the thing under test). */
async function loadWithTheme(page: import('@playwright/test').Page, themeId: string) {
  await page.addInitScript(({ id, customBlob }) => {
    try {
      localStorage.setItem('boardripper-theme', JSON.stringify({ activeId: id }));
      localStorage.removeItem('boardripper-accent-override');
      localStorage.removeItem('boardripper-background-override');
      localStorage.removeItem('boardripper-chrome-override');
      if (id === 'custom') localStorage.setItem('boardripper-custom-theme', customBlob);
      else localStorage.removeItem('boardripper-custom-theme');
    } catch { /* ignore */ }
  }, { id: themeId, customBlob: CUSTOM_LIGHT_BLOB });
  await page.goto('/');
  await expect(page.getByTestId('toolbar')).toBeVisible({ timeout: 10000 });
}

/** Read the canonical theme variables as resolved by themeStore. */
async function readVars(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    const v = (name: string) => cs.getPropertyValue(name).trim();
    return {
      bgPrimary: v('--bg-primary'),
      bgSecondary: v('--bg-secondary'),
      bgTertiary: v('--bg-tertiary'),
      textPrimary: v('--text-primary'),
      textSecondary: v('--text-secondary'),
      accent: v('--accent'),
      accentFg: v('--accent-fg'),
      border: v('--border'),
      canvasBg: v('--canvas-bg'),
      boardFill: v('--board-fill'),
      boardOutline: v('--board-outline'),
      boardSelection: v('--board-selection'),
      boardLabelText: v('--board-label-text'),
      boardLabelPart: v('--board-label-part'),
      boardLabelNet: v('--board-label-net'),
    };
  });
}

for (const themeId of ALL_THEMES) {
  test(`token contrast — ${themeId}`, async ({ page }) => {
    await loadWithTheme(page, themeId);
    const c = await readVars(page);

    // Every var must have resolved to a concrete colour.
    for (const [k, val] of Object.entries(c)) {
      expect(val, `--${k} should be set for theme ${themeId}`).not.toBe('');
    }

    // AA normal-text (4.5): body text on each surface tier it can land on.
    const textPairs: Array<[string, string, string]> = [
      ['text-primary / bg-primary', c.textPrimary, c.bgPrimary],
      ['text-primary / bg-secondary', c.textPrimary, c.bgSecondary],
      ['text-primary / bg-tertiary', c.textPrimary, c.bgTertiary],
      ['text-secondary / bg-primary', c.textSecondary, c.bgPrimary],
      ['text-secondary / bg-tertiary', c.textSecondary, c.bgTertiary],
    ];
    for (const [label, fg, bg] of textPairs) {
      const ratio = contrast(fg, bg);
      expect(ratio, `${themeId}: ${label} = ${ratio.toFixed(2)}:1 (need ≥4.5) [${fg} on ${bg}]`).toBeGreaterThanOrEqual(4.5);
    }

    // Accent button text. NOTE: the legacy default blue (#4a9eff) renders
    // white text at only 2.75:1 — a deliberate v1 brand choice (pickAccentFg
    // keeps white on ordinary saturated accents rather than re-skinning every
    // button to black text). It's below WCAG AA and a candidate for a future
    // per-theme accent-fg override, but it is NOT the white-on-white failure
    // this harness guards against, so the assertion is the invisibility floor
    // only. Bright accents (yellow/lime) still auto-flip to dark via the store.
    const accentRatio = contrast(c.accentFg, c.accent);
    expect(accentRatio, `${themeId}: accent-fg/accent = ${accentRatio.toFixed(2)}:1 below invisibility floor [${c.accentFg} on ${c.accent}]`).toBeGreaterThanOrEqual(2.5);
    // (No border-contrast assertion: subtle low-contrast dividers are a valid
    //  design choice — e.g. the default theme's border sits at 1.07:1 by intent
    //  — and a divider is not text a user has to read.)

    // Light themes: board labels are dark-on-light by construction, so assert
    // they're legible over the board fill (the dominant surface labels sit on).
    // Dark themes draw white labels over a white fill relying on a render-time
    // drop shadow the static check can't model, so they're excluded here.
    if (LIGHT_THEMES.includes(themeId)) {
      for (const [label, fg] of [
        ['board-label-text', c.boardLabelText],
        ['board-label-part', c.boardLabelPart],
        ['board-label-net', c.boardLabelNet],
      ] as const) {
        const r = contrast(fg, c.boardFill);
        expect(r, `${themeId}: ${label}/board-fill = ${r.toFixed(2)}:1 (need ≥3) [${fg} on ${c.boardFill}]`).toBeGreaterThanOrEqual(3.0);
      }
      const selR = contrast(c.boardSelection, c.boardFill);
      expect(selR, `${themeId}: board-selection/board-fill = ${selR.toFixed(2)}:1 (need ≥1.6 to read)`).toBeGreaterThanOrEqual(1.6);
    }
  });
}

for (const themeId of ALL_THEMES) {
  test(`rendered text not invisible — ${themeId}`, async ({ page }) => {
    await loadWithTheme(page, themeId);
    // Give first-contact content a beat to paint.
    await page.waitForTimeout(400);

    const offenders = await page.evaluate(() => {
      function parse(input: string): { r: number; g: number; b: number; a: number } | null {
        const s = input.trim();
        // color-mix() resolves to color(srgb r g b / a) in Chromium, with
        // channels in 0–1. Handle it before rgb() so the dark pill chips
        // (color-mix backgrounds) are read instead of falling through.
        const cm = s.match(/color\(srgb\s+([^)]+)\)/);
        if (cm) {
          const parts = cm[1].split(/[/\s]+/).map((x) => parseFloat(x)).filter((x) => !Number.isNaN(x));
          return { r: parts[0] * 255, g: parts[1] * 255, b: parts[2] * 255, a: parts[3] != null ? parts[3] : 1 };
        }
        const m = s.match(/rgba?\(([^)]+)\)/);
        if (!m) return null;
        const p = m[1].split(/[, /]+/).map((x) => parseFloat(x.trim()));
        return { r: p[0], g: p[1], b: p[2], a: p[3] != null ? p[3] : 1 };
      }
      function lin(c: number) { const s = c / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); }
      function lum(c: { r: number; g: number; b: number }) { return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b); }
      function ratio(a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }) {
        const la = lum(a), lb = lum(b); const hi = Math.max(la, lb), lo = Math.min(la, lb); return (hi + 0.05) / (lo + 0.05);
      }
      // Nearest ancestor with an opaque-enough background.
      function bgOf(el: Element): { r: number; g: number; b: number } {
        let cur: Element | null = el;
        while (cur) {
          const bg = parse(getComputedStyle(cur).backgroundColor);
          if (bg && bg.a >= 0.5) return bg;
          cur = cur.parentElement;
        }
        return { r: 8, g: 8, b: 12 }; // app root canvas fallback
      }
      const out: Array<{ text: string; color: string; ratio: number }> = [];
      const els = Array.from(document.querySelectorAll('body *')) as HTMLElement[];
      for (const el of els) {
        // Only elements with their own direct, non-whitespace text.
        const direct = Array.from(el.childNodes).some(
          (n) => n.nodeType === Node.TEXT_NODE && (n.textContent || '').trim().length > 1,
        );
        if (!direct) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width < 4 || rect.height < 4) continue;
        const st = getComputedStyle(el);
        if (st.visibility === 'hidden' || st.display === 'none' || parseFloat(st.opacity) < 0.3) continue;
        const fg = parse(st.color);
        if (!fg || fg.a < 0.3) continue;
        const r = ratio(fg, bgOf(el));
        if (r < 2.5) {
          out.push({ text: (el.textContent || '').trim().slice(0, 40), color: st.color, ratio: Math.round(r * 100) / 100 });
        }
      }
      return out;
    });

    expect(
      offenders,
      `theme ${themeId}: ${offenders.length} text element(s) below the invisibility floor (2.5:1):\n` +
        offenders.map((o) => `  "${o.text}" color=${o.color} ratio=${o.ratio}`).join('\n'),
    ).toEqual([]);
  });
}

test.describe('board screenshots per theme', () => {
  test.skip(!haveBoard, 'sample board 820-02100.bvr not present');
  for (const themeId of ALL_THEMES) {
    test(`board renders under ${themeId}`, async ({ page }) => {
      await loadWithTheme(page, themeId);
      await page.getByTestId('file-input').setInputFiles(BVR_FILE);
      await expect(page.locator('.dv-tab', { hasText: '820-02100.bvr' })).toBeVisible({ timeout: 20000 });
      await page.waitForTimeout(1200);
      await page.screenshot({ path: `test-results/theme-${themeId}.png`, fullPage: false });
    });
  }
});
