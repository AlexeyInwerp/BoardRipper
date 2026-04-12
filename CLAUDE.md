# BoardRipper — Project Configuration

## Project Overview
BoardRipper — web-based PCB boardview file viewer and inspector. Hosted via Docker on NAS.

## Tech Stack
- **Rendering:** PixiJS v8 (WebGL) + pixi-viewport v6 (pan/zoom/culling/deceleration)
- **Frontend:** React 19 + TypeScript + Vite 7
- **Panels:** Dockview v5 (dockable, detachable, floating, popout-to-window)
- **Backend:** Go (net/http stdlib) — serves SPA, file management, board database, self-update
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
├── desktop/                     # Electron desktop app (Mac + Windows builds)
├── scripts/                     # CI/workflow scripts
├── Board Database/              # Reference board database (SQLite)
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
    │   ├── tests/               # Playwright E2E specs
    │   └── src/
    │       ├── parsers/         # Format parsers (pure TS functions, 9 formats)
    │       ├── renderer/        # BoardRenderer, board-scene (shared), mockup-data
    │       ├── pdf/             # PDF glyph extraction & overlay utilities
    │       ├── components/      # Toolbar, StatusBar, TabBar, ContextMenu, PanelAdder, BindLink, BoardSidebar
    │       ├── panels/          # BoardViewer, ComponentInfo, NetList, SearchResults, PDF, Settings, SettingsMockup, Debug, Library
    │       ├── hooks/           # useBoardStore, usePdfStore, useDatabank, useKeyboardShortcuts, createStoreHook
    │       └── store/           # board-store, render-settings, board-cache, pdf-store, databank-store, update-store, ...
    └── backend/                 # Go net/http server
        ├── handlers/            # HTTP handlers (files, boards, databank, update)
        ├── boarddb/             # Board reference database (ODM matcher, resolver)
        ├── databank/            # File scanner, search, PDF text extraction
        └── updater/             # Self-update via Docker socket
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
- **PDF render pipeline:** Zoom → `mainTierFromZoom()` (capped by quality preset) → `quantiseTier()` (0.5 steps for cache hits) → `hysteresisFilter()` (5%/10% band prevents thrashing) → pdf.js render → `ImageBitmap` cache. Adjacent pages render center-out with `AbortController` cancellation. A separate preview cache (tier-1, never evicted by hi-res) provides instant fallback on zoom/page transitions. Quality presets (`max/high/medium/low`) control tier caps, cache sizes, and settle delays via `PdfQualityConfig` in `PdfViewerPanel.tsx`.
- **PDF canvas rules:** Only **pooled offscreen** canvases (freshly acquired, used once, released) use `getContext('2d', { alpha: false })`. Persistent canvases (main visible canvas, adjacent page canvases) must NOT use `alpha: false` — resetting `canvas.width` doesn't reliably reset the alpha attribute across browsers, causing mirroring artifacts on reused canvases. Canvas pool (8 entries) shrinks backing store synchronously before pooling — never defer shrinking (race condition with reuse). Highlight and glyph canvases retain alpha.
- **Scroll modifier zoom speeds:** Both BoardViewer and PDF viewer support modifier-dependent zoom speeds: Shift+Scroll = slow zoom (precise), Ctrl+Scroll = fast zoom (coarse), trackpad pinch = direct proportional zoom. Ctrl and Cmd are **distinct keys** even on Mac — browsers emit `ctrlKey=true` wheel events for both physical Ctrl+Scroll and trackpad pinch, but the pinch gesture produces small deltaY values that map to proportional zoom, while Ctrl+mouse-wheel produces large deltaY steps. pixi-viewport natively lacks shift-key awareness, so `BoardRenderer.installShiftWheelHandler()` intercepts Shift+Scroll in capture phase. The speed difference comes from divisor constants: `/500` (shift, slow) vs `/200` (ctrl+wheel, fast). Do not unify these — the two-speed zoom is a deliberate feature.

## Safety Rules
- **COMMIT before removing code.** Before deleting or replacing any significant block of code (>10 lines), commit the current working state first. A stray `git checkout` must never destroy hours of work.
- **COMMIT at milestones.** When a feature, phase, or significant progress is complete and building, commit immediately — don't accumulate uncommitted work.

## Conventions
- TypeScript strict mode
- All coordinates internally in mils (thousandths of an inch)
- Component naming: PascalCase for React components, camelCase for functions/variables
- File format parsers are pure functions: `(buffer: ArrayBuffer) => BoardData | Promise<BoardData>` (see `FormatDescriptor.parse` in `parsers/registry.ts`)
- **Logging:** Use scoped loggers from `store/log-store.ts` — never raw `console.log`. Import `{ log }` and use `log.parser.*`, `log.render.*`, `log.pdf.*`, `log.scan.*`, `log.ui.*`, `log.cache.*`, `log.perf.*`, `log.update.*`. The Debug Panel filters by scope. Avoid logging in hot paths (per-frame, per-pointer-move).

## Reference
- OpenBoardView source: https://github.com/OpenBoardView/OpenBoardView
- PixiJS v8 docs: https://pixijs.com/8.x/guides
- Dockview docs: https://dockview.dev/
