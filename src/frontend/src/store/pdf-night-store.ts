/**
 * PDF night mode (issue #41). One value for every PDF panel, persisted.
 *
 * Every style is one pipeline, applied as a CSS `filter` on the canvas
 * container:
 *
 *   saturate(colour) → [hue-rotate(180°)] → contrast curve → paper/ink map
 *
 *  - The paper/ink map is per channel and linear: white paper → `bg`, black
 *    ink → `fg`, exactly. `invert` and `dark` are this map with bg black and
 *    fg white; `custom` uses the chosen pair.
 *  - The hue is turned back by 180° whenever the map flips lightness (paper
 *    darker than ink) — except in `invert`, whose point is the flip — so a red
 *    line stays red. Turning the hue and inverting commute (the hue-rotate
 *    matrix rows sum to 1), so `dark` here equals the old
 *    `invert(1) hue-rotate(180deg)`.
 *  - The contrast curve squeezes only the pale range: values up to a knee are
 *    left as drawn (dark and saturated lines already read), values between
 *    the knee and near-paper are compressed below a limit, and a short ramp
 *    leads up to paper white for anti-aliased edges. Paper (1) and ink (0)
 *    stay where they are; a pale line drawn for white paper becomes readable
 *    on the new one, a strong red or blue keeps its colour. Two curves were
 *    tried first and lost colour: `x^k` turned red into plain ink, and a
 *    uniform `m·x` washed dark blue out to near white. `Auto` picks the limit
 *    from the colour pair (`autoScale`); otherwise the slider sets it.
 *  - `colour` (saturation) 0 turns every coloured line grey, i.e. into a shade
 *    of the ink colour — the quick way to take colours out of the picture.
 *
 * When the result is the plain inversion with no curve, the filter is the
 * CSS-only `invert(1)` (+ hue-rotate), which every browser composites on the
 * GPU; anything else needs the panel's SVG `<filter>` (`nightPipeline().svg`).
 */
import { Emitter } from './emitter';
import { createStoreHook } from '../hooks/createStoreHook';

export type NightStyle = 'invert' | 'dark' | 'custom';

export interface PdfNightState {
  on: boolean;
  style: NightStyle;
  /** Custom paper colour, `#rrggbb`. */
  bg: string;
  /** Custom ink colour, `#rrggbb`. */
  fg: string;
  /** Saturation of coloured lines, percent: 0 grey … 100 as drawn … 200 vivid. */
  colour: number;
  /** Contrast curve chosen from the colours. */
  contrastAuto: boolean;
  /** Manual contrast, 0 (as drawn) … 100 (every line close to ink). */
  contrast: number;
}

export const DEFAULT_NIGHT_BG = '#1e1f22';
export const DEFAULT_NIGHT_FG = '#d6d6d6';
const DEFAULT_COLOUR = 100;
const DEFAULT_CONTRAST = 40;

const ON_KEY = 'boardripper-pdf-nightmode';      // '1' | '0' — predates the styles
const STYLE_KEY = 'boardripper-pdf-nightstyle';
const BG_KEY = 'boardripper-pdf-night-bg';
const FG_KEY = 'boardripper-pdf-night-fg';
const COLOUR_KEY = 'boardripper-pdf-night-colour';
const CONTRAST_AUTO_KEY = 'boardripper-pdf-night-contrast-auto';
const CONTRAST_KEY = 'boardripper-pdf-night-contrast';

const HEX = /^#[0-9a-f]{6}$/i;

function read(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key: string, v: string): void {
  try { localStorage.setItem(key, v); } catch { /* no storage */ }
}
function readNum(key: string, def: number, lo: number, hi: number): number {
  const v = Number(read(key));
  return read(key) !== null && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def;
}

class PdfNightStore extends Emitter {
  private _s: PdfNightState;

