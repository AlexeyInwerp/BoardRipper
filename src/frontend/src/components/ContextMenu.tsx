import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { contextMenuStore } from '../store/context-menu-store';
import type { ContextMenuState } from '../store/context-menu-store';
import { boardStore } from '../store/board-store';
import { pdfStore } from '../store/pdf-store';
import { ensurePdfPanel } from '../store/dockview-api';
import { fileInputRefs } from '../store/file-inputs';
import { findInBoardTab, countInBoardTab, findInPdf } from '../store/cross-target-search';
import { SearchScopeBadge } from './SearchScopeBadge';

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

interface DonorGroup<T> {
  /** Scope for the shared badge component */
  scope: 'board' | 'pdf';
  /** Stable key prefix so submenu keys from different groups never collide */
  keyPrefix: string;
  /** Label shown on the quick-search row (1-or-2-item case), e.g. "Board" */
  quickSearchLabel: string;
  /** Umbrella label shown when the group collapses (≥3 items — Task 5) */
  umbrellaLabel: string;
  /** Items to render (board tabs, PDF file names, etc.) */
  items: T[];
  /** Unique key per item for React + submenu state */
  itemKey: (item: T) => string;
  /** Short display label (extension-stripped) for submenu trigger rows */
  itemLabel: (item: T) => string;
  /** Click target for the quick-search row (component-name query on items[0]) */
  onQuickSearch: (item: T) => void;
  /** Content of the per-item expanded submenu (query variants) */
  renderSubmenu: (item: T) => React.ReactNode;
  /** Items for the 1-item flat case (full query variants inline) */
  renderFlatItems: (item: T) => React.ReactNode;
}

