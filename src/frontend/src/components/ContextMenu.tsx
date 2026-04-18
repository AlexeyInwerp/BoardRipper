import React, { useEffect, useRef, useSyncExternalStore, useState } from 'react';
import { contextMenuStore } from '../store/context-menu-store';
import type { ContextMenuState } from '../store/context-menu-store';
import { boardStore } from '../store/board-store';
import { pdfStore } from '../store/pdf-store';
import { ensurePdfPanel } from '../store/dockview-api';
import { fileInputRefs } from '../store/file-inputs';
import { findInBoardTab, countInBoardTab, findInPdf } from '../store/cross-target-search';
import { SearchScopeBadge } from './SearchScopeBadge';

/**
 * ============================================================================
 *  KEEP IN SYNC — renderBoardBody() and renderPdfBody() share a UI contract:
 *    • Flat one-liner rows, never submenus or umbrellas
 *    • Row format: [scope-badge] <donor-short-name> — <query-label> (<count>)
 *    • Grouped under muted .context-menu-group-header labels with separators
 *    • Zero-count rows stay clickable — users may jump to a target and tweak
 *      the query there. Do not add `disabled` based on count.
 *
 *  When changing one body (row format, group structure, badge placement,
 *  click behavior) update the other so the two right-click modes stay
 *  visually and behaviorally consistent. The symmetry is load-bearing for
 *  the user's mental model.
 * ============================================================================
 */

let version = 0;
let lastVer = -1;
let cached: ContextMenuState | null = null;

contextMenuStore.subscribe(() => { version++; });

function getSnapshot() {
  if (lastVer !== version || !cached) {
    cached = contextMenuStore.state;
    lastVer = version;
  }
  return cached;
}

function subscribe(cb: () => void) {
  return contextMenuStore.subscribe(cb);
}

/** Strip extension for shorter display labels */
function shortPdfName(fileName: string): string {
  return fileName.replace(/\.pdf$/i, '');
}

/** Strip extension for shorter board display labels */
function shortBoardName(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, '');
}

