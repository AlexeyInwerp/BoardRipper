import { Emitter } from './emitter';
import { log } from './log-store';
import { setThemeOverridesProvider, renderSettingsStore } from './render-settings';
import type { RenderSettings } from './render-settings';
import {
  shadeToward,
  pickAccentFg,
  pickTextColors,
  accentTextColor,
} from './color-math';

// Re-exported for existing call sites that imported these from themes.ts.
export { lightenHex, darkenHex, shadeToward, pickAccentFg, pickTextColors, hexToInt } from './color-math';

/**
 * A theme bundles every color that's currently configurable across the app —
 * UI chrome (CSS custom properties), board canvas (PixiJS scene constants),
 * and selection accents. Two presets ship in v1; adding a third is one entry
 * in THEMES.
 */
export interface Theme {
  id: string;
  label: string;

  /** UI chrome — drives CSS custom properties on document.documentElement. */
  ui: {
    bgPrimary: string;
    bgSecondary: string;
    bgTertiary: string;
    textPrimary: string;
    textSecondary: string;
    accent: string;
    border: string;
    /** Library file-type badge backgrounds — green for boards, red for PDFs,
     *  for at-a-glance type recognition in the file list. */
    iconBoardBg: string;
    iconPdfBg: string;
  };

  /** Board canvas — drives PixiJS scene constants via the BOARD_COLORS getter. */
  board: {
    canvasBackground: string;
    boardFill: string;
    outline: string;
    selection: string;
    butterflySelection: string;
    /** Pin-number labels (drives BOARD_COLORS.labelPin). */
    labelText: string;
    /** Part refdes labels. Default is light gray; monochrome themes set
     *  white for maximum contrast against a black board. */
    labelPart: string;
    /** Net-name labels. Default is light blue; monochrome themes set white. */
    labelNet: string;
    /** Background box behind net-name labels (when the bg toggle is on). Dark
     *  themes use near-black; light themes a light tint of the board fill. */
    netLabelBg: string;
    /** Opacity 0–1 of the net-label background box. */
    netLabelBgOpacity: number;
    /** Primary (clicked) part outline. Absent = white, the Default look. */
    selectedPart?: string;
    /** Colour the dim overlay fades the board toward. Absent = black. */
    dimColor?: string;
    /** Part border, top / underside. Absent = the green / red of Default. */
    partOutlineTop?: string;
    partOutlineBottom?: string;
    /** Copper colour of the top / bottom layer. Absent = red / green. */
    copperTop?: string;
    copperBottom?: string;
  };

  /**
   * Role colours for a scheme that owns the whole picture (Dark, Landrex,
   * Light, Atari — docs/specs/2026-10-11-colour-schemes-review.md). Turned into
   * render-setting overrides by `paletteOverrides`, applied over the user's
   * own pin groups and part types so their keywords and prefixes stay theirs
   * and only the colours change. Absent = the theme leaves pin and part
   * colours to the render settings (BoardRipper Default).
   */
  palette?: ThemePalette;

  /**
   * Optional render-settings overrides applied while this theme is active.
   * Lets a theme like Landrex enforce a "monochrome supermode" (no
   * component-type colors, no net colors, white pins regardless of side)
   * without the user having to flip every relevant setting by hand.
   * The user's saved settings are restored when the theme is switched off.
   */
  boardOverrides?: Partial<RenderSettings>;
}

/** What a pin is for, as far as colour goes. Matches the rule ids of
 *  DEFAULT_PIN_GROUPS; `signalTop`/`signalBottom` colour every pin no group
 *  claims, one per side, so the side has its own code and red can mean power. */
export type PinRole = 'signalTop' | 'signalBottom' | 'power' | 'rail' | 'ground' | 'agnd'
  | 'serial' | 'pci' | 'ddr' | 'enable' | 'onoff' | 'nc';

export interface ThemePalette {
  pins: Record<PinRole, string>;
  /** Fill per part-type id; null = parts are outlines with no fill. */
  partTints: Record<string, string> | null;
  componentFillAlpha?: number;
  /** 1 = the board sheet is drawn solid in `board.boardFill`. */
  boardFillAlpha?: number;
  showPin1Marker?: boolean;
  /** Fill of a large part fades with its share of the board, so a connector
   *  the size of a third of the board is a tint, not a block. */
  fadeLargeBodies?: boolean;
}

/** DEFAULT_PIN_GROUPS rule id → role. A rule the user added has no role and
 *  keeps its own colour. */
const RULE_ROLE: Record<string, PinRole> = {
  'power-v': 'power', 'power-pp': 'rail', 'gnd-sep': 'agnd', gnd: 'ground',
  serial: 'serial', pci: 'pci', ddr: 'ddr', enable: 'enable', onoff: 'onoff', nc: 'nc',
};

/** The render-setting overrides a palette theme implies, built on the user's
 *  own settings: pin groups and part types keep every keyword and prefix, only
 *  the colours of the built-in rules and types are swapped. */
