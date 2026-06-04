const KEY = 'boardripper-two-window-mode';

export interface ModeStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export interface TwoWindowModeStore {
  isTwoWindowMode(): boolean;
  setTwoWindowMode(enabled: boolean): void;
  toggleTwoWindowMode(): void;
  onTwoWindowModeChange(fn: () => void): () => void;
}

export function createTwoWindowModeStore(storage: ModeStorage): TwoWindowModeStore {
  let value = storage.get(KEY) === '1';
  const listeners = new Set<() => void>();

  return {
    isTwoWindowMode: () => value,
    setTwoWindowMode(enabled: boolean) {
      if (value === enabled) return;
      value = enabled;
      try { storage.set(KEY, enabled ? '1' : '0'); } catch { /* ignore quota */ }
      listeners.forEach(fn => fn());
    },
    toggleTwoWindowMode() {
      this.setTwoWindowMode(!value);
    },
    onTwoWindowModeChange(fn: () => void) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
  };
}

// Browser singleton (uses real localStorage). Imported by the rest of the app.
const browserStorage: ModeStorage = (typeof localStorage !== 'undefined')
  ? {
      get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
      set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
    }
  : { get: () => null, set: () => {} };

const singleton = createTwoWindowModeStore(browserStorage);
export const isTwoWindowMode = singleton.isTwoWindowMode.bind(singleton);
export const setTwoWindowMode = singleton.setTwoWindowMode.bind(singleton);
export const toggleTwoWindowMode = singleton.toggleTwoWindowMode.bind(singleton);
export const onTwoWindowModeChange = singleton.onTwoWindowModeChange.bind(singleton);
