# Secure Update Pipeline — Design

**Status:** approved 2026-05-05
**Replaces:** GitHub-token-gated self-update at [src/backend/updater/updater.go](../../../src/backend/updater/updater.go)
**Owner:** maintainer (single-developer project)

## Overview & goals

Replace the current update flow — which requires every end-user to obtain a GitHub Personal Access Token for a private repo — with a token-free, signature-verified pipeline that ships from two mirrors (GHCR + ripperdoc.de) and lets us add a third (public GitHub Releases) at zero protocol cost when the repo eventually goes public.

**Hard goals:**
- End-users need zero secrets, zero manual configuration, and no GitHub account.
- Compromise of any single piece of distribution infrastructure (FTP, GHCR, DNS, CDN) cannot push a malicious update to existing installs.
- A forked image cannot fetch updates from our mirrors; a tampered mirror cannot deliver a forged update.
- Existing installs that have `GITHUB_TOKEN` set today must migrate themselves automatically with one click.
- Notify-only update UX. No auto-apply, no mandatory updates.

**Non-goals (v1):**
- Multiple release channels (stable/beta/canary)
- Rollback UI / version history browser
- Auto-apply on a schedule, urgent-bypass flags
- Sigstore keyless / Fulcio integration
- Per-key compartmentalisation (one Ed25519 key signs both manifest and image; two keys is a v2 option)

## Decisions

These were made explicitly during brainstorming and are load-bearing for the rest of the design:

| # | Decision | Rationale |
|---|---|---|
| 1 | Two-source from day one (GHCR + ripperdoc.de tarball), public-GH-Releases addable later | Layer dedup + free CDN via GHCR; tarball as ungameable fallback; multi-source via signature-verified bytes is source-agnostic |
| 2 | Offline Ed25519 signing key on maintainer's Mac | Compromise of CI / website / GitHub all simultaneously cannot forge an update; `release.sh` prompts for passphrase per release |
| 3 | One signing identity, two key files (one minisign for manifest, one cosign for image) | Each tool needs its native key format; treating them as one logical "release identity" for backup keeps ops simple. Compartmentalisation across multiple identities is a v2 concern. |
| 4 | Single bridge release (option A migration) | One last token-flow release `vN` that immediately puts existing users on the new system; retire GH releases pipeline after that |
| 5 | Notify-only UI, no auto-apply | User control; `important` flag exists as visual emphasis only, never as auto-trigger |
| 6 | Source list baked at build time, not configurable at runtime | Runtime-configurable source = self-extending trust hole; new sources added by shipping a new release |
| 7 | Signature on manifest (which contains image digest + tarball sha256), not on artifacts directly | Single signing operation per release authenticates everything; cosign on the image gives registry-pull path its own verification |
| 8 | Per-install random secret on `/api/update/*`, not maintainer-issued auth | Closes unauthenticated `/api/update/apply` hole without adding maintainer-side accounts |

## Architecture

```
                       ┌──────────────────────┐
                       │ Maintainer's Mac     │
                       │ (offline signing key)│
                       └──────────┬───────────┘
                                  │ ./scripts/release.sh vX.Y.Z
                                  │  (sign manifest + cosign image)
                  ┌───────────────┼───────────────┐
                  ▼               ▼               ▼
            ┌─────────┐    ┌─────────────┐  ┌───────────────┐
            │  GHCR   │    │ ripperdoc.de│  │ GitHub Release│
            │(public) │    │   (FTP)     │  │ (added later, │
            │         │    │             │  │  when public) │
            └────┬────┘    └──────┬──────┘  └───────┬───────┘
                 │                │                 │
                 └────────────────┼─────────────────┘
                                  ▼
                       ┌──────────────────────┐
                       │ User's BoardRipper   │
                       │ container (updater)  │
                       └──────────────────────┘
```

The updater walks an ordered, build-time-baked **source list** until one returns a manifest whose Ed25519 signature verifies against the **public key compiled into the binary**. The first valid manifest wins. Source URL is untrusted; the signature is the trust root.

## Trust model

