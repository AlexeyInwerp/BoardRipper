import type { BoardData, Part, Pin } from '../parsers';
import { boardCache } from './board-cache';
import { parseBoardFile } from '../parsers';

export type BoardStoreListener = () => void;

export interface SelectionState {
  partIndex: number | null;
  pinIndex: number | null;
  highlightedNet: string | null;
}

export interface BoardTab {
  id: number;
  fileName: string;
  board: BoardData | null;
  selection: SelectionState;
  showTop: boolean;
  showBottom: boolean;
  butterfly: boolean;
  searchQuery: string;
  rotation: number;
  mirrorX: boolean;
  mirrorY: boolean;
  showNetLines: boolean;
}

export interface FocusRequest {
  partIndex: number;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

const emptySelection: SelectionState = { partIndex: null, pinIndex: null, highlightedNet: null };

let nextTabId = 1;

class BoardStore {
  private _tabs: BoardTab[] = [];
  private _activeTabId: number | null = null;
  private _focusRequest: FocusRequest | null = null;
  private _listeners = new Set<BoardStoreListener>();

  get tabs(): BoardTab[] { return this._tabs; }
  get activeTabId(): number | null { return this._activeTabId; }

  private get activeTab(): BoardTab | null {
    return this._tabs.find(t => t.id === this._activeTabId) ?? null;
  }

  get board(): BoardData | null { return this.activeTab?.board ?? null; }
  get fileName(): string { return this.activeTab?.fileName ?? ''; }
  get selection(): SelectionState { return this.activeTab?.selection ?? emptySelection; }
  get showTop(): boolean { return this.activeTab?.showTop ?? true; }
  get showBottom(): boolean { return this.activeTab?.showBottom ?? true; }
  get butterfly(): boolean { return this.activeTab?.butterfly ?? false; }
  get searchQuery(): string { return this.activeTab?.searchQuery ?? ''; }
  get rotation(): number { return this.activeTab?.rotation ?? 0; }
  get mirrorX(): boolean { return this.activeTab?.mirrorX ?? false; }
  get mirrorY(): boolean { return this.activeTab?.mirrorY ?? false; }
  get showNetLines(): boolean { return this.activeTab?.showNetLines ?? false; }

  get selectedPart(): Part | null {
    const tab = this.activeTab;
    if (tab?.board && tab.selection.partIndex !== null) {
      return tab.board.parts[tab.selection.partIndex] ?? null;
    }
    return null;
  }

  get selectedPin(): Pin | null {
    const part = this.selectedPart;
    const tab = this.activeTab;
    if (part && tab?.selection.pinIndex !== null) {
      return part.pins[tab.selection.pinIndex] ?? null;
    }
    return null;
  }

  subscribe(listener: BoardStoreListener): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  private notify() {
    for (const l of this._listeners) l();
  }

  private updateActiveTab(patch: Partial<BoardTab>) {
    const tab = this.activeTab;
    if (!tab) return;
    Object.assign(tab, patch);
  }

  async loadFile(file: File) {
    // Check if already open — switch to that tab
    const existing = this._tabs.find(t => t.fileName === file.name);
    if (existing) {
      this._activeTabId = existing.id;
      this.notify();
      return;
    }

    const id = nextTabId++;
    const tab: BoardTab = {
      id,
      fileName: file.name,
      board: null,
      selection: { ...emptySelection },
      showTop: true,
      showBottom: false,
      butterfly: false,
      searchQuery: '',
      rotation: 0,
      mirrorX: false,
      mirrorY: false,
      showNetLines: false,
    };

    this._tabs.push(tab);
    this._activeTabId = id;

    // Try loading from cache first
    const cached = await boardCache.get(file.name, file.size, file.lastModified);
    if (cached) {
      tab.board = cached;
      this.notify();
      return;
    }

    const text = await file.text();
    const board = parseBoardFile(text);
    tab.board = board;

    // Cache for fast re-access
    await boardCache.put(file.name, file.size, file.lastModified, board);

    this.notify();
  }

  async loadFiles(files: FileList | File[]) {
    for (const file of files) {
      await this.loadFile(file);
    }
  }

  switchTab(tabId: number) {
    if (this._tabs.some(t => t.id === tabId) && this._activeTabId !== tabId) {
      this._activeTabId = tabId;
      this.notify();
    }
  }