export function paletteOverrides(p: ThemePalette, global: RenderSettings): Partial<RenderSettings> {
  const pinGroups = (global.pinGroups ?? []).map(g => ({
    ...g,
    rules: g.rules.map(r => (RULE_ROLE[r.id] ? { ...r, color: p.pins[RULE_ROLE[r.id]] } : r)),
  }));
  const partTypes = (global.partTypes ?? []).map(t => (p.partTints?.[t.id] ? { ...t, color: p.partTints[t.id] } : t));
  const ov: Partial<RenderSettings> = {
    pinGroups,
    defaultPinColorTop: p.pins.signalTop,
    defaultPinColorBottom: p.pins.signalBottom,
    showComponentColors: p.partTints !== null,
    partTypes,
  };
  if (p.componentFillAlpha !== undefined) ov.componentFillAlpha = p.componentFillAlpha;
  if (p.boardFillAlpha !== undefined) ov.boardFillAlpha = p.boardFillAlpha;
  if (p.showPin1Marker !== undefined) ov.showPin1Marker = p.showPin1Marker;
  return ov;
}

/** Interface chrome shared by the dark schemes (identical to Default's). */
const DARK_UI: Theme['ui'] = {
  bgPrimary: '#08080c', bgSecondary: '#0f0f18', bgTertiary: '#0c1424', textPrimary: '#e0e0e0',
  textSecondary: '#a0a0b0', accent: '#4a9eff', border: '#1a1a28', iconBoardBg: '#44cc44', iconPdfBg: '#cc4444',
};

