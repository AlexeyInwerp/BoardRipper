#!/usr/bin/env bash
#
# BoardRipper release pipeline — CI first, local fallback on artifact-quota failure.
#
# Normal path: bump package.json, commit, tag, push — GitHub Actions builds
# and uploads seven release assets. When the repo's Actions artifact storage
# quota is exhausted ("Failed to CreateArtifact: storage quota has been hit",
# recalculated every 6–12 h), this script automatically falls back to
# reproducing every asset locally and publishing via `gh release`.
#
# Playbook reference: docs/RELEASE_FALLBACK.md
#
# Usage:
#   scripts/release.sh v0.8.0              # full: preflight → push → CI or local
#   scripts/release.sh v0.8.0 --local      # skip CI entirely (build locally)
#   scripts/release.sh v0.8.0 --resume     # tag already pushed: just monitor / fall back
#
set -euo pipefail

VERSION="${1:-}"
[ -z "$VERSION" ] && {
  echo "Usage: $0 <version> [--local|--resume]" >&2
  exit 2
}
[[ "$VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$ ]] || {
  echo "Version must look like vX.Y.Z or vX.Y.Z-beta.N (got: $VERSION)" >&2
  exit 2
}
shift

MODE=""
for arg in "$@"; do
  case "$arg" in
    --local) MODE="local" ;;
    --resume) MODE="resume" ;;
    *) echo "Unknown flag: $arg" >&2; exit 2 ;;
  esac
done

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"
[ "$(basename "$(git remote get-url origin)")" = "BoardRipper.git" ] || {
  echo "Not the BoardRipper repo (origin is $(git remote get-url origin))" >&2
  exit 1
}

STAGE="/tmp/release-$VERSION"
ARTIFACTS="$STAGE/artifacts"
FRONT_DIST="$REPO_ROOT/src/frontend/dist"

log() { printf '\033[1;34m[release]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[release]\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31m[release]\033[0m %s\n' "$*" >&2; exit 1; }

# ── Preflight ─────────────────────────────────────────────────────────────
preflight() {
  log "Preflight: clean tsbuildinfo, eslint, tsc, go build"
  ( cd src/frontend \
    && rm -f tsconfig.tsbuildinfo tsconfig.app.tsbuildinfo \
    && npx eslint . --max-warnings 80 \
    && npx tsc -b --noEmit ) || die "Frontend preflight failed"
  ( cd src/backend && go build ./... ) || die "Go build failed"
}

# ── Bump package.json + commit + tag + push ──────────────────────────────
push_tag() {
  local target="${VERSION#v}"
  local current
  current=$(node -p "require('./src/frontend/package.json').version")
  if [ "$current" != "$target" ]; then
    log "Bumping package.json: $current → $target"
    # Use Node to rewrite JSON so we don't depend on sed -i platform differences.
    node -e "
      const fs = require('fs');
      const p = 'src/frontend/package.json';
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      j.version = '$target';
      fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
    "
    git add src/frontend/package.json
    git commit -m "release: $VERSION"
  else
    log "package.json already at $target"
  fi
  if git tag --list "$VERSION" | grep -qx "$VERSION"; then
    log "Tag $VERSION already exists locally"
  else
    git tag "$VERSION"
  fi
  log "Pushing main + $VERSION"
  git push origin main "$VERSION"
}

# ── CI monitoring ────────────────────────────────────────────────────────
# Look up the Release workflow run associated with this tag. Tags trigger a
# workflow on branch 'v0.8.0' (the tag name), so we filter by displayTitle
# commit match rather than branch.
ci_run_id_for_tag() {
  gh run list --workflow=Release --limit 10 \
    --json databaseId,headBranch,headSha,conclusion,status \
    --jq "map(select(.headBranch == \"$VERSION\")) | .[0].databaseId" 2>/dev/null
}

# Classify a finished run: success | quota | fail
# Quota = any "CreateArtifact: ... storage quota" message in failed logs.
classify_failed_run() {
  local id="$1"
  # Stage logs to a variable first: piping `gh run view` directly into
  # `grep -q` under `set -o pipefail` makes grep close stdin on the first
  # match, which gives `gh` SIGPIPE → the pipeline returns gh's 141 exit
  # code → the if below treats a real quota failure as non-quota and
  # falls through to die(). Reading once, grepping once is unambiguous.
  local logs
  logs=$(gh run view "$id" --log-failed 2>/dev/null) || true
  if printf '%s\n' "$logs" | grep -qiE 'storage quota has been hit|Failed to CreateArtifact.*quota'; then
    echo "quota"
  else
    echo "fail"
  fi
}

