# BoardRipper — Project Configuration

## Project Overview
BoardRipper — web-based PCB boardview file viewer and inspector. Hosted via Docker on NAS.

## Tech Stack
- **Rendering:** PixiJS v8 (WebGL) + pixi-viewport v6 (pan/zoom/culling/deceleration)
- **Frontend:** React 19 + TypeScript + Vite 7
- **Panels:** Dockview v5 (dockable, detachable, floating, popout-to-window)
- **Backend:** Go (net/http stdlib) — serves SPA + handles file upload/list/delete
- **Container:** Docker (multi-stage build, scratch-based, ~15MB)
- **Tests:** Playwright (Chromium headless)

## Supported Formats
- BVR1 (`BVRAW_FORMAT_1`) — tab-delimited, absolute coords ×1000
- BVR3 (`BVRAW_FORMAT_3`) — keyword-value, relative pin coords
- Format spec: `docs/formats/BVR_FORMAT.md`

## Project Structure
```
Boardviewer/
├── CLAUDE.md                    # This file
├── README.md
├── Dockerfile                   # Multi-stage build (node → golang → scratch)
├── docker-compose.yml
├── docs/
│   ├── formats/
│   │   └── BVR_FORMAT.md        # BVR1/BVR3 format spec
│   └── PLANNING.md              # Architecture & implementation plan
├── samples/                     # Real-world BVR3 + PDF test files
└── src/
    ├── frontend/                # React + PixiJS SPA
    │   └── src/
    │       ├── parsers/         # BVR1/BVR3 parsers (pure TS functions)
    │       ├── renderer/        # BoardRenderer, board-scene (shared), mockup-data
    │       ├── components/      # Toolbar, StatusBar, TabBar, ContextMenu, PanelAdder
    │       ├── panels/          # ComponentInfo, NetList, SearchResults, PDF, Settings, SettingsMockup
    │       ├── hooks/           # useBoardStore, usePdfStore
    │       └── store/           # board-store, render-settings, board-cache, pdf-store, ...
    └── backend/                 # Go net/http server (upload/list/delete + SPA fallback)
```

## Key Architectural Decisions
- PixiJS v8 chosen over Canvas2D/Konva for GPU-accelerated rendering of 10,000+ components at 60fps
- `buildBoardScene()` in `renderer/board-scene.ts` is a shared pure function used by both `BoardRenderer` and `SettingsMockup` — visual changes propagate to both automatically
- BitmapText atlases for part/pin labels: dramatically fewer GPU draw calls vs per-label canvas Text objects
- Dockview chosen for IDE-like panel system with floating/popout window support
- Go backend chosen for minimal Docker footprint and single-binary deployment
- All BVR parsing happens client-side in TypeScript (no server dependency for rendering)
- `useSyncExternalStore` for reactive stores — getSnapshot must return a stable cached reference
- **NEVER call `app.destroy()` on PixiJS v8 Applications** — `destroy()` triggers `GlobalResourceRegistry.clear()` which corrupts the module-level `batchPool` in `Batcher.mjs`, permanently breaking ALL other Application instances with `_DefaultBatcher2.break: Cannot read properties of null`. Instead, just remove the canvas from DOM and let GC reclaim the Application + WebGL context. See `BoardRenderer.teardownForReinit()`.
- PDF panels use per-document state via `usePdfDoc(fileName)` hook, allowing multiple PDFs to render side-by-side. The singleton `pdfStore` tracks an "active" doc for mutations but each panel reads its own doc's state independently.

## Conventions
- TypeScript strict mode
- All coordinates internally in mils (thousandths of an inch)
- Component naming: PascalCase for React components, camelCase for functions/variables
- File format parsers are pure functions: `(text: string) => BoardData`

## Reference
- OpenBoardView source: https://github.com/OpenBoardView/OpenBoardView
- PixiJS v8 docs: https://pixijs.com/8.x/guides
- Dockview docs: https://dockview.dev/
