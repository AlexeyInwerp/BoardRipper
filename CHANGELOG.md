# BoardRipper changelog

## v0.20.4 — 2026-05-10

### Fixed

- **Library files served from cloud-sync placeholders no longer reach the parser as truncated bytes.** When the user's library mount lives on a cloud-managed filesystem (Google Drive on macOS via File Provider, OneDrive on Windows via NTFS reparse points, iCloud, Dropbox Smart Sync), the OS lazily materializes content on read. `http.ServeFile` was happy to stream whatever the kernel returned — sometimes a partial file or zero bytes — and the frontend parser would fail with "empty/truncated file." The two cloud-exposed file-serve handlers (`files.Get`, `files.GetByPath`) now route through a new `serveFileEager` (`src/backend/handlers/serve.go`) that reads the file fully into memory and verifies byte count matches `stat().Size()` before responding. Truncated reads return 503 + `Retry-After: 5`; the 30s read deadline returns 503 + `Retry-After: 10`. Frontend `fetchWithCloudRetry` retries up to 6 attempts / 3 min, surfaces a "Downloading from cloud storage…" toast on retry, and surfaces an error toast on exhaustion. `databank.PreviewGet` deliberately keeps `http.ServeFile` — previews live in the always-local `<dataDir>/.previews/` and benefit from `ServeFile`'s ETag/304 caching there.

- **Docker-bound cloud placeholders surface a clear "materialize on host first" error** instead of a generic 500. When BoardRipper runs in a Docker container on macOS with a Google Drive folder bind-mounted as the library, the FUSE bridge can't drive host-side materialization and reads return `EDEADLK` (resource deadlock avoided). `serveFileEager` now detects this specific error and returns 503 with a body that tells the user how to fix it: "Cloud-storage placeholder: file not yet materialized on host. Open it on the host (Finder → right-click → 'Keep on this device' for Google Drive/iCloud, equivalent for OneDrive) or sync your library to a fully-local directory." Native macOS reads of the same placeholder block 1–2 seconds for materialization and succeed normally — `EDEADLK` only fires inside the container, so the friendly error is scoped to the case where it's actually useful.

### Trade-offs

