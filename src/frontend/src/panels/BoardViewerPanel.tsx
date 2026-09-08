import { useRef, useEffect, useState, useCallback } from 'react';
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
import { IconChevronLeft, IconChevronRight, IconChevronUp, IconChevronDown, IconLayoutSidebarRight } from '@tabler/icons-react';
import { useOverlayCollapsed, toggleOverlayCollapsed } from '../store/overlay-collapse-store';
import { QuickMenu } from '../components/QuickMenu';
import { isSeparatorId, slotLabel } from '../store/overlay-layout';
import { showSidebarTab } from '../components/Sidebar.utils';
import { getFormat } from '../parsers';
import { useRenderSettings } from '../hooks/useRenderSettings';
import { renderSettingsStore } from '../store/render-settings';
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
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarTab, setSidebarTab] = useState<'layers' | 'info' | 'search' | 'worklist' | null>(null);
  const overlayCollapsed = useOverlayCollapsed();
  const [barMenu, setBarMenu] = useState<{ x: number; y: number } | null>(null);
  const closeBarMenu = useCallback(() => setBarMenu(null), []);
  // Floating ribbon: the shade handle doubles as the drag grip. A press that
  // moves less than 4px is a click (fold/unfold); more is a drag, committed
  // to settings on release and clamped to the panel. Move/up are tracked on
  // window for the life of the drag, so the bar keeps following even when a
  // clamp lets the pointer slide off the handle.
  const barRef = useRef<HTMLDivElement>(null);
  const floatingRef = useRef(renderSettings.overlayPosition === 'floating');
  floatingRef.current = renderSettings.overlayPosition === 'floating';
  const floatPosRef = useRef({ x: renderSettings.overlayFloatX, y: renderSettings.overlayFloatY });
  floatPosRef.current = { x: renderSettings.overlayFloatX, y: renderSettings.overlayFloatY };
  const onHandlePointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if (!floatingRef.current) return;                     // docked: plain click handled by onClick
    e.preventDefault();
    const start = { x: e.clientX, y: e.clientY };
    const origin = floatPosRef.current;
    let moved = false;
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - start.x, dy = ev.clientY - start.y;
      if (!moved && Math.hypot(dx, dy) < 4) return;
      moved = true;
      const host = containerRef.current?.getBoundingClientRect();
      const bar = barRef.current;
      if (!host || !bar) return;
      const x = Math.max(0, Math.min(origin.x + dx, host.width - bar.offsetWidth));
      const y = Math.max(0, Math.min(origin.y + dy, host.height - bar.offsetHeight));
      bar.style.left = `${x}px`; bar.style.top = `${y}px`;
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onUp, true);
      if (!moved) { toggleOverlayCollapsed(); return; }
      const bar = barRef.current;
      if (bar) renderSettingsStore.setOverlayFloatPos(parseFloat(bar.style.left) || 0, parseFloat(bar.style.top) || 0);
    };
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onUp, true);
  }, []);
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

  const tabFmt = thisTab?.board ? getFormat(thisTab.board.format) : undefined;
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
      showTop: thisTab?.showTop ?? true,
      showBottom: thisTab?.showBottom ?? false,
      butterfly: thisTab?.butterfly ?? false,
      showTraces: thisTab?.showTraces ?? true,
      rotation: thisTab?.rotation ?? 0,
      flipAxis: thisTab?.flipAxis ?? 'y',
      primarySide: thisTab?.board?.primarySide === 'bottom' ? 'bottom' : 'top',
      hasLayers: tabFmt?.hasLayers ?? false,
      hasTraces: tabFmt?.hasTraces ?? false,
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
      {thisTab && !thisTab.board && (
        <div className="board-loading-overlay">
          <div className="board-loading-spinner" />
          <span className="board-loading-text">Loading board...</span>
        </div>
      )}
      <div className="board-sidebar-toggle-group">
        <button
          className={`board-sidebar-toggle ${sidebarOpen ? 'active' : ''}`}
          onClick={() => setSidebarOpen(!sidebarOpen)}
          aria-pressed={sidebarOpen}
          title={sidebarOpen ? 'Hide board panel (Layers · Info · Search · Worklist)' : 'Show board panel (Layers · Info · Search · Worklist)'}
        >
          <IconLayoutSidebarRight size={16} />
        </button>
      </div>
      {/* Overlay controls. The handle sits at the RIGHT end, where the Classic
          Mac collapse box was; clicking it rolls the bar up toward its left
          anchor until only the handle is left, and the board gets the room.
          Persisted across tabs and reloads. */}
      <div
        ref={barRef}
        className={`board-status-indicators${renderSettings.overlayPosition === 'center' ? ' center' : ''}${renderSettings.overlayPosition === 'floating' ? ' floating' : ''}${renderSettings.overlayOrientation === 'vertical' ? ' vertical' : ''}${overlayCollapsed ? ' collapsed' : ''}`}
        style={renderSettings.overlayPosition === 'floating' ? { left: renderSettings.overlayFloatX, top: renderSettings.overlayFloatY } : undefined}
        data-testid="board-overlay-bar"
        data-collapsed={overlayCollapsed ? 'true' : 'false'}
        data-orientation={renderSettings.overlayOrientation}
        data-position={renderSettings.overlayPosition}
        onContextMenu={(e) => { e.preventDefault(); setBarMenu({ x: e.clientX, y: e.clientY }); }}
      >
        {!overlayCollapsed && renderOverlayLayout(renderSettings.overlayLayout, slotCtx)}
        <button
          type="button"
          className="overlay-collapse"
          data-testid="overlay-collapse"
          aria-expanded={!overlayCollapsed}
          aria-label={overlayCollapsed ? 'Show board controls' : 'Hide board controls'}
          title={renderSettings.overlayPosition === 'floating'
            ? (overlayCollapsed ? 'Show board controls · drag to move' : 'Hide board controls · drag to move')
            : (overlayCollapsed ? 'Show board controls' : 'Hide board controls')}
          onPointerDown={onHandlePointerDown}
          onClick={renderSettings.overlayPosition === 'floating' ? undefined : toggleOverlayCollapsed}
        >
          {renderSettings.overlayOrientation === 'vertical'
            ? (overlayCollapsed ? <IconChevronDown size={14} stroke={2} /> : <IconChevronUp size={14} stroke={2} />)
            : (overlayCollapsed ? <IconChevronRight size={14} stroke={2} /> : <IconChevronLeft size={14} stroke={2} />)}
        </button>
      </div>
      {/* Right-click on the ribbon: edit it where it lives. Show/hide each
          button, row position, fold, and a jump to the full editor. Same store
          operations as Settings ▸ Board overlay. */}
      {barMenu && (
        <QuickMenu
          x={barMenu.x}
          y={barMenu.y}
          onClose={closeBarMenu}
          ariaLabel="Board controls"
          testId="board-bar-menu"
          items={[
            { kind: 'header', label: 'On the bar' },
            ...renderSettings.overlayLayout
              .filter(sl => !isSeparatorId(sl.id))
              .map(sl => ({
                kind: 'check' as const,
                label: slotLabel(sl.id),
                checked: sl.visible,
                testId: `bar-menu-slot-${sl.id}`,
                onSelect: () => renderSettingsStore.setOverlaySlotVisible(sl.id, !sl.visible),
              })),
            { kind: 'sep' },
            { kind: 'header', label: 'Position' },
            { kind: 'check', label: 'Left', checked: renderSettings.overlayPosition === 'left', onSelect: () => renderSettingsStore.setOverlayPosition('left') },
            { kind: 'check', label: 'Centred', checked: renderSettings.overlayPosition === 'center', onSelect: () => renderSettingsStore.setOverlayPosition('center') },
            { kind: 'check', label: 'Floating · drag the handle', checked: renderSettings.overlayPosition === 'floating', testId: 'bar-menu-floating', onSelect: () => renderSettingsStore.setOverlayPosition('floating') },
            { kind: 'header', label: 'Orientation' },
            { kind: 'check', label: 'Horizontal', checked: renderSettings.overlayOrientation !== 'vertical', onSelect: () => renderSettingsStore.setOverlayOrientation('horizontal') },
            { kind: 'check', label: 'Vertical', checked: renderSettings.overlayOrientation === 'vertical', testId: 'bar-menu-vertical', onSelect: () => renderSettingsStore.setOverlayOrientation('vertical') },
            { kind: 'sep' },
            { label: overlayCollapsed ? 'Unfold controls' : 'Fold controls', onSelect: toggleOverlayCollapsed },
            { label: 'Customise order and separators…', testId: 'bar-menu-customise', onSelect: () => {
                showSidebarTab('settings');
                window.dispatchEvent(new CustomEvent('settings-focus-section', { detail: 'boardOverlay' }));
              } },
            { label: 'Reset layout', testId: 'bar-menu-reset', onSelect: () => renderSettingsStore.resetOverlayLayout() },
          ]}
        />
      )}
      <BoardSidebar
        visible={sidebarOpen}
        requestedTab={sidebarTab}
        onTabApplied={() => setSidebarTab(null)}
        tabId={tabId!}
      />
    </div>
  );
}
