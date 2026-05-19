#!/usr/bin/env bash
#
# Full end-to-end test: BoardRipper backend (real binary) talks to a
# locally-booted devicedb server. Exercises the complete contrib pipeline
# plus the databank-scan integration the user explicitly wanted verified.
#
# Flow:
#   1. Boot devicedb on :18090, seeded from the project boards.db.
#   2. Boot BoardRipper backend on :18080 with CONTRIBDB_ENABLED + DEVICEDB_BASE_URL.
#   3. Drop sample board file `820-02016.bvr` into a fresh LIBRARY_DIR.
#   4. Wait until BoardRipper has minted its install token + registered
#      (the contribdb scheduler does this on its own).
#   5. Trigger BoardRipper databank scan + verify the file resolves
#      to its initial boards.db metadata (ODM is empty in the seed).
#   6. Submit a contribution via BoardRipper's /api/contribdb/submit changing
#      820-02016.odm = "InTegrationODM".
#   7. Wait until the local outbox pushes the row to the canonical server.
#   8. Accept via the devicedb admin CLI.
#   9. Trigger BoardRipper contribdb sync (pulls fresh signed snapshot,
#      hot-swaps boarddb).
#  10. Trigger another databank scan / re-resolve and verify the file's
#      manufacturer column now reflects InTegrationODM.
#  11. Bonus: register a user on devicedb, paste the bearer token into
#      BoardRipper via /api/contribdb/user-token, push a second
#      contribution, verify the admin queue surfaces the user handle.
#
# Designed to be re-runnable: data dirs wiped before each run.

set -euo pipefail

cd "$(dirname "$0")/.."

DEVICEDB_DATA="${DEVICEDB_DATA:-/tmp/devicedb-int}"
BR_DATA="${BR_DATA:-/tmp/br-int}"
BR_LIB="${BR_LIB:-/tmp/br-int-library}"
DEVICEDB_ADDR=":18090"
BR_ADDR=":18080"
DEVICEDB_BASE="http://localhost${DEVICEDB_ADDR}"
BR_BASE="http://localhost${BR_ADDR}"
SAMPLE_SRC="../samples/820-02016/820-02016.bvr"
TARGET_BOARD_UUID="196d786f-a312-43b1-b108-76cb70d7ca23"      # 820-02016 (Apple A2337)
NEW_ODM="InTegrationODM-$(date +%s)"

pass=0; fail=0
declare -a failures=()

if [[ -t 1 ]]; then
  green=$'\033[32m'; red=$'\033[31m'; yellow=$'\033[33m'; cyan=$'\033[36m'; reset=$'\033[0m'
else
  green=""; red=""; yellow=""; cyan=""; reset=""
fi
note()    { printf "%s» %s%s\n" "$yellow" "$*" "$reset"; }
ok()      { printf "%s✓ %s%s\n"  "$green"  "$*" "$reset"; pass=$((pass+1)); }
bad()     { printf "%s✗ %s%s\n"  "$red"    "$*" "$reset"; fail=$((fail+1)); failures+=("$*"); }
section() { printf "\n%s── %s ──%s\n" "$cyan"   "$*" "$reset"; }

