#!/usr/bin/env bash
# Generates a throwaway minisign signing key for the update test harness, on
# first run. Subsequent runs reuse the key so the same OLD image (built with
# its compiled-in pubkey) keeps verifying manifests.
#
# Outputs:
#   keys/mockup.minisign         — secret key (passwordless; test-only)
#   keys/mockup.minisign.pub     — public key file
#   keys/pubkey.txt              — raw base64 pubkey for --build-arg PUBKEY=...
set -euo pipefail
cd "$(dirname "$0")"

KEYDIR="keys"
mkdir -p "$KEYDIR"

if [[ ! -f "$KEYDIR/mockup.minisign" ]]; then
  echo "==> generating throwaway minisign key (test-only, empty passphrase)"
  # `aead.dev/minisign` (the Go pkg the binary uses for verify) accepts both
  # `minisign` and `signify` keys. Use empty password so the harness is
  # non-interactive.
  echo -e "\n\n" | minisign -fGW -p "$KEYDIR/mockup.minisign.pub" -s "$KEYDIR/mockup.minisign" >/dev/null
fi

# Extract base64 pubkey (drop the `untrusted comment` header line). Same form
# as scripts/release.sh:91, so the harness mirrors the production pipeline.
grep -v '^untrusted' "$KEYDIR/mockup.minisign.pub" | tr -d '\n' > "$KEYDIR/pubkey.txt"
echo "==> pubkey: $(cat "$KEYDIR/pubkey.txt")"
