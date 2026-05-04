import { boardStore } from '../store/board-store';
import { createStoreHook } from './createStoreHook';
import type { BoardData, Part, Pin } from '../parsers';
import type { SelectionState, BoardTab, Toast, NetLineMode } from '../store/board-store';
import type { LayerState } from '../store/layer-store';

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
  flipAxis: 'x' | 'y';
  netLineMode: NetLineMode;
  dimMode: BoardTab['dimMode'];
  showHoverInfo: boolean;
  followPdf: boolean;
  showTraces: boolean;
  showComponents: boolean;
  showVias: boolean;
  showSilkscreen: boolean;
  showPads: boolean;
  showCopperDrops: boolean;
  showPins: boolean;
  showOutlines: boolean;
  showLabels: boolean;
  showGhosts: boolean;
  hideGhosts: boolean;
  swappedGhostPairs: ReadonlySet<string>;
  foldMode: 'suggested' | 'all-sides';
  selectedBoardIndex: number | null;
  layerStates: LayerState[];
  boundPdfFiles: File[];
  pdfFileNames: string[];
  toasts: Toast[];
  searchSelectionActive: boolean;
}

export const useBoardStore = createStoreHook<StoreSnapshot>(boardStore, () => ({
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
  flipAxis: boardStore.flipAxis,
  netLineMode: boardStore.netLineMode,
  dimMode: boardStore.dimMode,
  showHoverInfo: boardStore.showHoverInfo,
  followPdf: boardStore.followPdf,
  showTraces: boardStore.showTraces,
  showComponents: boardStore.showComponents,
  showVias: boardStore.showVias,
  showSilkscreen: boardStore.showSilkscreen,
  showPads: boardStore.showPads,
  showCopperDrops: boardStore.showCopperDrops,
  showPins: boardStore.showPins,
  showOutlines: boardStore.showOutlines,
  showLabels: boardStore.showLabels,
  showGhosts: boardStore.showGhosts,
  hideGhosts: boardStore.hideGhosts,
  swappedGhostPairs: boardStore.swappedGhostPairs,
  foldMode: boardStore.foldMode,
  selectedBoardIndex: boardStore.selectedBoardIndex,
  layerStates: boardStore.layerStates,
  boundPdfFiles: boardStore.boundPdfFiles,
  pdfFileNames: boardStore.pdfFileNames,
  toasts: boardStore.toasts,
  searchSelectionActive: boardStore.searchSelectionActive,
}));
