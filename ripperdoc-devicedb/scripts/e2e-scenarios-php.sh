#!/usr/bin/env bash
# E2E scenarios for the PHP port of ripperdoc-devicedb.
#
# This is the PHP twin of scripts/e2e-scenarios.sh — same 8 scenarios, same
# 25 checks. The only difference is the server-boot section, which uses
# `php -S` with api.php as the router script instead of the Go binary.
#
# Run with:    bash scripts/e2e-scenarios-php.sh
# Override:    SERVER_PORT=18099 bash scripts/e2e-scenarios-php.sh

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PHP_DIR="$ROOT/php"
PORT="${SERVER_PORT:-18092}"
BASE="http://127.0.0.1:$PORT/v1"
SEED="${SEED_DB_PATH:-$ROOT/../Board Database/boards.db}"

pass=0; fail=0; check_n=0
check() {
  check_n=$((check_n+1))
  local name="$1" got="$2" want_re="$3"
  if [[ "$got" =~ $want_re ]]; then
    echo "  ok   [$check_n] $name"
    pass=$((pass+1))
  else
    echo "  FAIL [$check_n] $name"
    echo "         got : $got"
    echo "         want: ~ $want_re"
    fail=$((fail+1))
  fi
}

# Reset state.
rm -rf  "$PHP_DIR/data/canonical.sqlite" "$PHP_DIR/data/canonical.sqlite-shm" "$PHP_DIR/data/canonical.sqlite-wal"
rm -rf  "$PHP_DIR/data/snapshots" "$PHP_DIR/data/logs" "$PHP_DIR/data/snapshot.dev.key" "$PHP_DIR/data/.cron-snapshot.lock"

# Boot server.
echo ">> booting PHP server on :$PORT (seed=$SEED)"
SEED_DB_PATH="$SEED" php -S "127.0.0.1:$PORT" -t "$PHP_DIR" "$PHP_DIR/api.php" > /tmp/devicedb-php.log 2>&1 &
SRV_PID=$!
trap 'kill $SRV_PID 2>/dev/null; wait 2>/dev/null' EXIT
sleep 1

# Sanity probe.
hr=$(curl -sS -o /dev/null -w "%{http_code}" "$BASE/health" || echo "000")
if [[ "$hr" != "200" ]]; then
  echo "FATAL: PHP server failed to boot. Log:"; cat /tmp/devicedb-php.log; exit 1
fi

#-------- 1. health + openapi
echo "[1] basic liveness"
check "health 200 ok"   "$(curl -sS $BASE/health)"          '"ok":true'
check "openapi has paths" "$(curl -sS $BASE/openapi.json | python3 -c "import json,sys;d=json.load(sys.stdin);print(len(d['paths']))")"  '^[0-9]+$'

#-------- 2. read tree (seeded)
echo "[2] read tree"
ent=$(curl -sS $BASE/entities)
check "entities returns brands array" "$ent" '"brands":\['
BOARD_UUID=$(echo "$ent" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['brands'][0]['families'][0]['models'][0]['boards'][0]['uuid'])")
check "extracted board uuid is uuid-shaped" "$BOARD_UUID" '^[0-9a-f-]{36}$'

#-------- 3. install registration + idempotency
echo "[3] install registration"
TOK="plaintext-test-token-$(date +%s)-$$"
out1=$(curl -sS -X POST -H 'content-type: application/json' -d "{\"token\":\"$TOK\",\"version_hint\":\"phptest\"}" $BASE/installs/register)
check "register returns contributor_uuid" "$out1" 'contributor_uuid'
check "register created=true on first call" "$out1" '"created":true'
out2=$(curl -sS -X POST -H 'content-type: application/json' -d "{\"token\":\"$TOK\",\"version_hint\":\"phptest\"}" $BASE/installs/register)
check "re-register idempotent (created=false)" "$out2" '"created":false'

#-------- 4. user registration + duplicate handle
echo "[4] user registration"
HANDLE="alice-$(date +%s)-$$"
ur=$(curl -sS -X POST -H 'content-type: application/json' -d "{\"handle\":\"$HANDLE\",\"email\":\"a@b.com\"}" $BASE/users/register)
check "user reg returns token"  "$ur" '"token":"[A-Za-z0-9_-]+"'
check "user reg warning present" "$ur" 'shown exactly once'
dup=$(curl -sS -X POST -H 'content-type: application/json' -d "{\"handle\":\"$HANDLE\",\"email\":\"x@y.com\"}" $BASE/users/register)
check "duplicate handle → handle_taken"  "$dup" 'handle_taken'

#-------- 5. submit good contribution + auth failures
echo "[5] submit contribution"
auth=$(curl -sS -X POST $BASE/contributions -H 'content-type: application/json' -d '{}')
check "no auth → auth_required" "$auth" 'auth_required'

body='{"target":{"type":"board","uuid":"'$BOARD_UUID'","field":"odm"},"to":"Quanta","from":"","evidence":{"rationale":"because-i-have-the-board"},"confidence":"high","client_ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}'
ok=$(curl -sS -X POST -H "X-BoardRipper-Install-Token: $TOK" -H 'content-type: application/json' -d "$body" $BASE/contributions)
check "submit returns submitted status" "$ok" '"status":"submitted"'
CONTRIB_UUID=$(echo "$ok" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['uuid'])")
check "submit returns uuid-shaped id" "$CONTRIB_UUID" '^[0-9a-f-]{36}$'

