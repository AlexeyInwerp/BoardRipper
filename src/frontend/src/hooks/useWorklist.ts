import { worklistStore } from '../store/worklist-store';
import type { Worklist, WorklistSummary } from '../store/worklist-store';
import { boardStore } from '../store/board-store';
import { subscribeBoardFacts } from '../store/worklist-board-keys';
import { createStoreHook } from './createStoreHook';

interface WorklistSnapshot {
  /** The active tab's loaded worklist, rows resolved on its board. */
  activeWorklist: Worklist | null;
  /** Every live worklist, newest first. */
  summaries: WorklistSummary[];
  hasBoard: boolean;
  /** False until the store has loaded its cache and synced once. */
  ready: boolean;
}

export const useWorklist = createStoreHook<WorklistSnapshot>(
  {
    subscribe(cb) {
      const a = worklistStore.subscribe(cb);
      const b = boardStore.subscribe(cb);
      const c = subscribeBoardFacts(cb);
      return () => { a(); b(); c(); };
    },
  },
  () => ({
    activeWorklist: worklistStore.activeWorklist,
    summaries: worklistStore.summaries(),
    hasBoard: !!boardStore.board,
    ready: worklistStore.ready,
  }),
);
