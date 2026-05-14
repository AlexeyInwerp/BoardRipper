import { worklistStore } from '../store/worklist-store';
import type { BoardWorklistes, Worklist } from '../store/worklist-store';
import { boardStore } from '../store/board-store';
import { createStoreHook } from './createStoreHook';

interface WorklistSnapshot {
  current: BoardWorklistes | null;
  activeWorklist: Worklist | null;
  hasBoard: boolean;
}

export const useWorklist = createStoreHook<WorklistSnapshot>(
  {
    subscribe(cb) {
      const a = worklistStore.subscribe(cb);
      const b = boardStore.subscribe(cb);
      return () => { a(); b(); };
    },
  },
  () => ({
    current: worklistStore.current,
    activeWorklist: worklistStore.activeWorklist,
    hasBoard: !!boardStore.board,
  }),
);
