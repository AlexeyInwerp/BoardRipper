import React, { useEffect, useSyncExternalStore } from 'react';
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

export function ContextMenu() {
  const state = useSyncExternalStore(subscribe, getSnapshot);

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

  const renderItems = (pdfFileName: string, pdfLabel: string) => (
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

  return (
    <div
      className="context-menu"
      style={{ left: state.screenX, top: state.screenY }}
      onClick={(e) => e.stopPropagation()}
    >
      {boundPdfNames.length === 0 ? (
        <div className="context-menu-item disabled">
          Search &apos;{state.componentName}&apos; in PDF (none linked)
        </div>
      ) : boundPdfNames.length === 1 ? (
        renderItems(boundPdfNames[0], ' in PDF')
      ) : (
        boundPdfNames.map(name => (
          <React.Fragment key={name}>
            {renderItems(name, ` in ${name}`)}
          </React.Fragment>
        ))
      )}
    </div>
  );
}
