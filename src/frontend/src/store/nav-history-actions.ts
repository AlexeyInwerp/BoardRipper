/**
 * Navigation history — back, forward, jump.
 *
 * The only module that both reads the timeline and drives the viewers. A
 * restore replays through the ordinary store methods (`selectPinInTab`,
 * `highlightNet`, `switchTo`, `goToPage`…) with `navHistoryStore.isRestoring`
 * set, so every consumer — renderer, sidebar, PDF-follow, MCP bridge — sees
 * an ordinary change and nothing is recorded twice. The camera is then put
 * back exactly (not fitted: a fit is what the user did *not* want when they
 * pressed back) through the provider the panel registered.
 *
 * Design: docs/specs/2026-09-29-navigation-history-design.md §6.
 */
import { boardStore } from './board-store';
import { pdfStore } from './pdf-store';
import { navHistoryStore } from './nav-history-store';
import { activateLinkedPanel, boardPanelId, ensureBoardPanel, ensurePdfPanel, pdfPanelId } from './dockview-api';
import { log } from './log-store';
import { openBoardSearch } from '../panels/board-viewer-bridge';
import type { NavEntry, BoardPlace, PdfPlace } from './nav-history';

function tabFor(place: BoardPlace) {
  return boardStore.tabs.find(t => t.id === place.tabId)
    ?? boardStore.tabs.find(t => t.cacheKey && t.cacheKey === place.fileKey)
    ?? null;
}

/** Is the file behind this entry still open? Closed files stay listed but are skipped by ⌘[ / ⌘]. */
export function entryReachable(e: NavEntry): boolean {
  if (!e.place) return true;
  if (e.place.kind === 'board') return tabFor(e.place) !== null;
  return pdfStore.hasDoc(e.place.fileName);
}
navHistoryStore.reachable = entryReachable;

function restoreBoard(entry: NavEntry, place: BoardPlace): boolean {
  const tab = tabFor(place);
  if (!tab?.board) return false;

  if (boardStore.activeTabId !== tab.id) {
    ensureBoardPanel(tab.id, tab.fileName);
    if (!activateLinkedPanel(boardPanelId(tab.id), () => boardStore.switchTab(tab.id))) {
      boardStore.switchTab(tab.id);
    }
  } else {
    // Bring the panel to the front of its group without switching tabs.
    activateLinkedPanel(boardPanelId(tab.id), () => {});
  }

  if (place.side) boardStore.setSideVisibility(tab.id, place.side !== 'bottom', place.side !== 'top');

  const hasCamera = !!place.camera;
  if (place.part) {
    const upper = place.part.toUpperCase();
    const part = tab.board.parts.find(p => p.name.toUpperCase() === upper);
    if (!part) {
      boardStore.addToast(`${place.part} is not on this board any more`, 'info');
      log.ui.warn(`history: ${place.part} not found on ${tab.fileName}`);
    } else {
      let pinIndex: number | null = null;
      if (place.pin) {
        const i = part.pins.findIndex(p => (p.number || p.name) === place.pin);
        if (i >= 0) pinIndex = i;
      }
      // Without a recorded pose the store's own focus request frames the part.
      boardStore.selectPinInTab(tab.id, part.name, pinIndex, { focus: !hasCamera });
      if (place.net && place.net !== (pinIndex != null ? part.pins[pinIndex]?.net : null)) {
        boardStore.highlightNet(place.net);
      }
    }
  } else if (place.net) {
    boardStore.highlightNet(place.net);
    if (!hasCamera) boardStore.focusNet(place.net);
  }

  if (place.camera) navHistoryStore.applyBoardCamera(tab.id, place.camera);
  // A result picked from the sidebar / global search: the query comes back too.
  if (entry.query && (entry.query.surface === 'board' || entry.query.surface === 'global')) {
    boardStore.setSearch(entry.query.text);
  }
  return true;
}

function restorePdf(entry: NavEntry, place: PdfPlace): boolean {
  if (!pdfStore.hasDoc(place.fileName)) return false;
  ensurePdfPanel(place.fileName);
  activateLinkedPanel(pdfPanelId(place.fileName), () => pdfStore.switchTo(place.fileName));
  pdfStore.switchTo(place.fileName);

  const query = entry.query?.surface === 'pdf' ? entry.query.text
    : (entry.cause === 'lookup' && entry.query) ? entry.query.text : null;
  if (query) pdfStore.restoreSearch(place.fileName, query, place.match ?? null);

  if (place.camera) navHistoryStore.applyPdfCamera(place.fileName, place.camera);
  else if (!query) pdfStore.goToPage(place.page);
  return true;
}

function restoreQueryOnly(entry: NavEntry): boolean {
  const q = entry.query;
  if (!q) return false;
  if (q.surface === 'pdf') {
    const name = pdfStore.activeDoc?.fileName;
    if (!name) return false;
    pdfStore.restoreSearch(name, q.text, null);
    return true;
  }
  // Board / global / ribbon: put the text back into the board sidebar search.
  const tabId = boardStore.activeTabId;
  if (tabId == null) return false;
  boardStore.setSearch(q.text);
  openBoardSearch(q.text, tabId);
  return true;
}

function restore(entry: NavEntry): boolean {
  navHistoryStore.isRestoring = true;
  try {
    if (entry.place?.kind === 'board') return restoreBoard(entry, entry.place);
    if (entry.place?.kind === 'pdf') return restorePdf(entry, entry.place);
    return restoreQueryOnly(entry);
  } catch (err) {
    log.ui.error('history: restore failed', err);
    return false;
  } finally {
    navHistoryStore.isRestoring = false;
  }
}

function step(dir: -1 | 1): boolean {
  const idx = navHistoryStore.stepIndex(dir);
  if (idx < 0) return false;
  navHistoryStore.touchCurrentCamera();
  navHistoryStore.moveCursor(idx);
  const e = navHistoryStore.current!;
  log.ui.log(`history: ${dir < 0 ? 'back' : 'forward'} → [${e.cause}] ${e.label} #${idx + 1}/${navHistoryStore.entries.length}`);
  restore(e);
  return true;
}

export function historyBack(): boolean { return step(-1); }
export function historyForward(): boolean { return step(1); }

/** Jump to a listed entry: the cursor moves there, nothing is appended. */
export function historyJumpTo(id: number): boolean {
  const idx = navHistoryStore.indexOfId(id);
  if (idx < 0) return false;
  const e = navHistoryStore.entries[idx];
  if (!entryReachable(e)) return false;
  navHistoryStore.touchCurrentCamera();
  navHistoryStore.moveCursor(idx);
  log.ui.log(`history: jump → [${e.cause}] ${e.label} #${idx + 1}/${navHistoryStore.entries.length}`);
  restore(e);
  return true;
}

// Expose for integration tests (Playwright) — DEV builds only
if (typeof window !== 'undefined' && import.meta.env.DEV) {
  (window as unknown as { __navHistory: unknown }).__navHistory = {
    store: navHistoryStore, back: historyBack, forward: historyForward, jumpTo: historyJumpTo,
  };
}