  constructor() {
    super();
    const style = read(STYLE_KEY);
    const bg = read(BG_KEY);
    const fg = read(FG_KEY);
    this._s = {
      on: read(ON_KEY) === '1',
      style: style === 'dark' || style === 'custom' ? style : 'invert',
      bg: bg && HEX.test(bg) ? bg : DEFAULT_NIGHT_BG,
      fg: fg && HEX.test(fg) ? fg : DEFAULT_NIGHT_FG,
      colour: readNum(COLOUR_KEY, DEFAULT_COLOUR, 0, 200),
      contrastAuto: read(CONTRAST_AUTO_KEY) !== '0',
      contrast: readNum(CONTRAST_KEY, DEFAULT_CONTRAST, 0, 100),
    };
  }

  /** Stable reference until something changes (useSyncExternalStore). */
  get state(): PdfNightState { return this._s; }

  private patch(p: Partial<PdfNightState>): void {
    this._s = { ...this._s, ...p };
    this.notify();
  }

  setOn(on: boolean): void {
    if (this._s.on === on) return;
    write(ON_KEY, on ? '1' : '0');
    this.patch({ on });
  }

  /** Picking a style turns night mode on — choosing how to darken is asking for it. */
  setStyle(style: NightStyle): void {
    write(STYLE_KEY, style);
    write(ON_KEY, '1');
    this.patch({ style, on: true });
  }

  setColors(c: { bg?: string; fg?: string }): void {
    const p: Partial<PdfNightState> = {};
    if (c.bg && HEX.test(c.bg)) { p.bg = c.bg.toLowerCase(); write(BG_KEY, p.bg); }
    if (c.fg && HEX.test(c.fg)) { p.fg = c.fg.toLowerCase(); write(FG_KEY, p.fg); }
    this.patch(p);
  }

  setColour(v: number): void {
    const colour = Math.round(Math.min(200, Math.max(0, v)));
    write(COLOUR_KEY, String(colour));
    this.patch({ colour });
  }

  setContrastAuto(v: boolean): void {
    write(CONTRAST_AUTO_KEY, v ? '1' : '0');
    this.patch({ contrastAuto: v });
  }

  /** Moving the slider is choosing a manual value — Auto goes off. */
  setContrast(v: number): void {
    const contrast = Math.round(Math.min(100, Math.max(0, v)));
    write(CONTRAST_KEY, String(contrast));
    write(CONTRAST_AUTO_KEY, '0');
    this.patch({ contrast, contrastAuto: false });
  }

  /** Back to the defaults for everything the menu's lower half sets. */
  resetColors(): void {
    this.setColors({ bg: DEFAULT_NIGHT_BG, fg: DEFAULT_NIGHT_FG });
    this.setColour(DEFAULT_COLOUR);
    write(CONTRAST_KEY, String(DEFAULT_CONTRAST));
    this.patch({ contrast: DEFAULT_CONTRAST });
    this.setContrastAuto(true);
  }
}

export const pdfNightStore = new PdfNightStore();
export const usePdfNight = createStoreHook(pdfNightStore, () => pdfNightStore.state);

type RGB = [number, number, number];

function rgb(hex: string): RGB {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
}
/** WCAG relative luminance. */
function luminance(c: RGB): number {
  const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
}
function contrastRatio(a: RGB, b: RGB): number {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
const lerp = (a: RGB, b: RGB, t: number): RGB => [0, 1, 2].map(i => a[i] + (b[i] - a[i]) * t) as RGB;

/** The lightest line Auto must keep readable, in the source's 0…1 scale: a
 *  pale colour drawn for white paper (light green, cyan, yellow-ish; #a8e0a8
 *  is 0.88 at its brightest channel). */
const AUTO_REF = 0.88;
/** Strongest manual setting: everything below paper at 20 % of its distance. */
const MIN_SCALE = 0.2;
/** The knot where the squeezed range ends at the limit `m·knot` and a straight
 *  ramp to paper white begins — the anti-aliased rim of text and lines lives
 *  above it. A table knot (KNOT_STEPS of TABLE_STEPS). */
const KNOT_STEPS = 23;
const TABLE_STEPS = 25;

/** Contrast scale for Auto: the largest m ≤ 1 whose curve puts a source line
 *  of lightness `AUTO_REF` at WCAG 4.5:1 against the paper — or, when the
 *  chosen ink itself is softer than that, at 60 % of the ink's own contrast,
 *  so a deliberately low-contrast pair is respected rather than overridden.
 *  Solved against the real table curve, not `m·x`: the curve sits above
 *  `m·x` between the knee and the knot, so dividing by AUTO_REF fell short of
 *  the target (4.35:1 on black/white). */
export function autoScale(bgHex: string, fgHex: string): number {
  const bg = rgb(bgHex), fg = rgb(fgHex);
  const target = Math.min(4.5, 1 + (contrastRatio(fg, bg) - 1) * 0.6);
  // Output for source lightness x is lerp(fg, bg, curve(x)); a larger m lifts
  // the curve and lowers the contrast. Find the largest m still at the target.
  const reaches = (m: number) => contrastRatio(lerp(fg, bg, tableValueAt(m, AUTO_REF)), bg) >= target;
  if (reaches(1)) return 1;
  if (!reaches(MIN_SCALE)) return MIN_SCALE;
  let lo = MIN_SCALE, hi = 1;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (reaches(mid)) lo = mid; else hi = mid;
  }
  return lo;
}

