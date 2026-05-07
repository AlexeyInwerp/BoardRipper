#!/usr/bin/env bash
# BoardRipper release pipeline. Runs entirely on the maintainer's Mac.
# Usage:
#   ./scripts/release.sh v0.8.0 [--important "reason"] [--dry-run]
#   DRY_RUN=true ./scripts/release.sh v0.8.0
set -euo pipefail

# --- Argument parsing ---
DRY_RUN="${DRY_RUN:-false}"
VERSION=""
IMPORTANT_FLAG="false"
IMPORTANT_REASON=""

while [ $# -gt 0 ]; do
  case "$1" in
    --important) IMPORTANT_FLAG="true"; IMPORTANT_REASON="${2:-}"; shift 2;;
    --dry-run)   DRY_RUN=true; shift;;
    -*) echo "unknown flag: $1" >&2; exit 1;;
    *) if [ -z "$VERSION" ]; then VERSION="$1"; shift; else echo "extra arg: $1" >&2; exit 1; fi;;
  esac
done

if [ -z "$VERSION" ]; then
  echo "usage: $0 v0.X.Y [--important \"reason\"] [--dry-run]" >&2
  exit 1
fi
if [[ ! "$VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(\.[a-z0-9.-]+)?$ ]]; then
  echo "version must look like v0.8.0 or v0.8.0.beta1" >&2
  exit 1
fi

# --- Configuration ---
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_DIR="${BOARDRIPPER_RELEASE_CONFIG:-$HOME/.config/boardripper}"
RELEASE_ENV="$CONFIG_DIR/release.env"

if [ ! -f "$RELEASE_ENV" ]; then
  echo "missing $RELEASE_ENV — see docs/RELEASE_RUNBOOK.md" >&2
  exit 1
fi
# shellcheck source=/dev/null
. "$RELEASE_ENV"

: "${FTP_USER:?must be set in release.env}"
: "${FTP_PASSWORD:?must be set in release.env}"
: "${GHCR_TOKEN:?must be set in release.env}"
: "${GHCR_USER:?must be set in release.env}"
: "${MINISIGN_KEY:=$CONFIG_DIR/release.minisign}"
: "${MINISIGN_PUB:=$CONFIG_DIR/release.pub}"

if [ ! -f "$MINISIGN_KEY" ]; then echo "missing $MINISIGN_KEY" >&2; exit 1; fi
if [ ! -f "$MINISIGN_PUB" ]; then echo "missing $MINISIGN_PUB" >&2; exit 1; fi

# --- Preflight ---
for cmd in docker minisign lftp jq sha256sum gzip; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "missing: $cmd" >&2; exit 1; }
done

cd "$REPO_ROOT"
if [ "$DRY_RUN" != "true" ] && [ -n "$(git status --porcelain)" ]; then
  echo "git working tree not clean — commit or stash first" >&2
  git status --short
  exit 1
fi
CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$DRY_RUN" != "true" ] && [ "$CURRENT_BRANCH" != "main" ]; then
  echo "must be on main, currently on $CURRENT_BRANCH" >&2
  exit 1
fi

# --- Counter ---
COUNTER_FILE="$REPO_ROOT/.release-counter"
PREV_COUNTER="$(cat "$COUNTER_FILE" 2>/dev/null || echo 0)"
NEW_COUNTER=$((PREV_COUNTER + 1))

echo ">>> Releasing $VERSION (counter $NEW_COUNTER)$([ "$DRY_RUN" = "true" ] && echo ' [DRY RUN]')"

# --- Sync src/frontend/package.json version with $VERSION ---
# Vite injects __APP_VERSION__ at build time from package.json. Without this
# sync, the frontend status bar shows whatever package.json said when last
# committed (e.g. 0.19.0), while the backend reports the real APP_VERSION
# from -ldflags (e.g. 0.19.4). Source of truth = the $VERSION arg here.
PKG_VERSION="${VERSION#v}"
PKG_FILE="$REPO_ROOT/src/frontend/package.json"
TMP_PKG="$(mktemp)"
jq --arg v "$PKG_VERSION" '.version = $v' "$PKG_FILE" > "$TMP_PKG"
mv "$TMP_PKG" "$PKG_FILE"
echo "    package.json -> $PKG_VERSION"

# --- Build & push multi-arch image ---
PUBKEY_B64="$(grep -v '^untrusted' "$MINISIGN_PUB" | tr -d '\n')"
SOURCES_CSV="https://ghcr.io/alexeyinwerp/boardripper,https://www.ripperdoc.de/boardripper"

if [ "$DRY_RUN" != "true" ]; then
  echo ">>> Logging into GHCR"
  echo "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USER" --password-stdin
fi

echo ">>> Building multi-arch image $VERSION"
PUSH_FLAG="--push"
[ "$DRY_RUN" = "true" ] && PUSH_FLAG="--load"
# In DRY mode --load only supports a single platform; default to host arch.
PLATFORMS="linux/amd64,linux/arm64"
[ "$DRY_RUN" = "true" ] && PLATFORMS="$(docker version -f '{{.Server.Os}}/{{.Server.Arch}}')"

docker buildx build \
  --platform "$PLATFORMS" \
  --build-arg "APP_VERSION=$VERSION" \
  --build-arg "PUBKEY=$PUBKEY_B64" \
  --build-arg "SOURCES=$SOURCES_CSV" \
  -t "ghcr.io/alexeyinwerp/boardripper:$VERSION" \
  -t "ghcr.io/alexeyinwerp/boardripper:latest" \
  $PUSH_FLAG \
  .

echo ">>> Capturing image digest"
if [ "$DRY_RUN" = "true" ]; then
  IMAGE_DIGEST="sha256:$(docker inspect ghcr.io/alexeyinwerp/boardripper:$VERSION --format '{{.Id}}' | sed 's|^sha256:||')"
else
  # Capture the multi-arch INDEX digest, not a per-platform manifest digest.
  # Earlier this used `--raw | jq '.manifests[0].digest'` which picked the
  # first platform manifest (amd64) — that signed an amd64-only digest into
  # manifest.json, which makes pull-by-digest fail on arm64 hosts because
  # the digest is platform-specific. The non-raw `imagetools inspect` output
  # has a top-level `Digest:` line that IS the index digest (resolves to
  # any platform via Docker's content negotiation).
  IMAGE_DIGEST="$(docker buildx imagetools inspect ghcr.io/alexeyinwerp/boardripper:$VERSION \
    | grep -E '^Digest:' | head -1 | awk '{print $2}')"
  if [ -z "$IMAGE_DIGEST" ]; then
    echo "ERROR: could not capture image digest from imagetools inspect" >&2
    exit 1
  fi
fi
echo "    digest: $IMAGE_DIGEST"

# --- Pin orchestrator image (alpine for in-place restart) ---
ORCHESTRATOR_IMG="alpine:3.19"
# Capture the multi-arch INDEX digest from the registry, not a per-platform
# manifest. The previous form (`docker pull --platform linux/amd64` then
# `RepoDigests[0]`) captured the amd64-only manifest digest — which makes
# pull-by-digest fail on arm64 hosts because the digest is platform-specific.
# Same bug class as the main-image fix in d720a39. `imagetools inspect` reads
# the registry's image index directly and returns the index digest, which
# Docker resolves to the right per-arch manifest at pull time.
ORCHESTRATOR_DIGEST="$(docker buildx imagetools inspect "$ORCHESTRATOR_IMG" 2>/dev/null \
  | grep -E '^Digest:' | head -1 | awk '{print $2}')"
if [ -n "$ORCHESTRATOR_DIGEST" ]; then
  ORCHESTRATOR_REF="${ORCHESTRATOR_IMG%:*}@$ORCHESTRATOR_DIGEST"
else
  echo "WARN: could not capture orchestrator index digest; falling back to tag-pinned ref" >&2
  ORCHESTRATOR_REF="$ORCHESTRATOR_IMG"
fi
echo "    orchestrator: $ORCHESTRATOR_REF"

# --- Build tarball from the pushed image ---
mkdir -p out
TARBALL="out/boardripper-$VERSION.tar.gz"

echo ">>> Saving image as tarball"
docker save "ghcr.io/alexeyinwerp/boardripper:$VERSION" | gzip > "$TARBALL"

TARBALL_SHA="$(sha256sum "$TARBALL" | awk '{print $1}')"
TARBALL_SIZE="$(stat -f %z "$TARBALL" 2>/dev/null || stat -c %s "$TARBALL")"
echo "    sha256: $TARBALL_SHA"
echo "    size:   $TARBALL_SIZE bytes"

# --- Generate manifest.json ---
RELEASED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
NOT_AFTER="$(date -u -v+90d +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '+90 days' +%Y-%m-%dT%H:%M:%SZ)"

cat > out/manifest.json <<EOF
{
  "version": "$VERSION",
  "counter": $NEW_COUNTER,
  "released_at": "$RELEASED_AT",
  "not_after": "$NOT_AFTER",
  "important": $IMPORTANT_FLAG,
  "important_reason": $(jq -Rn --arg s "$IMPORTANT_REASON" '$s'),
  "notes_url": "https://www.ripperdoc.de/boardripper/changelog.html#$VERSION",
  "tarball": {
    "url_primary": "https://www.ripperdoc.de/boardripper/releases/boardripper-$VERSION.tar.gz",
    "url_mirrors": [],
    "sha256": "$TARBALL_SHA",
    "size_bytes": $TARBALL_SIZE
  },
  "image": {
    "registry": "ghcr.io/alexeyinwerp/boardripper",
    "tag": "$VERSION",
    "digest": "$IMAGE_DIGEST"
  },
  "min_supported_version": "v0.8.0",
  "orchestrator_image_digest": "$ORCHESTRATOR_REF",
  "source_list_next": [
    "https://ghcr.io/alexeyinwerp/boardripper",
    "https://www.ripperdoc.de/boardripper"
  ]
}
EOF

jq . out/manifest.json >/dev/null

# --- Sign manifest ---
echo ">>> Signing manifest (will prompt for passphrase)"
minisign -S -s "$MINISIGN_KEY" -m out/manifest.json
# Produces out/manifest.json.minisig

# --- Build update bundle (drop-to-update fallback) ---
# A single-file archive containing manifest + signature + image tarball.
# Users drop it onto the BoardRipper UI as a recovery path when the
# in-binary updater can't reach GHCR / ripperdoc.de or has a bug.
BUNDLE="out/boardripper-update-$VERSION.tar"
tar -cf "$BUNDLE" \
  -C out \
  manifest.json \
  manifest.json.minisig \
  "boardripper-$VERSION.tar.gz"
BUNDLE_SIZE="$(stat -f %z "$BUNDLE" 2>/dev/null || stat -c %s "$BUNDLE")"
echo "    bundle: $BUNDLE ($BUNDLE_SIZE bytes)"

# --- Generate site artifacts ---
export VERSION RELEASED_AT
OUT_DIR="$REPO_ROOT/out" "$REPO_ROOT/scripts/release/site-artifacts.sh"

# --- Upload to FTP atomically ---
if [ "$DRY_RUN" != "true" ]; then
  echo ">>> Uploading to ftp.ripperdoc.de"

  STAGE="$REPO_ROOT/out/ftp-stage"
  rm -rf "$STAGE" && mkdir -p "$STAGE/boardripper/releases"
  cp out/site/index.html        "$STAGE/boardripper/index.html"
  [ -f out/site/changelog.html ]    && cp out/site/changelog.html "$STAGE/boardripper/changelog.html"
  [ -f out/site/third_party.html ]  && cp out/site/third_party.html "$STAGE/boardripper/third_party.html"
  cp out/site/releases/index.html "$STAGE/boardripper/releases/index.html"
  cp -r landing/screenshots     "$STAGE/boardripper/screenshots"
  cp out/manifest.json          "$STAGE/boardripper/manifest.json.new"
  cp out/manifest.json.minisig  "$STAGE/boardripper/manifest.json.minisig.new"
  cp "$TARBALL"                 "$STAGE/boardripper/releases/boardripper-$VERSION.tar.gz"
  cp "$TARBALL"                 "$STAGE/boardripper/releases/latest.tar.gz.new"
  cp "$BUNDLE"                  "$STAGE/boardripper/releases/boardripper-update-$VERSION.tar"
  cp "$BUNDLE"                  "$STAGE/boardripper/releases/latest-update.tar.new"

  lftp -u "$FTP_USER,$FTP_PASSWORD" "ftp.ripperdoc.de" <<LFTP_EOF
set ftp:ssl-allow no
mirror --reverse --only-newer --verbose \
  "$STAGE/boardripper" "/public_html/boardripper"

cd /public_html/boardripper
rm -f manifest.json
mv manifest.json.new manifest.json
rm -f manifest.json.minisig
mv manifest.json.minisig.new manifest.json.minisig
cd /public_html/boardripper/releases
rm -f latest.tar.gz
mv latest.tar.gz.new latest.tar.gz
rm -f latest-update.tar
mv latest-update.tar.new latest-update.tar
bye
LFTP_EOF

  echo ">>> FTP upload complete"
else
  echo ">>> [DRY RUN] Would upload manifest, signature, tarball, and site artifacts to ftp.ripperdoc.de"
fi

# --- Final local commit & tag ---
if [ "$DRY_RUN" != "true" ]; then
  echo "$NEW_COUNTER" > "$COUNTER_FILE"
  git add "$COUNTER_FILE" "$PKG_FILE"
  git commit -m "release: $VERSION (counter $NEW_COUNTER)"
  git tag "$VERSION"
  echo ">>> Local tag $VERSION created. Run 'git push origin main $VERSION' when ready."
  echo ">>> Verify: curl -I https://www.ripperdoc.de/boardripper/manifest.json"
else
  echo ">>> [DRY RUN] Counter would be $NEW_COUNTER; would tag $VERSION."
fi
