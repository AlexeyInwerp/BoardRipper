# BoardRipper release runbook

Single-command release pipeline. Runs entirely from the maintainer's Mac.

## One-time setup

### Tools

```bash
brew install minisign lftp jq docker
docker buildx create --use --name boardripper-multiarch || true
```

(v0.19.5 dropped the `pandoc` dependency — `scripts/release/site-artifacts.sh` now renders the changelog inline using `perl + sed + awk`. If you have an older clone that still references pandoc, pull main.)

### Signing key

```bash
mkdir -p ~/.config/boardripper
minisign -G -p ~/.config/boardripper/release.pub -s ~/.config/boardripper/release.minisign
```

Strong passphrase. Save it to 1Password. **Back up `release.minisign` to a second
encrypted location** (1Password attachment + USB drive). Loss = no future updates
for any existing install.

### release.env

```bash
cat > ~/.config/boardripper/release.env <<EOF
FTP_USER=ftp@ripperdoc.de
FTP_PASSWORD=<from 1Password>
GHCR_USER=alexeyinwerp
GHCR_TOKEN=<github PAT, write:packages scope>
EOF
chmod 600 ~/.config/boardripper/release.env
```

### GHCR

1. github.com → Settings → Developer settings → Personal access tokens → Tokens (classic).
2. Generate new token, scope: `write:packages` + `read:packages`. Save to `release.env`.
3. After your first `release.sh` run, github.com → Profile → Packages → `boardripper` → Package settings → Change visibility → Public.

## Per-release flow

```bash
cd ~/Desktop/Boardviewer
git pull
# (edit CHANGELOG.md with new entry)
./scripts/release.sh v0.19.1
# (or with important flag:)
./scripts/release.sh v0.19.1 --important "Security fix: unauthenticated update endpoint"
```

The script will:

1. Validate working tree is clean and on `main`.
2. Increment `.release-counter`.
3. Build multi-arch image, push to `ghcr.io/alexeyinwerp/boardripper`.
4. Save image as tarball with sha256.
5. Generate manifest.json (filling counter / sha / digest / important).
6. Prompt for minisign passphrase to sign manifest.
7. Render landing-page version block, changelog.html, third_party.html.
8. Upload via lftp to ftp.ripperdoc.de with atomic renames.
9. Commit counter bump and create local git tag.

After the script finishes:

```bash
git push origin main v0.19.1
curl -I https://www.ripperdoc.de/boardripper/manifest.json
curl https://www.ripperdoc.de/boardripper/manifest.json | jq .
```

To verify the manifest signature against the published public key:

```bash
curl -s https://www.ripperdoc.de/boardripper/manifest.json -o /tmp/m.json
curl -s https://www.ripperdoc.de/boardripper/manifest.json.minisig -o /tmp/m.json.minisig
minisign -V -p ~/.config/boardripper/release.pub -m /tmp/m.json
```

### Version string conventions

- `v0.19.0` — release
- `v0.19.0.beta1`, `v0.19.0.rc1` — pre-release with **dot-delimited** suffix (NOT hyphens)
- The script's regex enforces this; `v0.19.0-beta1` will be rejected.

### Dry run

```bash
./scripts/release.sh v0.19.1 --dry-run
```

Builds the image locally (single-arch), generates and signs the manifest, renders site artifacts, but skips:
- GHCR push
- FTP upload
- Counter persist
- Git tag/commit

Useful for validating the pipeline after schema or script changes.

## Bridge release (v0.19.0 — completed 2026-05-06)

The bridge release (v0.19.0) was shipped to BOTH the old GitHub Releases page
(via the legacy CI, which triggered on tag push) AND the new GHCR + ripperdoc.de
pipeline. Existing v0.18.x clients picked it up via their old token-based path.

**Lesson learned:** the legacy `release.yml` workflow was not disabled before the
bridge tag was pushed. The CI rebuilt the image without the new `PUBKEY`/`SOURCES`
build args, producing a tarball with an empty PubKey that broke `Check()` for
any client that pulled the GH-Releases asset instead of GHCR. Fix was to
`docker pull ghcr.io/alexeyinwerp/boardripper:v0.19.0` manually on affected
installs. **Disable the legacy workflow BEFORE pushing any bridge tag.** See
`feedback_disable_legacy_workflow_before_bridge_tag.md` in agent memory.