export function ContextMenu() {
  const state = useSyncExternalStore(subscribe, getSnapshot);
  const menuRef = useRef<HTMLDivElement>(null);

  // Clamp menu position to viewport after render
  useEffect(() => {
    const el = menuRef.current;
    if (!el || !state.visible) return;
    const rect = el.getBoundingClientRect();
    const maxX = window.innerWidth - 8;
    const maxY = window.innerHeight - 8;
    if (rect.right > maxX) el.style.left = `${state.screenX - (rect.right - maxX)}px`;
    if (rect.bottom > maxY) el.style.top = `${state.screenY - (rect.bottom - maxY)}px`;
  }, [state.visible, state.screenX, state.screenY]);

  // Track visibility transitions so the one-time reset hook mirrors board.
  // Kept for parity with the previous design — no open-submenu state exists
  // anymore since both bodies render flat rows.
  const [trackedVisible, setTrackedVisible] = useState(false);
  if (state.visible !== trackedVisible) setTrackedVisible(state.visible);

  useEffect(() => {
    if (!state.visible) return;
    const handleClick = () => contextMenuStore.hide();
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') contextMenuStore.hide();
    };
    document.addEventListener('click', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('click', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [state.visible]);

  if (!state.visible) return null;

  // ── Board-mode derivations ───────────────────────────────────────────────
  const activeTab = boardStore.tabs.find(t => t.id === boardStore.activeTabId);
  const boundPdfNames = activeTab?.pdfFileNames ?? [];
  const allOpenPdfNames = pdfStore.loadedFileNames;
  const boundOpen = boundPdfNames.filter(n => allOpenPdfNames.includes(n));
  const otherPdfNames = allOpenPdfNames.filter(n => !boundOpen.includes(n));
  const otherBoardTabs = boardStore.tabs.filter(
    t => t.id !== boardStore.activeTabId && t.board !== null,
  );

  // ── PDF-mode derivations ─────────────────────────────────────────────────
  const originPdf = state.originPdfFileName;
  const boundBoardTabs = boardStore.tabs.filter(
    t => t.board !== null && t.pdfFileNames.includes(originPdf),
  );
  const otherBoardsForPdf = boardStore.tabs.filter(
    t => t.board !== null && !t.pdfFileNames.includes(originPdf),
  );
  const otherPdfsForPdf = allOpenPdfNames.filter(n => n !== originPdf);

  // ── Shared click dispatchers ────────────────────────────────────────────
  const doPdfSearch = (e: React.MouseEvent, pdfFileName: string, query: string) => {
    e.stopPropagation();
    pdfStore.switchTo(pdfFileName);
    pdfStore.searchText(query);
    ensurePdfPanel(pdfFileName);
    contextMenuStore.hide();
    // Activate the PDF panel (ensurePdfPanel already does this) and focus
    // the search input. Wait a tick for the panel's onDidActiveChange effect
    // to register searchInputRef into fileInputRefs.pdfSearch.
    setTimeout(() => {
      const input = fileInputRefs.pdfSearch;
      if (!input) return;
      input.focus();
      input.select();
    }, 0);
  };

  const doBoardSearch = (e: React.MouseEvent, tabId: number, query: string) => {
    e.stopPropagation();
    findInBoardTab(query, tabId);
    contextMenuStore.hide();
  };

  const doPdfDonorFromPdf = (e: React.MouseEvent, fileName: string) => {
    e.stopPropagation();
    findInPdf(state.query, fileName);
    contextMenuStore.hide();
  };

  // ── Generic flat-row renderer ───────────────────────────────────────────
  /** [scope-badge] <donorLabel> — <queryLabel> (<count>). Always clickable. */
  const renderDonorRow = (
    key: string,
    scope: 'board' | 'pdf',
    donorLabel: string,
    queryLabel: string,
    count: number,
    onClick: (e: React.MouseEvent) => void,
  ) => (
    <div
      key={key}
      className="context-menu-item"
      onClick={onClick}
    >
      <SearchScopeBadge scope={scope} />
      {' '}{donorLabel} — {queryLabel} ({count})
    </div>
  );

  // ── Board right-click body ──────────────────────────────────────────────
  // Query variants available from a component right-click:
  //   - componentName (always, e.g. "UF400")
  //   - chipPinQuery  (when pin selected, e.g. "F11@UF400") — PDF-only idiom
  //   - netName       (when pin on a net, e.g. "PP_VCC")
  const renderBoardBody = () => {
    const componentName = state.componentName;
    const chipPinQuery = state.pinId ? `${state.pinId}@${componentName}` : null;
    const netName = state.netName;

    const nothingToSearch =
      boundOpen.length === 0 &&
      otherPdfNames.length === 0 &&
      otherBoardTabs.length === 0;

    if (nothingToSearch) {
      return (
        <div className="context-menu-item disabled">
          Search &apos;{componentName}&apos; in PDF (none linked)
        </div>
      );
    }

    const sections: React.ReactNode[] = [];

    // Helper: emit PDF-donor rows for one file (component, chip@pin, net).
    const pdfRowsFor = (name: string, keyPrefix: string) => {
      const short = shortPdfName(name);
      const lower = componentName.toLowerCase();
      const compCount = pdfStore.countTextMatches(name, lower);
      const rows: React.ReactNode[] = [
        renderDonorRow(
          `${keyPrefix}:${name}:comp`,
          'pdf', short, componentName, compCount,
          (e) => doPdfSearch(e, name, componentName),
        ),
      ];
      if (chipPinQuery) {
        const ccount = pdfStore.countTextMatches(name, chipPinQuery.toLowerCase());
        rows.push(renderDonorRow(
          `${keyPrefix}:${name}:chip`,
          'pdf', short, chipPinQuery, ccount,
          (e) => doPdfSearch(e, name, chipPinQuery),
        ));
      }
      if (netName) {
        const ncount = pdfStore.countTextMatches(name, netName.toLowerCase());
        rows.push(renderDonorRow(
          `${keyPrefix}:${name}:net`,
          'pdf', short, `net ${netName}`, ncount,
          (e) => doPdfSearch(e, name, netName),
        ));
      }
      return rows;
    };

    // Helper: emit Board-donor rows for one tab (component + net — chip@pin
    // is a PDF-text idiom that doesn't apply to board data).
    const boardRowsFor = (tab: { id: number; fileName: string }, keyPrefix: string) => {
      const short = shortBoardName(tab.fileName);
      const compCount = countInBoardTab(componentName, tab.id);
      const rows: React.ReactNode[] = [
        renderDonorRow(
          `${keyPrefix}:${tab.id}:comp`,
          'board', short, componentName, compCount,
          (e) => doBoardSearch(e, tab.id, componentName),
        ),
      ];
      if (netName) {
        const ncount = countInBoardTab(netName, tab.id);
        rows.push(renderDonorRow(
          `${keyPrefix}:${tab.id}:net`,
          'board', short, `net ${netName}`, ncount,
          (e) => doBoardSearch(e, tab.id, netName),
        ));
      }
      return rows;
    };

    if (boundOpen.length > 0) {
      sections.push(
        <React.Fragment key="bound-pdfs">
          <div className="context-menu-separator" />
          <div className="context-menu-group-header">Bound PDFs</div>
          {boundOpen.flatMap(name => pdfRowsFor(name, 'bound-pdf'))}
        </React.Fragment>,
      );
    }
    if (otherPdfNames.length > 0) {
      sections.push(
        <React.Fragment key="other-pdfs">
          <div className="context-menu-separator" />
          <div className="context-menu-group-header">Other PDFs</div>
          {otherPdfNames.flatMap(name => pdfRowsFor(name, 'other-pdf'))}
        </React.Fragment>,
      );
    }
    if (otherBoardTabs.length > 0) {
      sections.push(
        <React.Fragment key="other-boards">
          <div className="context-menu-separator" />
          <div className="context-menu-group-header">Other Boards</div>
          {otherBoardTabs.flatMap(tab => boardRowsFor(tab, 'other-board'))}
        </React.Fragment>,
      );
    }

    return <>{sections}</>;
  };

  // ── PDF right-click body ────────────────────────────────────────────────
  // Only one query available: the text item under the cursor.
  const renderPdfBody = () => {
    if (!state.query) {
      return <div className="context-menu-item disabled">No text at this point</div>;
    }

    const nothingToSearch =
      boundBoardTabs.length === 0 &&
      otherBoardsForPdf.length === 0 &&
      otherPdfsForPdf.length === 0;

    if (nothingToSearch) {
      return <div className="context-menu-item disabled">Nowhere to search</div>;
    }

    const sections: React.ReactNode[] = [];

    if (boundBoardTabs.length > 0) {
      sections.push(
        <React.Fragment key="bound-boards">
          <div className="context-menu-separator" />
          <div className="context-menu-group-header">Bound Boards</div>
          {boundBoardTabs.map(tab => renderDonorRow(
            `pdf-bound:${tab.id}`,
            'board',
            shortBoardName(tab.fileName),
            state.query,
            countInBoardTab(state.query, tab.id),
            (e) => doBoardSearch(e, tab.id, state.query),
          ))}
        </React.Fragment>,
      );
    }
    if (otherBoardsForPdf.length > 0) {
      sections.push(
        <React.Fragment key="other-boards">
          <div className="context-menu-separator" />
          <div className="context-menu-group-header">Other Boards</div>
          {otherBoardsForPdf.map(tab => renderDonorRow(
            `pdf-other-board:${tab.id}`,
            'board',
            shortBoardName(tab.fileName),
            state.query,
            countInBoardTab(state.query, tab.id),
            (e) => doBoardSearch(e, tab.id, state.query),
          ))}
        </React.Fragment>,
      );
    }
    if (otherPdfsForPdf.length > 0) {
      sections.push(
        <React.Fragment key="other-pdfs">
          <div className="context-menu-separator" />
          <div className="context-menu-group-header">Other PDFs</div>
          {otherPdfsForPdf.map(name => renderDonorRow(
            `pdf-other-pdf:${name}`,
            'pdf',
            shortPdfName(name),
            state.query,
            pdfStore.countTextMatches(name, state.query.toLowerCase()),
            (e) => doPdfDonorFromPdf(e, name),
          ))}
        </React.Fragment>,
      );
    }

    return <>{sections}</>;
  };

  return (
    <div
      className="context-menu"
      ref={menuRef}
      style={{ left: state.screenX, top: state.screenY }}
      onClick={(e) => e.stopPropagation()}
    >
      {state.source === 'board' ? renderBoardBody() : renderPdfBody()}
    </div>
  );
}
