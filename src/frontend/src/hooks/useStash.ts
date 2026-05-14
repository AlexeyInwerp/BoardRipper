import { stashStore } from '../store/stash-store';
import type { BoardStashes, Stash } from '../store/stash-store';
import { boardStore } from '../store/board-store';
import { createStoreHook } from './createStoreHook';

interface StashSnapshot {
  current: BoardStashes | null;
  activeStash: Stash | null;
  hasBoard: boolean;
}

export const useStash = createStoreHook<StashSnapshot>(
  {
    subscribe(cb) {
      const a = stashStore.subscribe(cb);
      const b = boardStore.subscribe(cb);
      return () => { a(); b(); };
    },
  },
  () => ({
    current: stashStore.current,
    activeStash: stashStore.activeStash,
    hasBoard: !!boardStore.board,
  }),
);
