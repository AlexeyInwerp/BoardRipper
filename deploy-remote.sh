#!/usr/bin/env bash
# BoardRipper NAS Remote Deploy Script
# This script runs ON the NAS via SSH. It is SCP'd by NASdeploy.sh.
# Arguments: $1 = sudo password
set -e

DOCKER="/usr/local/bin/docker"
PW="$1"
IMAGE_NAME="boardripper"
IMAGE_TAG="latest"

# Fallback config for first deploy (no existing container)
DEFAULT_MOUNTS='-v /volume1/docker/boardripper/data:/data -v /volume1/AL ZEUG/LogiCloud/Schematics-BV-EFI:/library:ro'
DEFAULT_PORTS='-p 8081:8080'
DEFAULT_ENV='-e PORT=8080 -e LIBRARY_DIR=/library'

# Helper: run docker with sudo, filtering prompt noise
sdocker() {
    echo "${PW}" | sudo -S ${DOCKER} "$@" 2>&1 | grep -v '^\[sudo\]' | grep -v '^Password:' || true
}

# Helper: run docker inspect quietly (returns "" on failure, not error text)
sdocker_inspect() {
    echo "${PW}" | sudo -S ${DOCKER} inspect "$@" 2>/dev/null | grep -v '^\[sudo\]' | grep -v '^Password:' || true
}

echo "[NAS] Decompressing image..."
gunzip -f /tmp/${IMAGE_NAME}.tar.gz

echo "[NAS] Loading Docker image..."
sdocker load -i /tmp/${IMAGE_NAME}.tar

# ── Capture existing container config before removing ──
MOUNT_ARGS=""
PORT_ARGS=""
ENV_ARGS=""
RESTART_POLICY="unless-stopped"

# Check if container exists
EXISTING=$(echo "${PW}" | sudo -S ${DOCKER} ps -a --filter "name=^${IMAGE_NAME}$" --format '{{.Names}}' 2>/dev/null | grep -v '^\[sudo\]' | grep -v '^Password:' || true)

