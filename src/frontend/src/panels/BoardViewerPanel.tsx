import { useRef, useEffect, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { BoardRenderer } from '../renderer/BoardRenderer';
import { boardStore } from '../store/board-store';
import { useBoardStore } from '../hooks/useBoardStore';
import { BoardSidebar } from '../components/BoardSidebar';

export function BoardViewerPanel(props: IDockviewPanelProps<{ boardTabId?: number }>) {
  const tabId = props.params.boardTabId;
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<BoardRenderer | null>(null);
  const { tabs, searchQuery, activeTabId, showNetLines } = useBoardStore();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarTab, setSidebarTab] = useState<'info' | 'nets' | 'search' | null>(null);
  const [sidebarOpacity, setSidebarOpacity] = useState(1);
  const [sliderVisible, setSliderVisible] = useState(false);
  const sliderGroupRef = useRef<HTMLDivElement>(null);
  const prevSearchRef = useRef('');

  // Auto-open sidebar to search tab when search query changes on this panel's tab
  const isActivePanel = activeTabId === tabId;
  if (isActivePanel && searchQuery !== prevSearchRef.current) {
    prevSearchRef.current = searchQuery;
    if (searchQuery) {
      if (!sidebarOpen) setSidebarOpen(true);
      setSidebarTab('search');
    } else {
      setSidebarTab(null);
    }
  }

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
        rendererRef.current = null;
      }
    })();

    return () => {
      destroyed = true;
      if (renderer) {
        renderer.destroy();
        rendererRef.current = null;
      }
    };
  }, [tabId]);

  // Handle activation/deactivation: switch boardStore + pause/resume renderer
  useEffect(() => {
    if (tabId == null) return;

    boardStore.switchTab(tabId);

    const disposable = props.api.onDidActiveChange((e) => {
      if (e.isActive) {
        boardStore.switchTab(tabId);
        rendererRef.current?.resume();
      } else {
        rendererRef.current?.pause();
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
        {linkedPdfs.length > 0 && (
          <div
            className="board-link-indicator"
            title={`Linked PDFs: ${linkedPdfs.join(', ')}`}
          >
            ∞{linkedPdfs.length > 1 ? ` ${linkedPdfs.length}` : ''}
          </div>
        )}
        <button
          className={`board-netlines-toggle ${showNetLines ? 'active' : ''}`}
          onClick={() => boardStore.toggleNetLines()}
          title={showNetLines ? 'Net lines: ON' : 'Net lines: OFF'}
        >
          ※
        </button>
      </div>
      <BoardSidebar
        visible={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        requestedTab={sidebarTab}
        onTabApplied={() => setSidebarTab(null)}
        opacity={sidebarOpacity}
      />
    </div>
  );
}
