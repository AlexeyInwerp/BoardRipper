#!/usr/bin/env bash
# Local dev container: the current working tree, built into the production
# image, served on http://localhost:1234 with samples/ as the library.
#
#   scripts/devcontainer.sh up      build + start + wait for /api/health
#   scripts/devcontainer.sh logs    follow the server log
#   scripts/devcontainer.sh down    stop and remove (keeps .devdata)
#   scripts/devcontainer.sh reset   down + delete .devdata (cold-start install)
#   scripts/devcontainer.sh status  is it up, what version, how many boards
#
# Why this exists: `npm run dev` and Playwright both run the frontend outside
# the container, so neither one exercises the Go server, the embedded static
# bundle, the bundled boards.db, or the pdfium/wazero PDF indexer. This is the
# last check before a release that the thing we actually ship boots and serves.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${REPO_ROOT}/docker-compose.dev.yml"
PORT=1234
URL="http://localhost:${PORT}"
DEVDATA="${REPO_ROOT}/.devdata"

compose() { docker compose -f "${COMPOSE_FILE}" "$@"; }

wait_for_health() {
  printf 'waiting for %s/api/health' "${URL}"
  for _ in $(seq 1 60); do
    if [ "$(curl -s -o /dev/null -w '%{http_code}' "${URL}/api/health" 2>/dev/null || echo 000)" = "200" ]; then
      echo " — up"
      return 0
    fi
    printf '.'
    sleep 2
  done
  echo
  echo "!!! no healthy response after 120s. Last 40 log lines:" >&2
  compose logs --tail 40 >&2
  return 1
}

case "${1:-up}" in
  up)
    # samples/ is gitignored and may legitimately be empty on a fresh clone,
    # but an empty library makes the container look broken rather than bare —
    # say so up front instead of leaving the Library panel unexplained.
    if [ ! -d "${REPO_ROOT}/samples" ] || [ -z "$(ls -A "${REPO_ROOT}/samples" 2>/dev/null)" ]; then
      echo "note: samples/ is empty — the Library panel will have nothing to show." >&2
      echo "      Drop board files in there (they are gitignored) and restart." >&2
    fi
    mkdir -p "${DEVDATA}"
    compose up -d --build
    wait_for_health
    echo
    echo "  BoardRipper dev  →  ${URL}"
    echo "  library          →  ${REPO_ROOT}/samples (read-only)"
    echo "  data             →  ${DEVDATA}"
    ;;
  down)
    compose down
    ;;
  reset)
    compose down
    rm -rf "${DEVDATA}"
    echo "removed ${DEVDATA} — next 'up' is a cold-start install."
    ;;
  logs)
    compose logs -f
    ;;
  status)
    compose ps
    if [ "$(curl -s -o /dev/null -w '%{http_code}' "${URL}/api/health" 2>/dev/null || echo 000)" = "200" ]; then
      echo
      echo "health : $(curl -s "${URL}/api/health")"
      echo "stats  : $(curl -s "${URL}/api/databank/stats")"
    else
      echo
      echo "not answering on ${URL}"
    fi
    ;;
  *)
    sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
