# BoardRipper changelog

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

## v0.18.1 and earlier

For releases prior to v0.19.0, see the git tags directly:
[`git log --oneline --tags`](https://github.com/AlexeyInwerp/BoardRipper/releases)
(maintainer-only access until the repo is open-sourced).
