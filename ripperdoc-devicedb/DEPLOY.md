# Deploying `ripperdoc-devicedb` to ripperdoc.de

The PHP implementation under `php/` is what actually ships. Everything
runs **directly on the ripperdoc.de host** (Linevast shared LiteSpeed) —
no NAS, no reverse-proxy, no Cloudflare tunnel. The Go reference under
`cmd/`, `internal/`, `Dockerfile`, `docker-compose.yml` stays in the tree
as a **local-dev fixture** so you can run an identical wire surface
locally without setting up the PHP host.

```
                          ┌─────────────────────────────────┐
                          │   ripperdoc.de / Linevast       │
  BoardRipper installs ──▶│   /devicedb/api/v1/*  (PHP)     │
                          │   /devicedb/         (HTML)     │
                          │   /devicedb/data/    (SQLite +  │
                          │       signed snapshot tarballs) │
                          └─────────────────────────────────┘
```

## What ripperdoc.de provides today (probed)

Linevast shared LiteSpeed at `lv151.nbg1.linevast.de`. Confirmed in-use
features by `cform/` and `.htaccess` inspection:

- **PHP 7.4+** with `ext-pdo_sqlite`, `ext-sodium` (Ed25519 signing),
  `ext-phar` (tar.gz), `password_hash(PASSWORD_ARGON2ID)`, `curl`,
  `session`, `fileinfo`. The existing `cform/` deploy is on Composer +
  Symfony, so the PHP environment is full-featured.
- **`mod_rewrite`, `mod_headers`, `mod_deflate`** (used by the live
  `.htaccess`).
- **`mod_proxy` is NOT enabled.** Doesn't matter — the PHP impl doesn't
  forward to anything.
- **Cron jobs** via the hosting control panel (needed for snapshot regen).
- **SSH** access for the admin CLI (`php admin.php …`).
- **Filesystem** under `/public_html/devicedb/` is writable by the PHP
  process. The `data/` subdir holds runtime state and is gated by an
  `.htaccess` with `Deny from all` (Apache 2.2 + 2.4 syntax both).

## File layout on the live host

```
/public_html/devicedb/
├── .htaccess                       # routes /api/v1/* → api.php, real files direct
├── api.php                         # one-file router; dispatches by PATH_INFO
├── bootstrap.php                   # autoloader, config, request bootstrap
├── admin.php                       # CLI tool (run over SSH)
├── cron-snapshot.php               # cron entrypoint — regen if dirty
├── index.html  register.html  recent.html        # static frontend
├── lib/*.php                       # Db, Schema, Auth, Contribs, Entities,
│                                   # Installs, Users, Snapshot, Allowlist,
│                                   # RateLimit, Json, Log, Time, Uuid
└── data/
    ├── .htaccess                   # Deny from all (Apache 2.2 + 2.4)
    ├── canonical.sqlite            # the DB (created on first request)
    ├── snapshot.key                # Ed25519 private key (chmod 0600)
    ├── snapshots/boards-N.tar.gz   # signed tarballs (one per counter)
    └── logs/<scope>.log
```

The runtime files (`canonical.sqlite`, `snapshot.key`, `snapshots/`,
`logs/`) are **never** deployed from the dev machine.
[`scripts/stage-for-ripperdocweb.sh`](scripts/stage-for-ripperdocweb.sh)
enforces an allowlist (only `data/.htaccess` + `data/.gitkeep`); the
`.gitignore` mirrors the same allowlist; both refuse to flow anything
else through.

## Deploy pipeline (FTP via RipperDocWeb)

The site is FTP-deployed from `~/Desktop/Website/RipperDocWeb/` using
its existing `deploy.sh` (Hugo build → merge sibling repos → lftp
mirror). Adding the devicedb is the same merge pattern already used for
`wiki/` and `boardripper/`:

### One-time setup

Edit `RipperDocWeb/deploy.sh` and add this line near the existing
"BoardRipper landing" merge step (after the existing `rsync -a "$BOARDRIPPER_DIR/landing/" ./public/boardripper/`):

```bash
# --- devicedb PHP service: stage Boardviewer/ripperdoc-devicedb/php/
#                           into ./public/devicedb/ -----------------------
"$BOARDRIPPER_DIR/ripperdoc-devicedb/scripts/stage-for-ripperdocweb.sh" "$SCRIPT_DIR"
```

That's it. The staging script:

- Wipes `RipperDocWeb/public/devicedb/` and rebuilds it from `php/`.
- Excludes everything under `data/` then explicitly allowlists
  `.htaccess` + `.gitkeep` only.
- Fails loudly if the `Deny from all` gate is missing or anything else
  leaks into `data/`.
- The next `RipperDocWeb/deploy.sh` invocation FTPs the staged tree.

Since RipperDocWeb's `lftp` mirror does **not** pass `--delete` on the
remote side, the live `data/canonical.sqlite`, `data/snapshot.key`, and
existing snapshots are preserved across deploys.

### First-time provisioning on the host

