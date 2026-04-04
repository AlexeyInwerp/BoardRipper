#!/usr/bin/env bash
set -euo pipefail

# BoardRipper NAS Deploy Script
# Builds Docker image locally for linux/amd64, transfers to NAS via scp,
# then SSHes in to load the image and restart the container.

# ── Configuration ──────────────────────────────────────────────
IMAGE_NAME="boardripper"
IMAGE_TAG="latest"
NAS_HOST="rd-nas"
NAS_USER="inwerp"
NAS_SSH_PORT=22
NAS_DATA_DIR="/volume1/docker/boardripper/data"
NAS_LIBRARY_DIR="/volume1/AL ZEUG/LogiCloud/Schematics-BV-EFI"
NAS_PORT=8090          # External port on NAS
CONTAINER_PORT=8080    # Internal port the Go server listens on
REMOTE="origin"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"

# Read config from deploy.conf
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NAS_PW=""
GITHUB_UPDATE_TOKEN=""
if [[ -f "${SCRIPT_DIR}/deploy.conf" ]]; then
    NAS_HOST=$(grep '^server:' "${SCRIPT_DIR}/deploy.conf" | awk '{print $2}')
    NAS_USER=$(grep '^ssh user:' "${SCRIPT_DIR}/deploy.conf" | awk '{print $3}')
    NAS_PW=$(grep '^ssh pw:' "${SCRIPT_DIR}/deploy.conf" | awk '{print $3}')
    GITHUB_UPDATE_TOKEN=$(grep '^github_token:' "${SCRIPT_DIR}/deploy.conf" | awk '{print $2}')
fi
APP_VERSION=$(git describe --tags --always 2>/dev/null || echo "dev")

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

# ── Pre-deploy validation ──────────────────────────────────────
info "=== Pre-deploy checks ==="

# 1. Verify Docker image builds locally
info "Building image..."
docker build --build-arg APP_VERSION="${APP_VERSION}" --build-arg GITHUB_TOKEN="${GITHUB_UPDATE_TOKEN}" -t boardripper:deploy-check . || { error "FAIL: Docker build failed"; exit 1; }

# 2. Smoke-test the image locally
info "Smoke-testing image..."
docker run -d --name br-deploy-check -p 18080:8080 boardripper:deploy-check
sleep 3
if ! curl -sf http://localhost:18080/ > /dev/null; then
    error "FAIL: Container does not serve HTTP"
    docker logs br-deploy-check
    docker rm -f br-deploy-check
    exit 1
fi
docker rm -f br-deploy-check
info "OK: Image serves HTTP"

# 3. Verify NAS is reachable
info "Checking NAS connectivity..."
if ! $(ssh_cmd) "${NAS_USER}@${NAS_HOST}" "echo ok" 2>/dev/null; then
    error "FAIL: Cannot reach NAS at ${NAS_HOST}"
    exit 1
fi
info "OK: NAS reachable"

# 4. Backup existing data volume
info "Backing up NAS data..."
$(ssh_cmd) "${NAS_USER}@${NAS_HOST}" "cp -r /volume1/docker/boardripper/data /volume1/docker/boardripper/data.bak.$(date +%Y%m%d)" || warn "WARN: backup failed (first deploy?)"

info "=== All pre-deploy checks passed ==="

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
docker buildx build --platform linux/amd64 --build-arg APP_VERSION="${APP_VERSION}" --build-arg GITHUB_TOKEN="${GITHUB_UPDATE_TOKEN}" -t "${IMAGE_NAME}:${IMAGE_TAG}" --load . || {
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

# ── Step 5: Upload deploy script and run on NAS ──────────────
info "Uploading deploy script to NAS..."
$(scp_cmd) "${SCRIPT_DIR}/deploy-remote.sh" "${NAS_USER}@${NAS_HOST}:/tmp/deploy-remote.sh" || {
    error "Failed to upload deploy script."
    exit 1
}

info "Deploying on NAS..."
$(ssh_cmd) "${NAS_USER}@${NAS_HOST}" "bash /tmp/deploy-remote.sh '${NAS_PW}'"

# Clean up local tar
rm -f "${TAR_FILE}"
info "Deployment finished successfully."
info "BoardRipper available at http://${NAS_HOST}:${NAS_PORT}/"
