import type { DockviewApi, IDockviewGroupPanel } from 'dockview-react';
import { log } from './log-store';

let _api: DockviewApi | null = null;

/** Re-entrancy guard for linked panel activation (board ↔ PDF) */
let _linkActivating = false;
export function isLinkActivating(): boolean { return _linkActivating; }
export function setLinkActivating(v: boolean): void { _linkActivating = v; }

// --- Sidebar (pinnable left panel group) ---
/** IDs of panel types that belong in the sidebar */
const SIDEBAR_PANEL_IDS = new Set(['library', 'settings', 'debug']);
let _sidebarCollapsed = false;
let _sidebarWidthBeforeCollapse = 0;
/** Listeners notified when sidebar collapse state changes */
const _sidebarListeners = new Set<() => void>();

const SIDEBAR_WIDTH_KEY = 'boardripper-sidebar-width';
const DEFAULT_SIDEBAR_RATIO = 0.22; // ~22% of container width

/** Read persisted sidebar width from localStorage (pixels), or null */
function loadSidebarWidth(): number | null {
  try {
    const v = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    return v ? parseInt(v, 10) : null;
  } catch { return null; }
}

/** Save sidebar width to localStorage */
function saveSidebarWidth(px: number): void {
  try { localStorage.setItem(SIDEBAR_WIDTH_KEY, String(Math.round(px))); } catch { /* ignore */ }
}

export function isSidebarCollapsed(): boolean { return _sidebarCollapsed; }
export function onSidebarChange(fn: () => void): () => void {
  _sidebarListeners.add(fn);
  return () => { _sidebarListeners.delete(fn); };
}

/** Get the current pixel width of the sidebar group (for positioning the toggle button) */
export function getSidebarWidth(): number {
  const group = getSidebarGroup();
  if (!group) return 0;
  return group.api.width;
}

/** Get or create the sidebar group, returning it */
function getSidebarGroup(): IDockviewGroupPanel | undefined {
  const api = _api;
  if (!api) return undefined;
  // The sidebar group is the group containing the 'library' panel (first sidebar panel created)
  const libraryPanel = api.getPanel('library');
  if (libraryPanel) return libraryPanel.group;
  // Or find any sidebar panel's group
  for (const p of api.panels) {
    if (SIDEBAR_PANEL_IDS.has(p.id)) return p.group;
  }
  return undefined;
}

export function toggleSidebar(): void {
  const api = _api;
  if (!api) return;
  const group = getSidebarGroup();
  if (!group) return;

  if (_sidebarCollapsed) {
    // Expand: restore constraints and previous width
    group.api.setConstraints({ minimumWidth: 100 });
    const restoreWidth = _sidebarWidthBeforeCollapse || loadSidebarWidth() || Math.round(api.width * DEFAULT_SIDEBAR_RATIO);
    group.api.setSize({ width: restoreWidth });
    _sidebarCollapsed = false;
  } else {
    // Collapse: save current width, allow 0 minimum, then hide completely
    _sidebarWidthBeforeCollapse = group.api.width;
    saveSidebarWidth(group.api.width);
    group.api.setConstraints({ minimumWidth: 0 });
    group.api.setSize({ width: 0 });
    _sidebarCollapsed = true;

    // Equalize remaining groups so they split the space evenly
    requestAnimationFrame(() => equalizeContentGroups());
  }
  _sidebarListeners.forEach(fn => fn());
}

/** Distribute equal widths across all non-sidebar groups */
function equalizeContentGroups(): void {
  const api = _api;
  if (!api) return;
  const sidebarGroup = getSidebarGroup();
  const contentGroups = api.groups.filter(g => g !== sidebarGroup);
  if (contentGroups.length < 2) return;
  const perGroup = Math.floor(api.width / contentGroups.length);
  for (const g of contentGroups) {
    g.api.setSize({ width: perGroup });
  }
}

/** Set sidebar to persisted width (or default ~22%), and persist on manual resize */
export function setSidebarInitialWidth(): void {
  const api = _api;
  if (!api) return;
  const group = getSidebarGroup();
  if (!group) return;
  requestAnimationFrame(() => {
    const saved = loadSidebarWidth();
    const targetWidth = saved ?? Math.round(api.width * DEFAULT_SIDEBAR_RATIO);
    group.api.setSize({ width: targetWidth });
    _sidebarListeners.forEach(fn => fn());
  });
}

/** Guard: when true, layout changes are automatic (not user-initiated) — don't persist */
let _restoringLayout = false;

/**
 * Restore the sidebar to its intended width after Dockview redistributes space
 * (e.g. when a content panel is closed). Called from onDidRemovePanel.
 */
export function preserveSidebarWidth(): void {
  const api = _api;
  if (!api) return;
  const group = getSidebarGroup();
  if (!group) return;

  _restoringLayout = true;

  if (_sidebarCollapsed) {
    // Sidebar is collapsed — Dockview may have given it width during redistribution.
    // Force it back to 0 and equalize the content panels.
    requestAnimationFrame(() => {
      group.api.setConstraints({ minimumWidth: 0 });
      group.api.setSize({ width: 0 });
      equalizeContentGroups();
      _sidebarListeners.forEach(fn => fn());
      _restoringLayout = false;
    });
    return;
  }

  const target = loadSidebarWidth() ?? Math.round(api.width * DEFAULT_SIDEBAR_RATIO);
  // Defer to next frame so Dockview finishes its own layout pass first
  requestAnimationFrame(() => {
    group.api.setSize({ width: target });
    _sidebarListeners.forEach(fn => fn());
    _restoringLayout = false;
  });
}

/** Save the current sidebar width (call after user manually resizes) */
export function persistSidebarWidth(): void {
  if (_sidebarCollapsed || _restoringLayout) return;
  const group = getSidebarGroup();
  if (!group) return;
  if (group.api.width > 0) saveSidebarWidth(group.api.width);
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
    } else {
      const existingBoard = api.panels.find(p => p.id.startsWith('board-'));
      api.addPanel({
        id,
        component: 'boardViewer',
        title: fileName,
        params: { boardTabId: tabId },
        position: existingBoard
          ? { referencePanel: existingBoard.id }
          : (() => {
              // Place to the right of the library panel (not as a tab inside it)
              const library = api.getPanel('library');
              if (library) return { referencePanel: library.id, direction: 'right' as const };
              return undefined;
            })(),
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
      if (_sidebarCollapsed) toggleSidebar();
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
      // Set sidebar to 1/3 width after layout settles
      setSidebarInitialWidth();
    }
  } catch (err) {
    log.ui.error('Failed to open library panel:', err);
  }
}

export function ensureUtilityPanel(id: string, component: string, title: string): void {
  try {
    const api = getDockviewApi();
    if (!api) return;
    const existing = api.getPanel(id);
    if (existing) {
      existing.api.setActive();
      return;
    }

    // Route utility panels (settings, debug) into the sidebar group as tabs
    const sidebarGroup = getSidebarGroup();
    if (sidebarGroup) {
      // Find any panel in the sidebar group to use as a reference for 'within' placement
      const sidebarPanel = api.panels.find(p => p.group === sidebarGroup);
      api.addPanel({
        id,
        component,
        title,
        position: sidebarPanel
          ? { referencePanel: sidebarPanel.id, direction: 'within' }
          : undefined,
      });

      // If sidebar was collapsed, expand it so user sees the new panel
      if (_sidebarCollapsed) {
        toggleSidebar();
      }
      return;
    }

    // Fallback: no sidebar exists yet, place standalone
    api.addPanel({ id, component, title });
  } catch (err) {
    log.ui.error(`Failed to open ${id} panel:`, err);
  }
}
