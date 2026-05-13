#!/usr/bin/env bash
# BoardRipper unified release pipeline. Runs entirely on the maintainer's Mac.
#
# Owns end-to-end:
#   1. Working-tree / branch / tag-collision / CHANGELOG gates
#   2. tsc + go preflight
#   3. Docker multi-arch build → push to GHCR
#   4. Update-test harness (sanity gate against the just-built image)
#   5. Sign manifest, build drop-bundle, FTP-upload to ripperdoc.de
#   6. Optional Electron desktop builds (mac universal, mac legacy, win) + smoke check
#   7. Commit (counter + package.json), tag, push
#   8. GitHub Release with sliced CHANGELOG notes + (if built) desktop zips
#
# Usage:
#   ./scripts/release.sh v0.X.Y [flags]
#
# Flags:
#   --important "reason"   Mark this release as important (red banner in UI)
#   --desktop              Build Electron desktop apps (skip prompt)
#   --no-desktop           Skip desktop build (skip prompt)
#   --desktop-only         Desktop + GH release only — skip Docker/FTP/counter
#   --skip-update-test     Skip the update-test sanity gate (default: run it)
#   --no-push              Don't push commit/tag to origin
#   --no-gh-release        Don't create a GitHub Release
#   --dry-run              Skip GHCR push, FTP, update-test, git push, GH release
set -euo pipefail

# --- Argument parsing ---
DRY_RUN="${DRY_RUN:-false}"
VERSION=""
IMPORTANT_FLAG="false"
IMPORTANT_REASON=""
DESKTOP_MODE="ask"          # ask | on | off | only
SKIP_UPDATE_TEST="false"
NO_PUSH="false"
NO_GH_RELEASE="false"

while [ $# -gt 0 ]; do
  case "$1" in
    --important)        IMPORTANT_FLAG="true"; IMPORTANT_REASON="${2:-}"; shift 2;;
    --desktop)          DESKTOP_MODE="on"; shift;;
    --no-desktop)       DESKTOP_MODE="off"; shift;;
    --desktop-only)     DESKTOP_MODE="only"; shift;;
    --skip-update-test) SKIP_UPDATE_TEST="true"; shift;;
    --no-push)          NO_PUSH="true"; shift;;
    --no-gh-release)    NO_GH_RELEASE="true"; shift;;
    --dry-run)          DRY_RUN=true; shift;;
    -*) echo "unknown flag: $1" >&2; exit 1;;
    *)  if [ -z "$VERSION" ]; then VERSION="$1"; shift
        else echo "extra arg: $1" >&2; exit 1; fi;;
  esac
done

if [ -z "$VERSION" ]; then
  cat >&2 <<'EOF'
usage: ./scripts/release.sh v0.X.Y [flags]
  --important "reason"   mark release important (red banner)
  --desktop              build Electron apps (skip prompt)
  --no-desktop           skip desktop builds (skip prompt)
  --desktop-only         desktop + GH release only (skip Docker/FTP/counter)
  --skip-update-test     skip the update-test sanity gate
  --no-push              don't push commit/tag
  --no-gh-release        don't create a GitHub Release
  --dry-run              skip external side effects
EOF
  exit 1
