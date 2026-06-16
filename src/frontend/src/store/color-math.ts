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
