# BoardRipper Web (Standalone, Backend-Free) — Design

**Date:** 2026-07-20
**Status:** Design — approved decisions captured; pending user spec review
**Topic:** A fully-usable, client-only build of the BoardRipper frontend with no Go
backend. Hosted first at `https://www.ripperdoc.de/boardripper/web/`, later
mirrored to a `*.web.app` root.

---

## 1. Overview & positioning

BoardRipper Web is **the complete BoardRipper frontend, built with the backend
disabled and served as static files**. It is not a marketing teaser or a
locked-down sample viewer — it is the real viewer/inspector that people use with
their own boardview files and PDFs, running entirely in the browser.

Same UI, same home page, same keyboard shortcuts, same rendering. The only thing
missing is the *server-backed* layer: the shared library, board reference
database, OpenBoardData readings, backend PDF full-text index, library sync,
self-update, and MCP server. None of those are meaningful for a personal,
single-user, client-only tool, so their absence is by design rather than a
degradation of the core experience.

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
   byte-for-byte unaffected when the demo flag is off.
5. First-run experience is the **normal BoardRipper home page**, not a bespoke
   demo screen — with backend-only widgets hidden.

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
| Build strategy | **Separate demo build** — one codebase, a build flag; not a fork, not a runtime probe. |
| Scope | **Pure local viewer** — strip all server-backed features, keep the full viewer/inspector. |
| First-run | **Same home page as always**, with backend-only widgets gated out. |
| Base path | **Relative** (`base: './'`) so one bundle is host-portable. |
| PWA / offline | **Included now** — service worker + installable manifest. |
| Bundled sample | **None for now** — BYO file; optional cleared sample deferred. |

---

## 4. Architecture

### 4.1 Build flag

- Add a Vite mode / env flag `VITE_DEMO=1`, driven by a new script:
  `"build:demo": "tsc -b && vite build --mode demo --outDir dist-demo"` (with
  `.env.demo` setting `VITE_DEMO=1`), emitting a static bundle in a distinct
  output dir (`dist-demo/`) so it never collides with the NAS build output.
  `--mode demo` loads `.env.demo` → `import.meta.env.VITE_DEMO` is `"1"`
  (truthy) in this build and `undefined` (dead-code-eliminated) in all others.
- The flag is **off by default**; `npm run build` (NAS) and the Electron build
  are untouched.

### 4.2 One central flag: `isDemoBuild()` (not `hasBackend()`)

The build type is defined by **one flag** in a new zero-dependency module
`src/store/build-mode.ts`:

```ts
/** True only in the standalone web build (`vite build --mode demo`). */
export function isDemoBuild(): boolean {
  return !!import.meta.env.VITE_DEMO;
}
```

`VITE_DEMO` is set only by `.env.demo`; in the NAS/Electron builds it is
`undefined`, so Vite statically inlines `false` and every `isDemoBuild()` branch
dead-code-eliminates away — zero risk to those builds.

**Two distinct gates — do not conflate them:**

- **`isDemoBuild()`** gates everything *demo-specific*: hiding backend UI and
  no-oping backend network. This is the correct gate because it is true **only**
  in the web build.
