import type { DockviewApi, IDockviewPanel, DockviewGroupPanel } from 'dockview-react';
import { log } from './log-store';
import { isTwoWindowMode, setTwoWindowMode, onTwoWindowModeChange } from './two-window-mode';
import { boardStore } from './board-store';

let _api: DockviewApi | null = null;
/** Re-entrancy guard: suppresses the mode-change side effect during the
 *  popout-window-closed-by-user flow, which flips the flag itself and handles
 *  re-add directly. Without this, the listener would also call
 *  `collapsePdfPopout()` and try to close panels that are already closing. */
let _modeListenerSuppressed = false;
/** Unsubscribe from the mode-change listener registered in `setDockviewApi`.
 *  StrictMode double-mount + Dockview's onReady can call setDockviewApi more
 *  than once; without this guard, listeners pile up and toggles fire N×. */
let _modeUnsubscribe: (() => void) | null = null;
/** Filenames whose pdf-* panel is being closed-and-re-added as part of the
 *  2-window-mode redock flow. App.tsx's onDidRemovePanel handler checks this
 *  set and skips `pdfStore.closeFile()` + binding cleanup for these — the
 *  panel is moving, not being closed by the user. */
const _redockingPdfNames = new Set<string>();
export function isRedockingPdf(fileName: string): boolean {
  return _redockingPdfNames.has(fileName);
}

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
  if (_modeUnsubscribe) { _modeUnsubscribe(); _modeUnsubscribe = null; }
  _modeUnsubscribe = onTwoWindowModeChange(() => {
    if (_modeListenerSuppressed) return;
    if (isTwoWindowMode()) {
      migrateOpenPdfsToPopout().catch(err => log.twoWindow.error('migrate failed:', err));
    } else {
      collapsePdfPopout();
    }
  });
  startThemeBridge();
}

// --- Theme bridge: mirror document.body.className into every popout window ---
// Themes set classes on <body> (light/dark, accent, chrome). Popouts get their
// own <body> from popout.html and don't inherit the class, so PixiJS-adjacent
// CSS variables and dockview theme classes need to be re-applied each time
// the theme changes or a new popout opens.
let _themeObserver: MutationObserver | null = null;
let _themeBridgeInterval: ReturnType<typeof setInterval> | null = null;

function syncThemeToPopouts(): void {
  const api = getDockviewApi();
  if (!api) return;
  const mainClass = document.body.className;
  for (const group of api.groups) {
    if (group.api.location.type !== 'popout') continue;
    const popoutBody = group.api.location.getWindow().document.body;
    if (popoutBody && popoutBody.className !== mainClass) {
      popoutBody.className = mainClass;
    }
  }
}

function startThemeBridge(): void {
  // Clean up any prior bridge BEFORE the observer guard, so a setDockviewApi
  // re-call (StrictMode double-mount, HMR) doesn't leave a stale interval.
  if (_themeBridgeInterval) { clearInterval(_themeBridgeInterval); _themeBridgeInterval = null; }
  if (_themeObserver) return;
  _themeObserver = new MutationObserver(() => syncThemeToPopouts());
  _themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  // Also re-sync periodically so newly opened popouts pick up the current theme
  // even if no class change happened since they opened.
  _themeBridgeInterval = setInterval(syncThemeToPopouts, 500);
}

