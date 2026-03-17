import { useBoardStore } from '../hooks/useBoardStore';
import { boardStore } from '../store/board-store';

export function SearchResultsPanel() {
  const { board, searchResults, searchQuery } = useBoardStore();

  if (!board) {
    return <div className="panel-empty">No board loaded</div>;
  }

  if (!searchQuery) {
    return <div className="panel-empty">Type in the search bar to find components</div>;
  }

  return (
    <div className="panel-content search-results" data-testid="search-results">
      <div className="search-results-header">
        <span>{searchResults.length} results for "{searchQuery}"</span>
      </div>
      <div className="search-results-container">
        {searchResults.map((part) => {
          return (
            <div
              key={part.name}
              className="search-result-item"
              onClick={() => boardStore.focusPart(part.name)}
            >
              <span className="result-name">{part.name}</span>
              <span className={`badge badge-${part.side}`}>{part.side}</span>
              <span className="result-pins">{part.pins.length} pins</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