export const THEMES: Record<string, Theme> = {
  default: {
    id: 'default',
    label: 'BoardRipper Default',
    // Note for future palette work: avoid AI-cliché colour schemes —
    // saturated cyan-blue dashboards and warm amber/orange "cyberpunk"
    // accents are both visually generic now. When picking a new default
    // accent, explore: magenta/hot-pink, acid lime, deep violet,
    // teal-not-cyan, classic ATARI red/orange/gold, or muted neutrals.
    // Keep ui.* values mirrored to :root in src/frontend/src/index.css
    // so the first paint (before themeStore.init()) doesn't flash.
    ui: {
      bgPrimary:     '#08080c',
      bgSecondary:   '#0f0f18',
      bgTertiary:    '#0c1424',
      textPrimary:   '#e0e0e0',
      textSecondary: '#a0a0b0',
      accent:        '#4a9eff',
      border:        '#1a1a28',
      iconBoardBg:   '#44cc44',
      iconPdfBg:     '#cc4444',
    },
    board: {
      canvasBackground:   '#050508',
      boardFill:          '#ffffff',
      outline:            '#4a9eff',
      selection:          '#ffff44',
      butterflySelection: '#44aaff',
      labelText:          '#ffffff',
      labelPart:          '#cccccc',
      labelNet:           '#88ccff',
      netLabelBg:         '#000000',
      netLabelBgOpacity:  0.6,
    },
    // Default theme = no overrides. Whatever the user has configured wins.
  },
  // ──────────────────────────────────────────────────────────────────────
  // Palette schemes (2026-10-11 review, docs/specs/2026-10-11-colour-schemes-review.md).
  // Each owns every colour on the board: pins by role and side, part bodies,
  // outlines, selection, dim and copper. All four pass the contrast checks in
  // themes.test.ts (labels ≥ 4.5:1 on the board and on every part body, pins
  // and selection ≥ 3:1). Mockup: claude.ai/artifact/9SzQM5xQaWsoEab6CPNgPX.
  dark: {
    id: 'dark',
    label: 'Dark',
    // Near-monochrome on NexusBV's principle: parts are grey outlines, every
    // pin one quiet grey, power a step brighter, ground a dark teal. Colour is
    // kept for the selection (yellow net, red part).
    ui: DARK_UI,
    board: {
      canvasBackground: '#08090b', boardFill: '#0f1114', outline: '#4a5260',
      selection: '#fff033', butterflySelection: '#44aaff', selectedPart: '#ff2b2b',
      labelText: '#e6e9ec', labelPart: '#d4d8dd', labelNet: '#b8c2cc',
      netLabelBg: '#000000', netLabelBgOpacity: 0.6, dimColor: '#08090b',
      partOutlineTop: '#5a606a', partOutlineBottom: '#6f6550',
      copperTop: '#39a9ff', copperBottom: '#f0a94a',
    },
    palette: {
      pins: {
        signalTop: '#6e7681', signalBottom: '#9c8a6a', power: '#a7afb9', rail: '#959da7',
        ground: '#5b7676', agnd: '#6b8686', serial: '#6e7681', pci: '#6e7681', ddr: '#6e7681',
        enable: '#6e7681', onoff: '#6e7681', nc: '#5e6570',
      },
      partTints: null, boardFillAlpha: 1,
    },
  },
  landrex: {
    id: 'landrex',
    label: 'Landrex Classic',
    // As Landrex Test Link drew a board: black, an olive board edge,
    // lavender-grey part outlines, every pin the same blue, nothing filled.
    // The only additions: ground set apart, an amber underside, a yellow
    // selected net and a red selected part. Editing any colour forks the theme
    // into the custom slot like every other theme.
    ui: DARK_UI,
    board: {
      canvasBackground: '#000000', boardFill: '#000000', outline: '#9c9a4e',
      selection: '#fff033', butterflySelection: '#44aaff', selectedPart: '#ff2b2b',
      labelText: '#ffffff', labelPart: '#d8d8e8', labelNet: '#c8c8e0',
      netLabelBg: '#000000', netLabelBgOpacity: 0.55, dimColor: '#000000',
      partOutlineTop: '#8f8fc8', partOutlineBottom: '#a08850',
      copperTop: '#3b5bff', copperBottom: '#e0a040',
    },
    palette: {
      pins: {
        signalTop: '#3b5bff', signalBottom: '#e0a040', power: '#3b5bff', rail: '#3b5bff',
        ground: '#5a5f9a', agnd: '#5a5f9a', serial: '#3b5bff', pci: '#3b5bff', ddr: '#3b5bff',
        enable: '#3b5bff', onoff: '#3b5bff', nc: '#55558f',
      },
      partTints: null, boardFillAlpha: 1, showPin1Marker: false,
    },
  },
  light: {
    id: 'light',
    label: 'Light',
    // Paper-white sheet, dark ink. Part tints reuse the pin hues (rail 29,
    // crystal 48, logic 174, data 213, on/off 262, one green), so parts and
    // pins are one family. Red means power only; the underside is violet.
    ui: {
      bgPrimary: '#eceef1', bgSecondary: '#dee0e3', bgTertiary: '#dde0e4', textPrimary: '#1c1f24',
      textSecondary: '#5b616b', accent: '#2f6db5', border: '#c2c5c9', iconBoardBg: '#3f9142', iconPdfBg: '#c0392b',
    },
    board: {
      canvasBackground: '#e6e8eb', boardFill: '#ffffff', outline: '#5d6672',
      selection: '#c26f00', butterflySelection: '#2f6db5', selectedPart: '#15191e',
      labelText: '#15191e', labelPart: '#15191e', labelNet: '#1f4f8f',
      netLabelBg: '#ffffff', netLabelBgOpacity: 0.72, dimColor: '#e6e8eb',
      partOutlineTop: '#5d6672', partOutlineBottom: '#7a5fb0',
      copperTop: '#1f63d6', copperBottom: '#d95f0e',
    },
    palette: {
      pins: {
        signalTop: '#5d6672', signalBottom: '#7a5fb0', power: '#d7261e', rail: '#d95f0e',
        ground: '#8c939c', agnd: '#8c939c', serial: '#b8338f', pci: '#1f63d6', ddr: '#3d82d8',
        enable: '#0e8f84', onoff: '#7a4fd6', nc: '#878e97',
      },
      partTints: {
        resistor: '#eae5e1', capacitor: '#f0ecdb', inductor: '#e3e5e8', diode: '#dae4f1', crystal: '#f4eed7',
        transistor: '#dbf0ee', ic: '#e3ddee', connector: '#dfe5ec', fuse: '#e6e6e6', testpoint: '#deedde', shield: '#e6e6e6',
      },
      componentFillAlpha: 0.95, boardFillAlpha: 1, fadeLargeBodies: true,
    },
  },
  atari: {
    id: 'atari',
    label: 'Atari (light)',
    // The 2600's silver label and black ink. Every colour is one of the five
    // rainbow-stripe hues (green #4faf4a, yellow #f4e325, orange #fe8b1f,
    // red #ed3823, blue #2a3192) at a set lightness: pale tints for parts,
    // deep shades for pins (red power, orange rails, blue data, green logic),
    // muted orange for the woodgrain underside. Six neutrals.
    ui: {
      bgPrimary: '#ececea', bgSecondary: '#dcdcd8', bgTertiary: '#e0e0dc', textPrimary: '#111111',
      textSecondary: '#4a4a48', accent: '#2a3192', border: '#b8b8b4', iconBoardBg: '#3d883a', iconPdfBg: '#c62310',
    },
    board: {
      canvasBackground: '#b8b8b4', boardFill: '#ececea', outline: '#111111',
      selection: '#cb6301', butterflySelection: '#2a3192', selectedPart: '#111111',
      labelText: '#111111', labelPart: '#111111', labelNet: '#2a3192',
      netLabelBg: '#ececea', netLabelBgOpacity: 0.72, dimColor: '#ececea',
      partOutlineTop: '#111111', partOutlineBottom: '#6f4b2a',
      copperTop: '#2a3192', copperBottom: '#cb6301',
    },
    palette: {
      pins: {
        signalTop: '#4a4a48', signalBottom: '#6f4b2a', power: '#c62310', rail: '#cb6301',
        ground: '#86867f', agnd: '#86867f', serial: '#2a3192', pci: '#2a3192', ddr: '#414ac8',
        enable: '#3d883a', onoff: '#316c2d', nc: '#6c6c68',
      },
      partTints: {
        resistor: '#f8ddc4', capacitor: '#f6f2c6', inductor: '#d4e9d3', diode: '#cfd1ed', crystal: '#f6f2c6',
        transistor: '#d4e9d3', ic: '#cfd1ed', connector: '#d4d4d0', fuse: '#f8ddc4', testpoint: '#d4e9d3', shield: '#d4d4d0',
      },
      componentFillAlpha: 1, boardFillAlpha: 1, fadeLargeBodies: true,
    },
  },
};

