#!/usr/bin/env bash
#
# End-to-end scenario tests for the ripperdoc-devicedb service.
#
# Boots the server in the background (using `go run` against the project
# boards.db), runs eight scenarios against it via curl + admin CLI, and
# reports pass/fail. Exits non-zero on any failure.
#
# Scenarios:
#   1. Boot + seed + health
#   2. Anonymous install registers
#   3. Install pushes a contribution
#   4. Admin queue lists the submission
#   5. Admin accepts -> canonical entity updates
#   6. User registers + receives a token
#   7. User pushes a contribution with bearer token -> queue shows user attribution
#   8. Snapshot manifest + tarball downloadable
#
# Designed to be re-runnable: data dir wiped before each run.

set -euo pipefail

cd "$(dirname "$0")/.."

DATA_DIR="${DATA_DIR:-./data-test}"
LISTEN_ADDR="${LISTEN_ADDR:-:18090}"
BASE="http://localhost${LISTEN_ADDR}"
SEED="../Board Database/boards.db"
SNAP_TARBALL_BASE="$BASE/v1/snapshots"

# Wrapper so the admin CLI uses the same snapshot URL prefix as the server.
admin() {
  SNAPSHOT_TARBALL_BASE_URL="$SNAP_TARBALL_BASE" DATA_DIR="$DATA_DIR" ./bin/admin "$@"
}

pass=0
fail=0
declare -a failures=()

# ANSI colour helpers — only when stdout is a tty.
if [[ -t 1 ]]; then
  green=$'\033[32m'; red=$'\033[31m'; yellow=$'\033[33m'; reset=$'\033[0m'
else
  green=""; red=""; yellow=""; reset=""
fi

note()    { printf "%s» %s%s\n" "$yellow" "$*" "$reset"; }
ok()      { printf "%s✓ %s%s\n"  "$green"  "$*" "$reset"; pass=$((pass+1)); }
bad()     { printf "%s✗ %s%s\n"  "$red"    "$*" "$reset"; fail=$((fail+1)); failures+=("$*"); }
section() { printf "\n%s── %s ──%s\n" "$yellow" "$*" "$reset"; }

