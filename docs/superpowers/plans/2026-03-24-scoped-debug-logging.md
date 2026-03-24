# Scoped Debug Log Viewer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add structured log scoping with 7 scopes, a filter bar in the Debug Panel, a global kill switch, and persistence — replacing all ad-hoc logging patterns.

**Architecture:** Extend `log-store.ts` with a `LogScope` type and scoped logger factory. Each scope produces loggers with `.log()/.warn()/.error()` that tag entries and route through the original console. The `DebugPanel` gains a filter bar with scope checkboxes, a kill switch, and persist toggle. All ~164 call sites across 20 files are migrated from raw `console.*`/`logStore.log()`/`dbg()` to the new `log.<scope>.*()` API.

**Tech Stack:** React 19, TypeScript, CSS (existing vars), localStorage

**Spec:** `docs/superpowers/specs/2026-03-24-scoped-debug-logging-design.md`

---

### Task 1: Extend log-store.ts — data model + scoped logger API

**Files:**
- Modify: `src/frontend/src/store/log-store.ts`

- [ ] **Step 1: Add LogScope type and update LogEntry**

Add `LogScope` type and `scope` field to `LogEntry`. Add `enabled` property with localStorage persistence. Add `createScopedLogger` factory and `log` export.

```typescript
export type LogLevel = 'log' | 'warn' | 'error';
export type LogScope = 'parser' | 'render' | 'pdf' | 'scan' | 'ui' | 'cache' | 'perf';

export const LOG_SCOPES: readonly LogScope[] = ['parser', 'render', 'pdf', 'scan', 'ui', 'cache', 'perf'] as const;

export interface LogEntry {
  id: number;
  time: string;
  level: LogLevel;
  scope: LogScope;
  message: string;
}

type LogListener = () => void;

const LS_ENABLED_KEY = 'boardripper-log-enabled';

class LogStore {
  private _entries: LogEntry[] = [];
  private _listeners = new Set<LogListener>();
  private _nextId = 1;
  private _snapshot: LogEntry[] = [];
  private _orig = {
    log:   console.log.bind(console),
    warn:  console.warn.bind(console),
    error: console.error.bind(console),
  };

  enabled: boolean;

  constructor() {
    const stored = localStorage.getItem(LS_ENABLED_KEY);
    this.enabled = stored === null ? true : stored === 'true';
    this._intercept();
  }

  private _intercept() {
    const push = (level: LogLevel, scope: LogScope, args: unknown[]) => {
      if (!this.enabled) return;
      const message = args.map(a => {
        if (a instanceof Error) return a.stack ?? a.message;
        if (typeof a === 'object') { try { return JSON.stringify(a); } catch { return String(a); } }
        return String(a);
      }).join(' ');
      const now = new Date();
      const time = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}.${String(now.getMilliseconds()).padStart(3,'0')}`;
      this._entries.push({ id: this._nextId++, time, level, scope, message });
      if (this._entries.length > 500) this._entries.shift();
      this._snapshot = [...this._entries];
      for (const l of this._listeners) l();
    };

    // Intercept unscoped console calls (third-party libs) → tagged 'ui'
    console.log = (...args: unknown[]) => { this._orig.log(...args); push('log', 'ui', args); };
    console.warn = (...args: unknown[]) => { this._orig.warn(...args); push('warn', 'ui', args); };
    console.error = (...args: unknown[]) => { this._orig.error(...args); push('error', 'ui', args); };

    // Expose push for scoped loggers
    this._push = push;
  }

  private _push!: (level: LogLevel, scope: LogScope, args: unknown[]) => void;

  /** Create a scoped logger that routes through original console + store */
  createScopedLogger(scope: LogScope) {
    return {
      log: (...args: unknown[]) => { this._orig.log(`[${scope}]`, ...args); this._push('log', scope, args); },
      warn: (...args: unknown[]) => { this._orig.warn(`[${scope}]`, ...args); this._push('warn', scope, args); },
      error: (...args: unknown[]) => { this._orig.error(`[${scope}]`, ...args); this._push('error', scope, args); },
    };
  }

  setEnabled(v: boolean) {
    this.enabled = v;
    localStorage.setItem(LS_ENABLED_KEY, String(v));
    for (const l of this._listeners) l();
  }

  getSnapshot(): LogEntry[] { return this._snapshot; }

  clear() {
    this._entries = [];
    this._snapshot = [];
    for (const l of this._listeners) l();
  }

  subscribe(listener: LogListener): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }
}

