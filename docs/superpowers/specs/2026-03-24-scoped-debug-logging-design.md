# Scoped Debug Log Viewer — Design Spec

## Overview

Add structured log scoping to the existing debug log system. Each log entry is tagged with a scope (parser, render, pdf, etc.). The Debug Panel gains a filter bar to toggle scope visibility, a global kill switch for performance, and persistence controls.

## Data Model

```typescript
export type LogScope = 'parser' | 'render' | 'pdf' | 'scan' | 'ui' | 'cache' | 'perf';
export type LogLevel = 'log' | 'warn' | 'error';

export interface LogEntry {
  id: number;
  time: string;
  level: LogLevel;
  scope: LogScope;
  message: string;
}
```

Unscoped console calls (third-party libs, stray `console.log`) are tagged `'ui'` as a catch-all.

## Scoped Logger API

`log-store.ts` exports a `log` object with one method per scope:

```typescript
export const log = {
  parser: createScopedLogger('parser'),
  render: createScopedLogger('render'),
  pdf:    createScopedLogger('pdf'),
  scan:   createScopedLogger('scan'),
  ui:     createScopedLogger('ui'),
  cache:  createScopedLogger('cache'),
  perf:   createScopedLogger('perf'),
};

// Usage:
log.pdf.log('Content stream reduced by 40%');
log.parser.warn('TVW: unknown object type', objType);
log.render.error('teardown failed', err);
```

Each scoped logger's `.log()/.warn()/.error()` methods:
1. Call the original (pre-intercept) `console.*` method (for browser devtools)
2. Push a `LogEntry` with the scope tag into the store

### Global Kill Switch

- `logStore.enabled` boolean (default: `true`)
- When `false`: scoped loggers become no-ops — no string formatting, no `LogEntry` creation, no array pushes. Original `console.*` calls still pass through to devtools.
- Console interception for unscoped calls also skips store capture when disabled.
- Persisted in `localStorage['boardripper-log-enabled']`.

### Console Interception

Console interception stays for catching unscoped `console.log/warn/error` calls from third-party code. These get tagged with scope `'ui'`. When the global kill switch is off, interception skips store capture.

## Debug Panel UI

```
┌─────────────────────────────────────────────────┐
│  12 of 42 entries    [Clear Cache] [Clear Log]   │  ← toolbar (filtered count)
├─────────────────────────────────────────────────┤
│  [● Logging]                                     │  ← global kill switch
│  ☐ parser  ☐ render  ☐ pdf  ☐ scan  ☐ ui       │  ← scope toggles
│  ☐ cache   ☐ perf         ☑ persist filters     │
├─────────────────────────────────────────────────┤
│  10:23:01.445  WARN  [parser] TVW: unknown ...   │  ← log entries with scope badge
│  10:23:01.512  LOG   [pdf]    Content stream...  │
│  ...                                             │
└─────────────────────────────────────────────────┘
```

### Behavior

- **All scopes OFF by default** — clean panel, opt-in when debugging
- **Errors always shown** regardless of scope toggles
- Each entry displays a `[scope]` badge next to the level badge, color-coded per scope
- Entry count shows filtered vs total: "12 of 42 entries"
- **Persist filters checkbox** (default ON): saves enabled scopes to `localStorage['boardripper-log-scopes']`. When unchecked, scopes reset to all-off on next page load.
- **Global kill switch**: when OFF, scope checkboxes are greyed out, log list shows "Logging disabled" message
- Filtering is render-time only — all entries are always stored (when logging is enabled). Toggling a scope reveals historical entries.

## Migration

~164 call sites across 20 files are migrated to the scoped logger API. This covers three current patterns:
1. Raw `console.log/warn/error` calls
2. `logStore.log(level, ...)` calls (the direct store method, now deprecated)
3. `dbg()` helper calls (BoardRenderer)

All three patterns are replaced by `log.<scope>.log/warn/error(...)`.

