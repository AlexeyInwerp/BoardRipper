import type { DockviewApi } from 'dockview-react';
import { log } from './log-store';

let _api: DockviewApi | null = null;

/** Re-entrancy guard for linked panel activation (board ↔ PDF) */
let _linkActivating = false;
export function isLinkActivating(): boolean { return _linkActivating; }
export function setLinkActivating(v: boolean): void { _linkActivating = v; }

// --- Auto-switch between linked board and PDF panels ---
// When true, activating a board panel also activates its linked PDF panel
// (and vice versa). When false, each panel is activated independently.
// Persisted to localStorage.
const AUTO_SWITCH_KEY = 'boardripper-auto-switch-linked';
let _autoSwitchLinked = (() => {
  try { return localStorage.getItem(AUTO_SWITCH_KEY) !== '0'; }
  catch { return true; }
})();
const _autoSwitchListeners = new Set<() => void>();
export function isAutoSwitchLinked(): boolean { return _autoSwitchLinked; }
export function setAutoSwitchLinked(v: boolean): void {
  _autoSwitchLinked = v;
  try { localStorage.setItem(AUTO_SWITCH_KEY, v ? '1' : '0'); } catch { /* ignore */ }
  _autoSwitchListeners.forEach(fn => fn());
}
export function onAutoSwitchChange(fn: () => void): () => void {
  _autoSwitchListeners.add(fn);
  return () => { _autoSwitchListeners.delete(fn); };
}

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
      return;
    }
    // Placement priority:
    //   1. Tab into an existing board group (so multiple boards stack in tabs)
    //   2. Split from an existing PDF panel (board to the left/above — the
    //      LEFT/ABOVE direction is deliberate so board+PDF are distinct groups)
    //   3. Standalone (first panel ever)
    const existingBoard = api.panels.find(p => p.id.startsWith('board-'));
    if (existingBoard) {
      api.addPanel({
        id,
        component: 'boardViewer',
        title: fileName,
        params: { boardTabId: tabId },
        position: { referencePanel: existingBoard.id },
      });
      return;
    }
    const existingPdf = api.panels.find(p => p.id.startsWith('pdf-'));
    if (existingPdf) {
      const isLandscape = api.width >= api.height;
      api.addPanel({
        id,
        component: 'boardViewer',
        title: fileName,
        params: { boardTabId: tabId },
        position: {
          referencePanel: existingPdf.id,
          direction: isLandscape ? 'left' : 'above',
        },
      });
      return;
    }
    api.addPanel({
      id,
      component: 'boardViewer',
      title: fileName,
      params: { boardTabId: tabId },
    });
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