export const logStore = new LogStore();

export const log = {
  parser: logStore.createScopedLogger('parser'),
  render: logStore.createScopedLogger('render'),
  pdf:    logStore.createScopedLogger('pdf'),
  scan:   logStore.createScopedLogger('scan'),
  ui:     logStore.createScopedLogger('ui'),
  cache:  logStore.createScopedLogger('cache'),
  perf:   logStore.createScopedLogger('perf'),
};
```

- [ ] **Step 2: Verify build compiles**

Run: `cd src/frontend && npx tsc --noEmit`
Expected: May show errors in files still using old `logStore.log()` API — that's fine, those get fixed in later tasks. The store itself should compile.

- [ ] **Step 3: Commit**

```bash
git add src/frontend/src/store/log-store.ts
git commit -m "feat: add scoped logger API with global kill switch to log-store"
```

---

### Task 2: Update DebugPanel — filter bar, scope toggles, kill switch

**Files:**
- Modify: `src/frontend/src/panels/DebugPanel.tsx`
- Modify: `src/frontend/src/index.css` (lines 2072–2170, add new classes after)

- [ ] **Step 1: Rewrite DebugPanel with filter bar**

Replace the full `DebugPanel.tsx` with:

```tsx
import { useSyncExternalStore, useEffect, useRef, useState, useCallback } from 'react';
import { logStore, LOG_SCOPES, type LogScope } from '../store/log-store';
import { boardCache } from '../store/board-cache';
import { log } from '../store/log-store';

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
  parser: '#c084fc',  // purple
  render: '#60a5fa',  // blue
  pdf:    '#f97316',  // orange
  scan:   '#34d399',  // green
  ui:     '#94a3b8',  // slate
  cache:  '#fbbf24',  // amber
  perf:   '#f472b6',  // pink
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

  // Persist scopes to localStorage when they change
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

  // Filter entries: show if scope is enabled OR level is error
  const filtered = entries.filter(e => e.level === 'error' || enabledScopes[e.scope]);

  // Auto-scroll
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
```

- [ ] **Step 2: Add CSS for filter bar and scope badges**

Append after the existing `.debug-log-text-log` rule (after line 2170 in `index.css`):

```css
/* Debug filter bar */
.debug-filter-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 4px 8px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.debug-filter-toggle {
  display: flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
  user-select: none;
}

.debug-filter-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  cursor: pointer;
}

.debug-filter-dot-on {
  background: #4ade80;
  box-shadow: 0 0 4px #4ade80;
}

.debug-filter-dot-off {
  background: #666;
}

.debug-filter-label {
  font-size: 11px;
  color: var(--text-primary);
  cursor: pointer;
}

