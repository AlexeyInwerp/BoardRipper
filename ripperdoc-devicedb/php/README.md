# ripperdoc-devicedb — PHP port

PHP 7.4+ implementation of the same REST wire surface the Go reference
implements. Designed to deploy directly onto Linevast shared LiteSpeed via
the FTP upload step in `RipperDocWeb/deploy.sh`. The Go service remains the
canonical reference; this port follows it endpoint-by-endpoint.

## Layout

```
php/
  api.php                # single HTTP entrypoint (router-mode + .htaccess)
  bootstrap.php          # autoloader, ext checks, schema ensure, seed
  admin.php              # CLI (queue / accept / reject / block / token / snapshot)
  cron-snapshot.php      # cron entrypoint (idempotent, flock-guarded)
  .htaccess              # routes /v1/* → api.php; denies /data/
  index.html / register.html / recent.html
  lib/
    Allowlist.php  Auth.php  Config.php  Contribs.php  Db.php
    Entities.php   Installs.php  Json.php  Log.php  RateLimit.php
    Schema.php     Snapshot.php  Time.php  Users.php  Uuid.php
  data/
    .htaccess            # belt-and-braces deny-all
    canonical.sqlite     # runtime DB (created on first request)
    snapshots/           # signed tarballs + latest-manifest.json
    snapshot.dev.key     # dev-only ephemeral signing key (auto-generated)
    snapshot.key         # PRODUCTION signing key (NEVER commit; set via FTP)
    logs/devicedb.log
```

## Requirements

PHP 7.4+ with:
- `pdo_sqlite`
- `sodium` (Ed25519 signing/verification)
- `phar` (snapshot tarball builder)
- `fileinfo`, `curl`, `session` (built-in on Linevast)

`password_hash(PASSWORD_ARGON2ID)` requires PHP built with libargon2 (Linevast's
shared PHP has it). The first call will fall back to a slower hash if not.

## Routing

`.htaccess` rewrites:

| URL prefix              | Target              |
| ----------------------- | ------------------- |
| `/v1/*`                 | `api.php`           |
| `/devicedb/v1/*`        | `api.php` (alias)   |
| `/devicedb/api/v1/*`    | `api.php` (alias)   |
| Any real file/dir       | served directly     |
| `/data/*`               | 403                 |

Same wire shape as the Go reference. See `/v1/openapi.json` for the live truth.

## Local dev

```bash
cd ripperdoc-devicedb/php
SEED_DB_PATH=../Board\ Database/boards.db \
  php -S 127.0.0.1:18090 api.php
# api.php detects cli-server SAPI and acts as the router script.
```

## Running the e2e suite

```bash
bash ripperdoc-devicedb/scripts/e2e-scenarios-php.sh
# 28 checks; expects all green.
```

The suite covers: health, openapi, entity tree, install registration +
idempotency, user registration + handle-collision, contribution submit
+ all four error paths, list-mine + withdraw + double-withdraw, admin
moderator-token issuance + accept + canonical update verification, and
signed snapshot (manifest counter, Ed25519 signature length, tarball
download, contents inclusion + exclusion).

## Configuration

All via environment variables. Linevast supports them via `.htaccess`
`SetEnv` or a leading `define()` in `bootstrap.php`.

| Env                              | Default                     | Purpose                                          |
| -------------------------------- | --------------------------- | ------------------------------------------------ |
| `DATA_DIR`                       | `<php>/data`                | Writable root for SQLite, logs, snapshots        |
| `SEED_DB_PATH`                   | (or `data/.seed-from`)      | One-shot seed source (v2 boards.db)              |
| `SNAPSHOT_PRIVATE_KEY_PATH`      | `data/snapshot.key` if set  | 64-byte Ed25519 secret key                       |
| `SNAPSHOT_TARBALL_BASE_URL`      | `<host>/v1/snapshots`       | Where the manifest tells clients to fetch        |
| `MIN_SUPPORTED_VERSION`          | `0.31.0`                    | Embedded in every manifest                       |
| `ENABLE_SNAPSHOT`                | `1`                         | Set `0` to disable on-demand regeneration        |

## Admin CLI

```
php admin.php queue list [--status submitted] [--limit 50]
php admin.php queue show <uuid>
php admin.php accept <uuid> [--moderator <contributor_uuid>]
php admin.php reject <uuid> --reason "..." [--moderator <contributor_uuid>]
php admin.php block  <contributor_uuid> --reason "..."
php admin.php token  issue --handle H [--email E] [--scopes contributions:moderate]
php admin.php snapshot regenerate
```

If `--moderator` is omitted, the CLI uses the first `kind='user'` contributor
that holds the `contributions:moderate` scope. Bootstrap a moderator via:

```bash
php admin.php token issue --handle me --scopes "contributions:submit,contributions:moderate"
```

## Cron

Suggested crontab on Linevast:

```cron
*/10 * * * *  php /home/USER/public_html/devicedb/cron-snapshot.php >/dev/null 2>&1
```

The script:
1. Acquires a `flock` advisory mutex (concurrent ticks no-op).
2. Reads `snapshot_state.dirty` — if 0 and a snapshot already exists, exits.
3. Otherwise calls `Snapshot::regenerate()`.

Pass `--force` for an unconditional regen.

## Rate limits

PHP shared hosting has no shared memory between requests, so we use a
SQLite-backed fixed-window counter (`rate_limit_buckets`). Distributed-process
exact limits aren't enforced — but the bounded count per window is, which is
what the spec actually cares about. See `lib/RateLimit.php`.

## Trust envelope

- Snapshot tarballs are signed offline. `SNAPSHOT_PRIVATE_KEY_PATH` is the
  raw 64-byte secret key (concat `sk||pk`) produced by `sodium_crypto_sign_keypair`.
- The corresponding pubkey ships compiled into BoardRipper (mirrors the Go
  reference's `ldflags -X main.DBPubKey=...`).
- Dev mode auto-generates `data/snapshot.dev.key` and logs a warning. Never
  ship the dev key — `scripts/stage-for-ripperdocweb.sh` already excludes it.

## Deploy

`scripts/stage-for-ripperdocweb.sh` rsyncs `php/` into `RipperDocWeb/public/devicedb/`,
excluding live SQLite, snapshots, the dev key, and logs. From there, the
existing `RipperDocWeb/deploy.sh` FTP-pushes everything.
