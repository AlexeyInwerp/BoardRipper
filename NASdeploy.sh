#!/usr/bin/env bash
set -euo pipefail

# BoardRipper NAS Deploy Script
# Builds Docker image locally for linux/amd64, transfers to NAS via scp,
# then SSHes in to load the image and restart the container.

# ── Configuration ──────────────────────────────────────────────
IMAGE_NAME="boardripper"
IMAGE_TAG="latest"
NAS_HOST="192.168.178.21"
NAS_USER="inwerp"
NAS_SSH_PORT=22
NAS_DATA_DIR="/volume1/docker/boardripper/data"
NAS_LIBRARY_DIR="/volume1/AL ZEUG/LogiCloud/Schematics-BV-EFI"
NAS_PORT=8081          # External port on NAS (8080 is taken by CRM)
CONTAINER_PORT=8080    # Internal port the Go server listens on
REMOTE="origin"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"

# Read config from deploy.conf
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NAS_PW=""
if [[ -f "${SCRIPT_DIR}/deploy.conf" ]]; then
    NAS_HOST=$(grep '^server:' "${SCRIPT_DIR}/deploy.conf" | awk '{print $2}')
    NAS_USER=$(grep '^ssh user:' "${SCRIPT_DIR}/deploy.conf" | awk '{print $3}')
    NAS_PW=$(grep '^ssh pw:' "${SCRIPT_DIR}/deploy.conf" | awk '{print $3}')
fi

# ── Colors ─────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[deploy]${NC} $*"; }
warn()  { echo -e "${YELLOW}[deploy]${NC} $*"; }
error() { echo -e "${RED}[deploy]${NC} $*" >&2; }

# SSH/SCP helpers (with optional sshpass)
ssh_cmd() {
    local cmd="ssh -o ConnectTimeout=10 -o StrictHostKeyChecking=no -o PubkeyAuthentication=no -p ${NAS_SSH_PORT}"
    if [[ -n "${NAS_PW}" ]] && command -v sshpass &>/dev/null; then
        cmd="sshpass -p ${NAS_PW} ${cmd}"
    fi
    echo "${cmd}"
}

scp_cmd() {
    local cmd="scp -O -o ConnectTimeout=10 -o StrictHostKeyChecking=no -o PubkeyAuthentication=no -P ${NAS_SSH_PORT}"
    if [[ -n "${NAS_PW}" ]] && command -v sshpass &>/dev/null; then
        cmd="sshpass -p ${NAS_PW} ${cmd}"
    fi
    echo "${cmd}"
}

# ── Step 1: Push to GitHub ─────────────────────────────────────
info "Pushing branch '${BRANCH}' to ${REMOTE}..."
git push "${REMOTE}" "${BRANCH}" || {
    error "Git push failed. Commit your changes first?"
    exit 1
}
info "Push complete."

# ── Step 2: Build Docker image for linux/amd64 ────────────────
TAR_FILE="/tmp/${IMAGE_NAME}.tar.gz"
info "Building Docker image ${IMAGE_NAME}:${IMAGE_TAG} for linux/amd64..."
docker buildx build --platform linux/amd64 -t "${IMAGE_NAME}:${IMAGE_TAG}" --load . || {
    error "Docker build failed."
    exit 1
}
info "Build complete."

# ── Step 3: Export image to tar.gz ─────────────────────────────
info "Exporting image to ${TAR_FILE}..."
docker save "${IMAGE_NAME}:${IMAGE_TAG}" | gzip > "${TAR_FILE}"
info "Image exported ($(du -h "${TAR_FILE}" | awk '{print $1}'))."

# ── Step 4: Transfer to NAS via scp ───────────────────────────
info "Uploading image to NAS (${NAS_USER}@${NAS_HOST})..."
$(scp_cmd) "${TAR_FILE}" "${NAS_USER}@${NAS_HOST}:/tmp/${IMAGE_NAME}.tar.gz" || {
    error "SCP upload failed."
    exit 1
}
info "Upload complete."

# ── Step 5: SSH into NAS to load image and restart container ──
info "Deploying on NAS..."
$(ssh_cmd) "${NAS_USER}@${NAS_HOST}" << REMOTE_SCRIPT_END
set -e
DOCKER="/usr/local/bin/docker"
PW="${NAS_PW}"
IMAGE_NAME="boardripper"
IMAGE_TAG="latest"
NAS_DATA_DIR="/volume1/docker/boardripper/data"
NAS_LIBRARY_DIR="/volume1/AL ZEUG/LogiCloud/Schematics-BV-EFI"
NAS_PORT=8081
CONTAINER_PORT=8080

# Helper: run docker with sudo
sdocker() {
    echo "\${PW}" | sudo -S \${DOCKER} "\$@" 2>&1 | { grep -v '^\[sudo\]' || true; }
}

echo "[NAS] Decompressing image..."
gunzip -f /tmp/\${IMAGE_NAME}.tar.gz

echo "[NAS] Loading Docker image..."
sdocker load -i /tmp/\${IMAGE_NAME}.tar

echo "[NAS] Stopping old container..."
sdocker stop \${IMAGE_NAME} 2>/dev/null || true
sdocker rm \${IMAGE_NAME} 2>/dev/null || true

echo "[NAS] Ensuring data directory exists..."
mkdir -p "\${NAS_DATA_DIR}" 2>/dev/null || echo "\${PW}" | sudo -S mkdir -p "\${NAS_DATA_DIR}"

echo "[NAS] Starting new container..."
sdocker run -d \
    --name "\${IMAGE_NAME}" \
    --restart unless-stopped \
    -p "\${NAS_PORT}:\${CONTAINER_PORT}" \
    -v "\${NAS_DATA_DIR}:/data" \
    -v "\${NAS_LIBRARY_DIR}:/library:ro" \
    -e "PORT=\${CONTAINER_PORT}" \
    -e "LIBRARY_DIR=/library" \
    "\${IMAGE_NAME}:\${IMAGE_TAG}"

echo "[NAS] Pruning old images..."
sdocker image prune -f 2>/dev/null || true

echo "[NAS] Container status:"
sdocker ps --filter "name=\${IMAGE_NAME}" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"

echo "[NAS] Cleaning up..."
rm -f /tmp/\${IMAGE_NAME}.tar
REMOTE_SCRIPT_END

# Clean up local tar
rm -f "${TAR_FILE}"
info "Deployment finished successfully."
info "BoardRipper available at http://${NAS_HOST}:${NAS_PORT}/"