.debug-filter-scopes {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.debug-filter-scopes.debug-filter-disabled {
  opacity: 0.4;
  pointer-events: none;
}

.debug-filter-scope {
  display: flex;
  align-items: center;
  gap: 2px;
  font-size: 11px;
  cursor: pointer;
  user-select: none;
}

.debug-filter-scope input[type="checkbox"] {
  margin: 0;
  cursor: pointer;
}

.debug-filter-persist {
  display: flex;
  align-items: center;
  gap: 3px;
  font-size: 10px;
  color: var(--text-secondary);
  margin-left: auto;
  cursor: pointer;
  user-select: none;
}

.debug-filter-persist input[type="checkbox"] {
  margin: 0;
  cursor: pointer;
}

/* Scope badge in log entries */
.debug-log-scope {
  flex-shrink: 0;
  width: 52px;
  font-size: 11px;
}
```

- [ ] **Step 3: Verify build and visual**

Run: `cd src/frontend && npx tsc --noEmit`
Expected: Compile clean (DebugPanel no longer uses removed `logStore.log()` method).

- [ ] **Step 4: Commit**

```bash
git add src/frontend/src/panels/DebugPanel.tsx src/frontend/src/index.css
git commit -m "feat: add scope filter bar, kill switch, and persist toggle to DebugPanel"
```

---

### Task 3: Migrate parsers (tvw, bvr3, xzz, allegro-brd)

**Files:**
- Modify: `src/frontend/src/parsers/tvw-parser.ts` (~20 sites)
- Modify: `src/frontend/src/parsers/bvr3-parser.ts` (~2 sites)
- Modify: `src/frontend/src/parsers/xzz-parser.ts` (~8 sites)
- Modify: `src/frontend/src/parsers/allegro-brd-parser.ts` (~13 sites)

- [ ] **Step 1: Migrate tvw-parser.ts**

1. Add `import { log } from '../store/log-store';` at top
2. Delete `const TVW_DEBUG = false;` (line 15)
3. Replace every `if (TVW_DEBUG) console.log(...)` → `log.parser.log(...)`
4. Replace every `if (TVW_DEBUG) console.warn(...)` → `log.parser.warn(...)`
5. Replace every unconditional `console.warn(...)` → `log.parser.warn(...)`
6. Replace every unconditional `console.log(...)` → `log.parser.log(...)`
7. Remove `TVW:` prefix from messages (scope badge replaces it)

- [ ] **Step 2: Migrate bvr3-parser.ts**

1. Add `import { log } from '../store/log-store';`
2. Replace `console.warn(...)` → `log.parser.warn(...)`

- [ ] **Step 3: Migrate xzz-parser.ts**

1. Replace `import { logStore } from '../store/log-store';` → `import { log } from '../store/log-store';`
2. Replace every `logStore.log('log', ...)` → `log.parser.log(...)`
3. Replace every `logStore.log('warn', ...)` → `log.parser.warn(...)`
4. Remove `[XZZ]` prefix from messages

- [ ] **Step 4: Migrate allegro-brd-parser.ts**

1. Add `import { log } from '../store/log-store';`
2. Delete `const ALLEGRO_DEBUG = false;` (line 40)
3. Replace every `if (ALLEGRO_DEBUG) console.warn(...)` → `log.parser.warn(...)`
4. Replace every `if (ALLEGRO_DEBUG) console.log(...)` → `log.parser.log(...)`
5. Replace every unconditional `console.log(...)` → `log.parser.log(...)`
6. Replace every unconditional `console.warn(...)` → `log.parser.warn(...)`
7. Remove `[AllegroBRD]` prefix from messages

- [ ] **Step 5: Verify build**

Run: `cd src/frontend && npx tsc --noEmit`
Expected: No errors in parser files.

- [ ] **Step 6: Commit**

```bash
git add src/frontend/src/parsers/tvw-parser.ts src/frontend/src/parsers/bvr3-parser.ts src/frontend/src/parsers/xzz-parser.ts src/frontend/src/parsers/allegro-brd-parser.ts
git commit -m "refactor: migrate parser logging to scoped log.parser API"
```

---

### Task 4: Migrate renderer files (BoardRenderer, board-scene, BoardViewerPanel, SettingsMockup, render-settings)

**Files:**
- Modify: `src/frontend/src/renderer/BoardRenderer.ts` (~61 sites)
- Modify: `src/frontend/src/renderer/board-scene.ts` (~1 site)
- Modify: `src/frontend/src/panels/BoardViewerPanel.tsx` (~3 sites)
- Modify: `src/frontend/src/panels/SettingsMockup.tsx` (~1 site)
- Modify: `src/frontend/src/store/render-settings.ts` (~1 site)

- [ ] **Step 1: Migrate BoardRenderer.ts**

1. Replace `import { logStore } from '../store/log-store';` → `import { log } from '../store/log-store';`
2. Delete the `window.__BV_DEBUG` type declaration, `DebugLevel` type, and `dbg()` function (lines ~33-38)
3. Replace every `dbg(N, ...)` → `log.render.log(...)`
4. Replace every `logStore.log('log', ...)` → `log.render.log(...)`
5. Replace every `logStore.log('warn', ...)` → `log.render.warn(...)`
6. Replace every `console.warn(...)` → `log.render.warn(...)`
7. Remove `[renderer]`, `[follow]`, `[BoardRenderer]` prefixes from messages

- [ ] **Step 2: Migrate board-scene.ts**

1. Add `import { log } from '../store/log-store';`
2. Replace `console.warn(...)` → `log.render.warn(...)`

- [ ] **Step 3: Migrate BoardViewerPanel.tsx**

1. Replace `import { logStore } from '../store/log-store';` → `import { log } from '../store/log-store';`
2. Replace every `logStore.log('log', ...)` → `log.render.log(...)`
3. Remove `[panel]` prefix from messages

- [ ] **Step 4: Migrate SettingsMockup.tsx and render-settings.ts**

1. SettingsMockup: add `import { log } from '../store/log-store';`, replace `console.error(...)` → `log.render.error(...)`
2. render-settings: add `import { log } from '../store/log-store';`, replace `console.log(...)` → `log.render.log(...)`

- [ ] **Step 5: Verify build**

Run: `cd src/frontend && npx tsc --noEmit`
Expected: No errors in renderer/panel files.

- [ ] **Step 6: Commit**

```bash
git add src/frontend/src/renderer/BoardRenderer.ts src/frontend/src/renderer/board-scene.ts src/frontend/src/panels/BoardViewerPanel.tsx src/frontend/src/panels/SettingsMockup.tsx src/frontend/src/store/render-settings.ts
git commit -m "refactor: migrate renderer/panel logging to scoped log.render API"
```

---

### Task 5: Migrate PDF files (pdf-store, PdfViewerPanel, glyph-extractor)

**Files:**
- Modify: `src/frontend/src/store/pdf-store.ts` (~13 sites)
- Modify: `src/frontend/src/panels/PdfViewerPanel.tsx` (~9 sites)
- Modify: `src/frontend/src/pdf/glyph-extractor.ts` (~4 sites)

- [ ] **Step 1: Migrate pdf-store.ts**

1. Replace `import { logStore } from './log-store';` → `import { log } from './log-store';`
2. Replace `console.log(...)` / `logStore.log('log', ...)` with `[PdfStore]` → `log.pdf.log(...)` (remove prefix)
3. Replace `console.error(...)` / `logStore.log('error', ...)` → `log.pdf.error(...)` (remove prefix)
4. Performance timing logs with `[pdf-strip-perf]` → `log.perf.log(...)` (remove prefix)

- [ ] **Step 2: Migrate PdfViewerPanel.tsx**

1. Replace `import { logStore } from '../store/log-store';` → `import { log } from '../store/log-store';`
2. `[pdf-perf]` timing logs → `log.perf.log(...)` (remove prefix)
3. Error logs → `log.pdf.error(...)` (remove prefix)

- [ ] **Step 3: Migrate glyph-extractor.ts**

1. Add `import { log } from '../store/log-store';`
2. Replace `console.warn(...)` → `log.pdf.warn(...)`
3. Replace `console.error(...)` → `log.pdf.error(...)`

- [ ] **Step 4: Verify build**

Run: `cd src/frontend && npx tsc --noEmit`
Expected: No errors in PDF files.

- [ ] **Step 5: Commit**

```bash
git add src/frontend/src/store/pdf-store.ts src/frontend/src/panels/PdfViewerPanel.tsx src/frontend/src/pdf/glyph-extractor.ts
git commit -m "refactor: migrate PDF logging to scoped log.pdf/log.perf API"
```

---

### Task 6: Migrate remaining files (scan, cache, ui)

**Files:**
- Modify: `src/frontend/src/store/databank-store.ts` (~3 sites)
- Modify: `src/frontend/src/store/board-store.ts` (~5 sites)
- Modify: `src/frontend/src/store/dockview-api.ts` (~4 sites)
- Modify: `src/frontend/src/components/Toolbar.tsx` (~2 sites)
- Modify: `src/frontend/src/panels/LibraryPanel.tsx` (~2 sites)
- Modify: `src/frontend/src/App.tsx` (~2 sites)

- [ ] **Step 1: Migrate databank-store.ts (scan scope)**

1. Add `import { log } from './log-store';`
2. Replace `console.warn(...)` with `[Databank]` → `log.scan.warn(...)` (remove prefix)

- [ ] **Step 2: Migrate board-store.ts (cache scope)**

1. Replace `import { logStore } from './log-store';` → `import { log } from './log-store';`
2. Replace `logStore.log('log', ...)` → `log.cache.log(...)` (remove `[board-store]` prefix)
3. Replace `logStore.log('error', ...)` → `log.cache.error(...)` (remove prefix)

- [ ] **Step 3: Migrate UI files (dockview-api, Toolbar, LibraryPanel, App)**

1. dockview-api.ts: add `import { log } from './log-store';`, replace `console.error(...)` → `log.ui.error(...)`, remove `[dockview]` prefix
2. Toolbar.tsx: add `import { log } from '../store/log-store';`, replace `console.error(...)` → `log.ui.error(...)`
3. LibraryPanel.tsx: add `import { log } from '../store/log-store';`, replace `console.error(...)` → `log.ui.error(...)`
4. App.tsx: add `import { log } from '../store/log-store';`, replace `console.error(...)` → `log.ui.error(...)`, remove `[DragDrop]` prefix

- [ ] **Step 4: Remove deprecated logStore.log() method**

In `src/frontend/src/store/log-store.ts`, delete the `log()` method from the `LogStore` class (the old `logStore.log(level, ...args)` API). Verify no remaining callers exist.

Run: `cd src/frontend && grep -r "logStore\.log(" src/ --include="*.ts" --include="*.tsx"`
Expected: Only `log-store.ts` internal references (if any) — no external callers.

- [ ] **Step 5: Verify full build**

Run: `cd src/frontend && npx tsc --noEmit`
Expected: Zero errors. All call sites migrated.

- [ ] **Step 6: Commit**

```bash
git add src/frontend/src/store/databank-store.ts src/frontend/src/store/board-store.ts src/frontend/src/store/dockview-api.ts src/frontend/src/components/Toolbar.tsx src/frontend/src/panels/LibraryPanel.tsx src/frontend/src/App.tsx src/frontend/src/store/log-store.ts
git commit -m "refactor: migrate scan/cache/ui logging to scoped API, remove deprecated logStore.log()"
```

---

### Task 7: Manual smoke test and final cleanup

- [ ] **Step 1: Run dev server and verify visually**

Run: `cd src/frontend && npm run dev`

Test checklist:
1. Open the Debug Panel in the sidebar
2. Open a board file — confirm entries appear with `[scope]` badges in correct colors
3. All scopes should be OFF by default — only errors visible
4. Toggle `parser` scope ON — parser entries appear, count updates to "N of M entries"
5. Toggle `render` scope ON — renderer entries appear
6. Open a PDF — toggle `pdf` and `perf` scopes, confirm PDF logs show up
7. Toggle logging OFF — scope checkboxes grey out, "Logging disabled" message shows
8. Open another file while logging is OFF — confirm no new entries captured
9. Toggle logging back ON — new entries start appearing again
10. Check "persist filters" ON, enable some scopes, refresh page — scopes restored
11. Uncheck "persist filters", refresh — scopes reset to all-off

- [ ] **Step 2: Run existing Playwright tests**

Run: `cd src/frontend && npx playwright test`
Expected: All existing tests pass (no UI behavior changes outside Debug Panel).

- [ ] **Step 3: Final commit if any cleanup needed**

```bash
git add -A
git commit -m "chore: scoped debug logging — final cleanup"
```
