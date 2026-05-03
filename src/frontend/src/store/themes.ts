import { Emitter } from './emitter';
import { log } from './log-store';
import { setThemeOverridesProvider, renderSettingsStore } from './render-settings';
import type { RenderSettings } from './render-settings';

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
    /** Library file-type badge backgrounds. Default uses green/red for
     *  at-a-glance type recognition; monochrome themes (Landrex) lean on
     *  brightness contrast (light vs dark gray) instead so no chromatic
     *  noise leaks into the supermode aesthetic. */
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
    labelText: string;
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
    },
    // Default theme = no overrides. Whatever the user has configured wins.
  },
  landrex: {
    id: 'landrex',
    label: 'Landrex Classic',
    ui: {
      bgPrimary:     '#000000',
      bgSecondary:   '#0a0a0a',
      bgTertiary:    '#141414',
      textPrimary:   '#ffffff',
      textSecondary: '#b0b0b0',
      // Muted mid-gray accent — bright yellow buttons would defeat the
      // "no visual clutter" intent (yellow stays reserved for selection).
      // #888 is dark enough that white button text reads (contrast ~3:1)
      // but light enough to read as the active-tab indicator on near-black bg.
      accent:        '#888888',
      border:        '#262626',
      // Monochrome icons — light gray for B (black letter), dark gray for P
      // (white letter). Brightness contrast carries the type distinction
      // without colour, keeping the supermode aesthetic clean.
      iconBoardBg:   '#aaaaaa',
      iconPdfBg:     '#555555',
    },
    board: {
      canvasBackground:   '#000000',
      boardFill:          '#ffffff',
      outline:            '#ffffff',
      selection:          '#ffff44',
      butterflySelection: '#44aaff',
      labelText:          '#ffffff',
    },
    // Landrex supermode — strip every source of board-content color.
    // User keeps their saved settings; these layer on top while Landrex is
    // active and revert automatically when the user switches back to Default.
    boardOverrides: {
      showComponentColors: false,    // no color-coded part bodies
      showPin1Marker:      false,    // no red pin-1 dot
      defaultPinColorTop:    '#ffffff',
      defaultPinColorBottom: '#ffffff',
      netColorRules:       [],       // no GND/VCC/PP color rules
    },
  },
};

const STORAGE_KEY = 'boardripper-theme';
const ACCENT_OVERRIDE_KEY = 'boardripper-accent-override';
const BACKGROUND_OVERRIDE_KEY = 'boardripper-background-override';
const CHROME_OVERRIDE_KEY = 'boardripper-chrome-override';
const DEFAULT_ID = 'default';

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
    if (parsed?.activeId && THEMES[parsed.activeId]) return parsed.activeId;
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

/** Mix a hex colour toward white by `amount` ∈ [0,1]. Used to derive a
 *  lighter sibling token (e.g. button surface from canvas background) when
 *  the user overrides only the parent token. */
export function lightenHex(hex: string, amount: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const lr = Math.round(r + (255 - r) * amount);
  const lg = Math.round(g + (255 - g) * amount);
  const lb = Math.round(b + (255 - b) * amount);
  const toHex = (n: number) => n.toString(16).padStart(2, '0');
  return `#${toHex(lr)}${toHex(lg)}${toHex(lb)}`;
}

/** WCAG relative luminance ∈ [0,1]. */
function relativeLuminance(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const linearize = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

/** Pick a foreground colour that reads on top of `bgHex`. Flips to dark
 *  text only when the accent is genuinely bright (gold / lime / yellow);
 *  ordinary saturated accents — blue, red, violet, magenta, teal — keep
 *  the white-on-accent look the app has used since v1. The 0.5 luminance
 *  threshold is intentionally above the WCAG-strict cutoff so picking
 *  e.g. ATARI Red doesn't re-skin every accent button as black-text. */
export function pickAccentFg(bgHex: string): string {
  return relativeLuminance(bgHex) > 0.5 ? '#0a0a0a' : '#ffffff';
}

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

interface UiOverrides {
  accent: string | null;
  background: string | null;
  chrome: string | null;
}

/** Apply a theme's UI + canvas colors to CSS custom properties on <html>.
 *  Each override replaces the corresponding theme token and cascades into
 *  related siblings:
 *    - background  → --bg-primary; --bg-secondary derived (lighten 6%)
 *    - chrome      → --bg-tertiary; --border derived (lighten 12%)
 *    - accent      → --accent; --accent-hover derived in CSS via color-mix
 */
export function applyThemeToDOM(theme: Theme, overrides: Partial<UiOverrides> = {}) {
  const root = document.documentElement;
  const { accent, background, chrome } = overrides;

  if (background) {
    root.style.setProperty('--bg-primary',   background);
    root.style.setProperty('--bg-secondary', lightenHex(background, 0.06));
  } else {
    root.style.setProperty('--bg-primary',   theme.ui.bgPrimary);
    root.style.setProperty('--bg-secondary', theme.ui.bgSecondary);
  }

  if (chrome) {
    root.style.setProperty('--bg-tertiary', chrome);
    root.style.setProperty('--border',      lightenHex(chrome, 0.12));
  } else {
    root.style.setProperty('--bg-tertiary', theme.ui.bgTertiary);
    root.style.setProperty('--border',      theme.ui.border);
  }

  root.style.setProperty('--text-primary',   theme.ui.textPrimary);
  root.style.setProperty('--text-secondary', theme.ui.textSecondary);
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
}

/** Convert '#rrggbb' to a 24-bit integer for PixiJS color arguments. */
export function hexToInt(hex: string): number {
  return parseInt(hex.slice(1), 16);
}

class ThemeStore extends Emitter {
  private _activeId: string = DEFAULT_ID;
  private _accentOverride: string | null = null;
  private _backgroundOverride: string | null = null;
  private _chromeOverride: string | null = null;
  private _initialized = false;

  /** Call once at app startup. Idempotent — second call no-ops. */
  init(): void {
    if (this._initialized) return;
    this._activeId = loadFromStorage();
    this._accentOverride = loadHexOverride(ACCENT_OVERRIDE_KEY);
    this._backgroundOverride = loadHexOverride(BACKGROUND_OVERRIDE_KEY);
    this._chromeOverride = loadHexOverride(CHROME_OVERRIDE_KEY);
    this.applyAll();
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

  activeTheme(): Theme {
    return THEMES[this._activeId] ?? THEMES[DEFAULT_ID];
  }

  private applyAll(): void {
    applyThemeToDOM(this.activeTheme(), {
      accent: this._accentOverride,
      background: this._backgroundOverride,
      chrome: this._chromeOverride,
    });
  }

  setTheme(id: string): void {
    if (!THEMES[id]) {
      log.ui.warn(`themes: setTheme called with unknown id '${id}' — ignored`);
      return;
    }
    if (id === this._activeId) return;
    this._activeId = id;
    saveToStorage(id);
    this.applyAll();
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

  /** All available themes, sorted by label for UI display. */
  list(): Theme[] {
    return Object.values(THEMES).sort((a, b) => a.label.localeCompare(b.label));
  }
}

export const themeStore = new ThemeStore();

// Wire theme overrides into render-settings. The provider is read by
// renderSettingsStore.recomputeEffective() — calling .recomputeEffective()
// directly would be cleaner but that method is private; setActiveBoard is
// the public hook used elsewhere for the same purpose.
setThemeOverridesProvider(() => themeStore.activeTheme().boardOverrides);

// On theme change, force render-settings to re-merge so the new theme's
// boardOverrides take effect. We poke setActiveBoard with the current
// active board to trigger the existing recompute path without changing state.
themeStore.subscribe(() => {
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