cleanup() {
  if [[ -n "${SERVER_PID:-}" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    note "stopping server (pid $SERVER_PID)"
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# ─────────────────────────────────────────────────────────────────────────
# Setup
# ─────────────────────────────────────────────────────────────────────────
section "setup"

if [[ ! -f "$SEED" ]]; then
  bad "seed DB not found at $SEED"
  exit 1
fi
ok "seed DB present at $SEED"

note "wiping $DATA_DIR"
rm -rf "$DATA_DIR"
mkdir -p "$DATA_DIR"

note "building server + admin CLI"
go build -o ./bin/server ./cmd/server
go build -o ./bin/admin  ./cmd/admin
ok "built server + admin binaries"

note "booting server on $LISTEN_ADDR (logs -> $DATA_DIR/server.log)"
LISTEN_ADDR="$LISTEN_ADDR" \
  DATA_DIR="$DATA_DIR" \
  SEED_DB_PATH="$SEED" \
  WEB_DIR="./web" \
  SNAPSHOT_TARBALL_BASE_URL="$BASE/v1/snapshots" \
  ./bin/server > "$DATA_DIR/server.log" 2>&1 &
SERVER_PID=$!

# Wait for health (max 15s).
for i in {1..30}; do
  if curl -fs "$BASE/v1/health" >/dev/null 2>&1; then break; fi
  sleep 0.5
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    bad "server crashed during boot; see $DATA_DIR/server.log"
    exit 1
  fi
done
if ! curl -fs "$BASE/v1/health" >/dev/null; then
  bad "server failed to reach health after 15s"
  exit 1
fi
ok "server healthy"

# ─────────────────────────────────────────────────────────────────────────
# Scenario 1 — entities load
# ─────────────────────────────────────────────────────────────────────────
section "scenario 1: entities load"

ent=$(curl -fs "$BASE/v1/entities")
brand_count=$(echo "$ent" | jq '(.brands // []) | length')
if [[ "$brand_count" -gt 0 ]]; then
  ok "seeded $brand_count brand(s)"
else
  bad "no brands found in seeded DB"
fi

# Pick a sample board UUID for later patch tests.
BOARD_UUID=$(echo "$ent" | jq -r '.brands[0].families[0].models[0].boards[0].uuid')
BOARD_ODM_NOW=$(echo "$ent" | jq -r '.brands[0].families[0].models[0].boards[0].odm // ""')

if [[ -z "$BOARD_UUID" || "$BOARD_UUID" == "null" ]]; then
  bad "could not extract a sample board UUID from /v1/entities"
  exit 1
fi
ok "sample board UUID: $BOARD_UUID  (current odm='$BOARD_ODM_NOW')"

# ─────────────────────────────────────────────────────────────────────────
# Scenario 2 — anonymous install registers
# ─────────────────────────────────────────────────────────────────────────
section "scenario 2: anonymous install registration"

INSTALL_TOK="install-tok-$(date +%s)-$RANDOM"
reg=$(curl -fs -X POST "$BASE/v1/installs/register" \
  -H 'content-type: application/json' \
  -d "{\"token\":\"$INSTALL_TOK\",\"version_hint\":\"e2e-test/0.0\"}")
INSTALL_UUID=$(echo "$reg" | jq -r '.contributor_uuid')
if [[ -z "$INSTALL_UUID" || "$INSTALL_UUID" == "null" ]]; then
  bad "no contributor_uuid in registration response: $reg"
else
  ok "registered install $INSTALL_UUID"
fi

# Re-register should be idempotent.
reg2=$(curl -fs -X POST "$BASE/v1/installs/register" \
  -H 'content-type: application/json' \
  -d "{\"token\":\"$INSTALL_TOK\",\"version_hint\":\"e2e-test/0.0\"}")
if [[ "$(echo "$reg2" | jq -r '.contributor_uuid')" == "$INSTALL_UUID" ]]; then
  ok "re-register is idempotent"
else
  bad "re-register returned a different uuid"
fi

# ─────────────────────────────────────────────────────────────────────────
# Scenario 3 — install pushes a contribution
# ─────────────────────────────────────────────────────────────────────────
section "scenario 3: install-only contribution push"

NEW_ODM="E2E-TestODM-$(date +%s)"
NOW_TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
sub_body=$(jq -nc \
  --arg t "board" --arg u "$BOARD_UUID" --arg f "odm" \
  --arg to "$NEW_ODM" --arg from "$BOARD_ODM_NOW" \
  --arg r "End-to-end scenario test" \
  --arg ts "$NOW_TS" \
  '{target:{type:$t,uuid:$u,field:$f}, to:$to, from:$from,
    evidence:{rationale:$r}, confidence:"medium", client_ts:$ts}')

sub=$(curl -fs -X POST "$BASE/v1/contributions" \
  -H "X-BoardRipper-Install-Token: $INSTALL_TOK" \
  -H 'content-type: application/json' \
  -d "$sub_body")
SUB_UUID=$(echo "$sub" | jq -r '.uuid')
if [[ -z "$SUB_UUID" || "$SUB_UUID" == "null" ]]; then
  bad "submission did not return uuid: $sub"
else
  ok "submitted contribution $SUB_UUID"
fi

# Validation: refuse a non-allowlisted field.
bad_resp=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/contributions" \
  -H "X-BoardRipper-Install-Token: $INSTALL_TOK" \
  -H 'content-type: application/json' \
  -d "$(jq -nc --arg u "$BOARD_UUID" --arg ts "$NOW_TS" \
        '{target:{type:"board",uuid:$u,field:"uuid"},to:"x",from:"y",
          evidence:{rationale:"trying to rewrite uuid"}, client_ts:$ts}')")
if [[ "$bad_resp" == "400" ]]; then
  ok "non-allowlisted field rejected with 400"
else
  bad "expected 400 for field_not_writable, got $bad_resp"
fi

# Validation: refuse missing evidence.
bad_ev=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/contributions" \
  -H "X-BoardRipper-Install-Token: $INSTALL_TOK" \
  -H 'content-type: application/json' \
  -d "$(jq -nc --arg u "$BOARD_UUID" --arg ts "$NOW_TS" \
        '{target:{type:"board",uuid:$u,field:"notes"},to:"x",from:"",evidence:{}, client_ts:$ts}')")
if [[ "$bad_ev" == "400" ]]; then
  ok "missing evidence rejected with 400"
else
  bad "expected 400 for evidence_missing, got $bad_ev"
fi

# ─────────────────────────────────────────────────────────────────────────
# Scenario 4 — admin queue lists the submission
# ─────────────────────────────────────────────────────────────────────────
section "scenario 4: admin queue inspection"

q=$(admin queue list --status submitted 2>&1)
if echo "$q" | grep -q "$SUB_UUID"; then
  ok "admin sees submission in queue"
else
  bad "admin queue did not show $SUB_UUID — output: $q"
fi

# ─────────────────────────────────────────────────────────────────────────
# Scenario 5 — admin accepts -> canonical entity updates
# ─────────────────────────────────────────────────────────────────────────
section "scenario 5: admin accepts patch"

acc=$(admin accept "$SUB_UUID" 2>&1)
if echo "$acc" | grep -qi "accepted"; then
  ok "admin accept returned: $(echo "$acc" | head -1)"
else
  bad "admin accept output unexpected: $acc"
fi

board_after=$(curl -fs "$BASE/v1/entities/board/$BOARD_UUID")
odm_after=$(echo "$board_after" | jq -r '.odm // ""')
if [[ "$odm_after" == "$NEW_ODM" ]]; then
  ok "canonical board.odm now = '$odm_after'"
else
  bad "expected odm='$NEW_ODM', got '$odm_after'"
fi

# Public history endpoint should show the accepted contribution.
hist=$(curl -fs "$BASE/v1/entities/board/$BOARD_UUID/contributions?status=accepted")
if echo "$hist" | jq -e ".contributions[] | select(.uuid == \"$SUB_UUID\")" >/dev/null 2>&1; then
  ok "accepted contribution shows in public history"
else
  bad "accepted contribution missing from public history: $hist"
fi

# ─────────────────────────────────────────────────────────────────────────
# Scenario 6 — user registration
# ─────────────────────────────────────────────────────────────────────────
section "scenario 6: user registration"

HANDLE="e2e-tester-$(date +%s)"
ureg=$(curl -fs -X POST "$BASE/v1/users/register" \
  -H 'content-type: application/json' \
  -d "$(jq -nc --arg h "$HANDLE" \
        '{handle:$h,email:"e2e@example.org"}')")
USER_UUID=$(echo "$ureg" | jq -r '.user_uuid')
USER_TOKEN=$(echo "$ureg" | jq -r '.token')
if [[ -n "$USER_UUID" && "$USER_UUID" != "null" && -n "$USER_TOKEN" && "$USER_TOKEN" != "null" ]]; then
  ok "registered user $HANDLE  (uuid=$USER_UUID, token=${USER_TOKEN:0:8}…)"
else
  bad "user registration response missing uuid or token: $ureg"
  exit 1
fi

# Duplicate handle should 409.
dup_code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/users/register" \
  -H 'content-type: application/json' \
  -d "$(jq -nc --arg h "$HANDLE" '{handle:$h}')")
if [[ "$dup_code" == "409" ]]; then
  ok "duplicate handle rejected with 409"
else
  bad "expected 409 for duplicate handle, got $dup_code"
fi

# ─────────────────────────────────────────────────────────────────────────
# Scenario 7 — user pushes a contribution with bearer token
# ─────────────────────────────────────────────────────────────────────────
section "scenario 7: user-attributed contribution push"

# Pick a different writable field this time so optimistic concurrency
# doesn't trip us up.
# Read current notes value so `from` matches — the seed DB ships boards
# with non-empty `notes` (e.g. "researched:filename-list brand=ASUS").
CURRENT_NOTES=$(curl -fs "$BASE/v1/entities/board/$BOARD_UUID" | jq -r '.notes // ""')
NEW_NOTES="Reviewed by $HANDLE during e2e run"
NOW_TS2=$(date -u +%Y-%m-%dT%H:%M:%SZ)
sub2_body=$(jq -nc \
  --arg u "$BOARD_UUID" --arg notes "$NEW_NOTES" --arg from "$CURRENT_NOTES" --arg ts "$NOW_TS2" \
  '{target:{type:"board",uuid:$u,field:"notes"}, to:$notes, from:$from,
    evidence:{source_url:"https://example.org/repair-notes"}, confidence:"high",
    client_ts:$ts}')

sub2=$(curl -fs -X POST "$BASE/v1/contributions" \
  -H "Authorization: Bearer $USER_TOKEN" \
  -H 'content-type: application/json' \
  -d "$sub2_body")
SUB2_UUID=$(echo "$sub2" | jq -r '.uuid')
if [[ -n "$SUB2_UUID" && "$SUB2_UUID" != "null" ]]; then
  ok "user submission accepted into queue: $SUB2_UUID"
else
  bad "user submission missing uuid: $sub2"
fi

# Admin queue should now show user attribution.
q2=$(admin queue show "$SUB2_UUID" 2>&1)
if echo "$q2" | grep -q "$HANDLE"; then
  ok "admin queue shows user handle '$HANDLE'"
else
  note "queue show output (no handle match):"
  echo "$q2" | sed 's/^/    /'
  bad "admin queue did not surface user handle"
fi

# Cross-source: install + user token together.
CURRENT_NAME=$(curl -fs "$BASE/v1/entities/board/$BOARD_UUID" | jq -r '.board_name // ""')
NOW_TS3=$(date -u +%Y-%m-%dT%H:%M:%SZ)
both_body=$(jq -nc --arg u "$BOARD_UUID" --arg from "$CURRENT_NAME" --arg ts "$NOW_TS3" \
  '{target:{type:"board",uuid:$u,field:"board_name"}, to:"Both-token board", from:$from,
    evidence:{rationale:"testing dual-auth path"}, confidence:"low",
    client_ts:$ts}')
both=$(curl -fs -X POST "$BASE/v1/contributions" \
  -H "X-BoardRipper-Install-Token: $INSTALL_TOK" \
  -H "Authorization: Bearer $USER_TOKEN" \
  -H 'content-type: application/json' \
  -d "$both_body")
BOTH_UUID=$(echo "$both" | jq -r '.uuid')
if [[ -n "$BOTH_UUID" && "$BOTH_UUID" != "null" ]]; then
  ok "dual-auth submission accepted: $BOTH_UUID"
else
  bad "dual-auth submission rejected: $both"
fi

# Accept the dual one and verify it carries both install_uuid AND
# user contributor_uuid in audit (best-effort grep on `queue show`).
admin accept "$BOTH_UUID" >/dev/null
show_dual=$(admin queue show "$BOTH_UUID" 2>&1)
if echo "$show_dual" | grep -qi 'install'; then
  ok "dual-auth submission audit-shows install presence"
else
  note "(dual-auth audit detail unavailable in queue show output)"
fi

# ─────────────────────────────────────────────────────────────────────────
# Scenario 8 — snapshot manifest + tarball
# ─────────────────────────────────────────────────────────────────────────
section "scenario 8: snapshot download"

# Force a regen so the snapshot reflects accepted changes.
admin snapshot regenerate >/dev/null 2>&1 || \
  note "(snapshot regenerate output suppressed — may be a no-op if endpoint regenerated lazily)"

man=$(curl -fs "$BASE/v1/snapshots/latest")
COUNTER=$(echo "$man" | jq -r '.counter')
TARBALL_URL=$(echo "$man" | jq -r '.tarball_url')
SHA256=$(echo "$man" | jq -r '.tarball_sha256')

if [[ -n "$COUNTER" && "$COUNTER" != "null" && "$COUNTER" -ge 1 ]]; then
  ok "manifest counter=$COUNTER"
else
  bad "manifest missing counter: $man"
fi

if [[ -n "$TARBALL_URL" && "$TARBALL_URL" != "null" ]]; then
  ok "tarball url: $TARBALL_URL"
else
  bad "manifest missing tarball_url"
fi

# Download + sha-check (tarball URL might be absolute; use curl directly).
download_url="$TARBALL_URL"
case "$download_url" in
  http*) ;;  # already absolute
  *) download_url="$BASE$TARBALL_URL" ;;
esac
tmp_tarball="$DATA_DIR/snap.tar.gz"
if curl -fs "$download_url" -o "$tmp_tarball"; then
  ok "downloaded tarball ($(wc -c < "$tmp_tarball") bytes)"
else
  bad "tarball download failed"
fi

if [[ -f "$tmp_tarball" ]]; then
  got_sha=$(shasum -a 256 "$tmp_tarball" | awk '{print $1}')
  if [[ "$got_sha" == "$SHA256" ]]; then
    ok "tarball sha256 matches manifest"
  else
    bad "sha mismatch: manifest=$SHA256 actual=$got_sha"
  fi
fi

# Tarball must NOT contain contributions/tokens/audit (spec §9 invariant #2).
if [[ -f "$tmp_tarball" ]]; then
  contents=$(tar -tzf "$tmp_tarball" 2>/dev/null || echo "")
  # The tarball ships a SQLite, so use sqlite3 to check tables if available.
  if command -v sqlite3 >/dev/null; then
    extracted_db="$DATA_DIR/snap-extracted.db"
    rm -f "$extracted_db"
    tar -xzf "$tmp_tarball" -C "$DATA_DIR" --strip-components=0 2>/dev/null || true
    snap_db_file=$(find "$DATA_DIR" -name 'boards*.db' -newer "$tmp_tarball" 2>/dev/null | head -1)
    if [[ -z "$snap_db_file" ]]; then
      # Fall back: extract any *.db
      snap_db_file=$(tar -tzf "$tmp_tarball" 2>/dev/null | grep -E '\.db$' | head -1)
      [[ -n "$snap_db_file" ]] && tar -xzf "$tmp_tarball" -C "$DATA_DIR" "$snap_db_file" 2>/dev/null && \
        snap_db_file="$DATA_DIR/$snap_db_file"
    fi
    if [[ -n "$snap_db_file" && -f "$snap_db_file" ]]; then
      tables=$(sqlite3 "$snap_db_file" ".tables")
      bad_tables=$(echo "$tables" | tr -s ' \n' '\n' | grep -E '^(contributions|contributors|install_tokens|user_tokens|contribution_audit)$' || true)
      if [[ -z "$bad_tables" ]]; then
        ok "tarball SQLite contains only entity tables (no contributions/tokens/audit)"
      else
        bad "tarball SQLite contains sensitive tables: $bad_tables"
      fi
    else
      note "(could not locate extracted .db file; skipping table check)"
    fi
  else
    note "(sqlite3 not available; skipping tarball table check)"
  fi
fi

# ─────────────────────────────────────────────────────────────────────────
# Summary
# ─────────────────────────────────────────────────────────────────────────
section "summary"

printf "%spass: %d%s   %sfail: %d%s\n" \
  "$green" "$pass" "$reset" \
  "$red"   "$fail" "$reset"

if (( fail > 0 )); then
  echo
  echo "Failures:"
  for f in "${failures[@]}"; do echo "  - $f"; done
  exit 1
fi
exit 0
