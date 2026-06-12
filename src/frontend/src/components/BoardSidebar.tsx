import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { IconPin, IconPinFilled, IconChevronRight, IconChevronDown } from '@tabler/icons-react';
import { useBoardStore } from '../hooks/useBoardStore';
import { useWorklist } from '../hooks/useWorklist';
import { boardStore, ghostPairSig, bomClusterSig } from '../store/board-store';
import { worklistStore } from '../store/worklist-store';
import type { SelectionState } from '../store/board-store';
import { colorToHex, hexToColor } from '../store/layer-store';
import { renderSettingsStore, isNcNet } from '../store/render-settings';
import { extractBoardNumberFromFilename } from '../store/obd-store';
import { ComponentInfoBody } from './ComponentInfoBody';
import { WorklistPanel } from '../panels/WorklistPanel';
import { bomReasonLabel, type BoardData, type Part } from '../parsers';
import { pinDisplayId } from '../parsers/types';
import { setActiveSearchInput, getActiveSearchInput } from './BoardSidebar.utils';

type SidebarTab = 'layers' | 'info' | 'search' | 'revisions' | 'worklist';

const EMPTY_GHOST_SWAPS: ReadonlySet<string> = new Set();
const EMPTY_BOM_SELECTIONS: ReadonlyMap<string, string> = new Map();
const EMPTY_SELECTION: SelectionState = {
  partIndex: null,
  pinIndex: null,
  highlightedNet: null,
  adjacentNets: new Set<string>(),
};

interface BoardSidebarProps {
  visible: boolean;
  onClose: () => void;
  /** The board tab this sidebar belongs to */
  tabId: number;
  /** One-shot tab switch request (cleared after applying) */
  requestedTab?: SidebarTab | null;
  onTabApplied?: () => void;
  opacity?: number;
}

