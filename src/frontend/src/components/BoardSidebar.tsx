import { useState, useMemo } from 'react';
import { useBoardStore } from '../hooks/useBoardStore';
import { boardStore } from '../store/board-store';
import { colorToHex, hexToColor } from '../store/layer-store';

type SidebarTab = 'layers' | 'info' | 'nets' | 'search';

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
  const { layerStates } = useBoardStore();
  const hasLayers = layerStates.length > 0;
  const [activeTab, setActiveTab] = useState<SidebarTab>(hasLayers ? 'layers' : 'info');

  // Apply external tab request (one-shot: clear after applying)
  if (requestedTab && requestedTab !== activeTab) {
    setActiveTab(requestedTab);
    onTabApplied?.();
  }

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
            className={`board-sidebar-tab ${activeTab === 'nets' ? 'active' : ''}`}
            onClick={() => setActiveTab('nets')}
          >
            Nets
          </button>
          <button
            className={`board-sidebar-tab ${activeTab === 'search' ? 'active' : ''}`}
            onClick={() => setActiveTab('search')}
          >
            Search
          </button>
        </div>
        <button className="board-sidebar-close" onClick={onClose} title="Close sidebar">
          ×
        </button>
      </div>
      <div className="board-sidebar-content">
        {activeTab === 'layers' && <LayersTab />}
        {activeTab === 'info' && <InfoTab tabId={tabId} />}
        {activeTab === 'nets' && <NetsTab tabId={tabId} />}
        {activeTab === 'search' && <SearchTab tabId={tabId} />}
      </div>
    </div>
  );
}

