import { Emitter } from './emitter';

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

const LS_ENABLED_KEY = 'boardripper-log-enabled';

class LogStore extends Emitter {
  private _entries: LogEntry[] = [];
  private _nextId = 1;
  private _snapshot: LogEntry[] = [];
  private _snapshotDirty = false;
  private _orig = {
    log:   console.log.bind(console),
    warn:  console.warn.bind(console),
    error: console.error.bind(console),
  };

  enabled: boolean;

  constructor() {
    super();
    let stored: string | null = null;
    try { stored = localStorage.getItem(LS_ENABLED_KEY); } catch { /* Node.js tests — no localStorage */ }
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
      if (this._entries.length > 600) this._entries = this._entries.slice(-500);
      this._snapshotDirty = true;
      this.notify();
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
    try { localStorage.setItem(LS_ENABLED_KEY, String(v)); } catch { /* Node.js */ }
    this.notify();
  }

  getSnapshot(): LogEntry[] {
    if (this._snapshotDirty) {
      this._snapshot = [...this._entries];
      this._snapshotDirty = false;
    }
    return this._snapshot;
  }

  clear() {
    this._entries = [];
    this._snapshot = [];
    this.notify();
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
