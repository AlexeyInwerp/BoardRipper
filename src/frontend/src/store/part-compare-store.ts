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
import { renderSettingsStore, isGroundNet } from './render-settings';
import { createStoreHook } from '../hooks/createStoreHook';
import { comparePart, type AlignMode, type CompareResult, type PinDiffStatus } from './part-compare';

export interface CompareSideRef {
  tabId: number;
  /** Refdes, as stored on the part. Resolved to a `Part` at render time so a
   *  board reload or a revision switch is picked up for free. */
  partName: string;
}

/** One pin of the compared part, as the board overlay and tooltip need it. */
export interface CompareHighlightPin {
  status: PinDiffStatus;
  /** Why the row reads as it does, when the names decided it. */
  reason: string;
  /** The other board's net on the matching pin; '' when unconnected or absent. */
  otherNet: string;
  /** The other board's pin label, or null when that side has no such pin. */
  otherPin: string | null;
}

export interface CompareHighlight {
  partName: string;
  otherPart: string;
  /** Other board's filename without extension — the tooltip says where the
   *  comparison value came from, since two boards look alike on the canvas. */
  otherBoard: string;
  pins: Map<number, CompareHighlightPin>;
}

/** Filename without its extension, trimmed for a one-line tooltip. */
function shortBoardLabel(fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/, '');
  return base.length > 24 ? `${base.slice(0, 23)}…` : base;
}

export interface PartCompareState {
  a: CompareSideRef | null;
  b: CompareSideRef | null;
  mode: AlignMode;
  onlyDiffs: boolean;
  /** Paint the comparison onto the board: a standing outline around the
   *  compared part plus a mark on every pin that is not a plain match.
   *  Off by default — it is a second, persistent highlight competing with the
   *  selection, so it only appears when asked for. */
  highlight: boolean;
}

class PartCompareStore extends Emitter {
  private _state: PartCompareState = {
    a: null, b: null, mode: 'auto', onlyDiffs: false, highlight: false,
  };
  /** Memoised `comparePart` output. Keyed by everything that can change it,
   *  board identity included — `deriveBoardView` and a reload both produce a
   *  fresh `BoardData`, so an identity check is a correct invalidation. */
  private _cache: { key: string; boardA: object; boardB: object; result: CompareResult } | null = null;

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
  setHighlight(highlight: boolean) { this.patch({ highlight }); }
  toggleHighlight() { this.patch({ highlight: !this._state.highlight }); }

  /**
   * The current comparison, or null when either side is unresolved.
   *
   * Lives on the store rather than in the tool's `useMemo` because the
   * renderer needs the same answer to paint the board, and recomputing it
   * per frame is not an option. The kernel is pure, so caching it here costs
   * nothing and removes the duplicate computation.
   */
  get result(): CompareResult | null {
    const { a, b, mode } = this._state;
    const sa = resolveSide(a, boardStore.tabs);
    const sb = resolveSide(b, boardStore.tabs);
    if (!sa?.part || !sb?.part) { this._cache = null; return null; }

    const key = `${a!.tabId}|${sa.part.name}|${b!.tabId}|${sb.part.name}|${mode}`;
    const hit = this._cache;
    if (hit && hit.key === key && hit.boardA === sa.board && hit.boardB === sb.board) {
      return hit.result;
    }
    const settings = renderSettingsStore.settings;
    const result = comparePart(
      { board: sa.board, part: sa.part },
      { board: sb.board, part: sb.part },
      { mode, isBulkNet: n => isGroundNet(settings, n) },
    );
    this._cache = { key, boardA: sa.board, boardB: sb.board, result };
    return result;
  }

  /**
   * What to paint on `tabId`, and what to say about a pin when it is hovered —
   * or null when the board highlight is off, this tab is neither side, or
   * there is nothing to compare.
   *
   * Everything is keyed by pin index **on that side**, so the renderer never
   * has to know which half of the comparison it is looking at. Each entry
   * carries the other board's net as well as the status: a red pin that does
   * not say what it differs *to* only raises a question.
   */
  highlightFor(tabId: number): CompareHighlight | null {
    const { a, b, highlight } = this._state;
    if (!highlight) return null;
    const which: 'a' | 'b' | null =
      a?.tabId === tabId ? 'a' : b?.tabId === tabId ? 'b' : null;
    if (!which) return null;
    const result = this.result;
    if (!result) return null;

    const otherRef = which === 'a' ? b : a;
    const otherSide = resolveSide(otherRef, boardStore.tabs);
    const pins = new Map<number, CompareHighlightPin>();
    for (const row of result.rows) {
      const mine = which === 'a' ? row.a : row.b;
      const theirs = which === 'a' ? row.b : row.a;
      if (!mine) continue;
      pins.set(mine.pinIndex, {
        status: row.status,
        reason: row.nameReason ?? '',
        otherNet: theirs?.rawNet ?? '',
        otherPin: theirs?.label ?? null,
      });
    }
    const ref = which === 'a' ? a : b;
    return {
      partName: ref!.partName,
      otherPart: otherRef?.partName ?? '',
      otherBoard: shortBoardLabel(otherSide?.tab.fileName ?? ''),
      pins,
    };
  }

  /**
   * Seed both sides at once — the right-click entry point.
   *
   * `b` may be omitted, which is the "Compare part…" row: board A and its
   * refdes are known, and the user picks the other side in the tool. Alignment
   * mode resets to auto so a mode pinned for a previous pair cannot silently
   * mis-align the new one.
   */
  open(a: CompareSideRef, b: CompareSideRef | null) {
    this._state = {
      ...this._state, a, b, mode: 'auto',
    };
    this.notify();
  }

  /**
   * With exactly two boards open and neither side chosen, there is only one
   * comparison the user can mean — so make it for them.
   *
   * Guarded on **both** sides being empty, so clearing one side to re-pick it
   * does not get overruled on the next render. Only the boards are filled;
   * the components stay blank, because which chip to compare is the actual
   * question and guessing at it would be noise.
   */
  autoFillBoards(tabIds: readonly number[]) {
    if (tabIds.length !== 2) return;
    if (this._state.a || this._state.b) return;
    this._state = {
      ...this._state,
      a: { tabId: tabIds[0], partName: '' },
      b: { tabId: tabIds[1], partName: '' },
    };
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
