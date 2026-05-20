#!/usr/bin/env bash
set -euo pipefail

# BoardRipper NAS DEV Deploy
# Builds a linux/amd64 image of the CURRENT branch tagged boardripper-dev,
# ships it to the NAS, and runs a SEPARATE "boardripper-dev" container next to
# the live one — same library folder (read-only), separate data dir, port 1234.
# Does NOT touch the live "boardripper" container or its data.

DEV_NAME="boardripper-dev"
DEV_TAG="latest"
DEV_PORT="${DEV_PORT:-1234}"
DEV_MEM="${DEV_MEM:-2048m}"   # 4 wazero/pdfium workers can spike WASM memory on big schematics
DEV_POOL="${DEV_POOL:-4}"     # NAS has 4 cores; pool=4 ~saturates them (measured 385% CPU vs 230% at 2)
NAS_SSH_PORT=22

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# deploy.conf is gitignored and lives in the main checkout; allow override via
# DEPLOY_CONF env. Search: worktree dir → DEPLOY_CONF → main checkout sibling.
DEPLOY_CONF="${DEPLOY_CONF:-}"
if [[ -z "${DEPLOY_CONF}" ]]; then
    if [[ -f "${SCRIPT_DIR}/deploy.conf" ]]; then
        DEPLOY_CONF="${SCRIPT_DIR}/deploy.conf"
    elif [[ -f "/Users/besitzer/Desktop/Boardviewer/deploy.conf" ]]; then
        DEPLOY_CONF="/Users/besitzer/Desktop/Boardviewer/deploy.conf"
    fi
fi

NAS_HOST="rd-nas"; NAS_USER="inwerp"; NAS_PW=""
if [[ -n "${DEPLOY_CONF}" && -f "${DEPLOY_CONF}" ]]; then
    NAS_HOST=$(grep '^server:'  "${DEPLOY_CONF}" | awk '{print $2}')
    NAS_USER=$(grep '^ssh user:' "${DEPLOY_CONF}" | awk '{print $3}')
    NAS_PW=$(grep '^ssh pw:'    "${DEPLOY_CONF}" | awk '{print $3}')
fi
APP_VERSION="$(git describe --tags --always 2>/dev/null || echo dev)-dev"

GREEN='\033[0;32m'; RED='\033[0;31m'; YEL='\033[1;33m'; NC='\033[0m'
info(){ echo -e "${GREEN}[dev-deploy]${NC} $*"; }
warn(){ echo -e "${YEL}[dev-deploy]${NC} $*"; }
err(){ echo -e "${RED}[dev-deploy]${NC} $*" >&2; }

ssh_cmd(){ local c="ssh -o ConnectTimeout=10 -o StrictHostKeyChecking=no -o PubkeyAuthentication=no -p ${NAS_SSH_PORT}"; [[ -n "${NAS_PW}" ]] && command -v sshpass &>/dev/null && c="sshpass -p ${NAS_PW} ${c}"; echo "${c}"; }
scp_cmd(){ local c="scp -O -o ConnectTimeout=10 -o StrictHostKeyChecking=no -o PubkeyAuthentication=no -P ${NAS_SSH_PORT}"; [[ -n "${NAS_PW}" ]] && command -v sshpass &>/dev/null && c="sshpass -p ${NAS_PW} ${c}"; echo "${c}"; }

TAR="/tmp/${DEV_NAME}.tar.gz"

info "Branch: $(git rev-parse --abbrev-ref HEAD)  Version: ${APP_VERSION}  NAS: ${NAS_USER}@${NAS_HOST}  Port: ${DEV_PORT}"

# 1. Build linux/amd64 (NAS is x86). PUBKEY intentionally empty — dev has no
#    docker socket and does not self-update.
info "Building ${DEV_NAME}:${DEV_TAG} for linux/amd64 (this takes a few minutes)..."
docker buildx build --platform linux/amd64 \
    --build-arg APP_VERSION="${APP_VERSION}" \
    -t "${DEV_NAME}:${DEV_TAG}" --load "${SCRIPT_DIR}" || { err "Build failed"; exit 1; }
info "Build complete."

# 2. Export
info "Exporting image to ${TAR}..."
docker save "${DEV_NAME}:${DEV_TAG}" | gzip > "${TAR}"
info "Exported ($(du -h "${TAR}" | awk '{print $1}'))."

# 3. Reachability
info "Checking NAS connectivity..."
$(ssh_cmd) "${NAS_USER}@${NAS_HOST}" "echo ok" >/dev/null 2>&1 || { err "Cannot reach NAS ${NAS_HOST}"; exit 1; }

# 4. Transfer image + remote script
info "Uploading image..."
$(scp_cmd) "${TAR}" "${NAS_USER}@${NAS_HOST}:/tmp/${DEV_NAME}.tar.gz" || { err "Image upload failed"; exit 1; }
info "Uploading remote script..."
$(scp_cmd) "${SCRIPT_DIR}/deploy-remote-dev.sh" "${NAS_USER}@${NAS_HOST}:/tmp/deploy-remote-dev.sh" || { err "Script upload failed"; exit 1; }

# 5. Run on NAS (pass tunables through the environment)
info "Deploying ${DEV_NAME} on NAS..."
$(ssh_cmd) "${NAS_USER}@${NAS_HOST}" "DEV_PORT='${DEV_PORT}' DEV_MEM='${DEV_MEM}' DEV_POOL='${DEV_POOL}' bash /tmp/deploy-remote-dev.sh '${NAS_PW}'"

rm -f "${TAR}"
info "Done. Dev UI: http://${NAS_HOST}:${DEV_PORT}  (live boardripper untouched)"