const STORAGE_KEY = 'boardripper-theme';
const ACCENT_OVERRIDE_KEY = 'boardripper-accent-override';
const BACKGROUND_OVERRIDE_KEY = 'boardripper-background-override';
const CHROME_OVERRIDE_KEY = 'boardripper-chrome-override';
const UI_SCALE_KEY = 'boardripper-ui-scale';
const CUSTOM_THEME_KEY = 'boardripper-custom-theme';
const DEFAULT_ID = 'default';
/** Reserved id for the single user-editable theme (the custom theme editor).
 *  Unlike the built-in THEMES entries it is persisted as user data, not a
 *  constant, and is the only theme whose colours can be edited in the UI. */
export const CUSTOM_ID = 'custom';

/** Interface scaling factor — multiplies the visual size of all chrome
 *  (toolbars, panels, dialogs, sidebar, start page). The BoardViewer and
 *  PDF canvases are counter-zoomed via CSS so their rendered pixel
 *  resolution is unaffected. */
export const UI_SCALE_MIN = 0.50;
export const UI_SCALE_MAX = 1.50;
export const UI_SCALE_STEP = 0.05;
export const UI_SCALE_DEFAULT = 1.00;

function clampScale(n: number): number {
  if (!Number.isFinite(n)) return UI_SCALE_DEFAULT;
  const clamped = Math.max(UI_SCALE_MIN, Math.min(UI_SCALE_MAX, n));
  return Math.round(clamped / UI_SCALE_STEP) * UI_SCALE_STEP;
}

function loadScale(): number {
  try {
    const raw = localStorage.getItem(UI_SCALE_KEY);
    if (!raw) return UI_SCALE_DEFAULT;
    const n = parseFloat(raw);
    if (!Number.isFinite(n)) return UI_SCALE_DEFAULT;
    return clampScale(n);
  } catch {
    return UI_SCALE_DEFAULT;
  }
}

function saveScale(n: number | null) {
  try {
    if (n == null || n === UI_SCALE_DEFAULT) localStorage.removeItem(UI_SCALE_KEY);
    else localStorage.setItem(UI_SCALE_KEY, String(n));
  } catch { /* quota — ignore */ }
}

/** Apply --ui-scale CSS var. Read by the body { zoom: var(--ui-scale) }
 *  rule in index.css; canvas containers counter-zoom via the same var. */
export function applyUiScaleToDOM(scale: number) {
  document.documentElement.style.setProperty('--ui-scale', String(scale));
}

/**
 * Architecture note — themes vs interface knobs.
 *
 * The `THEMES` registry was originally a kitchen-sink theme: UI chrome
 * + board canvas + render-settings overrides bundled per id. The user
 * has clarified that **themes should be for boards**, not the interface.
 * Going forward:
 *
 *   - Theme  — board-side concerns: canvas background, board fill,
 *              outline / selection / butterfly / labelText, plus any
 *              `boardOverrides` (settings overlays like Landrex super-
 *              monochrome). Selectable via setTheme().
 *   - Knobs  — interface-side: 3 simple colours the user picks freely.
 *              `accent` (signal indicators), `background` (canvas + the
 *              interactive surface tier), `chrome` (toolbar / status /
 *              tab strips). Each cascades into the related CSS vars.
 *
 * Right now `theme.ui.*` still ships per theme as a *fallback default*
 * for the knobs — when no override is set, the active theme's UI tokens
 * paint chrome. The end-state is to retire `theme.ui.*` and have a
 * single neutral baseline; the override knobs become the only path to
 * change interface chrome. Tracked separately from this registry edit.
 */

/**
 * Curated accent presets used by both the SettingsPanel and the home
 * dashboard picker. Adding a preset = one append; both surfaces pick it up.
 *
 * Deep-research notes on the Atari palette
 * (after a request to verify rather than guess):
 *
 *   - The classical Atari Fuji logo (designed by George Opperman, first
 *     used 1972–73) was MONOCHROME — black on white — for ~30 years.
 *     There is no "classical Atari red".
 *   - The official red was introduced in 2002 in a corporate refresh.
 *     Documented spec: Pantone Bright Red C, #E5141E, RGB 229/20/30,
 *     CMYK 0/91/87/10. (Some secondary sources cite #E01E2B as a slightly
 *     different web rendering of the same Pantone.)
 *   - The "Atari rainbow" — five vertical stripes of green / yellow /
 *     orange / red / blue — lives on the 1983 Atari 2600 silver-label
 *     cartridges and the "long/short rainbow" 2600 console variants. This
 *     is packaging / industrial-design art, NOT the Fuji logo itself, but
 *     is widely associated with the brand and is a useful era-evocative
 *     palette for an interface accent.
 *   - The arcade marquee gradient (red→orange→gold inside the Fuji on
 *     Asteroids / Centipede / Tempest cabinets) was a separate marketing
 *     treatment — dropped here because the rainbow stripe is the
 *     better-documented Atari heritage palette.
 *
 * Sources: fabrikbrands.com (explicit hex/Pantone for Fuji red),
 * 1000logos.net, logodesignlove.com, AtariAge forums (rainbow cartridge
 * variants), Wikipedia (Atari, Inc. + Atari 2600 articles).
 */
