#!/bin/bash
# Deploy the BoardRipper lite (backend-free) web build to
# https://www.ripperdoc.de/boardripper/web/.
#
# Builds dist-lite/ AND the single-file offline bundle
# (dist-offline/boardripper-lite.html, what the toolbar "Offline copy" button
# links to), stages them alongside the app-scoped .htaccess
# (deploy/boardripper-web.htaccess), and uploads ONLY the /boardripper/web/
# subtree via lftp — additive, touches nothing else on the site.
#
# FTP creds are read from the sibling RipperDocWeb deploy.sh (NOT committed
# here). Override with RIPPERDOCWEB=/path/to/RipperDocWeb, or set
# FTP_USER / FTP_PASSWORD / FTP_ADDRESS directly in the environment.
#
# Usage:  npm run deploy:lite      (from src/frontend)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"          # src/frontend
RIPPERDOCWEB="${RIPPERDOCWEB:-$HOME/Desktop/Website/RipperDocWeb}"
REMOTE_DIR="/public_html/boardripper/web"

# --- credentials -----------------------------------------------------------
if [ -z "${FTP_USER:-}" ] && [ -f "$RIPPERDOCWEB/deploy.sh" ]; then
  FTP_USER=$(grep '^FTP_USER=' "$RIPPERDOCWEB/deploy.sh" | cut -d'"' -f2)
  FTP_PASSWORD=$(grep '^FTP_PASSWORD=' "$RIPPERDOCWEB/deploy.sh" | cut -d'"' -f2)
  FTP_ADDRESS=$(grep '^FTP_ADDRESS=' "$RIPPERDOCWEB/deploy.sh" | cut -d'"' -f2)
fi
: "${FTP_USER:?set FTP_USER (or point RIPPERDOCWEB at a checkout with deploy.sh)}"
: "${FTP_PASSWORD:?set FTP_PASSWORD}"
: "${FTP_ADDRESS:?set FTP_ADDRESS}"

command -v lftp >/dev/null || { echo "ERROR: lftp not installed (brew install lftp)"; exit 1; }

# --- build -----------------------------------------------------------------
echo ">>> building lite bundle"
(cd "$HERE" && npm run build:lite)
echo ">>> building single-file offline bundle"
(cd "$HERE" && npm run build:offline)

# --- stage (dist-lite + offline single file + app-scoped .htaccess) --------
echo ">>> staging"
STAGE="$(mktemp -d)/web"
mkdir -p "$STAGE"
rsync -a "$HERE/dist-lite/" "$STAGE/"
cp "$HERE/deploy/boardripper-web.htaccess" "$STAGE/.htaccess"
# The downloadable offline copy — the toolbar "Offline copy" button links here.
cp "$HERE/dist-offline/boardripper-lite.html" "$STAGE/boardripper-lite.html"

# --- upload (only the web/ subtree; --delete prunes old hashed assets) ------
echo ">>> uploading $STAGE -> $REMOTE_DIR"
lftp -e "set net:timeout 20; set net:max-retries 2; mirror --reverse --delete --verbose $STAGE $REMOTE_DIR; bye" \
  -u "$FTP_USER,$FTP_PASSWORD" "$FTP_ADDRESS"

echo ">>> done: https://www.ripperdoc.de/boardripper/web/"
