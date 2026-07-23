import { useRef, useEffect, useState, useSyncExternalStore } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { BoardRenderer } from '../renderer/BoardRenderer';
import { boardStore } from '../store/board-store';
import { useBoardStore } from '../hooks/useBoardStore';
import { BoardSidebar } from '../components/BoardSidebar';
import { pdfPanelId, isLinkActivating, activateLinkedPanel, isAutoSwitchLinked } from '../store/dockview-api';
import { pdfStore } from '../store/pdf-store';
import { fileInputRefs } from '../store/file-inputs';
import { log } from '../store/log-store';
import { useBareScrollAction } from '../store/scroll-mode';
import { obdStore, extractBoardNumberFromFilename } from '../store/obd-store';
import { renderOverlayLayout } from '../components/overlay/slot-renderers';
import { resizeModeStore } from '../store/resize-mode-store';
import { ResizePopup } from '../components/ResizePopup';
import { useRenderSettings } from '../hooks/useRenderSettings';
import type { SlotCtx } from '../components/overlay/slot-ctx';
import {
  registerBoardSearchHandler,
  registerBoardSidebarTabHandler,
  type SidebarTabName,
} from './board-viewer-bridge';

export function BoardViewerPanel(props: IDockviewPanelProps<{ boardTabId?: number }>) {
  const tabId = props.params.boardTabId;
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<BoardRenderer | null>(null);
  const { tabs } = useBoardStore();
  const thisTab = tabId != null ? tabs.find(t => t.id === tabId) : undefined;
  const netLineMode = thisTab?.netLineMode ?? 'off';
  const dimMode = thisTab?.dimMode ?? 'dim';
  const showHoverInfo = thisTab?.showHoverInfo ?? true;
  const ghostMode = thisTab?.ghostMode ?? 'ghosts';
  const followPdf = thisTab?.followPdf ?? false;
  const layerStates = thisTab?.layerStates ?? [];
  const bareAction = useBareScrollAction();
  const renderSettings = useRenderSettings();
  const resizeMode = useSyncExternalStore(
    (cb) => resizeModeStore.subscribe(cb),
    () => resizeModeStore.enabled,
  );
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarTab, setSidebarTab] = useState<'layers' | 'info' | 'search' | 'worklist' | null>(null);
  const [sidebarOpacity, setSidebarOpacity] = useState(1);
  const [sliderVisible, setSliderVisible] = useState(false);
  const sliderGroupRef = useRef<HTMLDivElement>(null);
  const prevLayerCountRef = useRef(0);

  // Register per-tab handler for toolbar → board search
  useEffect(() => {
    if (tabId == null) return;
    return registerBoardSearchHandler(tabId, (query: string) => {
      boardStore.switchTab(tabId);
      boardStore.setSearch(query);
      setSidebarOpen(true);
      setSidebarTab('search');
      // Activate this panel in dockview
      props.api.setActive();
    });
  }, [tabId, props.api]);

  // Register per-tab handler for "open this sidebar tab" requests (Worklist, etc).
  useEffect(() => {
    if (tabId == null) return;
    return registerBoardSidebarTabHandler(tabId, (tab: SidebarTabName) => {
      // Worklist is unconditional; revisions is gated on showRevisionsTab. We
      // accept the request optimistically — BoardSidebar's own fallback effect
      // will drop us back to 'info' if the requested tab isn't available.
      boardStore.switchTab(tabId);
      setSidebarOpen(true);
      // The 'revisions' value is a valid SidebarTab inside BoardSidebar, but
      // BoardViewerPanel's local state was narrower historically — kept here
      // since we widened it above.
      setSidebarTab(tab === 'revisions' ? null : tab);
      props.api.setActive();
    });
  }, [tabId, props.api]);

  // Auto-open sidebar to layers tab when this tab's board first loads with
  // layers. Per-tab layerStates means each panel tracks its own transition
  // 0 → N independently — no need to gate on the active-panel check. rAF
  // defers the setState to satisfy the no-setState-in-effect rule.
  useEffect(() => {
    const wasZero = prevLayerCountRef.current === 0;
    prevLayerCountRef.current = layerStates.length;
    if (layerStates.length > 0 && wasZero) {
      const frame = requestAnimationFrame(() => {
        setSidebarOpen(true);
        setSidebarTab('layers');
      });
      return () => cancelAnimationFrame(frame);
    }
  }, [layerStates.length]);

  // Find this panel's tab to check PDF bindings
  const linkedPdfs = thisTab?.pdfFileNames ?? [];

  // Auto-load OpenBoardData for this tab's board so the canvas hover
  // tooltip + sidebar Info tab surface readings without requiring the
  // user to detour through the Library detail pane. Best-effort: when the
  // backend has no library_dir or no index, this no-ops cleanly.
  const tabFileName = thisTab?.fileName ?? '';
  useEffect(() => {
    const bn = extractBoardNumberFromFilename(tabFileName);
    if (bn) obdStore.loadMatches(bn);
  }, [tabFileName]);

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
      } else if (!props.api.isVisible) {
        // Mounted already-hidden (e.g. background tab restored on reload):
        // onDidVisibilityChange won't fire, so arm deep-pause from initial state.
        renderer.scheduleDeepPause();
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

    // Deep-pause: when this panel is genuinely hidden (tabbed away in its group,
    // or its group is collapsed/hidden) release its GPU context + scene graph
    // after a delay so K open board tabs don't hold K live WebGL contexts.
    // Visibility — not activation — is the correct signal: a board still shown in
    // a split/floating group stays visible and keeps its live renderer.
    // (Initial already-hidden state is armed in the renderer-creation effect,
    // after init(), since the renderer is created asynchronously and isn't in
    // rendererRef yet when this effect first runs.)
    const visDisposable = props.api.onDidVisibilityChange((e) => {
      if (e.isVisible) rendererRef.current?.cancelDeepPause();
      else rendererRef.current?.scheduleDeepPause();
    });

    return () => { disposable.dispose(); visDisposable.dispose(); };
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

  const slotCtx: SlotCtx = {
    tabId: tabId!,
    thisTab: {
      netLineMode,
      dimMode,
      showHoverInfo,
      ghostMode,
      followPdf,
      pdfFileNames: linkedPdfs,
      fileName: tabFileName,
    },
    rendererRef,
    bareAction,
  };

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
      <button
        onClick={() => resizeModeStore.toggle()}
        title={resizeMode
          ? 'Resize Mode ON — click a pin, part, or text label to resize it. Click to exit.'
          : 'Resize Mode — click board elements to resize them directly'}
        style={{
          position: 'absolute', top: 8, right: 8, zIndex: 30,
          height: 30, padding: '0 12px', borderRadius: 6, cursor: 'pointer',
          font: '12px/1 system-ui, sans-serif', fontWeight: 600,
          border: resizeMode ? '1px solid var(--accent)' : '1px solid var(--border)',
          background: resizeMode ? 'var(--accent)' : 'var(--bg-secondary)',
          color: resizeMode ? 'var(--accent-fg, #fff)' : 'var(--text-primary)',
          boxShadow: resizeMode ? '0 0 0 2px var(--accent-hover, transparent)' : 'none',
        }}
      >
        ⇲ Resize{resizeMode ? ' · ON' : ''}
      </button>
      {resizeMode && <ResizePopup />}
      {thisTab && !thisTab.board && (
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
          title={sidebarOpen ? 'Hide board panel (Layers · Info · Search · Worklist)' : 'Show board panel (Layers · Info · Search · Worklist)'}
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
      <div className={`board-status-indicators${renderSettings.overlayPosition === 'center' ? ' center' : ''}`}>
        {renderOverlayLayout(renderSettings.overlayLayout, slotCtx)}
      </div>
      <BoardSidebar
        visible={sidebarOpen}
        requestedTab={sidebarTab}
        onTabApplied={() => setSidebarTab(null)}
        opacity={sidebarOpacity}
        tabId={tabId!}
      />
    </div>
  );
}
