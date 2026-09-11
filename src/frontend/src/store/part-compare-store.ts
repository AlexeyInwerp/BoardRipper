/**
 * Which two parts the Part comparison tool is showing.
 *
 * Session-scoped and deliberately not persisted: a comparison names two *open
 * board tabs*, and tab ids do not survive a reload. Restoring "compare tab 3
 * with tab 7" into a session where those are different boards would be worse
 * than restoring nothing.
 *
 * The store holds only the *selection*. The comparison itself is recomputed by
 * the tool from `part-compare.ts`, which is pure — so nothing here caches a
 * result that could go stale when a board reloads.
 */

import { Emitter } from './emitter';
import { boardStore, type BoardTab } from './board-store';
import { createStoreHook } from '../hooks/createStoreHook';
import type { AlignMode } from './part-compare';

export interface CompareSideRef {
  tabId: number;
  /** Refdes, as stored on the part. Resolved to a `Part` at render time so a
   *  board reload or a revision switch is picked up for free. */
  partName: string;
}

export interface PartCompareState {
  a: CompareSideRef | null;
  b: CompareSideRef | null;
  mode: AlignMode;
  onlyDiffs: boolean;
}

class PartCompareStore extends Emitter {
  private _state: PartCompareState = { a: null, b: null, mode: 'auto', onlyDiffs: false };

  get state(): PartCompareState { return this._state; }

  private patch(p: Partial<PartCompareState>) {
    this._state = { ...this._state, ...p };
    this.notify();
  }

  setSide(which: 'a' | 'b', ref: CompareSideRef | null) {
    this.patch({ [which]: ref } as Partial<PartCompareState>);
  }

  /** Keep the board, change the component — what the lookup field does. */
  setPart(which: 'a' | 'b', partName: string) {
    const cur = this._state[which];
    if (!cur) return;
    this.patch({ [which]: { ...cur, partName } } as Partial<PartCompareState>);
  }

  /** Keep the component, change the board — what the board dropdown does. */
  setBoard(which: 'a' | 'b', tabId: number) {
    const cur = this._state[which];
    this.patch({ [which]: { tabId, partName: cur?.partName ?? '' } } as Partial<PartCompareState>);
  }

  swap() {
    this.patch({ a: this._state.b, b: this._state.a });
  }

  setMode(mode: AlignMode) { this.patch({ mode }); }
  setOnlyDiffs(onlyDiffs: boolean) { this.patch({ onlyDiffs }); }

  /**
   * Seed both sides at once — the right-click entry point.
   *
   * `b` may be omitted, which is the "Compare part…" row: board A and its
   * refdes are known, and the user picks the other side in the tool. Alignment
   * mode resets to auto so a mode pinned for a previous pair cannot silently
   * mis-align the new one.
   */
  open(a: CompareSideRef, b: CompareSideRef | null) {
    this._state = { a, b, mode: 'auto', onlyDiffs: this._state.onlyDiffs };
    this.notify();
  }

  /** Drop references to tabs that are no longer open. */
  pruneClosedTabs(liveTabIds: ReadonlySet<number>) {
    const next: Partial<PartCompareState> = {};
    if (this._state.a && !liveTabIds.has(this._state.a.tabId)) next.a = null;
    if (this._state.b && !liveTabIds.has(this._state.b.tabId)) next.b = null;
    if (Object.keys(next).length > 0) this.patch(next);
  }
}

export const partCompareStore = new PartCompareStore();

// Closing a board tab must not leave the tool pointing at it. Done by
// subscription rather than a call inside `boardStore.closeTab` so the
// dependency stays one-directional — this module knows about the board store,
// never the other way round.
boardStore.subscribe(() => {
  partCompareStore.pruneClosedTabs(new Set(boardStore.tabs.map(t => t.id)));
});

export const usePartCompare = createStoreHook(partCompareStore, () => partCompareStore.state);

/**
 * Resolve a side to the data the kernel needs.
 *
 * Deliberately reads `tab.board` — the **raw** parse — and not the derived
 * view. `deriveBoardView` filters parts (board-pack selection, hidden
 * overrides) and rebuilds `nets` from what survives, so comparing through it
 * would let a view filter quietly shrink a topology fingerprint and turn a
 * rename into a difference. A comparison is about what is in the file.
 */
export function resolveSide(ref: CompareSideRef | null, tabs: readonly BoardTab[]) {
  if (!ref) return null;
  const tab = tabs.find(t => t.id === ref.tabId);
  if (!tab?.board) return null;
  const upper = ref.partName.trim().toUpperCase();
  if (!upper) return { tab, board: tab.board, part: null };
  const part = tab.board.parts.find(p => p.name.trim().toUpperCase() === upper) ?? null;
  return { tab, board: tab.board, part };
}
