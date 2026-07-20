# BoardRipper Web — Lite Build (Backend-Free) — Design

**Date:** 2026-07-20 (revised 2026-07-21 after model review: renamed demo → lite, closed gating gaps)
**Status:** Design — approved decisions captured; pending final user review
**Topic:** The lite build of BoardRipper: the full frontend as a client-only
static site with no Go backend. Hosted first at
`https://www.ripperdoc.de/boardripper/web/`, later mirrored to a `*.web.app`
root.

---

## 1. Overview & positioning

The lite build is **not a demo**. It is BoardRipper, light: the complete
frontend, built with the backend disabled and served as static files — the real
viewer/inspector that people use with their own boardview files and PDFs,
running entirely in the browser.

Same UI, same home page, same keyboard shortcuts, same rendering. The only
thing missing is the *server-backed* layer: the shared library, board reference
database, OpenBoardData readings, backend PDF full-text index, library sync,
self-update, and MCP server. None of those are meaningful for a personal,
single-user, client-only tool, so their absence is by design rather than a
degradation of the core experience.

**It is just a build type.** The renderer and interface are 100% shared with
mainline BoardRipper — no forked components, no parallel tree — so every future
rendering/UI improvement flows into the lite build automatically. A new
backend-coupled feature costs exactly one `isLiteBuild()` guard at its
registration point.

### Why this is low-risk

The architecture already separates "render a board" from "the server":

- **All parsing/rendering is client-side.** `store/board-store.ts` makes zero
  `/api/*` calls; `boardStore.loadFiles(files: File[])` runs the TypeScript
  parsers in-browser on raw `File` objects.
- **Drag-drop already uploads nothing.** `App.tsx` `handleDrop` →
  `boardStore.loadFiles` / `openPdfFiles` straight from the dropped `File`.
- **A no-backend mode already ships.** `hasBackend()`
  (`store/databank-store.ts`) gates backend features throughout, and the
  Electron desktop app already runs this exact frontend with
  `hasBackend() === false` in its default (MCP-off) configuration.
- **Failures already fail soft.** `apiFetch` swallows any `/api/*` miss and
  returns `null`, so nothing white-screens even today.

Consequence: the work is **mostly subtractive** (hiding UI and skipping dead
network calls), plus a small amount of additive build/deploy plumbing.

---

## 2. Goals & non-goals

### Goals
1. A single static bundle that runs the full BoardRipper viewer/inspector with
   no backend and no network dependency at runtime.
2. Portability: the **same** bundle works both at a sub-path
   (`/boardripper/web/`) and at a domain root (`*.web.app`) with no rebuild.
3. Installable + offline (PWA) so it is a genuine standalone bench tool.
4. Zero risk to the existing NAS (web) and Electron builds — they must be
   behaviorally unaffected (the lite flag is false there and its branches are
   inert).
5. First-run experience is the **normal BoardRipper home page** — with
   backend-only widgets hidden. No bespoke landing screen.

### Non-goals
- Reimplementing any server feature client-side (library search, board DB, OBD,
  PDF full-text search, sync, self-update, MCP). These are removed, not ported.
- A bundled sample board (BYO-file is the baseline; a cleared sample can be
  added later without touching the build).
- Multi-user, cloud, or persistence-beyond-the-browser features.

---

## 3. Approved decisions

| Decision | Choice |
|---|---|
| Positioning | **Lite build, not demo** — full BoardRipper minus the server layer; "just a build type". |
| Build strategy | **Separate lite build** — one codebase, one mode flag; not a fork, not a runtime probe. |
| Scope | **Pure local viewer** — strip all server-backed features, keep the full viewer/inspector (incl. local worklist). |
| First-run | **Same home page as always**, with backend-only widgets gated out. |
| Base path | **Relative** (`base: './'`) so one bundle is host-portable. |
| PWA / offline | **Included now** — service worker + installable manifest. |
| Bundled sample | **None for now** — BYO file; optional cleared sample deferred. |

---

## 4. Architecture

### 4.1 Build type = Vite mode

The lite build is `--mode lite` — the mode **is** the build type; no env file
needed:

- `"build:lite": "tsc -b && vite build --mode lite"` → emits `dist-lite/`
  (never collides with `dist/`, which the Go server embeds).
- `vite.config.ts` becomes a function of `{ mode }`: `const lite = mode ===
  'lite'` drives `base: './'`, `outDir: 'dist-lite'`, and the PWA plugin.
- `npm run build` (NAS) and the Electron build pass mode `production` as
  always and are untouched.

### 4.2 One central flag: `isLiteBuild()` (not `hasBackend()`)

