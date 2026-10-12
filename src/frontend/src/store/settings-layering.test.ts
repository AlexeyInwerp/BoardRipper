/**
 * Layering of render settings: global ⊕ board overrides ⊕ theme overlay.
 *
 * A palette scheme (Light, Dark, Landrex, Atari) is an overlay, never part of
 * what is stored: board overrides are diffed against global without it, a
 * Settings preview keeps it, and the stored scheme is merged at startup before
 * any board opens.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';

type RS = typeof import('./render-settings');
type TH = typeof import('./themes');
let rs: RS;
let th: TH;

const BOARD = 'layering-test.kicad_pcb';

beforeAll(async () => {
  const mem = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => { mem.set(k, String(v)); },
    removeItem: (k: string) => { mem.delete(k); },
    clear: () => mem.clear(),
    key: (i: number) => [...mem.keys()][i] ?? null,
    get length() { return mem.size; },
  };
  (globalThis as { document?: unknown }).document = {
    documentElement: { style: { setProperty: () => {}, removeProperty: () => {} } },
  };
  // The stored scheme is Light, as on an install that picked it last session.
  mem.set('boardripper-theme', JSON.stringify({ activeId: 'light' }));
  rs = await import('./render-settings');
  th = await import('./themes');
});

afterEach(() => {
  rs.renderSettingsStore.clearBoardOverrides(BOARD);
  rs.renderSettingsStore.setActiveBoard('');
  th.themeStore.setTheme('light');
});

const light = () => th.THEMES.light.palette!;

describe('settings layering', () => {
  it('the stored palette scheme is merged at startup, with no board open', () => {
    const store = rs.renderSettingsStore;
    // Before init the provider is registered but the scheme is still Default.
    expect(store.settings.defaultPinColorTop).toBe(store.globalSettings.defaultPinColorTop);
    th.themeStore.init();
    expect(th.themeStore.activeId).toBe('light');
    expect(store.settings.defaultPinColorTop).toBe(light().pins.signalTop);
    expect(store.settings.ambientDim).toBe(false);
  });

  it('boardSnapshot carries no palette keys', () => {
    const store = rs.renderSettingsStore;
    store.setActiveBoard(BOARD);
    const snap = store.boardSnapshot();
    const g = store.globalSettings;
    expect(snap.defaultPinColorTop).toBe(g.defaultPinColorTop);
    expect(snap.ambientDim).toBe(g.ambientDim);
    expect(snap.pinGroups).toEqual(g.pinGroups);
    expect(snap.partTypes).toEqual(g.partTypes);
    // …while the effective settings do carry it.
    expect(store.settings.defaultPinColorTop).toBe(light().pins.signalTop);
  });

  it('an unedited board snapshot under a palette yields no overrides', () => {
    const store = rs.renderSettingsStore;
    store.setActiveBoard(BOARD);
    expect(rs.computeOverrides(store.globalSettings, store.boardSnapshot())).toEqual({});
    const edited = { ...store.boardSnapshot(), pinSizeScale: 1.7 };
    expect(rs.computeOverrides(store.globalSettings, edited)).toEqual({ pinSizeScale: 1.7 });
  });

  it('a board-mode preview keeps the palette', () => {
    const store = rs.renderSettingsStore;
    store.setActiveBoard(BOARD);
    store.previewSettings({ ...store.boardSnapshot(), pinSizeScale: 2.2 }, 'board');
    expect(store.settings.pinSizeScale).toBe(2.2);
    expect(store.settings.defaultPinColorTop).toBe(light().pins.signalTop);
    expect(store.settings.ambientDim).toBe(false);
    store.endPreview();
    expect(store.settings.pinSizeScale).toBe(store.globalSettings.pinSizeScale);
    expect(store.settings.defaultPinColorTop).toBe(light().pins.signalTop);
  });

  it('a global-mode preview keeps the board overrides and the palette', () => {
    const store = rs.renderSettingsStore;
    store.setActiveBoard(BOARD);
    store.setBoardOverrides(BOARD, { pinSizeScale: 3 });
    const w = store.globalSettings.netLineWidth + 1;
    store.previewSettings({ ...store.globalSnapshot(), netLineWidth: w }, 'global');
    expect(store.settings.netLineWidth).toBe(w);
    expect(store.settings.pinSizeScale).toBe(3);
    expect(store.settings.defaultPinColorTop).toBe(light().pins.signalTop);
    store.endPreview();
    expect(store.settings.netLineWidth).toBe(w - 1);
  });

  it("a board's own part types survive a palette", () => {
    const store = rs.renderSettingsStore;
    const partTypes = store.globalSettings.partTypes.map(t => (t.id === 'resistor' ? { ...t, prefixes: ['R', 'RX'], hidden: true } : t));
    store.setBoardOverrides(BOARD, { partTypes });
    store.setActiveBoard(BOARD);
    const r = store.settings.partTypes.find(t => t.id === 'resistor')!;
    expect(r.prefixes).toEqual(['R', 'RX']);
    expect(r.hidden).toBe(true);
    const tint = light().partTints?.resistor;
    if (tint) expect(r.color).toBe(tint);
  });

  it('switching to Default leaves only the edited board key', () => {
    const store = rs.renderSettingsStore;
    store.setActiveBoard(BOARD);
    store.setBoardOverrides(BOARD, rs.computeOverrides(store.globalSettings, { ...store.boardSnapshot(), pinSizeScale: 1.4 }));
    th.themeStore.setTheme('default');
    expect(store.getBoardOverrides(BOARD)).toEqual({ pinSizeScale: 1.4 });
    expect(store.settings.pinGroups).toEqual(store.globalSettings.pinGroups);
    expect(store.settings.ambientDim).toBe(store.globalSettings.ambientDim);
  });

  it('resetCustom bumps lastSwitch only when the active scheme changes', () => {
    const ts = th.themeStore;
    ts.setTheme(th.CUSTOM_ID);
    const seq = ts.lastSwitch.seq;
    ts.resetCustom();
    expect(ts.activeId).toBe('default');
    expect(ts.lastSwitch.seq).toBe(seq + 1);
    expect(ts.lastSwitch.prev.id).toBe(th.CUSTOM_ID);
    ts.ensureCustom();
    ts.resetCustom();   // custom exists but is not active: no switch
    expect(ts.lastSwitch.seq).toBe(seq + 1);
  });

  it('refreshEffective does not notify when nothing changed', () => {
    const store = rs.renderSettingsStore;
    let n = 0;
    const off = store.subscribe(() => { n++; });
    store.refreshEffective();
    expect(n).toBe(0);
    th.themeStore.setTheme('dark');
    expect(n).toBe(1);
    off();
  });
});