fi
if [[ ! "$VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(\.[a-z0-9.-]+)?$ ]]; then
  echo "version must look like v0.8.0 or v0.8.0.beta1" >&2
  exit 1
fi

IS_DESKTOP_ONLY="false"
[ "$DESKTOP_MODE" = "only" ] && IS_DESKTOP_ONLY="true"

# Pre-release detection — gates --latest on the GitHub Release
PRERELEASE="false"
if [[ "$VERSION" =~ \.(beta|rc|alpha)[0-9]*$ ]]; then
  PRERELEASE="true"
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

if [ "$IS_DESKTOP_ONLY" = "false" ]; then
  : "${FTP_USER:?must be set in release.env}"
  : "${FTP_PASSWORD:?must be set in release.env}"
  : "${GHCR_TOKEN:?must be set in release.env}"
  : "${GHCR_USER:?must be set in release.env}"
fi
: "${MINISIGN_KEY:=$CONFIG_DIR/release.minisign}"
: "${MINISIGN_PUB:=$CONFIG_DIR/release.pub}"

if [ "$IS_DESKTOP_ONLY" = "false" ]; then
  if [ ! -f "$MINISIGN_KEY" ]; then echo "missing $MINISIGN_KEY" >&2; exit 1; fi
  if [ ! -f "$MINISIGN_PUB" ]; then echo "missing $MINISIGN_PUB" >&2; exit 1; fi
fi

# --- Preflight: tool presence ---
REQUIRED_CMDS=(git jq gh)
if [ "$IS_DESKTOP_ONLY" = "false" ]; then
  REQUIRED_CMDS+=(docker minisign lftp gzip)
fi
if [ "$DESKTOP_MODE" != "off" ]; then
  # node needed for `ask` (might say yes), `on`, and `only`
  REQUIRED_CMDS+=(node)
fi
for cmd in "${REQUIRED_CMDS[@]}"; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "missing: $cmd" >&2; exit 1; }
done

# macOS BSD lacks sha256sum by default — shim to shasum -a 256 (same output).
if ! command -v sha256sum >/dev/null 2>&1; then
  sha256sum() { shasum -a 256 "$@"; }
fi

cd "$REPO_ROOT"

# --- Working tree + branch gate ---
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

# --- Tag-collision gate ---
if [ "$DRY_RUN" != "true" ]; then
  if git rev-parse "refs/tags/$VERSION" >/dev/null 2>&1; then
    LOCAL_TAG_SHA="$(git rev-parse "refs/tags/$VERSION")"
    cat >&2 <<EOF
ERROR: tag $VERSION already exists locally at $LOCAL_TAG_SHA
To re-cut this version, delete it first:
  git tag -d $VERSION && git push origin :refs/tags/$VERSION
EOF
    exit 1
  fi
  if git ls-remote --tags --exit-code origin "refs/tags/$VERSION" >/dev/null 2>&1; then
    cat >&2 <<EOF
ERROR: tag $VERSION already exists on origin
To re-cut: git push origin :refs/tags/$VERSION
EOF
    exit 1
  fi
fi

# --- CHANGELOG gate ---
# Look for "## v0.X.Y" at start of line, optionally followed by space/EOL/em-dash.
# (regex dot is over-permissive but the risk of a false positive is negligible)
if ! grep -qE "^## ${VERSION}( |$|—| —)" "$REPO_ROOT/CHANGELOG.md"; then
  cat >&2 <<EOF
ERROR: CHANGELOG.md has no '## $VERSION' entry.
Add the release notes section at the top, then re-run.
EOF
  exit 1
fi
echo "    CHANGELOG.md has $VERSION entry ✓"

# --- Pre-flight: type-check + go build ---
echo ">>> Pre-flight: tsc --noEmit (frontend)"
(cd "$REPO_ROOT/src/frontend" \
  && rm -f tsconfig.tsbuildinfo tsconfig.app.tsbuildinfo \
  && npx tsc -b --noEmit)
echo ">>> Pre-flight: go build ./... (backend)"
(cd "$REPO_ROOT/src/backend" && go build ./...)

# --- Desktop build decision (resolve `ask` to on/off) ---
if [ "$DESKTOP_MODE" = "ask" ]; then
  if [ -t 0 ] && [ "$DRY_RUN" != "true" ]; then
    read -r -p "Build desktop Electron apps too? [y/N] " yn
    case "$yn" in [yY]*) DESKTOP_MODE="on";; *) DESKTOP_MODE="off";; esac
  else
    DESKTOP_MODE="off"
  fi
fi
case "$DESKTOP_MODE" in
  on)   echo "    Desktop: building macOS universal + macOS legacy + Windows x64";;
  off)  echo "    Desktop: skipping";;
  only) echo "    Desktop-only: skipping Docker pipeline, no counter bump";;
esac

# --- Counter prep ---
COUNTER_FILE="$REPO_ROOT/.release-counter"
PREV_COUNTER="$(cat "$COUNTER_FILE" 2>/dev/null || echo 0)"
if [ "$IS_DESKTOP_ONLY" = "false" ]; then
  NEW_COUNTER=$((PREV_COUNTER + 1))
  echo ">>> Releasing $VERSION (counter $NEW_COUNTER)$([ "$DRY_RUN" = "true" ] && echo ' [DRY RUN]')"
