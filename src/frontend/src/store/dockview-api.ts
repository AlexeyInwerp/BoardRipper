import type { DockviewApi, IDockviewGroupPanel } from 'dockview-react';

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
    // Expand: restore previous width
    const restoreWidth = _sidebarWidthBeforeCollapse || Math.round(api.width / 3);
    group.api.setSize({ width: restoreWidth });
    _sidebarCollapsed = false;
  } else {
    // Collapse: save current width, shrink to ~1% of total width
    _sidebarWidthBeforeCollapse = group.api.width;
    const minWidth = Math.max(Math.round(api.width * 0.01), 4);
    group.api.setSize({ width: minWidth });
    _sidebarCollapsed = true;
  }
  _sidebarListeners.forEach(fn => fn());
}

/** Set sidebar to 1/3 width of the dockview container */
export function setSidebarInitialWidth(): void {
  const api = _api;
  if (!api) return;
  const group = getSidebarGroup();
  if (!group) return;
  // Use requestAnimationFrame to ensure layout is settled
  requestAnimationFrame(() => {
    const targetWidth = Math.round(api.width / 3);
    group.api.setSize({ width: targetWidth });
  });
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
      // Set sidebar to 1/3 width after layout settles
      setSidebarInitialWidth();
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
    console.error(`[dockview] Failed to open ${id} panel:`, err);
  }
}
