/**
 * The board legend card: open or not, and which mode it shows. One value for
 * every board tab, persisted — the legend is a reference you keep up while
 * you work, not a per-board setting.
 */
import { Emitter } from './emitter';
import { createStoreHook } from '../hooks/createStoreHook';
import { LEGEND_MODES, type LegendMode } from './board-legend';

const KEY = 'boardripper-board-legend';

/** Where the card was dragged to: px from the board panel's top-left. null =
 *  the default corner (lower right, clear of the board sidebar). */
export interface LegendPos { x: number; y: number }

interface LegendState { open: boolean; mode: LegendMode; pos: LegendPos | null }

class BoardLegendStore extends Emitter {
  private _state: LegendState = { open: false, mode: 'pins', pos: null };

  constructor() {
    super();
    try {
      const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<LegendState> | null;
      if (raw) {
        const mode = LEGEND_MODES.some(m => m.id === raw.mode) ? raw.mode! : 'pins';
        const p = raw.pos;
        const pos = p && Number.isFinite(p.x) && Number.isFinite(p.y) ? { x: p.x, y: p.y } : null;
        this._state = { open: raw.open === true, mode, pos };
      }
    } catch { /* no storage, or junk in it */ }
  }

  /** Stable until the next change — safe as a useSyncExternalStore snapshot. */
  get state(): LegendState { return this._state; }

  private set(patch: Partial<LegendState>): void {
    const next = { ...this._state, ...patch };
    const cur = this._state;
    if (next.open === cur.open && next.mode === cur.mode
      && next.pos?.x === cur.pos?.x && next.pos?.y === cur.pos?.y) return;
    this._state = next;
    try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* no storage */ }
    this.notify();
  }

  toggle(): void { this.set({ open: !this._state.open }); }
  close(): void { this.set({ open: false }); }
  setMode(mode: LegendMode): void { this.set({ mode, open: true }); }
  /** Move the card (rounded px); null puts it back in its corner. */
  setPos(pos: LegendPos | null): void { this.set({ pos: pos && { x: Math.round(pos.x), y: Math.round(pos.y) } }); }
}

export const boardLegendStore = new BoardLegendStore();

export const useBoardLegend = createStoreHook(boardLegendStore, () => boardLegendStore.state);
