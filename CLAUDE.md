# BoardRipper — Project Configuration

## Project Overview
BoardRipper — web-based PCB boardview file viewer and inspector. Hosted via Docker on NAS.

## License
AGPL-3.0. See [LICENSE](LICENSE) and [THIRD_PARTY.md](THIRD_PARTY.md). AGPL was
chosen because the Allegro parser (`src/frontend/src/parsers/allegro/`) is a
TypeScript re-implementation derived from KiCad (GPL-3.0), which forces the
whole project to be GPL-3.0-compatible. AGPL additionally closes the SaaS
loophole. All other parsers (BVR/BRD/BDV/FZ/CAD/XZZ) draw from OpenBoardView
(MIT); TVW draws from eagleview (MIT). All runtime dependencies are
MIT/Apache-2.0/BSD.

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
- **BDV ASC** — Honhan / Tebo-ICT obfuscated multi-section ASC (line-key cipher). Spec: `docs/formats/BDV_ASC_FORMAT.md`
- **FZ** — ASUS boardview (RC6-encrypted, zlib-compressed). Spec: `docs/formats/FZ_FORMAT.md`
- **CAD** — GenCAD 1.4 text-based PCB interchange. Spec: `docs/formats/CAD_FORMAT.md`
- **XZZ** — XZZ PCB (DES-encrypted boardview). Spec: `docs/formats/XZZ_FORMAT.md`
- **TVW** — Teboview binary (multi-layer, traces, drill data). Spec: `docs/formats/TVW_FORMAT.md`
- **MENTOR_NEUTRAL** — Mentor Graphics Boardstation/Expedition neutral export (text, `.cad` extension; not GenCAD). Spec: `docs/formats/MENTOR_NEUTRAL_FORMAT.md`
- **ALLEGRO_BRD** — Cadence Allegro binary PCB. Two parser families share `parsers/allegro/`:
  - v16.x–v17.x (magic `0x0013XXXX`) — original target. Spec: `docs/formats/ALLEGRO_BRD_FORMAT.md`
  - v15.x (magic `0x0012XXXX`) — added in v0.17.0 via blind RE; ~99% net coverage on 15.5.7 corpus. Spec: `docs/formats/ALLEGRO_V15_FORMAT.md`

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
│   │   ├── BVR_FORMAT.md         # BVR1/BVR3
│   │   ├── BRD_FORMAT.md         # BRD (Apple/Mac obfuscated)
│   │   ├── BDV_FORMAT.md         # BDV (plain-text boardview)
│   │   ├── BDV_ASC_FORMAT.md     # BDV ASC (Honhan / Tebo-ICT obfuscated)
│   │   ├── FZ_FORMAT.md          # FZ (ASUS RC6-encrypted)
│   │   ├── CAD_FORMAT.md         # GenCAD 1.4
│   │   ├── XZZ_FORMAT.md         # XZZ PCB (DES-encrypted)
│   │   ├── TVW_FORMAT.md         # Teboview (multi-layer binary)
│   │   ├── MENTOR_NEUTRAL_FORMAT.md # Mentor Boardstation Neutral (.cad text)
│   │   ├── ALLEGRO_BRD_FORMAT.md # Cadence Allegro v16/v17 BRD
│   │   └── ALLEGRO_V15_FORMAT.md # Cadence Allegro v15.x BRD (RE'd in v0.17.0)
│   ├── PLANNING.md               # Architecture & implementation plan
│   ├── PDF_VIEWER.md             # PDF render-pipeline architecture
│   ├── RELEASE_RUNBOOK.md        # Maintainer release-cutting procedure
│   └── analysis/                 # Quarterly comprehensive code reviews
├── samples/                     # Real-world BVR3 + PDF test files
├── landing/                     # Static landing page deployed to ripperdoc.de
├── scripts/                     # release.sh, packaging, NAS deploy helpers
└── src/
    ├── frontend/                # React + PixiJS SPA
    │   ├── tests/               # Playwright E2E specs
    │   └── src/
    │       ├── parsers/         # Format parsers (pure TS functions, 11 formats)
    │       │   └── allegro/     # Allegro v15.x + v16/v17 (split families share types)
    │       ├── renderer/        # BoardRenderer, board-scene (shared), mockup-data
    │       ├── pdf/             # PDF glyph extraction & overlay utilities
    │       ├── components/      # Toolbar, StatusBar, TabBar, ContextMenu, PanelAdder, BindLink, BoardSidebar, UpdateBanner, UpdateModal, BoardOverlay, …
    │       ├── panels/          # BoardViewer, ComponentInfo, NetList, SearchResults, PDF, Settings, SettingsMockup, Debug, Library
    │       ├── hooks/           # useBoardStore, usePdfStore, useDatabank, useObdForBoard, useKeyboardShortcuts, createStoreHook
    │       └── store/           # board-store, render-settings, board-cache, pdf-store, databank-store, update-store, theme-store, overlay-store, obd-store, …
    └── backend/                 # Go net/http server
        ├── handlers/            # HTTP handlers (auth, files, boards, databank, sync, obd, update, health)
        ├── boarddb/             # Board reference database (v2 entity hierarchy, ODM matcher, resolver)
        ├── databank/            # File scanner, search, PDF text extraction
        ├── librarysync/         # WebDAV pull + scheduler for shared library mirror
        ├── obd/                 # OpenBoardData parser, cache, scraper
        └── updater/             # Self-update via Docker socket — signed-manifest pipeline
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
- **NEVER `BitmapFont.uninstall()` on per-tab teardown.** `BitmapFont.install()` registers atlases in PixiJS's **global** registry — one atlas is shared by every open tab's `BitmapText`. Uninstalling on tab close / scene rebuild destroys the `TextureStyle` still referenced by other tabs, which later crashes in `GlTextureSystem.updateStyle → applyStyleParams` with `Cannot read properties of null (reading 'addressModeU')`. Atlases are content-keyed (`board-shadow-N-v3`, `board-pin-N`), idempotent, and safe to keep for the app lifetime.
- PDF panels use per-document state via `usePdfDoc(fileName)` hook, allowing multiple PDFs to render side-by-side. The singleton `pdfStore` tracks an "active" doc for mutations but each panel reads its own doc's state independently.
- **PDF render pipeline:** see [docs/PDF_VIEWER.md](docs/PDF_VIEWER.md) for the full architecture. Short summary: at zoom ≤ 1.05 a full-page path renders the current page to an `ImageBitmap` cache keyed by `(file, page, tier, cleanMode)`; above that a per-tile DOM-canvas path (`tile-manager.ts`) renders 1024×1024 tiles with an LRU cache keyed by `(file, page, col, row, scale)`. Both paths flow through `mainTierFromZoom → quantiseTier → hysteresisFilter → clampCanvasScale` before calling `page.render()`. A separate tier-1 preview cache provides instant backdrop on zoom/page transitions. Adjacent pages use `renderPageToBitmap` (capped at `maxAdjTier`). Quality presets in `QUALITY_CONFIGS` control tier caps, cache budgets, and settle delays.
- **PDF watermark filter:** operator-level text filtering via pdf.js's public `operationsFilter` callback. `pdfStore.getWatermarkSkipSet()` scans the operator list once per page, matching glyph-drawing ops whose effective font size matches any watermark text item (5% relative tolerance). Skip sets are cached per `(file, page, filterSig)` and pre-warmed in the background via `requestIdleCallback` after text extraction completes. No post-processing, no clipping — watermark pixels never reach the canvas.
- **PDF canvas rules:** Only **pooled offscreen** canvases (freshly acquired, used once, released) use `getContext('2d', { alpha: false })`. Persistent canvases (main visible canvas, adjacent page canvases, tile canvases) must NOT use `alpha: false` — resetting `canvas.width` doesn't reliably reset the alpha attribute across browsers, causing mirroring artifacts on reused canvases. Canvas pool (8 entries) shrinks backing store synchronously before pooling — never defer shrinking (race condition with reuse). Highlight, glyph, and tile canvases retain alpha.
- **Never pool pdf.js-rendered canvases.** After `page.render()` completes, the pdf.js Worker thread may still queue stale draw operations. Abandon the offscreen canvas to GC by setting `width = 1; height = 1` — do NOT return it to the canvas pool, or subsequent reuses will be corrupted with mirrored/flipped content.
- **Scroll modifier zoom speeds:** Both BoardViewer and PDF viewer support modifier-dependent zoom speeds: Shift+Scroll = slow zoom (precise), Ctrl+Scroll = fast zoom (coarse), trackpad pinch = direct proportional zoom. Ctrl and Cmd are **distinct keys** even on Mac — browsers emit `ctrlKey=true` wheel events for both physical Ctrl+Scroll and trackpad pinch, but the pinch gesture produces small deltaY values that map to proportional zoom, while Ctrl+mouse-wheel produces large deltaY steps. pixi-viewport natively lacks shift-key awareness, so `BoardRenderer.installShiftWheelHandler()` intercepts Shift+Scroll in capture phase. The speed difference comes from divisor constants: `/500` (shift, slow) vs `/200` (ctrl+wheel, fast). Do not unify these — the two-speed zoom is a deliberate feature.
- **Secure update pipeline (v0.19.0+):** Releases are signed offline by the maintainer (Ed25519/minisign); the running container's compiled-in `PubKey` (set via Docker build-arg `PUBKEY` → ldflags, **no env/file override**) verifies every manifest before any I/O on its body. Two delivery sources walked in order — `ghcr.io/alexeyinwerp/boardripper` (pull-by-digest) and `https://www.ripperdoc.de/boardripper/` (signed-tarball mirror with sha256 verification) — first source whose signature verifies wins. Manifest schema includes monotonic `counter` (replay defence), `released_at` + `not_after` (30-day freshness window + 90-day expiry — see freshness invariants below), `min_supported_version` (downgrade defence), `important` flag (red-banner UX) + `important_reason` + `notes_url`, image registry/tag/digest, tarball sha256 + `size_bytes`, and `orchestrator_image_digest` (the multi-arch INDEX digest of the alpine container that swaps the running image). `/api/update/*` is gated by a per-install 32-byte secret persisted at `/data/.update-secret` (mode 0600); the install's monotonic counter persists alongside at `/data/.update-counter`. Cookie attributes: HttpOnly + SameSite=Strict + conditional Secure based on request scheme. Healthcheck-based rollback: orchestrator polls the new container's IP-resolved `/api/health` for 60 s and reverts on failure. The previous image is tagged `boardripper:previous` before swap so a manual rollback is one `docker run` away. Drop-to-update bundle (`POST /api/update/apply-bundle`) is the recovery escape-hatch — a signed-manifest+tarball single file the user can drag onto the window when GHCR + ripperdoc.de are both unreachable. Same trust envelope as the network path. **Operational invariants:** download timeout 10 min, body cap = manifest's `size_bytes` (or 1 GiB fallback), `released_at` rejection bounds [now − 30d, now + 24h], single-flight gate prevents concurrent `Apply` / `ApplyBundle`. See `docs/RELEASE_RUNBOOK.md` and `docs/superpowers/specs/2026-05-05-secure-update-pipeline-design.md`.
- **Theme stack (v0.18.0+):** themes split into board-side concerns (the `THEMES` registry — pin/part/background colours used by `buildBoardScene`) and three independent interface knobs persisted separately by `themeStore`: `accent`, `background`, `chrome`. Boards adopt the theme; UI chrome obeys the knobs. Auto-flip of accent text colour is computed against perceived brightness (don't hardcode contrast pairs). User-pickable accent presets (BoardRipper default + ATARI palette) live in `theme-store.ts`.
- **Board overlay slot system (v0.18.0+):** the floating in-canvas controls (top/bottom toggle, flip-axis, spotlight tri-state dim, parts/nets filters, separators, selection-name label) render via a slot registry under `components/BoardOverlay/`. Layout is persisted (`overlay-store.ts`) and reconciled against `DEFAULT_OVERLAY_LAYOUT` on load — new slots auto-append with `def.visible`, removed slots drop. Settings ▸ Board overlay edits the layout via drag-and-drop. Default position is left; the overlay is mounted as a `netDimGfx` sibling so highlight blending pattern works.
- **Boards reference database v2 (v0.15.0+):** `Board Database/boards.db` is a SQLite reference DB shipped inside the container image (`/build/boards.db`). v2 schema replaces the old flat board table with an entity hierarchy (Brand → Family → Board), color cascade, and explicit family field. Resolver lives in `src/backend/boarddb/`. Imported sources include Wikidata Macs, XZZ Apple-laptop filenames, and an LLM-classified NAS dump (~2,914 boards as of v0.16.6). The Database Editor panel surfaces it read-only.
- **Library sync (v0.16.11+):** `src/backend/librarysync/` pulls a remote WebDAV mirror into a local library mount on a schedule, with diff-then-fetch semantics, sync-error surfacing in the UI, and zero-byte-file skip. Configured via Settings ▸ Library. Scoped log: `log.scan.*`.
- **OpenBoardData (OBD) integration (v0.16.7+):** `src/backend/obd/` parses the public OBDATA_V002 corpus, caches per-board entries at `<dataDir>/obd/` (always writable across container updates; pre-v0.20.3 was rooted at the typically-read-only library mount and silently lost the cache on every restart), uses atomic writes + bpath sandbox, and exposes four HTTP handlers behind `/api/obd/*` with single-flight + drop-guard. Legacy caches at `<libRoot>/.boardripper/openboarddata/` are auto-migrated on first boot via `obd.MigrateLegacyCache` (skipped on cross-volume rename — user re-syncs once). Frontend renders a structured DIAGNOSIS section (collapsible blocks, clickable refs, multi-variant table) in LibraryPanel and surfaces readings in the canvas tooltip + Info pane. Scoped log: `log.obd.*`.
- **Cloud-storage-aware file serving (v0.20.4+):** the two cloud-exposed file-serve handlers (`files.Get` and `files.GetByPath`; `databank.PreviewGet` continues to use `http.ServeFile` since previews live in the always-local `<dataDir>/.previews/`) read files fully into memory via `serveFileEager` (`src/backend/handlers/serve.go`) and verify byte count matches `stat().Size()` before writing the response. Truncated reads from cloud-sync placeholders (Google Drive on macOS File Provider, OneDrive on Windows NTFS reparse points, iCloud, Dropbox) produce a 503 with `Retry-After: 5` instead of corrupt bytes; the 30s read deadline produces 503 with `Retry-After: 10`; an `EDEADLK` on read (Docker bind-mount can't drive host-side materialization) produces 503 with `Retry-After: 60` and an actionable body. Every error response carries `X-Boardripper-Cloud-Error: <code>` (`edeadlk` / `deadline` / `short-read` / `read-error:<errno>` / `open-failed:<errno>` / `not-found` / `is-dir` / `too-large`) so the frontend can switch on the code without parsing free-form bodies. `st_blocks` is logged in every error branch alongside size/elapsed/bytes_read for diagnosis (placeholder signal = `size>0 && blocks==0`) but is NOT used for gating — see commit `4b9c722` for why. Frontend `fetchWithCloudRetry` (`src/frontend/src/store/fetch-with-cloud-retry.ts`) retries up to 6 attempts / 3 min, logs every attempt to `log.cloud`, surfaces a "Downloading from cloud storage…" toast on retry, and on exhaustion uses `formatCloudErrorToast()` which switches on the cloud-error code and incorporates the backend body so the user sees actionable text (e.g. "materialize on host first" for `edeadlk`). Diagnostic endpoint: `GET /api/files/probe?path=<libpath>` runs a 5 s probe read and returns `{size, blocks, blocks_known, placeholder_signal, probe: {ok, bytes_read, errno, error, elapsed_ms, timed_out}}`. Trade-offs: loses range-request and ETag support (no consumer needed them); 512 MiB cap on in-memory reads. Scoped log: `log.cloud.*`.

## Safety Rules
- **COMMIT before removing code.** Before deleting or replacing any significant block of code (>10 lines), commit the current working state first. A stray `git checkout` must never destroy hours of work.
- **COMMIT at milestones.** When a feature, phase, or significant progress is complete and building, commit immediately — don't accumulate uncommitted work.

## Conventions
- TypeScript strict mode
- All coordinates internally in mils (thousandths of an inch)
- Component naming: PascalCase for React components, camelCase for functions/variables
- File format parsers are pure functions: `(buffer: ArrayBuffer) => BoardData | Promise<BoardData>` (see `FormatDescriptor.parse` in `parsers/registry.ts`)
- **Logging:** Use scoped loggers from `store/log-store.ts` — never raw `console.log`. Import `{ log }` and use `log.parser.*`, `log.render.*`, `log.pdf.*`, `log.scan.*`, `log.ui.*`, `log.cache.*`, `log.perf.*`, `log.update.*`, `log.obd.*`. The Debug Panel filters by scope. Avoid logging in hot paths (per-frame, per-pointer-move).

## Public landing page (`landing/`)
The `landing/` folder owns the static page served at <https://www.ripperdoc.de/boardripper/>. It is plain HTML5 with embedded CSS — no JS, no build step, not part of any application build. To update the page (new feature, new screenshot, format-table change): edit `landing/index.html` directly and replace screenshots in `landing/screenshots/`. The RipperDocWeb deploy script rsyncs this folder; nothing in this repo's build pipeline is involved. See `landing/README.md` for the full update workflow.

## Reference
- OpenBoardView source: https://github.com/OpenBoardView/OpenBoardView
- PixiJS v8 docs: https://pixijs.com/8.x/guides
- Dockview docs: https://dockview.dev/
