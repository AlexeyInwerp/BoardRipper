# UI Agent — File Map

**git_hash:** a7bbb79
**last_updated:** 2026-04-11

## Staleness Check

```bash
git log --oneline a7bbb79..HEAD -- src/frontend/src/panels/ src/frontend/src/components/ src/frontend/src/hooks/ src/frontend/src/store/ src/frontend/src/App.tsx
```

## Domain: Panels (`src/frontend/src/panels/`)

| File | Lines | Purpose |
|------|-------|---------|
| `BoardViewerPanel.tsx` | 247 | Main PixiJS canvas container, mount/cleanup, resize |
| `PdfViewerPanel.tsx` | 2,272 | **Shared with pdf agent** — PDF viewer with zoom/pan/search/bookmarks |
| `SettingsPanel.tsx` | 1,202 | Render settings editor, presets, color pickers |
| `SettingsMockup.tsx` | 399 | Live preview of settings via `buildBoardScene()` |
| `LibraryPanel.tsx` | 1,194 | Backend library browser, folder tree, search, board-PDF bindings |
| `DebugPanel.tsx` | 173 | Scoped log viewer with level/scope filters |
| `ComponentInfoPanel.tsx` | 73 | Part/pin info display |
| `NetListPanel.tsx` | 42 | Net list (basic) |
| `SearchResultsPanel.tsx` | 37 | PDF text search results |

## Domain: Components (`src/frontend/src/components/`)

| File | Lines | Purpose |
|------|-------|---------|
| `Toolbar.tsx` | 328 | Top bar: file actions, view toggles, format selector, search |
| `BoardSidebar.tsx` | 343 | Collapsible right sidebar: Layers, Info, Nets, Search tabs |
| `ContextMenu.tsx` | 190 | Right-click menu: net actions, panel shortcuts |
| `BindLink.tsx` | 91 | Board↔PDF association dropdown |
| `PanelAdder.tsx` | 85 | Re-open hidden panels dropdown |
| `TabBar.tsx` | 59 | Board tab switcher |
| `StatusBar.tsx` | 46 | Bottom bar: counts, selection info |

## Domain: Hooks (`src/frontend/src/hooks/`)

| File | Lines | Purpose |
|------|-------|---------|
| `useKeyboardShortcuts.ts` | 177 | Global keyboard listener (20+ shortcuts) |
| `usePdfStore.ts` | 114 | Subscribe to PDF state |
| `useBoardStore.ts` | 73 | Subscribe to current tab board state |
| `useDatabank.ts` | 55 | Databank API calls |
| `createStoreHook.ts` | 35 | Factory for `useSyncExternalStore` hooks |
| `useUpdateStore.ts` | 8 | Subscribe to update state |

## Domain: Stores (`src/frontend/src/store/`)

| File | Lines | Purpose |
|------|-------|---------|
| `pdf-store.ts` | 1,192 | **Shared with pdf agent** |
| `render-settings.ts` | 853 | **Shared with renderer agent** |
| `board-store.ts` | 848 | Multi-tab board management, selection, view prefs |
| `databank-store.ts` | 808 | Backend library integration |
| `dockview-api.ts` | 330 | Panel lifecycle, sidebar persistence |
| `board-cache.ts` | 250 | IndexedDB cache for parsed boards |
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
