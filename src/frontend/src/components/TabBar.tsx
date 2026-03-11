import { boardStore } from '../store/board-store';
import { useBoardStore } from '../hooks/useBoardStore';

export function TabBar() {
  const { tabs, activeTabId } = useBoardStore();

  if (tabs.length === 0) return null;

  return (
    <div className="tab-bar">
      {tabs.map(tab => (
        <div
          key={tab.id}
          className={`tab-item ${tab.id === activeTabId ? 'active' : ''}`}
          onClick={() => boardStore.switchTab(tab.id)}
        >
          <span className="tab-name" title={tab.fileName}>
            {tab.fileName}
          </span>
          <button
            className="tab-close"
            onClick={(e) => {
              e.stopPropagation();
              boardStore.closeTab(tab.id);
            }}
            title="Close"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