# Returns: running | success | quota | fail | none
ci_status() {
  local id status conclusion
  id=$(ci_run_id_for_tag)
  [ -z "$id" ] && { echo "none"; return; }
  status=$(gh run view "$id" --json status --jq '.status' 2>/dev/null || echo "unknown")
  [ "$status" = "in_progress" ] || [ "$status" = "queued" ] && { echo "running"; return; }
  conclusion=$(gh run view "$id" --json conclusion --jq '.conclusion' 2>/dev/null || echo "")
  [ "$conclusion" = "success" ] && { echo "success"; return; }
  classify_failed_run "$id"
}

# Poll up to 30 min. Returns 0 on success, 2 on quota, 1 otherwise.
wait_for_ci() {
  local timeout=1800 start=$SECONDS
  while : ; do
    local st; st=$(ci_status)
    case "$st" in
      running) log "CI running… ($((SECONDS - start))s elapsed)"; sleep 30 ;;
      success) return 0 ;;
      quota)   warn "CI blocked by artifact storage quota — falling back to local build"; return 2 ;;
      fail)    die "CI failed for a non-quota reason — run 'gh run view' and fix the code" ;;
      none)    die "No Release workflow run found for $VERSION — was the tag pushed?" ;;
    esac
    [ $((SECONDS - start)) -gt $timeout ] && die "CI timed out after ${timeout}s"
  done
}

# ── Local fallback build ─────────────────────────────────────────────────
build_frontend() {
  log "Building frontend dist"
  ( cd src/frontend && npm run build ) >/dev/null
}

build_go_binaries() {
  log "Cross-compiling Go binaries for 4 platforms"
  local LDFLAGS="-s -w -X boardripper/updater.Version=$VERSION"
  ( cd src/backend
    CGO_ENABLED=0 GOOS=linux   GOARCH=amd64 go build -ldflags="$LDFLAGS" -o "$STAGE/boardripper-linux-amd64" .
    CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -ldflags="$LDFLAGS" -o "$STAGE/boardripper-windows-amd64.exe" .
    CGO_ENABLED=0 GOOS=darwin  GOARCH=amd64 go build -ldflags="$LDFLAGS" -o "$STAGE/boardripper-macos-amd64" .
    CGO_ENABLED=0 GOOS=darwin  GOARCH=arm64 go build -ldflags="$LDFLAGS" -o "$STAGE/boardripper-macos-arm64" .
  )
}

package_server_bundles() {
  log "Packaging server bundles (binary + static)"
  for P in linux-amd64 macos-amd64 macos-arm64; do
    rm -rf "$STAGE/pkg-$P" && mkdir -p "$STAGE/pkg-$P/static"
    cp "$STAGE/boardripper-$P" "$STAGE/pkg-$P/boardripper"
    chmod +x "$STAGE/pkg-$P/boardripper"
    cp -R "$FRONT_DIST/"* "$STAGE/pkg-$P/static/"
    tar -czf "$ARTIFACTS/boardripper-$P-$VERSION.tar.gz" -C "$STAGE/pkg-$P" .
  done
  rm -rf "$STAGE/pkg-windows-amd64" && mkdir -p "$STAGE/pkg-windows-amd64/static"
  cp "$STAGE/boardripper-windows-amd64.exe" "$STAGE/pkg-windows-amd64/boardripper.exe"
  cp -R "$FRONT_DIST/"* "$STAGE/pkg-windows-amd64/static/"
  ( cd "$STAGE/pkg-windows-amd64" && zip -qr "$ARTIFACTS/boardripper-windows-amd64-$VERSION.zip" . )
}

build_docker() {
  log "Building Docker image (linux/amd64)"
  docker buildx build \
    --platform linux/amd64 \
    --build-arg "APP_VERSION=$VERSION" \
    --tag "boardripper:$VERSION" \
    --output "type=docker,dest=$STAGE/boardripper-docker.tar" \
    . >/dev/null
  gzip -f "$STAGE/boardripper-docker.tar"
  mv "$STAGE/boardripper-docker.tar.gz" "$ARTIFACTS/boardripper-docker-$VERSION.tar.gz"
}

