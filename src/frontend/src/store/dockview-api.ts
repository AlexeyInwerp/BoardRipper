import type { DockviewApi } from 'dockview-react';

let _api: DockviewApi | null = null;

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

export function ensureUtilityPanel(id: string, component: string, title: string): void {
  try {
    const api = getDockviewApi();
    if (!api) return;
    const existing = api.getPanel(id);
    if (existing) {
      existing.api.setActive();
    } else {
      api.addPanel({
        id,
        component,
        title,
        floating: { width: 400, height: 500 },
      });
    }
  } catch (err) {
    console.error(`[dockview] Failed to open ${id} panel:`, err);
  }
}
