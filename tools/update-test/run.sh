#!/usr/bin/env bash
# End-to-end update test harness.
#
#  1. Generates a throwaway minisign key on first run.
#  2. Builds OLD + NEW boardripper images pinned to that pubkey + a local
#     mockup mirror URL.
#  3. Signs a release manifest pointing at the NEW image's tarball.
#  4. Starts a mockup HTTP server (Python http.server) that serves the
#     manifest + signature + tarball.
#  5. Starts the OLD container (with /var/run/docker.sock mounted so its
#     in-binary updater can orchestrate a restart).
#  6. Hands control to the Playwright harness in playwright/.
#
# Re-runs are idempotent: the mockup data volume is wiped at the start of
# each run so the install counter resets to 0 and the same manifest counter
# (1) is always accepted as a fresh install.
set -euo pipefail
cd "$(dirname "$0")"
HARNESS_DIR="$(pwd)"
REPO_ROOT="$(cd ../.. && pwd)"

# --- Tunables ---
OLD_VERSION="${OLD_VERSION:-v0.99.0-test-old}"
NEW_VERSION="${NEW_VERSION:-v0.99.0-test-new}"
OLD_IMAGE_TAG="boardripper:${OLD_VERSION}"
NEW_IMAGE_TAG="boardripper:${NEW_VERSION}"
HOST_PORT="${HOST_PORT:-18081}"
MOCK_PORT="${MOCK_PORT:-18000}"
CONTAINER_NAME="${CONTAINER_NAME:-boardripper-update-test}"
DATA_VOLUME="${DATA_VOLUME:-boardripper-update-test-data}"
# host.docker.internal works on Docker Desktop / Mac. On Linux you may need
# to add `--add-host host.docker.internal:host-gateway` to the run cmd; not
# wired up here because the project's primary target is darwin.
SOURCES_URL="http://host.docker.internal:${MOCK_PORT}"

