import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { contextMenuStore } from '../store/context-menu-store';
import type { ContextMenuState } from '../store/context-menu-store';
import { boardStore } from '../store/board-store';
import { pdfStore } from '../store/pdf-store';
import { ensurePdfPanel } from '../store/dockview-api';

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

  const doSearch = (e: React.MouseEvent, pdfFileName: string, query: string) => {
    e.stopPropagation();
    pdfStore.switchTo(pdfFileName);
    pdfStore.searchText(query);
    ensurePdfPanel(pdfFileName);
    contextMenuStore.hide();
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

  return (
    <div
      className="context-menu"
      ref={menuRef}
      style={{ left: state.screenX, top: state.screenY }}
      onClick={(e) => e.stopPropagation()}
    >
      {boundPdfNames.length === 0 ? (
        <div className="context-menu-item disabled">
          Search &apos;{state.componentName}&apos; in PDF (none linked)
        </div>
      ) : boundPdfNames.length === 1 ? (
        renderFlatItems(boundPdfNames[0], ' in PDF')
      ) : (
        <>
          {/* Quick search: component name in first (bound) PDF */}
          <div
            className="context-menu-item"
            onClick={(e) => doSearch(e, boundPdfNames[0], state.componentName)}
          >
            Search &apos;{state.componentName}&apos; in PDF
          </div>
          <div className="context-menu-separator" />
          {/* Per-PDF submenus with all query options */}
          {boundPdfNames.map(name => (
            <div
              key={name}
              className="context-menu-submenu-trigger"
              onMouseEnter={() => setOpenSubmenu(name)}
              onMouseLeave={() => setOpenSubmenu(null)}
            >
              <div className="context-menu-item context-menu-has-submenu">
                {shortPdfName(name)}
                <span className="context-submenu-arrow">▸</span>
              </div>
              {openSubmenu === name && (
                <div className="context-submenu">
                  {renderSubmenuItems(name)}
                </div>
              )}
            </div>
          ))}
        </>
      )}
    </div>
  );
}
