#!/usr/bin/env bash
# Manual one-shot seed: copy the project's Board Database/boards.db into
# the devicedb container's /seed mount path. Normally docker-compose.yml
# already mounts the right directory, so this script is mainly a fallback
# for runs without compose.
set -euo pipefail

SRC="${1:-$(dirname "$0")/../../Board Database/boards.db}"
DST_DATA_DIR="${DATA_DIR:-./data}"
SEED_DEST="${2:-/tmp/devicedb-seed}"

if [[ ! -f "$SRC" ]]; then
    echo "Source boards.db not found at: $SRC" >&2
    exit 1
fi

mkdir -p "$SEED_DEST"
cp "$SRC" "$SEED_DEST/boards.db"
echo "Seed staged at $SEED_DEST/boards.db"
echo "Run the server with SEED_DB_PATH=$SEED_DEST/boards.db"
