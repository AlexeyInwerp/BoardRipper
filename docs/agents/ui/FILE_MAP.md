# UI Agent — File Map

**git_hash:** a5a2f8e
**last_updated:** 2026-04-15

## Staleness Check

```bash
git log --oneline a7bbb79..HEAD -- src/frontend/src/panels/ src/frontend/src/components/ src/frontend/src/hooks/ src/frontend/src/store/ src/frontend/src/App.tsx
```

## Domain: Panels (`src/frontend/src/panels/`)

| File | Lines | Purpose |
|------|-------|---------|
| `BoardViewerPanel.tsx` | 263 | Main PixiJS canvas container, mount/cleanup, resize |
| `PdfViewerPanel.tsx` | 2,869 | **Shared with pdf agent** — PDF viewer with zoom/pan/search/bookmarks/tiled rendering/watermark filter |
| `SettingsPanel.tsx` | 1,325 | Render settings editor, presets, color pickers, part-type grouping, cache-control reset UI |
| `SettingsMockup.tsx` | 399 | Live preview of settings via `buildBoardScene()` |
| `LibraryPanel.tsx` | 1,194 | Backend library browser, folder tree, search, board-PDF bindings |
| `DebugPanel.tsx` | 173 | Scoped log viewer with level/scope filters |
| `ComponentInfoPanel.tsx` | 73 | Part/pin info display |
| `NetListPanel.tsx` | 42 | Net list (basic) |
| `SearchResultsPanel.tsx` | 37 | PDF text search results |

## Domain: Components (`src/frontend/src/components/`)

| File | Lines | Purpose |
|------|-------|---------|
| `Toolbar.tsx` | 443 | Top bar: file actions, view toggles, format selector, global search, toolbar groups (v0.4.1) |
| `BoardSidebar.tsx` | 619 | Right sidebar (extracted from Dockview, fixed width #9): Layers, Info, Nets, Revisions, Search tabs |
| `Sidebar.tsx` | 200 | **NEW** — standalone fixed-width sidebar shell (extraction from Dockview, 03c871d) |
| `ContextMenu.tsx` | 200 | Right-click menu: net actions, panel shortcuts, PDF lookup |
| `BindLink.tsx` | 91 | Board↔PDF association dropdown |
| `PanelAdder.tsx` | 85 | Re-open hidden panels dropdown |
| `TabBar.tsx` | 59 | Board tab switcher |
| `StatusBar.tsx` | 46 | Bottom bar: counts, selection info |

## Domain: Hooks (`src/frontend/src/hooks/`)

| File | Lines | Purpose |
|------|-------|---------|
| `useKeyboardShortcuts.ts` | 286 | Global keyboard listener (Cmd+F sidebar search, Tab board↔PDF, etc.) |
| `usePdfStore.ts` | 118 | Subscribe to PDF state |
| `useBoardStore.ts` | 75 | Subscribe to current tab board state |
| `useDatabank.ts` | 55 | Databank API calls |
| `createStoreHook.ts` | 35 | Factory for `useSyncExternalStore` hooks |
| `useUpdateStore.ts` | 8 | Subscribe to update state |

## Domain: Stores (`src/frontend/src/store/`)

| File | Lines | Purpose |
|------|-------|---------|
| `pdf-store.ts` | 1,469 | **Shared with pdf agent** |
| `render-settings.ts` | 949 | **Shared with renderer agent** |
| `board-store.ts` | 1,056 | Multi-tab board management, selection, view prefs, revision switching + ghost-hide (176cced) |
| `databank-store.ts` | 808 | Backend library integration |
| `dockview-api.ts` | 103 | Panel lifecycle (sidebar extracted to standalone in 03c871d) |
| `board-cache.ts` | 350 | IndexedDB cache for parsed boards, per-entry parser versioning + scoped reset (93d78e3) |
| `keyboard-shortcuts.ts` | 252 | Shortcut definitions, platform detection |
| `apple-boards.ts` | 203 | Apple board code lookup |
| `update-store.ts` | 141 | Auto-update state |
| `log-store.ts` | 108 | Scoped logging |
| `layer-store.ts` | 62 | **Shared with renderer agent** |
| `file-actions.ts` | 54 | File open dialogs |
| `context-menu-store.ts` | 33 | Right-click menu state |
| `view-commands.ts` | 23 | Pan/zoom constants |
| `emitter.ts` | 15 | Pub/sub event emitter |
| `file-inputs.ts` | 11 | File input ref map |

## Root

| File | Lines | Purpose |
|------|-------|---------|
| `App.tsx` | 234 | DockviewReact setup, panel registration, drag-drop, shortcuts |

## Shared Boundaries

- **pdf agent** owns: `PdfViewerPanel.tsx`, `pdf-store.ts`, `pdf/` directory
- **renderer agent** owns: `renderer/`, `render-settings.ts`, `layer-store.ts`
- **ui agent** owns everything else in panels/, components/, hooks/, store/

## Known Issues from Historical Bugs

- Focus/activation state is fragile: Dockview panel focus ↔ store ↔ ticker lifecycle caused 3 of 8 historical bugs (#1, #5, #6)
- `useSyncExternalStore` getSnapshot must return cached reference — new object = infinite loop
- `panel.api.setActive()` not `setActivePanel()` in Dockview v5

## Recent churn (a7bbb79..a5a2f8e)

- 03c871d — fix: extract sidebar from Dockview into standalone fixed-width component (closes #9)
- 9767d0c — release: v0.4.0 — sidebar overhaul, PDF performance, format cleanup
- 0355f93 — refactor: remove format overrides system, clamp sidebar width
- bfc11ad — release: v0.4.1 — global search, PDF click-to-lookup, toolbar groups
- 6ab75e1 — feat: PDF click-to-lookup, search nav hint, sidebar & renderer polish
- 176cced — feat(store): revision switching + ghost-hide toggle, persist via cache
- 32b9efc — feat(ui): revisions sidebar panel with revision switcher + ghost list
- 58f1dfa — feat: double-click / context-menu PDF lookup activates panel + focuses search
- 7031a7c — feat(ui): Cmd+F on empty board selection opens sidebar search; Tab jumps between board and linked PDF
- 93d78e3 — feat(cache): granular cache control — per-entry parser versioning + scoped reset UI
- 696cbe2 / a5a2f8e — Settings Part Types grouping + MOSFET→Transistor rename

