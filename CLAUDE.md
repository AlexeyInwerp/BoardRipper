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
- **BVR1** — tab-delimited, absolute coords ×1000. Spec: `docs/formats/BVR_FORMAT.md`
- **BVR3** — keyword-value, relative pin coords. Spec: `docs/formats/BVR_FORMAT.md`
- **BRD** — binary obfuscated boardview (Apple/Mac repair). Spec: `docs/formats/BRD_FORMAT.md`
- **BDV** — plain-text boardview (BRDOUT/NETS/PARTS/PINS/NAILS sections). Spec: `docs/formats/BDV_FORMAT.md`
- **FZ** — ASUS boardview (RC6-encrypted, zlib-compressed). Spec: `docs/formats/FZ_FORMAT.md`
- **CAD** — GenCAD 1.4 text-based PCB interchange. Spec: `docs/formats/CAD_FORMAT.md`
- **XZZ** — XZZ PCB (DES-encrypted boardview). Spec: `docs/formats/XZZ_FORMAT.md`
- **TVW** — Teboview binary (multi-layer, traces, drill data). Spec: `docs/formats/TVW_FORMAT.md`
- **ALLEGRO_BRD** — Cadence Allegro binary PCB (v16.0–17.4, multi-layer). Spec: `docs/formats/ALLEGRO_BRD_FORMAT.md`

## Project Structure
```
Boardviewer/
├── CLAUDE.md                    # This file
├── README.md
├── Dockerfile                   # Multi-stage build (node → golang → scratch)
├── docker-compose.yml
├── docs/
│   ├── formats/                  # Format specifications (one per format)
│   │   ├── BVR_FORMAT.md        # BVR1/BVR3
│   │   ├── BRD_FORMAT.md        # BRD (Apple/Mac obfuscated)
│   │   ├── BDV_FORMAT.md        # BDV (plain-text boardview)
│   │   ├── FZ_FORMAT.md         # FZ (ASUS RC6-encrypted)
│   │   ├── CAD_FORMAT.md        # GenCAD 1.4
│   │   ├── XZZ_FORMAT.md        # XZZ PCB (DES-encrypted)
│   │   ├── TVW_FORMAT.md        # Teboview (multi-layer binary)
│   │   └── ALLEGRO_BRD_FORMAT.md # Cadence Allegro BRD
│   └── PLANNING.md              # Architecture & implementation plan
├── samples/                     # Real-world BVR3 + PDF test files
└── src/
    ├── frontend/                # React + PixiJS SPA
    │   └── src/
    │       ├── parsers/         # Format parsers (pure TS functions, 9 formats)
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
- All format parsing happens client-side in TypeScript (no server dependency for rendering)
- `useSyncExternalStore` for reactive stores — getSnapshot must return a stable cached reference
- **NEVER call `app.destroy()` on PixiJS v8 Applications** — `destroy()` triggers `GlobalResourceRegistry.clear()` which corrupts the module-level `batchPool` in `Batcher.mjs`, permanently breaking ALL other Application instances with `_DefaultBatcher2.break: Cannot read properties of null`. Instead, just remove the canvas from DOM and let GC reclaim the Application + WebGL context. See `BoardRenderer.teardownForReinit()`.
- PDF panels use per-document state via `usePdfDoc(fileName)` hook, allowing multiple PDFs to render side-by-side. The singleton `pdfStore` tracks an "active" doc for mutations but each panel reads its own doc's state independently.

## Conventions
- TypeScript strict mode
- All coordinates internally in mils (thousandths of an inch)
- Component naming: PascalCase for React components, camelCase for functions/variables
- File format parsers are pure functions: `(text: string) => BoardData`
- **Logging:** Use scoped loggers from `store/log-store.ts` — never raw `console.log`. Import `{ log }` and use `log.parser.*`, `log.render.*`, `log.pdf.*`, `log.scan.*`, `log.ui.*`, `log.cache.*`, `log.perf.*`. The Debug Panel filters by scope. Avoid logging in hot paths (per-frame, per-pointer-move).

## Reference
- OpenBoardView source: https://github.com/OpenBoardView/OpenBoardView
- PixiJS v8 docs: https://pixijs.com/8.x/guides
- Dockview docs: https://dockview.dev/