The bridge is complete. From v0.19.1 onward, only the new pipeline is used:
- `.github/workflows/release.yml` renamed to `.disabled` (commit `7200694`)
- Existing installs no longer need `GITHUB_TOKEN`

## Cleanup after bridge release (v0.19.0 — pending)

1. ~~Delete or rename `.github/workflows/release.yml`~~ — done (commit `7200694`).
2. github.com → repo Settings → Secrets and variables → Actions → remove old `GH_TOKEN`/`GITHUB_PAT` secrets.
3. **Delete the legacy maintainer PAT after the public flip.** github.com → Developer settings → Personal access tokens → revoke any fine-grained token still scoped to `BoardRipper` (it was previously needed to fetch updates from a private repo; once the repo is public, no token is required for cloning or pulling images). The deploy scripts no longer read `github_token:` from `deploy.conf`.

## Recovery

- **Bad release shipped:** the in-container updater auto-rolls-back if `/api/health` fails for 60s. For irreversible damage, cut `vX.Y.Z+1` immediately with the fix.
- **Manual rollback to the previous image:** the orchestrator tags the prior image as `boardripper:previous` before each swap, so any host with a working Docker daemon can revert to it without the auto-rollback path:
  ```bash
  docker stop boardripper
  docker rename boardripper boardripper-broken         # keep for forensics
  docker run -d --name boardripper [original flags] boardripper:previous
  ```
  The original flags (volumes, port bindings, env, restart policy) come from the user's `docker-compose.yml` — `docker compose up -d` against an unchanged compose file plus `image: boardripper:previous` will recreate the container correctly.
- **Lost signing key:** no recovery for existing installs. Cut a new key, ship a new bridge release as a **manual** download (no auto-update path will work). Tell users to `docker pull` it.
- **GHCR down:** clients fall through to ripperdoc.de tarball automatically. No action needed.
- **ripperdoc.de down:** clients use GHCR. Restore the FTP host at leisure.
- **Manifest counter regression:** if a release.sh failure leaves `.release-counter` ahead of the published manifest, the next run will skip a counter value (no harm; counter just needs to be monotonic, not gap-free). Note: clients track an independent counter at `/data/.update-counter`; if that file is wiped (e.g. user reset their data volume) the install is treated as a fresh first-install — counter check is skipped on the first manifest accepted. Freshness check still bites.
- **Release pause exceeding 30 days:** clients reject any `released_at` older than 30d (defence against compromised-mirror replay of stale-but-signed manifests). If you don't cut a release in a month, all clients will stop seeing updates until you re-sign and republish — they'll keep running their installed version, just stop checking. The fix is to cut **any** release (even a no-op patch bump): the new manifest's `released_at` advances and clients resume normally. This is intentional, not a bug; surface it to anyone who pings about a stale install.
- **In-binary updater is broken** (e.g. orchestrator bug, network fully blocked, GHCR + ripperdoc.de both unreachable): tell affected users to drop the bundle file. Each release also publishes `boardripper-update-vX.Y.Z.tar` (alias `latest-update.tar`) on FTP. Users download it, drag it onto the BoardRipper window, confirm — the running container verifies the signature, applies the update, restarts. Same trust envelope as the network path; only the manifest signature grants trust. This is the recovery escape-hatch for any future broken-self-update situation, but only works if the running container's binary already speaks the bundle protocol (v0.19.5+).

## Files written by the pipeline

After a successful release, the following are uploaded to `ftp.ripperdoc.de:/public_html/boardripper/`:

- `manifest.json` (signed)
- `manifest.json.minisig` (Ed25519 signature)
- `index.html` (landing page with version-block templated)
- `changelog.html` (rendered from CHANGELOG.md)
- `third_party.html` (rendered from THIRD_PARTY.md, if present)
- `releases/boardripper-vX.Y.Z.tar.gz` (the OCI image archive)
- `releases/latest.tar.gz` (copy of the same, atomic-renamed)
- `releases/boardripper-update-vX.Y.Z.tar` (drop-to-update bundle: manifest + signature + tarball, single file)
- `releases/latest-update.tar` (copy of the same, atomic-renamed)
- `releases/index.html` (release index page)
- `screenshots/*.png` (landing-page assets)

The atomic `.new`-then-rename trick on the manifest and `latest.tar.gz` ensures clients downloading mid-upload never see a half-written file.
