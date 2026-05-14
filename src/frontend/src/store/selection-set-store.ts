import { boardStore } from './board-store';

/** Ephemeral multi-select set per board tab. Lives in memory only —
 *  cleared on tab close, reload, or board switch. Companion to the
 *  single-`selectedPart` selection: shift-click adds/removes parts
 *  from this set without touching the primary selection. Pushing to
 *  a worklist copies refdes + partIndex out of this set. */

interface TabSelection {
  /** Insertion-ordered list of partIndex. Order = navigation order. */
  ordered: number[];
  /** Same members for O(1) presence check. */
  set: Set<number>;
}

class SelectionSetStore {
  private byTab = new Map<number, TabSelection>();
  private listeners = new Set<() => void>();

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  private notify(): void {
    this.listeners.forEach(fn => fn());
  }

  private ensure(tabId: number): TabSelection {
    let s = this.byTab.get(tabId);
    if (!s) {
      s = { ordered: [], set: new Set<number>() };
      this.byTab.set(tabId, s);
    }
    return s;
  }

  /** Current selection for the active tab. Returns a stable empty
   *  reference when nothing is selected so React snapshots don't churn. */
  get current(): { ordered: readonly number[]; set: ReadonlySet<number> } {
    const id = boardStore.activeTabId;
    if (id == null) return EMPTY;
    const s = this.byTab.get(id);
    return s ?? EMPTY;
  }

  has(partIndex: number): boolean {
    return this.current.set.has(partIndex);
  }

  toggle(tabId: number, partIndex: number): void {
    const s = this.ensure(tabId);
    if (s.set.has(partIndex)) {
      s.set.delete(partIndex);
      const i = s.ordered.indexOf(partIndex);
      if (i >= 0) s.ordered.splice(i, 1);
    } else {
      s.set.add(partIndex);
      s.ordered.push(partIndex);
    }
    this.notify();
  }

  add(tabId: number, partIndex: number): void {
    const s = this.ensure(tabId);
    if (!s.set.has(partIndex)) {
      s.set.add(partIndex);
      s.ordered.push(partIndex);
      this.notify();
    }
  }

  remove(tabId: number, partIndex: number): void {
    const s = this.byTab.get(tabId);
    if (!s) return;
    if (s.set.delete(partIndex)) {
      const i = s.ordered.indexOf(partIndex);
      if (i >= 0) s.ordered.splice(i, 1);
      this.notify();
    }
  }

  clear(tabId: number): void {
    const s = this.byTab.get(tabId);
    if (s && s.ordered.length > 0) {
      s.ordered = [];
      s.set.clear();
      this.notify();
    }
  }

  /** Drop selection for a tab being closed. No notify — caller is mid-teardown. */
  dropTab(tabId: number): void {
    this.byTab.delete(tabId);
  }
}

const EMPTY: { ordered: readonly number[]; set: ReadonlySet<number> } = Object.freeze({
  ordered: Object.freeze([]) as readonly number[],
  set: new Set<number>() as ReadonlySet<number>,
});

export const selectionSetStore = new SelectionSetStore();
