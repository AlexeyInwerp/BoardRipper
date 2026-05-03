/**
 * Theme store — persists the selected theme id and applies it to the
 * <html> element via [data-theme]. Imported once from main.tsx so the
 * attribute is set before first paint.
 */
import { Emitter } from '../store/emitter';
import { themes, DEFAULT_THEME_ID, isValidTheme } from './themes';

const STORAGE_KEY = 'boardripper-theme';

class ThemeStore extends Emitter {
  private _id: string = (() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved && isValidTheme(saved)) return saved;
    } catch {
      /* private mode / disabled storage */
    }
    return DEFAULT_THEME_ID;
  })();

  constructor() {
    super();
    this.apply();
  }

  /** Currently active theme id. */
  get id(): string {
    return this._id;
  }

  /** All registered themes (re-exported for hook consumers). */
  get themes() {
    return themes;
  }

  setId(id: string): void {
    if (!isValidTheme(id) || id === this._id) return;
    this._id = id;
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch {
      /* ignore quota / disabled storage */
    }
    this.apply();
    this.notify();
  }

  private apply(): void {
    if (typeof document === 'undefined') return;
    document.documentElement.setAttribute('data-theme', this._id);
  }
}

export const themeStore = new ThemeStore();
