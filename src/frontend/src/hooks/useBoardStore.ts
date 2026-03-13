import { useSyncExternalStore } from 'react';
import { boardStore } from '../store/board-store';
import type { BoardData, Part, Pin } from '../parsers';
import type { SelectionState, BoardTab } from '../store/board-store';

interface StoreSnapshot {
  board: BoardData | null;
  fileName: string;
  selection: SelectionState;
  selectedPart: Part | null;
  selectedPin: Pin | null;
  showTop: boolean;
  showBottom: boolean;
  butterfly: boolean;
  searchQuery: string;
  searchResults: Part[];
  tabs: BoardTab[];
  activeTabId: number | null;
  rotation: number;
  mirrorX: boolean;
  mirrorY: boolean;
  showNetLines: boolean;
  pdfFile: File | null;
  pdfFileNames: string[];
}

let cachedSnapshot: StoreSnapshot | null = null;
let snapshotVersion = 0;
let lastVersion = -1;

boardStore.subscribe(() => { snapshotVersion++; });

function getSnapshot(): StoreSnapshot {
  if (lastVersion !== snapshotVersion || !cachedSnapshot) {
    cachedSnapshot = {
      board: boardStore.board,
      fileName: boardStore.fileName,
      selection: boardStore.selection,
      selectedPart: boardStore.selectedPart,
      selectedPin: boardStore.selectedPin,
      showTop: boardStore.showTop,
      showBottom: boardStore.showBottom,
      butterfly: boardStore.butterfly,
      searchQuery: boardStore.searchQuery,
      searchResults: boardStore.searchResults,
      tabs: boardStore.tabs,
      activeTabId: boardStore.activeTabId,
      rotation: boardStore.rotation,
      mirrorX: boardStore.mirrorX,
      mirrorY: boardStore.mirrorY,
      showNetLines: boardStore.showNetLines,
      pdfFile: boardStore.pdfFile,
      pdfFileNames: boardStore.pdfFileNames,
    };
    lastVersion = snapshotVersion;
  }
  return cachedSnapshot;
}

function subscribe(cb: () => void) {
  return boardStore.subscribe(cb);
}

export function useBoardStore() {
  return useSyncExternalStore(subscribe, getSnapshot);
}
