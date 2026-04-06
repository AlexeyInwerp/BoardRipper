#!/usr/bin/env bash
# BoardRipper NAS Remote Deploy Script
# This script runs ON the NAS via SSH. It is SCP'd by NASdeploy.sh.
# Arguments: $1 = sudo password
set -e

DOCKER="/usr/local/bin/docker"
PW="$1"
GITHUB_TOKEN="${2:-}"
IMAGE_NAME="boardripper"
IMAGE_TAG="latest"
CONFIG_FILE="/volume1/docker/boardripper/container-config.json"

# Fallback config for first deploy (no existing container AND no saved config)
DEFAULT_MOUNTS='-v /volume1/docker/boardripper/data:/data -v /volume1/AL ZEUG/LogiCloud/Schematics-BV-EFI:/library:ro -v /var/run/docker.sock:/var/run/docker.sock'
DEFAULT_PORTS='-p 8090:8080'
DEFAULT_ENV='-e PORT=8080 -e LIBRARY_DIR=/library -e GITHUB_TOKEN=${GITHUB_TOKEN:-}'

# Helper: run docker with sudo, filtering prompt noise
sdocker() {
    echo "${PW}" | sudo -S ${DOCKER} "$@" 2>&1 | grep -v '^\[sudo\]' | grep -v '^Password:' || true
}

echo "[NAS] Decompressing image..."
gunzip -f /tmp/${IMAGE_NAME}.tar.gz

echo "[NAS] Loading Docker image..."
sdocker load -i /tmp/${IMAGE_NAME}.tar

# ── Capture existing container config and persist to file ──
EXISTING=$(echo "${PW}" | sudo -S ${DOCKER} ps -a --filter "name=^${IMAGE_NAME}$" --format '{{.Names}}' 2>/dev/null | grep -v '^\[sudo\]' | grep -v '^Password:' || true)

if [ -n "${EXISTING}" ]; then
    echo "[NAS] Saving container config to ${CONFIG_FILE}..."
    echo "${PW}" | sudo -S ${DOCKER} inspect "${IMAGE_NAME}" 2>/dev/null \
        | grep -v '^\[sudo\]' | grep -v '^Password:' \
        > "${CONFIG_FILE}" 2>/dev/null || true
fi

# ── Read config: from saved file, or fall back to defaults ──
MOUNT_ARGS=""
PORT_ARGS=""
ENV_ARGS=""
RESTART_POLICY="unless-stopped"

if [ -f "${CONFIG_FILE}" ] && python3 -c "import sys,json; json.load(open(sys.argv[1]))" "${CONFIG_FILE}" 2>/dev/null; then
    echo "[NAS] Reading config from ${CONFIG_FILE}..."

    MOUNT_ARGS=$(python3 -c "
import sys, json
data = json.load(open(sys.argv[1]))
if isinstance(data, list): data = data[0]
for m in data.get('Mounts', []):
    if m.get('Type') == 'bind':
        s = '-v ' + m['Source'] + ':' + m['Destination']
        if not m.get('RW', True): s += ':ro'
        print(s, end=' ')
" "${CONFIG_FILE}" 2>/dev/null)

    PORT_ARGS=$(python3 -c "
import sys, json
data = json.load(open(sys.argv[1]))
if isinstance(data, list): data = data[0]
for cp, bindings in (data.get('HostConfig', {}).get('PortBindings') or {}).items():
    port = cp.replace('/tcp', '')
    for b in (bindings or []):
        hp = b.get('HostPort', '')
        hip = b.get('HostIp', '')
        if hp:
            prefix = (hip + ':') if hip and hip != '0.0.0.0' else ''
            print(f'-p {prefix}{hp}:{port}', end=' ')
" "${CONFIG_FILE}" 2>/dev/null)

    ENV_ARGS=$(python3 -c "
import sys, json
data = json.load(open(sys.argv[1]))
if isinstance(data, list): data = data[0]
skip = {'PATH', 'HOME', 'HOSTNAME'}
for e in data.get('Config', {}).get('Env', []):
    key = e.split('=', 1)[0]
    if key not in skip:
        print(f'-e {e}', end=' ')
" "${CONFIG_FILE}" 2>/dev/null)

    RP=$(python3 -c "
import sys, json
data = json.load(open(sys.argv[1]))
if isinstance(data, list): data = data[0]
print(data.get('HostConfig', {}).get('RestartPolicy', {}).get('Name', ''))
" "${CONFIG_FILE}" 2>/dev/null)
    if [ -n "${RP}" ] && [ "${RP}" != "no" ]; then
        RESTART_POLICY="${RP}"
    fi
else
    echo "[NAS] No saved config — using defaults"
fi

# Fall back to defaults for any empty fields
[ -z "${PORT_ARGS}" ] && PORT_ARGS="${DEFAULT_PORTS}" && echo "[NAS]   ports: using defaults"
[ -z "${MOUNT_ARGS}" ] && MOUNT_ARGS="${DEFAULT_MOUNTS}" && echo "[NAS]   mounts: using defaults"
[ -z "${ENV_ARGS}" ] && ENV_ARGS="${DEFAULT_ENV}" && echo "[NAS]   env: using defaults"

# Ensure Docker socket is always mounted (required for self-update)
if ! echo "${MOUNT_ARGS}" | grep -q 'docker.sock'; then
    MOUNT_ARGS="${MOUNT_ARGS} -v /var/run/docker.sock:/var/run/docker.sock"
fi

# Ensure GITHUB_TOKEN is set (required for update checking from private repo)
if [ -n "${GITHUB_TOKEN}" ]; then
    # Remove any existing GITHUB_TOKEN from env args, then add the current one
    ENV_ARGS=$(echo "${ENV_ARGS}" | sed 's/-e GITHUB_TOKEN=[^ ]* //g')
    ENV_ARGS="${ENV_ARGS} -e GITHUB_TOKEN=${GITHUB_TOKEN}"
fi

echo "[NAS]   mounts:  ${MOUNT_ARGS}"
echo "[NAS]   ports:   ${PORT_ARGS}"
echo "[NAS]   env:     ${ENV_ARGS}"
echo "[NAS]   restart: ${RESTART_POLICY}"

echo "[NAS] Stopping old container..."
sdocker stop ${IMAGE_NAME} 2>/dev/null || true
sdocker rm ${IMAGE_NAME} 2>/dev/null || true

echo "[NAS] Starting new container..."
RUN_CMD=$(python3 -c "
import shlex
args = ['run', '-d', '--name', '${IMAGE_NAME}', '--restart', '${RESTART_POLICY}']
for raw in '''${PORT_ARGS}
${MOUNT_ARGS}
${ENV_ARGS}'''.strip().splitlines():
    raw = raw.strip()
    if not raw: continue
    parts = raw.split()
    i = 0
    while i < len(parts):
        if parts[i] in ('-v', '-p', '-e') and i + 1 < len(parts):
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