export function BoardSidebar({ visible, onClose, tabId, requestedTab, onTabApplied, opacity = 1 }: BoardSidebarProps) {
  const { tabs } = useBoardStore();
  const tab = tabs.find(t => t.id === tabId);
  const board = tab?.board ?? null;
  const layerStates = tab?.layerStates ?? [];
  const hasLayers = layerStates.length > 0;
  const hasRevisions = (board?.revisions?.length ?? 0) > 1;
  const hasGhosts = (board?.ghosts?.length ?? 0) > 0;
  const hasBomClusters = (board?.bomClusters?.length ?? 0) > 0;
  const showRevisionsTab = hasRevisions || hasGhosts || hasBomClusters;
  // LayersTab hosts ALL visibility toggles (Traces, Vias, Silkscreen, Pads,
  // etc.) and not just the per-layer rows. Previously the entire tab was
  // hidden when layerStates was empty (single-layer XZZ / BRD), leaving
  // users with no way to toggle anything. Always show the tab; it's
  // labelled "View" on single-layer boards to set expectations.
  const [activeTab, setActiveTab] = useState<SidebarTab>('layers');

  // Apply external tab request (one-shot, rAF defers setState to satisfy lint rule)
  useEffect(() => {
    if (!requestedTab || requestedTab === activeTab) return;
    const frame = requestAnimationFrame(() => {
      setActiveTab(requestedTab);
      onTabApplied?.();
    });
    return () => cancelAnimationFrame(frame);
  }, [requestedTab]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fall back to Info if the currently selected tab is no longer available
  // (e.g. user switched from a multi-revision board to a clean one). rAF
  // defers the setState to the next frame to avoid cascading renders.
  useEffect(() => {
    // Layers/View tab is always available now; only fall back from
    // Revisions when that tab goes away.
    if (activeTab === 'revisions' && !showRevisionsTab) {
      const frame = requestAnimationFrame(() => setActiveTab('info'));
      return () => cancelAnimationFrame(frame);
    }
  }, [activeTab, showRevisionsTab, hasLayers]);

  if (!visible) return null;

  return (
    <div className="board-sidebar" style={{ opacity }}>
      <div className="board-sidebar-header">
        <div className="board-sidebar-tabs">
          <button
            className={`board-sidebar-tab ${activeTab === 'layers' ? 'active' : ''}`}
            onClick={() => setActiveTab('layers')}
          >
            {hasLayers ? 'Layers' : 'View'}
          </button>
          <button
            className={`board-sidebar-tab ${activeTab === 'info' ? 'active' : ''}`}
            onClick={() => setActiveTab('info')}
          >
            Info
          </button>
          <button
            className={`board-sidebar-tab ${activeTab === 'search' ? 'active' : ''}`}
            onClick={() => setActiveTab('search')}
          >
            Search
          </button>
          {showRevisionsTab && (
            <button
              className={`board-sidebar-tab ${activeTab === 'revisions' ? 'active' : ''}`}
              onClick={() => setActiveTab('revisions')}
              title={
                hasRevisions
                  ? 'Multiple board revisions detected in this file'
                  : hasBomClusters
                    ? 'BOM alternates / suspicious overlaps detected'
                    : 'Suspicious overlapping components detected'
              }
            >
              Revisions{(hasGhosts || hasBomClusters) && <span className="tab-badge">!</span>}
            </button>
          )}
          <button
            className={`board-sidebar-tab ${activeTab === 'worklist' ? 'active' : ''}`}
            onClick={() => setActiveTab('worklist')}
            title="Multi-select scratchpad + named worklistes (mark/note/export)"
          >
            Worklist
          </button>
        </div>
        <button className="board-sidebar-close" onClick={onClose} title="Close sidebar">
          ×
        </button>
      </div>
      <div className="board-sidebar-content">
        {activeTab === 'layers' && <LayersTab tabId={tabId} />}
        {activeTab === 'info' && <InfoTab tabId={tabId} />}
        {activeTab === 'search' && <SearchTab tabId={tabId} />}
        {activeTab === 'revisions' && showRevisionsTab && <RevisionsTab tabId={tabId} />}
        {activeTab === 'worklist' && <WorklistPanel />}
      </div>
    </div>
  );
}

function LayersTab({ tabId }: { tabId: number }) {
  const { tabs } = useBoardStore();
  const tab = tabs.find(t => t.id === tabId);
  const board = tab?.board ?? null;
  const layerStates = tab?.layerStates ?? [];
  const selectedLayerIndex = tab?.selectedLayerIndex ?? null;
  const fixatedLayerIndex = tab?.fixatedLayerIndex ?? null;
  const showComponents = tab?.showComponents ?? true;
  const showVias = tab?.showVias ?? false;
  const showTraces = tab?.showTraces ?? true;
  const showSilkscreen = tab?.showSilkscreen ?? true;
  const showPads = tab?.showPads ?? true;
  const showCopperDrops = tab?.showCopperDrops ?? false;
  const showSurfaces = tab?.showSurfaces ?? false;
  const showPins = tab?.showPins ?? true;
  const showOutlines = tab?.showOutlines ?? true;
  const showLabels = tab?.showLabels ?? true;
  const selection = tab?.selection ?? { partIndex: null, pinIndex: null, highlightedNet: null };
  const foldMode = tab?.foldMode ?? 'suggested';
  const selectedBoardIndex = tab?.selectedBoardIndex ?? null;
  const [componentsExpanded, setComponentsExpanded] = useState(true);
  // Parts removed via the context menu's Hide — they no longer hit-test, so
  // this row is the only discoverable way back besides the undo toast.
  const hiddenParts = [...(tab?.partOverrides ?? new Map<string, { hidden?: boolean }>())]
    .filter(([, o]) => o.hidden === true)
    .map(([name]) => name);

  // Compute which layers have traces for the currently highlighted net.
  // React Compiler memoizes this automatically — manual useMemo was rejected
  // here for narrowing the dep to `board?.traces` instead of `board`.
  const highlightedLayers = (() => {
    const set = new Set<number>();
    if (selection.highlightedNet && board?.traces) {
      for (const t of board.traces) {
        if (t.net === selection.highlightedNet && t.layer != null) {
          set.add(t.layer);
        }
      }
    }
    return set;
  })();

  return (
    <div className="panel-content layer-list" data-testid="layer-list">
      {board?.format === 'XZZ' && (
        <div className="fold-section">
          <div className="fold-section-title">Board folding</div>
          <p className="fold-section-desc">
            XZZ <code>.pcb</code> files store top and bottom halves side-by-side
            instead of stacked — a single board looks like two mirror-image
            rectangles next to each other. Files can also hold several boards
            side-by-side. The parser picks a default; if it looks wrong, switch
            to "Show all sides".
          </p>
          {board.boardGroups && board.boardGroups.length > 1 && (
            <div className="fold-boards">
              <div className="fold-boards-label">
                Detected boards: {board.boardGroups.length}{board.foldComponents && ` (${board.foldComponents.length} components)`}
              </div>
              <div className="fold-boards-list">
                <label className="fold-option">
                  <input
                    type="radio"
                    name="selectedBoard"
                    checked={selectedBoardIndex === null}
                    onChange={() => boardStore.setSelectedBoardIndex(null)}
                  />
                  <span className="fold-option-label">All boards</span>
                  <span className="fold-option-hint">Render every detected board together.</span>
                </label>
                {board.boardGroups.map((group, i) => {
                  const firstComp = board.foldComponents?.[group.components[0]];
                  const dims = firstComp
                    ? `${Math.round(firstComp.maxX - firstComp.minX)} × ${Math.round(firstComp.maxY - firstComp.minY)} mils`
                    : '';
                  const sides = group.components.length;
                  return (
                    <label key={i} className="fold-option">
                      <input
                        type="radio"
                        name="selectedBoard"
                        checked={selectedBoardIndex === i}
                        onChange={() => boardStore.setSelectedBoardIndex(i)}
                      />
                      <span className="fold-option-label">Board {i + 1}</span>
                      <span className="fold-option-hint">
                        {dims} · {sides} side{sides === 1 ? '' : 's'} (C{group.components.join(', C')})
                        {group.fold && ` · ${group.fold.dim.toUpperCase()}-fold available`}
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>
          )}
          <div className="fold-resolution">
            <label className="fold-option">
              <input
                type="radio"
                name="foldMode"
                checked={foldMode === 'suggested'}
                onChange={() => boardStore.setFoldMode('suggested')}
              />
              <span className="fold-option-label">Suggested</span>
              <span className="fold-option-hint">
                {board.foldInfo?.summary ?? 'No fold applied — rendered as-is'}
              </span>
            </label>
            <label className="fold-option">
              <input
                type="radio"
                name="foldMode"
                checked={foldMode === 'all-sides'}
                onChange={() => boardStore.setFoldMode('all-sides')}
              />
              <span className="fold-option-label">Show all sides</span>
              <span className="fold-option-hint">
                Render every component at its raw file position, no mirroring.
              </span>
            </label>
          </div>
        </div>
      )}
      {layerStates.length > 0 && (
        <div className="layer-list-header">
          <span>{layerStates.length} layers</span>
        </div>
      )}

      {/* Visibility toggles — unified vertical list */}
      <div className="visibility-toggle-list">
        <button
          className={`visibility-toggle ${showTraces ? '' : 'off'}`}
          onClick={() => boardStore.toggleTraces()}
          title={showTraces ? 'Hide traces' : 'Show traces'}
        >
          <span className="toggle-check">{showTraces ? '■' : '□'}</span> Traces
        </button>
        {board?.vias && board.vias.length > 0 && (
          <button
            className={`visibility-toggle ${showVias ? '' : 'off'}`}
            onClick={() => boardStore.toggleVias()}
            title={showVias ? 'Hide vias' : 'Show vias'}
          >
            <span className="toggle-check">{showVias ? '■' : '□'}</span> Vias
          </button>
        )}
        {board?.silkscreen && board.silkscreen.length > 0 && (
          <button
            className={`visibility-toggle ${showSilkscreen ? '' : 'off'}`}
            onClick={() => boardStore.toggleSilkscreen()}
            title={showSilkscreen ? 'Hide silkscreen' : 'Show silkscreen'}
          >
            <span className="toggle-check">{showSilkscreen ? '■' : '□'}</span> Silkscreen
          </button>
        )}
        {/* Pad + copper-drop overlays render whenever the parser supplies
            board.pads (TVW, Allegro, XZZ). The pad layer sits below the
            pin layer (see board-scene addChildAt), so net-colored pins
            stay on top and the overlay just adds copper-color halos
            around them. The earlier multi-layer-only gate hid these
            toggles from XZZ users entirely; restored. */}
        {board?.pads && board.pads.length > 0 && (
          <button
            className={`visibility-toggle ${showPads ? '' : 'off'}`}
            onClick={() => boardStore.togglePads()}
            title={showPads ? 'Hide copper pads' : 'Show copper pads'}
          >
            <span className="toggle-check">{showPads ? '■' : '□'}</span> Pads
          </button>
        )}
        {board?.pads && board.pads.some(p => p.attached === false) && (
          <button
            className={`visibility-toggle ${showCopperDrops ? '' : 'off'}`}
            onClick={() => boardStore.toggleCopperDrops()}
            title={showCopperDrops ? 'Hide standalone GND/power copper drops' : 'Show standalone GND/power copper drops'}
          >
            <span className="toggle-check">{showCopperDrops ? '■' : '□'}</span> Copper drops
          </button>
        )}
        {board?.surfaces && board.surfaces.length > 0 && (
          <button
            className={`visibility-toggle ${showSurfaces ? '' : 'off'}`}
            onClick={() => boardStore.toggleSurfaces()}
            title={showSurfaces ? 'Hide copper-fill polygons (ground planes, power pours)' : 'Show copper-fill polygons (ground planes, power pours)'}
          >
            <span className="toggle-check">{showSurfaces ? '■' : '□'}</span> Copper fills
          </button>
        )}
        <div className="visibility-toggle-group">
          <div className="visibility-toggle-row">
            <button
              className={`visibility-toggle ${showComponents ? '' : 'off'}`}
              onClick={() => boardStore.toggleComponents()}
              title={showComponents ? 'Hide all components' : 'Show all components'}
            >
              <span className="toggle-check">{showComponents ? '■' : '□'}</span>
              <span className="toggle-label">Components</span>
            </button>
            <button
              className="toggle-collapse"
              onClick={() => setComponentsExpanded(!componentsExpanded)}
              title={componentsExpanded ? 'Collapse' : 'Expand'}
            >
              {componentsExpanded ? '▾' : '▸'}
            </button>
          </div>
          {componentsExpanded && (
            <div className={`visibility-sub-toggles ${showComponents ? '' : 'disabled'}`}>
              <button
                className={`visibility-toggle sub ${showComponents && showPins ? '' : 'off'}`}
                onClick={() => boardStore.togglePins()}
                disabled={!showComponents}
                title={showPins ? 'Hide pins' : 'Show pins'}
              >
                <span className="toggle-check">{showPins ? '■' : '□'}</span> Pins
              </button>
              <button
                className={`visibility-toggle sub ${showComponents && showOutlines ? '' : 'off'}`}
                onClick={() => boardStore.toggleOutlines()}
                disabled={!showComponents}
                title={showOutlines ? 'Hide outlines' : 'Show outlines'}
              >
                <span className="toggle-check">{showOutlines ? '■' : '□'}</span> Outlines
              </button>
              <button
                className={`visibility-toggle sub ${showComponents && showLabels ? '' : 'off'}`}
                onClick={() => boardStore.toggleLabels()}
                disabled={!showComponents}
                title={showLabels ? 'Hide labels' : 'Show labels'}
              >
                <span className="toggle-check">{showLabels ? '■' : '□'}</span> Labels
              </button>
            </div>
          )}
          {hiddenParts.length > 0 && (
            <div className="hidden-parts-row" title={hiddenParts.join(', ')}>
              <span className="hidden-parts-label">Hidden parts ({hiddenParts.length})</span>
              <button
                className="hidden-parts-restore"
                onClick={() => boardStore.unhideAllParts()}
                title={`Restore: ${hiddenParts.join(', ')}`}
              >
                Restore all
              </button>
            </div>
          )}
        </div>
      </div>

      {layerStates.length > 1 && (
        <div className="layer-list-hint">
          Click a layer to bump it on top · pin one to keep it there
        </div>
      )}
      <div className="layer-list-container">
        {layerStates.map((layer, idx) => {
          const hasNet = highlightedLayers.has(idx);
          const blinkHidden = hasNet && !layer.visible;
          const isSelected = selectedLayerIndex === idx;
          const isPinned = fixatedLayerIndex === idx;
          return (
            <div
              key={idx}
              className={[
                'layer-item',
                layer.visible ? '' : 'layer-hidden',
                hasNet ? 'layer-net-active' : '',
                blinkHidden ? 'layer-blink' : '',
                isSelected ? 'layer-selected' : '',
                isPinned ? 'layer-pinned' : '',
              ].join(' ')}
              onClick={() => boardStore.selectLayer(idx)}
              title="Click to bump this layer on top"
            >
              <button
                className={`layer-visibility ${layer.visible ? 'on' : 'off'}`}
                onClick={(e) => { e.stopPropagation(); boardStore.toggleLayer(idx); }}
                title={layer.visible ? 'Hide layer' : 'Show layer'}
              >
                {layer.visible ? '●' : '○'}
              </button>
              <input
                type="color"
                className="layer-color-picker"
                value={colorToHex(layer.color)}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => boardStore.setLayerColor(idx, hexToColor(e.target.value))}
                title="Change layer color"
              />
              <span className="layer-name">{layer.name}</span>
              <button
                className={`layer-pin ${isPinned ? 'pinned' : ''}`}
                onClick={(e) => { e.stopPropagation(); boardStore.fixateLayer(idx); }}
                title={isPinned ? 'Unpin — stop keeping this layer on top' : 'Pin this layer on top'}
                aria-pressed={isPinned}
              >
                {isPinned ? <IconPinFilled size={14} stroke={2} /> : <IconPin size={14} stroke={2} />}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function InfoTab({ tabId }: { tabId: number }) {
  // Subscribe to store changes but read from the specific tab. Renders the
  // SHARED ComponentInfoBody so this Info tab and the floating Component Info
  // panel stay in lock-step (BOM-alternates switcher, OBD cells + diagnosis).
  const { tabs } = useBoardStore();
  const tab = tabs.find(t => t.id === tabId);
  const board = tab?.board ?? null;
  const selection = tab?.selection ?? EMPTY_SELECTION;
  const tabFileName = tab?.fileName ?? '';
  const boardNumber = extractBoardNumberFromFilename(tabFileName) ?? undefined;
  const showBomAlternates = tab?.showBomAlternates ?? false;
  const bomClusterSelections: ReadonlyMap<string, string> =
    tab?.bomClusterSelections ?? EMPTY_BOM_SELECTIONS;

  if (!board) return <div className="panel-empty">No board loaded</div>;

  return (
    <ComponentInfoBody
      board={board}
      selection={selection}
      boardNumber={boardNumber}
      showBomAlternates={showBomAlternates}
      bomClusterSelections={bomClusterSelections}
    />
  );
}

function RevisionsTab({ tabId }: { tabId: number }) {
  const { tabs } = useBoardStore();
  const tab = tabs.find(t => t.id === tabId);
  const board = tab?.board ?? null;
  const fileName = tab?.fileName ?? '';
  const hideGhosts = tab?.hideGhosts ?? false;
  const swappedGhostPairs: ReadonlySet<string> = tab?.swappedGhostPairs ?? EMPTY_GHOST_SWAPS;
  const revisions = board?.revisions;
  const ghosts = board?.ghosts;
  const active = board?.activeRevision ?? (revisions && revisions.length > 0
    ? revisions[revisions.length - 1].index
    : 0);

  const activeRev = revisions?.find(r => r.index === active);
  // React Compiler memoizes this automatically. Manual useMemo with
  // [activeRev] was rejected because activeRev is itself derived inline.
  const activeRefdes = new Set(activeRev?.parts.map(p => p.name) ?? []);

  const bomClusters = board?.bomClusters;
  const showBomAlternates = tab?.showBomAlternates ?? false;
  const bomClusterSelections: ReadonlyMap<string, string> = tab?.bomClusterSelections ?? EMPTY_BOM_SELECTIONS;
  const hasRevisions = (revisions?.length ?? 0) > 1;
  const hasGhosts = (ghosts?.length ?? 0) > 0;
  const hasBomClusters = (bomClusters?.length ?? 0) > 0;
  if (!hasRevisions && !hasGhosts && !hasBomClusters) {
    return <div className="panel-empty">Nothing to report</div>;
  }

  return (
    <div className="panel-content revisions-panel" data-testid="revisions-panel">
      {hasRevisions && revisions && (
        <>
          <div className="revisions-header">
            <div className="revisions-title">Multiple revisions</div>
            <div className="revisions-subtitle" title={fileName}>
              {revisions.length} revisions detected in this file
            </div>
          </div>

          <div className="revisions-list">
            {revisions.map(rev => {
              const isActive = rev.index === active;
              const refdes = new Set(rev.parts.map(p => p.name));
              let added = 0, removed = 0;
              for (const r of refdes) if (!activeRefdes.has(r)) added++;
              for (const r of activeRefdes) if (!refdes.has(r)) removed++;
              return (
                <button
                  key={rev.index}
                  className={`revision-item ${isActive ? 'active' : ''}`}
                  onClick={() => boardStore.setActiveRevision(rev.index)}
                >
                  <div className="revision-radio">{isActive ? '●' : '○'}</div>
                  <div className="revision-meta">
                    <div className="revision-label">{rev.label}</div>
                    <div className="revision-stats">
                      {rev.componentCount} components
                      {!isActive && (added > 0 || removed > 0) && (
                        <span className="revision-diff">
                          {added > 0 && <span className="diff-add"> +{added}</span>}
                          {removed > 0 && <span className="diff-rem"> −{removed}</span>}
                        </span>
                      )}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>

          <div className="revisions-help">
            Some CAD exports accumulate every prior revision of the board into the
            same file. Switch revisions to compare layouts. The last revision is
            the canonical one for this file.
          </div>
        </>
      )}

      {hasGhosts && ghosts && (
        <div className="ghosts-section">
          <div className="ghosts-header">
            <div className="ghosts-title">⚠ Suspicious overlaps</div>
            <div className="ghosts-subtitle">
              {ghosts.length} component{ghosts.length === 1 ? '' : 's'} overlap
              another part with a superset of the same nets — likely stale
              refdes left from an earlier revision. The strikethrough side
              gets hidden when the toggle below is on; click ⇄ to swap if the
              detector picked the wrong side.
            </div>
            <button
              className={`ghost-hide-toggle ${hideGhosts ? 'on' : ''}`}
              onClick={() => boardStore.toggleHideGhosts()}
              title={hideGhosts
                ? 'Show all overlap parts (currently hiding strikethrough side)'
                : 'Hide the strikethrough side of every pair from the board'}
            >
              {hideGhosts ? '◉ Hiding strikethrough' : '○ Hide strikethrough side'}
            </button>
          </div>
          <div className="ghosts-list">
            {ghosts.map(g => {
              // Default: g.partName = stale (smaller), g.dominatorName = keep.
              // Swapped: roles flipped — dominator becomes the strikethrough one.
              const swapped = swappedGhostPairs.has(ghostPairSig(g.partIndex, g.dominatorIndex));
              const staleName = swapped ? g.dominatorName : g.partName;
              const keepName  = swapped ? g.partName     : g.dominatorName;
              return (
                <div key={`${g.partIndex}-${g.dominatorIndex}`} className="ghost-item">
                  <button
                    className="ghost-name ghost-stale"
                    onClick={() => {
                      if (hideGhosts) boardStore.toggleHideGhosts();
                      boardStore.focusPart(staleName);
                    }}
                    title={hideGhosts
                      ? `Show & focus ${staleName} (currently hidden)`
                      : `Focus ${staleName} — will be hidden when toggle is on`}
                  >
                    {staleName}
                  </button>
                  <button
                    className="ghost-swap"
                    onClick={() => boardStore.swapGhostPair(g.partIndex, g.dominatorIndex)}
                    title={swapped
                      ? 'Swap back to the auto-detected role (smaller part as stale)'
                      : 'Swap which side is treated as the stale one for this pair'}
                  >
                    ⇄
                  </button>
                  <button
                    className="ghost-name ghost-keep"
                    onClick={() => boardStore.focusPart(keepName)}
                    title={`Focus ${keepName} — kept on the board`}
                  >
                    {keepName}
                  </button>
                  <span className="ghost-distance">{Math.round(g.distance)} mils</span>
                </div>
              );
            })}
          </div>
          <div className="revisions-help">
            The auto-detector picks the smaller part of each overlap as the
            stale one (strikethrough). Click ⇄ on a row to flip that choice
            when you know which is really absent. The toggle above hides the
            strikethrough side of every pair from the rendered scene.
          </div>
        </div>
      )}

      {hasBomClusters && bomClusters && (
        <div className="bom-clusters-section">
          <div className="ghosts-header">
            <div className="ghosts-title">⇄ BOM alternates</div>
            <div className="ghosts-subtitle">
              {bomClusters.length} site{bomClusters.length === 1 ? '' : 's'} where same-role parts overlap
              and share connectivity — only one member of each cluster is
              fitted per BOM variant. The toggle below shows every member
              (X-ray) instead of just the chosen primary.
            </div>
            <button
              className={`ghost-hide-toggle ${showBomAlternates ? 'on' : ''}`}
              onClick={() => boardStore.toggleShowBomAlternates()}
              title={showBomAlternates
                ? 'Show only the chosen primary per cluster (currently showing all members)'
                : 'Show every cluster member overlapping (X-ray view)'}
            >
              {showBomAlternates ? '◉ Showing all alternates' : '○ Hide alternates (default)'}
            </button>
          </div>
          <div className="ghosts-list">
            {bomClusters.map((c) => {
              const sig = bomClusterSig(c.memberRefdes);
              const chosen = bomClusterSelections.get(sig) ?? c.defaultPrimaryRefdes;
              const reasonLabel = bomReasonLabel(c.reason);
              return (
                <div key={sig} className="ghost-item bom-cluster-item" style={{ flexWrap: 'wrap', gap: 4 }}>
                  <span style={{ fontSize: 11, color: '#888', minWidth: 60 }} title={`Auto-pick reason: ${reasonLabel}`}>
                    {c.memberRefdes.length}× ({reasonLabel})
                  </span>
                  {c.memberRefdes.map(refdes => {
                    const isChosen = refdes === chosen;
                    return (
                      <button
                        key={refdes}
                        className={`ghost-name ${isChosen ? 'ghost-keep' : 'ghost-stale'}`}
                        onClick={() => {
                          if (isChosen) {
                            boardStore.focusPart(refdes);
                          } else {
                            boardStore.selectBomClusterPrimary(sig, refdes);
                            boardStore.focusPart(refdes);
                          }
                        }}
                        title={isChosen
                          ? `${refdes} is the active primary — click to focus`
                          : `Click to make ${refdes} the active primary`}
                      >
                        {isChosen ? '●' : '○'} {refdes}
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
          <div className="revisions-help">
            BoardRipper auto-picks one member per cluster as the primary using
            shape-suffixed device names → lowest refdes → largest footprint
            (≈88% accurate across observed CAD files). Click any non-primary
            refdes to override the pick for that cluster.
          </div>
        </div>
      )}
    </div>
  );
}

interface NetComponentsSublistProps {
  board: BoardData;
  pinIndices: Array<{ partIndex: number; pinIndex: number }>;
}

/** Spoiler body shown beneath a selected net row in the search Nets section.
 *  Lists every component on the net (deduped, both sides), sorted by name.
 *  Pin count = pins of that part touching THIS net (not the part's total). */
function NetComponentsSublist({ board, pinIndices }: NetComponentsSublistProps) {
  const components = useMemo(() => {
    const byPart = new Map<number, { firstPinIdx: number; firstPinId: string; count: number }>();
    for (const { partIndex, pinIndex } of pinIndices) {
      const part = board.parts[partIndex];
      if (!part) continue;
      const existing = byPart.get(partIndex);
      if (existing) {
        existing.count++;
        if (pinIndex < existing.firstPinIdx) {
          existing.firstPinIdx = pinIndex;
          existing.firstPinId = pinDisplayId(part.pins[pinIndex], pinIndex);
        }
      } else {
        const pin = part.pins[pinIndex];
        byPart.set(partIndex, {
          firstPinIdx: pinIndex,
          firstPinId: pin ? pinDisplayId(pin, pinIndex) : String(pinIndex + 1),
          count: 1,
        });
      }
    }
    const rows: { name: string; side: string; firstPinId: string; count: number }[] = [];
    for (const [partIndex, v] of byPart) {
      const part = board.parts[partIndex];
      if (!part) continue;
      rows.push({ name: part.name, side: part.side, firstPinId: v.firstPinId, count: v.count });
    }
    return rows.sort((a, b) => a.name.localeCompare(b.name));
  }, [board, pinIndices]);

  return (
    <div className="net-components-sublist">
      {components.map(c => (
        <div
          key={c.name}
          className="search-result-item search-result-sub"
          onClick={() => boardStore.focusPart(c.name)}
        >
          <span className="result-pin-id">{c.firstPinId}</span>
          <span className="result-name">{c.name}</span>
          <span className={`badge badge-${c.side}`}>{c.side}</span>
          <span className="result-pins">{c.count} pin{c.count === 1 ? '' : 's'}</span>
        </div>
      ))}
    </div>
  );
}

/** Spoiler body shown beneath a selected component row. Lists every net
 *  the part touches (deduped), sorted by the first pin that hits it. Clicking
 *  a net focuses it on the board. */
function PartNetsSublist({ part }: { part: Part }) {
  const nets = useMemo(() => {
    const seenAt = new Map<string, { firstPinIdx: number; firstPinId: string; count: number }>();
    for (let i = 0; i < part.pins.length; i++) {
      const pin = part.pins[i];
      const net = pin.net;
      if (!net) continue;
      const entry = seenAt.get(net);
      if (entry) {
        entry.count++;
      } else {
        seenAt.set(net, { firstPinIdx: i, firstPinId: pinDisplayId(pin, i), count: 1 });
      }
    }
    return Array.from(seenAt.entries())
      .map(([net, v]) => ({ net, ...v }))
      .sort((a, b) => a.firstPinIdx - b.firstPinIdx);
  }, [part]);

  if (nets.length === 0) return null;
  return (
    <div className="net-components-sublist">
      {nets.map(({ net, firstPinId, count }) => (
        <div
          key={net}
          className="search-result-item search-result-sub"
          onClick={() => boardStore.focusNet(net)}
        >
          <span className="result-pin-id">{firstPinId}</span>
          <span className="result-name">{net}</span>
          <span className="result-pins">{count} pin{count === 1 ? '' : 's'}</span>
        </div>
      ))}
    </div>
  );
}

function SearchTab({ tabId }: { tabId: number }) {
  const { tabs } = useBoardStore();
  const { activeWorklist } = useWorklist();
  const tab = tabs.find(t => t.id === tabId);
  const board = tab?.board ?? null;
  const selection = tab?.selection ?? { partIndex: null, pinIndex: null, highlightedNet: null };
  const storeQuery = tab?.searchQuery ?? '';

  // Active-worklist membership sets so each row knows whether to render its
  // pin button as filled (already in the list) vs outline (click to add).
  const pinnedRefdes = new Set(activeWorklist?.entries.map(e => e.refdes) ?? []);
  const pinnedNets = new Set(activeWorklist?.netEntries?.map(e => e.netName) ?? []);

  const [query, setQuery] = useState(storeQuery || '');
  const [showSuggestions, setShowSuggestions] = useState(false);

  // Sync from toolbar search → sidebar search tab
  const prevStoreQueryRef = useRef('');
  if (storeQuery !== prevStoreQueryRef.current) {
    prevStoreQueryRef.current = storeQuery;
    if (storeQuery !== query) setQuery(storeQuery);
  }
  const [componentsOpen, setComponentsOpen] = useState(true);
  const [netsOpen, setNetsOpen] = useState(true);
  // Which part name (if any) has its net sublist expanded. Decoupled from
  // boardStore.selection so clicking a net *inside* the sublist (which clears
  // the part selection) doesn't collapse the spoiler.
  const [expandedPart, setExpandedPart] = useState<string | null>(null);
  // Which net (if any) has its component sublist expanded. Decoupled from
  // selection for the same reason — clicking a component below focuses the
  // part and would otherwise drop the net highlight + close the spoiler.
  const [expandedNet, setExpandedNet] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const suggestionsRef = useRef<HTMLDivElement>(null);

  // Expose input to module-level ref while mounted, for external focus requests.
  // Copy ref.current to a local at effect-run time so the cleanup compares
  // against the SAME element the effect registered — the ref's `.current` may
  // be null by the time the cleanup runs (React 19 cleans refs before effect
  // cleanups), which would skip the clear and leave a stale registration.
  useEffect(() => {
    const el = inputRef.current;
    setActiveSearchInput(el);
    return () => {
      if (getActiveSearchInput() === el) setActiveSearchInput(null);
    };
  }, []);

  // Filter out placeholder/empty names
  const isValidName = (name: string) => {
    const trimmed = name.trim();
    return trimmed !== '' && !/^\.+$/.test(trimmed);
  };

  // The React Compiler is NOT installed (verified: absent from package.json /
  // lockfile; vite uses bare react()), so these O(N log N) sorts must be
  // memoized by hand or they re-run on every keystroke. Dep on `board` is
  // correct: buildRenderedBoard mints a new BoardData on revision/BOM swaps;
  // selection changes do not.
  const allParts = useMemo(
    () => board ? board.parts.map(p => p.name).filter(isValidName).sort((a, b) => a.localeCompare(b)) : [],
    [board],
  );
  const allNets = useMemo(
    () => board ? Array.from(board.nets.keys()).filter(isValidName).sort((a, b) => a.localeCompare(b)) : [],
    [board],
  );

  // Pre-sort the full valid lists ONCE per board; filtering per keystroke is
  // O(N) over the pre-sorted arrays (no re-sort).
  const sortedParts = useMemo(
    () => board ? board.parts.filter(p => isValidName(p.name)).sort((a, b) => a.name.localeCompare(b.name)) : [],
    [board],
  );
  const sortedNets = useMemo(
    () => board
      ? Array.from(board.nets.entries()).filter(([name]) => isValidName(name)).sort((a, b) => a[0].localeCompare(b[0]))
      : [],
    [board],
  );

  // Compute filtered results (show all when no query)
  const ql = query.toLowerCase();
  const matchedParts = useMemo(
    () => ql ? sortedParts.filter(p => p.name.toLowerCase().includes(ql)) : sortedParts,
    [sortedParts, ql],
  );
  const matchedNets = useMemo(
    () => ql ? sortedNets.filter(([name]) => name.toLowerCase().includes(ql)) : sortedNets,
    [sortedNets, ql],
  );

  // Render cap: dense boards have 5–8k parts/nets. Rendering them all
  // unvirtualized janks every keystroke; cap the DOM and show an overflow
  // hint instead. Refine the query to narrow.
  const RESULT_CAP = 400;
  const shownParts = matchedParts.length > RESULT_CAP ? matchedParts.slice(0, RESULT_CAP) : matchedParts;
  const shownNets = matchedNets.length > RESULT_CAP ? matchedNets.slice(0, RESULT_CAP) : matchedNets;

  // Autocomplete suggestions (max 8)
  const suggestions = useMemo(() => {
    if (!ql) return [];
    const items: { label: string; type: 'component' | 'net' }[] = [];
    for (const name of allParts) {
      if (name.toLowerCase().includes(ql)) items.push({ label: name, type: 'component' });
      if (items.length >= 8) return items;
    }
    for (const name of allNets) {
      if (name.toLowerCase().includes(ql)) items.push({ label: name, type: 'net' });
      if (items.length >= 8) return items;
    }
    return items;
  }, [ql, allParts, allNets]);

  // Sync toolbar search with local query
  const onQueryChange = useCallback((value: string) => {
    setQuery(value);
    boardStore.setSearch(value);
  }, []);

  // Close suggestions on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (suggestionsRef.current && !suggestionsRef.current.contains(e.target as Node) &&
          inputRef.current && !inputRef.current.contains(e.target as Node)) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  if (!board) return <div className="panel-empty">No board loaded</div>;

  const totalResults = matchedParts.length + matchedNets.length;

  return (
    <div className="panel-content search-tab" data-testid="search-results">
      <div className="search-tab-input-wrap">
        <input
          ref={inputRef}
          type="text"
          className="search-tab-input"
          placeholder="Search components or nets..."
          value={query}
          onChange={(e) => { onQueryChange(e.target.value); setShowSuggestions(true); }}
          onFocus={() => { if (query) setShowSuggestions(true); }}
        />
        {query && (
          <button className="search-tab-clear" onClick={() => { onQueryChange(''); setShowSuggestions(false); }} title="Clear">×</button>
        )}
        {showSuggestions && suggestions.length > 0 && (
          <div className="search-tab-suggestions" ref={suggestionsRef}>
            {suggestions.map((s, i) => (
              <div key={i} className="search-tab-suggestion" onClick={() => {
                onQueryChange(s.label);
                setShowSuggestions(false);
              }}>
                <span className={`suggestion-type suggestion-type-${s.type}`}>{s.type === 'component' ? 'C' : 'N'}</span>
                <span className="suggestion-label">{s.label}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="search-tab-results">
        {query && <div className="search-results-summary">{totalResults} results for &quot;{query}&quot;</div>}

          {/* Components section */}
          <div className="search-section">
            <button className="search-section-header" onClick={() => setComponentsOpen(!componentsOpen)}>
              <span className="search-section-arrow">{componentsOpen ? <IconChevronDown size={18} /> : <IconChevronRight size={18} />}</span>
              <span className="search-section-title">Components</span>
              <span className="search-section-count">{matchedParts.length}</span>
            </button>
            {componentsOpen && (
              <div className="search-section-body">
                {matchedParts.length === 0 && <div className="search-section-empty">No matching components</div>}
                {shownParts.map((part) => {
                  const isExpanded = expandedPart === part.name;
                  const isPinned = pinnedRefdes.has(part.name);
                  return (
                    <div key={part.name} className={isExpanded ? 'search-spoiler-open' : ''}>
                      <div
                        className={`part-item ${isExpanded ? 'net-highlighted' : ''}`}
                        onClick={() => {
                          setExpandedPart(isExpanded ? null : part.name);
                          boardStore.focusPart(part.name);
                        }}
                      >
                        <span className="net-item-arrow">{isExpanded ? <IconChevronDown size={18} /> : <IconChevronRight size={18} />}</span>
                        <span className="result-name">{part.name}</span>
                        <span className={`badge badge-${part.side}`}>{part.side}</span>
                        <span className="result-pins">{part.pins.length} pins</span>
                        <button
                          className={`search-pin-btn ${isPinned ? 'pinned' : ''}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            worklistStore.pushRefdesToActive(part.name);
                          }}
                          title={isPinned ? 'Already in the active worklist' : 'Add to current worklist'}
                        >
                          {isPinned ? <IconPinFilled size={14} /> : <IconPin size={14} />}
                        </button>
                      </div>
                      {isExpanded && <PartNetsSublist part={part} />}
                    </div>
                  );
                })}
                {matchedParts.length > shownParts.length && (
                  <div className="search-section-overflow">
                    Showing {shownParts.length} of {matchedParts.length} — refine the search to narrow.
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Nets section */}
          <div className="search-section">
            <button className="search-section-header" onClick={() => setNetsOpen(!netsOpen)}>
              <span className="search-section-arrow">{netsOpen ? <IconChevronDown size={18} /> : <IconChevronRight size={18} />}</span>
              <span className="search-section-title">Nets</span>
              <span className="search-section-count">{matchedNets.length}</span>
            </button>
            {netsOpen && (
              <div className="search-section-body">
                {matchedNets.length === 0 && <div className="search-section-empty">No matching nets</div>}
                {shownNets.map(([name, net]) => {
                  const upper = name.toUpperCase();
                  const skipExpand = upper.includes('GND') || isNcNet(upper, renderSettingsStore.settings.ncNetPatterns);
                  const isExpanded = expandedNet === name && !skipExpand;
                  const isHighlighted = selection.highlightedNet === name || isExpanded;
                  const isPinned = pinnedNets.has(name);
                  return (
                    <div key={name} className={isExpanded ? 'search-spoiler-open' : ''}>
                      <div
                        className={`net-item ${isHighlighted ? 'net-highlighted' : ''}`}
                        onClick={() => {
                          if (isExpanded) {
                            setExpandedNet(null);
                            boardStore.highlightNet(null);
                          } else {
                            if (!skipExpand) setExpandedNet(name);
                            boardStore.focusNet(name);
                          }
                        }}
                      >
                        <span className="net-item-arrow">
                          {skipExpand ? null : isExpanded ? <IconChevronDown size={18} /> : <IconChevronRight size={18} />}
                        </span>
                        <span className="net-name">{name}</span>
                        <span className="net-count">{net.pinIndices.length}</span>
                        <button
                          className={`search-pin-btn ${isPinned ? 'pinned' : ''}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            worklistStore.pushNetToActive(name);
                          }}
                          title={isPinned ? 'Already in the active worklist' : 'Add to current worklist'}
                        >
                          {isPinned ? <IconPinFilled size={14} /> : <IconPin size={14} />}
                        </button>
                      </div>
                      {isExpanded && board && (
                        <NetComponentsSublist board={board} pinIndices={net.pinIndices} />
                      )}
                    </div>
                  );
                })}
                {matchedNets.length > shownNets.length && (
                  <div className="search-section-overflow">
                    Showing {shownNets.length} of {matchedNets.length} — refine the search to narrow.
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
    </div>
  );
}