```bash
ssh ripperdoc.de
cd ~/public_html/devicedb

# 1) Generate the real production Ed25519 signing key.
php -r '$kp = sodium_crypto_sign_keypair();
        $sk = sodium_crypto_sign_secretkey($kp);
        file_put_contents("data/snapshot.key", bin2hex($sk));
        echo "pubkey: " . base64_encode(sodium_crypto_sign_publickey($kp)) . PHP_EOL;'
chmod 0600 data/snapshot.key
# Capture the printed pubkey — BoardRipper bakes it in via ldflags
# (see "BoardRipper side" below).

# 2) Seed the canonical DB once from a v2 boards.db (optional but
#    recommended — populates 28 brands / 3977 boards in the prototype).
#    Upload boards.db to data/.seed-from, then hit any endpoint to
#    trigger the first-boot import:
# scp 'Board Database/boards.db' user@ripperdoc.de:~/public_html/devicedb/data/.seed-from
curl -s https://www.ripperdoc.de/devicedb/api/v1/health

# 3) Mint your maintainer reviewer token.
php admin.php token issue \
    --handle "your-handle" --email "your@email" \
    --scopes "contributions:moderate,contributions:submit"
# Captures the printed plaintext token (shown once) — save it.

# 4) Add a cron job (via Linevast control panel) — every 10 minutes:
#    cd ~/public_html/devicedb && php cron-snapshot.php
```

### BoardRipper side

Each install ships with two defaults already wired in
[`src/backend/main.go`](../src/backend/main.go):

```
CONTRIBDB_ENABLED=true                             # default true
DEVICEDB_BASE_URL=https://www.ripperdoc.de         # default — no edit needed
```

To make BoardRipper verify snapshot signatures, bake the pubkey from
step 1 above into the release build:

```
go build -ldflags "-X main.DBPubKey=<base64-pubkey>" ./src/backend
```

(Already plumbed through `contribdb.ServiceConfig.SnapshotPubKey`; the
release-pipeline change to inject this from a file is a small follow-up
in [`scripts/release.sh`](../scripts/release.sh).)

## Verification once deployed

Public — no auth:
```bash
curl -s https://www.ripperdoc.de/devicedb/api/v1/health
curl -s https://www.ripperdoc.de/devicedb/api/v1/entities | jq '.brands | length'
open https://www.ripperdoc.de/devicedb/
```

Authenticated reads — use the install token from BoardRipper Settings:
```bash
TOKEN=$(curl -s http://localhost:1336/api/contribdb/install-token | jq -r .install_token)
curl -s -H "X-BoardRipper-Install-Token: $TOKEN" \
  https://www.ripperdoc.de/devicedb/api/v1/contributions/mine
```

End-to-end (point at any host):
```bash
DEVICEDB_BASE=https://www.ripperdoc.de scripts/e2e-scenarios-php.sh
```

## Snapshot freshness on release

Spec §6.5 calls for [`scripts/release.sh`](../scripts/release.sh) to
bake the current canonical snapshot into every BoardRipper image at
build time. A one-line addition in `release.sh` to
`curl https://www.ripperdoc.de/devicedb/api/v1/snapshots/latest` +
download tarball + verify Ed25519 sig + place at
`Board Database/boards.db` covers it. Not yet implemented in the
prototype — until it ships, a fresh BoardRipper install pulls the
snapshot on its first scheduled sync (default 24 h cadence; manual
trigger via Settings → Database Contributions → Sync now).

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| 500 on `/devicedb/api/v1/*` | Check `data/logs/` (server.log, api.log). PHP errors there. Confirm `data/` exists and is writable by the PHP user. |
| 403 on `/devicedb/data/canonical.sqlite` from the browser | Correct — `data/.htaccess` is doing its job. |
| Snapshot pull never advances `counter` | Cron isn't running. Verify the cron entry in the Linevast panel; manual: `php cron-snapshot.php`. |
| 401 `auth_required` on POST `/v1/contributions` | Install token missing or revoked. Inspect BR Settings → Database Contributions. |
| BR `outbox_failed` keeps climbing | Network reachability or signature verification. Inspect BR `[contribdb]` log lines. |
| `Argon2id is not supported` PHP error | PHP 7.2+ required for `PASSWORD_ARGON2ID`. Bump host PHP version. |
| Static frontend renders but `/api/v1/*` 404s | `mod_rewrite` not active on `/devicedb/`. Confirm the deployed `.htaccess` is present and the rewrite rules look intact. |

## Local dev

```bash
# PHP impl (target host) — exactly what runs on ripperdoc.de:
cd ripperdoc-devicedb/php
mkdir -p data
SEED_DB_PATH="../../Board Database/boards.db" \
  php -S localhost:18092 api.php
# → http://localhost:18092/devicedb/

# Go reference (faster, identical wire surface) — for hot-iteration:
cd ripperdoc-devicedb
SEED_DB_PATH="../Board Database/boards.db" go run ./cmd/server
# → http://localhost:8090/devicedb/

# E2E (28 checks, point at either):
DEVICEDB_BASE=http://localhost:18092 scripts/e2e-scenarios-php.sh
```
