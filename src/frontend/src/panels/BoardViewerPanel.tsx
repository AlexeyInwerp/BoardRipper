import { useRef, useEffect, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { IconHierarchy, IconTooltip, IconObjectScan, IconGhost2, IconHandMove, IconZoomIn } from '@tabler/icons-react';
import { BoardRenderer } from '../renderer/BoardRenderer';
import { boardStore } from '../store/board-store';
import { useBoardStore } from '../hooks/useBoardStore';
import { BoardSidebar } from '../components/BoardSidebar';
import { pdfPanelId, isLinkActivating, activateLinkedPanel, isAutoSwitchLinked } from '../store/dockview-api';
import { pdfStore } from '../store/pdf-store';
import { fileInputRefs } from '../store/file-inputs';
import { log } from '../store/log-store';
import { invertScrollBindings, useBareScrollAction } from '../store/scroll-mode';

// Per-tab handlers for toolbar search → board sidebar integration
const _boardSearchHandlers = new Map<number, (query: string) => void>();
export function openBoardSearch(query: string, tabId?: number): void {
  if (tabId != null) {
    _boardSearchHandlers.get(tabId)?.(query);
  } else {
    // Fallback: use active tab's handler
    const activeId = boardStore.activeTabId;
    if (activeId != null) _boardSearchHandlers.get(activeId)?.(query);
  }
}

export function BoardViewerPanel(props: IDockviewPanelProps<{ boardTabId?: number }>) {
  const tabId = props.params.boardTabId;
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<BoardRenderer | null>(null);
  const { tabs, activeTabId, showNetLines, showNetDim, showHoverInfo, showGhosts, followPdf, layerStates } = useBoardStore();
  const bareAction = useBareScrollAction();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarTab, setSidebarTab] = useState<'layers' | 'info' | 'search' | null>(null);
  const [sidebarOpacity, setSidebarOpacity] = useState(1);
  const [sliderVisible, setSliderVisible] = useState(false);
  const sliderGroupRef = useRef<HTMLDivElement>(null);
  const prevLayerCountRef = useRef(0);

  const isActivePanel = activeTabId === tabId;

  // Register per-tab handler for toolbar → board search
  useEffect(() => {
    if (tabId == null) return;
    const handler = (query: string) => {
      boardStore.switchTab(tabId);
      boardStore.setSearch(query);
      setSidebarOpen(true);
      setSidebarTab('search');
      // Activate this panel in dockview
      props.api.setActive();
    };
    _boardSearchHandlers.set(tabId, handler);
    return () => { _boardSearchHandlers.delete(tabId); };
  }, [tabId, props.api]);

  // Auto-open sidebar to layers tab when a multi-layer board is loaded
  if (isActivePanel && layerStates.length > 0 && prevLayerCountRef.current === 0) {
    if (!sidebarOpen) setSidebarOpen(true);
    setSidebarTab('layers');
  }
  prevLayerCountRef.current = layerStates.length;

  // Find this panel's tab to check PDF bindings
  const tab = tabId != null ? tabs.find(t => t.id === tabId) : null;
  const linkedPdfs = tab?.pdfFileNames ?? [];

  // Create and destroy the renderer with the panel
  useEffect(() => {
    if (!containerRef.current || tabId == null) return;
    const container = containerRef.current;
    let destroyed = false;
    let renderer: BoardRenderer | null = null;

    (async () => {
      renderer = new BoardRenderer(container, tabId);
      rendererRef.current = renderer;
      boardStore.switchTab(tabId);
      await renderer.init();
      if (destroyed) {
        renderer.destroy();
        // Only null the ref if it still points to THIS renderer — during
        // React StrictMode double-mount, mount 2 may have already replaced it.
        if (rendererRef.current === renderer) rendererRef.current = null;
      }
    })();

    return () => {
      destroyed = true;
      if (renderer) {
        renderer.destroy();
        if (rendererRef.current === renderer) rendererRef.current = null;
      }
    };
  }, [tabId]);

  // Handle activation/deactivation: switch boardStore + pause/resume renderer
  useEffect(() => {
    if (tabId == null) return;

    // Guard: only set active tab if this panel is currently active in dockview.
    // React mounts panels asynchronously — without this check, a newly-created panel
    // can overwrite boardStore.activeTabId even after the user has already switched
    // back to a different board tab.
    if (props.api.isActive) {
      boardStore.switchTab(tabId);
    }

    const disposable = props.api.onDidActiveChange((e) => {
      log.render.log(`onDidActiveChange tab=${tabId} isActive=${e.isActive} linkActivating=${isLinkActivating()} storeActive=${boardStore.activeTabId}`);
      if (e.isActive) {
        boardStore.switchTab(tabId);
        rendererRef.current?.resume();
        // Board is active — clear PDF search ref so Cmd+F goes to board search
        fileInputRefs.pdfSearch = null;
        // Activate linked PDF panel so it follows the board tab
        // Gated by auto-switch flag (toggled via BindLink header in PDF panel).
        const tab = isAutoSwitchLinked()
          ? boardStore.tabs.find(t => t.id === tabId)
          : null;
        if (tab && tab.pdfFileNames.length > 0) {
          const pdfName = tab.pdfFileNames[0];
          activateLinkedPanel(pdfPanelId(pdfName), () => pdfStore.switchTo(pdfName));
        }
      } else if (!isLinkActivating() || boardStore.activeTabId !== tabId) {
        // Pause when this panel loses focus. Two conditions cover all cases:
        // - !isLinkActivating(): normal tab switch — no PDF cross-activation in progress.
        // - activeTabId !== tabId: board store already moved to another tab, so this
        //   renderer must stop even if isActive=false fired inside a link-activation
        //   sequence (which would set _linkActivating=true and block the first condition).
        log.render.log(`pausing renderer tab=${tabId}`);
        rendererRef.current?.pause();
      } else {
        log.render.log(`SKIP pause tab=${tabId} (linkActivating=${isLinkActivating()} storeActive=${boardStore.activeTabId})`);
      }
    });

    return () => disposable.dispose();
  }, [tabId, props.api]);

  // Auto-hide slider on outside click (sidebar stays open)
  useEffect(() => {
    if (!sliderVisible) return;
    const handler = (e: MouseEvent) => {
      if (sliderGroupRef.current && !sliderGroupRef.current.contains(e.target as Node)) {
        setSliderVisible(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [sliderVisible]);

  if (tabId == null) {
    return (
      <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#888' }}>
        No board loaded
      </div>
    );
  }

  return (
    <div className="board-panel-root">
      <div
        ref={containerRef}
        className="board-panel-canvas"
        data-testid="board-canvas"
      />
      {tab && !tab.board && (
        <div className="board-loading-overlay">
          <div className="board-loading-spinner" />
          <span className="board-loading-text">Loading board...</span>
        </div>
      )}
      <div className="board-sidebar-toggle-group" ref={sliderGroupRef}>
        <button
          className={`board-sidebar-toggle ${sidebarOpen ? 'active' : ''}`}
          onClick={() => {
            const next = !sidebarOpen;
            setSidebarOpen(next);
            setSliderVisible(next);
          }}
          title={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
        >
          ☰
        </button>
        {sliderVisible && (
          <div className="board-sidebar-slider-wrap">
            <input
              type="range"
              className="board-sidebar-opacity-slider"
              min={20}
              max={100}
              value={sidebarOpacity * 100}
              onChange={(e) => setSidebarOpacity(Number(e.target.value) / 100)}
              onDoubleClick={() => setSidebarOpacity(1)}
            />
            <div
              className="board-sidebar-slider-tooltip"
              style={{ top: `${(1 - (sidebarOpacity * 100 - 20) / 80) * 100}%` }}
            >
              {Math.round(sidebarOpacity * 100)}%
            </div>
          </div>
        )}
      </div>
      <div className="board-status-indicators">
        <div className="board-button-group">
          {linkedPdfs.length > 0 && (
            <div
              className="board-link-indicator"
              title={`Linked PDFs: ${linkedPdfs.join(', ')}`}
            >
              ∞{linkedPdfs.length > 1 ? ` ${linkedPdfs.length}` : ''}
            </div>
          )}
          <button
            className={`board-netlines-toggle ${followPdf ? 'active' : ''}`}
            onClick={() => boardStore.toggleFollowPdf()}
            disabled={linkedPdfs.length === 0}
            title={followPdf ? 'PDF follow: ON' : 'PDF follow: OFF'}
          >
            ⇶
          </button>
          <button
            className="board-netlines-toggle"
            onClick={invertScrollBindings}
            title={bareAction === 'pan'
              ? 'Scroll: Pan · Shift+Scroll: Zoom — click to swap'
              : 'Scroll: Zoom · Shift+Scroll: Pan — click to swap'}
          >
            {bareAction === 'pan' ? <IconHandMove size={16} /> : <IconZoomIn size={16} />}
          </button>
          <button
            className="board-netlines-toggle"
            onClick={() => rendererRef.current?.fitToBoard()}
            title="Zoom to fit board"
          >
            <IconObjectScan size={16} />
          </button>
        </div>
        <div className="board-button-group">
          <button
            className={`board-netlines-toggle ${showHoverInfo ? 'active' : ''}`}
            onClick={() => boardStore.toggleHoverInfo()}
            title={showHoverInfo ? 'Hover info: ON' : 'Hover info: OFF'}
          >
            <IconTooltip size={16} />
          </button>
          <button
            className={`board-netlines-toggle ${showNetDim ? 'active' : ''}`}
            onClick={() => boardStore.toggleNetDim()}
            title={showNetDim ? 'Selection dimming: ON' : 'Selection dimming: OFF'}
          >
            ◐
          </button>
          <button
            className={`board-netlines-toggle ${showNetLines ? 'active' : ''}`}
            onClick={() => boardStore.toggleNetLines()}
            title={showNetLines ? 'Net lines: ON' : 'Net lines: OFF'}
          >
            <IconHierarchy size={16} />
          </button>
          <button
            className={`board-netlines-toggle ${showGhosts ? 'active' : ''}`}
            onClick={() => boardStore.toggleGhosts()}
            title={showGhosts ? 'Hidden-side ghosts: ON' : 'Hidden-side ghosts: OFF'}
          >
            <IconGhost2 size={16} />
          </button>
        </div>
      </div>
      <BoardSidebar
        visible={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        requestedTab={sidebarTab}
        onTabApplied={() => setSidebarTab(null)}
        opacity={sidebarOpacity}
        tabId={tabId!}
      />
    </div>
  );
}
