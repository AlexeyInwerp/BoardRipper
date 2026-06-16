import { useCallback, useRef, useSyncExternalStore } from 'react';
import type { IDockviewPanelHeaderProps } from 'dockview-react';
import { useBoardStore } from '../hooks/useBoardStore';
import { usePdfDoc } from '../hooks/usePdfStore';
import { boardStore } from '../store/board-store';
import { pdfStore } from '../store/pdf-store';
import { isAutoSwitchLinked, setAutoSwitchLinked, onAutoSwitchChange } from '../store/dockview-api';
import { BindLink } from './BindLink';

/** Subscribes to dockview title changes via useSyncExternalStore — avoids the
 *  effect-setState race that dockview's own useTitle has. Mirrors BoardTab. */
function useTitle(api: IDockviewPanelHeaderProps['api']): string {
  return useSyncExternalStore(
    (cb) => {
      const disposable = api.onDidTitleChange(cb);
      return () => disposable.dispose();
    },
    () => api.title ?? '',
  );
}

// Stable snapshot of open PDF names for useSyncExternalStore (the store getter
// builds a fresh array per call). Module-level cache, invalidated on every
// pdfStore notify — same pattern as BoardTab.
let _pdfNamesCache: string[] | null = null;
pdfStore.subscribe(() => { _pdfNamesCache = null; });
function getPdfNamesSnapshot(): string[] {
  if (!_pdfNamesCache) _pdfNamesCache = pdfStore.loadedFileNames;
  return _pdfNamesCache;
}

/**
 * PDF-specific dockview tab header. Mirrors BoardTab's structure (close button,
 * middle-click close) and hosts the ∞ link control in the tab itself rather
 * than the PDF toolbar — symmetric with the board tab. The BindLink links the
 * PDF to a boardview (single-select) and cross-links to another open PDF; the
 * `fixedDropdown` variant portals the menu to <body> so it isn't clipped by the
 * transformed tab-header container (see BoardTab / the bindlink portal fix).
 */
export function PdfTab(props: IDockviewPanelHeaderProps<{ pdfFileName?: string }>) {
  const { api, params } = props;
  const title = useTitle(api);
  const { tabs } = useBoardStore();
  const pdfFileName = params.pdfFileName ?? '';
  const { linkedDoc } = usePdfDoc(pdfFileName);
  const pdfNames = useSyncExternalStore((cb) => pdfStore.subscribe(cb), getPdfNamesSnapshot);
  const autoSwitchLinked = useSyncExternalStore(onAutoSwitchChange, isAutoSwitchLinked);

  const boundBoardTabs = tabs.filter(t => t.pdfFileNames.includes(pdfFileName));
  const boardTabNames = tabs.map(t => t.fileName);
  const otherPdfs = pdfNames.filter(n => n !== pdfFileName);

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

  // Bind this PDF to a board (single-select: unbind current, bind selected).
  const handleBindBoard = useCallback((boardFileName: string | null) => {
    const bound = tabs.filter(t => t.pdfFileNames.includes(pdfFileName));
    for (const tab of bound) boardStore.removePdfBinding(tab.id, pdfFileName);
    if (boardFileName !== null) {
      const target = tabs.find(t => t.fileName === boardFileName);
      if (target) boardStore.addPdfBinding(target.id, pdfFileName);
    }
  }, [tabs, pdfFileName]);

  // Cross-link this PDF to another open PDF (1:1). null / current partner = unlink.
  const handleLinkPdf = useCallback((name: string | null) => {
    if (name === null || name === linkedDoc) pdfStore.unlinkDoc(pdfFileName);
    else pdfStore.linkDocs(pdfFileName, name);
  }, [linkedDoc, pdfFileName]);

  const showLink = boardTabNames.length > 0 || otherPdfs.length > 0;

  return (
    <div
      data-testid="dockview-dv-default-tab"
      className="dv-default-tab"
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerLeave}
    >
      {showLink && (
        <span
          className="board-tab-bindlink"
          // Keep BindLink interactions out of dockview's tab drag/activate and
          // out of the middle-click-close tracking above.
          onPointerDown={(e) => e.stopPropagation()}
          onPointerUp={(e) => e.stopPropagation()}
        >
          <BindLink
            boundNames={boundBoardTabs.map(t => t.fileName)}
            options={boardTabNames}
            onToggle={handleBindBoard}
            primaryLabel="Boardview"
            unlinkedLabel="Link board…"
            fixedDropdown
            title={boundBoardTabs.length > 0
              ? `Board: ${boundBoardTabs.map(t => t.fileName).join(', ')} — click to manage`
              : 'Link this PDF to a boardview'}
            headerItem={boardTabNames.length > 0 ? {
              label: 'auto-open boardview',
              checked: autoSwitchLinked,
              onChange: setAutoSwitchLinked,
            } : undefined}
            secondary={{
              label: 'Cross-link PDF',
              boundNames: linkedDoc ? [linkedDoc] : [],
              options: otherPdfs,
              onToggle: handleLinkPdf,
            }}
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
