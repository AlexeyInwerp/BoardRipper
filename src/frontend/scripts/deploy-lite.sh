#!/bin/bash
# Deploy the BoardRipper lite (backend-free) web build to
#   https://www.ripperdoc.de/boardripper/web/          (default)
#   https://www.ripperdoc.de/boardripper/legacy-web/   (--legacy)
#
# Builds dist-lite/ AND the single-file offline bundle
# (dist-offline/boardripper-lite.html, what the toolbar "Offline copy" button
# links to), stages them alongside the app-scoped .htaccess
# (deploy/boardripper-web.htaccess), and uploads ONLY that one subtree via
# lftp — additive, touches nothing else on the site.
#
# --legacy builds the same tree from the current checkout with the version
# suffixed "-legacy" and the PWA named "BoardRipper Legacy" (so an iPad can
# install both side by side), and uploads it to legacy-web/. That is the
# feat/browser-compat build (Safari/iOS 15.4 floor) published next to the
# main one until it is confirmed on real devices — landing/compatibility.html.
#
# FTP creds: RipperDocWeb/ftp.env (FTP_ADDRESS / FTP_USER / FTP_PASSWORD).
# Override with RIPPERDOCWEB=/path/to/RipperDocWeb, or set the three in the
# environment. One login attempt only, after a TCP probe of port 21: a stale
# password plus lftp retries is how this machine got fail2ban-blocked for two
# hours on 2026-09-03 (scripts/ftp-check.sh tells the two credential files apart).
#
# Usage:  npm run deploy:lite            (from src/frontend)
#         scripts/deploy-lite.sh --legacy
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"          # src/frontend
RIPPERDOCWEB="${RIPPERDOCWEB:-$HOME/Projects/RipperDocWeb}"
LEGACY=0
for arg in "$@"; do
  case "$arg" in
    --legacy) LEGACY=1 ;;
    *) echo "unknown argument: $arg"; exit 2 ;;
  esac
done
if [ "$LEGACY" = 1 ]; then
  REMOTE_DIR="/public_html/boardripper/legacy-web"
  PUBLIC_URL="https://www.ripperdoc.de/boardripper/legacy-web/"
  export BR_VERSION_SUFFIX="${BR_VERSION_SUFFIX:--legacy}"
  export BR_LEGACY=1
else
  REMOTE_DIR="/public_html/boardripper/web"
  PUBLIC_URL="https://www.ripperdoc.de/boardripper/web/"
fi

# --- credentials -----------------------------------------------------------
if [ -z "${FTP_USER:-}" ] && [ -f "$RIPPERDOCWEB/ftp.env" ]; then
  # shellcheck disable=SC1091
  . "$RIPPERDOCWEB/ftp.env"
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

# --- upload (only this subtree; --delete prunes old hashed assets) ---------
# Probe first: never hand a credential to a host that does not answer, and
# log in exactly once — a failed login is what fail2ban counts.
# (nc, not bash's /dev/tcp: macOS's /bin/bash is built without it and the
# probe fails on every host, which is how the first --legacy run stopped.)
FTP_HOST="${FTP_ADDRESS#ftp://}"; FTP_HOST="${FTP_HOST%%/*}"
if ! nc -z -w 5 -G 5 "$FTP_HOST" 21 >/dev/null 2>&1 && ! nc -z -w 5 "$FTP_HOST" 21 >/dev/null 2>&1; then
  echo "ERROR: $FTP_HOST:21 does not answer — not sending a credential (blocked IP? see scripts/ftp-check.sh)"; exit 1
fi
echo ">>> uploading $STAGE -> $REMOTE_DIR"
lftp -e "set net:timeout 20; set net:max-retries 1; set net:reconnect-interval-base 5; mirror --reverse --delete --verbose $STAGE $REMOTE_DIR; bye" \
  -u "$FTP_USER,$FTP_PASSWORD" "$FTP_ADDRESS"

echo ">>> done: $PUBLIC_URL"