- **`hasBackend()`** keeps its existing meaning ("is an HTTP backend
  reachable"). It gets a single short-circuit so HTTP-backend-gated paths also
  no-op in the demo:

  ```ts
  export function hasBackend(): boolean {
    if (isDemoBuild()) return false;                 // standalone web build
    return !isElectron() || (typeof location !== 'undefined' && location.protocol !== 'file:');
  }
  ```

**Why UI must NOT gate on `hasBackend()` (bug avoided):** on the normal desktop
app (Electron, MCP sidecar off) `hasBackend()` is *also* `false`, yet the
Library / databank / board-DB features work there via Electron **IPC**
(`initElectron`). Gating their visibility on `!hasBackend()` would wrongly hide
them on desktop. `isDemoBuild()` is false on desktop, so it hides those surfaces
**only** in the web build. This is the single most important correctness point
in the plan.

**Databank boot short-circuit.** Rather than trust each of databank-store's
~14 `hasBackend()` sub-guards, add one early-return at the top of
`_runStartupLoad()`:

```ts
if (isDemoBuild()) { this._loadStatus = 'loaded'; this.notify(); return; }
```

so the entire startup load chain (config, stats, files, donors, scan-status,
pdf-index-stats) is skipped centrally in the demo build.

### 4.3 Relative base path (host portability)

Under the demo mode, set Vite `base: './'`. This makes every emitted asset
reference relative, so the built folder runs unmodified at:

- `https://www.ripperdoc.de/boardripper/web/` (sub-path), and
- `https://<name>.web.app/` (root) — the later mirror,

with no per-host rebuild. **Verification required** (see §9): `index.html`
currently references `/logo.svg` and `/src/main.tsx` with leading slashes, and
the pdf.js worker + any `new URL(..., import.meta.url)` / `?url` asset imports
must resolve relative to the document, not the origin root.

### 4.4 PWA / offline

- Use `vite-plugin-pwa` (Workbox under the hood), enabled only in demo mode.
- **Manifest:** name "BoardRipper", standalone display, theme/background colors
  from the default theme, icons derived from the existing `logo.svg`.
- **Service worker (precache):** the built JS/CSS/wasm/worker assets so the app
  shell loads fully offline after first visit. Runtime board/PDF files are
  user-supplied `File` objects — never fetched — so they need no caching
  strategy.
- **No `/api/*` runtime caching** — there is no backend to cache.
- Registration is gated so it never activates in the NAS/Electron builds.

### 4.5 Client-side persistence (already works, no change)

These already run with no backend and give the standalone app real
session continuity:

- IndexedDB board cache (`boardripper-cache`, keyed
  `fileName:fileSize:lastModified`) — re-opening a cached board is instant.
- `localStorage` — theme/accent/chrome knobs, render settings, overlay layout,
  welcome-done flag, recent items, session restore.

---

## 5. Feature matrix

| Kept (100% client-side) | Removed / hidden (server-only) |
|---|---|
| All 11 format parsers + PixiJS rendering | Library panel + databank search |
| PDF local open/drag-drop, viewing, rotate/mirror/page-modes | Database Editor panel |
| Selection, highlight, butterfly, spotlight, overlay | OBD readings (auto-fetch on board open) |
| Worklist (local clipboard-driven; AI/MCP writes disabled) | PDF full-text search (backend FTS) |
| Themes, settings, keyboard shortcuts | Self-update badge + drop-to-update |
| IndexedDB board cache, localStorage session/settings | MCP server/bridge |
| Apple board metadata (bundled `apple-boards.ts` table) | Library sync |
| FZ key dialog (user-provided key) | Incoming-file upload |

---

## 6. Gating work (file-by-file)

Beyond the central databank short-circuit (§4.2), a handful of files fire
`/api/*` or render backend UI. Each gets **one `isDemoBuild()` guard** — at the
feature-registration point, not scattered — so it hides/no-ops in the web build
while staying byte-identical on NAS/Electron. `apiFetch` already fails soft, so
this is about a clean UX (no dead panels, no spinners-to-nowhere, no console
noise), not crash prevention. Exact per-file code lives in the implementation
plan (`docs/plans/2026-07-20-boardripper-web-standalone-plan.md`). The guard
sites, grouped:

**Boot-time auto-fires (module-level side-effects — highest priority; these
poll forever):** `update-store.ts` (`/api/update/*` on load + every 30 min),
`librarysync-store.ts` (`/api/sync/*` on load + every 30 s), and
`mcp-bridge.ts` `startMcpBridgeIfEnabled()` (`/api/mcp/status`, called from
`main.tsx`). Guard each with `isDemoBuild()`.

**Call-driven fires (on board/PDF open or drop):** `obd-store.ts`
(`loadMatches`/`fetchBoard`/`syncIndex`), `pdf/pdf-index-client.ts`
(`ensureIndexed`), `incoming-upload.ts` (`saveDroppedToIncoming` — today gated
`if (isElectron())`; extend to `if (isElectron() || isDemoBuild())`).

**UI surfaces:** the sidebar `TABS` registry (filter out `library`),
`Toolbar.tsx` update badge (`!isElectron()` → `!isElectron() && !isDemoBuild()`),
`HomeBackdrop.tsx` "Library" quick-section, and the SettingsPanel tabs/sections
that expose backend features (Library, Software update, Integrations/MCP, and
the "Open Database Editor" button — which transitively hides the panel launch).
All keyed on `isDemoBuild()`.

Transitively hidden (no direct edit needed): `components/UpdateProgressOverlay.tsx`
(only shown during a self-update, which never starts once update-store is
gated); the `DatabaseEditorPanel` Dockview panel (its only launcher is the
Settings button that gets hidden); the cross-file PDF full-text search UI (its
index is never populated). The **local** worklist stays — it is clipboard-driven
and client-side; its MCP/AI-mode writes are already gated on `mcp_drive_ui`,
which is unreachable with no backend config.

The endpoint names above reflect the code as of this spec: library sync is
`/api/sync/*` (not `/api/librarysync/*`), and `incoming-upload` currently gates
on `isElectron()` (extended, not replaced).

---

## 7. First-run / empty state

The normal `HomeBackdrop` home page renders unchanged except that its
backend-only cards (library stats, auto-PDF toggle, database info) are gated
out. The open-a-file / drag-here empty-state and the supported-format list stay.
`WelcomeSetup` (once-per-install, localStorage-gated) can show but its
library-setup step is hidden/skipped when `!hasBackend()`. No bespoke demo
screen is introduced.

---

## 8. Deploy

- `npm run build:demo` → `dist-demo/`.
- Deployed by the **RipperDocWeb** rsync, the same mechanism that ships
  `landing/` — no involvement from this repo's build pipeline.
- Target 1: `https://www.ripperdoc.de/boardripper/web/`.
- Target 2 (later): `*.web.app` root — a copy of the same folder; the relative
  base makes it portable with no rebuild.
- **Headers:** the app sets COOP/COEP on the dev server + Go backend to unlock
  precise memory measurement. A static host may not; absence degrades only the
  status-bar memory stat (graceful). If offered, RipperDocWeb / the web.app host
  can add COOP:same-origin + COEP:credentialless to restore it.

---

## 9. Risks & verification items

1. **Relative-base asset resolution** — verify the built bundle loads with no
   `/`-rooted asset misses at a sub-path: `index.html` (`/logo.svg`), the pdf.js
   worker URL (`pdf-store.ts` points at the unminified `pdf.worker.mjs`), and
   any `new URL(..., import.meta.url)` / `?url` / public-dir references. Test by
   serving `dist-demo/` under a `/boardripper/web/` prefix locally.
2. **FZ decryption key — no new problem; already client-side.** The FZ (ASUS
   RC6) key is never bundled in any build (DMCA/anti-circumvention; upstream
   OpenBoardView does the same). `FZKeyDialog` already handles it entirely
   client-side and carries into the standalone build unchanged: a one-click
   **Fetch** that browser-`fetch()`es public GitHub raw mirrors with fallback
   (`store/fz-key-store.ts` `fetchAndApply`), **clickable mirror links** to
   follow manually, and a **paste-back** textarea gated by the 44-word parity
   validator → `localStorage`. The `VITE_FZ_KEY` env "auto-load" is a maintainer
   dev-fixture convenience only (gitignored `.env.local`, tree-shaken from every
   production build) — not user-facing, so nothing is lost. Deliberately keep
   retrieval **user-initiated** (no silent auto-fetch on FZ open) to preserve
   the "user's decision, not BoardRipper's" legal posture. Offline (PWA): paste
   works; Fetch needs a network and fails gracefully. (BRD/XZZ/other encrypted
   formats embed their keys in the client parser and are unaffected.)
   **Deploy dependency:** the Fetch button is a cross-origin request, so the
   static host must serve **no COEP** or **`COEP: credentialless`** (never
   `require-corp`) — same requirement that keeps cross-origin OBD images working
   — see §8 headers.
3. **Service worker staleness** — a precache SW can serve an old app shell after
   a redeploy. Use Workbox auto-update (skipWaiting + clientsClaim or a prompt)
   so a new deploy is picked up on next load.
4. **Console/network hygiene** — after gating, confirm a cold load fires **zero**
   `/api/*` requests (network tab / Playwright request assertion).
5. **Dead-code elimination** — confirm the demo `VITE_DEMO` branch does not leak
   into NAS/Electron output and vice-versa (the NAS build must still reach a
   real backend).

---

## 10. Testing

A Playwright spec run against the demo build (`VITE_DEMO=1`, served statically)
asserting:

- **No `/api/*` requests** fire on cold load or on opening a board/PDF.
- Backend UI is absent: no Library tab, no Database Editor entry, no update
  badge, no OBD sections, no cross-file PDF search.
- A board file opens from a local `File` object and renders (part/pin geometry
  present) — reuse existing headless caveats (SwiftShader for WebGL).
- A PDF opens from a local `File` and renders a page.
- The PWA manifest + service worker register (installability check).

---

## 11. Out of scope / future

- Cleared bundled sample board (+ schematic PDF) for a one-click first
  impression — additive, no build change.
- Any client-side re-port of library search / board DB / OBD / PDF FTS.
- `web.app` domain registration/DNS and its host configuration.
