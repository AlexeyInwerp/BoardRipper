import { useEffect, useSyncExternalStore } from 'react';
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

  const handleSearchInPdf = (e: React.MouseEvent, pdfFileName: string) => {
    e.stopPropagation();
    pdfStore.switchTo(pdfFileName);
    pdfStore.searchText(state.componentName);
    ensurePdfPanel(pdfFileName);
    contextMenuStore.hide();
  };

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
        <div
          className="context-menu-item"
          onClick={(e) => handleSearchInPdf(e, boundPdfNames[0])}
        >
          Search &apos;{state.componentName}&apos; in PDF
        </div>
      ) : (
        boundPdfNames.map(name => (
          <div
            key={name}
            className="context-menu-item"
            onClick={(e) => handleSearchInPdf(e, name)}
          >
            Search &apos;{state.componentName}&apos; in {name}
          </div>
        ))
      )}
    </div>
  );
}
