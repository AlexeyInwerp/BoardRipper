import { Emitter } from './emitter';
import { log } from './log-store';

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
  };

  /** Board canvas — drives PixiJS scene constants via the BOARD_COLORS getter. */
  board: {
    canvasBackground: string;
    boardFill: string;
    selection: string;
    butterflySelection: string;
    labelText: string;
  };
}

export const THEMES: Record<string, Theme> = {
  default: {
    id: 'default',
    label: 'BoardRipper Default',
    ui: {
      bgPrimary:     '#0f0f1a',
      bgSecondary:   '#1a1a2e',
      bgTertiary:    '#16213e',
      textPrimary:   '#e0e0e0',
      textSecondary: '#a0a0b0',
      accent:        '#4a9eff',
      border:        '#2a2a40',
    },
    board: {
      canvasBackground:   '#1a1a2e',
      boardFill:          '#ffffff',
      selection:          '#ffff44',
      butterflySelection: '#44aaff',
      labelText:          '#ffffff',
    },
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
      accent:        '#ffff44',
      border:        '#262626',
    },
    board: {
      canvasBackground:   '#000000',
      boardFill:          '#ffffff',
      selection:          '#ffff44',
      butterflySelection: '#44aaff',
      labelText:          '#ffffff',
    },
  },
};

const STORAGE_KEY = 'boardripper-theme';
const DEFAULT_ID = 'default';

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

/** Apply a theme's UI + canvas colors to CSS custom properties on <html>. */
export function applyThemeToDOM(theme: Theme) {
  const root = document.documentElement;
  root.style.setProperty('--bg-primary',     theme.ui.bgPrimary);
  root.style.setProperty('--bg-secondary',   theme.ui.bgSecondary);
  root.style.setProperty('--bg-tertiary',    theme.ui.bgTertiary);
  root.style.setProperty('--text-primary',   theme.ui.textPrimary);
  root.style.setProperty('--text-secondary', theme.ui.textSecondary);
  root.style.setProperty('--accent',         theme.ui.accent);
  root.style.setProperty('--border',         theme.ui.border);
  root.style.setProperty('--canvas-bg',      theme.board.canvasBackground);
}

/** Convert '#rrggbb' to a 24-bit integer for PixiJS color arguments. */
export function hexToInt(hex: string): number {
  return parseInt(hex.slice(1), 16);
}

class ThemeStore extends Emitter {
  private _activeId: string = DEFAULT_ID;
  private _initialized = false;

  /** Call once at app startup. Idempotent — second call no-ops. */
  init(): void {
    if (this._initialized) return;
    this._activeId = loadFromStorage();
    applyThemeToDOM(this.activeTheme());
    this._initialized = true;
  }

  get activeId(): string {
    return this._activeId;
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
    applyThemeToDOM(this.activeTheme());
    this.notify();
  }

  /** All available themes, sorted by label for UI display. */
  list(): Theme[] {
    return Object.values(THEMES).sort((a, b) => a.label.localeCompare(b.label));
  }
}

export const themeStore = new ThemeStore();
