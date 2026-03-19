#!/usr/bin/env bash
set -euo pipefail

# BoardRipper NAS Deploy Script
# Pushes current branch to GitHub, then SSHes into the NAS to pull & rebuild.

# ── Configuration ──────────────────────────────────────────────
NAS_HOST="inwerp.direct.quickconnect.to"
NAS_USER="inwerp"
NAS_SSH_PORT=22
# Path to the project on the NAS (adjust to your Synology volume)
NAS_PROJECT_DIR="/volume1/docker/boardripper"
REMOTE="origin"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"

# ── Colors ─────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[deploy]${NC} $*"; }
warn()  { echo -e "${YELLOW}[deploy]${NC} $*"; }
error() { echo -e "${RED}[deploy]${NC} $*" >&2; }

# ── Step 1: Push to GitHub ─────────────────────────────────────
info "Pushing branch '${BRANCH}' to ${REMOTE}..."
git push "${REMOTE}" "${BRANCH}" || {
    error "Git push failed. Commit your changes first?"
    exit 1
}
info "Push complete."

# ── Step 2: SSH into NAS and deploy ────────────────────────────
info "Connecting to NAS (${NAS_USER}@${NAS_HOST}:${NAS_SSH_PORT})..."

ssh -o ConnectTimeout=10 \
    -o StrictHostKeyChecking=no \
    -p "${NAS_SSH_PORT}" \
    "${NAS_USER}@${NAS_HOST}" << REMOTE_SCRIPT
set -e
echo "[NAS] Connected."

cd "${NAS_PROJECT_DIR}" || { echo "[NAS] Project dir not found: ${NAS_PROJECT_DIR}"; exit 1; }

echo "[NAS] Fetching latest from ${REMOTE}..."
git fetch ${REMOTE}

echo "[NAS] Checking out ${BRANCH}..."
git checkout ${BRANCH} 2>/dev/null || git checkout -b ${BRANCH} ${REMOTE}/${BRANCH}
git reset --hard ${REMOTE}/${BRANCH}

echo "[NAS] Rebuilding Docker container..."
docker compose down 2>/dev/null || docker-compose down 2>/dev/null || true
docker compose build --no-cache 2>/dev/null || docker-compose build --no-cache
docker compose up -d 2>/dev/null || docker-compose up -d

echo "[NAS] Pruning old images..."
docker image prune -f 2>/dev/null || true

echo "[NAS] Deploy complete. Container status:"
docker compose ps 2>/dev/null || docker-compose ps 2>/dev/null || true
REMOTE_SCRIPT

info "Deployment finished successfully."
