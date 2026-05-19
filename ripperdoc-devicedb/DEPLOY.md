# Deploying `ripperdoc-devicedb` to ripperdoc.de

`ripperdoc-devicedb` is its own thing. It deploys **independently** of the
RipperDocWeb static-site project — its own staging step, its own FTP
push, its own credentials. The two services share the same FTP host but
nothing in this directory depends on RipperDocWeb being checked out.

```
                          ┌─────────────────────────────────┐
                          │   ripperdoc.de / Linevast       │
  BoardRipper installs ──▶│   /devicedb/api/v1/*  (PHP)     │
                          │   /devicedb/         (HTML)     │
                          │   /devicedb/data/    (SQLite +  │
                          │       signed snapshot tarballs) │
                          └─────────────────────────────────┘
```

The PHP impl under `php/` is what ships. The Go reference under `cmd/`,
`internal/`, `Dockerfile`, `docker-compose.yml` stays as a local-dev
fixture (faster iteration, identical wire surface) — never deployed.

## What ripperdoc.de provides (probed 2026-05-19)

Linevast shared LiteSpeed at `lv151.nbg1.linevast.de`. Confirmed via
[`cform/`](https://www.ripperdoc.de/cform/) + live `.htaccess`:

- **PHP 7.4+** with `ext-pdo_sqlite`, `ext-sodium` (Ed25519 signing),
  `ext-phar` (tar.gz), `password_hash(PASSWORD_ARGON2ID)`, `curl`,
  `session`, `fileinfo`. The existing `cform/` deploy is on Composer +
  Symfony — environment is full-featured.
- **`mod_rewrite`, `mod_headers`, `mod_deflate`** (used by the live
  `.htaccess`).
- **No `mod_proxy`** — but the PHP impl forwards to nothing, so it
  doesn't matter.
- **Cron jobs** via the hosting control panel (needed for snapshot regen).
- **SSH** for the admin CLI (`php admin.php …`).
- **Filesystem** under `/public_html/devicedb/` writable by the PHP user.

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
    ├── canonical.sqlite            # the DB (auto-created on first request)
    ├── snapshot.key                # Ed25519 private key (chmod 0600)
    ├── snapshots/boards-N.tar.gz   # signed tarballs
    └── logs/<scope>.log
```

`canonical.sqlite`, `snapshot.key`, `snapshots/`, `logs/` are **never**
pushed from the dev box. [`scripts/stage.sh`](scripts/stage.sh) enforces
an allowlist (only `data/.htaccess` + `data/.gitkeep` ever flow), and
the `.gitignore` mirrors the same allowlist for `php/data/`. Belt-and-
braces leak guards on both ends.

## First-time setup (you do this once)

### 1. Configure local credentials

```bash
cd ripperdoc-devicedb
cp .env.example .env
$EDITOR .env       # fill in DEVICEDB_FTP_HOST / USER / PASS
```

`.env` is gitignored. `scripts/deploy.sh` auto-loads it.

Install `lftp` if you don't have it:
```bash
brew install lftp        # macOS
sudo apt-get install lftp # Linux
```

### 2. Push the code

```bash
scripts/deploy.sh --dry-run    # confirm staging looks right
scripts/deploy.sh              # actually push to /public_html/devicedb/
```

To stage to a non-canonical path first (recommended for the first push):
```bash
scripts/deploy.sh --remote /public_html/devicedb-staging
# verify https://www.ripperdoc.de/devicedb-staging/...
# then re-deploy without --remote to land at /devicedb/
```

### 3. Provision the host (one-time, over SSH)

```bash
ssh ripperdoc.de
cd ~/public_html/devicedb

# Generate the prod Ed25519 signing key.
php -r '$kp = sodium_crypto_sign_keypair();
        file_put_contents("data/snapshot.key", bin2hex(sodium_crypto_sign_secretkey($kp)));
        echo "pubkey: " . base64_encode(sodium_crypto_sign_publickey($kp)) . PHP_EOL;'
chmod 0600 data/snapshot.key
# Save the printed pubkey — BoardRipper bakes it in via ldflags.

# Optional: seed the canonical DB from a v2 boards.db.
# scp 'Board Database/boards.db' user@ripperdoc.de:~/public_html/devicedb/data/.seed-from
# curl -s https://www.ripperdoc.de/devicedb/api/v1/health    # triggers seed

# Mint your maintainer reviewer token.
php admin.php token issue \
    --handle "your-handle" --email "your@email" \
    --scopes "contributions:moderate,contributions:submit"
# Saves the plaintext token (shown ONCE).
```

### 4. Register the cron job

Via the Linevast control panel — every 10 minutes:
```
cd ~/public_html/devicedb && php cron-snapshot.php
```

## Iterating on code

Every subsequent deploy is just:
```bash
cd ripperdoc-devicedb
scripts/deploy.sh
```

`lftp mirror` runs WITHOUT `--delete` on the remote side, so the live
`data/canonical.sqlite`, `data/snapshot.key`, and existing
`data/snapshots/` on the host **survive every redeploy**.

## BoardRipper-side configuration

Built-in defaults in [`src/backend/main.go`](../src/backend/main.go):

```
CONTRIBDB_ENABLED=true                             # default true
DEVICEDB_BASE_URL=https://www.ripperdoc.de         # default — no edit needed
```

To make BoardRipper verify snapshot signatures, bake the pubkey from
step 3 into the release build:

```
go build -ldflags "-X main.DBPubKey=<base64-pubkey>" ./src/backend
```

(Already plumbed through `contribdb.ServiceConfig.SnapshotPubKey`. The
release-pipeline change to inject this from a file is a small follow-up
in [`scripts/release.sh`](../scripts/release.sh).)

## Verification once deployed

```bash
# Public — no auth
curl -s https://www.ripperdoc.de/devicedb/api/v1/health
curl -s https://www.ripperdoc.de/devicedb/api/v1/entities | jq '.brands | length'
open https://www.ripperdoc.de/devicedb/

# Authenticated read — use the install token from BoardRipper Settings
TOKEN=$(curl -s http://localhost:1336/api/contribdb/install-token | jq -r .install_token)
curl -s -H "X-BoardRipper-Install-Token: $TOKEN" \
  https://www.ripperdoc.de/devicedb/api/v1/contributions/mine

# Full e2e suite against any host
DEVICEDB_BASE=https://www.ripperdoc.de scripts/e2e-scenarios-php.sh
```

## Snapshot freshness on BoardRipper release

Spec §6.5 calls for [`scripts/release.sh`](../scripts/release.sh) to
bake the canonical snapshot into every BoardRipper image at build time
(`curl /devicedb/api/v1/snapshots/latest` → download + verify → place at
`Board Database/boards.db`). Not yet implemented; until it ships, a
fresh BoardRipper install pulls the snapshot on its first scheduled
sync (default 24 h; manual trigger via Settings → Database
Contributions → Sync now).

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `deploy.sh` says lftp not installed | `brew install lftp` / `apt-get install lftp` |
| `deploy.sh` says missing env vars | Copy `.env.example` → `.env`, fill in FTP creds |
| 500 on `/devicedb/api/v1/*` | Check `data/logs/` (server.log, api.log). PHP errors there. Confirm `data/` is writable. |
| 403 on `/devicedb/data/canonical.sqlite` from a browser | Correct — `data/.htaccess` doing its job. |
| Snapshot pull never advances `counter` | Cron isn't running. Verify the cron entry; manual fallback: `php cron-snapshot.php`. |
| 401 `auth_required` on POST `/v1/contributions` | Install token missing or revoked. Inspect BR Settings → Database Contributions. |
| BR `outbox_failed` keeps climbing | Network reachability or signature verification. Inspect BR `[contribdb]` log lines. |
| `Argon2id is not supported` PHP error | Host PHP < 7.2 — upgrade. |
| Static frontend renders but `/api/v1/*` 404s | `mod_rewrite` not active. Confirm `/devicedb/.htaccess` is present. |

## Local dev

```bash
# PHP impl (target host) — exactly what runs on ripperdoc.de:
cd ripperdoc-devicedb/php
mkdir -p data
SEED_DB_PATH="../../Board Database/boards.db" \
  php -S localhost:18092 api.php
# → http://localhost:18092/devicedb/

# Go reference (faster iteration, identical wire surface):
cd ripperdoc-devicedb
SEED_DB_PATH="../Board Database/boards.db" go run ./cmd/server
# → http://localhost:8090/devicedb/

# E2E (28 checks, point at either):
DEVICEDB_BASE=http://localhost:18092 scripts/e2e-scenarios-php.sh
```
