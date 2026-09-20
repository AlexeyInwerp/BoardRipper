# BoardRipper Web — lite build (backend-free)

The full BoardRipper viewer/inspector as a static site — local file open /
drag-drop only, no server. Not a demo: same renderer, same interface, same
shortcuts as mainline; it tracks the app automatically because nothing is
forked. **Live: https://www.ripperdoc.de/boardripper/web/** — later mirrorable
to a `*.web.app` root (relative base makes the bundle host-portable).

## Build

    cd src/frontend
    npm run build:lite        # → dist-lite/ (relative base, PWA, no backend UI)

`dist-lite/` is self-contained and host-portable (relative base) — deploy the
folder as-is at any mount point via the RipperDocWeb rsync, same as `landing/`.

## Offline single-file build (`--mode offline`)

    npm run build:offline     # → dist-offline/boardripper-lite.html (ONE ~7 MB file)

The same app packaged as **one self-contained HTML** that opens straight from
`file://` — save it, double-click, no server. `vite-plugin-singlefile` inlines
JS+CSS and `inlineDynamicImports` folds in the pdf.js worker;
`scripts/pack-offline.mjs` inlines the favicon and drops the stray parse-worker
chunk. Both workers fall back to the main thread on `file://` (the parse worker
is skipped via `isOfflineBuild()`; pdf.js uses its existing `location.protocol
=== 'file:'` main-thread path). No service worker / PWA (can't register on
`file://`).

The hosted lite build's toolbar **"Offline copy"** button (top-right, where the
update badge sits on the Docker build) links to `./boardripper-lite.html`, which
`deploy:lite` uploads next to the web app. E2E: `npm run test:offline` opens the
built file from `file://` and asserts zero external loads + a rendered board.
Trade-off vs. the hosted build: main-thread board parse (fine — board files are
small), and Dockview pop-out windows don't work from a single file.

## The library: a folder on this machine

The lite and offline builds have no server, so their library is a folder the
browser is pointed at — `src/store/folder-library.ts`, a third producer for
`databankStore._files` next to the Go backend and Electron IPC. Everything
downstream (Library panel, Board#/Folders trees, open-by-id, the IndexedDB
board cache) is source-agnostic and reused unchanged.

Two APIs, feature-detected by `folderPickMode()`:

| | Chromium | everything else |
|---|---|---|
| picker | `showDirectoryPicker()` | `<input type="file" webkitdirectory>` |
| after a reload | handle comes back from IndexedDB, permission usually intact | `File` objects cannot be revived |
| reads | fresh from disk on every open | the `File` handed over at pick time |
| rescan | yes, same folder | re-pick |

Firefox, Safari, **iOS Safari 18.4+** and `file://` are all on the input path.
It is also the fallback when the picker exists but the context is not allowed
to use it (a `file://` page): `pickDirectory` throws on a refusal and returns
null only on the user's own cancel, so the UI can tell them apart.

**The index is persisted separately from the bytes.** Both modes store the
scanned `DatabankFile[]` + folder tree in IndexedDB
(`boardripper-folder-library`), so the library lists on the next visit either
way. In input mode it comes back `detached` — browsable and searchable, and
opening a file asks for the folder again. That is what makes it usable on a
tablet, where the page is discarded from memory constantly.

Two rules worth keeping:

- **File ids are a hash of the relative path**, not the position in the walk.
  Recent files, worklists and session restore all persist ids; one file added
  at the front must not renumber everything behind it.
- **Scanning does not parse boards** — extension sniff plus the filename board
  number, same as the Electron producer. Board# grouping then happens
  client-side through `apple-boards.ts`, which the build already carries.

Not ported (and not planned here): the board reference DB, PDF full-text
search, OBD, dedup, sync. UI entry points: the Library tab (empty state →
**Choose a folder**, chip above the status bar for rescan/change/forget) and
the home page's open card.

## Local preview / test

    npm run serve:lite        # dist-lite/ at http://localhost:18086/boardripper/web/
    npm run preview:lite      # dist-lite/ at the root path
    npx vite --mode lite      # dev server in lite mode
    npm run test:lite         # E2E gate: zero /api, sub-path dist project, UI absence

## Deploy to ripperdoc.de/boardripper/web

    cd src/frontend
    npm run deploy:lite       # build + upload only the /boardripper/web/ subtree

`scripts/deploy-lite.sh` builds `dist-lite/`, stages it with the app-scoped
`deploy/boardripper-web.htaccess`, and `lftp`-uploads (mirror --reverse
--delete) ONLY `/public_html/boardripper/web/` — additive, nothing else on the
site is touched. FTP creds are read from the sibling `RipperDocWeb/deploy.sh`
(override with `RIPPERDOCWEB=…` or `FTP_USER/FTP_PASSWORD/FTP_ADDRESS`).

This is independent of RipperDocWeb's own `deploy.sh` (which rebuilds Hugo +
the landing page). `deploy.sh` never `--delete`s the remote, so it won't wipe
`web/`; re-run `npm run deploy:lite` to push a new lite build.

## Host requirement (learned from the live LiteSpeed host)

ripperdoc.de runs LiteSpeed with a strict site-wide CSP + `nosniff`. The
app-scoped `deploy/boardripper-web.htaccess` (uploaded by `deploy:lite`) is
**required** — without it the app breaks three ways, all confirmed live:

1. **`.mjs` MIME** — the pdf.js worker is `.mjs`; under `nosniff` it must be
   served as a JS type. LiteSpeed/Apache don't map `.mjs` by default →
   `AddType text/javascript .mjs`.
2. **PixiJS `unsafe-eval`** — the renderer throws "Current environment does not
   allow unsafe-eval" unless `script-src` includes `'unsafe-eval'`.
   (Alternative hardening, not yet done: import `pixi.js/unsafe-eval` and drop
   the CSP allowance.)
3. **Workers / wasm / FZ fetch** — need `worker-src 'self' blob:`,
   `'wasm-unsafe-eval'`, and `connect-src … https://raw.githubusercontent.com`
   (FZ-key mirror). The site's `connect-src 'self'` otherwise blocks the FZ
   "Fetch" button (paste-back still works).

Also serve with NO `Cross-Origin-Embedder-Policy`, or `COEP: credentialless` —
never `require-corp` (would block the FZ mirror fetch). ripperdoc.de sets no
COEP, so that's already fine; the only cost is the status-bar precise-memory
stat is unavailable (graceful).

## Manual bench checklist (WebGL — headless CI cannot cover these)

Verified live 2026-07-21: home page + board render (WebGL, 120 fps), zero
console errors. Still worth a human pass for:

1. Open a PDF — renders; rotate/mirror work.
2. FZ file → key dialog appears; mirror **Fetch** + paste-back work.
3. Install as PWA, go offline, reload — app shell + PDF viewing still work.

## Definition of the build type

One flag: `store/build-mode.ts` `isLiteBuild()` — true only under
`--mode lite`. A new backend-coupled feature needs exactly one `isLiteBuild()`
guard at its registration point. Never gate lite UI on `hasBackend()`: that is
also false on desktop (Electron, MCP off), where library features work via IPC.