function renderDonorGroup<T>(
  g: DonorGroup<T>,
  openSubmenu: string | null,
  setOpenSubmenu: (k: string | null) => void,
  componentName: string,
): React.ReactNode {
  if (g.items.length === 0) return null;

  // 1 item → flat query variants inline
  if (g.items.length === 1) {
    return (
      <>
        <div className="context-menu-separator" />
        {g.renderFlatItems(g.items[0])}
      </>
    );
  }

  // 2 items → top-level per-item submenu triggers (flat expansion)
  if (g.items.length === 2) {
    return (
      <>
        <div className="context-menu-separator" />
        <div
          className="context-menu-item"
          onClick={() => g.onQuickSearch(g.items[0])}
        >
          <SearchScopeBadge scope={g.scope} />
          {' '}Search &apos;{componentName}&apos; in {g.quickSearchLabel}
        </div>
        <div className="context-menu-separator" />
        {g.items.map(item => {
          const key = `${g.keyPrefix}:${g.itemKey(item)}`;
          return (
            <div
              key={key}
              className="context-menu-submenu-trigger"
              onMouseEnter={() => setOpenSubmenu(key)}
              onMouseLeave={() => setOpenSubmenu(null)}
            >
              <div className="context-menu-item context-menu-has-submenu">
                <SearchScopeBadge scope={g.scope} />
                {' '}{g.itemLabel(item)}
                <span className="context-submenu-arrow">▸</span>
              </div>
              {openSubmenu === key && (
                <div className="context-submenu">
                  {g.renderSubmenu(item)}
                </div>
              )}
            </div>
          );
        })}
      </>
    );
  }

  // ≥3 items → umbrella: one top-level trigger reveals per-item submenu
  //            triggers inside (two-level nesting). Keeps the menu compact
  //            when many donors are open.
  const umbrellaKey = `umbrella:${g.keyPrefix}`;
  return (
    <>
      <div className="context-menu-separator" />
      <div
        className="context-menu-submenu-trigger"
        onMouseEnter={() => setOpenSubmenu(umbrellaKey)}
        onMouseLeave={() => setOpenSubmenu(null)}
      >
        <div className="context-menu-item context-menu-has-submenu">
          <SearchScopeBadge scope={g.scope} />
          {' '}{g.umbrellaLabel}
          <span className="context-submenu-arrow">▸</span>
        </div>
        {openSubmenu?.startsWith(`umbrella:${g.keyPrefix}`) || openSubmenu?.startsWith(`item:${g.keyPrefix}`) ? (
          <div className="context-submenu">
            {g.items.map(item => {
              const key = `item:${g.keyPrefix}:${g.itemKey(item)}`;
              return (
                <div
                  key={key}
                  className="context-menu-submenu-trigger"
                  onMouseEnter={(e) => { e.stopPropagation(); setOpenSubmenu(key); }}
                >
                  <div className="context-menu-item context-menu-has-submenu">
                    <SearchScopeBadge scope={g.scope} />
                    {' '}{g.itemLabel(item)}
                    <span className="context-submenu-arrow">▸</span>
                  </div>
                  {openSubmenu === key && (
                    <div className="context-submenu">
                      {g.renderSubmenu(item)}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
    </>
  );
}

export function ContextMenu() {
  const state = useSyncExternalStore(subscribe, getSnapshot);
  const [openSubmenu, setOpenSubmenu] = useState<string | null>(null);
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

  // Reset submenu when menu opens — derive during render (React-recommended pattern)
  const [trackedVisible, setTrackedVisible] = useState(false);
  if (state.visible !== trackedVisible) {
    setTrackedVisible(state.visible);
    if (state.visible) setOpenSubmenu(null);
  }

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

  // Get the active board tab's bound PDF names
  const activeTab = boardStore.tabs.find(t => t.id === boardStore.activeTabId);
  const boundPdfNames = activeTab?.pdfFileNames ?? [];

  // Other board tabs (for donor-search submenu). Only include tabs with a
  // loaded board — donor rows won't render until the target is ready.
  const otherBoardTabs = boardStore.tabs.filter(
    t => t.id !== boardStore.activeTabId && t.board !== null,
  );

  // All open PDFs minus bound ones → the "Other PDFs" donor group.
  // Includes unbound PDFs and those bound to other boards. Filter the
  // bound list through actually-loaded names to guard stale references.
  const allOpenPdfNames = pdfStore.loadedFileNames;
  const boundOpen = boundPdfNames.filter(n => allOpenPdfNames.includes(n));
  const otherPdfNames = allOpenPdfNames.filter(n => !boundOpen.includes(n));

  // PDF-mode derivations — meaningful only when state.source === 'pdf'
  const originPdf = state.originPdfFileName;
  const boundBoardTabs = boardStore.tabs.filter(
    t => t.board !== null && t.pdfFileNames.includes(originPdf),
  );
  const otherBoardsForPdf = boardStore.tabs.filter(
    t => t.board !== null && !t.pdfFileNames.includes(originPdf),
  );
  const otherPdfsForPdf = allOpenPdfNames.filter(n => n !== originPdf);

  const doBoardSearch = (e: React.MouseEvent, tabId: number, query: string) => {
    e.stopPropagation();
    findInBoardTab(query, tabId);
    contextMenuStore.hide();
  };

  const doSearch = (e: React.MouseEvent, pdfFileName: string, query: string) => {
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

  // @ syntax: PIN@CHIP — "find pin F11 at chip UF400", whole-page co-occurrence
  const chipPinQuery = state.pinId ? `${state.pinId}@${state.componentName}` : null;
  const netName = state.netName;

  // Single PDF: flat list of all search options
  const renderFlatItems = (pdfFileName: string, pdfLabel: string) => (
    <>
      {chipPinQuery && (
        <div
          className="context-menu-item"
          onClick={(e) => doSearch(e, pdfFileName, chipPinQuery)}
        >
          Search &apos;{chipPinQuery}&apos;{pdfLabel}
        </div>
      )}
      <div
        className="context-menu-item"
        onClick={(e) => doSearch(e, pdfFileName, state.componentName)}
      >
        Search &apos;{state.componentName}&apos;{pdfLabel}
      </div>
      {netName && (
        <div
          className="context-menu-item"
          onClick={(e) => doSearch(e, pdfFileName, netName)}
        >
          Search net &apos;{netName}&apos;{pdfLabel}
        </div>
      )}
    </>
  );

  /** Flat items for the single-other-board case */
  const renderBoardFlatItems = (tabId: number, boardLabel: string) => (
    <>
      <div
        className="context-menu-item"
        onClick={(e) => doBoardSearch(e, tabId, state.componentName)}
      >
        Search &apos;{state.componentName}&apos; in {boardLabel}
      </div>
      {netName && (
        <div
          className="context-menu-item"
          onClick={(e) => doBoardSearch(e, tabId, netName)}
        >
          Search net &apos;{netName}&apos; in {boardLabel}
        </div>
      )}
    </>
  );

  /** Submenu items for a single other board (multi-board case).
   *  Each row is suffixed with a match count; zero-count rows are disabled. */
  const renderBoardSubmenuItems = (tabId: number) => {
    const partCount = countInBoardTab(state.componentName, tabId);
    const netCount = netName ? countInBoardTab(netName, tabId) : 0;
    return (
      <>
        <div
          className={`context-menu-item context-submenu-item${partCount === 0 ? ' disabled' : ''}`}
          onClick={partCount === 0 ? undefined : (e) => doBoardSearch(e, tabId, state.componentName)}
        >
          {state.componentName} ({partCount})
        </div>
        {netName && (
          <div
            className={`context-menu-item context-submenu-item${netCount === 0 ? ' disabled' : ''}`}
            onClick={netCount === 0 ? undefined : (e) => doBoardSearch(e, tabId, netName)}
          >
            net {netName} ({netCount})
          </div>
        )}
      </>
    );
  };

  // Multi-PDF submenu items for a single PDF
  const renderSubmenuItems = (pdfFileName: string) => (
    <>
      <div
        className="context-menu-item context-submenu-item"
        onClick={(e) => doSearch(e, pdfFileName, state.componentName)}
      >
        {state.componentName}
      </div>
      {chipPinQuery && (
        <div
          className="context-menu-item context-submenu-item"
          onClick={(e) => doSearch(e, pdfFileName, chipPinQuery)}
        >
          {chipPinQuery}
        </div>
      )}
      {netName && (
        <div
          className="context-menu-item context-submenu-item"
          onClick={(e) => doSearch(e, pdfFileName, netName)}
        >
          net {netName}
        </div>
      )}
    </>
  );

  const renderBoardBody = () => (
    <>
      {boundOpen.length === 0 && otherPdfNames.length === 0 && (
        <div className="context-menu-item disabled">
          Search &apos;{state.componentName}&apos; in PDF (none linked)
        </div>
      )}
      {/* Bound PDFs: explicitly linked to the active board tab */}
      {renderDonorGroup(
        {
          scope: 'pdf',
          keyPrefix: 'pdf-bound',
          quickSearchLabel: 'PDF',
          umbrellaLabel: 'Bound PDFs',
          items: boundOpen,
          itemKey: (name) => name,
          itemLabel: (name) => shortPdfName(name),
          onQuickSearch: (name) => {
            doSearch({ stopPropagation: () => {} } as React.MouseEvent, name, state.componentName);
          },
          renderSubmenu: (name) => renderSubmenuItems(name),
          renderFlatItems: (name) => renderFlatItems(name, ' in PDF'),
        },
        openSubmenu,
        setOpenSubmenu,
        state.componentName,
      )}
      {/* Other PDFs: unbound or bound to a different board tab */}
      {renderDonorGroup(
        {
          scope: 'pdf',
          keyPrefix: 'pdf-other',
          quickSearchLabel: 'Other PDFs',
          umbrellaLabel: 'Other PDFs',
          items: otherPdfNames,
          itemKey: (name) => name,
          itemLabel: (name) => shortPdfName(name),
          onQuickSearch: (name) => {
            doSearch({ stopPropagation: () => {} } as React.MouseEvent, name, state.componentName);
          },
          renderSubmenu: (name) => renderSubmenuItems(name),
          renderFlatItems: (name) => renderFlatItems(name, ` in ${shortPdfName(name)}`),
        },
        openSubmenu,
        setOpenSubmenu,
        state.componentName,
      )}
      {renderDonorGroup(
        {
          scope: 'board',
          keyPrefix: 'board',
          quickSearchLabel: 'Board',
          umbrellaLabel: 'Other Boards',
          items: otherBoardTabs,
          itemKey: (tab) => String(tab.id),
          itemLabel: (tab) => shortBoardName(tab.fileName),
          onQuickSearch: (tab) => {
            findInBoardTab(state.componentName, tab.id);
            contextMenuStore.hide();
          },
          renderSubmenu: (tab) => renderBoardSubmenuItems(tab.id),
          renderFlatItems: (tab) => renderBoardFlatItems(tab.id, shortBoardName(tab.fileName)),
        },
        openSubmenu,
        setOpenSubmenu,
        state.componentName,
      )}
    </>
  );

  // PDF-mode click handlers + per-item renderers
  const doPdfBoardSearch = (e: React.MouseEvent, tabId: number) => {
    e.stopPropagation();
    findInBoardTab(state.query, tabId);
    contextMenuStore.hide();
  };

  const doPdfPdfSearch = (e: React.MouseEvent, fileName: string) => {
    e.stopPropagation();
    findInPdf(state.query, fileName);
    contextMenuStore.hide();
  };

  const renderPdfBoardFlat = (tab: { id: number; fileName: string }) => (
    <div
      className="context-menu-item"
      onClick={(e) => doPdfBoardSearch(e, tab.id)}
    >
      Search &apos;{state.query}&apos; in {shortBoardName(tab.fileName)}
    </div>
  );

  const renderPdfPdfFlat = (name: string) => (
    <div
      className="context-menu-item"
      onClick={(e) => doPdfPdfSearch(e, name)}
    >
      Search &apos;{state.query}&apos; in {shortPdfName(name)}
    </div>
  );

  const renderPdfBoardSubmenu = (tab: { id: number; fileName: string }) => {
    const count = countInBoardTab(state.query, tab.id);
    return (
      <div
        className={`context-menu-item context-submenu-item${count === 0 ? ' disabled' : ''}`}
        onClick={count === 0 ? undefined : (e) => doPdfBoardSearch(e, tab.id)}
      >
        {state.query} ({count})
      </div>
    );
  };

  const renderPdfPdfSubmenu = (name: string) => (
    <div
      className="context-menu-item context-submenu-item"
      onClick={(e) => doPdfPdfSearch(e, name)}
    >
      {state.query}
    </div>
  );

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

    return (
      <>
        {renderDonorGroup(
          {
            scope: 'board',
            keyPrefix: 'pdf-bound-boards',
            quickSearchLabel: 'Board',
            umbrellaLabel: 'Bound Boards',
            items: boundBoardTabs,
            itemKey: (tab) => String(tab.id),
            itemLabel: (tab) => shortBoardName(tab.fileName),
            onQuickSearch: (tab) => {
              findInBoardTab(state.query, tab.id);
              contextMenuStore.hide();
            },
            renderSubmenu: (tab) => renderPdfBoardSubmenu(tab),
            renderFlatItems: (tab) => renderPdfBoardFlat(tab),
          },
          openSubmenu,
          setOpenSubmenu,
          state.query,
        )}
        {renderDonorGroup(
          {
            scope: 'board',
            keyPrefix: 'pdf-other-boards',
            quickSearchLabel: 'Other Boards',
            umbrellaLabel: 'Other Boards',
            items: otherBoardsForPdf,
            itemKey: (tab) => String(tab.id),
            itemLabel: (tab) => shortBoardName(tab.fileName),
            onQuickSearch: (tab) => {
              findInBoardTab(state.query, tab.id);
              contextMenuStore.hide();
            },
            renderSubmenu: (tab) => renderPdfBoardSubmenu(tab),
            renderFlatItems: (tab) => renderPdfBoardFlat(tab),
          },
          openSubmenu,
          setOpenSubmenu,
          state.query,
        )}
        {renderDonorGroup(
          {
            scope: 'pdf',
            keyPrefix: 'pdf-other-pdfs',
            quickSearchLabel: 'Other PDFs',
            umbrellaLabel: 'Other PDFs',
            items: otherPdfsForPdf,
            itemKey: (name) => name,
            itemLabel: (name) => shortPdfName(name),
            onQuickSearch: (name) => {
              findInPdf(state.query, name);
              contextMenuStore.hide();
            },
            renderSubmenu: (name) => renderPdfPdfSubmenu(name),
            renderFlatItems: (name) => renderPdfPdfFlat(name),
          },
          openSubmenu,
          setOpenSubmenu,
          state.query,
        )}
      </>
    );
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
