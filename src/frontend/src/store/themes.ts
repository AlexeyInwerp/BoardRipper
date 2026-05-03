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
const DEFAULT_ID = 'default';

/**
 * Curated accent presets used by both the SettingsPanel and the home
 * dashboard picker. Adding a preset = one append; both surfaces pick it up.
 *
 * The ATARI grouping anchors on the corporate Fuji red (Pantone 185 ≈
 * #E2231A) — the only colour that's strictly the classical ATARI brand.
 * The orange + gold come from the arcade-marquee gradient art inside
 * the Fuji shape on Asteroids / Centipede / Tempest cabinets — culturally
 * "ATARI colours" but not part of the logo proper. Labelled "(Atari
 * marquee)" so the attribution stays honest.
 */
export const ACCENT_PRESETS: ReadonlyArray<{ hex: string; label: string }> = [
  { hex: '#4a9eff', label: 'BoardRipper default' },
  { hex: '#e2231a', label: 'ATARI Red' },
  { hex: '#f77f00', label: 'Arcade orange (Atari marquee)' },
  { hex: '#fcbf49', label: 'Arcade gold (Atari marquee)' },
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

function loadAccentOverride(): string | null {
  try {
    const raw = localStorage.getItem(ACCENT_OVERRIDE_KEY);
    if (!raw) return null;
    return HEX_RE.test(raw) ? raw : null;
  } catch {
    return null;
  }
}

function saveAccentOverride(hex: string | null) {
  try {
    if (hex == null) localStorage.removeItem(ACCENT_OVERRIDE_KEY);
    else localStorage.setItem(ACCENT_OVERRIDE_KEY, hex);
  } catch { /* quota — ignore */ }
}

/** Apply a theme's UI + canvas colors to CSS custom properties on <html>.
 *  When `accentOverride` is non-null it replaces the theme's `--accent`. */
export function applyThemeToDOM(theme: Theme, accentOverride: string | null = null) {
  const root = document.documentElement;
  root.style.setProperty('--bg-primary',     theme.ui.bgPrimary);
  root.style.setProperty('--bg-secondary',   theme.ui.bgSecondary);
  root.style.setProperty('--bg-tertiary',    theme.ui.bgTertiary);
  root.style.setProperty('--text-primary',   theme.ui.textPrimary);
  root.style.setProperty('--text-secondary', theme.ui.textSecondary);
  root.style.setProperty('--accent',         accentOverride ?? theme.ui.accent);
  root.style.setProperty('--border',         theme.ui.border);
  root.style.setProperty('--canvas-bg',      theme.board.canvasBackground);
  root.style.setProperty('--icon-board-bg',  theme.ui.iconBoardBg);
  root.style.setProperty('--icon-pdf-bg',    theme.ui.iconPdfBg);
  // Note: --accent-hover is derived from --accent via color-mix in
  // index.css, so no JS work is needed to update it.
}

/** Convert '#rrggbb' to a 24-bit integer for PixiJS color arguments. */
export function hexToInt(hex: string): number {
  return parseInt(hex.slice(1), 16);
}

class ThemeStore extends Emitter {
  private _activeId: string = DEFAULT_ID;
  private _accentOverride: string | null = null;
  private _initialized = false;

  /** Call once at app startup. Idempotent — second call no-ops. */
  init(): void {
    if (this._initialized) return;
    this._activeId = loadFromStorage();
    this._accentOverride = loadAccentOverride();
    applyThemeToDOM(this.activeTheme(), this._accentOverride);
    this._initialized = true;
  }

  get activeId(): string {
    return this._activeId;
  }

  /** User's accent override, or null if the theme's default is in use. */
  get accentOverride(): string | null {
    return this._accentOverride;
  }

  /** The accent currently driving --accent (override if set, else theme default). */
  get effectiveAccent(): string {
    return this._accentOverride ?? this.activeTheme().ui.accent;
  }

  activeTheme(): Theme {
    return THEMES[this._activeId] ?? THEMES[DEFAULT_ID];
  }

  setTheme(id: string): void {
    if (!THEMES[id]) {
      log.ui.warn(`themes: setTheme called with unknown id '${id}' — ignored`);
      return;
    }
    if (id === this._activeId) return;
    this._activeId = id;
    saveToStorage(id);
    applyThemeToDOM(this.activeTheme(), this._accentOverride);
    this.notify();
  }

  /** Override the active theme's accent. Pass null to revert to the theme's
   *  built-in accent. Persisted to localStorage so the override survives
   *  across reloads independent of the active theme. */
  setAccent(hex: string | null): void {
    if (hex != null && !HEX_RE.test(hex)) {
      log.ui.warn(`themes: setAccent called with invalid hex '${hex}' — ignored`);
      return;
    }
    if (hex === this._accentOverride) return;
    this._accentOverride = hex;
    saveAccentOverride(hex);
    applyThemeToDOM(this.activeTheme(), this._accentOverride);
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