/** The curve's output for source value x, interpolated between the table's
 *  knots exactly as `feFuncX type="table"` does. */
export function tableValueAt(m: number, x: number): number {
  const t = contrastTable(m);
  const n = t.length - 1;
  const k = Math.min(n - 1, Math.floor(Math.max(0, Math.min(1, x)) * n));
  return t[k] + (t[k + 1] - t[k]) * (Math.max(0, Math.min(1, x)) * n - k);
}

/** Below this fraction of the limit, values are left as drawn. */
const KNEE = 0.6;

/** `feFuncX type="table"` values for scale m: the limit is `m·knot`; identity
 *  up to the knee, the knee…knot range squeezed under the limit, then a
 *  straight ramp to 1. m = 1 is the identity. */
export function contrastTable(m: number): number[] {
  const knot = KNOT_STEPS / TABLE_STEPS;
  const limit = m * knot;
  const knee = KNEE * limit;
  return Array.from({ length: TABLE_STEPS + 1 }, (_, i) => {
    const x = i / TABLE_STEPS;
    if (x <= knee) return x;
    if (x <= knot) return knee + (x - knee) * (limit - knee) / (knot - knee);
    return limit + (1 - limit) * (x - knot) / (1 - knot);
  });
}

export interface NightPipeline {
  /** CSS `filter` for the canvas container. */
  css: string;
  /** Present when the panel must render its SVG `<filter>`: the contrast
   *  table (space-separated, for `tableValues`) and the per-channel paper/ink map. */
  svg: { table: string; map: { slope: number; intercept: number }[] } | null;
}

/** The night filter for the current state, or null when night mode is off.
 *  `svgFilterId` names the panel's `<filter>` element. */
export function nightPipeline(s: PdfNightState, svgFilterId: string): NightPipeline | null {
  if (!s.on) return null;
  const custom = s.style === 'custom';
  const bgHex = custom ? s.bg : '#000000';
  const fgHex = custom ? s.fg : '#ffffff';
  const bg = rgb(bgHex), fg = rgb(fgHex);
  const flipsLightness = luminance(bg) < luminance(fg);
  const keepHue = s.style !== 'invert' && flipsLightness;
  const scale = s.contrastAuto ? autoScale(bgHex, fgHex) : 1 - (s.contrast / 100) * (1 - MIN_SCALE);

  const parts: string[] = [];
  if (s.colour !== 100) parts.push(`saturate(${s.colour}%)`);
  if (keepHue) parts.push('hue-rotate(180deg)');

  const plainInvert = !custom && scale >= 0.999;
  if (plainInvert) {
    parts.push('invert(1)');
    return { css: parts.join(' '), svg: null };
  }
  parts.push(`url(#${svgFilterId})`);
  return {
    css: parts.join(' '),
    svg: { table: contrastTable(scale).map(v => v.toFixed(4)).join(' '), map: [0, 1, 2].map(i => ({ slope: bg[i] - fg[i], intercept: fg[i] })) },
  };
}