- Range-request and `ETag`/`If-Modified-Since` caching are dropped on the two affected handlers. No current consumer relied on either (boardview parsers always read from byte 0; PDF.js doesn't issue range requests in the current implementation).
- 512 MiB cap on in-memory reads in `serveFileEager`. Boardview files are <10 MB, PDFs <100 MB; the cap is a safety net, not a hot path.

## v0.20.3 — 2026-05-10

### Fixed

- **OpenBoardData index now survives container updates.** OBD cache was rooted at `<libraryDir>/.boardripper/openboarddata/`. The library mount is `:ro` by default in Docker, so atomic writes silently failed and the index was effectively in-memory — gone on every container restart, including the restart triggered by self-update. Users had to re-sync (`POST /api/obd/index/sync`, ~2 min) after every release. Cache now lives at `<dataDir>/obd/`, which is the always-writable persistent volume by design. Existing caches at the legacy path are auto-migrated on first boot via `obd.MigrateLegacyCache`; cross-volume rename failures (typical when `/library` and `/data` are different mounts) fall back to a one-time re-sync. `obdStore` is no longer library-conditional — OBD works on fresh installs that haven't configured a library yet.

- **Library "Browse" tab respects the search filter in live-filesystem mode.** Typing into the filter input had no effect when the user was browsing live (`viewMode === 'folders' && browseMode === 'live'`). The filter wired to the database-backed `FolderView` was silently dropped on the `LiveBrowser` side. `LiveBrowser` now receives `searchFilter` from the same `localSearch` state every other view uses, applies a case-insensitive substring filter to both directories and files in the current directory. A directory whose name matches stays visible so the user can navigate toward something they remember the parent name of. No descent into subdirectories — that stays as future work.

## v0.20.2 — 2026-05-09

### New

- **Right-click context-menu selection header.** A muted, smaller-font line at the very top of the menu shows what Copy / Search will act on: `<component> · pin <pinId> · net <netName>` in board mode, or the cursor word in PDF mode. Hidden when the relevant fields are empty. Removes the "wait, what am I about to copy?" pause that the new icon-strip introduced in v0.20.1.

### Fixed

- **Right-click menu was blocking ~1 s on bound PDFs.** `pdfStore.countTextMatches` walked every line of every page synchronously, called 3× per PDF donor (default query, chip@pin variant, net variant), all before the menu rendered. With one bound PDF that's 3 sync scans gating the open. New `countTextMatchesAsync` yields every 8 pages via `setTimeout(0)`; ContextMenu dispatches the counts in a `useEffect` after first paint and replaces `(…)` placeholders as each promise resolves. AbortController cancels stale work when the menu closes or the selection changes. Board counts (`countInBoardTab`) stay sync — they walk in-memory parsed objects, not text.

### Docs

- **README has a Keyboard Shortcuts section** covering the new game-style shortcuts (WSAD, Q/E, Shift+W/S), the `~` library toggle (with the layout note about Backquote / IntlBackslash and the AZERTY caveat), and the configurable Settings ▸ Navigation knob.

## v0.20.1 — 2026-05-08

### New

- **Game-style keyboard shortcuts** (WSAD pan, Q/E rotate, Shift+W/S zoom, `~` toggles Library sidebar). Pan and zoom work on both board and PDF panels; rotate is board-only and silently no-ops on PDF. Library toggle binds to the physical key left of `1` via `KeyboardEvent.code` ('Backquote' on US, 'IntlBackslash' on German Mac), so `~` on US, `°` on German DE both fire the same toggle. Existing Cmd+arrow / Space / Cmd+F shortcuts unchanged. Auto-rendered in Settings ▸ Shortcuts and the home-screen Getting Started card under a new "WSAD Navigation" section. Pan and zoom step sizes configurable in Settings ▸ Navigation ▸ Keyboard pan / zoom (default: 10% of screen per pan, ×1.32 per zoom press; previous defaults were 15% / ×1.72).

- **Right-click context-menu icon strip.** A new top-of-menu icon row with up to 4 board buttons (Copy net, Copy part, Search net, Search part) or 2 PDF buttons (Copy, Search Web) for the cursor word. Copy uses `navigator.clipboard.writeText` with toast feedback; Search opens Google in a new tab with `noopener,noreferrer`. Strip hides entirely when no entity is selected. The existing donor-row search functionality is unchanged below.

- **Shortcut schema gained `code` (KeyboardEvent.code, single string or array for multi-layout binding), `displayLabel` (formatter override), and `ignoreShift` (matcher accepts shift-held events when set, used by the `~` library toggle so Shift+Backquote fires the same as bare Backquote).** Foundation for the AZERTY remapping work queued in `docs/superpowers/specs/2026-05-08-keyboard-shortcuts-wsad-rotate-zoom-library-design.md`.

### Fixed

- **The keyboard matcher was permissive about un-required modifiers.** `if (!requireShift && e.shiftKey) return false;` was missing — bare `W` would match `Shift+W` events, blocking the new zoom shortcut from registering distinctly. Added the symmetric guard. The `Shift+Cmd/Ctrl+F` "previous match" path (documented in the focusSearch shortcut description) re-enters with `{ ...focusSearch, shift: true }` so the routing block still receives both directions.

- **Pin labels were being painted under the highlight ring**, so the ring's stroke clipped the bottom of pin numerals on selected nets. Renderer now stacks labels above the ring graphics so the typography reads cleanly on top, and the ring stroke pops past the label outline rather than through it. (Reported by the user on a Quanta board where 0402 caps were unreadable on a selected ground net.)

## v0.19.9 — 2026-05-08

### Fixed

- **Self-update was silently broken on Synology DSM Container Manager.** v0.19.7 hardcoded the Engine API path to `/v1.44/` to fix Docker Engine 29.x rejecting `/v1.41/` as "too old"; the same hardcode now broke Synology DSM (Docker 20.10.3, max API 1.41) which rejects `/v1.44/` as `client version 1.44 is too new. Maximum supported API version is 1.41`. Every code path through `docker.sock` — pull, load, inspect, orchestrate — hit the same 400. Bundle-drop also affected (shares `dockerLoad`). User-reported on the maintainer's NAS, manual SSH swap was the only escape until this release. Fix: probe `GET /_ping` once on first use, parse the daemon's `Api-Version` header, and prefix every Engine API call with that. `sync.Once`-gated; falls back to `v1.41` if `/_ping` itself fails (in which case nothing else would work either, but no panic at first use). Replaces all 13 hardcoded `http://docker/v1.44/...` strings; the orchestrator shell script's `API=` line gets the same value via `Sprintf` so the alpine-curl payload speaks the same dialect. Forward-compatible to whatever Docker bumps the floor to next.

## v0.19.8 — 2026-05-08

### Fixed

- **Net highlights resolved to wrong parts on any file with ≥1 BOM-alternate cluster.** `buildRenderedBoard`'s filtered branch (BOM-alternate filter / hide-ghosts toggle) returned `nets: rev.nets` from before any parts were dropped. `Net.pinIndices` are positional `partIndex` refs into the array they were built against — after dropping a single part every index past that slot pointed one element off in the filtered array, scrambling every net on the board. Latent since `176cced` (2026-04-14, hide-ghosts toggle, default off — almost no one hit it). Default-on as of `48ce8ae` (2026-05-05): BOM-alternate cluster filtering with `showBomAlternates: false` default means any CAD/TVW file with ≥1 detected cluster drops one part on first render. ROG STRIX RTX 4090 sample (1 cluster, C1903/C1906) was the user-reported canary — clicking PC101 lit PC104 / PC258 / C415 instead of PC265, and 12V_F_R1's 36 refs landed on a completely different 27 parts than the file actually says. Fix: rebuild nets via `buildNets(filteredParts)` whenever any part is dropped. Regression spec asserts every `pinIndex` in every net resolves to a pin actually on that net after filtering.

## v0.19.7 — 2026-05-07

### Fixed

- **Self-update was silently broken on Docker Engine 29.x** (the floor for fresh Docker Desktop installs from January 2026). The in-binary updater hardcoded the Engine API path to `/v1.41/`; Engine 29 rejects that with HTTP 400 (`client version 1.41 is too old. Minimum supported API version is 1.44`). The first call (`findSelfContainer`) parsed the `{"message":...}` error body as a `[]struct` and failed with `cannot unmarshal object into ... []struct`; `tagPrevious` warned and continued, but every later docker.sock call also 400'd and the orchestrator was never created — Apply silently bailed out part-way. Bumped all Engine API URLs to `/v1.44/` (single `dockerAPIVersion` constant; keeps Docker 25+ compatibility — the floor on current Synology DSM Container Manager). `findSelfContainer` now also checks `resp.StatusCode` and surfaces the error body so the next floor bump shows up as `Docker API HTTP 400: ...` instead of an unmarshal error.
- **Apply errors were dropped on the floor by the HTTP handler.** `go h.upd.Apply()` discarded the return value, and several pre-orchestrate failure paths (manifest sha mismatch, `findSelfContainer` failure, etc.) returned without first logging a `status: error` progress entry. The frontend's SSE stream would just go silent and the UI hung on "Updating…" until the 2-minute health-poll timeout. New `Updater.PushError` helper funnels the return value into the SSE channel as a terminal error entry; `ApplyBundle` got the same treatment.
- **`waitForRestart` reloaded the page against the about-to-die backend.** `Apply()` returns the moment the orchestrator container is *launched*, but that orchestrator's first action is `apk add curl` (5–15 s) before it stops the running container. During that window `/api/health` on the OLD container returned 200 happily — the previous loop accepted that as "swap done" and reloaded the page right back into the dying backend. The user then saw a "rolled back" log line and sat on the unchanged UI until the next 30-minute background poll. Now waits for an authoritative `/api/update/status` to report the manifest's expected new version (cookie survives the swap because the per-install secret persists in `/data`); falls back to a downtime-then-up `/api/health` sequence if status auth races. Reload only fires when the swap is real.
- **Slow two-finger trackpad scroll on the PDF panel zoomed instead of paging.** Two related causes: (1) the `wheelDetection` burst-latch in `scroll-mode.ts` was defaulting every new burst to "wheel" — slow trackpad scrolls (gaps >35 ms — never reach the 6-fast-cadence demotion threshold) stayed latched and got reinterpreted as zoom. The first event of a new burst is now classified by signature (large integer `deltaY` with no `deltaX` → wheel; `ctrlKey`, `deltaX`, small magnitude, or fractional → trackpad), preserving the original Mac smooth-scroll mid-burst-flip fix while fixing slow trackpad scrolls. (2) The PDF panel's wheel handler no longer consults `looksLikeMouseWheel` at all — the safety net's purpose ("classic mouse wheel + pan mode = unusable") is board-only; on PDF, bare wheel scrolling is the natural way to walk through pages even with a real mouse wheel. Pinch (`ctrlKey`) still routes to zoom.

### Tooling

- **End-to-end self-update harness (`tools/update-test/`).** Builds OLD + NEW docker images pinned to a throwaway minisign key + a local Python http.server mirror at `host.docker.internal:18000`, signs a mock release manifest, starts the OLD container with `/var/run/docker.sock` mounted, and drives Playwright headless Chromium through the full apply→swap→reload, screenshotting every 2.5 s into `results/`. Asserts overlay visibility during restart, version flip via `/api/update/status`, and absence of JS crashes during the disconnect window. The harness reads `__brUpdateStore.{updating,restarting,progress.length}` directly via a deliberate `window` export so it can probe internal state without walking the React fiber. One command — `cd tools/update-test && ./run.sh` (add `BR_HARNESS_HEADED=1` to watch). Cached re-run completes in ~1 minute. **Run before any future updater change.**

## v0.19.6 — 2026-05-07

### Fixed

- **Small pins were unselectable in chain-adjacent / search-dim / spotlight modes.** PixiJS v8 Graphics inherit `eventMode` from their parent — the viewport is interactive (so pins receive clicks), so every Graphics added underneath was *also* interactive and any painted pixel under the cursor counted as a hit. The full-board dim layer drawn in those modes silently swallowed clicks before they reached the pin sprites; tiny 0402 caps and dense BGA pins were the worst affected. Decoration layers now explicitly set `eventMode='none'` at construction *and* at every `renderSelection` (the latter is an HMR safety-net — Vite replaces the module without re-instantiating the PixiJS Application, so layers in a hot-reloaded session would otherwise stay stale on `'auto'`). User-reported as "extreme regression."
- **XZZ multi-board packs were sometimes globally folded into one mirrored slab.** iPhone14 Pro/ProMax combined boardview was the canary — its tall portrait boards produce a strong mid-Y centroid gap (the empty CPU centerlines stacked on top of each other) that beat the X-direction inter-board gaps and slipped past the balance checks in `findFoldAxis()`. Now early-returns when the outline decomposes into ≥4 connected components that all pair off by `(width, height, segCount)`; per-board X-fold axes from `boardGroups` are the only thing the UI applies, with manual per-board folding still available from the sidebar. PARSER_VERSION bumped to invalidate cached entries.
- **Board rotation now pivots around the viewport's current focus**, not the board's geometric centre. Rotating while looking at a non-centred region used to slide that region off-screen. Implementation captures the viewport's world-centre before `applyFlips`, then pans so the same world point lands at screen-centre again after the rotation completes. Net-line geometry is now also recomputed and redrawn immediately on rotation (previously stayed at pre-rotation world positions until the next selection/pan/pulse-tick).
- **Flip-axis toggle now stays screen-stable across rotation.** Rotating to 90°/270° silently inverted the meaning of the flip-axis button — the stored hinge is a board-axis, but the user picks a *screen* direction. `rotateFlipAxis()` now flips the stored `'x'|'y'` whenever rotation crosses an axes-swap boundary so the screen direction the user selected is preserved. Toolbar icon and tooltip ('⇅ Vertical' vs '⇄ Horizontal') reflect the actual screen-axis result.

### New

- **180° rotation button** between the CCW/CW arrows. Repair work is dominated by boards photographed from the wrong end; one click is faster than two.
- **Rotation disabled in butterfly mode** with an explanatory tooltip — rotating a side-by-side spread tilted the joint off-screen, and the auto-separation axis logic didn't track manual rotation.
- **Public landing page** at <https://www.ripperdoc.de/boardripper/>. Plain HTML5, no JS, deployed via the RipperDocWeb rsync. Lives in `landing/`, excluded from the Docker image (the Dockerfile only `COPY`s `src/frontend/`, `src/backend/`, and `Board Database/boards.db`). See `landing/README.md` for the update workflow.

### Performance — renderer hot-path

Four findings from the 2026-05-07 review report; all sub-millisecond individually, compounding under sustained interaction. The bundle was reverted once when its `eventMode` interaction with the dim-layer bug surfaced as a click-blocking regression, then re-introduced piece by piece after that bug was traced to a separate root cause and fixed independently.

- **R-1** — restored G-3's zero-allocation property for the net-line render path. Per-pulse-frame `Map<color, Segment[]>` and `{start,end}` wrapper allocations (added in `a9d99b4` for chain-adjacent) are now built once in `recomputeNetLineSegments` (already dirty-tracked) as `netLineSegmentsByColor`. ~30 allocs/frame → 0 (single net) or ~150 → 0 (chain-adjacent on a 60-net rail).
- **R-2** — replaced `[...adjacentNets].sort().join(',')` sentinel with `.size` compare in `lastRenderedSel`. Content changes always co-occur with a change in `(partIndex, pinIndex, highlightedNet, board)` — the BFS inputs — so size is a sufficient sentinel. Saves ~0.05–0.3 ms per store notify on a 60-adjacent rail; biggest win during search iteration / PDF-binding refresh.
- **R-3** — pulled the OBD tooltip lookup off the per-`pointermove` path. `formatObdForNet` was running 6 regex tests + O(matches × |nets|) per move (~4 500 string compares on a 3-variant × 1 500-net board). Now: `obdNetIndex(boardNumber)` exposes a snapshot-keyed `Map<netName, ObdNet[]>` cached on a `WeakMap` keyed by the obd-store snapshot, and `BoardRenderer` memoises `extractBoardNumberFromFilename` against `boardStore.fileName`. Per-move cost: 1 string compare + 1 `Map.get`.
- **R-4** — promoted `crossSideGhostParts` from `number[]` to `Set<number>`. Two `.includes()` calls in the per-pin chain-mode net-line builder were O(g) linear scans called for every pin reference of every active net (~30 000 array scans → ~600 hash lookups on a busy 5 V rail with 60 nets, 10 pins, 50 ghosts).

### Updater hardening

Closes the two Important findings from `docs/analysis/2026-05-07-updater-security.md`. The crypto primitives were already well-covered; these tighten the surrounding I/O envelope.

- **Enforce `released_at` freshness window in `ValidateManifest`.** The existing check rejected expired manifests (90-day `not_after`) but ignored `released_at`, so a compromised mirror could re-serve any signed-but-stale manifest from anywhere in the 90-day window — defeating the counter check on first install (where `installedCounter == 0` skips), and freezing installed clients on outdated releases. Now requires `released_at ∈ [now − 30 d, now + 24 h]`. The 30 d past bound is wide enough not to bite the maintainer's normal cadence (5 releases in 9 days during the v0.19 cycle); the 24 h future slack tolerates clock-skew between signing host and client. Manifests without `released_at` are rejected outright.
- **Cap, time-out, and stream-verify the tarball download.** `downloadAsset()` previously did a plain `http.Get()` with no timeout, no size cap, and no streaming integrity check; `applyTarball` then re-read the whole tarball off disk to compute SHA-256, doubling peak RAM. New `downloadAssetVerified()` does it in one streaming pass: 10 min `http.Client.Timeout`, body cap = manifest's signed `SizeBytes` (or 1 GiB legacy fallback) by reading one byte past the cap so over-long streams are observed not silently truncated, incremental SHA-256 via `io.MultiWriter(file, sha256.New())` so peak memory stays at io.Copy's 32 KiB buffer. Rejects on size mismatch, SHA mismatch, or non-200.
- **Test coverage for orchestration helpers.** v0.19.2 (image-ref form), v0.19.3 (ghost-pulse), and v0.19.4 (healthcheck-by-name) all regressed in the orchestration layer despite well-tested crypto primitives. `parseDockerImageRef` and `selectNewImageRef` extracted as pure functions and covered with 25 tests across `parseDockerImageRef` (6 forms incl. embedded-colon-in-digest), `selectNewImageRef` (4 paths incl. the v0.19.2 fallback case), `extractBundle` (path-traversal guard, bsdtar/gnu `./` parity, ignored-extras), `bindsFromMounts`, and `shortID`.

### Release pipeline

- **Multi-arch INDEX digest is now captured for both the BoardRipper image and the orchestrator alpine.** Two same-class fixes: (a) `release.sh` was reading `--raw | jq '.manifests[0].digest'` for the BoardRipper image, which grabs the *first* platform manifest (amd64) from the multi-arch index, then signing that amd64-only digest into `manifest.json`. amd64 hosts pulled fine; an arm64 install would error. Now uses the non-raw `imagetools inspect`'s top-level `Digest:` line, hard-failing if the parse returns empty. (b) Same bug class on `alpine:3.19` for the orchestrator: `docker pull --platform linux/amd64` then `RepoDigests[0]` gave the per-platform manifest digest, not the index digest. Now pulls without `--platform` and reads via `buildx imagetools`. v0.19.5's NAS deploy was unaffected because the maintainer's NAS is amd64-only.

## v0.19.5 — 2026-05-06

### New: update-in-progress modal

When the user clicks **Update Now**, BoardRipper now shows a centered modal: *"Update in progress — the page will reload automatically in 30–60 seconds."* The modal stays up across the SSE-disconnect window (the orchestrator deliberately stops the running container, killing the progress stream — that is the **expected** success path, not a failure). Once the new container's `/api/health` responds, the page reloads automatically; the modal vanishes.

A `boardripper-update-in-flight` flag in localStorage persists across page refreshes mid-update — refreshing the tab while the update is in flight no longer presents a fresh dashboard with an "Update" button that could be clicked again. The flag is cleared on completion or after 5 minutes (whichever comes first). Backend health-poll runs every 2 seconds for up to 120 seconds while waiting for the new container.

### New: drop-to-update fallback

When the in-app update button can't reach GHCR or ripperdoc.de — or when a future broken-orchestrator bug strands an install — users can now download a single bundle file and drag it onto the BoardRipper window to apply the update. Each release publishes `boardripper-update-vX.Y.Z.tar` (and a stable `latest-update.tar` alias) at <https://www.ripperdoc.de/boardripper/releases/>. The bundle contains the signed manifest, its signature, and the OCI image tarball; the running container verifies the signature against its compiled-in public key, validates counter/expiry/min-version, checks the tarball sha256, then runs the same orchestrator restart as the network path. Same trust envelope: only the manifest signature grants trust; the file itself is untrusted bytes until verification passes. Recovery escape-hatch for any future broken-self-update situation, but only available once the running container is on v0.19.5+.

### Internal

- `update-store.ts` gains `restarting` / `restartingFromVersion` getters and an internal `streamProgress()` + `waitForRestart()` flow shared between `apply()` and `applyBundle()`.
- New `UpdateProgressOverlay` React component, mounted at the App root, gated on `updateStore.restarting`.
- New backend endpoint `POST /api/update/apply-bundle` (multipart upload, same auth-cookie middleware as the other `/api/update/*` routes).
- New helper `updater.ApplyBundle([]byte)` reuses every existing piece (`VerifyManifest`, `ValidateManifest`, `VerifyTarballSHA256`, `dockerLoad`, `orchestrateRestart`).
- `release.sh` now produces `out/boardripper-update-$VERSION.tar` alongside the regular tarball and uploads it to FTP atomically.
- `scripts/release/site-artifacts.sh` no longer requires `pandoc` — built-in renderer (perl + sed + awk) handles the BoardRipper CHANGELOG.md format. Without this, missing pandoc on the maintainer's machine silently uploaded a 141-byte stub instead of the rendered changelog.

## v0.19.4 — 2026-05-06

### Fixed

- **Auto-update silently rolled back on default Docker bridge.** The orchestrator polled `http://<container-name>:8080/api/health`, but Docker's default bridge network does not provide DNS-by-name for containers (only user-defined networks do). The poll never resolved, the 60-second healthcheck timed out, and the orchestrator restored the previous container — looking from outside as if "the update silently undid itself." Fix: query the new container's IP via `containers/{id}/json` and poll that IP. Falls back to name lookup if IP can't be parsed (preserves user-defined-network behavior).
- **Status bar showed wrong version after update** (e.g. `0.19.0` while backend was on `0.19.2`). The frontend bundle injects `__APP_VERSION__` from `src/frontend/package.json` at build time, which was being bumped by hand. The backend version comes from `release.sh`'s `--build-arg APP_VERSION`. The two drift apart whenever release.sh runs without a prior `package.json` edit. Fix: `release.sh` now writes `$VERSION` (sans `v` prefix) into `package.json` before the build, then commits the change as part of the release commit. Single source of truth from this release on.

### Migration note

Existing v0.19.0–v0.19.3 installs cannot auto-update to v0.19.4 (their bundled orchestrator still has the healthcheck-by-name bug). One manual `docker pull ghcr.io/alexeyinwerp/boardripper:v0.19.4 && recreate-container` is required. After landing on v0.19.4 once, future auto-updates work normally.

## v0.19.3 — 2026-05-06

### Fixed

- **Cross-side ghost outlines no longer flash and tank framerate during pan/zoom.** The ghost-pulse animation was rebuilding the entire `crossSideGhostGfx` Graphics object every tick (clearing, recomputing each part's polygon/bounds, drawing fill+stroke+pins), running at 60 fps regardless of whether the user was interacting. On boards with many hidden-side parts on a selected net, this competed with viewport updates and produced visible stutter. On top of that, `onZoomFrame()` was clearing the ghost geometry on every zoom frame, so during continuous wheel scrolling the ghosts vanished and reappeared on each 32 ms settle, producing the visible "flash".
  - Net-line + ghost pulse now freezes for a 100 ms window after every viewport `'moved'` event; pan and zoom no longer pay the per-frame Graphics rebuild. Phase doesn't advance during the pause, so the breathing resumes jump-free once the viewport settles.
  - The ghost gfx is no longer cleared in `onZoomFrame()` — ghost stroke widths are world-space and stay visually correct at any zoom, so the ghost stays drawn (frozen at last alpha) during zoom instead of vanishing/reappearing.

## v0.19.2 — 2026-05-06

### Fixed

- **Self-update would leave the host with no running container** when updating from v0.19.0 or v0.19.1. The orchestrator built the new container's image reference as `boardripper:<version>` (a leftover from the legacy tarball-load deploy convention), but the GHCR pull stores the image as `<registry>@<digest>` with no local named tag. The Docker daemon returned 404 on `containers/create`, the orchestrator's `set -e` killed the script before the rollback path could run, and the old container was left renamed to `-old` and stopped.
  - Now uses the canonical `<registry>@<digest>` reference, falling back to `<registry>:<tag>` if the digest is absent. Both pull-by-digest and tarball-load paths resolve correctly.
  - **Existing v0.19.0 / v0.19.1 installs cannot auto-update to v0.19.2** because their bundled orchestrator still has the bug. One manual `docker pull ghcr.io/alexeyinwerp/boardripper:v0.19.2 && recreate-container` is required. After landing on v0.19.2 once, future auto-updates work.
  - Recovery procedure for anyone hit by this on v0.19.0/v0.19.1: `docker rename boardripper-old boardripper && docker start boardripper` puts the host back on the old version.

## v0.19.1 — 2026-05-06

First release through the new pipeline end-to-end (no GitHub Actions). Pure cosmetic fixes; **the update flow itself is what's being validated.**

### Fixed

- **Quick settings labels on the home dashboard** now read identically to the Settings panel. Previously the dashboard showed glyphs (⇧ ⌃ ⌘ ⊞) and a half-translated `Cmd+Scroll / Win+Scroll` form for the PDF meta slot, while the Settings panel said `Shift + Scroll / Ctrl + Scroll (fast)` and `⌘ + Scroll / Ctrl + Scroll`. Both surfaces now use the same wording.
  - Slot labels: `Left-drag`, `Shift + Left-drag`, `Scroll`, `Shift + Scroll / Ctrl + Scroll (fast)`, `⌘ + Scroll` (Mac) / `Ctrl + Scroll` (Windows/Linux).
  - Row labels tidied: `Board: CLICK+DRAG` → `Board: Drag`; `Board: 2Finger/Scroll` → `Board: Scroll`; `PDF: Scroll` consistent.
  - Hint tooltips also match: "Drag pills between slots to reassign scroll actions."
- **Settings page subsection** "Mouse drag behavior" renamed to "Trackpad/Mouse drag behavior" — matches the QuickSettings hint already in place.

### Internal

- `scripts/release.sh` no longer uses the unsupported `lftp mv -f` syntax — atomic rename now does explicit `rm -f && mv`. (Already fixed in `84308b3`; this is the first release that benefits.)

## v0.19.0 — 2026-05-05

### New: secure update pipeline (replaces GitHub-token flow)

Updates no longer require `GITHUB_TOKEN`. Each release is now signed offline by
the maintainer (Ed25519 / minisign), and the running container verifies that
signature against a public key compiled into its own binary before applying any
update.

**For end users:** you can remove `GITHUB_TOKEN` from your `docker-compose.yml`
after this update. The toolbar update button keeps working with no token. If you
prefer to update manually, both sources are public and free:

```bash
docker pull ghcr.io/alexeyinwerp/boardripper:latest
docker compose up -d
```

…or the signed-tarball mirror (no Docker registry required, useful behind
firewalls):

```bash
curl -O https://www.ripperdoc.de/boardripper/releases/latest.tar.gz
docker load < latest.tar.gz
docker compose up -d
```

**What changed under the hood:**

- **Two delivery sources.** `ghcr.io/alexeyinwerp/boardripper` (public registry,
  fast layer dedup) and `https://www.ripperdoc.de/boardripper/` (signed tarball
  mirror). Updater walks them in order and accepts the first source whose
  manifest signature verifies. A hijacked mirror cannot deliver a forged update.
- **Manifest schema.** `manifest.json` carries `version`, `counter`,
  `released_at`, `not_after`, `important` flag, image digest, and tarball
  sha256. Replay/freeze attacks closed by a monotonic counter; dropped manifests
  closed by a 90-day expiry.
- **Notify-only UX, no auto-apply.** Updates appear as a banner; nothing
  installs without you clicking. Releases marked `important` (security fixes)
  show with a red banner instead of the normal blue.
- **Healthcheck-based rollback.** If the new container fails its healthcheck
  within 60 s of starting, the orchestrator auto-reverts to the previous image.
- **Per-install auth on `/api/update/*`.** A 32-byte secret is generated on
  first boot (`/data/.update-secret`, mode 0600). LAN drive-by requests to
  `/api/update/apply` now return 401. The web UI bootstraps an `HttpOnly +
  SameSite=Strict` cookie on first load.

Full design: `docs/superpowers/specs/2026-05-05-secure-update-pipeline-design.md`.
Maintainer release runbook: `docs/RELEASE_RUNBOOK.md`.

### Fixed

- Polyfilled `Promise.withResolvers` for older browser engines (R3dfox / Mypal
  on Win7 etc.). pdfjs-dist@5 calls it directly and would throw before any PDF
  byte was read.

### Misc

- Landing page footer credits "Alexey Lavrov / RipperDoc Munich".
- `CLAUDE.md` documents the `landing/` folder workflow.

### Bridge release note (one-time)

This release is the last one published to the private GitHub Releases page —
it's the bridge release that moves existing token-using clients onto the new
system. From v0.19.1 onward, releases will only appear at GHCR + ripperdoc.de.

---

## v0.18.1 — 2026-05-05

### Fixed

- **FZ load failures on real-world ASUS / MSI / ASRock boardviews.** The dominant variant in our 116-file NAS corpus (84%) carries an undocumented 4-byte forward-pointer that strict zlib decoders reject as trailing junk. We now detect and trim it before decompression, and we replaced the browser-native `DecompressionStream` with `pako.inflate` for tighter error reporting. Combined fix: ~80% of previously-broken FZ files now load.

## v0.18.0 — 2026-05-05

### New: themes — accent / background / chrome split

Themes are now two independent surfaces. The `THEMES` registry covers **board-side** concerns only (pin colours, part fills, background-of-board) and the board adopts whichever entry matches its file family. **UI chrome** obeys three independent knobs the user can set from the QuickSettings home dashboard or from Settings ▸ Themes:

- `accent` — buttons, focus rings, primary chrome (with auto-flipped text colour against perceived brightness)
- `background` — app shell background
- `chrome` — toolbar / status bar / sidebar chrome

Five accent presets ship: BoardRipper default (recoloured away from generic AI-cliché blue), and four ATARI homages (Pantone Bright Red C plus the Atari 2600 silver-label rainbow stripes). Each knob persists separately.

### New: Mentor Boardstation Neutral parser

11th supported format. Mentor Graphics Boardstation/Expedition exports a plain-text "neutral file" with the `.cad` extension shipped with some Samsung / Quanta / Compal / Acer notebook board packages — **not** GenCAD despite the shared extension. Detection cue: `# file : ...` first comment + `BOARD ... OFFSET ... ORIENTATION` record + `###Section` banners. Outline is synthesized from drill-hole geometry. See `docs/formats/MENTOR_NEUTRAL_FORMAT.md` for the full spec; AGPL provenance recorded in the spec footer.

### New: board-overlay search dropdowns + customizer

The floating in-canvas overlay (top/bottom toggle, flip-axis, parts/nets filters, dim-mode tri-state, selection-name label) is now slot-driven and user-customizable. Drag-and-drop in Settings ▸ Board overlay reorders or hides slots; "Add separator" inserts a divider; layout is persisted. Parts and Nets dropdowns use a shared popover scaffold with a memoized natural-sort index (refdes-aware) and a No-Connect partition for nets.

The dim-mode button cycles three states (off / search-dim / spotlight) — spotlight is a smooth dark gradient with a clear core sized to the selected component; selected pins draw above the spotlight so the component stays fully bright.

### New: home dashboard — bindings matrix + behaviour toggles

The HomeBackdrop dashboard now carries a Bindings matrix (board↔PDF associations from the library) and Behaviour toggles (auto-open PDF on board load, theme switch). The QuickSettings strip got a compact accent picker.

### Fixed

- **Allegro pad rotation on diagonally-placed footprints.** 45° QFNs and similar non-axis-aligned packages now render with correctly rotated pads.
- **`useThemeOverrides` `useSyncExternalStore` infinite loop.** Snapshot now caches a stable reference; the same fix shape applied to HomeBackdrop earlier in the cycle (`01eda1c`).
- **Settings panel crash guards** for the new overlay/themes subtree (`?? DEFAULTS` + try/catch defensive paths in fresh code).
- Browser-native page-zoom (Ctrl+/Ctrl-/Ctrl+wheel-on-page-chrome) no longer fires inside the BoardRipper window — would previously double-count with the in-canvas zoom.

### Internal

- `theme-store.ts` consolidated; the parallel registry shipped as a stop-gap was dropped.
- `boardOverlay` slot registry under `components/BoardOverlay/` with per-slot toggle components and a Separator slot.
- `panToPart` / `panToNetIfOffscreen` helpers added in renderer; focus-zoom capped at 3× fit-to-board scale.

## v0.17.1 — 2026-05-04

### New

- **PixiJS `CullerPlugin` enabled.** Off-viewport pin labels and parts no longer pay GPU per frame; expect 5–20× p95 improvement at deep zoom on dense boards. Closes a long-deferred research item.
- **Opt-in WebGPU backend** (PixiJS will fall back to WebGL if unavailable). Off by default.
- **Tidier QuickSettings home dashboard** — Library stats and Cache actions hoisted above the keyboard-shortcut instructions.

### Fixed

- Part-hull polygon now generates a tighter axis-aligned chip-layout guard, fixing selection misses on small chip caps near component-clusters.

## v0.17.0 — 2026-05-03

### New: Cadence Allegro v15.x BRD support

A second Allegro parser family. v15.x (magic `0x0012XXXX`) is a different binary from the v16/v17 family already supported (`0x0013XXXX`) — different header, different block table — but many block payloads are shared. Reverse-engineered blind from a 15.5.7 / 15.5.2 corpus over the previous week:

- Component definitions (LL_0x06), footprints (LL_0x2B), placements (BLK_0x2D), refdes strings (BLK_0x07), nets (LL_0x1B), pad geometry (BLK_0x48), pin-net assignment (Route 5: BLK_0xC8 back-link + multi-layer variants).
- **99.4%** perfect net coverage on the 15.5.7 corpus, ~92.7% on 15.5.2 (variant-split documented).
- A per-component oracle correctness gate runs in CI to prevent regressions.

Spec: `docs/formats/ALLEGRO_V15_FORMAT.md`. Future-work items captured inline.

### Fixed

- **BDV `BRDOUT: 0 0 0` (zero outline) regression.** v0.17.0-development restored the max-part-Y mirror axis fallback for files that ship a zeroed BRDOUT (e.g. creator 1457685 / DAG3BEMBCD0 — HP 17-an100 Quanta G3BE). Canary regression test pins it.

## v0.16.15 — 2026-05-03

### Fixed

- **Library sync no longer re-downloads zero-byte files forever.** A long-tail of intentionally-empty files (placeholder schematics, `.gitkeep`-shaped markers) was bypassing the local-cache "skip if same size" check because zero-size compared as falsy in the diff path; we now treat 0 as a real size.

## v0.16.14 — 2026-05-03

### Fixed

- **Library sync errors are now surfaced in the UI** instead of silently logging. The Settings ▸ Library section shows the most recent sync's status (success/fail/in-progress) and the failing path; a "Retry" button re-runs the failed step.

## v0.16.13 — 2026-05-03

### Fixed

- **Library sync manifest parser preserves spaces in paths.** WebDAV PROPFIND responses with `<D:href>/Library/Apple iPhone 14/...</D:href>` were splitting on the space; sync skipped any board folder whose name contained a space. Fix: parse `<D:href>` as a single token, URL-decode after extraction.

## v0.16.12 — 2026-05-03

### Fixed

- **Library sync diff phase no longer blocks for hours.** The diff was doing a per-file HEAD on every remote candidate, which on a 60k-file mirror added minutes-to-hours before any actual transfer started. We now use the manifest's enclosed PROPFIND size+mtime as authoritative and reserve HEAD for tiebreakers.

## v0.16.11 — 2026-05-02

### New: library sync (WebDAV pull)

A scheduled background sync pulls a remote WebDAV-served library mirror into the local `/library/` mount. Settings ▸ Library exposes the endpoint, schedule, and a "Sync now" button. Diff-then-fetch semantics; per-file resume; never deletes remotely-missing files (Phase 1: pull-only). Useful for repair shops who keep an authoritative library on a NAS or office server and want every workstation to mirror it without manual copy.

### Performance

- **Net-line pulse skips when the page is hidden or the window is unfocused.** Browsers had been paying the 60 fps Graphics rebuild cost on background tabs; cutting it slashes the renderer's idle CPU.

## v0.16.10 — 2026-05-02

### New

- **Per-tab sidebar isolation.** Each BoardViewer panel tab now keeps its own sidebar selection, scroll position, and overlay-toolbar state. Switching tabs no longer wipes the Component Info pane in the other tab.
- **InfoTab OBData notes.** OBD readings (Diagnosis, Notes, Photos) now appear in the BoardSidebar InfoTab the same way they appear in the LibraryPanel's ObdSection.
- **TVW BOM-variant + ghost detection.** TVW boards now light up the Revisions tab — bbox-overlap clustering catches stacked-cap "alternate parts" that share refdes but differ in value. The per-pair swap button (added in v0.16.9 for Revisions) now applies to TVW too.

### Fixed

- **TVW empty Through layer** (Landrex variant on Gigabyte boards) no longer fails to load.
- **TVW pin-extension block** now fires on `partType=0x11` too — fixes broken pin geometry on the Gigabyte/Landrex variant.
- **Net search** can now expand a selected net into its component spoiler.

## v0.16.9 — 2026-05-01

### New

- **OBD structured DIAGNOSIS.** OpenBoardData diagnosis text is now parsed into collapsible sections with clickable refs (component refdes, net names) that select on the canvas. Multi-variant tables with comments displayed inline.

## v0.16.8 — 2026-05-01

### Fixed

- **PDF↔board lookup** — net-line drawing across the schematic, board-search mirror behaviour. Focus-zoom capped at 600% so opening a tiny test pad doesn't fly the viewport into pixel territory.

## v0.16.7 — 2026-05-01

### New: OpenBoardData (OBD) integration

BoardRipper now reads the public [OpenBoardData](https://openboarddata.org) corpus — community-maintained per-board diagnostics, pin readings, schematics, and notes — and surfaces it inline.

- **Backend:** `OBDATA_V002` parser, filesystem cache with atomic writes + `bpath` sandboxing, scraper with drop-guard, four HTTP handlers under `/api/obd/*` with single-flight, integration tests.
- **Frontend:** `obdStore`, `useObdForBoard` hook, Settings ▸ Library tab with disclaimer + "Sync OBD" button, `ObdSection` in LibraryPanel detail with a multi-variant table and visible comments. Canvas tooltip + Info pane surface readings on hover.
- **Disclosure:** OBD content is third-party; the disclaimer in the sync UI sets expectations clearly. Cache is bounded; sync is opt-in.

The aligned-with-real-format scraper fix in this release brought OBD live.

## v0.16.6 — 2026-04-30

### New

- **Local-LLM NAS classifier.** A second-pass classifier runs against the maintainer's NAS dump using a local LLM, filling Brand/Family/Board placeholders for the boards the heuristic + Tavily passes left in `Unsorted`. Round 1 imported **1024** new boards.
- **Family-hierarchy normalization** across all brands (so Apple `MacBook Pro` is one family, not three near-duplicates separated by capitalization).

## v0.16.5 — 2026-04-29

### New / Cleanup

- Tightened the file-extension whitelist used by the librarian's filename scanner — drops dead `.cae` and `.xzz` (the parser handles `.xzz`; the scanner doesn't).
- **Tavily classifier residue cleared.** From 1091 Unsorted → **170** Unsorted left.

## v0.16.4 — 2026-04-29

### New

- **Tavily search backend** wired into the offline classifier (`--search-backend tavily`). LLM classifier is now searchable in three modes: offline (heuristic only), DuckDuckGo, Tavily.
- boards.db curated from the v0.16.3 raw import down to **1091 Unsorted** (was ~2,800 after the filename-scan import).

## v0.16.3 — 2026-04-29

### New

- **`apple-boards.ts` retired** — the hardcoded Apple-board lookup is gone; `boards.db` is now the single source of truth.
- **Rescan re-resolves metadata.** Renaming a board in the DB no longer requires re-importing files.

## v0.16.2 — 2026-04-29

### Fixed

- **Auto-bind log spam** on `FOREIGN KEY constraint failed` (787) now bounded — previously one full line per failed pair hammered stdout and the writer mutex on a busy rescan after Reset All.

### Internal

- Release pipeline trimmed to Docker-only (legacy CI tarball path removed).

## v0.16.1 — 2026-04-29

### New

- **`boards.db` is now bundled inside the Docker image** at `/build/boards.db`. Fresh installs no longer need a side-channel DB download.
- Desktop builds (Electron Mac/Windows) paused for this release window.

## v0.16.0 — 2026-04-29

### New: boards.db 20× expansion (145 → 2,914 boards)

The board reference database expanded from 145 hand-curated entries to **2,914** via three import slices, all converging on the v2 schema:

1. **Wikidata Macs import (Slice 1).** SPARQL fetch of all Apple Mac models → staging file → apply with INSERT OR IGNORE under v2 placeholders. Family resolver auto-assigns `MacBook` / `iMac` / `Mac mini` / `Mac Pro` / `Mac Studio`.
2. **XZZ Apple-laptop skeleton import.** Replaces the Wikidata path with a filesystem walk of the maintainer's XZZ corpus — recovers boards Wikidata doesn't carry (Quanta / Compal / Foxconn ODM codes).
3. **Filename-scan importer (Slice 1).** A pattern battery walks `/library/`, cross-references existing boards, tokenizes unmatched substrings, and emits a Markdown observation report + JSON sidecar. The JSON sidecar feeds an importer that creates placeholder Brand/Family/Board entries with `INSERT OR IGNORE`. **2.8K new boards** added in one pass.

A snapshot of the 2026-04-29 observation report is archived under `docs/scan/archive/`.

### Internal

- All three importers landed via per-slice spec → plan → implementation, merged into main as separate feature branches (`feat/wikidata-macs-import`, `feat/filename-scan-observation`).

## v0.15.0 — 2026-04-28

### New: boards.db v2 schema redesign + Database Editor

The flat `boards` table is replaced by an **entity hierarchy**: Brand → Family → Board, with a color cascade and an explicit `family` field on each Board. The v2 resolver walks the hierarchy and returns the most specific colour/identity available; UUIDs are always freshly generated in the migration so old `BoardColorHex` values don't pin to retired entries.

- v2 migration script with full test coverage; step tracking + orphan-row defense; case-insensitive brand match; `FAMILY_PATTERNS` extended.
- `boards.db` rewritten on the v2 schema; `create_mockup_db.sql` rewritten; `build_full_db.sql` archived.
- **Database Editor panel** (Library tab) — read-only first slice. Lists Brands, Families, Boards in a tree view; clicking a Board surfaces its full row.

### Fixed

- **HomeBackdrop hides** when any Dockview panel is opened — previously it leaked through float-window seams.

---

## v0.14.0 and earlier

For releases prior to v0.15.0, see the git tags directly:
[`git log --oneline --tags`](https://github.com/AlexeyInwerp/BoardRipper/releases)
(maintainer-only access until the repo is open-sourced).
