/**
 * The board legend card: open or not, and which mode it shows. One value for
 * every board tab, persisted — the legend is a reference you keep up while
 * you work, not a per-board setting.
 */
import { Emitter } from './emitter';
import { createStoreHook } from '../hooks/createStoreHook';
import { LEGEND_MODES, type LegendMode } from './board-legend';

const KEY = 'boardripper-board-legend';

interface LegendState { open: boolean; mode: LegendMode }

class BoardLegendStore extends Emitter {
  private _state: LegendState = { open: false, mode: 'pins' };

  constructor() {
    super();
    try {
      const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<LegendState> | null;
      if (raw) {
        const mode = LEGEND_MODES.some(m => m.id === raw.mode) ? raw.mode! : 'pins';
        this._state = { open: raw.open === true, mode };
      }
    } catch { /* no storage, or junk in it */ }
  }

  /** Stable until the next change — safe as a useSyncExternalStore snapshot. */
  get state(): LegendState { return this._state; }

  private set(patch: Partial<LegendState>): void {
    const next = { ...this._state, ...patch };
    if (next.open === this._state.open && next.mode === this._state.mode) return;
    this._state = next;
    try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* no storage */ }
    this.notify();
  }

  toggle(): void { this.set({ open: !this._state.open }); }
  close(): void { this.set({ open: false }); }
  setMode(mode: LegendMode): void { this.set({ mode, open: true }); }
}

export const boardLegendStore = new BoardLegendStore();

export const useBoardLegend = createStoreHook(boardLegendStore, () => boardLegendStore.state);
