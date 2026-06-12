import { useCallback, useRef, useSyncExternalStore } from 'react';
import type { IDockviewPanelHeaderProps } from 'dockview-react';
import { useBoardStore } from '../hooks/useBoardStore';
import { boardStore } from '../store/board-store';
import { pdfStore } from '../store/pdf-store';
import { BindLink } from './BindLink';

/** Subscribes to dockview title changes via useSyncExternalStore — avoids the
 *  effect-setState race that dockview's own useTitle has (also avoids the
 *  react-hooks/set-state-in-effect lint error). */
function useTitle(api: IDockviewPanelHeaderProps['api']): string {
  return useSyncExternalStore(
    (cb) => {
      const disposable = api.onDidTitleChange(cb);
      return () => disposable.dispose();
    },
    () => api.title ?? '',
  );
}

// Stable snapshot of open PDF names for useSyncExternalStore (the store
// getter builds a fresh array per call). Module-level cache, invalidated on
// every pdfStore notify — same pattern as SettingsPanel's theme overrides.
let _pdfNamesCache: string[] | null = null;
pdfStore.subscribe(() => { _pdfNamesCache = null; });
function getPdfNamesSnapshot(): string[] {
  if (!_pdfNamesCache) _pdfNamesCache = pdfStore.loadedFileNames;
  return _pdfNamesCache;
}

/**
 * Board-specific dockview tab header. Mirrors DockviewDefaultTab's structure
 * and close-button behavior. The ∞ link control is a full BindLink (board →
 * PDFs, multi-select) so linking works from the board side too — previously
 * the only entry point was the PDF toolbar.
 */
export function BoardTab(props: IDockviewPanelHeaderProps<{ boardTabId?: number }>) {
  const { api, params } = props;
  const title = useTitle(api);
  const { tabs } = useBoardStore();
  const pdfNames = useSyncExternalStore(
    (cb) => pdfStore.subscribe(cb),
    getPdfNamesSnapshot,
  );

  const tabId = params.boardTabId;
  const tab = tabId != null ? tabs.find(t => t.id === tabId) : null;
  const linkedPdfs = tab?.pdfFileNames ?? [];
  const linkedCount = linkedPdfs.length;

  const isMiddleMouseRef = useRef(false);

  const onClose = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    api.close();
  }, [api]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    isMiddleMouseRef.current = e.button === 1;
  }, []);

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    if (isMiddleMouseRef.current && e.button === 1) {
      isMiddleMouseRef.current = false;
      api.close();
    }
  }, [api]);

  const onPointerLeave = useCallback(() => {
    isMiddleMouseRef.current = false;
  }, []);

  const onBtnPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
  }, []);

  const handleToggle = useCallback((name: string | null) => {
    if (!tab) return;
    if (name === null) {
      for (const p of tab.pdfFileNames) boardStore.removePdfBinding(tab.id, p);
    } else {
      boardStore.togglePdfBinding(tab.id, name);
    }
  }, [tab]);

  return (
    <div
      data-testid="dockview-dv-default-tab"
      className="dv-default-tab"
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerLeave}
    >
      {tab && pdfNames.length > 0 && (
        <span
          className="board-tab-bindlink"
          // Keep BindLink interactions out of dockview's tab drag/activate
          // and out of the middle-click-close tracking above.
          onPointerDown={(e) => e.stopPropagation()}
          onPointerUp={(e) => e.stopPropagation()}
        >
          <BindLink
            boundNames={linkedPdfs}
            options={pdfNames}
            onToggle={handleToggle}
            primaryLabel="Linked PDFs"
            fixedDropdown
            title={linkedCount > 0
              ? `Linked PDFs: ${linkedPdfs.join(', ')} — click to manage`
              : 'Link a PDF to this board'}
          />
        </span>
      )}
      <span className="dv-default-tab-content">{title}</span>
      <div
        className="dv-default-tab-action"
        onPointerDown={onBtnPointerDown}
        onClick={onClose}
      >
        <svg width="11" height="11" viewBox="0 0 11 11">
          <line x1="1" y1="1" x2="10" y2="10" stroke="currentColor" strokeWidth="1.5" />
          <line x1="10" y1="1" x2="1" y2="10" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </div>
    </div>
  );
}