- **One Ed25519 keypair**, generated once on the maintainer's Mac, stored encrypted (passphrase + 1Password backup, ideally YubiKey-touched). Public half compiled into every BoardRipper binary via `-ldflags -X`.
- **Manifest signing only.** The manifest contains the SHA256 of the image tarball and the digest of the GHCR image, so signing the manifest transitively authenticates the bytes via either delivery path.
- **Cosign image signature** uses the same key, applied to the GHCR image by digest. The registry-pull path verifies via cosign; the tarball-fallback path verifies via the manifest signature. One trust root.
- **Replay/freeze protection** via a monotonic `counter` field, signed into the manifest. Client refuses any manifest whose counter is `≤` the currently installed counter.
- **Expiry.** Manifest carries `not_after`. Client refuses expired manifests; forces re-sign at least every 90 days, which closes any unbounded freeze window.
- **Fork containment.** A forked image rebuilt without our key cannot consume our updates. Forks must ship their own key for their own user base. This is the correct behaviour, not a bug.
- **Threats explicitly out of scope:** maintainer Mac compromise (assumed trusted), supply-chain compromise of npm/Go dependencies (mitigated by lockfiles + audits, but not by this design).

## Manifest schema

`https://ripperdoc.de/boardripper/manifest.json` (and identical bytes on every other mirror):

```json
{
  "version": "v0.8.0",
  "counter": 42,
  "released_at": "2026-05-10T14:00:00Z",
  "not_after":   "2026-08-10T14:00:00Z",
  "important": false,
  "important_reason": "",
  "notes_url": "https://ripperdoc.de/boardripper/changelog.html#v0.8.0",
  "tarball": {
    "url_primary":  "https://ripperdoc.de/boardripper/releases/boardripper-v0.8.0.tar.gz",
    "url_mirrors":  [],
    "sha256":       "5e0c620d8a59c0a1a800df4f572c919af6f439d2c382d0f8a34eb065c9e98e0b",
    "size_bytes":   26214400
  },
  "image": {
    "registry": "ghcr.io/alexeyinwerp/boardripper",
    "tag":      "v0.8.0",
    "digest":   "sha256:81cfa28b508ff379dbece4ba612692fab2e62f99e0e5e149dbceda45de34f692"
  },
  "min_supported_version": "v0.8.0",
  "orchestrator_image_digest": "sha256:abc...",
  "source_list_next": [
    "ghcr",
    "ripperdoc.de"
  ]
}
```

Signature lives next to it as `manifest.json.minisig` (minisign format, Ed25519). `source_list_next` is informational — it documents the canonical mirrors going forward but is not used to expand the running client's source list (that would be a self-extending trust hole). It only matters for the next release the maintainer cuts.

**Field semantics:**
- `counter` — monotonic, never reused. Persisted in repo as `.release-counter`, auto-incremented by `release.sh`.
- `important` / `important_reason` — UI emphasis only; never auto-applies anything.
- `min_supported_version` — if installed `Version < min_supported_version`, the updater refuses and shows a "manual update required" message. Used for protocol-breaking changes.
- `image.digest` — content-addressed; immune to tag rewrites. The updater pulls by digest, never by tag.
- `orchestrator_image_digest` — the alpine image used for in-place container restart, pinned by digest (current code uses `alpine:latest`, a supply-chain risk).

## Updater code changes (Go, in-container)

[src/backend/updater/updater.go](../../../src/backend/updater/updater.go) is rewritten:

- Replace hardcoded `RepoOwner / RepoName` constants with build-time variables set via `-ldflags -X`:
  - `PubKey` — base64-encoded Ed25519 public key (44 chars)
  - `SourceList` — comma-separated mirror URLs
  - `Version` — current binary version (already set today)
- Replace `fetchLatestRelease()` (GitHub API) with `fetchSignedManifest()`:
  1. Walk `SourceList` in order. For each mirror: GET `<base>/manifest.json` and `<base>/manifest.json.minisig`.
  2. Verify Ed25519 signature against compiled-in `PubKey`. First valid manifest wins.
  3. Validate: `counter > installed_counter`, `not_after > now`, `min_supported_version <= Version`.
  4. If `image.registry` is set and Docker can reach it → `docker pull <registry>@<digest>`. Verify cosign signature on the pulled image against the same public key.
  5. Otherwise → download `tarball.url_primary`, sha256-check against manifest, `docker load`.
