#!/usr/bin/env bash
# Runs ON the NAS. Swaps the boardripper-dev (port 1234) image to the freshly
# uploaded one, preserving its exact mounts/env/port/user. Does NOT touch the
# live `boardripper` container (port 1336). Arg $1 = sudo password.
set -e

DOCKER="/usr/local/bin/docker"
PW="$1"
TAR="/tmp/boardripper-dev.tar.gz"
NAME="boardripper-dev"
IMAGE="boardripper-dev:latest"

sdocker() { echo "${PW}" | sudo -S ${DOCKER} "$@" 2>&1 | grep -v '^\[sudo\]' | grep -v '^Password:' || true; }

echo "[dev] Decompressing + loading image..."
gunzip -f "${TAR}"
sdocker load -i "/tmp/boardripper-dev.tar"

echo "[dev] Stopping + removing old ${NAME}..."
sdocker stop "${NAME}" || true
sdocker rm "${NAME}" || true

echo "[dev] Starting new ${NAME} on :1234 (preserved config)..."
sdocker run -d --name "${NAME}" \
  --restart unless-stopped \
  --user 0:0 \
  -m 2g \
  -p 1234:8080 \
  -e LIBRARY_DIR=/library \
  -e DATA_DIR=/data \
  -e STATIC_DIR=/static \
  -e PORT=8080 \
  -e SQLITE_TMPDIR=/data \
  -e TMPDIR=/data \
  -e PDFINDEX_POOL_MAX=4 \
  -v "/volume1/docker/boardripper-dev/data:/data" \
  -v "/volume1/AL ZEUG/LogiCloud/Schematics-BV-EFI:/library/logicloud:ro" \
  -v "/volume1/AL ZEUG/XZZ:/library/xzz:ro" \
  -v "/volume1/AL ZEUG/New Boards:/library/incoming:ro" \
  -v "/volume1/AL ZEUG/DESKTOP/BOARDS STUFF:/library/boards_stuff:ro" \
  "${IMAGE}"

echo "[dev] Waiting for health..."
ok=0
for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:1234/api/health 2>/dev/null || echo 000)
  if [ "${code}" = "200" ]; then ok=1; break; fi
  sleep 2
done
if [ "${ok}" = "1" ]; then
  echo "[dev] HEALTHY. Version: $(curl -s http://localhost:1234/api/health)"
else
  echo "[dev] WARNING: health check did not pass in 60s — recent logs:"
  sdocker logs --tail 40 "${NAME}"
  exit 1
fi
echo "[dev] Done. boardripper-dev redeployed on :1234."
rm -f /tmp/boardripper-dev.tar
