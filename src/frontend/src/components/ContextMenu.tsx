import { useEffect, useSyncExternalStore } from 'react';
import { contextMenuStore } from '../store/context-menu-store';
import type { ContextMenuState } from '../store/context-menu-store';
import { pdfStore } from '../store/pdf-store';
import { getDockviewApi } from '../store/dockview-api';

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

  const hasPdf = pdfStore.isLoaded;

  const handleSearchInPdf = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!hasPdf) return;
    pdfStore.searchText(state.componentName);

    // Ensure PDF panel is visible
    const api = getDockviewApi();
    if (api) {
      const panel = api.getPanel('pdfViewer');
      if (panel) {
        panel.api.setActive();
      }
    }

    contextMenuStore.hide();
  };

  return (
    <div
      className="context-menu"
      style={{ left: state.screenX, top: state.screenY }}
      onClick={(e) => e.stopPropagation()}
    >
      <div
        className={`context-menu-item ${hasPdf ? '' : 'disabled'}`}
        onClick={handleSearchInPdf}
      >
        Search &apos;{state.componentName}&apos; in PDF
      </div>
    </div>
  );
}
