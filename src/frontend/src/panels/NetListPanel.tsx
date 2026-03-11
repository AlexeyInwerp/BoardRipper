import { useBoardStore } from '../hooks/useBoardStore';
import { boardStore } from '../store/board-store';

export function NetListPanel() {
  const { board, selection, searchQuery } = useBoardStore();

  if (!board) {
    return <div className="panel-empty">No board loaded</div>;
  }

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
