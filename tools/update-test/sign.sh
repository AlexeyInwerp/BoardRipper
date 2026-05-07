#!/usr/bin/env bash
# Build a release tarball from a tagged docker image and a signed manifest
# pointing at it. Mirrors the production release.sh shape but trimmed to what
# the in-binary updater actually validates.
#
# Args:
#   $1 = NEW_IMAGE_TAG (e.g. "boardripper:v0.99.0-test-new")
#   $2 = NEW_VERSION   (e.g. "v0.99.0-test-new")
#   $3 = COUNTER       (monotonic; defaults to 1)
#   $4 = SOURCES_BASE  (single mirror URL, e.g. http://host.docker.internal:18000)
#
# Outputs to release/:
#   boardripper-update-<VERSION>.tar.gz   — `docker save | gzip`
#   manifest.json
#   manifest.json.minisig
set -euo pipefail
cd "$(dirname "$0")"

NEW_IMAGE_TAG="${1:?image tag}"
NEW_VERSION="${2:?version}"
COUNTER="${3:-1}"
SOURCES_BASE="${4:?sources base url}"

mkdir -p release
TARBALL="release/boardripper-update-${NEW_VERSION}.tar.gz"

echo "==> saving $NEW_IMAGE_TAG → $TARBALL"
docker save "$NEW_IMAGE_TAG" | gzip -n > "$TARBALL"

SIZE_BYTES=$(wc -c < "$TARBALL" | tr -d ' ')
SHA256=$(shasum -a 256 "$TARBALL" | awk '{print $1}')

NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
NOT_AFTER=$(date -u -v+90d +%Y-%m-%dT%H:%M:%SZ)

cat > release/manifest.json <<EOF
{
  "version": "${NEW_VERSION}",
  "counter": ${COUNTER},
  "released_at": "${NOW}",
  "not_after": "${NOT_AFTER}",
  "important": false,
  "tarball": {
    "url_primary": "${SOURCES_BASE}/boardripper-update-${NEW_VERSION}.tar.gz",
    "url_mirrors": [],
    "sha256": "${SHA256}",
    "size_bytes": ${SIZE_BYTES}
  },
  "image": {
    "registry": "",
    "tag": "${NEW_VERSION}",
    "digest": ""
  },
  "min_supported_version": "0.0.0",
  "orchestrator_image_digest": "alpine:latest"
}
EOF

echo "==> signing manifest"
# Key was generated with `-W` (no password) so signing is non-interactive.
rm -f release/manifest.json.minisig
minisign -S -s keys/mockup.minisign -m release/manifest.json >/dev/null
test -f release/manifest.json.minisig

echo "==> manifest:"
cat release/manifest.json
echo "==> signature: release/manifest.json.minisig"
ls -la release/