- Replace `orchestrateRestart()` ([src/backend/updater/docker.go:258](../../../src/backend/updater/docker.go#L258))'s use of `alpine:latest` with the manifest's `orchestrator_image_digest`.
- Drop `gitHubToken()` ([src/backend/updater/updater.go:26-29](../../../src/backend/updater/updater.go#L26-L29)) entirely.
- Drop `GITHUB_TOKEN` from [docker-compose.yml:43](../../../docker-compose.yml#L43).

**Library choices:**
- `aead.dev/minisign` — Go-native minisign verification, single small package.
- For cosign verification, shell out to `cosign verify` rather than embedding the cosign Go SDK (smaller binary, simpler). Requires `cosign` binary in the runtime image — added to the final Dockerfile stage.

**Dockerfile build args (new):**
- `ARG PUBKEY` — minisign public key (base64), passed as `-X boardripper/updater.PubKey=$PUBKEY`
- `ARG SOURCES` — comma-separated source list, passed as `-X boardripper/updater.SourceList=$SOURCES`
- `ARG COSIGN_PUBKEY` — cosign public key (PEM), embedded into image at `/etc/boardripper/cosign.pub` for `cosign verify --key` to consume.
- `APP_VERSION` already exists ([Dockerfile:17](../../../Dockerfile#L17)).

## Auth on `/api/update/*`

Per-install secret, generated on first boot:
- On startup, if `/data/.update-secret` doesn't exist, write 32 random bytes (hex), mode 0600.
- All `/api/update/*` routes ([src/backend/handlers/update.go:23-105](../../../src/backend/handlers/update.go#L23)) require header `X-BoardRipper-Update-Token: <secret>`.
- Bootstrap flow: on first UI load, the frontend calls `GET /api/update/bootstrap`. The handler sets a same-origin HttpOnly cookie containing the secret, returns 204. Subsequent `/api/update/*` calls accept either the header or the cookie. The cookie is scoped to `/api/update/`, `SameSite=Strict`, no `Secure` flag (the install is plain HTTP on a LAN by default).
- Result: any browser that has visited the BoardRipper UI (and thereby received the cookie) can trigger updates; a LAN attacker hitting `http://nas:8081/api/update/apply` from `curl` without the cookie gets 401. Acceptable threat model — the protection is "no drive-by CSRF from a different origin," not "fully authenticated multi-user system."

## Rollback

- Before pulling new image, tag currently-running image as `boardripper:previous` (don't `docker rmi` it).
- Add `GET /api/health` endpoint that returns 200 only when databank is open + HTTP serving + static dir mounted.
- After `docker run` of new container, orchestrator polls `/api/health` for 60s.
- If 60s elapses without 200, orchestrator stops new container, restarts the previous container with same config, surfaces "rollback: new version failed health check" via the existing progress SSE stream.
- One previous image kept; no version-history UI.

## Frontend banner

[src/frontend/src/store/update-store.ts](../../../src/frontend/src/store/update-store.ts) reshape:
- Pipe through new manifest fields: `important`, `important_reason`, `notes_url`.
- Banner variant from `important`:
  - `false` (default) → blue/grey "Update available" banner
  - `true` → red/orange "**Important update**" banner with `important_reason` text inline + icon
- "View release notes" link → `notes_url` (or hidden if absent).
- "Update" button → POSTs `/api/update/apply` with the per-install token header.
- Polling cadence unchanged: every 6h while UI is open + on tab focus.

## Build / release pipeline (`scripts/release.sh`)

Replaces existing `scripts/release.sh` entirely. Reads creds from `~/.config/boardripper/release.env` (mode 0600, NOT in any tracked repo).

```
release.sh v0.8.0 [--important "reason"]

  preflight:
    - require: docker buildx, minisign, cosign, lftp, jq
    - require: signing key + FTP creds + GHCR token in ~/.config/boardripper/release.env
    - confirm git working tree is clean and on main
    - read .release-counter, increment by 1

  build & push image:
    - docker buildx build --platform linux/amd64,linux/arm64 \
        --build-arg APP_VERSION=v0.8.0 \
        --build-arg PUBKEY=<base64> \
        --build-arg SOURCES=<csv> \
        -t ghcr.io/alexeyinwerp/boardripper:v0.8.0 \
        -t ghcr.io/alexeyinwerp/boardripper:latest \
        --push .
    - capture image digest from buildx imagetools

  cosign-sign image:
    - cosign sign --key ~/.config/boardripper/cosign.key \
        ghcr.io/alexeyinwerp/boardripper@<digest>

  build tarball:
    - docker save ghcr.io/.../boardripper:v0.8.0 | gzip > out/boardripper-v0.8.0.tar.gz
    - sha256sum, size

  generate manifest.json:
    - fill schema (version, counter, sha256, digest, important, etc.)
    - minisign -S -s ~/.config/boardripper/release.minisign -m manifest.json
        (produces manifest.json.minisig)

  generate site artifacts:
    - sed-template landing/index.html between <!-- BR_VERSION:START/END -->
    - convert CHANGELOG.md → changelog.html (pandoc or minimal converter)
    - convert THIRD_PARTY.md → third_party.html
    - regenerate releases/index.html (simple list of past tarballs)

  upload to FTP atomically:
    - upload manifest.json.new + manifest.json.minisig.new, then rename
    - upload boardripper-v0.8.0.tar.gz
    - upload latest.tar.gz.new, then rename
    - upload templated landing/index.html, changelog.html, third_party.html
    - bump releases/index.html

  finalize locally:
    - git add CHANGELOG.md .release-counter landing/index.html
    - git commit -m "release: v0.8.0"
    - git tag v0.8.0 && git push origin main v0.8.0
```

The `.new`-then-rename trick on FTP means a client mid-download never sees a half-written manifest or tarball. Whole script ~150 lines bash.

## Migration release (vN, the bridge)

Concretely: cut `vN` (likely `v0.8.0`) twice — once via the OLD pipeline, once via the NEW pipeline.

- vN's binary already has the new updater compiled in (new `PubKey`, new `SourceList`).
- vN is ALSO uploaded to the existing private GitHub repo as a release tarball, exactly as today — so existing token-using clients see "update available" via their old code path and click.
- After they update to vN, their next check uses the new code path against `ghcr.io` + `ripperdoc.de`. The token in their env becomes vestigial.
- vN's release notes explicitly say: "This release moves updates to ripperdoc.de + GHCR. You can now remove `GITHUB_TOKEN` from your `docker-compose.yml`."
- vN+1 onward: only the new pipeline. The private GH repo's release page never gets another upload.

**Stuck-on-vN-1 fallback:** users who never click update on vN stay on vN-1 forever. Acceptable — they can update manually with `docker pull ghcr.io/.../boardripper:latest && docker compose up -d`, or you cut `vN.0.1` to GH releases as a final nag release.

## Landing page changes (already deployed 2026-05-05)

Source: [landing/index.html](../../../landing/index.html), rsynced into `RipperDocWeb/public/boardripper/` by the website repo's `deploy.sh`. Edits applied:

| Section | Change |
|---|---|
| Header (line 67-69) | Added `<!-- BR_VERSION:START/END -->` block, written by `release.sh` |
| Nav (lines 76-77) | Changelog link → `/boardripper/changelog.html`; private-repo `GitHub` link removed |
| #features (line 136) | Self-update bullet rewritten: "signed update", "no GitHub token required" |
| #docker compose example | `image:` line → `ghcr.io/alexeyinwerp/boardripper:latest` |
| #docker small print | Dropped "GitHub PAT for private repos" note |
| #download | Restructured: GHCR primary + ripperdoc.de tarball + signed manifest, dropped paused-binary lines, all GH-Releases links removed |
| #feedback | Bug-tracker line replaced with Discord/email |
| #credits | THIRD_PARTY.md link → `/boardripper/third_party.html`; "open issue" → mailto |
| `landing/README.md` | Documented BR_VERSION templating + new release-script flow |

Live at <https://www.ripperdoc.de/boardripper/>. All internal links currently 404 (expected — they're produced by `release.sh`'s first run). External links and screenshot assets verified 200.

## GitHub checklist

**One-time (before first new-system release):**

1. Generate Personal Access Token (classic) for `docker login ghcr.io`. Settings → Developer settings → Personal access tokens → Tokens (classic) → name `boardripper-ghcr-push`, scopes `write:packages` + `read:packages`. Save to `~/.config/boardripper/release.env`.
2. First image push from `release.sh` creates the GHCR package automatically.
3. Make package public: Profile → Packages → `boardripper` → Package settings → Change visibility → Public.
4. Link package to repo in same Package settings page (cosmetic; useful when repo goes public).

**Migration release (vN, one-time):**

5. Upload vN tarball to existing private GH releases page using current flow. LAST GH release.
6. vN release notes: "This release moves updates to ripperdoc.de + GHCR. You can now remove `GITHUB_TOKEN`."

**After vN ships (cleanup):**

7. Disable old release workflow. Delete or rename `.github/workflows/release.yml`.
8. Delete old repo secrets. Settings → Secrets and variables → Actions → remove `GH_TOKEN` / `GITHUB_PAT` / similar.
9. Rotate the PAT exposed in `deploy.conf` (per the security audit, that token is in plaintext in a tracked-adjacent file). Revoke immediately. Move what's left of `deploy.conf` out of the repo tree to `~/.config/boardripper-deploy/`.

**Eventual / when repo goes public:**

10. Settings → Change visibility → Public.
11. (Optional) Re-enable a thin CI workflow that mirrors the FTP tarball to a GitHub Release. Add GitHub Releases as third mirror in the next release's `SourceList`. No code changes — just an extended source list.

## One-time local setup (Mac)

12. `brew install minisign cosign lftp jq pandoc`
13. Generate signing key: `minisign -G -p ~/.config/boardripper/release.pub -s ~/.config/boardripper/release.minisign`. Strong passphrase. Save to 1Password.
14. Encrypted backup of `release.minisign` (cloud password manager attachment + USB drive). **If you lose this key, you cannot ship updates to existing installs ever again** — they reject anything signed by a new key. Plan key rotation (out of scope for v1, see Risks).
15. Generate cosign keypair: `cosign generate-key-pair` → `cosign.key` + `cosign.pub`. Use the same passphrase as the minisign key for ops convenience; back up alongside `release.minisign`.
16. Create `~/.config/boardripper/release.env` (mode 0600) with `FTP_USER`, `FTP_PASSWORD`, `GHCR_TOKEN`. Source it at top of `release.sh`.
17. Move FTP creds out of `Website/RipperDocWeb/deploy.sh` ([deploy.sh:39-41](../../../../Website/RipperDocWeb/deploy.sh#L39)) to a similar config file.

## What end-users do

Nothing. Existing `docker-compose.yml` keeps working. After vN, `GITHUB_TOKEN` becomes vestigial — they can remove it but don't have to. Toolbar update button works without any token, signed by your offline key.

## Out of scope (YAGNI)

- Auto-apply updates on schedule
- Mandatory / urgent-bypass updates
- Rollback UI / version history browser (one-step previous-image revert is automatic, but no UI)
- Multiple release channels (stable/beta/canary)
- Sigstore keyless / Fulcio
- TLS cert pinning in binary
- Per-install signing key (compartmentalisation)
- Multi-arch separate tarballs (single multi-arch OCI archive via `docker save` instead)
- Differential / delta updates

## Risks & open items

| # | Risk | Mitigation / decision needed |
|---|---|---|
| R1 | **Loss of signing key.** No way to ship updates to existing installs after key loss; they reject anything signed by a new key. | Mandatory: encrypted backup in 2 locations. v2: ship a *key-rotation* mechanism — manifest can include a "next public key" field, signed by current key, that clients adopt as trust anchor for future updates. |
| R2 | **Same-origin cookie bootstrap is best-effort, not strong auth.** Any browser that has loaded the UI gets the cookie; if a user has the UI open in one tab and visits a malicious page in another, the malicious page cannot read the cookie (HttpOnly + SameSite=Strict) but `curl`-style direct LAN access from a compromised same-LAN device still bypasses it (no cookie → 401). | Acceptable for self-hosted home/shop deployment. v2 may add real session auth if multi-user becomes a goal. |
| R3 | **Migration leaves stuck-on-vN-1 users behind.** Anyone who never clicks update on the bridge release stays forever on the old system. | Acceptable. Manual `docker pull` documented; cut `vN.0.1` nag release if needed. |
| R4 | **Counter on first install.** Fresh install has no `installed_counter`; should accept any current manifest. | Treat absent counter as 0; first manifest validates. Document. |
| R5 | **`important_reason` is signed but free-text.** A tampered mirror cannot inject a fake banner, but a compromised maintainer Mac can. | In-scope risk; same trust assumption as the entire design. |
| R6 | **`min_supported_version` must be set carefully.** If we ever bump it past a release that's still in the wild, those users get a permanent "manual update required" prompt. | Documented in release runbook; only bump when protocol-breaking. |
| R7 | **GHCR rate limits for unauthenticated pulls** (10k/hr per IP at present). | Acceptable for current install base; revisit if GHCR caps tighten. |
| R8 | **Release script is single-machine.** No CI; if the maintainer's Mac is unavailable, no releases can ship. | Acceptable for single-developer project. Cosign key portable to a second machine. |

## Implementation phases (handoff to writing-plans)

1. **Updater protocol + manifest verification** (Go side) — new `fetchSignedManifest`, drop GH code path, build flags
2. **Per-install secret + auth on `/api/update/*`** — new endpoint, frontend bootstrap fetch
3. **Healthcheck + rollback orchestrator** — new `/api/health`, modified `orchestrateRestart`
4. **Frontend banner update** — `important`/`notes_url` plumbing, two banner variants
5. **`scripts/release.sh` rewrite** — full pipeline with sign + push + FTP
6. **Local setup runbook** — `docs/RELEASE_RUNBOOK.md` documenting key generation, backup, env file
7. **Bridge release vN** — final upload to private GH releases + first run of new pipeline
8. **Cleanup** — disable old workflow, rotate `deploy.conf` PAT, delete old secrets