else
  NEW_COUNTER=$PREV_COUNTER
  echo ">>> Releasing $VERSION (electron-only, counter unchanged at $PREV_COUNTER)"
fi

# --- Sync src/frontend/package.json version with $VERSION ---
PKG_VERSION="${VERSION#v}"
PKG_FILE="$REPO_ROOT/src/frontend/package.json"
TMP_PKG="$(mktemp)"
jq --arg v "$PKG_VERSION" '.version = $v' "$PKG_FILE" > "$TMP_PKG"
mv "$TMP_PKG" "$PKG_FILE"
echo "    package.json -> $PKG_VERSION"

# ════════════════════════════════════════════════════════════════════════
#   DOCKER PIPELINE (skipped in --desktop-only)
# ════════════════════════════════════════════════════════════════════════
if [ "$IS_DESKTOP_ONLY" = "false" ]; then
  PUBKEY_B64="$(grep -v '^untrusted' "$MINISIGN_PUB" | tr -d '\n')"
  # ripperdoc.de is the only manifest source. The image at GHCR
  # (ghcr.io/alexeyinwerp/boardripper@<digest>) is still used during Apply for
  # pull-by-digest — that's an OCI Distribution v2 endpoint, totally different
  # protocol — but GHCR cannot serve `/manifest.json`. The previous form here
  # also listed `https://ghcr.io/alexeyinwerp/boardripper` as a Check() source;
  # every install ever shipped wasted one HTTP request on a guaranteed
  # 405 there before falling through to ripperdoc.de.
  SOURCES_CSV="https://www.ripperdoc.de/boardripper"

  if [ "$DRY_RUN" != "true" ]; then
    echo ">>> Logging into GHCR"
    echo "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USER" --password-stdin
  fi

  echo ">>> Building multi-arch image $VERSION"
  PUSH_FLAG="--push"
  [ "$DRY_RUN" = "true" ] && PUSH_FLAG="--load"
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
    # Multi-arch INDEX digest (resolves to per-arch manifest at pull time).
    # `--raw | jq '.manifests[0].digest'` would grab the amd64-only manifest
    # and break arm64 clients (see commit d720a39).
    IMAGE_DIGEST="$(docker buildx imagetools inspect ghcr.io/alexeyinwerp/boardripper:$VERSION \
      | grep -E '^Digest:' | head -1 | awk '{print $2}')"
    if [ -z "$IMAGE_DIGEST" ]; then
      echo "ERROR: could not capture image digest from imagetools inspect" >&2
      exit 1
    fi
  fi
  echo "    digest: $IMAGE_DIGEST"

  # --- Update-test sanity gate ---
  # Runs the e2e harness which builds its own OLD/NEW images locally and drives
  # Playwright through apply→swap→reload. Catches updater-code regressions
  # BEFORE we sign and publish a manifest that clients would actually apply.
  # GHCR has an orphan tag if this fails, but no signed manifest references it,
  # so no client picks it up. Recoverable.
  if [ "$SKIP_UPDATE_TEST" = "false" ] && [ "$DRY_RUN" != "true" ]; then
    echo ">>> Running update-test harness (sanity gate, ~1 min)"
    echo "    (skip with --skip-update-test if you really must)"
    "$REPO_ROOT/tools/update-test/run.sh"
    echo "    update-test passed ✓"
  elif [ "$SKIP_UPDATE_TEST" = "true" ]; then
    echo "WARN: update-test harness SKIPPED via --skip-update-test"
  fi

  # --- Pin orchestrator image (alpine for in-place restart) ---
  ORCHESTRATOR_IMG="alpine:3.19"
  # INDEX digest (same arm64 trap as above — see commit 7f631cd).
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
    "https://www.ripperdoc.de/boardripper"
  ]
}
EOF

  jq . out/manifest.json >/dev/null

  # minisign reads the password from stdin when stdin isn't a tty. Set
  # MINISIGN_PASSWORD in ~/.config/boardripper/release.env to drive it
  # non-interactively (required when invoking from chat / CI / cron); fall
  # back to an interactive prompt for hands-on runs.
  if [ -n "${MINISIGN_PASSWORD:-}" ]; then
    echo ">>> Signing manifest (using MINISIGN_PASSWORD from release.env)"
    printf '%s\n' "$MINISIGN_PASSWORD" | minisign -S -s "$MINISIGN_KEY" -m out/manifest.json
  else
    echo ">>> Signing manifest (will prompt for passphrase — set MINISIGN_PASSWORD in release.env to skip)"
    minisign -S -s "$MINISIGN_KEY" -m out/manifest.json
  fi
  # Produces out/manifest.json.minisig

  # --- Build drop-to-update bundle (recovery escape-hatch) ---
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
    [ -f out/site/archive.html ]      && cp out/site/archive.html "$STAGE/boardripper/archive.html"
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

    # --- Post-upload verify: manifest reachable + claims target version ---
    sleep 2  # small CDN propagation slack
    LIVE_VERSION="$(curl -sf https://www.ripperdoc.de/boardripper/manifest.json \
      | jq -r '.version // empty' 2>/dev/null || true)"
    if [ "$LIVE_VERSION" != "$VERSION" ]; then
      echo "WARN: published manifest reports version=$LIVE_VERSION (expected $VERSION)." >&2
      echo "WARN: CDN may still be propagating. Re-check in a minute:" >&2
      echo "      curl -s https://www.ripperdoc.de/boardripper/manifest.json | jq .version" >&2
    else
      echo "    manifest live at $VERSION ✓"
    fi
  else
    echo ">>> [DRY RUN] Would upload manifest, signature, tarball, and site artifacts to ftp.ripperdoc.de"
  fi
