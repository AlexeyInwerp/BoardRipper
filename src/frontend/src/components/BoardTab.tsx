import { useCallback, useEffect, useRef, useState } from 'react';
import type { IDockviewPanelHeaderProps } from 'dockview-react';
import { useBoardStore } from '../hooks/useBoardStore';

/** Replicates dockview's useTitle hook — keeps tab title reactive to api title changes. */
function useTitle(api: IDockviewPanelHeaderProps['api']): string {
  const [title, setTitle] = useState(api.title ?? '');
  useEffect(() => {
    const disposable = api.onDidTitleChange((e) => setTitle(e.title ?? ''));
    if (title !== api.title) setTitle(api.title ?? '');
    return () => disposable.dispose();
  }, [api]);
  return title;
}

/**
 * Board-specific dockview tab header. Mirrors DockviewDefaultTab's structure
 * and close-button behavior, and prepends a ∞ indicator when the board tab
 * has linked PDFs. No change to dockview's CSS — uses the built-in
 * .dv-default-tab class so appearance matches PDF tabs exactly.
 */
export function BoardTab(props: IDockviewPanelHeaderProps<{ boardTabId?: number }>) {
  const { api, params } = props;
  const title = useTitle(api);
  const { tabs } = useBoardStore();

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

  return (
    <div
      data-testid="dockview-dv-default-tab"
      className="dv-default-tab"
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerLeave}
    >
      {linkedCount > 0 && (
        <span
          className="board-tab-link-indicator"
          title={`Linked PDFs: ${linkedPdfs.join(', ')}`}
        >
          ∞{linkedCount > 1 ? linkedCount : ''}
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
