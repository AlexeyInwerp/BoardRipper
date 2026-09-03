#!/usr/bin/env bash
# Verify the ripperdoc.de FTP credential with ONE login attempt — optionally
# from a Tailscale node (rd-nas) so the releasing machine's IP is never the one
# that fails. Run this before a release whenever the password may have changed.
#
#   scripts/ftp-check.sh              # one attempt from this machine
#   scripts/ftp-check.sh --via rd-nas # one attempt from rd-nas over Tailscale
#
# Why this exists (2026-09-03): the FTP password lives in TWO files —
# ~/.config/boardripper/release.env (release.sh) and RipperDocWeb/ftp.env
# (deploy.sh). One was rotated, the other was not, and lftp's default
# unlimited retries turned the stale password into a fail2ban block of the
# releasing machine's public IP for ~2 hours. This script (a) tells you when
# the two files disagree, (b) refuses to send the credential to a host that
# does not answer, and (c) tries exactly once, with the password on stdin so
# it never appears in a process list on either machine.
#
# Never probe FTP anonymously while diagnosing — every anonymous connect is a
# failed login from the host's point of view and extends the ban.
set -euo pipefail

VIA=""
while [ $# -gt 0 ]; do
  case "$1" in
    --via) VIA="${2:?--via needs a node name from deploy.conf, e.g. rd-nas}"; shift 2;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RELEASE_ENV="${BOARDRIPPER_RELEASE_CONFIG:-$HOME/.config/boardripper}/release.env"
WEB_ENV="${RIPPERDOCWEB_DIR:-$REPO_ROOT/../RipperDocWeb}/ftp.env"
HOST="ftp.ripperdoc.de"
PROBE_PATH="/public_html/boardripper/manifest.json"

[ -f "$RELEASE_ENV" ] || { echo "missing $RELEASE_ENV" >&2; exit 1; }
# shellcheck source=/dev/null
. "$RELEASE_ENV"
: "${FTP_USER:?not set in $RELEASE_ENV}"; : "${FTP_PASSWORD:?not set in $RELEASE_ENV}"

# --- (a) the two credential files must agree ------------------------------
if [ -f "$WEB_ENV" ]; then
  web_pw="$(sed -n 's/^FTP_PASSWORD="\(.*\)"$/\1/p' "$WEB_ENV" | head -1)"
  if [ -n "$web_pw" ] && [ "$web_pw" != "$FTP_PASSWORD" ]; then
    newer="$( [ "$WEB_ENV" -nt "$RELEASE_ENV" ] && echo "$WEB_ENV" || echo "$RELEASE_ENV" )"
    echo "!!! FTP_PASSWORD differs between release.env and ftp.env (newer: $newer)." >&2
    echo "    Sync them before attempting a login — one of them is the rotated-away value." >&2
    exit 3
  fi
  echo "credential files agree (release.env == ftp.env)"
else
  echo "note: $WEB_ENV not found — only release.env checked"
fi

# --- (b)+(c) reachability, then exactly one login -------------------------
# lftp reads the credential from its stdin script (`open -u`), so it is never
# on a command line. max-retries 1 caps a wrong password at a single 530.
LFTP_SCRIPT="set ftp:ssl-allow no
set net:max-retries 1
set net:reconnect-interval-base 5
set net:timeout 25
open -u \"$FTP_USER\",\"$FTP_PASSWORD\" $HOST
cls -1 $PROBE_PATH
bye"

if [ -z "$VIA" ]; then
  if ! ping -c 2 -W 2000 "$HOST" >/dev/null 2>&1 && ! nc -z -G 6 "$HOST" 21 >/dev/null 2>&1; then
    echo "!!! $HOST does not answer ping or TCP/21 from this machine (public IP $(curl -s --max-time 8 https://api.ipify.org || echo ?))." >&2
    echo "    Not sending the credential. If another machine reaches it, this IP is probably blocked — try --via rd-nas." >&2
    exit 4
  fi
  echo "host answers from this machine (public IP $(curl -s --max-time 8 https://api.ipify.org || echo ?)); one login attempt…"
  if printf '%s\n' "$LFTP_SCRIPT" | lftp 2>&1 | grep -q "$PROBE_PATH"; then
    echo "LOGIN OK — credential accepted from this machine"
  else
    echo "!!! login failed from this machine (wrong password, or blocked mid-handshake)" >&2; exit 5
  fi
else
  # Same test, executed on a Tailscale node whose public IP is not ours.
  CONF="$REPO_ROOT/deploy.conf"
  [ -f "$CONF" ] || { echo "missing $CONF (needed for ssh to $VIA)" >&2; exit 1; }
  NAS_USER="$(grep '^ssh user:' "$CONF" | awk '{print $3}')"
  NAS_PW="$(grep '^ssh pw:' "$CONF" | awk '{print $3}')"
  command -v sshpass >/dev/null || { echo "sshpass not installed (brew install sshpass)" >&2; exit 1; }
  echo "testing from $VIA over Tailscale…"
  REMOTE='
    HOST="'"$HOST"'"; P="'"$PROBE_PATH"'"
    ip=$(curl -s --max-time 8 https://api.ipify.org || echo ?)
    if ! timeout 8 bash -c "exec 3<>/dev/tcp/$HOST/21" 2>/dev/null; then
      echo "!!! $HOST TCP/21 unreachable from '"$VIA"' (public IP $ip) — not sending the credential"; exit 4
    fi
    echo "host answers from '"$VIA"' (public IP $ip); one login attempt…"
    if command -v lftp >/dev/null; then
      if lftp 2>&1 | grep -q "$P"; then echo "LOGIN OK — credential accepted from '"$VIA"'"; else echo "!!! login failed from '"$VIA"'"; exit 5; fi
    else
      echo "lftp missing on '"$VIA"'"; exit 1
    fi'
  # The lftp script travels on stdin through ssh; `lftp` above reads it there.
  printf '%s\n' "$LFTP_SCRIPT" | sshpass -p "$NAS_PW" ssh -o ConnectTimeout=15 -o PubkeyAuthentication=no \
    -o NumberOfPasswordPrompts=1 "$NAS_USER@$VIA" "bash -c '$REMOTE'" 2>&1 | grep -v '^Warning: Permanently'
fi
