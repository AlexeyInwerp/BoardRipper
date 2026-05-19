#!/usr/bin/env bash
#
# Stage ripperdoc-devicedb/php/ for deployment.
#
# Produces a clean staging tree in $1 (default: /tmp/ripperdoc-devicedb-stage).
# Caller (typically `deploy.sh`) then `lftp mirror`s the staging tree to
# the live host. Pure file ops — no network, no credentials, no
# dependency on any sibling repo.
#
# Critically EXCLUDES local-only files that would clobber the live SQLite
# or leak a dev signing key:
#
#   data/canonical.sqlite*    (live runtime DB on the host)
#   data/snapshots/           (live tarballs — never overwrite from a dev box)
#   data/snapshot.key         (dev/test signing key — prod has its own)
#   data/.seed-from           (local seeding sentinel)
#   data/logs/                (server logs)
#
# What DOES ship under data/:
#
#   data/.htaccess            (Deny from all — protects runtime files
#                              even on a brand-new install)
#   data/.gitkeep             (harmless)
#
# Usage:
#   scripts/stage.sh                  # stage to /tmp/ripperdoc-devicedb-stage
#   scripts/stage.sh /some/dest       # stage to /some/dest
#
# Returns: prints the staged path on the last line, ready for use in
# pipelines (`stage_dir=$(scripts/stage.sh)`).

set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${1:-/tmp/ripperdoc-devicedb-stage}"

if [[ ! -d "$SRC_DIR/php" ]]; then
  echo "ERROR: PHP impl not found at $SRC_DIR/php/" >&2
  exit 1
fi

echo ">>> Staging ripperdoc-devicedb/php → $DEST" >&2

# Wipe + recreate the staging tree. Live runtime files (canonical.sqlite,
# snapshot.key, snapshots/) live on the FTP server only and are preserved
# across deploys because deploy.sh's `lftp mirror` runs without --delete.
rm -rf "$DEST"
mkdir -p "$DEST"

# Hard exclude everything under data/, then whitelist back just the two
# files that should ship. New local-only file types added later (test
# SQLite, dev signing keys, snapshots generated during e2e) physically
# cannot leak through without someone updating this script.
rsync -a \
  --exclude='/data/***' \
  --exclude='/tests/' \
  --exclude='.DS_Store' \
  --exclude='*.bak' \
  "$SRC_DIR/php/" "$DEST/"

mkdir -p "$DEST/data"
cp "$SRC_DIR/php/data/.htaccess" "$DEST/data/.htaccess"
[ -f "$SRC_DIR/php/data/.gitkeep" ] && cp "$SRC_DIR/php/data/.gitkeep" "$DEST/data/.gitkeep"

# Sanity-check the data-dir gate. Without it, the SQLite + tokens table
# would be directly fetchable via HTTP.
if [[ ! -f "$DEST/data/.htaccess" ]]; then
  echo "ERROR: $DEST/data/.htaccess is missing — staging aborted." >&2
  exit 1
fi
if ! grep -qE '(Deny from all|Require all denied)' "$DEST/data/.htaccess"; then
  echo "ERROR: $DEST/data/.htaccess does not deny direct access:" >&2
  cat "$DEST/data/.htaccess" >&2
  exit 1
fi

# Belt-and-braces leak check.
unexpected=$(find "$DEST/data" -mindepth 1 \
  ! -name '.htaccess' ! -name '.gitkeep' 2>/dev/null)
if [[ -n "$unexpected" ]]; then
  echo "ERROR: unexpected files staged under data/:" >&2
  echo "$unexpected" >&2
  echo "Refusing to deploy — update the allowlist in stage.sh." >&2
  exit 1
fi

count=$(find "$DEST" -type f | wc -l | tr -d ' ')
echo ">>> $count files staged." >&2
# Last line is the path, so callers can capture it.
echo "$DEST"
