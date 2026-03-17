import { useState } from 'react';
import { useBoardStore } from '../hooks/useBoardStore';
import { boardStore } from '../store/board-store';

type SidebarTab = 'info' | 'nets' | 'search';

interface BoardSidebarProps {
  visible: boolean;
  onClose: () => void;
  /** One-shot tab switch request (cleared after applying) */
  requestedTab?: SidebarTab | null;
  onTabApplied?: () => void;
  opacity?: number;
}

export function BoardSidebar({ visible, onClose, requestedTab, onTabApplied, opacity = 1 }: BoardSidebarProps) {
  const [activeTab, setActiveTab] = useState<SidebarTab>('info');

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
        {activeTab === 'info' && <InfoTab />}
        {activeTab === 'nets' && <NetsTab />}
        {activeTab === 'search' && <SearchTab />}
      </div>
    </div>
  );
}

function InfoTab() {
  const { selectedPart, selection, board } = useBoardStore();

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

function NetsTab() {
  const { board, selection, searchQuery } = useBoardStore();

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

function SearchTab() {
  const { board, searchResults, searchQuery } = useBoardStore();

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
