/**
 * Pure colour maths shared by the theme system, the (upcoming) custom theme
 * editor, and the visibility test harness. Deliberately free of any imports
 * or side effects so it can be pulled into a Playwright spec or a Node script
 * without dragging in the store / DOM machinery.
 *
 * All hex inputs are '#rrggbb'. Contrast follows WCAG 2.1 relative-luminance.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** Parse '#rrggbb' (or '#rgb') to 0–255 channels. Throws on malformed input
 *  so a bad theme value fails loudly rather than silently rendering black. */
export function parseHex(hex: string): Rgb {
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) throw new Error(`parseHex: not a hex colour: ${hex}`);
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

const toHex2 = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');

export function rgbToHex({ r, g, b }: Rgb): string {
  return `#${toHex2(r)}${toHex2(g)}${toHex2(b)}`;
}

/** WCAG relative luminance ∈ [0,1] from a hex colour. */
export function relativeLuminance(hex: string): number {
  const { r, g, b } = parseHex(hex);
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/**
 * WCAG contrast ratio between two hex colours, ∈ [1, 21].
 * 4.5 is the AA threshold for normal text, 3.0 for large text / UI graphics.
 */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/** Mix a hex colour toward white by `amount` ∈ [0,1]. */
export function lightenHex(hex: string, amount: number): string {
  const { r, g, b } = parseHex(hex);
  return rgbToHex({
    r: r + (255 - r) * amount,
    g: g + (255 - g) * amount,
    b: b + (255 - b) * amount,
  });
}

/** Mix a hex colour toward black by `amount` ∈ [0,1]. */
export function darkenHex(hex: string, amount: number): string {
  const { r, g, b } = parseHex(hex);
  return rgbToHex({ r: r * (1 - amount), g: g * (1 - amount), b: b * (1 - amount) });
}

/**
 * Derive a *visible sibling* tier from a base colour, shading away from the
 * nearest luminance pole: lighten a dark base, darken a light one. This is
 * what makes the background/chrome knobs (and the light themes) produce a
 * legible tier whether the base is dark or light.
 */
export function shadeToward(hex: string, amount: number): string {
  return relativeLuminance(hex) > 0.5 ? darkenHex(hex, amount) : lightenHex(hex, amount);
}

/**
 * Foreground colour that reads on top of an accent-filled surface. Flips to
 * dark only when the accent is genuinely bright (gold / lime / yellow);
 * ordinary saturated accents keep white. The 0.5 threshold is intentionally
 * above the WCAG-strict cutoff so e.g. ATARI Red doesn't re-skin every accent
 * button to black-text.
 */
export function pickAccentFg(bgHex: string): string {
  return relativeLuminance(bgHex) > 0.5 ? '#0a0a0a' : '#ffffff';
}

/**
 * Accent colour tuned to stay legible as *text* on a given background. Bright
 * accents (Atari yellow #f4e325, Acid lime #b8ff2b) sit near-invisible as text
 * on a light background; here the accent is shaded away from the background's
 * luminance pole (darken on light bg, lighten on dark bg) just enough to reach
 * AA-normal contrast (4.5:1), capped at ~66% so the accent hue stays
 * recognisable. Returns the accent unchanged when it already has adequate
 * contrast — the common dark-theme case, so existing themes are untouched.
 */
export function accentTextColor(accentHex: string, bgHex: string, minContrast = 4.5): string {
  if (contrastRatio(accentHex, bgHex) >= minContrast) return accentHex;
  const bgLight = relativeLuminance(bgHex) > 0.5;
  let best = accentHex;
  for (let amount = 0.06; amount <= 0.66; amount += 0.06) {
    best = bgLight ? darkenHex(accentHex, amount) : lightenHex(accentHex, amount);
    if (contrastRatio(best, bgHex) >= minContrast) break;
  }
  return best;
}

/**
 * Body-text pair chosen for contrast against the effective background. Keeps
 * the historical #e0e0e0 / #a0a0b0 on dark backgrounds so existing dark themes
 * are unchanged; flips to graphite on light backgrounds so text stays readable
 * when the background knob (or a light theme) lightens the base. This single
 * derivation is what unblocks light themes.
 */
export function pickTextColors(bgHex: string): { primary: string; secondary: string } {
  return relativeLuminance(bgHex) > 0.5
    ? { primary: '#1c1f24', secondary: '#5b616b' }
    : { primary: '#e0e0e0', secondary: '#a0a0b0' };
}

/** Convert '#rrggbb' to a 24-bit integer for PixiJS color arguments. */
export function hexToInt(hex: string): number {
  const { r, g, b } = parseHex(hex);
  return (r << 16) | (g << 8) | b;
}

/* ── Derived UI tokens ──────────────────────────────────────────────────────
 * index.css used to derive every tint from the theme tokens with
 * `color-mix()`, 73 sites. color-mix over var() is Safari 16.2+ and Lightning
 * CSS cannot lower it, so a Safari 15.4 build lost all of them at once. The
 * mixes now happen here, once per theme change, and index.css reads plain
 * tokens (`var(--accent-a12)`); the `:root` block keeps static first-paint
 * values for the default palette, generated by the same maths — keep them
 * in sync when a percentage changes. Two forms, matching what color-mix did:
 *   mixHex(a, b, p)  = a·p + b·(1−p) per sRGB channel, both opaque
 *   alphaHex(c, a)   = c at alpha a (color-mix with `transparent`)
 * Colours arrive as '#rrggbb'; every theme token is one.
 */

export function mixHex(a: string, b: string, pA: number): string {
  const A = parseHex(a), B = parseHex(b);
  return rgbToHex({ r: A.r * pA + B.r * (1 - pA), g: A.g * pA + B.g * (1 - pA), b: A.b * pA + B.b * (1 - pA) });
}

export function alphaHex(hex: string, alpha: number): string {
  const { r, g, b } = parseHex(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/* Static semantic colours from index.css `:root`; mirrored so the derived
 * tokens can be computed without reading the DOM. */
const CSS_YELLOW = '#ffff44';
const CSS_ORANGE = '#ffaa00';
const CSS_DANGER = '#d9534f';
/** The fixed-dark chip under the neon binding pills (`--pill-surface`). */
const CSS_PILL_SURFACE = '#15151d';

export interface UiPalette {
  bgPrimary: string;
  bgSecondary: string;
  bgTertiary: string;
  border: string;
  textPrimary: string;
  textSecondary: string;
  accent: string;
}

/** Every global tint index.css consumes, keyed by CSS custom property. The
 *  names say what they are: `-aNN` = the colour at NN % alpha, `-bg2-NN` =
 *  NN % of it over --bg-secondary, `-border-NN` = over --border. */
export function derivedUiTokens(p: UiPalette): Record<string, string> {
  const t: Record<string, string> = {
    '--accent-hover':    mixHex(p.accent, '#ffffff', 0.78),
    '--scrim':           alphaHex(p.bgPrimary, 0.72),
    '--scrim-strong':    alphaHex(p.bgPrimary, 0.86),
    // color-mix(bg-tertiary 90%, text-primary 4%): the 94 % sum became an
    // alpha multiplier, the colour is the 90:4 mix.
    '--tooltip-bg':      alphaHex(mixHex(p.bgTertiary, p.textPrimary, 90 / 94), 0.94),
    '--surface-hover':   alphaHex(p.accent, 0.12),
    '--surface-active':  alphaHex(p.accent, 0.22),
    '--chip-bg':         alphaHex(p.bgTertiary, 0.82),
    '--highlight-net':   alphaHex(CSS_YELLOW, 0.16),
    '--highlight-pin':   alphaHex(CSS_ORANGE, 0.20),
    '--chrome-dark-72':  mixHex(p.bgTertiary, '#000000', 0.72),
    '--chrome-dark-55':  mixHex(p.bgTertiary, '#000000', 0.55),
    '--chrome-bg2-60':   mixHex(p.bgTertiary, p.bgSecondary, 0.60),
    '--danger-a10':      alphaHex(CSS_DANGER, 0.10),
    '--text2-a25':       alphaHex(p.textSecondary, 0.25),
    '--text2-a30':       alphaHex(p.textSecondary, 0.30),
    '--border-a55':      alphaHex(p.border, 0.55),
    '--border-a65':      alphaHex(p.border, 0.65),
  };
  for (const n of [5, 6, 8, 10, 14, 16, 18, 28, 30, 40, 45, 50]) t[`--accent-a${n}`] = alphaHex(p.accent, n / 100);
  for (const n of [35, 40, 45, 50]) t[`--accent-border-${n}`] = mixHex(p.accent, p.border, n / 100);
  for (const n of [4, 8, 10, 20, 30]) t[`--accent-bg2-${n}`] = mixHex(p.accent, p.bgSecondary, n / 100);
  for (const n of [12, 20]) t[`--accent-bg3-${n}`] = mixHex(p.accent, p.bgTertiary, n / 100);
  return t;
}

/** Inline style for one neon binding pill (`.scroll-binding-pill`,
 *  `.home-bindings-cell-action`): the pill colour and its tints. Per element
 *  because each pill has its own colour. `border` and `bgSecondary` are the
 *  current theme's tokens, read by the caller from the theme store. */
export function pillVars(color: string, theme: { border: string; bgSecondary: string }): Record<string, string> {
  return {
    '--pill-color':     color,
    '--pill-bg-20':     mixHex(color, CSS_PILL_SURFACE, 0.20),
    '--pill-bg-16':     mixHex(color, CSS_PILL_SURFACE, 0.16),
    '--pill-a40':       alphaHex(color, 0.40),
    '--pill-a70':       alphaHex(color, 0.70),
    '--pill-border-30': mixHex(color, theme.border, 0.30),
    '--pill-bg2-22':    mixHex(color, theme.bgSecondary, 0.22),
  };
}

/** The net-tree colour ladder: every tint the ComponentInfo net tree uses,
 *  from the one wire colour (`--nw`). Set inline on `.net-scope` next to
 *  `--nw` and `--nw-ink`. */
export function netWireVars(nw: string): Record<string, string> {
  return {
    '--nw-trace':    alphaHex(nw, 0.85),
    '--nw-rail':     alphaHex(nw, 0.45),
    '--nw-rowsel':   alphaHex(nw, 0.24),
    '--nw-bus':      alphaHex(nw, 0.19),
    '--nw-bus-edge': alphaHex(nw, 0.40),
    '--nw-probe':    alphaHex(nw, 0.14),
    '--nw-rowhover': alphaHex(nw, 0.11),
    '--nw-echo':     alphaHex(nw, 0.08),
  };
}