fi

# ════════════════════════════════════════════════════════════════════════
#   DESKTOP ELECTRON BUILDS
#   Triggered by --desktop OR --desktop-only OR interactive y at the prompt.
# ════════════════════════════════════════════════════════════════════════
DESKTOP_ZIPS=()
if [ "$DESKTOP_MODE" = "on" ] || [ "$IS_DESKTOP_ONLY" = "true" ]; then
  # Build log MUST live outside desktop/ — otherwise @electron/universal merges
  # arm64+x64 builds and bails on the SHA-mismatch of the live-tailing log file.
  DESKTOP_BUILD_LOG="/tmp/boardripper-desktop-${VERSION}.log"
  echo ">>> Building Electron desktop apps (log: $DESKTOP_BUILD_LOG)"
  (cd "$REPO_ROOT/desktop" && node build-all.mjs > "$DESKTOP_BUILD_LOG" 2>&1) || {
    echo "ERROR: desktop build failed; tail of log:" >&2
    tail -30 "$DESKTOP_BUILD_LOG" >&2
    exit 1
  }

  MAC_ZIP="$REPO_ROOT/desktop/out/BoardRipper-macOS-universal-$VERSION.zip"
  LEG_ZIP="$REPO_ROOT/desktop/out-legacy/BoardRipper-Legacy-macOS-x64-$VERSION.zip"
  WIN_ZIP="$REPO_ROOT/desktop/out-win/BoardRipper-Windows-x64-$VERSION.zip"

  for zip in "$MAC_ZIP" "$LEG_ZIP" "$WIN_ZIP"; do
    [ -f "$zip" ] || { echo "ERROR: missing $zip" >&2; exit 1; }
    unzip -tq "$zip" >/dev/null || { echo "ERROR: $zip failed integrity check" >&2; exit 1; }
  done

  # NOTE on signing: BoardRipper desktop bundles are intentionally unsigned —
  # the project doesn't carry a paid Apple Developer ID, and users open via
  # right-click → Open on first launch (this is documented in every desktop
  # release page). We do NOT run `codesign --verify` here because it would
  # fail with "code object is not signed at all" on every release. The
  # `unzip -tq` integrity check above is the meaningful gate.

  DESKTOP_ZIPS=("$MAC_ZIP" "$LEG_ZIP" "$WIN_ZIP")
  echo "    desktop builds verified ✓"
fi

# ════════════════════════════════════════════════════════════════════════
#   COMMIT, TAG, PUSH, GITHUB RELEASE
# ════════════════════════════════════════════════════════════════════════
if [ "$DRY_RUN" = "true" ]; then
  echo ">>> [DRY RUN] Would commit, tag $VERSION, push, and create GH release"
  if [ "$IS_DESKTOP_ONLY" = "false" ]; then
    echo "    Counter would be $NEW_COUNTER."
  fi
  exit 0
