# Deploying `ripperdoc-devicedb` to ripperdoc.de

The prototype service is a single static-Go binary in a Docker container.
The site `https://www.ripperdoc.de/` is a **plain-static FTP/Apache** host
(see [`../landing/`](../landing/) and `RipperDocWeb/deploy.sh` for how the
landing page is published). The site has no built-in proxy hook, so we run
the Go service on the Synology NAS — same machine the BoardRipper container
already runs on — and use Apache `mod_rewrite` to forward the public URLs.

Two URLs to expose:

| Public URL                         | Forwards to              |
|-----------------------------------|--------------------------|
| `https://www.ripperdoc.de/devicedb/` (static frontend) | `nas-host:8090/devicedb/` |
| `https://www.ripperdoc.de/devicedb/api/v1/*`           | `nas-host:8090/v1/*`     |

The Go service already aliases `/devicedb/api/v1/` to `/v1/` so both paths
work; the rewrite below uses the more user-friendly `/devicedb/api/v1/`.

---

## 1. NAS — run the service in Docker

```bash
# 1.1  Pull / build the image on the NAS, on the same host as boardripper.
ssh nas-user@nas-host
cd ~/Desktop/ripperdoc-devicedb     # cloned from this repo

# 1.2  Provision data + signing key.
mkdir -p data
# Generate a real Ed25519 signing key. Keep the private half OFFLINE in
# production; for first-cut deploy you can let the service generate one,
# but you MUST capture the printed dev-key warning's pubkey if BoardRipper
# is going to verify signatures.
openssl genpkey -algorithm ed25519 -out data/snapshot.key
openssl pkey -in data/snapshot.key -pubout -outform DER \
  | base64 > data/snapshot.pubkey

# 1.3  Bring it up.
docker compose up -d --build

# 1.4  Verify health.
curl -sf http://localhost:8090/v1/health
```

The seed boards.db is mounted read-only from `../Board\ Database/boards.db`.
On first boot the canonical SQLite is populated from it; subsequent boots
no-op the seed step. Persistent state lives under `./data/`.

### Maintainer reviewer token (one-time)

```bash
# Create the maintainer user + a reviewer-scoped token.
docker compose exec devicedb /app/admin token issue \
  --handle "$MAINTAINER_HANDLE" \
  --email  "$MAINTAINER_EMAIL"  \
  --scopes "contributions:moderate,contributions:submit"
# Capture the printed plaintext token, store securely.
```

---

## 2. Apache — forward `/devicedb/` on `ripperdoc.de`

Add the following block to `RipperDocWeb/public/.htaccess` (the file that
gets rsynced to `/public_html/.htaccess` by `deploy.sh`). The rules must
come **before** the existing canonical-www redirect so they short-circuit
the rewrite chain:

```apache
# ─── devicedb sub-app ──────────────────────────────────────────────
# Forwards /devicedb/ and /devicedb/api/v1/* to the Go service running on
# the NAS. Replace NAS_HOST with the actual host (or wire a CNAME).
# Requires mod_proxy + mod_proxy_http enabled in the LiteSpeed/Apache
# admin panel.
RewriteEngine On

RewriteRule ^devicedb/api/v1/(.*)$  http://NAS_HOST:8090/v1/$1  [P,L]
RewriteRule ^devicedb/(.*)$         http://NAS_HOST:8090/devicedb/$1  [P,L]
RewriteRule ^devicedb$              http://NAS_HOST:8090/devicedb/   [P,L]

# Don't apply the canonical-www / HSTS / blocklist rules to proxied
# requests — they've already left the Apache process via [P].
```

If the hosting plan disables `mod_proxy` (some shared hosts do), the
fallback is a tiny PHP shim under `/devicedb/index.php` that `curl`s the
upstream — that's a 50-line script we can add later. For prototype + small
launch, ask the hosting provider to enable `mod_proxy`.

---

## 3. BoardRipper-side configuration

Every BoardRipper install that should contribute needs:

```
CONTRIBDB_ENABLED=true                            # default true
DEVICEDB_BASE_URL=https://www.ripperdoc.de         # default points here
```

Both have sensible defaults in `src/backend/main.go`; usually nothing to
change.

If you generated a real Ed25519 key in step 1.2 and want BoardRipper to
verify signatures (recommended for production), bake the pubkey in via
ldflags during release:

```
go build -ldflags "-X main.DBPubKey=$(cat data/snapshot.pubkey)" \
  ./src/backend
```

(The wiring inside `main.go` already passes `SnapshotPubKey` to the
contribdb service — see `feat(contribdb)` commit. Currently it's empty,
which disables verification. The release pipeline change to inject this
is a follow-up.)

---

## 4. Snapshot freshness

The spec calls for the release pipeline to bake the latest canonical
snapshot into the BoardRipper image at build time, so a fresh install
starts current. This is a one-line addition to `scripts/release.sh` —
see spec §6.5. Not yet implemented in the prototype; running BoardRipper
will pull the snapshot on its scheduled cadence (default daily, manual
trigger via Settings → Database Contributions → Sync now).

---

## 5. Verification once deployed

```bash
# Public — anyone can hit these:
curl -s https://www.ripperdoc.de/devicedb/api/v1/health
curl -s https://www.ripperdoc.de/devicedb/api/v1/entities | jq '.brands | length'
open https://www.ripperdoc.de/devicedb/                       # browse the DB

# Authenticated — needs the install token from your BoardRipper Settings:
TOKEN=$(curl -s http://localhost:1336/api/contribdb/install-token | jq -r .install_token)
curl -s -H "X-BoardRipper-Install-Token: $TOKEN" \
  https://www.ripperdoc.de/devicedb/api/v1/contributions/mine
```

## 6. Troubleshooting

| Symptom | Likely cause |
|---|---|
| 503 `snapshots_disabled` on `/v1/snapshots/latest` | Service couldn't write to `./data/snapshots/`. Check permissions on the NAS bind-mount. |
| 401 `auth_required` on POST `/v1/contributions` | Install token missing or revoked. Check Settings → Database Contributions in BoardRipper. |
| BR's `outbox_failed` keeps climbing | Network reachability to devicedb. `tail -f data/server.log` on the NAS and watch for 4xx/5xx. |
| Apache 502 from `/devicedb/*` | mod_proxy not enabled, or NAS_HOST isn't reachable from the web host. Test from web host: `curl -v http://NAS_HOST:8090/v1/health`. |
| Snapshot pull never advances counter | Admin accepted a patch but didn't trigger `snapshot regenerate`. Phase 3 will add a periodic auto-regen ticker; for now run it after each batch of accepts: `docker compose exec devicedb /app/admin snapshot regenerate`. |
