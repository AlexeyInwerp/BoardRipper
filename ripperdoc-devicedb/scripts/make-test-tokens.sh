#!/usr/bin/env bash
# Local-dev helper: register a user via the CLI, then issue a maintainer
# reviewer token with scope contributions:moderate.
#
# Usage: ./scripts/make-test-tokens.sh
#
# Prints two tokens to stdout (user token, reviewer token).
set -euo pipefail

ADMIN_BIN="${ADMIN_BIN:-./bin/devicedb-cli}"

if [[ ! -x "$ADMIN_BIN" ]]; then
    echo "Build admin CLI first: go build -o ./bin/devicedb-cli ./cmd/admin" >&2
    exit 1
fi

# Register a maintainer user — handle is local-dev fixed.
OUT="$("$ADMIN_BIN" user register --handle maintainer --email dev@localhost)"
USER_UUID="$(echo "$OUT" | grep '^user_uuid=' | cut -d= -f2)"
USER_TOKEN="$(echo "$OUT" | grep '^token=' | cut -d= -f2)"
echo "user_uuid=$USER_UUID"
echo "user_token=$USER_TOKEN"

# Issue a token with reviewer scope.
REVIEWER_TOKEN="$("$ADMIN_BIN" token issue --user-uuid "$USER_UUID" --name maintainer-reviewer --scopes 'contributions:submit,contributions:moderate' 2>/dev/null)"
echo "reviewer_token=$REVIEWER_TOKEN"
