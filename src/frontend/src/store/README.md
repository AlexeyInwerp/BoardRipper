# `store/` — State layer

The `store/` directory is the de-facto architecture layer. Every UI, renderer, and PDF interaction flows through it. Read this file before adding or editing a store.

## Core rule: `useSyncExternalStore` snapshot stability

React's `useSyncExternalStore` requires `getSnapshot()` to return a **stable reference** when the underlying state has not changed. Allocating a fresh object or array on every call causes infinite re-renders.

Every store here extends `Emitter` (see [emitter.ts](emitter.ts)) and uses one of two patterns:

1. **Single cached snapshot.** Mutate an internal `_snapshot` object in place and replace the reference on change; `getSnapshot()` returns the live reference.
2. **Selector via [createStoreHook.ts](../hooks/createStoreHook.ts).** `buildSnapshot` must return a value that only changes when inputs change — either a primitive, a cached object, or a memoized selector.

If you are tempted to write `getSnapshot: () => ({ foo, bar })` — STOP. Cache it.

## Emitter base class

[emitter.ts](emitter.ts) provides `subscribe(listener)` / `notify()` used by every reactive store. All stores below extend it.

## Stores

### Board & rendering

| File | Role |
|---|---|
| [board-store.ts](board-store.ts) | Board tabs, active tab, selection, per-tab layer visibility, auto-bind to PDF via `820-XXXXX` code. Orchestrates parsing via `../parsers` and caches via `board-cache`. |
| [board-cache.ts](board-cache.ts) | IndexedDB cache (`boardripper-cache`). Keyed by `fileName:fileSize:lastModified`. `DB_VERSION` bumps only on schema changes; parser changes use `PARSER_VERSION` per-entry. |
| [render-settings.ts](render-settings.ts) | Rendering overrides, quality presets, part-type definitions (prefix → category), label sizes. Reactive; persisted to localStorage. |
| [layer-store.ts](layer-store.ts) | Default layer palette and helpers for multi-layer boards. Actual state lives per-`BoardTab`. |
| [view-commands.ts](view-commands.ts) | Imperative command bus for viewport actions (zoom-to-fit, flip, reset). `BoardRenderer` subscribes; keyboard shortcuts and UI dispatch. |

### PDF

| File | Role |
|---|---|
| [pdf-store.ts](pdf-store.ts) | PDF document lifecycle, text extraction, page cache. Watermarks are filtered at parse time by the patched pdf.js worker via the `watermarkFilter` render option (terms from `render-settings.ts`); there is no client-side skip-set. Per-document state via `usePdfDoc(fileName)` hook — multiple PDFs render side-by-side. Singleton tracks "active" doc for mutations. See [docs/PDF_VIEWER.md](../../../../../docs/PDF_VIEWER.md), `patches/README.md`, and CLAUDE.md PDF rules. |

### Data sources

| File | Role |
|---|---|
| [databank-store.ts](databank-store.ts) | File scanner results from Go backend, search index, board lookup (`apple-boards`). Electron-aware. |
| [apple-boards.ts](apple-boards.ts) | Static Apple board-number → model lookup table (repair.wiki / logi.wiki). No reactive state. |

### UI / infrastructure

| File | Role |
|---|---|
| [context-menu-store.ts](context-menu-store.ts) | Right-click context menu visibility + items. |
| [dockview-api.ts](dockview-api.ts) | Module-global handle to the Dockview `DockviewApi` instance. `ensurePdfPanel()` etc. Set once by `App`, read by file-actions and keyboard shortcuts. |
| [file-actions.ts](file-actions.ts) | High-level actions that coordinate board-store + pdf-store + Dockview (e.g. "open file" decides whether it's a board or PDF and routes it). |
| [file-inputs.ts](file-inputs.ts) | Refs to hidden `<input type="file">` elements. Set by Toolbar, read by keyboard shortcuts. No reactive state. |
| [keyboard-shortcuts.ts](keyboard-shortcuts.ts) | Keyboard shortcut registry, platform detection (`isMac`), label formatting. Consumed by `useKeyboardShortcuts`. |
| [update-store.ts](update-store.ts) | Polls `/api/update/status` for the self-update system. |
| [log-store.ts](log-store.ts) | Scoped logger. **Use this — never raw `console.log`.** Scopes: `parser`, `render`, `pdf`, `scan`, `ui`, `cache`, `perf`, `update`, `obd`, `cloud`. Debug Panel filters by scope. Avoid logging in hot paths (per-frame, per-pointer-move, per-tile-render). |

## Ownership boundaries

- **board-store** owns board tabs and selection. Do not reach into it from renderer hot paths — subscribe once and cache.
- **pdf-store** is a singleton that multiplexes multiple documents. Never assume "the active doc" in panel code; take `fileName` as a prop.
- **render-settings** is read by both `BoardRenderer` and `SettingsMockup` via the shared `buildBoardScene()` — changes propagate automatically.
- **log-store** has no upstream dependencies. Every other store may import it.

## Adding a new store

1. Extend `Emitter`.
2. Cache the snapshot; never allocate on `getSnapshot()`.
3. Import `log` from `log-store` for any logging — do not touch `console.*`.
4. If the store coordinates other stores, put it in the "UI / infrastructure" group above and update this README.
5. If the store owns reactive state that React reads, add a hook wrapper (see `hooks/createStoreHook.ts`).