function LayersTab() {
  const { layerStates, showComponents, showVias, showTraces, board, selection } = useBoardStore();

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
      <div className="layer-list-header">
        <span>{layerStates.length} layers</span>
        <div className="layer-header-buttons">
          <button
            className={`layer-toggle-all ${showTraces ? '' : 'off'}`}
            onClick={() => boardStore.toggleTraces()}
            title={showTraces ? 'Hide all traces' : 'Show all traces'}
          >
            {showTraces ? '◉ Traces' : '○ Traces'}
          </button>
          {board?.vias && board.vias.length > 0 && (
            <button
              className={`layer-toggle-all ${showVias ? '' : 'off'}`}
              onClick={() => boardStore.toggleVias()}
              title={showVias ? 'Hide vias' : 'Show vias'}
            >
              {showVias ? '◉ Vias' : '○ Vias'}
            </button>
          )}
          <button
            className={`layer-toggle-all ${showComponents ? '' : 'off'}`}
            onClick={() => boardStore.toggleComponents()}
            title={showComponents ? 'Hide all components' : 'Show all components'}
          >
            {showComponents ? '◉ Components' : '○ Components'}
          </button>
        </div>
      </div>
      <div className="layer-list-container">
        {layerStates.map((layer, idx) => {
          const hasNet = highlightedLayers.has(idx);
          const blinkHidden = hasNet && !layer.visible;
          return (
            <div
              key={idx}
              className={[
                'layer-item',
                layer.visible ? '' : 'layer-hidden',
                hasNet ? 'layer-net-active' : '',
                blinkHidden ? 'layer-blink' : '',
              ].join(' ')}
            >
              <button
                className={`layer-visibility ${layer.visible ? 'on' : 'off'}`}
                onClick={() => boardStore.toggleLayer(idx)}
                title={layer.visible ? 'Hide layer' : 'Show layer'}
              >
                {layer.visible ? '●' : '○'}
              </button>
              <input
                type="color"
                className="layer-color-picker"
                value={colorToHex(layer.color)}
                onChange={(e) => boardStore.setLayerColor(idx, hexToColor(e.target.value))}
                title="Change layer color"
              />
              <span className="layer-name">{layer.name}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function InfoTab({ tabId }: { tabId: number }) {
  // Subscribe to store changes but read from the specific tab
  const { tabs } = useBoardStore();
  const tab = tabs.find(t => t.id === tabId);
  const board = tab?.board ?? null;
  const selection = tab?.selection ?? { partIndex: null, pinIndex: null, highlightedNet: null };
  const selectedPart = board && selection.partIndex !== null ? board.parts[selection.partIndex] : null;

  if (!board) return <div className="panel-empty">No board loaded</div>;
  if (!selectedPart) return <div className="panel-empty">Click a component to inspect</div>;

  return (
    <div className="panel-content component-info" data-testid="component-info">
      <div className="info-header">
        <h3>{selectedPart.name}</h3>
        <div className="info-meta">
          <span className={`badge badge-${selectedPart.side}`}>{selectedPart.side}</span>
          <span className="badge">{selectedPart.type}</span>
          <span className="badge">{selectedPart.pins.length} pins</span>
        </div>
      </div>
      <div className="pin-table-container">
        <table className="pin-table">
          <thead>
            <tr><th>#</th><th>Name</th><th>Net</th></tr>
          </thead>
          <tbody>
            {selectedPart.pins.map((pin, idx) => {
              const isSelected = selection.pinIndex === idx;
              const isNetHighlighted = selection.highlightedNet === pin.net && pin.net !== '';
              return (
                <tr
                  key={idx}
                  className={[
                    isSelected ? 'pin-selected' : '',
                    isNetHighlighted ? 'pin-net-highlight' : '',
                  ].join(' ')}
                  onClick={() => {
                    if (selection.partIndex !== null) {
                      boardStore.selectPin(selection.partIndex, idx);
                    }
                  }}
                >
                  <td>{pin.number}</td>
                  <td>{pin.name}</td>
                  <td
                    className="pin-net"
                    onClick={(e) => {
                      e.stopPropagation();
                      boardStore.highlightNet(
                        selection.highlightedNet === pin.net ? null : pin.net
                      );
                    }}
                  >
                    {pin.net}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function NetsTab({ tabId }: { tabId: number }) {
  const { tabs } = useBoardStore();
  const tab = tabs.find(t => t.id === tabId);
  const board = tab?.board ?? null;
  const selection = tab?.selection ?? { partIndex: null, pinIndex: null, highlightedNet: null };
  const searchQuery = tab?.searchQuery ?? '';

  if (!board) return <div className="panel-empty">No board loaded</div>;

  const nets = Array.from(board.nets.entries())
    .sort((a, b) => a[0].localeCompare(b[0]));

  const filtered = searchQuery
    ? nets.filter(([name]) => name.toLowerCase().includes(searchQuery.toLowerCase()))
    : nets;

  return (
    <div className="panel-content net-list" data-testid="net-list">
      <div className="net-list-header">
        <span>{filtered.length} nets</span>
      </div>
      <div className="net-list-container">
        {filtered.map(([name, net]) => (
          <div
            key={name}
            className={`net-item ${selection.highlightedNet === name ? 'net-highlighted' : ''}`}
            onClick={() => boardStore.highlightNet(
              selection.highlightedNet === name ? null : name
            )}
          >
            <span className="net-name">{name}</span>
            <span className="net-count">{net.pinIndices.length}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function SearchTab({ tabId }: { tabId: number }) {
  const { tabs } = useBoardStore();
  const tab = tabs.find(t => t.id === tabId);
  const board = tab?.board ?? null;
  const searchQuery = tab?.searchQuery ?? '';
  const searchResults = boardStore.searchForTab(tabId);

  if (!board) return <div className="panel-empty">No board loaded</div>;
  if (!searchQuery) return <div className="panel-empty">Type in the search bar to find components</div>;

  return (
    <div className="panel-content search-results" data-testid="search-results">
      <div className="search-results-header">
        <span>{searchResults.length} results for &quot;{searchQuery}&quot;</span>
      </div>
      <div className="search-results-container">
        {searchResults.map((part) => (
            <div
              key={part.name}
              className="search-result-item"
              onClick={() => boardStore.focusPart(part.name)}
            >
              <span className="result-name">{part.name}</span>
              <span className={`badge badge-${part.side}`}>{part.side}</span>
              <span className="result-pins">{part.pins.length} pins</span>
            </div>
        ))}
      </div>
    </div>
  );
}
