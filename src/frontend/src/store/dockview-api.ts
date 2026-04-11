import type { DockviewApi } from 'dockview-react';
import { log } from './log-store';

let _api: DockviewApi | null = null;

/** Re-entrancy guard for linked panel activation (board ↔ PDF) */
let _linkActivating = false;
export function isLinkActivating(): boolean { return _linkActivating; }
export function setLinkActivating(v: boolean): void { _linkActivating = v; }

export function setDockviewApi(api: DockviewApi) {
  _api = api;
}

export function getDockviewApi(): DockviewApi | null {
  return _api;
}

export function boardPanelId(tabId: number): string {
  return 'board-' + tabId;
}

export function ensureBoardPanel(tabId: number, fileName: string): void {
  try {
    const api = getDockviewApi();
    if (!api) return;
    const id = boardPanelId(tabId);
    const existing = api.getPanel(id);
    if (existing) {
      existing.api.setActive();
    } else {
      const existingBoard = api.panels.find(p => p.id.startsWith('board-'));
      api.addPanel({
        id,
        component: 'boardViewer',
        title: fileName,
        params: { boardTabId: tabId },
        position: existingBoard
          ? { referencePanel: existingBoard.id }
          : undefined,
      });
    }
  } catch (err) {
    log.ui.error('Failed to open board panel:', err);
  }
}

export function pdfPanelId(fileName: string): string {
  return 'pdf-' + fileName.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export function ensurePdfPanel(fileName: string): void {
  try {
    const api = getDockviewApi();
    if (!api) return;
    const id = pdfPanelId(fileName);
    const existing = api.getPanel(id);
    if (existing) {
      existing.api.setActive();
    } else {
      const existingPdf = api.panels.find(p => p.id.startsWith('pdf-'));
      api.addPanel({
        id,
        component: 'pdfViewer',
        title: fileName,
        params: { pdfFileName: fileName },
        position: existingPdf
          ? { referencePanel: existingPdf.id }
          : (() => {
              const anyBoard = api.panels.find(p => p.id.startsWith('board-'));
              if (!anyBoard) return undefined;
              const isLandscape = api.width >= api.height;
              return {
                referencePanel: anyBoard.id,
                direction: isLandscape ? ('right' as const) : ('below' as const),
              };
            })(),
      });
    }
  } catch (err) {
    log.ui.error('Failed to open PDF panel:', err);
  }
}

/**
 * Activate a linked panel (board ↔ PDF) with re-entrancy guard.
 * Returns true if activation was performed.
 */
export function activateLinkedPanel(
  panelId: string,
  switchFn: () => void,
): boolean {
  if (_linkActivating) return false;
  const api = _api;
  if (!api) return false;
  const panel = api.getPanel(panelId);
  if (!panel) return false;
  _linkActivating = true;
  switchFn();
  panel.api.setActive();
  _linkActivating = false;
  return true;
}