| File | Sites | Current Pattern | Migrated To |
|------|-------|----------------|-------------|
| tvw-parser.ts | 20 | `console.log/warn` + `TVW_DEBUG` gate | `log.parser.log/warn` |
| bvr3-parser.ts | 2 | `console.warn` | `log.parser.warn` |
| xzz-parser.ts | 8 | `logStore.log()` with `[XZZ]` prefix | `log.parser.log/warn` |
| allegro-brd-parser.ts | 13 | `console.log/warn` + `ALLEGRO_DEBUG` gate | `log.parser.log/warn` |
| BoardRenderer.ts | 61 | `dbg()` + `window.__BV_DEBUG`, `logStore.log()` with `[renderer]`/`[follow]` prefix | `log.render.log/warn` (follow logs → `log.render`) |
| board-scene.ts | 1 | `console.warn` | `log.render.warn` |
| BoardViewerPanel.tsx | 3 | `logStore.log()` with `[panel]` prefix | `log.render.log` |
| SettingsMockup.tsx | 1 | `console.error` | `log.render.error` |
| render-settings.ts | 1 | `console.log` | `log.render.log` |
| pdf-store.ts | 13 | `console.log/error` with `[PdfStore]`/`[pdf-strip-perf]` prefix | `log.pdf.log/error`, `log.perf.log` (strip timings) |
| PdfViewerPanel.tsx | 9 | `console.log/error` with `[pdf-perf]` prefix | `log.perf.log` (timings), `log.pdf.error` (errors) |
| glyph-extractor.ts | 4 | `console.warn/error` | `log.pdf.warn/error` |
| databank-store.ts | 3 | `console.warn` with `[Databank]` prefix | `log.scan.warn` |
| board-store.ts | 5 | `logStore.log()` with `[board-store]` prefix | `log.cache.log/error` |
| dockview-api.ts | 4 | `console.error` with `[dockview]` prefix | `log.ui.error` |
| Toolbar.tsx | 2 | `console.error` | `log.ui.error` |
| LibraryPanel.tsx | 2 | `console.error` | `log.ui.error` |
| App.tsx | 2 | `console.error` with `[DragDrop]` prefix | `log.ui.error` |

### Deprecated APIs

The `logStore.log(level, ...)` method is removed. All existing callers migrate to the scoped `log.<scope>.*()` API. The `logStore` singleton remains for `subscribe()`, `getSnapshot()`, `clear()`, and the `enabled` toggle.

### Removals

- `const TVW_DEBUG = false` in tvw-parser.ts — deleted (scope toggle replaces it)
- `const ALLEGRO_DEBUG` in allegro-brd-parser.ts — deleted (scope toggle replaces it)
- `window.__BV_DEBUG` / `dbg()` in BoardRenderer.ts — deleted (scope toggle replaces it)
- String prefixes like `[PdfStore]`, `[Databank]`, `[dockview]`, `[DragDrop]`, `[XZZ]`, `[board-store]`, `[renderer]`, `[follow]`, `[panel]`, `[AllegroBRD]` — removed from message text (the scope badge replaces them)

## Persistence

| Key | Default | Schema | Purpose |
|-----|---------|--------|---------|
| `boardripper-log-enabled` | `true` | `boolean` | Global kill switch state |
| `boardripper-log-scopes` | `{}` (all off) | `Partial<Record<LogScope, boolean>>` — missing keys default to `false` | Which scopes are enabled for display |
| `boardripper-log-persist` | `true` | `boolean` | Whether scope state persists across sessions |

## Constraints

- The existing 500-entry cap is retained. Oldest entries are evicted first.
- Scope colors are defined at implementation time (not part of this spec).

## Testing

- Existing Playwright tests unaffected — no UI behavior changes outside the Debug Panel
- Manual verification: open board + PDF, confirm entries appear with correct scope badges, toggle scopes, toggle kill switch, verify persist on/off across refresh
