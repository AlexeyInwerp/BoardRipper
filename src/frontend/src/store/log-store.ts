export type LogLevel = 'log' | 'warn' | 'error';

export interface LogEntry {
  id: number;
  time: string;
  level: LogLevel;
  message: string;
}

type LogListener = () => void;

class LogStore {
  private _entries: LogEntry[] = [];
  private _listeners = new Set<LogListener>();
  private _nextId = 1;
  private _snapshot: LogEntry[] = [];

  constructor() {
    this._intercept();
  }

  private _intercept() {
    const orig = {
      log:   console.log.bind(console),
      warn:  console.warn.bind(console),
      error: console.error.bind(console),
    };

    const push = (level: LogLevel, args: unknown[]) => {
      const message = args.map(a => {
        if (a instanceof Error) return a.stack ?? a.message;
        if (typeof a === 'object') { try { return JSON.stringify(a); } catch { return String(a); } }
        return String(a);
      }).join(' ');
      const now = new Date();
      const time = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}.${String(now.getMilliseconds()).padStart(3,'0')}`;
      this._entries.push({ id: this._nextId++, time, level, message });
      // Keep last 500 entries
      if (this._entries.length > 500) this._entries.shift();
      this._snapshot = [...this._entries];
      for (const l of this._listeners) l();
    };

    console.log = (...args: unknown[]) => { orig.log(...args); push('log', args); };
    console.warn = (...args: unknown[]) => { orig.warn(...args); push('warn', args); };
    console.error = (...args: unknown[]) => { orig.error(...args); push('error', args); };
  }

  log(level: LogLevel, ...args: unknown[]) {
    // Route through overridden console so it appears in both places
    if (level === 'error') console.error(...args);
    else if (level === 'warn') console.warn(...args);
    else console.log(...args);
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
