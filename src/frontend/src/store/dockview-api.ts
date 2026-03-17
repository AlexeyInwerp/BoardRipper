import type { DockviewApi } from 'dockview-react';

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
    console.error('[dockview] Failed to open board panel:', err);
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
    console.error('[dockview] Failed to open PDF panel:', err);
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
  switchFn();           // update store BEFORE setActive so deactivation handlers see the new activeTabId
  panel.api.setActive(); // fires onDidActiveChange synchronously — deactivating panel reads store now
  _linkActivating = false;
  return true;
}

export function ensureLibraryPanel(): void {
  try {
    const api = getDockviewApi();
    if (!api) return;
    const id = 'library';
    const existing = api.getPanel(id);
    if (existing) {
      existing.api.setActive();
    } else {
      // Place library on the left side of the first existing panel, or standalone
      const anyPanel = api.panels[0];
      api.addPanel({
        id,
        component: 'library',
        title: 'Library',
        position: anyPanel
          ? { referencePanel: anyPanel.id, direction: 'left' }
          : undefined,
      });
    }
  } catch (err) {
    console.error('[dockview] Failed to open library panel:', err);
  }
}

export function ensureUtilityPanel(id: string, component: string, title: string): void {
  try {
    const api = getDockviewApi();
    if (!api) return;
    const existing = api.getPanel(id);
    if (existing) {
      existing.api.setActive();
    } else {
      // Find the rightmost group to place the utility panel as a tab next to existing panels
      const panels = api.panels;
      const ref = panels.length > 0 ? panels[panels.length - 1] : undefined;
      api.addPanel({
        id,
        component,
        title,
        position: ref ? { referencePanel: ref.id, direction: 'within' } : undefined,
      });
    }
  } catch (err) {
    console.error(`[dockview] Failed to open ${id} panel:`, err);
  }
}
