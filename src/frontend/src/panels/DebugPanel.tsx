import { useSyncExternalStore, useEffect, useRef } from 'react';
import { logStore } from '../store/log-store';

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
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', fontFamily: 'monospace', fontSize: '12px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px', borderBottom: '1px solid #333', flexShrink: 0 }}>
        <span style={{ color: '#aaa', flexGrow: 1 }}>{entries.length} entries</span>
        <button
          onClick={() => logStore.clear()}
          style={{ background: '#333', border: '1px solid #555', color: '#ccc', padding: '2px 8px', cursor: 'pointer', borderRadius: 3, fontSize: 11 }}
        >
          Clear
        </button>
      </div>
      <div
        ref={containerRef}
        onScroll={handleScroll}
        style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}
      >
        {entries.length === 0 && (
          <div style={{ color: '#555', padding: '8px 12px' }}>No log entries yet. Open a board file to see output.</div>
        )}
        {entries.map(e => (
          <div
            key={e.id}
            style={{
              display: 'flex',
              gap: 8,
              padding: '1px 8px',
              lineHeight: '18px',
              color: e.level === 'error' ? '#f88' : e.level === 'warn' ? '#fd9' : '#ccc',
              background: e.level === 'error' ? 'rgba(255,80,80,0.07)' : 'transparent',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
            }}
          >
            <span style={{ color: '#555', flexShrink: 0 }}>{e.time}</span>
            <span style={{
              flexShrink: 0,
              width: 36,
              color: e.level === 'error' ? '#f55' : e.level === 'warn' ? '#fa0' : '#666',
              fontWeight: e.level !== 'log' ? 600 : 400,
            }}>
              {e.level.toUpperCase()}
            </span>
            <span style={{ flex: 1 }}>{e.message}</span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
