import { useSyncExternalStore, useEffect, useRef, useState, useCallback } from 'react';
import { logStore, LOG_SCOPES, type LogScope, log } from '../store/log-store';
import { boardCache } from '../store/board-cache';

const LS_SCOPES_KEY = 'boardripper-log-scopes';
const LS_PERSIST_KEY = 'boardripper-log-persist';

function loadPersistedScopes(): Partial<Record<LogScope, boolean>> {
  try {
    const raw = localStorage.getItem(LS_SCOPES_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function loadPersist(): boolean {
  const raw = localStorage.getItem(LS_PERSIST_KEY);
  return raw === null ? true : raw === 'true';
}

const SCOPE_COLORS: Record<LogScope, string> = {
  parser: '#c084fc',
  render: '#60a5fa',
  pdf:    '#f97316',
  scan:   '#34d399',
  ui:     '#94a3b8',
  cache:  '#fbbf24',
  perf:   '#f472b6',
};

export function DebugPanel() {
  const entries = useSyncExternalStore(
    cb => logStore.subscribe(cb),
    () => logStore.getSnapshot(),
  );

  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);

  const [persist, setPersist] = useState(loadPersist);
  const [enabledScopes, setEnabledScopes] = useState<Partial<Record<LogScope, boolean>>>(
    () => persist ? loadPersistedScopes() : {},
  );
  const [loggingEnabled, setLoggingEnabled] = useState(() => logStore.enabled);

  useEffect(() => {
    if (persist) {
      localStorage.setItem(LS_SCOPES_KEY, JSON.stringify(enabledScopes));
    }
  }, [enabledScopes, persist]);

  useEffect(() => {
    localStorage.setItem(LS_PERSIST_KEY, String(persist));
    if (!persist) {
      localStorage.removeItem(LS_SCOPES_KEY);
    }
  }, [persist]);

  const toggleScope = useCallback((scope: LogScope) => {
    setEnabledScopes(prev => ({ ...prev, [scope]: !prev[scope] }));
  }, []);

  const toggleLogging = useCallback(() => {
    const next = !loggingEnabled;
    setLoggingEnabled(next);
    logStore.setEnabled(next);
  }, [loggingEnabled]);

  const filtered = entries.filter(e => e.level === 'error' || enabledScopes[e.scope]);

  useEffect(() => {
    if (autoScrollRef.current) {
      bottomRef.current?.scrollIntoView({ block: 'nearest' });
    }
  }, [filtered]);

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    autoScrollRef.current = atBottom;
  };

  return (
    <div className="debug-panel-root">
      <div className="debug-panel-toolbar">
        <span className="debug-panel-count">
          {filtered.length === entries.length
            ? `${entries.length} entries`
            : `${filtered.length} of ${entries.length} entries`}
        </span>
        <button
          onClick={() => boardCache.clear().then(() => log.cache.log('Board cache cleared'))}
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

      <div className="debug-filter-bar">
        <label className="debug-filter-toggle" title="Global logging kill switch">
          <span
            className={`debug-filter-dot ${loggingEnabled ? 'debug-filter-dot-on' : 'debug-filter-dot-off'}`}
            onClick={toggleLogging}
          />
          <span className="debug-filter-label" onClick={toggleLogging}>Logging</span>
        </label>

        <div className={`debug-filter-scopes ${!loggingEnabled ? 'debug-filter-disabled' : ''}`}>
          {LOG_SCOPES.map(scope => (
            <label key={scope} className="debug-filter-scope">
              <input
                type="checkbox"
                checked={!!enabledScopes[scope]}
                onChange={() => toggleScope(scope)}
                disabled={!loggingEnabled}
              />
              <span style={{ color: SCOPE_COLORS[scope] }}>{scope}</span>
            </label>
          ))}
        </div>

        <label className="debug-filter-persist" title="Remember enabled scopes across sessions">
          <input
            type="checkbox"
            checked={persist}
            onChange={() => setPersist(p => !p)}
          />
          <span>persist filters</span>
        </label>
      </div>

      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="debug-panel-log"
      >
        {!loggingEnabled && (
          <div className="debug-panel-empty">Logging disabled — toggle the switch above to capture entries.</div>
        )}
        {loggingEnabled && filtered.length === 0 && (
          <div className="debug-panel-empty">No matching entries. Enable scopes above or open a board file.</div>
        )}
        {filtered.map(e => (
          <div
            key={e.id}
            className={`debug-log-entry${e.level === 'error' ? ' debug-log-entry-error' : ''} debug-log-text-${e.level}`}
          >
            <span className="debug-log-time">{e.time}</span>
            <span className={`debug-log-level debug-log-level-${e.level}`}>
              {e.level.toUpperCase()}
            </span>
            <span className="debug-log-scope" style={{ color: SCOPE_COLORS[e.scope] }}>
              [{e.scope}]
            </span>
            <span className="debug-log-message">{e.message}</span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
