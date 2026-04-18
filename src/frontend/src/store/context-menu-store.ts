import { Emitter } from './emitter';

export interface ContextMenuState {
  visible: boolean;
  screenX: number;
  screenY: number;
  /** Discriminator — board component right-click or PDF text right-click */
  source: 'board' | 'pdf';
  // Board-mode fields
  componentName: string;
  /** Set when right-clicking a specific pin — enables chip+pin PDF search */
  pinId: string | null;
  /** Net name of the right-clicked pin */
  netName: string | null;
  // PDF-mode fields
  /** Text-item string under the cursor when the menu opened */
  query: string;
  /** PDF filename the click originated in — used to exclude it from "Other PDFs" */
  originPdfFileName: string;
}

const emptyState: ContextMenuState = {
  visible: false,
  screenX: 0,
  screenY: 0,
  source: 'board',
  componentName: '',
  pinId: null,
  netName: null,
  query: '',
  originPdfFileName: '',
};

class ContextMenuStore extends Emitter {
  private _state: ContextMenuState = { ...emptyState };

  get state(): ContextMenuState {
    return this._state;
  }

  showBoard(
    screenX: number,
    screenY: number,
    componentName: string,
    pinId: string | null = null,
    netName: string | null = null,
  ) {
    this._state = {
      ...emptyState,
      visible: true,
      screenX,
      screenY,
      source: 'board',
      componentName,
      pinId,
      netName,
    };
    this.notify();
  }

  showPdf(
    screenX: number,
    screenY: number,
    query: string,
    originPdfFileName: string,
  ) {
    this._state = {
      ...emptyState,
      visible: true,
      screenX,
      screenY,
      source: 'pdf',
      query,
      originPdfFileName,
    };
    this.notify();
  }

  hide() {
    if (!this._state.visible) return;
    this._state = { ...this._state, visible: false };
    this.notify();
  }
}

export const contextMenuStore = new ContextMenuStore();

// Expose for integration tests (Playwright) — DEV builds only
if (typeof window !== 'undefined' && import.meta.env.DEV) {
  (window as { __contextMenuStore?: typeof contextMenuStore }).__contextMenuStore = contextMenuStore;
}
