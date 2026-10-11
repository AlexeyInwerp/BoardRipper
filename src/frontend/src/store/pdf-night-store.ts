/**
 * PDF night mode (issue #41). One value for every PDF panel, persisted.
 *
 * Three styles, all applied as a CSS `filter` on the canvas container:
 *  - `invert`: every colour flipped — red lines turn cyan. The original mode.
 *  - `dark`:   lightness flipped, hue turned back by 180°, so the paper goes
 *              black and red/blue lines stay red/blue, only lighter.
 *  - `custom`: paper becomes exactly `bg`, black ink exactly `fg` (an SVG
 *              per-channel linear map, `customTransfer`). When the paper is
 *              darker than the ink, the hue is turned back first as in `dark`,
 *              so coloured lines keep their colour there too.
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
}

export const DEFAULT_NIGHT_BG = '#1e1f22';
export const DEFAULT_NIGHT_FG = '#d6d6d6';

const ON_KEY = 'boardripper-pdf-nightmode';      // '1' | '0' — predates the styles
const STYLE_KEY = 'boardripper-pdf-nightstyle';
const BG_KEY = 'boardripper-pdf-night-bg';
const FG_KEY = 'boardripper-pdf-night-fg';

const HEX = /^#[0-9a-f]{6}$/i;

function read(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key: string, v: string): void {
  try { localStorage.setItem(key, v); } catch { /* no storage */ }
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

  resetColors(): void {
    this.setColors({ bg: DEFAULT_NIGHT_BG, fg: DEFAULT_NIGHT_FG });
  }
}

export const pdfNightStore = new PdfNightStore();
export const usePdfNight = createStoreHook(pdfNightStore, () => pdfNightStore.state);

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
}
function luma([r, g, b]: [number, number, number]): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Per-channel `out = slope·in + intercept` for the custom style: white → bg,
 *  black → fg. When the paper ends up darker than the ink, the input has
 *  already been hue-rotated (see `nightFilter`), which leaves white and black
 *  where they were. */
export function customTransfer(s: Pick<PdfNightState, 'bg' | 'fg'>): { slope: number; intercept: number }[] {
  const bg = rgb(s.bg), fg = rgb(s.fg);
  return [0, 1, 2].map(i => ({ slope: bg[i] - fg[i], intercept: fg[i] }));
}

/** The CSS `filter` for the canvas container, or undefined when off.
 *  `svgFilterId` names the panel's `<filter>` holding `customTransfer`. */
export function nightFilter(s: PdfNightState, svgFilterId: string): string | undefined {
  if (!s.on) return undefined;
  if (s.style === 'invert') return 'invert(1)';
  if (s.style === 'dark') return 'invert(1) hue-rotate(180deg)';
  const darkPaper = luma(rgb(s.bg)) < luma(rgb(s.fg));
  return `${darkPaper ? 'hue-rotate(180deg) ' : ''}url(#${svgFilterId})`;
}
