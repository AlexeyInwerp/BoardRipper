import { selectionSetStore } from '../store/selection-set-store';
import { boardStore } from '../store/board-store';
import { createStoreHook } from './createStoreHook';

interface SelectionSetSnapshot {
  ordered: readonly number[];
  set: ReadonlySet<number>;
  count: number;
}

/** Bridge two notify sources: selection content AND active-tab change
 *  (the "current selection" depends on which tab is active). */
export const useSelectionSet = createStoreHook<SelectionSetSnapshot>(
  {
    subscribe(cb) {
      const a = selectionSetStore.subscribe(cb);
      const b = boardStore.subscribe(cb);
      return () => { a(); b(); };
    },
  },
  () => {
    const cur = selectionSetStore.current;
    return { ordered: cur.ordered, set: cur.set, count: cur.ordered.length };
  },
);
