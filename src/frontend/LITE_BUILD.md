# BoardRipper Web — lite build (backend-free)

The full BoardRipper viewer/inspector as a static site — local file open /
drag-drop only, no server. Not a demo: same renderer, same interface, same
shortcuts as mainline; it tracks the app automatically because nothing is
forked. Hosted at `ripperdoc.de/boardripper/web`, later mirrored to a
`*.web.app` root.

## Build

    cd src/frontend
    npm run build:lite        # → dist-lite/ (relative base, PWA, no backend UI)

`dist-lite/` is self-contained and host-portable (relative base) — deploy the
folder as-is at any mount point via the RipperDocWeb rsync, same as `landing/`.

## Local preview / test

    npm run serve:lite        # dist-lite/ at http://localhost:18086/boardripper/web/
    npm run preview:lite      # dist-lite/ at the root path
    npx vite --mode lite      # dev server in lite mode
    npm run test:lite         # E2E gate: zero /api, sub-path dist project, UI absence

## Manual bench checklist (WebGL — headless CI cannot cover these)

1. Open a board (drag-drop + toolbar open) — renders, selection works.
2. Open a PDF — renders; rotate/mirror work.
3. FZ file → key dialog appears; mirror links + paste-back work.
4. Install as PWA, go offline, reload — app shell + PDF viewing still work.

## Host requirement

Serve with NO `Cross-Origin-Embedder-Policy` header, or `COEP: credentialless`
— never `require-corp`. The FZ-key "Fetch" button and cross-origin OBD images
are browser `fetch()`es to third-party origins that `require-corp` would block.

## Definition of the build type

One flag: `store/build-mode.ts` `isLiteBuild()` — true only under
`--mode lite`. A new backend-coupled feature needs exactly one `isLiteBuild()`
guard at its registration point. Never gate lite UI on `hasBackend()`: that is
also false on desktop (Electron, MCP off), where library features work via IPC.