fi

# --- Commit ---
if [ "$IS_DESKTOP_ONLY" = "true" ]; then
  COMMIT_MSG="release: $VERSION (electron-only)"
  git add "$PKG_FILE"
else
  echo "$NEW_COUNTER" > "$COUNTER_FILE"
  COMMIT_MSG="release: $VERSION (counter $NEW_COUNTER)"
  git add "$COUNTER_FILE" "$PKG_FILE"
fi
# Empty-stage check: package.json may already be at target (e.g. release.sh
# bumped it but later step failed; user re-runs after fixing). No-op commit.
if [ -z "$(git diff --cached --name-only)" ]; then
  echo "    No staged changes; skipping release commit"
else
  git commit -m "$COMMIT_MSG"
  echo "    committed: $COMMIT_MSG"
fi

# --- Tag ---
git tag "$VERSION"
echo "    tagged $VERSION at $(git rev-parse HEAD)"

# --- Push ---
if [ "$NO_PUSH" = "true" ]; then
  echo ">>> Skipping git push (--no-push). Run manually: git push origin main $VERSION"
else
  echo ">>> Pushing main + $VERSION to origin"
  git push origin main "$VERSION"
fi

# --- GitHub Release ---
GH_RELEASE_URL=""
if [ "$NO_GH_RELEASE" = "true" ]; then
  echo ">>> Skipping GitHub Release (--no-gh-release)."
elif [ "$NO_PUSH" = "true" ]; then
  echo ">>> Skipping GitHub Release (can't reference an unpushed tag)."
else
  echo ">>> Creating GitHub Release $VERSION"
  NOTES_FILE="$(mktemp -t boardripper-release-notes)"
  # Slice the v$VERSION section out of CHANGELOG.md.
  awk -v v="$VERSION" '
    BEGIN { in_section = 0 }
    /^## v/ {
      if (in_section) exit
      if ($0 ~ "^## " v "( |$|—| —)") { in_section = 1; print; next }
    }
    in_section { print }
  ' "$REPO_ROOT/CHANGELOG.md" > "$NOTES_FILE"

  if [ ! -s "$NOTES_FILE" ]; then
    echo "WARN: extracted CHANGELOG section is empty; using generic body" >&2
    printf "Release %s\n\nSee https://www.ripperdoc.de/boardripper/changelog.html#%s\n" \
      "$VERSION" "$VERSION" > "$NOTES_FILE"
  fi

  GH_ARGS=(--title "BoardRipper $VERSION" --notes-file "$NOTES_FILE")
  if [ "$PRERELEASE" = "true" ]; then
    GH_ARGS+=(--prerelease)
  else
    GH_ARGS+=(--latest)
  fi
  if [ ${#DESKTOP_ZIPS[@]} -gt 0 ]; then
    GH_ARGS+=("${DESKTOP_ZIPS[@]}")
  fi
  gh release create "$VERSION" "${GH_ARGS[@]}"
  GH_RELEASE_URL="https://github.com/AlexeyInwerp/BoardRipper/releases/tag/$VERSION"
  echo "    $GH_RELEASE_URL"
  rm -f "$NOTES_FILE"
fi

# ════════════════════════════════════════════════════════════════════════
#   SUMMARY
# ════════════════════════════════════════════════════════════════════════
echo
echo "════════════════════════════════════════════════════════════════════"
echo "  Released $VERSION"
echo "════════════════════════════════════════════════════════════════════"
if [ "$IS_DESKTOP_ONLY" = "false" ]; then
  echo "  Docker image:    ghcr.io/alexeyinwerp/boardripper:$VERSION"
  echo "  Image digest:    $IMAGE_DIGEST"
  echo "  Manifest:        https://www.ripperdoc.de/boardripper/manifest.json"
  echo "  Counter:         $NEW_COUNTER"
fi
[ "$NO_PUSH" = "false" ] && echo "  Git tag:         pushed to origin"
[ -n "$GH_RELEASE_URL" ] && echo "  GitHub Release:  $GH_RELEASE_URL"
if [ ${#DESKTOP_ZIPS[@]} -gt 0 ]; then
  echo "  Desktop zips:"
  for z in "${DESKTOP_ZIPS[@]}"; do echo "    - $(basename "$z")"; done
fi
echo
