# Desktop app — update path (issue #42)

Issue: [#42](https://github.com/AlexeyInwerp/BoardRipper/issues/42) — "the update
feature doesn't work, had to be downloaded manually each time and overwritten"
(macOS). Three phases; the first two need no code signing and reuse the signing
and hosting the Docker update already has. Order = commit order.

## What is true today

- The desktop app is Electron 35 packaged by `@electron/packager`
  (`desktop/build-all.mjs`): three portable zips per **feature** release —
  `BoardRipper-macOS-universal-vX.Y.Z.zip`, `BoardRipper-Legacy-macOS-x64-vX.Y.Z.zip`,
  `BoardRipper-Windows-x64-vX.Y.Z.zip`. Point releases ship `--no-desktop`, so the
  newest desktop build is always the last minor (v0.50.1 has zips, v0.50.2 has none).
- Hosting: GitHub release assets (primary) and
  `https://www.ripperdoc.de/boardripper/desktop/` (mirror, with atomic
  `…-latest.zip` pointers). Both already written by `scripts/release.sh`.
- Signing: macOS ad-hoc (`codesign --sign -`), Windows none. Users open with
  right-click ▸ Open the first time. No Developer ID, no notarization.
- **There is no update code in the desktop app at all.** `desktop/main.js` never
  checks a version; the web UI hides `UpdateBadge` on Electron
  (`Toolbar.tsx`, `!isElectron() && !isLiteBuild()`); the sidecar backend is built
  without `PubKey`, so `/api/update/*` is dead there, and it only runs while MCP is on.
  So #42 is not a broken feature, it is a missing one — the reply on the issue
  should say that.
- The app knows its version: `app.getVersion()` in the main process and
  `__APP_VERSION__` in the renderer, both from `src/frontend/package.json`
  (`desktop/package.json`'s `1.0.0` is unused). The sidecar binary lives inside
  the bundle (`bin/darwin`, `bin/win32`), so replacing the bundle replaces it;
  `userData` (settings.json, logs, MCP secret) is outside and survives.
- The Docker manifest is minisign-signed (`VerifyManifestAny`, trusted keys
  compiled in, fail closed) and published at ripperdoc.de + the GitHub release.
  Nothing in it describes the desktop builds.

## Why not Electron's `autoUpdater` now

Squirrel.Mac refuses an app that is not signed with a Developer ID; Squirrel.Windows
wants its own installer layout, not a portable zip. `electron-updater` has the same
macOS requirement. So a "real" auto-update is Phase 3 and costs an Apple Developer
account. Phases 1–2 give the reporter what he asked for (no more manual download,
no more overwrite by hand) without it.

## Phase 0 — a signed desktop feed from the release script

`scripts/release.sh` writes `out/desktop.json` whenever it built the desktop zips
and signs it with the same minisign key as `manifest.json`:

```json
{
  "version": "0.51.0",
  "released_at": "2026-11-02T10:00:00Z",
  "notes_url": "https://github.com/AlexeyInwerp/BoardRipper/releases/tag/v0.51.0",
  "builds": {
    "darwin-universal": { "url_primary": "…/releases/download/v0.51.0/BoardRipper-macOS-universal-v0.51.0.zip",
                          "url_mirrors": ["https://www.ripperdoc.de/boardripper/desktop/BoardRipper-macOS-universal-v0.51.0.zip"],
                          "sha256": "…", "size_bytes": 123456789, "min_os": "11.0" },
    "darwin-x64-legacy": { … },
    "win32-x64": { … }
  }
}
```

Published next to the zips: `…/boardripper/desktop/desktop.json` + `.minisig` on FTP
and as two more assets on the GitHub release. A separate file, not a block inside
`manifest.json`, because point releases rebuild the manifest without desktop
builds and would have to carry the old block forward; a file that only desktop
releases touch stays correct by construction. Downgrade defence is the version
comparison itself — the client offers nothing that is not newer than
`app.getVersion()` — so no counter is needed; `released_at` is shown, not enforced.

Also add the two files to the `--desktop-only` path (it has no manifest step today)
and to `docs/RELEASE_RUNBOOK.md` step 12.

## Phase 1 — the app knows when it is behind

`desktop/update-check.js` (main process, plain Node, no new dependency):

- Sources in order, first verified wins — the Docker rule:
  `https://www.ripperdoc.de/boardripper/desktop/`, then
  `https://github.com/AlexeyInwerp/BoardRipper/releases/latest/download/`.
- **Verification is minisign in ~40 lines of Node:** parse the `.minisig`
  (second line, base64 → 2-byte algo `ED` + 8-byte key id + 64-byte signature);
  for `ED` the signed message is `blake2b512(desktop.json)`; verify with
  `crypto.verify(null, hash, spkiKey, sig)` where the SPKI key is the 32 raw key
  bytes behind the fixed DER prefix `302a300506032b6570032100`. The trusted key
  is baked at build time by `build-all.mjs` from the same `PUBKEY` the Docker
  build uses (plus `PUBKEYS` for the rotation window, `VerifyManifestAny`
  semantics). Empty key set ⇒ the check is off, never "verify nothing". An env
  override for the key is honoured **only when `!app.isPackaged`** — that is what
  the E2E uses; a packaged build has no override, same as the Go side.
- Build identity: `process.platform` is not enough on macOS (universal vs legacy
  are both `darwin`), so `build-all.mjs` writes a `build.json` into the app
  (`{ "build": "darwin-universal" | "darwin-x64-legacy" | "win32-x64" }`) and the
  check picks `builds[that]`. Compare semver against `app.getVersion()`
  (same digit-wise rule as `updater.parseVersion`).
- When: at launch (after the window shows, 10 s delay), on window focus when the
  last check is older than an hour, and every 6 h. Network errors are logged and
  otherwise silent. State lives in `settings.json`: `lastUpdateCheck`,
  `skippedVersion`.
- Surface: `preload.js` exposes `electronAPI.updates.{getState, check, skip, openNotes}`
  and `onUpdateState(cb)`. The renderer's `UpdateBadge` gets an Electron variant that
  reads this instead of `/api/update/status` and shows the same `Update` /
  version swap the Docker build has; its dropdown offers *Release notes* and
  *Download* (Phase 1: opens the browser on the release page; Phase 2 replaces
  it with the in-app install). Also a *Check for Updates…* item in the app menu
  (macOS: app menu; Windows: Help) so a user can ask.

Test: `tests/electron-update-check.spec.ts` beside `electron-smoke.spec.ts` —
spawn a local HTTP server serving a `desktop.json` signed with a throwaway
minisign key (generated in the test with Node's `crypto.generateKeyPairSync('ed25519')`,
signature written in minisign's own layout), point the app at it through the
non-packaged env override, assert the badge appears for a newer version, stays
hidden for an equal one, and that a tampered body is rejected and logged.

## Phase 2 — download, verify, swap, relaunch (still unsigned)

- Download `url_primary` then the mirrors into `userData/updates/<version>/`,
  cap the body at `size_bytes`, verify `sha256` + size before anything is
  extracted (the Docker rules: body cap, verify before use, one download at a time).
- Extract with what the OS has: `ditto -x -k` on macOS (keeps the bundle's
  resource forks and symlinks), `tar -xf` on Windows 10+ (bsdtar reads zip).
  No zip library.
- Swap on quit, not while running — neither OS lets a running binary be
  overwritten cleanly. Stage `BoardRipper.app.new` (or the new
  `BoardRipper-win32-x64` folder) next to the current one, then on
  `before-quit` spawn a **detached** helper (`/bin/sh` script / `cmd` script)
  that waits for our pid to exit, renames current → `.old`, `.new` → current,
  relaunches (`open -n` / `start`), and the next launch deletes `.old`.
  The helper's log goes to `userData/logs/update-swap.log`, the one record of a
  failed swap (the orchestrator-log lesson from the Docker path).
- **Fall back to "download and reveal" whenever the swap cannot be safe:**
  the app directory is not writable; `process.execPath` sits under
  `/private/var/folders/…/AppTranslocation/` (Gatekeeper ran us from a
  translocated copy — the real bundle is somewhere else and we do not know
  where); or the app is running from a mounted volume. In that case Phase 1's
  behaviour stays: the zip is downloaded and shown in Finder/Explorer with a
  one-line note.
- **Two things to measure on a real Mac before trusting this, not infer:**
  (a) a zip downloaded by Node (`fs.writeFile`, not a browser) carries no
  `com.apple.quarantine` attribute, so the swapped-in ad-hoc-signed bundle
  should launch without the right-click ▸ Open dance — verify with
  `xattr -l` on the staged bundle and one real relaunch; (b) whether the
  relaunched bundle keeps the same ad-hoc identity for TCC prompts (folder
  access granted to the library) or asks again — the answer decides whether the
  release note has to warn about it. On Windows, a Node-downloaded file has no
  Mark-of-the-Web, so SmartScreen is not expected; verify once.
- Progress: `electronAPI.updates.onProgress`, rendered by the existing
  `UpdateProgressOverlay` pattern.

## Phase 3 — signed builds (decision for the maintainer)

Apple Developer ID + notarization (US$99/yr) lets Phase 2's helper script go
away on macOS: `autoUpdater.setFeedURL` with a JSON feed we can generate from
`desktop.json`, and no first-launch right-click either. Windows gains nothing
from a certificate until SmartScreen complaints appear. Not needed for #42;
written down so the choice is explicit.

## Out of scope

- Updating the lite PWA (it already asks for updates itself, `sw-update-checks.ts`).
- Delta updates, background downloads before the user says yes, auto-apply
  without confirmation — the Docker path asks, the desktop asks too.

## Reply for #42 (draft)

> Thanks — and to answer joesipaq1's question for the record: it would not have
> mattered. The desktop app has no update mechanism at all today; the badge you
> see in the Docker build is deliberately hidden on desktop because its
> self-update swaps a container, which has no meaning for an .app. Plan:
> [docs/plans/2026-10-29-desktop-update-path.md]. First step is an in-app
> notice with a one-click download when a newer desktop build exists (checked
> against a signed feed, like the Docker manifest), second step is download,
> verify and replace the app on quit so nothing has to be overwritten by hand.
> A fully silent auto-update needs a signed build, which is a separate decision.
> Relabelled from "Rendering / Visual" to "Desktop".