  closeTab(tabId: number) {
    const idx = this._tabs.findIndex(t => t.id === tabId);
    if (idx === -1) return;

    this._tabs.splice(idx, 1);

    if (this._activeTabId === tabId) {
      // Switch to nearest tab
      if (this._tabs.length > 0) {
        const newIdx = Math.min(idx, this._tabs.length - 1);
        this._activeTabId = this._tabs[newIdx].id;
      } else {
        this._activeTabId = null;
      }
    }
    this.notify();
  }

  selectPart(partIndex: number | null) {
    this.updateActiveTab({
      selection: { partIndex, pinIndex: null, highlightedNet: null },
    });
    this.notify();
  }

  selectPin(partIndex: number, pinIndex: number) {
    const tab = this.activeTab;
    const part = tab?.board?.parts[partIndex];
    const pin = part?.pins[pinIndex];
    this.updateActiveTab({
      selection: { partIndex, pinIndex, highlightedNet: pin?.net || null },
    });
    this.notify();
  }

  highlightNet(netName: string | null) {
    const tab = this.activeTab;
    if (!tab) return;
    this.updateActiveTab({
      selection: { ...tab.selection, highlightedNet: netName },
    });
    this.notify();
  }

  /** Switch to top view, or shift-click to show both */
  selectTop(both = false) {
    const tab = this.activeTab;
    if (!tab) return;
    if (both) {
      this.updateActiveTab({ showTop: true, showBottom: true, butterfly: false });
    } else {
      this.updateActiveTab({ showTop: true, showBottom: false, butterfly: false });
    }
    this.notify();
  }

  /** Switch to bottom view, or shift-click to show both */
  selectBottom(both = false) {
    const tab = this.activeTab;
    if (!tab) return;
    if (both) {
      this.updateActiveTab({ showTop: true, showBottom: true, butterfly: false });
    } else {
      this.updateActiveTab({ showTop: false, showBottom: true, butterfly: false });
    }
    this.notify();
  }

  /** Toggle butterfly mode: show top and bottom side by side */
  toggleButterfly() {
    const tab = this.activeTab;
    if (!tab) return;
    const newButterfly = !tab.butterfly;
    if (newButterfly) {
      this.updateActiveTab({ butterfly: true, showTop: true, showBottom: true });
    } else {
      this.updateActiveTab({ butterfly: false });
    }
    this.notify();
  }

  rotateCW() {
    const tab = this.activeTab;
    if (!tab) return;
    this.updateActiveTab({ rotation: (tab.rotation + 90) % 360 });
    this.notify();
  }

  rotateCCW() {
    const tab = this.activeTab;
    if (!tab) return;
    this.updateActiveTab({ rotation: (tab.rotation + 270) % 360 });
    this.notify();
  }

  flipHorizontal() {
    const tab = this.activeTab;
    if (!tab) return;
    this.updateActiveTab({ mirrorX: !tab.mirrorX });
    this.notify();
  }

  flipVertical() {
    const tab = this.activeTab;
    if (!tab) return;
    this.updateActiveTab({ mirrorY: !tab.mirrorY });
    this.notify();
  }

  toggleNetLines() {
    const tab = this.activeTab;
    if (!tab) return;
    this.updateActiveTab({ showNetLines: !tab.showNetLines });
    this.notify();
  }

  setSearch(query: string) {
    this.updateActiveTab({ searchQuery: query });
    this.notify();
  }

  get searchResults(): Part[] {
    const tab = this.activeTab;
    if (!tab?.board || !tab.searchQuery) return [];
    const q = tab.searchQuery.toLowerCase();
    return tab.board.parts.filter(p =>
      p.name.toLowerCase().includes(q) ||
      p.pins.some(pin => pin.net.toLowerCase().includes(q))
    );
  }

  /** Focus request — consumed by the renderer to zoom to a part */
  get focusRequest(): FocusRequest | null { return this._focusRequest; }

  consumeFocusRequest(): FocusRequest | null {
    const req = this._focusRequest;
    this._focusRequest = null;
    return req;
  }

  /** Select a part by name and request the renderer to zoom to it */
  focusPart(name: string) {
    const tab = this.activeTab;
    if (!tab?.board) return;
    const upper = name.toUpperCase();
    const idx = tab.board.parts.findIndex(p => p.name.toUpperCase() === upper);
    if (idx < 0) return;

    const part = tab.board.parts[idx];
    this.updateActiveTab({
      selection: { partIndex: idx, pinIndex: null, highlightedNet: null },
    });
    this._focusRequest = { partIndex: idx, bounds: part.bounds };
    this.notify();
  }
}

export const boardStore = new BoardStore();
