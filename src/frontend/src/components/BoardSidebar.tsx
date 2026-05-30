import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { IconPin, IconPinFilled, IconChevronRight, IconChevronDown } from '@tabler/icons-react';
import { useBoardStore } from '../hooks/useBoardStore';
import { boardStore, ghostPairSig, bomClusterSig } from '../store/board-store';
import type { SelectionState } from '../store/board-store';
import { colorToHex, hexToColor } from '../store/layer-store';
import { renderSettingsStore, isNcNet } from '../store/render-settings';
import { extractBoardNumberFromFilename } from '../store/obd-store';
import { ComponentInfoBody } from './ComponentInfoBody';
import { WorklistPanel } from '../panels/WorklistPanel';
import { bomReasonLabel, type BoardData, type Part } from '../parsers';
import { pinDisplayId } from '../parsers/types';

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
  const [activeTab, setActiveTab] = useState<SidebarTab>(hasLayers ? 'layers' : 'info');

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
    if (
      (activeTab === 'revisions' && !showRevisionsTab) ||
      (activeTab === 'layers' && !hasLayers)
    ) {
      const frame = requestAnimationFrame(() => setActiveTab('info'));
      return () => cancelAnimationFrame(frame);
    }
  }, [activeTab, showRevisionsTab, hasLayers]);

  if (!visible) return null;

  return (
    <div className="board-sidebar" style={{ opacity }}>
      <div className="board-sidebar-header">
        <div className="board-sidebar-tabs">
          {hasLayers && (
            <button
              className={`board-sidebar-tab ${activeTab === 'layers' ? 'active' : ''}`}
              onClick={() => setActiveTab('layers')}
            >
              Layers
            </button>
          )}
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
  const showPins = tab?.showPins ?? true;
  const showOutlines = tab?.showOutlines ?? true;
  const showLabels = tab?.showLabels ?? true;
  const selection = tab?.selection ?? { partIndex: null, pinIndex: null, highlightedNet: null };
  const foldMode = tab?.foldMode ?? 'suggested';
  const selectedBoardIndex = tab?.selectedBoardIndex ?? null;
  const [componentsExpanded, setComponentsExpanded] = useState(true);

  // Compute which layers have traces for the currently highlighted net
  const highlightedLayers = useMemo(() => {
    const set = new Set<number>();
    if (selection.highlightedNet && board?.traces) {
      for (const t of board.traces) {
        if (t.net === selection.highlightedNet && t.layer != null) {
          set.add(t.layer);
        }
      }
    }
    return set;
  }, [selection.highlightedNet, board?.traces]);

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
      <div className="layer-list-header">
        <span>{layerStates.length} layers</span>
      </div>

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

  // Hooks must run unconditionally — keep useMemo above any early return.
  const activeRev = revisions?.find(r => r.index === active);
  const activeRefdes = useMemo(
    () => new Set(activeRev?.parts.map(p => p.name) ?? []),
    [activeRev],
  );

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

let _activeSearchInput: HTMLInputElement | null = null;
let _pendingFocus = false;
export function focusBoardSearchInput(): void {
  if (_activeSearchInput) {
    _activeSearchInput.focus();
    _activeSearchInput.select();
    return;
  }
  // SearchTab not mounted yet — flag it so the mount effect focuses on arrival
  _pendingFocus = true;
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
    const pinsByPart = new Map<number, number>();
    for (const { partIndex } of pinIndices) {
      pinsByPart.set(partIndex, (pinsByPart.get(partIndex) ?? 0) + 1);
    }
    const rows: { name: string; side: string; netPinCount: number }[] = [];
    for (const [partIndex, netPinCount] of pinsByPart) {
      const part = board.parts[partIndex];
      if (!part) continue;
      rows.push({ name: part.name, side: part.side, netPinCount });
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
          <span className="result-name">{c.name}</span>
          <span className={`badge badge-${c.side}`}>{c.side}</span>
          <span className="result-pins">{c.netPinCount} pin{c.netPinCount === 1 ? '' : 's'}</span>
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
  const tab = tabs.find(t => t.id === tabId);
  const board = tab?.board ?? null;
  const selection = tab?.selection ?? { partIndex: null, pinIndex: null, highlightedNet: null };
  const storeQuery = tab?.searchQuery ?? '';

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
  const inputRef = useRef<HTMLInputElement>(null);
  const suggestionsRef = useRef<HTMLDivElement>(null);

  // Expose input to module-level ref while mounted, for external focus requests
  useEffect(() => {
    _activeSearchInput = inputRef.current;
    if (_pendingFocus && inputRef.current) {
      _pendingFocus = false;
      inputRef.current.focus();
      inputRef.current.select();
    }
    return () => {
      if (_activeSearchInput === inputRef.current) _activeSearchInput = null;
    };
  }, []);

  // Filter out placeholder/empty names
  const isValidName = (name: string) => {
    const trimmed = name.trim();
    return trimmed !== '' && !/^\.+$/.test(trimmed);
  };

  // Build sorted lists for autocomplete
  const allParts = useMemo(
    () => board ? board.parts.map(p => p.name).filter(isValidName).sort((a, b) => a.localeCompare(b)) : [],
    [board?.parts],
  );
  const allNets = useMemo(
    () => board ? Array.from(board.nets.keys()).filter(isValidName).sort((a, b) => a.localeCompare(b)) : [],
    [board?.nets],
  );

  // Compute filtered results (show all when no query)
  const ql = query.toLowerCase();
  const matchedParts = useMemo(() => {
    if (!board) return [];
    const valid = board.parts.filter(p => isValidName(p.name));
    if (!ql) return valid.sort((a, b) => a.name.localeCompare(b.name));
    return valid.filter(p => p.name.toLowerCase().includes(ql));
  }, [board?.parts, ql]);

  const matchedNets = useMemo(() => {
    if (!board) return [];
    const entries = Array.from(board.nets.entries())
      .filter(([name]) => isValidName(name))
      .sort((a, b) => a[0].localeCompare(b[0]));
    if (!ql) return entries;
    return entries.filter(([name]) => name.toLowerCase().includes(ql));
  }, [board?.nets, ql]);

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
                {matchedParts.map((part) => {
                  const isSelected = board ? board.parts[selection.partIndex ?? -1]?.name === part.name : false;
                  return (
                    <div key={part.name}>
                      <div
                        className={`part-item ${isSelected ? 'net-highlighted' : ''}`}
                        onClick={() => boardStore.focusPart(part.name)}
                      >
                        <span className="net-item-arrow">{isSelected ? <IconChevronDown size={18} /> : <IconChevronRight size={18} />}</span>
                        <span className="result-name">{part.name}</span>
                        <span className={`badge badge-${part.side}`}>{part.side}</span>
                        <span className="result-pins">{part.pins.length} pins</span>
                      </div>
                      {isSelected && <PartNetsSublist part={part} />}
                    </div>
                  );
                })}
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
                {matchedNets.map(([name, net]) => {
                  const isHighlighted = selection.highlightedNet === name;
                  const upper = name.toUpperCase();
                  const skipExpand = upper.includes('GND') || isNcNet(upper, renderSettingsStore.settings.ncNetPatterns);
                  const expanded = isHighlighted && !skipExpand;
                  return (
                    <div key={name}>
                      <div
                        className={`net-item ${isHighlighted ? 'net-highlighted' : ''}`}
                        onClick={() => isHighlighted ? boardStore.highlightNet(null) : boardStore.focusNet(name)}
                      >
                        <span className="net-item-arrow">
                          {skipExpand ? null : expanded ? <IconChevronDown size={18} /> : <IconChevronRight size={18} />}
                        </span>
                        <span className="net-name">{name}</span>
                        <span className="net-count">{net.pinIndices.length}</span>
                      </div>
                      {expanded && board && (
                        <NetComponentsSublist board={board} pinIndices={net.pinIndices} />
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
    </div>
  );
}
