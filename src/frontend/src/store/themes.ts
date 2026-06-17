import { Emitter } from './emitter';
import { log } from './log-store';
import { setThemeOverridesProvider, renderSettingsStore } from './render-settings';
import type { RenderSettings } from './render-settings';
import {
  shadeToward,
  pickAccentFg,
  pickTextColors,
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
  };

  /**
   * Optional render-settings overrides applied while this theme is active.
   * Lets a theme like Landrex enforce a "monochrome supermode" (no
   * component-type colors, no net colors, white pins regardless of side)
   * without the user having to flip every relevant setting by hand.
   * The user's saved settings are restored when the theme is switched off.
   */
  boardOverrides?: Partial<RenderSettings>;
}

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
  landrex: {
    id: 'landrex',
    label: 'Landrex Classic',
    // A plain theme with a mostly-black-and-white board palette (the classic
    // Landrex / OpenBoardView look: black board defined by a white outline).
    // NO boardOverrides — pin/net group colours, component colours and the
    // pin-1 marker all behave exactly like any other theme; the theme just
    // supplies a monochrome base. Interface chrome stays dark (mirrors default).
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
      // Black board defined by a white outline. boardFill matches the canvas so
      // the silhouette reads only via the outline (classic look) AND so white
      // pin/net labels sit on black — readable — instead of white-on-white.
      canvasBackground:   '#000000',
      boardFill:          '#000000',
      outline:            '#ffffff',
      selection:          '#ffff44',
      butterflySelection: '#44aaff',
      labelText:          '#ffffff',   // pin numbers — white on black board
      labelPart:          '#e6e6e6',
      labelNet:           '#c8c8c8',   // net names slightly dimmer than parts
      netLabelBg:         '#000000',
      netLabelBgOpacity:  0.55,
    },
    // No boardOverrides — behaves like any other theme.
  },

  // ──────────────────────────────────────────────────────────────────────
  // Light themes. These are the first themes whose ui.bgPrimary is light;
  // they rely on the luminance-aware machinery added alongside them:
  //   - pickTextColors() flips body text to graphite (theme.ui.text* on a
  //     light base is ignored — the values below are documentation only).
  //   - shadeToward() is used for knob-derived siblings, but the non-override
  //     path reads bgSecondary/border verbatim, so those are pre-darkened.
  // Board side: canvas is a tinted mat, boardFill a near-white sheet on top,
  // outline a dark ink, every label dark, and selection an amber that pops on
  // a light canvas (the dark-theme yellow #ffff44 is invisible on paper).
  // No boardOverrides — the user's render settings ride through unchanged.
  'drafting-paper': {
    id: 'drafting-paper',
    label: 'Drafting Paper (light)',
    ui: {
      bgPrimary:     '#f4f1ea',
      bgSecondary:   '#e5e3dc',
      bgTertiary:    '#e7e2d6',
      textPrimary:   '#1c1f24',
      textSecondary: '#5b616b',
      accent:        '#b5532a',
      border:        '#cbc7bc',
      iconBoardBg:   '#3f9142',
      iconPdfBg:     '#c0392b',
    },
    board: {
      canvasBackground:   '#ece7db',
      boardFill:          '#fbfaf6',
      outline:            '#8a7a5f',
      selection:          '#e0a526',
      butterflySelection: '#2f6db5',
      labelText:          '#2b2722',
      labelPart:          '#5b4f3c',
      labelNet:           '#7a5a2a',
      netLabelBg:         '#fbfaf6',
      netLabelBgOpacity:  0.72,
    },
  },
  daylight: {
    id: 'daylight',
    label: 'Daylight (light)',
    ui: {
      bgPrimary:     '#eceef1',
      bgSecondary:   '#dee0e3',
      bgTertiary:    '#dde0e4',
      textPrimary:   '#1c1f24',
      textSecondary: '#5b616b',
      accent:        '#2f6db5',
      border:        '#c2c5c9',
      iconBoardBg:   '#3f9142',
      iconPdfBg:     '#c0392b',
    },
    board: {
      canvasBackground:   '#e4e7eb',
      boardFill:          '#f8f9fb',
      outline:            '#5a6470',
      selection:          '#e08a1e',
      butterflySelection: '#2f6db5',
      labelText:          '#1f2329',
      labelPart:          '#4a5560',
      labelNet:           '#2f6db5',
      netLabelBg:         '#f8f9fb',
      netLabelBgOpacity:  0.72,
    },
  },
  'blueprint-light': {
    id: 'blueprint-light',
    label: 'Blueprint (light)',
    ui: {
      bgPrimary:     '#e9eef5',
      bgSecondary:   '#dbe0e6',
      bgTertiary:    '#d6dfeb',
      textPrimary:   '#16263a',
      textSecondary: '#52606f',
      accent:        '#1f5fa8',
      border:        '#bcc4cf',
      iconBoardBg:   '#2f7d4f',
      iconPdfBg:     '#b5453a',
    },
    board: {
      canvasBackground:   '#dde6f0',
      boardFill:          '#f3f7fc',
      outline:            '#16263a',
      selection:          '#e0892a',
      butterflySelection: '#1f5fa8',
      labelText:          '#16263a',
      labelPart:          '#2c4663',
      labelNet:           '#1f5fa8',
      netLabelBg:         '#f3f7fc',
      netLabelBgOpacity:  0.72,
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

function loadFromStorage(): string {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_ID;
    const parsed = JSON.parse(raw) as PersistedTheme;
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
setThemeOverridesProvider(() => themeStore.activeTheme().boardOverrides);

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
let _prevThemeHadOverrides = !!themeStore.activeTheme().boardOverrides;
themeStore.subscribe(() => {
  const hasOverrides = !!themeStore.activeTheme().boardOverrides;
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
