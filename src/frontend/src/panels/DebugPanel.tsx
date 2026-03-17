import { useSyncExternalStore, useEffect, useRef } from 'react';
import { logStore } from '../store/log-store';
import { boardCache } from '../store/board-cache';

export function DebugPanel() {
  const entries = useSyncExternalStore(
    cb => logStore.subscribe(cb),
    () => logStore.getSnapshot(),
  );

  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);

  // Auto-scroll to bottom when new entries arrive, unless user has scrolled up
  useEffect(() => {
    if (autoScrollRef.current) {
      bottomRef.current?.scrollIntoView({ block: 'nearest' });
    }
  }, [entries]);

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    autoScrollRef.current = atBottom;
  };

  return (
    <div className="debug-panel-root">
      <div className="debug-panel-toolbar">
        <span className="debug-panel-count">{entries.length} entries</span>
        <button
          onClick={() => boardCache.clear().then(() => logStore.log('log', '[cache] Board cache cleared'))}
          className="debug-panel-btn debug-panel-btn-warn"
          title="Clear IndexedDB board cache — forces re-parse on next open"
        >
          Clear Cache
        </button>
        <button
          onClick={() => logStore.clear()}
          className="debug-panel-btn debug-panel-btn-muted"
        >
          Clear Log
        </button>
      </div>
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="debug-panel-log"
      >
        {entries.length === 0 && (
          <div className="debug-panel-empty">No log entries yet. Open a board file to see output.</div>
        )}
        {entries.map(e => (
          <div
            key={e.id}
            className={`debug-log-entry${e.level === 'error' ? ' debug-log-entry-error' : ''} debug-log-text-${e.level}`}
          >
            <span className="debug-log-time">{e.time}</span>
            <span className={`debug-log-level debug-log-level-${e.level}`}>
              {e.level.toUpperCase()}
            </span>
            <span className="debug-log-message">{e.message}</span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
