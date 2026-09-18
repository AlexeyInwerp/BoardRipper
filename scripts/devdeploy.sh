#!/usr/bin/env bash
# Build the CURRENT working tree and put it on the NAS dev container
# (rd-nas:1234). The local half of scripts/devdeploy-remote.sh, which until now
# had no caller — the image had to be built, saved, copied and loaded by hand.
#
#   scripts/devdeploy.sh              # build, ship, redeploy, wait for health
#   scripts/devdeploy.sh --test       # …then run the WebKit iPad suite against it
#   scripts/devdeploy.sh --no-build   # ship the boardripper-dev:latest already built
#
# This is the touchscreen test target: the machine you are reading this on
# cannot reproduce a tablet, and WebKit's Mac port cannot reproduce iPadOS.
# Only a real iPad pointed at a real server can, and :1234 is that server —
# reachable over Tailscale at http://rd-nas.taila1bfc9.ts.net:1234/.
#
# Three things about this NAS that cost time to discover:
#
#   - `scp` fails with "subsystem request failed on channel 0". DSM's sshd has
#     no working SFTP subsystem for this user, so every copy needs `scp -O`
#     (the legacy SCP protocol). Same for rsync-over-ssh.
#   - `docker` is not on the login PATH and needs sudo. It lives at
#     /usr/local/bin/docker, and the remote script feeds the password in on
#     stdin (`sudo -S`) rather than relying on a tty.
#   - The NAS is amd64 (Synology apollolake) and this Mac is arm64, so the
#     image must be built with `--platform linux/amd64`. That is cheap here:
#     the Dockerfile builds the frontend on $BUILDPLATFORM and cross-compiles
#     the Go binary with GOARCH, so nothing runs under QEMU.
#
# What it does NOT touch: the live container on :1336. See devdeploy-remote.sh.
set -euo pipefail

BUILD=1
RUN_TESTS=0
while [ $# -gt 0 ]; do
  case "$1" in
    --test)     RUN_TESTS=1; shift;;
    --no-build) BUILD=0; shift;;
    -h|--help)  sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'; exit 0;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONF="$REPO_ROOT/deploy.conf"
IMAGE="boardripper-dev:latest"
HOST_ALIAS="rd-nas"
URL="http://rd-nas.taila1bfc9.ts.net:1234"

[ -f "$CONF" ] || { echo "missing $CONF (local-only, never committed)" >&2; exit 1; }
command -v sshpass >/dev/null || { echo "sshpass not installed (brew install sshpass)" >&2; exit 1; }
PW="$(awk -F': ' '/^ssh pw:/{print $2}' "$CONF")"
[ -n "$PW" ] || { echo "no 'ssh pw:' line in $CONF" >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if [ "$BUILD" = 1 ]; then
  echo "[dev] Building $IMAGE for linux/amd64 from the working tree…"
  docker buildx build --platform linux/amd64 -t "$IMAGE" --load "$REPO_ROOT"
fi

arch="$(docker image inspect "$IMAGE" --format '{{.Architecture}}')"
[ "$arch" = "amd64" ] || { echo "$IMAGE is $arch, the NAS needs amd64" >&2; exit 1; }

echo "[dev] Exporting…"
docker save "$IMAGE" | gzip -1 > "$TMP/boardripper-dev.tar.gz"
ls -lh "$TMP/boardripper-dev.tar.gz" | awk '{print "[dev] " $5}'

# -O: legacy SCP protocol. DSM has no working SFTP subsystem for this user.
echo "[dev] Uploading…"
sshpass -p "$PW" scp -O -o ConnectTimeout=20 \
  "$TMP/boardripper-dev.tar.gz" "$HOST_ALIAS:/tmp/boardripper-dev.tar.gz"
sshpass -p "$PW" scp -O -o ConnectTimeout=20 \
  "$REPO_ROOT/scripts/devdeploy-remote.sh" "$HOST_ALIAS:/tmp/devdeploy-remote.sh"

echo "[dev] Redeploying on the NAS…"
sshpass -p "$PW" ssh -o ConnectTimeout=20 "$HOST_ALIAS" \
  "chmod +x /tmp/devdeploy-remote.sh && /bin/bash /tmp/devdeploy-remote.sh '$PW'"

echo "[dev] $URL"

if [ "$RUN_TESTS" = 1 ]; then
  echo "[dev] Running the WebKit iPad suite against the deployed container…"
  # Two PDF specs skip here and that is correct: they read `__pdfStore`, a
  # DEV-only global that a production bundle does not carry.
  ( cd "$REPO_ROOT/src/frontend" && BASE_URL="$URL" WEBKIT=1 npx playwright test --reporter=list )
fi