# bad evidence
bad='{"target":{"type":"board","uuid":"'$BOARD_UUID'","field":"odm"},"to":"X","from":"","evidence":{},"confidence":"low","client_ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}'
err1=$(curl -sS -X POST -H "X-BoardRipper-Install-Token: $TOK" -H 'content-type: application/json' -d "$bad" $BASE/contributions)
check "empty evidence → evidence_missing" "$err1" 'evidence_missing'

# bad field
bad2='{"target":{"type":"board","uuid":"'$BOARD_UUID'","field":"forbidden_col"},"to":"X","from":"","evidence":{"rationale":"abcd"},"client_ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}'
err2=$(curl -sS -X POST -H "X-BoardRipper-Install-Token: $TOK" -H 'content-type: application/json' -d "$bad2" $BASE/contributions)
check "non-allowlisted field → field_not_writable" "$err2" 'field_not_writable'

# unknown type
bad3='{"target":{"type":"widget","uuid":"00000000-0000-0000-0000-000000000000","field":"x"},"to":"X","from":"","evidence":{"rationale":"abcd"},"client_ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}'
err3=$(curl -sS -X POST -H "X-BoardRipper-Install-Token: $TOK" -H 'content-type: application/json' -d "$bad3" $BASE/contributions)
check "unknown target type → bad_type" "$err3" 'bad_type'

# bad client_ts
bad4='{"target":{"type":"board","uuid":"'$BOARD_UUID'","field":"odm"},"to":"X","from":"","evidence":{"rationale":"abcd"},"client_ts":"1999-01-01T00:00:00Z"}'
err4=$(curl -sS -X POST -H "X-BoardRipper-Install-Token: $TOK" -H 'content-type: application/json' -d "$bad4" $BASE/contributions)
check "stale client_ts → bad_client_ts" "$err4" 'bad_client_ts'

#-------- 6. list mine + withdraw
echo "[6] list mine + withdraw"
mine=$(curl -sS -H "X-BoardRipper-Install-Token: $TOK" $BASE/contributions/mine)
check "mine contains $CONTRIB_UUID" "$mine" "$CONTRIB_UUID"

# create a throw-away submission then withdraw it
body2='{"target":{"type":"board","uuid":"'$BOARD_UUID'","field":"notes"},"to":"throwaway","from":"","evidence":{"rationale":"throwaway-evidence"},"client_ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}'
trash=$(curl -sS -X POST -H "X-BoardRipper-Install-Token: $TOK" -H 'content-type: application/json' -d "$body2" $BASE/contributions)
TRASH_UUID=$(echo "$trash" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['uuid'])")
wd=$(curl -sS -X DELETE -H "X-BoardRipper-Install-Token: $TOK" $BASE/contributions/$TRASH_UUID)
check "withdraw returns status=withdrawn" "$wd" '"status":"withdrawn"'
# can't withdraw twice
wd2=$(curl -sS -X DELETE -H "X-BoardRipper-Install-Token: $TOK" $BASE/contributions/$TRASH_UUID)
check "double-withdraw → not_pending" "$wd2" 'not_pending'

#-------- 7. admin: accept via CLI, then verify canonical update
echo "[7] admin accept (via php admin.php token issue + accept)"
TOK_OUT=$(php "$PHP_DIR/admin.php" token issue --handle moderator-$$ --scopes "contributions:submit,contributions:moderate" 2>/dev/null)
MOD_TOKEN=$(echo "$TOK_OUT" | awk -F'=' '/^token=/{print $2}')
MOD_UUID=$(echo  "$TOK_OUT" | awk -F'=' '/^user_uuid=/{print $2}')
check "moderator token minted" "$MOD_TOKEN" '^[A-Za-z0-9_-]+$'

ar=$(curl -sS -X POST -H "Authorization: Bearer $MOD_TOKEN" "$BASE/admin/contributions/$CONTRIB_UUID/accept")
check "accept returns status=accepted" "$ar" '"status":"accepted"'

# canonical odm should now be Quanta
single=$(curl -sS "$BASE/entities/board/$BOARD_UUID")
check "canonical board.odm = Quanta after accept" "$single" '"odm":"Quanta"'

#-------- 8. snapshot tarball + manifest sanity
echo "[8] signed snapshot"
mani=$(curl -sS "$BASE/snapshots/latest")
check "manifest carries counter ≥ 1"        "$mani" '"counter":[0-9]+'
SIG=$(echo "$mani" | python3 -c 'import json,sys,base64;d=json.load(sys.stdin);print(len(base64.b64decode(d["signature"])))')
check "Ed25519 signature is 64 bytes"        "$SIG"  '^64$'
COUNTER=$(echo "$mani" | python3 -c 'import json,sys;print(json.load(sys.stdin)["counter"])')
tarball=$(curl -sS "$BASE/snapshots/$COUNTER/tarball" -o /tmp/snap-php.tgz -w "%{http_code}")
check "tarball download 200" "$tarball" '^200$'
cd /tmp && rm -rf snap-x && mkdir snap-x && tar xzf /tmp/snap-php.tgz -C snap-x
tablelist=$(sqlite3 /tmp/snap-x/boards.db ".tables")
check "tarball db has 'brands' table" "$tablelist" 'brands'
# Negative lookahead is unsupported in POSIX ERE; do a direct grep.
check_n=$((check_n+1))
if echo "$tablelist" | grep -qE '\bcontributions\b'; then
  echo "  FAIL [$check_n] tarball leaks contributions table!"
  fail=$((fail+1))
else
  echo "  ok   [$check_n] tarball excludes contributions table"
  pass=$((pass+1))
fi

echo
echo "=============================================="
echo " results: $pass passed, $fail failed (of $check_n checks)"
echo "=============================================="
[[ $fail -eq 0 ]] && exit 0 || exit 1