export const ACCENT_PRESETS: ReadonlyArray<{ hex: string; label: string }> = [
  { hex: '#4a9eff', label: 'BoardRipper default' },
  // Pantone Bright Red C — the canonical post-2002 Atari Fuji red.
  { hex: '#e5141e', label: 'ATARI Red (Pantone Bright Red C)' },
  // Atari 2600 silver-label rainbow stripe (1983) — five-bar packaging
  // palette also used on "long/short rainbow" 2600 consoles. Sampled from
  // the cartridge label artwork; values are commonly-cited reproductions.
  { hex: '#4faf4a', label: 'Atari rainbow — green' },
  { hex: '#f4e325', label: 'Atari rainbow — yellow' },
  { hex: '#fe8b1f', label: 'Atari rainbow — orange' },
  { hex: '#ed3823', label: 'Atari rainbow — red' },
  { hex: '#2a3192', label: 'Atari rainbow — blue' },
  // Non-Atari, non-cliché alternates.
  { hex: '#ff3aa1', label: 'Hot magenta' },
  { hex: '#b8ff2b', label: 'Acid lime' },
  { hex: '#9c6bff', label: 'Deep violet' },
  { hex: '#00c7b7', label: 'Teal' },
];

interface PersistedTheme {
  activeId: string;
}

/** Schemes retired in the 2026-10-11 review; an install that had one picked
 *  moves to its replacement instead of falling back to Default. */
const RETIRED_THEMES: Record<string, string> = { 'drafting-paper': 'light', daylight: 'light', 'blueprint-light': 'light' };

function loadFromStorage(): string {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_ID;
    const parsed = JSON.parse(raw) as PersistedTheme;
    if (parsed?.activeId && RETIRED_THEMES[parsed.activeId]) return RETIRED_THEMES[parsed.activeId];
    // CUSTOM_ID is valid even though it isn't in THEMES — activeTheme() falls
    // back to default if the custom theme blob is missing.
    if (parsed?.activeId && (THEMES[parsed.activeId] || parsed.activeId === CUSTOM_ID)) return parsed.activeId;
    log.ui.warn(`themes: unknown activeId in localStorage: ${parsed?.activeId} — falling back to '${DEFAULT_ID}'`);
    return DEFAULT_ID;
  } catch {
    return DEFAULT_ID;
  }
}

function saveToStorage(activeId: string) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ activeId } as PersistedTheme));
  } catch { /* quota — ignore */ }
}

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

function loadHexOverride(key: string): string | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return HEX_RE.test(raw) ? raw : null;
  } catch {
    return null;
  }
}

function saveHexOverride(key: string, hex: string | null) {
  try {
    if (hex == null) localStorage.removeItem(key);
    else localStorage.setItem(key, hex);
  } catch { /* quota — ignore */ }
}

/** A clone of `src` re-stamped as the editable custom theme. Used to seed the
 *  custom theme from whatever theme is active when the user first edits it, so
 *  they start from a familiar palette rather than a blank slate. */
function seedCustomFrom(src: Theme): Theme {
  return {
    id: CUSTOM_ID,
    label: 'Custom',
    ui: { ...src.ui },
    board: { ...src.board },
    // boardOverrides start empty: the custom theme only overrides global
    // render-settings (pin / net colours) once the user explicitly opts in.
    boardOverrides: src.boardOverrides ? structuredClone(src.boardOverrides) : undefined,
    palette: src.palette ? structuredClone(src.palette) : undefined,
  };
}