// Dev hook: expose the dockview API on window so Playwright tests can read
// activePanel.id without importing app modules inside page.evaluate().
// Only installed in DEV builds — the property is never present in production.
if (typeof window !== 'undefined' && import.meta.env.DEV) {
  Object.defineProperty(window as object, '__dockviewApi', {
    get: () => getDockviewApi(),
    configurable: true,
  });
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
        tabComponent: 'boardTab',
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
        tabComponent: 'boardTab',
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
      tabComponent: 'boardTab',
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

/** True if the panel currently lives in a Dockview popout window. */
function isPanelInPopout(panel: IDockviewPanel): boolean {
  return panel.api.location.type === 'popout';
}

/** Find the Dockview popout group that currently owns the open PDFs (if any). */
export function findPopoutPdfGroup(): DockviewGroupPanel | null {
  const api = getDockviewApi();
  if (!api) return null;
  for (const group of api.groups) {
    if (group.api.location.type !== 'popout') continue;
    if (group.panels.some(p => p.id.startsWith('pdf-'))) return group;
  }
  return null;
}

function pdfFileNameFromPanel(panel: IDockviewPanel): string | null {
  const params = panel.params as { pdfFileName?: string } | undefined;
  return params?.pdfFileName ?? null;
}

/** Mode OFF → ON: pop the docked PDFs out into a new window. */
async function migrateOpenPdfsToPopout(): Promise<void> {
  const api = getDockviewApi();
  if (!api) return;
  const docked = api.panels.filter(p => p.id.startsWith('pdf-') && !isPanelInPopout(p));
  if (docked.length === 0) {
    log.twoWindow.log('migrate: no docked PDFs (mode flag set; next PDF lazily creates popout)');
    return;
  }
  const [first, ...rest] = docked;
  const ok = await api.addPopoutGroup(first, {
    onWillClose: () => { handlePopoutWillClose(); },
  });
  if (!ok) {
    log.twoWindow.warn('addPopoutGroup blocked or failed — reverting mode');
    _modeListenerSuppressed = true;
    try { setTwoWindowMode(false); } finally { _modeListenerSuppressed = false; }
    boardStore.addToast('Popup blocked — 2-window mode disabled. Allow popups for this site and try again.', 'info');
    return;
  }
  const popout = findPopoutPdfGroup();
  if (!popout) {
    log.twoWindow.error('Popout opened but group not found in api.groups');
    return;
  }
  for (const panel of rest) {
    panel.api.moveTo({ group: popout });
  }
  log.twoWindow.log(`migrated ${docked.length} PDF(s) to popout`);
}

/** Mode ON → OFF: close popout PDFs, then re-add them via the docked path.
 *  Closing the last panel in a popout group causes Dockview to close the
 *  popout window. State (page/zoom/search) survives because pdfStore is
 *  keyed by file name, not by panel instance. */
function collapsePdfPopout(): void {
  const api = getDockviewApi();
  if (!api) return;
  const popoutPdfs = api.panels.filter(p => p.id.startsWith('pdf-') && isPanelInPopout(p));
  if (popoutPdfs.length === 0) {
    log.twoWindow.log('collapse: no popout PDFs');
    return;
  }
  const fileNames = popoutPdfs.map(pdfFileNameFromPanel).filter((n): n is string => !!n);
  // Mark these as in-transit so App.tsx's onDidRemovePanel doesn't destroy
  // the underlying pdf.js doc + board bindings when we close to re-add.
  for (const n of fileNames) _redockingPdfNames.add(n);
  for (const panel of popoutPdfs) {
    try { panel.api.close(); } catch (err) { log.twoWindow.warn('close failed:', err); }
  }
  // Re-add after Dockview drains close events + React renders. A microtask
  // is too eager — `api.getPanel(id)` can still return the closing panel,
  // making the new ensurePdfPanel() short-circuit to setActive() on a
  // doomed panel. setTimeout(0) defers past the current task boundary.
  setTimeout(() => {
    for (const fileName of fileNames) ensurePdfPanel(fileName);
    // Clear the redocking marker after re-add; further close events on
    // these panels should be treated as real user closes.
    for (const n of fileNames) _redockingPdfNames.delete(n);
  }, 0);
  log.twoWindow.log(`collapsed ${popoutPdfs.length} PDF(s) to main window`);
}

/** Popout is closing (OS close button, redock drag, or last panel closed). */
function handlePopoutWillClose(): void {
  const api = getDockviewApi();
  if (!api) return;
  const popoutPdfs = api.panels.filter(p => p.id.startsWith('pdf-') && isPanelInPopout(p));
  const fileNames = popoutPdfs.map(pdfFileNameFromPanel).filter((n): n is string => !!n);
  if (isTwoWindowMode()) {
    log.twoWindow.log('popout closing — disabling 2-window mode');
    // Flip without firing the listener (Dockview already closes the panels
    // for us; collapsePdfPopout would just double-close).
    _modeListenerSuppressed = true;
    try { setTwoWindowMode(false); } finally { _modeListenerSuppressed = false; }
  }
  // Mark in-transit so onDidRemovePanel doesn't destroy the pdf.js doc.
  for (const n of fileNames) _redockingPdfNames.add(n);
  // Re-add the PDFs in the main window after Dockview drains its close events.
  setTimeout(() => {
    for (const fileName of fileNames) ensurePdfPanel(fileName);
    for (const n of fileNames) _redockingPdfNames.delete(n);
  }, 0);
}

export function worklistPanelId(): string { return 'worklist-panel'; }

export function ensureWorklistPanel(): void {
  try {
    const api = getDockviewApi();
    if (!api) return;
    const id = worklistPanelId();
    const existing = api.getPanel(id);
    if (existing) {
      existing.api.setActive();
      return;
    }
    // Default placement: tab into the nearest non-board, non-pdf group so the
    // Worklist panel lives alongside other tool panels (or float as a standalone
    // group if none exist).
    const anchorPanel = api.panels.find(p => !p.id.startsWith('board-') && !p.id.startsWith('pdf-'));
    api.addPanel({
      id,
      component: 'worklist',
      title: 'Worklist',
      ...(anchorPanel
        ? { position: { referencePanel: anchorPanel.id } }
        : (() => {
            const anyBoard = api.panels.find(p => p.id.startsWith('board-'));
            return anyBoard
              ? { position: { referencePanel: anyBoard.id, direction: 'right' as const } }
              : {};
          })()),
    });
  } catch (err) {
    log.ui.error('Failed to open Worklist panel:', err);
  }
}

export function ensurePdfPanel(fileName: string): void {
  (async () => {
    try {
      const api = getDockviewApi();
      if (!api) return;
      const id = pdfPanelId(fileName);
      const existing = api.getPanel(id);
      if (existing) {
        existing.api.setActive();
        return;
      }

      if (isTwoWindowMode()) {
        const popoutGroup = findPopoutPdfGroup();
        if (popoutGroup) {
          // Popout already exists → drop a new tab into it.
          api.addPanel({
            id,
            component: 'pdfViewer',
            tabComponent: 'pdfTab',
            title: fileName,
            params: { pdfFileName: fileName },
            position: { referenceGroup: popoutGroup.id },
          });
          // Raise the popout window so the user notices the new tab —
          // without this, the popout silently gains a tab while the main
          // window stays focused and the user thinks nothing happened.
          if (popoutGroup.api.location.type === 'popout') {
            try { popoutGroup.api.location.getWindow().focus(); }
            catch (err) { log.twoWindow.warn('popout focus failed:', err); }
          }
          return;
        }
        // No popout yet → add the panel in main grid, then popout it. The
        // briefly-visible main-grid placement is acceptable; the popout opens
        // within ~50ms on the user-gesture path.
        const tempPanel = api.addPanel({
          id,
          component: 'pdfViewer',
          tabComponent: 'pdfTab',
          title: fileName,
          params: { pdfFileName: fileName },
        });
        const ok = await api.addPopoutGroup(tempPanel, {
          onWillClose: () => { handlePopoutWillClose(); },
        });
        if (!ok) {
          log.twoWindow.warn('popup blocked — PDF left in main grid:', fileName);
          boardStore.addToast('Popup blocked — PDF opened in main window. Click the 2-window button to retry.', 'info');
        }
        return;
      }

      // Mode OFF — original docked-placement logic.
      const existingPdf = api.panels.find(p => p.id.startsWith('pdf-'));
      api.addPanel({
        id,
        component: 'pdfViewer',
        tabComponent: 'pdfTab',
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
    } catch (err) {
      log.ui.error('Failed to open PDF panel:', err);
    }
  })();
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
