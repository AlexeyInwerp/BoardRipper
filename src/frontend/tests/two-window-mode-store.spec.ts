import { test, expect } from '@playwright/test';

test.describe('TwoWindowMode store', () => {
  function makeFakeStorage() {
    const m = new Map<string, string>();
    return {
      store: m,
      get: (k: string) => m.get(k) ?? null,
      set: (k: string, v: string) => { m.set(k, v); },
    };
  }

  test('defaults to false when storage empty', async () => {
    const mod = await import('../src/store/two-window-mode');
    const store = mod.createTwoWindowModeStore(makeFakeStorage());
    expect(store.isTwoWindowMode()).toBe(false);
  });

  test('toggle flips the flag and persists', async () => {
    const mod = await import('../src/store/two-window-mode');
    const fs = makeFakeStorage();
    const store = mod.createTwoWindowModeStore(fs);
    store.toggleTwoWindowMode();
    expect(store.isTwoWindowMode()).toBe(true);
    expect(fs.store.get('boardripper-two-window-mode')).toBe('1');
    store.toggleTwoWindowMode();
    expect(store.isTwoWindowMode()).toBe(false);
    expect(fs.store.get('boardripper-two-window-mode')).toBe('0');
  });

  test('listeners fire on change', async () => {
    const mod = await import('../src/store/two-window-mode');
    const store = mod.createTwoWindowModeStore(makeFakeStorage());
    let calls = 0;
    const off = store.onTwoWindowModeChange(() => { calls += 1; });
    store.setTwoWindowMode(true);
    store.setTwoWindowMode(true);   // no-op, same value
    store.setTwoWindowMode(false);
    off();
    store.setTwoWindowMode(true);   // after unsubscribe
    expect(calls).toBe(2);
  });

  test('corrupted storage value is treated as false', async () => {
    const mod = await import('../src/store/two-window-mode');
    const fs = makeFakeStorage();
    fs.store.set('boardripper-two-window-mode', 'garbage');
    const store = mod.createTwoWindowModeStore(fs);
    expect(store.isTwoWindowMode()).toBe(false);
  });
});