The build type is exposed to app code by **one flag** in a new zero-dependency
module `src/store/build-mode.ts`:

```ts
/** True only in the lite (standalone, backend-free) web build. */
export function isLiteBuild(): boolean {
  return import.meta.env.MODE === 'lite';
}
```

`import.meta.env.MODE` is statically replaced by Vite at build time, so in the
NAS/Electron builds every `isLiteBuild()` branch is inert (and typically
dead-code-eliminated).

**Two distinct gates — do not conflate them:**

- **`isLiteBuild()`** gates everything *lite-specific*: hiding backend UI and
  no-oping backend network. This is the correct gate because it is true **only**
  in the lite web build.
- **`hasBackend()`** keeps its existing meaning ("is an HTTP backend
  reachable"). It gets a single short-circuit so HTTP-backend-gated paths also
  no-op in the lite build:

  ```ts
  export function hasBackend(): boolean {
    if (isLiteBuild()) return false;                 // lite web build
    return !isElectron() || (typeof location !== 'undefined' && location.protocol !== 'file:');
  }
  ```

**Why UI must NOT gate on `hasBackend()` (bug avoided):** on the normal desktop
app (Electron, MCP sidecar off) `hasBackend()` is *also* `false`, yet the
Library / databank / board-DB features work there via Electron **IPC**
(`initElectron`). Gating their visibility on `!hasBackend()` would wrongly hide
them on desktop. `isLiteBuild()` is false on desktop, so it hides those surfaces
**only** in the lite web build. This is the single most important correctness
point in the plan.

**Databank boot short-circuit.** Rather than trust each of databank-store's
~14 `hasBackend()` sub-guards, add one early-return at the top of
`_runStartupLoad()`:

```ts
if (isLiteBuild()) { this._loadStatus = 'loaded'; this.notify(); return; }
```

so the entire startup load chain (config, stats, files, donors, scan-status,
pdf-index-stats) is skipped centrally in the lite build.

### 4.3 Relative base path (host portability)

Under lite mode, Vite `base: './'` makes every emitted asset reference
relative, so the built folder runs unmodified at:

- `https://www.ripperdoc.de/boardripper/web/` (sub-path), and
- `https://<name>.web.app/` (root) — the later mirror,

with no per-host rebuild. Review findings (2026-07-21) on the known
absolute-path candidates:

- `index.html` `href="/logo.svg"` — the one real offender; changed to
  `./logo.svg` (harmless on NAS).
- pdf.js worker — resolved via `new URL('pdfjs-dist/build/pdf.worker.mjs',
  import.meta.url)` in `pdf-store.ts`, which Vite rewrites per-base. Safe.
- Dockview popout — `App.tsx` passes `popoutUrl="popout.html"` (already
  relative). Safe under a sub-path.
- No `url(/...)` references in `index.css`; no other `/`-rooted public-dir
  references in `src/`.

Sub-path serving is **CI-covered, not just hand-checked**: the lite E2E runs
its whole spec twice — once against the dev server at root, once against the
**built bundle served under `/boardripper/web/`** by a dependency-free static
server (`scripts/serve-lite.mjs`), with a zero-failed-requests assertion (§10).

### 4.4 PWA / offline

- `vite-plugin-pwa` (Workbox), included in the plugin list **only when
  `mode === 'lite'`** — the NAS/Electron builds never see it.
- **Manifest:** name "BoardRipper", standalone display, relative `start_url`/
  `scope` (`'.'`) so the installed app works at any mount point; icon from the
  existing `logo.svg`.
- **Service worker (precache):** the built JS/**MJS**/CSS/wasm/font assets so
  the app shell — including the pdf.js worker (`pdf.worker.mjs`), which PDF
  viewing needs — loads fully offline after first visit. Runtime board/PDF
  files are user-supplied `File` objects, never fetched, so they need no
  caching strategy.
- **No `/api/*` runtime caching** — there is no backend to cache.
- `registerType: 'autoUpdate'` so a redeploy is picked up on next load (SW
  staleness defence).

### 4.5 Client-side persistence (already works, no change)

These already run with no backend and give the lite app real session
continuity:

- IndexedDB board cache (`boardripper-cache`, keyed
  `fileName:fileSize:lastModified`) — re-opening a cached board is instant.
- `localStorage` — theme/accent/chrome knobs, render settings, overlay layout,
  welcome-done flag, session restore.

`WelcomeSetup` needs **no gating**: review confirmed it is a pure input-gesture
calibration wizard (wheel/drag classification → renderSettings + localStorage),
with no library or backend coupling.

---

## 5. Feature matrix

| Kept (100% client-side) | Removed / hidden (server-only) |
|---|---|
| All 11 format parsers + PixiJS rendering | Library panel + databank search |
| PDF local open/drag-drop, viewing, rotate/mirror/page-modes | Database Editor panel |
| Selection, highlight, butterfly, spotlight, overlay | OBD readings (auto-fetch on board open) |
| Worklist (local, clipboard-driven) | Worklist AI-relay section (MCP-backed) |
| Themes, settings, keyboard shortcuts, welcome wizard | PDF full-text search (backend FTS) |
| IndexedDB board cache, localStorage session/settings | Self-update badge + drop-to-update |
| Apple board metadata (bundled `apple-boards.ts` table) | MCP server/bridge |
| FZ key dialog (fetch-from-mirror links + paste-back) | Library sync · incoming-file upload |

---

## 6. Gating work (file-by-file)

Beyond the central databank short-circuit (§4.2), the files below fire `/api/*`
or render backend UI. Each gets **one `isLiteBuild()` guard** — at the
feature-registration point, not scattered — so it hides/no-ops in the lite
build while staying behaviorally identical on NAS/Electron. `apiFetch` already
fails soft, so this is about a clean UX (no dead panels, no
spinners-to-nowhere, no console noise), not crash prevention. Exact per-file
code lives in the implementation plan
(`docs/plans/2026-07-20-boardripper-web-standalone-plan.md`). The guard sites,
grouped:

**Boot-time auto-fires (module-level side-effects — highest priority; these
poll forever):** `update-store.ts` (`/api/update/*` on load + every 30 min),
`librarysync-store.ts` (`/api/sync/*` on load + every 30 s), and
`mcp-bridge.ts` `startMcpBridgeIfEnabled()` (`/api/mcp/status`, called from
`main.tsx`).

**Recurring while UI is open (found in the 2026-07-21 review):**
`panels/WorklistPanel.tsx` — `AiWorklistSection` polls `/api/mcp/status` every
5 s whenever a worklist is open. Gate at the call site
(`{!isLiteBuild() && <AiWorklistSection …/>}`) so the poll never starts; the
local worklist itself stays fully functional.

**Call-driven fires (on board/PDF open or drop):** `obd-store.ts` — all six
fetchers (`loadMatches`/`fetchBoard`/`syncIndex` plus, belt-and-suspenders,
`loadCachedData`/`refreshStatus`/`clearCache`); `pdf/pdf-index-client.ts`
(`ensureIndexed`); `incoming-upload.ts` (`saveDroppedToIncoming` — today gated
`if (isElectron())`; extend to `if (isElectron() || isLiteBuild())`); and
`App.tsx` `handleDrop`'s **update-bundle / Docker-tarball branches** (also
found in review — dropping `latest-update.tar` on the lite build would confirm
and `POST /api/update/apply-bundle`; gated so such files fall through to the
normal "unsupported file" toast).

