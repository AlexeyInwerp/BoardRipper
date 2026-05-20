#!/usr/bin/env bash
# BoardRipper NAS DEV Remote Deploy Script
# Runs ON the NAS via SSH (SCP'd by NASdeploy-dev.sh).
# Creates a SEPARATE "boardripper-dev" container for testing a branch against
# the SAME library as live, WITHOUT touching the live "boardripper" container.
#
# Key isolation guarantees:
#   - DEV data dir is /volume1/docker/boardripper-dev/data (SEPARATE from live).
#     Critical: the v0->v1 PDF-index migration drops legacy pdf tables from
#     databank.db, so sharing the live data dir would corrupt production.
#   - DEV replicates EVERY /library* bind mount from the live container, mounted
#     READ-ONLY, so dev sees the identical library tree (live mounts them rw;
#     dev forces ro so it can't modify the shared folders).
#   - NO docker socket mount (dev needs no self-update; safer).
#
# Arguments: $1 = sudo password
set -e

DOCKER="/usr/local/bin/docker"
PW="$1"
LIVE_NAME="boardripper"
DEV_NAME="boardripper-dev"
DEV_IMAGE="boardripper-dev:latest"
DEV_DATA="/volume1/docker/boardripper-dev/data"
DEV_PORT="${DEV_PORT:-1234}"
DEV_MEM="${DEV_MEM:-1024m}"
DEV_POOL="${DEV_POOL:-2}"
TARBALL="/tmp/${DEV_NAME}.tar.gz"

sdocker() {
    echo "${PW}" | sudo -S ${DOCKER} "$@" 2>&1 | grep -v '^\[sudo\]' | grep -v '^Password:' || true
}

# Load the image only if a tarball was shipped; otherwise assume it's already
# loaded (lets us re-run with corrected mounts without re-shipping).
if [ -f "${TARBALL}" ]; then
    echo "[NAS-dev] Decompressing image..."
    gunzip -f "${TARBALL}"
    echo "[NAS-dev] Loading Docker image..."
    sdocker load -i "/tmp/${DEV_NAME}.tar"
else
    echo "[NAS-dev] No tarball at ${TARBALL} — using already-loaded ${DEV_IMAGE}."
fi

# ── Capture the live container's config (for /library* mount discovery) ──
# stdout (JSON) → user-owned file; the sudo prompt goes to stderr (suppressed).
echo "[NAS-dev] Reading live container config..."
echo "${PW}" | sudo -S ${DOCKER} inspect "${LIVE_NAME}" > /tmp/live_inspect.json 2>/dev/null || true

# ── Ensure dev data dir exists ──
echo "[NAS-dev] Ensuring dev data dir ${DEV_DATA}..."
echo "${PW}" | sudo -S mkdir -p "${DEV_DATA}" 2>&1 | grep -v '^\[sudo\]' | grep -v '^Password:' || true

# ── Build the full docker-run arg list as NUL-delimited bytes in a FILE ──
# (bash variables cannot hold NUL, and library paths contain spaces, so we keep
#  everything in files and exec via `xargs -0`.) Python replicates every
#  /library* mount from the live inspect as read-only.
echo "[NAS-dev] Building run args (replicating live /library* mounts, read-only)..."
python3 - "${DEV_NAME}" "${DEV_IMAGE}" "${DEV_DATA}" "${DEV_PORT}" "${DEV_MEM}" "${DEV_POOL}" > /tmp/dev_run_args <<'PY'
import sys, json
dev_name, dev_image, dev_data, dev_port, dev_mem, dev_pool = sys.argv[1:7]
args = ['run', '-d', '--name', dev_name, '--restart', 'unless-stopped',
        '--user', '0:0', '--memory', dev_mem, '-p', f'{dev_port}:8080',
        '-v', f'{dev_data}:/data']
libs = []
try:
    data = json.load(open('/tmp/live_inspect.json'))
    if isinstance(data, list): data = data[0]
    for m in data.get('Mounts', []):
        dest, src = m.get('Destination', ''), m.get('Source', '')
        if dest == '/library' or dest.startswith('/library/'):
            args += ['-v', f'{src}:{dest}:ro']
            libs.append(f'{src} -> {dest} (ro)')
except Exception as e:
    sys.stderr.write(f'    (inspect parse failed: {e})\n')
if not libs:
    args += ['-v', '/volume1/AL ZEUG/LogiCloud/Schematics-BV-EFI:/library:ro']
    sys.stderr.write('    WARNING: no live /library mounts found — using single LogiCloud fallback\n')
args += ['-e', 'PORT=8080', '-e', 'LIBRARY_DIR=/library',
         '-e', f'PDFINDEX_POOL_MAX={dev_pool}', dev_image]
sys.stdout.buffer.write(b'\0'.join(a.encode() for a in args))
sys.stderr.write('\n'.join('    ' + l for l in libs) + '\n')
PY

# ── Recreate the dev container ──
echo "[NAS-dev] Stopping old dev container (if any)..."
sdocker stop ${DEV_NAME} 2>/dev/null || true
sdocker rm ${DEV_NAME} 2>/dev/null || true

echo "[NAS-dev] Starting ${DEV_NAME} on port ${DEV_PORT}..."
echo "${PW}" | sudo -S bash -c "xargs -0 -a /tmp/dev_run_args ${DOCKER}" 2>&1 \
  | grep -v '^\[sudo\]' | grep -v '^Password:' || true
rm -f /tmp/dev_run_args /tmp/live_inspect.json

echo "[NAS-dev] Pruning dangling images..."
sdocker image prune -f 2>/dev/null || true

echo "[NAS-dev] Container status:"
sdocker ps --filter "name=${DEV_NAME}" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"

echo "[NAS-dev] Mounts:"
echo "${PW}" | sudo -S ${DOCKER} inspect ${DEV_NAME} 2>/dev/null | python3 -c "
import sys, json
data = json.load(sys.stdin)
if isinstance(data, list): data = data[0]
for m in data.get('Mounts', []):
    mode = 'ro' if not m.get('RW', True) else 'rw'
    print(f'  {m[\"Source\"]} -> {m[\"Destination\"]} ({mode})')
" 2>/dev/null || echo "  (could not read mounts)"

echo "[NAS-dev] Cleaning up..."
rm -f "/tmp/${DEV_NAME}.tar" /tmp/deploy-remote-dev.sh
echo "[NAS-dev] Done. Dev UI: http://<nas>:${DEV_PORT}"
