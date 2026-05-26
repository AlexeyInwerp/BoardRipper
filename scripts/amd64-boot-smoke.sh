#!/usr/bin/env bash
# Native-amd64 boot smoke-test for a pushed BoardRipper image.
#
# WHY THIS EXISTS
#   The update-test harness (tools/update-test/run.sh) builds its NEW image with
#   a plain host-arch `docker build`, so on an Apple-Silicon maintainer machine
#   it validates the *arm64* image. v0.31.0 shipped a boot failure that only
#   manifested on amd64 (modernc.org/sqlite v1.34.5 transpiled-libc mmap failure
#   under the Go 1.25 runtime) — invisible to an arm64 gate, fatal for every
#   real amd64 user. The orchestrator healthcheck rolled the update back, so
#   nobody was stranded, but the release was DOA.
#
#   This gate pulls the *pushed* multi-arch image by digest onto real amd64
#   hardware (the NAS named in deploy.conf), boots it bare (the image's built-in
#   65532-owned /data — no bind-mount, so no permission confound), and confirms
#   /api/health serves. It runs an isolated throwaway container on a high port
#   and never touches the live instance or its data.
#
# USAGE
#   scripts/amd64-boot-smoke.sh <image-ref-with-digest>
#   e.g. scripts/amd64-boot-smoke.sh ghcr.io/alexeyinwerp/boardripper@sha256:abc...
#
# EXIT CODES
#   0  image booted and served /api/health on amd64
#   1  image did NOT boot (real failure — do not release)
#   2  could not run the test (no deploy.conf, NAS unreachable, no sshpass).
#      The caller decides whether to treat this as fatal or to override.
set -euo pipefail

IMAGE_REF="${1:-}"
if [[ -z "$IMAGE_REF" ]]; then
  echo "usage: $0 <image-ref-with-digest>" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CONF="$REPO_ROOT/deploy.conf"

if [[ ! -f "$CONF" ]]; then
  echo "amd64-boot-smoke: no deploy.conf at $CONF — cannot reach amd64 hardware" >&2
  exit 2
fi
if ! command -v sshpass >/dev/null 2>&1; then
  echo "amd64-boot-smoke: sshpass not installed — cannot drive password SSH" >&2
  exit 2
fi

NAS_HOST="$(grep '^server:'   "$CONF" | awk '{print $2}')"
NAS_USER="$(grep '^ssh user:' "$CONF" | awk '{print $3}')"
NAS_PW="$(grep '^ssh pw:'     "$CONF" | awk '{print $3}')"
NAS_SSH_PORT="${NAS_SSH_PORT:-22}"
REMOTE_TMP="${REMOTE_TMP:-/volume1/docker}"   # writable to the login user
PORT="${SMOKE_PORT:-18344}"
NAME="br-release-smoke"

if [[ -z "$NAS_HOST" || -z "$NAS_USER" || -z "$NAS_PW" ]]; then
  echo "amd64-boot-smoke: deploy.conf missing server/ssh user/ssh pw" >&2
  exit 2
fi

SSH=(sshpass -p "$NAS_PW" ssh -o ConnectTimeout=10 -o StrictHostKeyChecking=no \
     -o PubkeyAuthentication=no -p "$NAS_SSH_PORT" "${NAS_USER}@${NAS_HOST}")

# Reachability probe — distinguishes "infra down" (exit 2) from "boot failed".
if ! "${SSH[@]}" "echo ok" >/dev/null 2>&1; then
  echo "amd64-boot-smoke: cannot reach NAS ${NAS_HOST} over ssh" >&2
  exit 2
fi

# Remote arch must actually be amd64 for this to mean anything.
REMOTE_ARCH="$("${SSH[@]}" "uname -m" 2>/dev/null || true)"
if [[ "$REMOTE_ARCH" != "x86_64" && "$REMOTE_ARCH" != "amd64" ]]; then
  echo "amd64-boot-smoke: remote arch is '$REMOTE_ARCH', not amd64 — skipping" >&2
  exit 2
fi

# Build the remote boot-test script with the image ref baked in.
REMOTE_SCRIPT="$(cat <<REMOTE
#!/bin/bash
set -u
DOCKER=/usr/local/bin/docker
IMG="$IMAGE_REF"
NAME="$NAME"
PORT="$PORT"
\$DOCKER rm -f "\$NAME" >/dev/null 2>&1
echo "[smoke] arch=\$(uname -m)"
echo "[smoke] pulling \$IMG"
if ! \$DOCKER pull "\$IMG" >/dev/null 2>&1; then
  echo "BOOT_SMOKE_RESULT: FAIL (pull)"; exit 0
fi
\$DOCKER run -d --name "\$NAME" -p \${PORT}:8080 -m 1g "\$IMG" >/dev/null 2>&1
UP=no
for i in \$(seq 1 45); do
  if curl -s -o /dev/null -m 2 "http://127.0.0.1:\${PORT}/api/health" 2>/dev/null; then
    UP=yes; break
  fi
  # bail early if the container already exited
  st=\$(\$DOCKER inspect "\$NAME" --format '{{.State.Status}}' 2>/dev/null || echo gone)
  [ "\$st" = exited ] && break
  sleep 2
done
echo "[smoke] state=\$(\$DOCKER inspect "\$NAME" --format 'status={{.State.Status}} exit={{.State.ExitCode}}' 2>/dev/null)"
echo "[smoke] --- boot logs (tail) ---"
\$DOCKER logs "\$NAME" 2>&1 | tail -15
\$DOCKER rm -f "\$NAME" >/dev/null 2>&1
if [ "\$UP" = yes ]; then echo "BOOT_SMOKE_RESULT: OK"; else echo "BOOT_SMOKE_RESULT: FAIL (no health)"; fi
REMOTE
)"

REMOTE_PATH="$REMOTE_TMP/br-release-smoke.sh"
# Stream the script over ssh (SFTP is chrooted on this Synology, so scp fails).
if ! printf '%s\n' "$REMOTE_SCRIPT" | "${SSH[@]}" "cat > '$REMOTE_PATH'"; then
  echo "amd64-boot-smoke: failed to upload remote test script" >&2
  exit 2
fi

echo ">>> amd64 boot smoke-test on ${NAS_HOST} (${REMOTE_ARCH})"
OUT="$("${SSH[@]}" "echo '$NAS_PW' | sudo -S bash '$REMOTE_PATH' 2>&1; rm -f '$REMOTE_PATH'" 2>&1 || true)"
# Echo the remote output (indented) for the operator's log.
printf '%s\n' "$OUT" | sed 's/^/    /'

if printf '%s\n' "$OUT" | grep -q 'BOOT_SMOKE_RESULT: OK'; then
  echo ">>> amd64 boot smoke-test: PASS"
  exit 0
fi
echo ">>> amd64 boot smoke-test: FAIL" >&2
exit 1