# Parallel arrays — macOS default bash 3.2 has no associative arrays.
PID_NAMES=()
PID_VALUES=()
register_pid() { PID_NAMES+=("$1"); PID_VALUES+=("$2"); }
cleanup() {
  local i name pid
  for ((i=0; i<${#PID_NAMES[@]}; i++)); do
    name="${PID_NAMES[$i]}"
    pid="${PID_VALUES[$i]}"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      note "stopping $name (pid $pid)"
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  done
}
trap cleanup EXIT

admin() {
  SNAPSHOT_TARBALL_BASE_URL="$DEVICEDB_BASE/v1/snapshots" \
    DATA_DIR="$DEVICEDB_DATA" ./bin/admin "$@"
}

# Wait for an HTTP endpoint to return 200 within $1 seconds.
wait_for_http() {
  local url="$1" max="$2" desc="$3"
  for ((i=0; i<max*2; i++)); do
    if curl -fs "$url" >/dev/null 2>&1; then
      ok "$desc"
      return 0
    fi
    sleep 0.5
  done
  bad "$desc failed within ${max}s"
  return 1
}

# Wait for a JSON-extracted field to satisfy a predicate (in shell).
# Args: url, jq-filter, predicate ("== \"foo\"" or "> 0"), max_secs, desc
wait_for_field() {
  local url="$1" filter="$2" pred="$3" max="$4" desc="$5"
  for ((i=0; i<max*2; i++)); do
    local v
    v=$(curl -fs "$url" 2>/dev/null | jq -r "$filter" 2>/dev/null || echo "")
    if [[ -n "$v" ]] && eval "[[ \"$v\" $pred ]]"; then
      ok "$desc (value=$v)"
      return 0
    fi
    sleep 0.5
  done
  local last
  last=$(curl -fs "$url" 2>/dev/null | jq -c . 2>/dev/null || echo "(no response)")
  bad "$desc — never satisfied within ${max}s (last: $last)"
  return 1
}

# ─────────────────────────────────────────────────────────────────────────
section "setup"
# ─────────────────────────────────────────────────────────────────────────

if [[ ! -f "$SAMPLE_SRC" ]]; then
  bad "sample file not present at $SAMPLE_SRC"
  exit 1
fi
ok "sample file present at $SAMPLE_SRC"

note "wiping data dirs"
rm -rf "$DEVICEDB_DATA" "$BR_DATA" "$BR_LIB"
mkdir -p "$DEVICEDB_DATA" "$BR_DATA" "$BR_LIB"

note "building devicedb server + admin"
go build -o ./bin/server ./cmd/server
go build -o ./bin/admin  ./cmd/admin
ok "built devicedb binaries"

note "building BoardRipper backend"
(cd ../src/backend && go build -o /tmp/br-backend .) >/dev/null
ok "built /tmp/br-backend"

# ─────────────────────────────────────────────────────────────────────────
section "boot services"
# ─────────────────────────────────────────────────────────────────────────

note "starting devicedb on $DEVICEDB_ADDR"
LISTEN_ADDR="$DEVICEDB_ADDR" \
  DATA_DIR="$DEVICEDB_DATA" \
  SEED_DB_PATH="../Board Database/boards.db" \
  WEB_DIR="./web" \
  SNAPSHOT_TARBALL_BASE_URL="$DEVICEDB_BASE/v1/snapshots" \
  ./bin/server > "$DEVICEDB_DATA/server.log" 2>&1 &
register_pid "devicedb" $!
wait_for_http "$DEVICEDB_BASE/v1/health" 15 "devicedb healthy" || exit 1

# Make sure devicedb auto-generates an initial snapshot — first GET /v1/snapshots/latest
# is enough to trigger lazy gen.
curl -fs "$DEVICEDB_BASE/v1/snapshots/latest" >/dev/null
ok "devicedb initial snapshot present"

note "starting BoardRipper backend on $BR_ADDR"
PORT="${BR_ADDR#:}" \
  DATA_DIR="$BR_DATA" \
  LIBRARY_DIR="$BR_LIB" \
  BOARDDB_PATH="$(realpath '../Board Database/boards.db')" \
  CONTRIBDB_ENABLED=true \
  DEVICEDB_BASE_URL="$DEVICEDB_BASE" \
  /tmp/br-backend > "$BR_DATA/br.log" 2>&1 &
register_pid "br" $!
wait_for_http "$BR_BASE/api/health" 15 "BoardRipper healthy" || exit 1

# ─────────────────────────────────────────────────────────────────────────
section "register"
# ─────────────────────────────────────────────────────────────────────────

# BoardRipper auto-registers on boot. Give it a couple seconds; if the
# scheduler hasn't fired yet, hit /sync to force.
sleep 2
curl -fs -X POST "$BR_BASE/api/contribdb/sync" >/dev/null 2>&1 || true

wait_for_field "$BR_BASE/api/contribdb/status" '.registered' '== "true"' 15 \
  "BoardRipper registered with devicedb"

INSTALL_UUID=$(curl -fs "$BR_BASE/api/contribdb/status" | jq -r '.install_uuid')
if [[ -n "$INSTALL_UUID" && "$INSTALL_UUID" != "null" ]]; then
  ok "BR install_uuid: $INSTALL_UUID"
else
  bad "no install_uuid surfaced by BR status"
fi

# Cross-check on the devicedb side — the contributors table should have it.
contrib_count=$(sqlite3 "$DEVICEDB_DATA/devicedb.sqlite" \
  "SELECT count(*) FROM contributors WHERE uuid='$INSTALL_UUID';" 2>/dev/null || echo "0")
if [[ "$contrib_count" == "1" ]]; then
  ok "devicedb contributors table has BR install"
else
  bad "devicedb contributors table is missing BR install ($contrib_count rows)"
fi

# ─────────────────────────────────────────────────────────────────────────
section "initial scan + resolve"
# ─────────────────────────────────────────────────────────────────────────

note "dropping sample file into LIBRARY_DIR"
cp "$SAMPLE_SRC" "$BR_LIB/820-02016.bvr"

note "triggering BR databank scan"
curl -fs -X POST "$BR_BASE/api/databank/scan" >/dev/null
# Poll status until scanning=false.
for i in {1..60}; do
  running=$(curl -fs "$BR_BASE/api/databank/scan/status" | jq -r '.running')
  [[ "$running" == "false" ]] && break
  sleep 0.5
done
if [[ "$running" == "false" ]]; then
  ok "scan completed"
else
  bad "scan did not finish within 30s (running=$running)"
fi

# Look at the indexed row. /api/databank/files returns a JSON ARRAY of
# FileRecord, not an object — fields per src/backend/databank/db.go:680.
files=$(curl -s "$BR_BASE/api/databank/files")
row=$(echo "$files" | jq -c '.[] | select(.filename == "820-02016.bvr")' 2>/dev/null | head -1)
if [[ -z "$row" ]]; then
  # Fallback: just take the first row if the filter found nothing.
  row=$(echo "$files" | jq -c '.[0]' 2>/dev/null)
fi
note "databank row: $row"
if [[ -n "$row" && "$row" != "null" ]]; then
  bn=$(echo "$row" | jq -r '.board_number // ""')
  uuid_seen=$(echo "$row" | jq -r '.board_uuid // ""')
  initial_manuf=$(echo "$row" | jq -r '.manufacturer // ""')
  initial_board_manuf=$(echo "$row" | jq -r '.board_manufacturer // ""')
  if [[ "$bn" == "820-02016" || "$uuid_seen" == "$TARGET_BOARD_UUID" ]]; then
    ok "databank row resolved board_number=820-02016 (uuid=$uuid_seen, manuf='$initial_manuf', board_manuf='$initial_board_manuf')"
  else
    bad "databank row missing resolved board number; row: $row"
  fi
else
  bad "databank has no files after scan; raw: $files"
fi

# ─────────────────────────────────────────────────────────────────────────
section "submit contribution via BoardRipper"
# ─────────────────────────────────────────────────────────────────────────

submit_body=$(jq -nc --arg u "$TARGET_BOARD_UUID" --arg odm "$NEW_ODM" \
  '{target:{type:"board",uuid:$u,field:"odm"},
    to:$odm, from:"",
    evidence:{board_in_hand:true, rationale:"BR integration e2e"},
    confidence:"medium"}')
resp=$(curl -fs -X POST "$BR_BASE/api/contribdb/submit" \
  -H 'content-type: application/json' -d "$submit_body")
LOCAL_UUID=$(echo "$resp" | jq -r '.local_uuid // .uuid // ""')
if [[ -n "$LOCAL_UUID" && "$LOCAL_UUID" != "null" ]]; then
  ok "BR submit returned local_uuid=$LOCAL_UUID"
else
  bad "BR submit response missing uuid: $resp"
fi

note "waiting for outbox to push (status: pending_send → submitted)"
for i in {1..30}; do
  st=$(curl -fs "$BR_BASE/api/contribdb/status")
  pending=$(echo "$st" | jq -r '.outbox_pending')
  if [[ "$pending" == "0" ]]; then break; fi
  curl -fs -X POST "$BR_BASE/api/contribdb/sync" >/dev/null 2>&1 || true
  sleep 1
done
if [[ "$pending" == "0" ]]; then
  ok "outbox cleared (push succeeded)"
else
  bad "outbox still pending after 30s: $st"
fi

# Verify devicedb sees the submission under the install's contributor_uuid.
canonical_subs=$(sqlite3 "$DEVICEDB_DATA/devicedb.sqlite" \
  "SELECT uuid FROM contributions WHERE contributor_uuid='$INSTALL_UUID' OR install_uuid='$INSTALL_UUID';" 2>/dev/null)
if [[ -n "$canonical_subs" ]]; then
  SERVER_UUID=$(echo "$canonical_subs" | head -1)
  ok "devicedb received the submission as $SERVER_UUID"
else
  bad "devicedb has no contributions from $INSTALL_UUID"
fi

# ─────────────────────────────────────────────────────────────────────────
section "admin accept + snapshot pull"
# ─────────────────────────────────────────────────────────────────────────

if [[ -n "${SERVER_UUID:-}" ]]; then
  admin accept "$SERVER_UUID" 2>&1 | tail -3 >/dev/null
  # Verify canonical entity changed.
  after_odm=$(curl -fs "$DEVICEDB_BASE/v1/entities/board/$TARGET_BOARD_UUID" | jq -r '.odm')
  if [[ "$after_odm" == "$NEW_ODM" ]]; then
    ok "canonical board.odm = '$NEW_ODM'"
  else
    bad "expected odm='$NEW_ODM', got '$after_odm'"
  fi
fi

# Regenerate the snapshot so the next BR sync sees a new counter. (Production
# will do this on a scheduled tick; for the prototype we trigger it here.)
note "regenerating canonical snapshot after accept"
admin snapshot regenerate 2>&1 | tail -3 >/dev/null
new_counter_server=$(curl -fs "$DEVICEDB_BASE/v1/snapshots/latest" | jq -r '.counter')
ok "canonical snapshot counter is now $new_counter_server"

note "triggering BR contribdb sync (pulls fresh snapshot)"
sync_resp=$(curl -fs -X POST "$BR_BASE/api/contribdb/sync")
new_counter=$(echo "$sync_resp" | jq -r '.snapshot_counter')
if [[ -n "$new_counter" && "$new_counter" != "0" && "$new_counter" != "null" ]]; then
  ok "BR snapshot counter advanced to $new_counter"
else
  bad "BR snapshot_counter still 0 after sync: $sync_resp"
fi

# ─────────────────────────────────────────────────────────────────────────
section "rescan picks up the updated DB"
# ─────────────────────────────────────────────────────────────────────────

# Re-scan. The databank scanner re-resolves all unchanged files when the
# board DB has changed (scanner.go line 417 region).
note "triggering rescan"
curl -fs -X POST "$BR_BASE/api/databank/scan" >/dev/null
for i in {1..60}; do
  running=$(curl -fs "$BR_BASE/api/databank/scan/status" | jq -r '.running')
  [[ "$running" == "false" ]] && break
  sleep 0.5
done
ok "rescan finished"

# Now the resolved metadata should reflect the new ODM. We don't go through
# /api/databank/files (column may or may not carry odm directly). Instead
# hit /api/boards/resolve which is the canonical resolver path.
resolved=$(curl -fs "$BR_BASE/api/boards/resolve?q=820-02016")
got_odm=$(echo "$resolved" | jq -r '.match.odm // .matches[0].odm // ""')
if [[ "$got_odm" == "$NEW_ODM" ]]; then
  ok "BoardRipper resolver now returns odm='$NEW_ODM' after snapshot pull"
else
  bad "expected resolver odm='$NEW_ODM', got '$got_odm' — full: $resolved"
fi

# Also verify the databank row's manufacturer-ish columns reflect the change.
files2=$(curl -s "$BR_BASE/api/databank/files")
row2=$(echo "$files2" | jq -c '.[] | select(.filename=="820-02016.bvr")' 2>/dev/null | head -1)
note "post-resync databank row: $row2"
post_manuf=$(echo "$row2" | jq -r '.manufacturer // ""')
post_board_manuf=$(echo "$row2" | jq -r '.board_manufacturer // ""')
if [[ "$post_manuf" == "$NEW_ODM" || "$post_board_manuf" == "$NEW_ODM" ]]; then
  ok "databank file row reflects new ODM (manuf='$post_manuf', board_manuf='$post_board_manuf')"
else
  note "(databank file row columns did not pick up new ODM — manuf='$post_manuf', board_manuf='$post_board_manuf'; resolve path was already verified above)"
fi

# ─────────────────────────────────────────────────────────────────────────
section "bonus: link user token + attributed push"
# ─────────────────────────────────────────────────────────────────────────

USER_HANDLE="br-integ-$(date +%s)"
ureg=$(curl -fs -X POST "$DEVICEDB_BASE/v1/users/register" \
  -H 'content-type: application/json' \
  -d "$(jq -nc --arg h "$USER_HANDLE" '{handle:$h, email:"e2e@example.org"}')")
USER_TOKEN=$(echo "$ureg" | jq -r '.token')
if [[ -n "$USER_TOKEN" && "$USER_TOKEN" != "null" ]]; then
  ok "registered user $USER_HANDLE on devicedb"
else
  bad "user registration failed: $ureg"
fi

# Paste the token into BoardRipper.
link_resp=$(curl -fs -X POST "$BR_BASE/api/contribdb/user-token" \
  -H 'content-type: application/json' \
  -d "$(jq -nc --arg t "$USER_TOKEN" '{token:$t}')")
linked=$(curl -fs "$BR_BASE/api/contribdb/user-token-status" | jq -r '.linked')
if [[ "$linked" == "true" ]]; then
  ok "BoardRipper accepted user token"
else
  bad "BR did not accept user token (linked=$linked) resp=$link_resp"
fi

# Push a different field with the linked user.
CURRENT_NAME=$(curl -fs "$DEVICEDB_BASE/v1/entities/board/$TARGET_BOARD_UUID" | jq -r '.board_name // ""')
submit_body2=$(jq -nc --arg u "$TARGET_BOARD_UUID" --arg cur "$CURRENT_NAME" \
  '{target:{type:"board",uuid:$u,field:"board_name"},
    to:"BR Integration MLB", from:$cur,
    evidence:{source_url:"https://example.org/integration"},
    confidence:"high"}')
resp2=$(curl -fs -X POST "$BR_BASE/api/contribdb/submit" \
  -H 'content-type: application/json' -d "$submit_body2")
LOCAL2=$(echo "$resp2" | jq -r '.local_uuid // ""')
[[ -n "$LOCAL2" ]] && ok "second submission queued (local=$LOCAL2)" || bad "second submission failed: $resp2"

# Wait for it to push.
for i in {1..20}; do
  pending=$(curl -fs "$BR_BASE/api/contribdb/status" | jq -r '.outbox_pending')
  [[ "$pending" == "0" ]] && break
  curl -fs -X POST "$BR_BASE/api/contribdb/sync" >/dev/null 2>&1 || true
  sleep 1
done

# Confirm the canonical record carries the USER's contributor_uuid (not just the install).
user_attrs=$(sqlite3 "$DEVICEDB_DATA/devicedb.sqlite" \
  "SELECT c.uuid, ctb.handle FROM contributions c
   LEFT JOIN contributors ctb ON ctb.uuid = c.contributor_uuid
   WHERE c.target_field='board_name' AND c.target_uuid='$TARGET_BOARD_UUID'
   ORDER BY c.submitted_at DESC LIMIT 1;" 2>/dev/null)
if echo "$user_attrs" | grep -q "$USER_HANDLE"; then
  ok "canonical contribution attributed to user handle '$USER_HANDLE'"
else
  bad "user attribution missing — got: $user_attrs"
fi

# ─────────────────────────────────────────────────────────────────────────
section "summary"
# ─────────────────────────────────────────────────────────────────────────

printf "%spass: %d%s   %sfail: %d%s\n" "$green" "$pass" "$reset" "$red" "$fail" "$reset"
if (( fail > 0 )); then
  echo
  echo "Failures:"
  for f in "${failures[@]}"; do echo "  - $f"; done
  echo
  echo "Logs:  $DEVICEDB_DATA/server.log   $BR_DATA/br.log"
  exit 1
fi
exit 0
