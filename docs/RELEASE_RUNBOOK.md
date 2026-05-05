# BoardRipper release runbook

Single-command release pipeline. Runs entirely from the maintainer's Mac.

## One-time setup

### Tools

```bash
brew install minisign lftp jq pandoc docker
docker buildx create --use --name boardripper-multiarch || true
```

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
./scripts/release.sh v0.8.1
# (or with important flag:)
./scripts/release.sh v0.8.1 --important "Security fix: unauthenticated update endpoint"
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
git push origin main v0.8.1
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

- `v0.8.0` — release
- `v0.8.0.beta1`, `v0.8.0.rc1` — pre-release with **dot-delimited** suffix (NOT hyphens)
- The script's regex enforces this; `v0.8.0-beta1` will be rejected.

### Dry run

```bash
./scripts/release.sh v0.8.1 --dry-run
```

Builds the image locally (single-arch), generates and signs the manifest, renders site artifacts, but skips:
- GHCR push
- FTP upload
- Counter persist
- Git tag/commit

Useful for validating the pipeline after schema or script changes.

## Bridge release (vN, one-time only)

The first release using the new pipeline must also be uploaded to the existing private GitHub releases page so existing token-using clients pick it up via the old code path. After they update once, they're on the new system.

1. Run `./scripts/release.sh v0.8.0` as normal.
2. Take `out/boardripper-v0.8.0.tar.gz` and upload to github.com → Releases → Draft new release for tag `v0.8.0` (existing flow).
3. Release notes: *"This release moves updates to ripperdoc.de + GHCR. You can remove `GITHUB_TOKEN` from your `docker-compose.yml` after this update."*

## Cleanup after vN ships

1. Delete or rename `.github/workflows/release.yml` so accidental tag pushes don't re-trigger old CI.
2. github.com → repo Settings → Secrets and variables → Actions → remove old `GH_TOKEN`/`GITHUB_PAT` secrets.
3. **Rotate the leaked PAT in `deploy.conf`.** github.com → revoke `github_pat_11ADU6R5I0…`. Move what's left of `deploy.conf` to `~/.config/boardripper-deploy/`.

## Recovery

- **Bad release shipped:** the in-container updater auto-rolls-back if `/api/health` fails for 60s. For irreversible damage, cut `vX.Y.Z+1` immediately with the fix.
- **Lost signing key:** no recovery for existing installs. Cut a new key, ship a new bridge release as a **manual** download (no auto-update path will work). Tell users to `docker pull` it.
- **GHCR down:** clients fall through to ripperdoc.de tarball automatically. No action needed.
- **ripperdoc.de down:** clients use GHCR. Restore the FTP host at leisure.
- **Manifest counter regression:** if a release.sh failure leaves `.release-counter` ahead of the published manifest, the next run will skip a counter value (no harm; counter just needs to be monotonic, not gap-free).

## Files written by the pipeline

After a successful release, the following are uploaded to `ftp.ripperdoc.de:/public_html/boardripper/`:

- `manifest.json` (signed)
- `manifest.json.minisig` (Ed25519 signature)
- `index.html` (landing page with version-block templated)
- `changelog.html` (rendered from CHANGELOG.md)
- `third_party.html` (rendered from THIRD_PARTY.md, if present)
- `releases/boardripper-vX.Y.Z.tar.gz` (the OCI image archive)
- `releases/latest.tar.gz` (copy of the same, atomic-renamed)
- `releases/index.html` (release index page)
- `screenshots/*.png` (landing-page assets)

The atomic `.new`-then-rename trick on the manifest and `latest.tar.gz` ensures clients downloading mid-upload never see a half-written file.
