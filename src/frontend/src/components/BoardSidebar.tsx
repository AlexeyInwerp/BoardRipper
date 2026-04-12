import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { useBoardStore } from '../hooks/useBoardStore';
import { boardStore } from '../store/board-store';
import { colorToHex, hexToColor } from '../store/layer-store';

type SidebarTab = 'layers' | 'info' | 'search';

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

  // Apply external tab request (one-shot, rAF defers setState to satisfy lint rule)
  useEffect(() => {
    if (!requestedTab || requestedTab === activeTab) return;
    const frame = requestAnimationFrame(() => {
      setActiveTab(requestedTab);
      onTabApplied?.();
    });
    return () => cancelAnimationFrame(frame);
  }, [requestedTab]); // eslint-disable-line react-hooks/exhaustive-deps

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
        </div>
        <button className="board-sidebar-close" onClick={onClose} title="Close sidebar">
          ×
        </button>
      </div>
      <div className="board-sidebar-content">
        {activeTab === 'layers' && <LayersTab />}
        {activeTab === 'info' && <InfoTab tabId={tabId} />}
        {activeTab === 'search' && <SearchTab tabId={tabId} />}
      </div>
    </div>
  );
}

function LayersTab() {
  const { layerStates, showComponents, showVias, showTraces, showPins, showOutlines, showLabels, board, selection } = useBoardStore();
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
        <div className="visibility-toggle-group">
          <button
            className={`visibility-toggle ${showComponents ? '' : 'off'}`}
            onClick={() => boardStore.toggleComponents()}
            title={showComponents ? 'Hide all components' : 'Show all components'}
          >
            <span className="toggle-check">{showComponents ? '■' : '□'}</span>
            <span className="toggle-label">Components</span>
            <button
              className="toggle-collapse"
              onClick={(e) => { e.stopPropagation(); setComponentsExpanded(!componentsExpanded); }}
              title={componentsExpanded ? 'Collapse' : 'Expand'}
            >
              {componentsExpanded ? '▾' : '▸'}
            </button>
          </button>
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

function SearchTab({ tabId }: { tabId: number }) {
  const { tabs, searchQuery: storeQuery } = useBoardStore();
  const tab = tabs.find(t => t.id === tabId);
  const board = tab?.board ?? null;
  const selection = tab?.selection ?? { partIndex: null, pinIndex: null, highlightedNet: null };

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
              <span className="search-section-arrow">{componentsOpen ? '▾' : '▸'}</span>
              <span className="search-section-title">Components</span>
              <span className="search-section-count">{matchedParts.length}</span>
            </button>
            {componentsOpen && (
              <div className="search-section-body">
                {matchedParts.length === 0 && <div className="search-section-empty">No matching components</div>}
                {matchedParts.map((part) => (
                  <div key={part.name} className="search-result-item" onClick={() => boardStore.focusPart(part.name)}>
                    <span className="result-name">{part.name}</span>
                    <span className={`badge badge-${part.side}`}>{part.side}</span>
                    <span className="result-pins">{part.pins.length} pins</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Nets section */}
          <div className="search-section">
            <button className="search-section-header" onClick={() => setNetsOpen(!netsOpen)}>
              <span className="search-section-arrow">{netsOpen ? '▾' : '▸'}</span>
              <span className="search-section-title">Nets</span>
              <span className="search-section-count">{matchedNets.length}</span>
            </button>
            {netsOpen && (
              <div className="search-section-body">
                {matchedNets.length === 0 && <div className="search-section-empty">No matching nets</div>}
                {matchedNets.map(([name, net]) => (
                  <div
                    key={name}
                    className={`net-item ${selection.highlightedNet === name ? 'net-highlighted' : ''}`}
                    onClick={() => boardStore.highlightNet(selection.highlightedNet === name ? null : name)}
                  >
                    <span className="net-name">{name}</span>
                    <span className="net-count">{net.pinIndices.length}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
    </div>
  );
}