if [ -n "${EXISTING}" ]; then
    echo "[NAS] Capturing existing container config..."

    # Use raw JSON inspect — Go templates are fragile across Docker versions
    INSPECT_JSON=$(sdocker_inspect "${IMAGE_NAME}")

    if [ -n "${INSPECT_JSON}" ] && echo "${INSPECT_JSON}" | python3 -c "import sys,json; json.load(sys.stdin)" 2>/dev/null; then
        # Mounts: extract bind mounts as -v source:destination[:ro]
        MOUNT_ARGS=$(echo "${INSPECT_JSON}" | python3 -c "
import sys, json
data = json.load(sys.stdin)
if isinstance(data, list): data = data[0]
for m in data.get('Mounts', []):
    if m.get('Type') == 'bind':
        s = '-v ' + m['Source'] + ':' + m['Destination']
        if not m.get('RW', True): s += ':ro'
        print(s, end=' ')
" 2>/dev/null)

        # Ports: extract published port bindings
        PORT_ARGS=$(echo "${INSPECT_JSON}" | python3 -c "
import sys, json
data = json.load(sys.stdin)
if isinstance(data, list): data = data[0]
for cp, bindings in (data.get('HostConfig', {}).get('PortBindings') or {}).items():
    port = cp.replace('/tcp', '')
    for b in (bindings or []):
        hp = b.get('HostPort', '')
        hip = b.get('HostIp', '')
        if hp:
            prefix = (hip + ':') if hip and hip != '0.0.0.0' else ''
            print(f'-p {prefix}{hp}:{port}', end=' ')
" 2>/dev/null)

        # Env: extract env vars (skip runtime-injected ones)
        ENV_ARGS=$(echo "${INSPECT_JSON}" | python3 -c "
import sys, json
data = json.load(sys.stdin)
if isinstance(data, list): data = data[0]
skip = {'PATH', 'HOME', 'HOSTNAME'}
for e in data.get('Config', {}).get('Env', []):
    key = e.split('=', 1)[0]
    if key not in skip:
        print(f'-e {e}', end=' ')
" 2>/dev/null)

        # Restart policy
        RP=$(echo "${INSPECT_JSON}" | python3 -c "
import sys, json
data = json.load(sys.stdin)
if isinstance(data, list): data = data[0]
print(data.get('HostConfig', {}).get('RestartPolicy', {}).get('Name', ''))
" 2>/dev/null)
        if [ -n "${RP}" ] && [ "${RP}" != "no" ]; then
            RESTART_POLICY="${RP}"
        fi
    fi

    # Fall back to defaults for any empty captures
    [ -z "${PORT_ARGS}" ] && PORT_ARGS="${DEFAULT_PORTS}" && echo "[NAS]   ports: empty, using defaults"
    [ -z "${MOUNT_ARGS}" ] && MOUNT_ARGS="${DEFAULT_MOUNTS}" && echo "[NAS]   mounts: empty, using defaults"
    [ -z "${ENV_ARGS}" ] && ENV_ARGS="${DEFAULT_ENV}" && echo "[NAS]   env: empty, using defaults"

    echo "[NAS]   mounts: ${MOUNT_ARGS}"
    echo "[NAS]   ports:  ${PORT_ARGS}"
    echo "[NAS]   env:    ${ENV_ARGS}"
    echo "[NAS]   restart: ${RESTART_POLICY}"
else
    echo "[NAS] No existing container — using defaults"
    MOUNT_ARGS="${DEFAULT_MOUNTS}"
    PORT_ARGS="${DEFAULT_PORTS}"
    ENV_ARGS="${DEFAULT_ENV}"
fi

echo "[NAS] Stopping old container..."
sdocker stop ${IMAGE_NAME} 2>/dev/null || true
sdocker rm ${IMAGE_NAME} 2>/dev/null || true

echo "[NAS] Starting new container (preserving config)..."
# Build docker run command via python3 to handle paths with spaces correctly
RUN_CMD=$(python3 -c "
import shlex, sys
args = ['run', '-d', '--name', '${IMAGE_NAME}', '--restart', '${RESTART_POLICY}']
# Parse preserved args (handles -v, -p, -e with values that may contain spaces)
for raw in '''${PORT_ARGS}
${MOUNT_ARGS}
${ENV_ARGS}'''.strip().splitlines():
    raw = raw.strip()
    if not raw: continue
    # Split on ' -' boundaries to separate flags, keeping the leading dash
    parts = raw.split()
    i = 0
    while i < len(parts):
        if parts[i] in ('-v', '-p', '-e') and i + 1 < len(parts):
            # Collect the value — may span multiple space-separated tokens until next flag
            val_parts = [parts[i + 1]]
            j = i + 2
            while j < len(parts) and parts[j] not in ('-v', '-p', '-e'):
                val_parts.append(parts[j])
                j += 1
            args.extend([parts[i], ' '.join(val_parts)])
            i = j
        else:
            args.append(parts[i])
            i += 1
args.append('${IMAGE_NAME}:${IMAGE_TAG}')
print(' '.join(shlex.quote(a) for a in args))
" 2>/dev/null)
echo "[NAS]   cmd: docker ${RUN_CMD}"
echo "${DOCKER} ${RUN_CMD}" > /tmp/docker_run_cmd.sh
echo "${PW}" | sudo -S bash /tmp/docker_run_cmd.sh 2>&1 | grep -v '^\[sudo\]' | grep -v '^Password:' || true
rm -f /tmp/docker_run_cmd.sh

echo "[NAS] Pruning old images..."
sdocker image prune -f 2>/dev/null || true

echo "[NAS] Container status:"
sdocker ps --filter "name=${IMAGE_NAME}" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"

echo "[NAS] Mounts:"
echo "${PW}" | sudo -S ${DOCKER} inspect ${IMAGE_NAME} 2>/dev/null | python3 -c "
import sys, json
data = json.load(sys.stdin)
if isinstance(data, list): data = data[0]
for m in data.get('Mounts', []):
    mode = 'ro' if not m.get('RW', True) else 'rw'
    print(f'  {m[\"Source\"]} -> {m[\"Destination\"]} ({mode})')
" 2>/dev/null || echo "  (could not read mounts)"

echo "[NAS] Cleaning up..."
rm -f /tmp/${IMAGE_NAME}.tar /tmp/deploy-remote.sh