**UI surfaces:** the sidebar `TABS` registry (filter out `library`; default
tab → `settings`; `showSidebarTab`/`toggleLibrarySidebar` degrade — the
keyboard shortcut is the only other caller and degrades with them),
`Sidebar.tsx` (don't mount `LibraryPanel` at all), `Toolbar.tsx` update badge
(`!isElectron()` → `!isElectron() && !isLiteBuild()`), `HomeBackdrop.tsx`
("Library" quick-section + auto-open-PDF toggle), and `SettingsPanel.tsx`
`TAB_ORDER` (drop the `library` + `integrations` tabs — this transitively
hides Scanning & Indexing, Database info, the "Open Database Editor" button,
Library Sync, and MCP settings) plus the `SoftwareUpdateSection` on the
`system` tab.

Transitively hidden / self-healing (no direct edit needed — verified in
review): `components/UpdateProgressOverlay.tsx` (only shown during a
self-update, which never starts once update-store is gated); the
`DatabaseEditorPanel` Dockview panel (its only launcher is the hidden Settings
button — verified sole call site); the cross-file PDF full-text search UI (its
index is never populated); the settings **search** (both `TabPill` and
`SearchEmptyState` derive from `TAB_ORDER`, so hidden tabs neither render
badges nor get suggested); `WelcomeSetup` (fully local, §4.5); Dockview
popouts (`popout.html` already relative).

The endpoint names above reflect the code as of this spec: library sync is
`/api/sync/*` (not `/api/librarysync/*`), and `incoming-upload` currently gates
on `isElectron()` (extended, not replaced).

---

## 7. First-run / empty state

The normal `HomeBackdrop` home page renders unchanged except that its
backend-only pieces (the "Library" stats section and the auto-open-bound-PDFs
toggle) are gated out. The open-a-file / drag-here empty-state and the
supported-format list stay. `WelcomeSetup` shows as normal — it is fully local
(§4.5). No bespoke landing screen is introduced.

---

## 8. Deploy

- `npm run build:lite` → `dist-lite/`.
- Deployed by the **RipperDocWeb** rsync, the same mechanism that ships
  `landing/` — no involvement from this repo's build pipeline.
- Target 1: `https://www.ripperdoc.de/boardripper/web/`.
- Target 2 (later): `*.web.app` root — a copy of the same folder; the relative
  base makes it portable with no rebuild.
- Local sub-path preview: `npm run serve:lite` (serves `dist-lite/` at
  `http://localhost:18086/boardripper/web/` — the same server the E2E uses).
- **Headers:** serve with **no `Cross-Origin-Embedder-Policy`** or
  `COEP: credentialless` — never `require-corp` — so the FZ-key mirror fetch
  and cross-origin resources keep working. COOP/COEP absence only degrades the
  status-bar precise-memory stat (graceful).

---

## 9. Risks & verification items

1. **Relative-base asset resolution** — reviewed (§4.3): only `index.html`'s
   favicon was absolute; worker/popout/css are safe. Backstopped in CI by the
   dist-under-sub-path E2E project with a zero-failed-requests assertion.
2. **FZ decryption key — no new problem; already client-side.** The FZ (ASUS
   RC6) key is never bundled in any build (DMCA/anti-circumvention; upstream
   OpenBoardView does the same). `FZKeyDialog` already handles it entirely
   client-side and carries into the lite build unchanged: a one-click **Fetch**
   that browser-`fetch()`es public GitHub raw mirrors with fallback
   (`store/fz-key-store.ts` `fetchAndApply`), **clickable mirror links** to
   follow manually, and a **paste-back** textarea gated by the 44-word parity
   validator → `localStorage`. The `VITE_FZ_KEY` env "auto-load" is a
   maintainer dev-fixture convenience only (gitignored `.env.local`,
   tree-shaken from every production build) — not user-facing, so nothing is
   lost. Deliberately keep retrieval **user-initiated** (no silent auto-fetch
   on FZ open) to preserve the "user's decision, not BoardRipper's" legal
   posture. Offline (PWA): paste works; Fetch needs a network and fails
   gracefully. (BRD/XZZ/other encrypted formats embed their keys in the client
   parser and are unaffected.) **Deploy dependency:** the COEP requirement in
   §8.
3. **Service worker staleness** — `registerType: 'autoUpdate'` picks up a
   redeploy on next load.
4. **Console/network hygiene** — the E2E asserts **zero** `/api/*` requests on
   cold load AND after opening a board through the real file-input path.
5. **NAS/Electron isolation** — `MODE === 'lite'` is never true there; the PWA
   plugin is excluded at config level; Task-level checks confirm `dist/` has
   no SW/manifest artifacts.
6. **Residual manual checks** (headless CI cannot drive WebGL): board/PDF
   actually *render*, FZ dialog flow, offline reload after install — covered
   by the bench checklist in `src/frontend/LITE_BUILD.md`.

---

## 10. Testing

`npm run test:lite` (dedicated `playwright.lite.config.ts`) runs one spec
(`tests/web-lite.spec.ts`) against **two projects**:

- **lite-dev** — `vite --mode lite` dev server at root;
- **lite-dist-subpath** — `npm run build:lite` output served at
  `http://localhost:18086/boardripper/web/` by `scripts/serve-lite.mjs`, so the
  relative base is exercised exactly as production will mount it. Tests
  navigate with `page.goto('.')` (never `'/'`, which would escape the
  sub-path).

Assertions:

- **Zero `/api/*` requests** on cold load (after settle) — and **zero failed
  (≥400) responses**, which catches any `/`-rooted asset miss under the
  sub-path.
- **Board opens locally, still silent:** the tracked synthetic fixture
  `public/samples/test-board.bvr` is uploaded through the real
  `file-input` — renamed on the fly to `820-00281.bvr` so the OBD board-open
  path would fire if it were ungated — status bar shows parts, and the `/api`
  log stays empty.
- **Backend UI absent:** no update badge, no Library sidebar tab, no
  Library/Integrations settings tabs.
- **PWA manifest link present.**
- Board/PDF **pixel rendering** is verified manually (headless CI has no
  WebGL) — bench checklist in `LITE_BUILD.md`.

---

## 11. Out of scope / future

- Cleared bundled sample board (+ schematic PDF) for a one-click first
  impression — additive, no build change.
- Any client-side re-port of library search / board DB / OBD / PDF FTS.
- `web.app` domain registration/DNS and its host configuration.
