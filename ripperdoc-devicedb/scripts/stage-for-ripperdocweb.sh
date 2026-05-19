#!/usr/bin/env bash
#
# Prepare ripperdoc-devicedb's PHP impl for deployment via RipperDocWeb.
#
# Stages a clean `./public/devicedb/` directory inside the RipperDocWeb
# checkout, ready for the next `deploy.sh` to FTP-push.
#
# Critically EXCLUDES local-only files that would clobber the live SQLite
# or leak a dev signing key:
#
#   data/canonical.sqlite*    (live runtime DB on the host)
#   data/snapshots/           (live tarballs)
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
#   scripts/stage-for-ripperdocweb.sh                       # auto-detects RipperDocWeb at ~/Desktop/Website/RipperDocWeb
#   scripts/stage-for-ripperdocweb.sh /path/to/RipperDocWeb # explicit path
#
# To wire into RipperDocWeb/deploy.sh, add one line near the existing
# "BoardRipper landing" merge step:
#
#   "$BOARDRIPPER_DIR/ripperdoc-devicedb/scripts/stage-for-ripperdocweb.sh" "$SCRIPT_DIR"

set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

DEST_ROOT="${1:-$HOME/Desktop/Website/RipperDocWeb}"
if [[ ! -d "$DEST_ROOT/public" ]]; then
  echo "ERROR: RipperDocWeb checkout not found at $DEST_ROOT (no public/ subdir)" >&2
  echo "Pass the path as the first arg, or clone https://github.com/.../RipperDocWeb.git there." >&2
  exit 1
fi

if [[ ! -d "$SRC_DIR/php" ]]; then
  echo "ERROR: PHP impl not built yet — $SRC_DIR/php/ is missing." >&2
  echo "The PHP port lives at ripperdoc-devicedb/php/. Did you run the port?" >&2
  exit 1
fi

DEST="$DEST_ROOT/public/devicedb"
echo ">>> Staging ripperdoc-devicedb/php → $DEST"

# Wipe + recreate. Live runtime files (data/canonical.sqlite etc.) live
# on the FTP server only and survive because RipperDocWeb's deploy.sh
# uses lftp mirror WITHOUT --delete on the remote side. So wiping the
# local staging area is safe.
rm -rf "$DEST"
mkdir -p "$DEST"

rsync -a \
  --exclude='/data/canonical.sqlite' \
  --exclude='/data/canonical.sqlite-shm' \
  --exclude='/data/canonical.sqlite-wal' \
  --exclude='/data/snapshots/' \
  --exclude='/data/snapshot.key' \
  --exclude='/data/.seed-from' \
  --exclude='/data/logs/' \
  --exclude='/tests/' \
  --exclude='.DS_Store' \
  --exclude='*.bak' \
  "$SRC_DIR/php/" "$DEST/"

# Sanity-check the data-dir gate that protects the runtime files. Without
# it, anyone could GET https://ripperdoc.de/devicedb/data/canonical.sqlite
# and walk away with the entire DB plus the tokens table.
if [[ ! -f "$DEST/data/.htaccess" ]]; then
  echo "ERROR: $DEST/data/.htaccess is missing — staging aborted." >&2
  echo "This file gates the SQLite + token files from direct HTTP GET." >&2
  exit 1
fi
if ! grep -qE '^(Deny from all|Require all denied)' "$DEST/data/.htaccess"; then
  echo "ERROR: $DEST/data/.htaccess does not deny direct access." >&2
  echo "Contents:" >&2
  cat "$DEST/data/.htaccess" >&2
  exit 1
fi

echo ">>> $(find "$DEST" -type f | wc -l | tr -d ' ') files staged."
echo ">>> Run RipperDocWeb/deploy.sh next to FTP-push."
