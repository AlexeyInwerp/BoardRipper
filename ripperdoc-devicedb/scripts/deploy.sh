#!/usr/bin/env bash
#
# Standalone deploy of ripperdoc-devicedb/php/ to the live host.
#
# Self-contained — no dependency on RipperDocWeb or any other sibling
# project. Stages the PHP impl, then `lftp mirror`s it to the FTP host.
#
# Credentials are read from environment variables OR a sibling .env file:
#
#   DEVICEDB_FTP_HOST          # e.g. ftp.ripperdoc.de
#   DEVICEDB_FTP_USER          # e.g. ftp@ripperdoc.de
#   DEVICEDB_FTP_PASS          # FTP password
#   DEVICEDB_REMOTE_PATH       # default: /public_html/devicedb
#
# Conventions:
#   - The remote path is the EXACT directory served at /devicedb/. To
#     deploy a staging path first, set DEVICEDB_REMOTE_PATH=/public_html/devicedb-staging
#     and verify, then re-deploy with the canonical path.
#   - `lftp mirror` runs WITHOUT --delete on the remote side, so the
#     live data/canonical.sqlite, data/snapshot.key, and existing
#     data/snapshots/ on the host survive every deploy.
#   - data/.htaccess and data/.gitkeep DO get pushed (they're harmless
#     re-writes of identical content).
#
# Usage:
#   scripts/deploy.sh                       # full deploy
#   scripts/deploy.sh --dry-run             # stage only, skip lftp push
#   scripts/deploy.sh --remote /custom/path # override DEVICEDB_REMOTE_PATH
#
# Pre-flight requirement: install lftp.
#   macOS:  brew install lftp
#   Linux:  apt-get install lftp / dnf install lftp

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# ─── Load .env if present ────────────────────────────────────────────────
ENV_FILE="$ROOT_DIR/.env"
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  set -o allexport
  . "$ENV_FILE"
  set +o allexport
fi

# ─── Args ───────────────────────────────────────────────────────────────
DRY_RUN=false
REMOTE_OVERRIDE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)     DRY_RUN=true; shift ;;
    --remote)      REMOTE_OVERRIDE="$2"; shift 2 ;;
    --help|-h)
      sed -n '2,30p' "$0"; exit 0 ;;
    *)
      echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

# ─── Validate config ────────────────────────────────────────────────────
FTP_HOST="${DEVICEDB_FTP_HOST:-}"
FTP_USER="${DEVICEDB_FTP_USER:-}"
FTP_PASS="${DEVICEDB_FTP_PASS:-}"
REMOTE_PATH="${REMOTE_OVERRIDE:-${DEVICEDB_REMOTE_PATH:-/public_html/devicedb}}"

if [[ "$DRY_RUN" == false ]]; then
  missing=""
  [[ -z "$FTP_HOST" ]] && missing="$missing DEVICEDB_FTP_HOST"
  [[ -z "$FTP_USER" ]] && missing="$missing DEVICEDB_FTP_USER"
  [[ -z "$FTP_PASS" ]] && missing="$missing DEVICEDB_FTP_PASS"
  if [[ -n "$missing" ]]; then
    echo "ERROR: missing required env vars:$missing" >&2
    echo "Set them in $ENV_FILE (copy .env.example), or export them." >&2
    exit 1
  fi
  if ! command -v lftp >/dev/null 2>&1; then
    echo "ERROR: lftp not installed (brew install lftp / apt-get install lftp)" >&2
    exit 1
  fi
fi

# ─── Stage ───────────────────────────────────────────────────────────────
STAGE_DIR="/tmp/ripperdoc-devicedb-deploy-$$"
trap 'rm -rf "$STAGE_DIR"' EXIT

bash "$SCRIPT_DIR/stage.sh" "$STAGE_DIR" >/dev/null
file_count=$(find "$STAGE_DIR" -type f | wc -l | tr -d ' ')

# Summary line goes to stderr so callers piping stdout aren't polluted.
{
  echo
  echo ">>> Staged $file_count files at $STAGE_DIR"
  echo "    target host:   ${FTP_HOST:-<not set>}"
  echo "    target user:   ${FTP_USER:-<not set>}"
  echo "    remote path:   $REMOTE_PATH"
  echo
} >&2

if [[ "$DRY_RUN" == true ]]; then
  echo ">>> --dry-run: stopping before the lftp push." >&2
  echo "$STAGE_DIR"   # so the caller can inspect
  trap - EXIT          # keep the staging tree around for inspection
  exit 0
fi

# ─── Push ───────────────────────────────────────────────────────────────
# `mirror -R` = local→remote.
# `--no-perms` = don't try to chmod via FTP (LiteSpeed often refuses).
# `--ignore-time` = always upload (skip mtime drift between dev box +
#                   live FTP — FTP mtime resolution is iffy).
# No --delete: live data/ files on the host survive.
echo ">>> lftp mirror → $FTP_HOST:$REMOTE_PATH …" >&2

lftp -c "
set ssl:verify-certificate no
set ftp:ssl-allow yes
open -u '$FTP_USER','$FTP_PASS' '$FTP_HOST'
mkdir -p '$REMOTE_PATH' || true
mkdir -p '$REMOTE_PATH/data' || true
mirror -R --no-perms --ignore-time --verbose \
  '$STAGE_DIR' '$REMOTE_PATH'
bye
"

echo >&2
echo ">>> Deploy complete." >&2
echo ">>> Verify:" >&2
echo "    curl -s https://www.ripperdoc.de/devicedb/api/v1/health" >&2