cleanup() {
  echo
  echo "==> cleanup"
  if [[ -n "${LOG_PID:-}" ]]; then kill "$LOG_PID" 2>/dev/null || true; fi
  if [[ -n "${ORCH_LOG_PID:-}" ]]; then kill "$ORCH_LOG_PID" 2>/dev/null || true; fi
  docker rm -f "$CONTAINER_NAME" "${CONTAINER_NAME}-old" boardripper-orchestrator >/dev/null 2>&1 || true
  if [[ -n "${MOCK_PID:-}" ]]; then
    kill "$MOCK_PID" 2>/dev/null || true
    wait "$MOCK_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# --- 1. Keys ---
./keys.sh

PUBKEY="$(cat keys/pubkey.txt)"
if [[ -z "$PUBKEY" ]]; then
  echo "ERROR: empty pubkey" >&2
  exit 1
fi

# --- 2. Build images (cached on second run) ---
echo "==> building OLD image $OLD_IMAGE_TAG"
docker build \
  --build-arg "APP_VERSION=${OLD_VERSION}" \
  --build-arg "PUBKEY=${PUBKEY}" \
  --build-arg "SOURCES=${SOURCES_URL}" \
  -t "$OLD_IMAGE_TAG" \
  "$REPO_ROOT" >/dev/null

echo "==> building NEW image $NEW_IMAGE_TAG"
docker build \
  --build-arg "APP_VERSION=${NEW_VERSION}" \
  --build-arg "PUBKEY=${PUBKEY}" \
  --build-arg "SOURCES=${SOURCES_URL}" \
  -t "$NEW_IMAGE_TAG" \
  "$REPO_ROOT" >/dev/null

# --- 3. Sign release ---
./sign.sh "$NEW_IMAGE_TAG" "$NEW_VERSION" 1 "$SOURCES_URL"

# Pre-pull the orchestrator base image so the orchestrator doesn't spend
# 10-30 s on a cold pull during the test (timing matters for the playwright
# deadline and for the frontend's overlay window).
echo "==> pre-pulling alpine:latest for orchestrator"
docker pull alpine:latest >/dev/null

# --- 4. Mockup HTTP server ---
echo "==> starting mockup server on :$MOCK_PORT"
(
  cd release
  exec python3 -m http.server "$MOCK_PORT" --bind 0.0.0.0 >../results.mockup.log 2>&1
) &
MOCK_PID=$!

# Wait for server to be reachable
for i in $(seq 1 20); do
  if curl -sf "http://localhost:${MOCK_PORT}/manifest.json" >/dev/null; then
    echo "    mockup server reachable"
    break
  fi
  sleep 0.2
done

# Sanity: verify the manifest is reachable from a container too.
# (boardripper itself is FROM scratch with no shell, so we use plain alpine.)
echo "==> verifying manifest reachable from container network"
# wget timeout makes this self-bounded; macOS BSD lacks `timeout` so don't wrap.
if ! docker run --rm alpine:latest \
    wget -q --timeout=10 -O /dev/null "http://host.docker.internal:${MOCK_PORT}/manifest.json"; then
  echo "WARN: container could not reach host.docker.internal:${MOCK_PORT}." >&2
  echo "      On Linux you may need --add-host host.docker.internal:host-gateway." >&2
fi

# --- 5. Wipe stale state, start OLD container ---
docker rm -f "$CONTAINER_NAME" "${CONTAINER_NAME}-old" boardripper-orchestrator >/dev/null 2>&1 || true
docker volume rm "$DATA_VOLUME" >/dev/null 2>&1 || true
docker volume create "$DATA_VOLUME" >/dev/null

echo "==> starting OLD container ($CONTAINER_NAME) on :$HOST_PORT"
# --user 0:0 mirrors `scripts/deploy-remote.sh` (line ~143). Since 430a219
# (2026-05-12) the image ships USER 65532 — without an override the
# container can't read /var/run/docker.sock and every updater call fails
# with `permission denied`. The harness has no `docker` group plumbing
# of its own; running as root matches what every real NAS deploy does.
docker run -d \
  --name "$CONTAINER_NAME" \
  --user 0:0 \
  -p "${HOST_PORT}:8080" \
  -v "/var/run/docker.sock:/var/run/docker.sock" \
  -v "${DATA_VOLUME}:/data" \
  "$OLD_IMAGE_TAG" >/dev/null

# Stream the OLD container's stdout to a file from the moment it boots so we
# preserve apply()/orchestrate logs even when the orchestrator removes the
# container post-swap. A second stream watches for the orchestrator
# container appearing.
mkdir -p results
docker logs -f "$CONTAINER_NAME" > "${HARNESS_DIR}/results/old-stream.log" 2>&1 &
LOG_PID=$!

# Wait for the orchestrator container to appear, then start tailing it. The
# orchestrator is short-lived (success → AutoRemove cleans up; failure → still
# vanishes after the hook commands run); without this watcher its logs are
# unrecoverable.
(
  while ! docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q '^boardripper-orchestrator$'; do
    sleep 0.2
  done
  docker logs -f boardripper-orchestrator > "${HARNESS_DIR}/results/orchestrator-stream.log" 2>&1
) &
ORCH_LOG_PID=$!

# Wait for /api/health
echo "==> waiting for /api/health"
for i in $(seq 1 60); do
  if curl -sf "http://localhost:${HOST_PORT}/api/health" >/dev/null; then
    echo "    OLD container healthy"
    break
  fi
  sleep 0.5
done

# --- 6. Hand off to Playwright ---
mkdir -p results
export BR_HARNESS_URL="http://localhost:${HOST_PORT}"
export BR_HARNESS_OLD_VERSION="${OLD_VERSION}"
export BR_HARNESS_NEW_VERSION="${NEW_VERSION}"
export BR_HARNESS_RESULTS_DIR="${HARNESS_DIR}/results"

cd playwright
if [[ ! -d node_modules ]]; then
  echo "==> installing playwright deps"
  npm install --silent
fi

echo "==> running playwright harness"
set +e
npx playwright test --reporter=list "$@"
PW_RC=$?
set -e

# Capture container logs so the operator sees them alongside screenshots
docker logs "$CONTAINER_NAME" > "${HARNESS_DIR}/results/old-container.log" 2>&1 || true
if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}-old$"; then
  docker logs "${CONTAINER_NAME}-old" > "${HARNESS_DIR}/results/old-container-postswap.log" 2>&1 || true
fi
if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
  # If the swap succeeded, $CONTAINER_NAME is now the NEW container.
  docker logs "$CONTAINER_NAME" > "${HARNESS_DIR}/results/new-container.log" 2>&1 || true
fi
docker logs boardripper-orchestrator > "${HARNESS_DIR}/results/orchestrator.log" 2>&1 || true

echo "==> done (exit=$PW_RC). Logs + screenshots in ${HARNESS_DIR}/results/"
exit $PW_RC