function loadCustomTheme(): Theme | null {
  try {
    const raw = localStorage.getItem(CUSTOM_THEME_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Theme;
    // Minimal shape validation — a corrupt blob shouldn't brick the app.
    if (!parsed?.ui?.bgPrimary || !parsed?.board?.canvasBackground) return null;
    parsed.id = CUSTOM_ID;
    if (!parsed.label) parsed.label = 'Custom';
    return parsed;
  } catch {
    return null;
  }
}

function saveCustomTheme(theme: Theme | null) {
  try {
    if (theme == null) localStorage.removeItem(CUSTOM_THEME_KEY);
    else localStorage.setItem(CUSTOM_THEME_KEY, JSON.stringify(theme));
  } catch { /* quota — ignore */ }
}

interface UiOverrides {
  accent: string | null;
  background: string | null;
  chrome: string | null;
}

/** Apply a theme's UI + canvas colors to CSS custom properties on <html>.
 *  Each override replaces the corresponding theme token and cascades into
 *  related siblings (siblings shade *away* from the base's luminance pole —
 *  lighten on dark, darken on light — via shadeToward):
 *    - background  → --bg-primary; --bg-secondary derived; text auto-flips
 *    - chrome      → --bg-tertiary; --border derived
 *    - accent      → --accent; --accent-fg auto-flips; --accent-hover in CSS
 */
export function applyThemeToDOM(theme: Theme, overrides: Partial<UiOverrides> = {}) {
  const root = document.documentElement;
  const { accent, background, chrome } = overrides;

  // Tier siblings are derived with shadeToward (not plain lightenHex) so a
  // light background/chrome produces a darker — therefore visible — sibling
  // instead of running into white. The non-override path now also derives
  // the sibling rather than trusting theme.ui.bg{Secondary,border}; this lets
  // a theme declare just bgPrimary/bgTertiary and get a correct tier for free,
  // and keeps knob and theme paths consistent.
  const effBg = background ?? theme.ui.bgPrimary;
  root.style.setProperty('--bg-primary',   effBg);
  root.style.setProperty('--bg-secondary', background ? shadeToward(effBg, 0.06) : theme.ui.bgSecondary);

  const effChrome = chrome ?? theme.ui.bgTertiary;
  root.style.setProperty('--bg-tertiary', effChrome);
  root.style.setProperty('--border',      chrome ? shadeToward(effChrome, 0.12) : theme.ui.border);

  // Body text is derived from the effective background's luminance so it
  // stays readable when the background knob (or a light theme) flips the base
  // from dark to light. Dark backgrounds reproduce the historical pair, so
  // existing dark themes are unchanged.
  const text = pickTextColors(effBg);
  root.style.setProperty('--text-primary',   text.primary);
  root.style.setProperty('--text-secondary', text.secondary);
  const effAccent = accent ?? theme.ui.accent;
  root.style.setProperty('--accent', effAccent);
  // --accent-fg = the text colour that reads on top of an accent-tinted
  // surface. Auto-flipped to dark when the accent is bright enough that
  // white text would blend in (yellow / gold / lime / pale teal). Replaces
  // the previously hardcoded `color: #fff` paired with accent backgrounds.
  root.style.setProperty('--accent-fg', pickAccentFg(effAccent));
  // --accent-text = the accent shaded (only when needed) to stay legible as
  // *text* on the effective background. Bright accents (Atari yellow, acid
  // lime) plus a light theme would otherwise render near-invisible accent
  // text; foreground `color:` sites in index.css read --accent-text, while
  // accent-as-background / border / glow sites keep the pure --accent hue.
  root.style.setProperty('--accent-text', accentTextColor(effAccent, effBg));
  // --accent-hover is derived from --accent in index.css via color-mix.
  root.style.setProperty('--canvas-bg',      theme.board.canvasBackground);
  root.style.setProperty('--icon-board-bg',  theme.ui.iconBoardBg);
  root.style.setProperty('--icon-pdf-bg',    theme.ui.iconPdfBg);

  // Board-side colours mirrored as CSS vars. The PixiJS scene reads these
  // through BOARD_COLORS (JS), not CSS — but exposing them on :root gives the
  // visibility test harness a single DOM source of truth for every theme
  // colour, and is the hook the upcoming custom-theme editor reads/writes.
  root.style.setProperty('--board-fill',         theme.board.boardFill);
  root.style.setProperty('--board-outline',      theme.board.outline);
  root.style.setProperty('--board-selection',    theme.board.selection);
  root.style.setProperty('--board-butterfly',    theme.board.butterflySelection);
  root.style.setProperty('--board-label-text',   theme.board.labelText);
  root.style.setProperty('--board-label-part',   theme.board.labelPart);
  root.style.setProperty('--board-label-net',    theme.board.labelNet);
}

class ThemeStore extends Emitter {
  private _activeId: string = DEFAULT_ID;
  private _accentOverride: string | null = null;
  private _backgroundOverride: string | null = null;
  private _chromeOverride: string | null = null;
  private _scale: number = UI_SCALE_DEFAULT;
  private _customTheme: Theme | null = null;
  private _initialized = false;
  private _switch: { seq: number; prev: Theme } = { seq: 0, prev: THEMES[DEFAULT_ID] };

  /** The last explicit scheme switch: a counter and the scheme left behind.
   *  Knob changes (accent, background, chrome) notify too but never move it. */
  get lastSwitch(): { seq: number; prev: Theme } { return this._switch; }

  /** Call once at app startup. Idempotent — second call no-ops. */
  init(): void {
    if (this._initialized) return;
    this._customTheme = loadCustomTheme();
    this._activeId = loadFromStorage();
    this._accentOverride = loadHexOverride(ACCENT_OVERRIDE_KEY);
    this._backgroundOverride = loadHexOverride(BACKGROUND_OVERRIDE_KEY);
    this._chromeOverride = loadHexOverride(CHROME_OVERRIDE_KEY);
    this._scale = loadScale();
    this.applyAll();
    applyUiScaleToDOM(this._scale);
    this._initialized = true;
  }

  get activeId(): string {
    return this._activeId;
  }

  /** User's accent override, or null if the theme's default is in use. */
  get accentOverride(): string | null {
    return this._accentOverride;
  }
  /** User's background (canvas + surface tier) override, or null. */
  get backgroundOverride(): string | null {
    return this._backgroundOverride;
  }
  /** User's chrome (toolbar / status / tabs / border tier) override, or null. */
  get chromeOverride(): string | null {
    return this._chromeOverride;
  }

  /** The accent currently driving --accent (override if set, else theme default). */
  get effectiveAccent(): string {
    return this._accentOverride ?? this.activeTheme().ui.accent;
  }
  /** Effective canvas background — drives --bg-primary. */
  get effectiveBackground(): string {
    return this._backgroundOverride ?? this.activeTheme().ui.bgPrimary;
  }
  /** Effective chrome colour — drives --bg-tertiary. */
  get effectiveChrome(): string {
    return this._chromeOverride ?? this.activeTheme().ui.bgTertiary;
  }

  /** Current interface scaling factor (1.0 = 100%). */
  get scale(): number {
    return this._scale;
  }

  activeTheme(): Theme {
    if (this._activeId === CUSTOM_ID && this._customTheme) return this._customTheme;
    return THEMES[this._activeId] ?? THEMES[DEFAULT_ID];
  }

  /** The editable custom theme, or null if the user hasn't created one yet. */
  get customTheme(): Theme | null {
    return this._customTheme;
  }
  /** True when the custom theme is the active one. */
  get isCustomActive(): boolean {
    return this._activeId === CUSTOM_ID && this._customTheme != null;
  }

  private applyAll(): void {
    applyThemeToDOM(this.activeTheme(), {
      accent: this._accentOverride,
      background: this._backgroundOverride,
      chrome: this._chromeOverride,
    });
  }

  setTheme(id: string): void {
    if (id === CUSTOM_ID) {
      // Selecting Custom seeds it from the current theme on first use so the
      // user starts from a familiar palette rather than an empty one.
      this.ensureCustom();
    } else if (!THEMES[id]) {
      log.ui.warn(`themes: setTheme called with unknown id '${id}' — ignored`);
      return;
    }
    if (id === this._activeId) return;
    this._switch = { seq: this._switch.seq + 1, prev: this.activeTheme() };
    this._activeId = id;
    saveToStorage(id);
    this.applyAll();
    this.notify();
  }

  /** Create the custom theme (seeded from the currently-active theme) if it
   *  doesn't exist yet. Returns the custom theme. Does not switch to it. */
  ensureCustom(): Theme {
    if (!this._customTheme) {
      this._customTheme = seedCustomFrom(this.activeTheme());
      saveCustomTheme(this._customTheme);
    }
    return this._customTheme;
  }

  /**
   * Patch the custom theme's colours. Accepts partial `ui` / `board` colour
   * maps and a `boardOverrides` patch (pin / net colours that override the
   * GLOBAL render settings while the custom theme is active — the same
   * mechanism Landrex uses). Creates the custom theme first if needed.
   * Re-applies + notifies immediately if the custom theme is active.
   */
  updateCustom(patch: {
    ui?: Partial<Theme['ui']>;
    board?: Partial<Theme['board']>;
    boardOverrides?: Partial<RenderSettings> | null;
  }): void {
    const base = this.ensureCustom();
    const next: Theme = {
      ...base,
      ui: { ...base.ui, ...(patch.ui ?? {}) },
      board: { ...base.board, ...(patch.board ?? {}) },
    };
    if (patch.boardOverrides !== undefined) {
      // null clears overrides entirely; an object merges into existing ones.
      next.boardOverrides = patch.boardOverrides == null
        ? undefined
        : { ...(base.boardOverrides ?? {}), ...patch.boardOverrides };
    }
    this._customTheme = next;
    saveCustomTheme(next);
    if (this._activeId === CUSTOM_ID) this.applyAll();
    // Always notify: the editor UI re-renders even when previewing while the
    // custom theme isn't the active one. The boardOverrides re-merge is gated
    // by the subscriber at the bottom of this module.
    this.notify();
  }

  /**
   * Set or clear a single board-override key on the custom theme (the "pin
   * colours act as overrides over the global render settings" model). Passing
   * null removes the key so that field falls back to the global setting; the
   * `boardOverrides` object is dropped entirely once it's empty.
   */
  setCustomOverride<K extends keyof RenderSettings>(key: K, value: RenderSettings[K] | null): void {
    const base = this.ensureCustom();
    const ov: Partial<RenderSettings> = { ...(base.boardOverrides ?? {}) };
    if (value == null) delete ov[key];
    else ov[key] = value;
    const next: Theme = { ...base, boardOverrides: Object.keys(ov).length ? ov : undefined };
    this._customTheme = next;
    saveCustomTheme(next);
    if (this._activeId === CUSTOM_ID) this.applyAll();
    this.notify();
  }

  /**
   * Overwrite the custom slot with a clone of the currently-active theme and
   * switch to it. The copy-to-custom-on-edit entry point: lets the colour
   * editors fork whatever built-in theme is active (preserving its palette)
   * into the single editable slot, rather than seeding from default.
   */
  forkToCustom(): void {
    this._customTheme = seedCustomFrom(this.activeTheme());
    saveCustomTheme(this._customTheme);
    if (this._activeId !== CUSTOM_ID) {
      this._activeId = CUSTOM_ID;
      saveToStorage(CUSTOM_ID);
    }
    this.applyAll();
    this.notify();
  }

  /** Delete the custom theme and, if it was active, fall back to default. */
  resetCustom(): void {
    this._customTheme = null;
    saveCustomTheme(null);
    if (this._activeId === CUSTOM_ID) {
      this._activeId = DEFAULT_ID;
      saveToStorage(DEFAULT_ID);
      this.applyAll();
    }
    this.notify();
  }

  /** Override the active theme's accent. Pass null to revert to the theme's
   *  built-in accent. Persisted independently of the active theme. */
  setAccent(hex: string | null): void {
    if (hex != null && !HEX_RE.test(hex)) {
      log.ui.warn(`themes: setAccent called with invalid hex '${hex}' — ignored`);
      return;
    }
    if (hex === this._accentOverride) return;
    this._accentOverride = hex;
    saveHexOverride(ACCENT_OVERRIDE_KEY, hex);
    this.applyAll();
    this.notify();
  }

  /** Override the canvas + surface background. Drives --bg-primary directly
   *  and --bg-secondary as a lightened sibling. Pass null to revert. */
  setBackground(hex: string | null): void {
    if (hex != null && !HEX_RE.test(hex)) {
      log.ui.warn(`themes: setBackground called with invalid hex '${hex}' — ignored`);
      return;
    }
    if (hex === this._backgroundOverride) return;
    this._backgroundOverride = hex;
    saveHexOverride(BACKGROUND_OVERRIDE_KEY, hex);
    this.applyAll();
    this.notify();
  }

  /** Override the chrome / passive-element tier. Drives --bg-tertiary
   *  directly and --border as a lifted sibling. Pass null to revert. */
  setChrome(hex: string | null): void {
    if (hex != null && !HEX_RE.test(hex)) {
      log.ui.warn(`themes: setChrome called with invalid hex '${hex}' — ignored`);
      return;
    }
    if (hex === this._chromeOverride) return;
    this._chromeOverride = hex;
    saveHexOverride(CHROME_OVERRIDE_KEY, hex);
    this.applyAll();
    this.notify();
  }

  /** Set the global interface scaling factor. Pass null to reset to 100%.
   *  Out-of-range values are clamped to [UI_SCALE_MIN, UI_SCALE_MAX] and
   *  snapped to UI_SCALE_STEP. The slider commits this on pointer-up only;
   *  there's no ephemeral path because mid-drag rescaling resizes the
   *  slider control itself, breaking the drag. */
  setScale(n: number | null): void {
    const next = n == null ? UI_SCALE_DEFAULT : clampScale(n);
    if (next === this._scale) {
      saveScale(n == null ? null : next);
      return;
    }
    this._scale = next;
    applyUiScaleToDOM(next);
    saveScale(n == null ? null : next);
    this.notify();
  }

  /** All available themes, sorted by label for UI display. The custom theme
   *  (when it exists) is appended last so it sits below the built-ins. */
  list(): Theme[] {
    const builtins = Object.values(THEMES).sort((a, b) => a.label.localeCompare(b.label));
    return this._customTheme ? [...builtins, this._customTheme] : builtins;
  }
}

export const themeStore = new ThemeStore();

// Wire theme overrides into render-settings. The provider is read by
// renderSettingsStore.recomputeEffective() — calling .recomputeEffective()
// directly would be cleaner but that method is private; setActiveBoard is
// the public hook used elsewhere for the same purpose.
setThemeOverridesProvider((global) => {
  const t = themeStore.activeTheme();
  if (!t.palette) return t.boardOverrides;
  // A palette theme's colours, then the custom theme's own edits on top.
  return { ...paletteOverrides(t.palette, global), ...(t.boardOverrides ?? {}) };
});

// On theme change, force render-settings to re-merge so the new theme's
// boardOverrides take effect. We poke applyGlobal to trigger the existing
// recompute path without changing state.
//
// IMPORTANT: themeStore.notify() fires on EVERY interface knob change —
// accent / background / chrome picks too — and those are pure-UI CSS-variable
// changes that carry no boardOverrides. Poking applyGlobal on each of them
// forces a full structuredClone + localStorage write + global notify for a
// cosmetic change. Gate the poke so it only fires when board rendering can
// actually be affected: the active theme has boardOverrides now, OR the
// previous active theme had them (so a switch away from an override theme
// still clears the stale overlay — e.g. leaving Landrex).
const themeHasOverrides = () => { const t = themeStore.activeTheme(); return !!t.boardOverrides || !!t.palette; };
let _prevThemeHadOverrides = themeHasOverrides();
themeStore.subscribe(() => {
  const hasOverrides = themeHasOverrides();
  if (!hasOverrides && !_prevThemeHadOverrides) {
    // Pure-UI knob change with no board-override involvement either way —
    // nothing for render-settings to re-merge.
    return;
  }
  _prevThemeHadOverrides = hasOverrides;
  const cur = renderSettingsStore.activeBoard;
  // setActiveBoard short-circuits when the value is unchanged unless either
  // side has overrides — bypass that by using applyGlobal which always
  // recomputes + notifies. Pass the current global snapshot unchanged.
  renderSettingsStore.applyGlobal(renderSettingsStore.globalSnapshot());
  // Restore active board if applyGlobal cleared it (it shouldn't, but be safe).
  if (cur && renderSettingsStore.activeBoard !== cur) {
    renderSettingsStore.setActiveBoard(cur);
  }
});