# Kick off mac + win Electron builds in parallel. Mac requires darwin host.
build_electron() {
  # electron-packager shares /tmp/electron-packager across invocations and
  # races on file renames inside the extracted prebuilt directory when
  # invoked concurrently (observed failure: ENOENT rename electron.exe →
  # BoardRipper.exe). Running sequentially avoids the race and the total
  # wall time is still within ~2 minutes.
  log "Building Electron Windows app"
  ( cd desktop && node build-all.mjs --win ) > "$STAGE/build-win.log" 2>&1 \
    || die "Windows Electron build failed — see $STAGE/build-win.log"
  cp "desktop/out-win/BoardRipper-Windows-x64-$VERSION.zip" "$ARTIFACTS/"
  if [ "$(uname -s)" = "Darwin" ]; then
    log "Building Electron macOS app"
    ( cd desktop && node build-all.mjs --mac ) > "$STAGE/build-mac.log" 2>&1 \
      || die "macOS Electron build failed — see $STAGE/build-mac.log"
    cp "desktop/out/BoardRipper-macOS-universal-$VERSION.zip" "$ARTIFACTS/"
  else
    warn "Not on darwin — skipping macOS Electron build; upload the .zip later with 'gh release upload'"
  fi
}

local_build() {
  mkdir -p "$ARTIFACTS"
  build_frontend
  build_go_binaries
  package_server_bundles
  build_docker
  build_electron
  log "Local artifacts ready:"
  ls -lh "$ARTIFACTS" | awk 'NR>1 {print "  " $9, $5}'
}

# ── Release notes + publish ──────────────────────────────────────────────
gen_notes() {
  local PREV
  PREV=$(git describe --tags --abbrev=0 "${VERSION}^" 2>/dev/null || true)
  {
    echo "## BoardRipper $VERSION"
    echo
    if [ -n "$PREV" ]; then
      echo "### Changes since $PREV"
      echo
      git log --no-merges --pretty=format:'- %s' "$PREV..$VERSION" \
        | grep -Ev '^- release:|^- chore\(release\):' \
        || echo "- (no non-release commits)"
      echo
    fi
    echo
    echo "### Downloads"
    echo "- \`boardripper-docker-$VERSION.tar.gz\` — server / NAS"
    echo "- \`boardripper-{linux,macos,windows}-{amd64,arm64}-$VERSION\` — standalone"
    echo "- \`BoardRipper-macOS-universal-$VERSION.zip\` — desktop (unsigned, see README)"
    echo "- \`BoardRipper-Windows-x64-$VERSION.zip\` — desktop (unsigned, see README)"
  } > "$STAGE/RELEASE_NOTES.md"
}

publish() {
  if gh release view "$VERSION" >/dev/null 2>&1; then
    log "Release $VERSION exists — uploading (clobbering) assets"
    gh release upload "$VERSION" "$ARTIFACTS"/* --clobber
  else
    gen_notes
    log "Creating release $VERSION"
    gh release create "$VERSION" \
      --title "BoardRipper $VERSION" \
      --notes-file "$STAGE/RELEASE_NOTES.md" \
      "$ARTIFACTS"/*
  fi
  local url
  url=$(gh release view "$VERSION" --json url --jq .url)
  log "Release: $url"
}

# ── Main ────────────────────────────────────────────────────────────────
main() {
  case "$MODE" in
    local)
      preflight
      push_tag
      local_build
      publish
      ;;
    resume)
      if wait_for_ci; then
        gh release view "$VERSION" >/dev/null 2>&1 \
          || die "CI reports success but release $VERSION not found"
        log "CI produced release: $(gh release view "$VERSION" --json url --jq .url)"
      else
        local_build
        publish
      fi
      ;;
    "")
      preflight
      push_tag
      if wait_for_ci; then
        gh release view "$VERSION" >/dev/null 2>&1 \
          || die "CI reports success but release $VERSION not found"
        log "CI produced release: $(gh release view "$VERSION" --json url --jq .url)"
      else
        local_build
        publish
      fi
      ;;
  esac
}
main
