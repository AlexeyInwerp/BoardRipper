# Deploying `ripperdoc-devicedb` to ripperdoc.de

The service is a single static-Go binary in a Docker container. It must
run somewhere with persistent storage and network reach — typically the
**Synology NAS** that already hosts BoardRipper.

**What `ripperdoc.de` actually provides** (probed 2026-05-19):

- **Web host:** Linevast shared hosting (`lv151.nbg1.linevast.de`), LiteSpeed.
- **`.htaccess` features working today:** `mod_rewrite`, `mod_headers`,
  `mod_deflate`, plus LiteSpeed-native directives.
- **PHP:** Full environment — `cform/` already runs Composer/Symfony,
  manages sessions, and sends mail via `process.php`. Definitely PHP 7.4+,
  `curl` extension available. Not "basic PHP" — sufficient for a
  reverse-proxy shim.
- **`mod_proxy`:** Almost certainly disabled (Linevast shared policy).
  `RewriteRule [P]` is **not** an option.
- **CSP today:** `connect-src 'self'` — browser-side fetches to any
  external origin are blocked. Same-origin via `ripperdoc.de/devicedb/*`
  is fine; moving the API off the domain would require CSP changes.
- **NAS:** behind a home router (192.168.178.21); not reachable from
  Linevast directly without DDNS+port-forward or a tunnel.

**Recommended setup, given these constraints:**

| Approach | Public URL | Website adds | NAS adds | Trade-offs |
|---|---|---|---|---|
| **PHP shim + Cloudflare Tunnel** *(recommended)* | `https://www.ripperdoc.de/devicedb/` | shim PHP file + `.htaccess` + static HTML | `cloudflared` daemon (no port-forward) | Keeps your original URL. Free tier covers this. CF is in the trust path. |
| PHP shim + DDNS + port-forward | `https://www.ripperdoc.de/devicedb/` | shim PHP + `.htaccess` + static HTML | Open `:8090` on the router; rely on `DEVICEDB_SHARED_SECRET` to gate | No third party. Adds public attack surface on the NAS. |
| Subdomain via CF Tunnel only | `https://db.ripperdoc.de/` | DNS-only (delegate `db.ripperdoc.de` to Cloudflare) | `cloudflared` daemon | Simplest end-to-end, no shim. Different URL; CSP on the main site needs to allow `connect-src https://db.ripperdoc.de` if static pages from `ripperdoc.de` ever call it. |

The rest of this doc walks the first option in detail, then sketches the
two alternatives.

---

## 1. PHP shim — recommended path

### 1.1  NAS: run the Go service

```bash
ssh nas-user@nas-host
cd ~/Desktop/ripperdoc-devicedb           # cloned from this repo

mkdir -p data

# Real Ed25519 signing key (keep private half safe — capture pubkey for BR).
openssl genpkey -algorithm ed25519 -out data/snapshot.key
openssl pkey -in data/snapshot.key -pubout -outform DER \
  | base64 > data/snapshot.pubkey

docker compose up -d --build

curl -sf http://localhost:8090/v1/health  # sanity check
```

State lives under `./data/` (canonical SQLite + snapshot tarballs). The
seed `boards.db` is bind-mounted read-only from `../Board Database/`.

**Maintainer reviewer token (one-time)**:
```bash
docker compose exec devicedb /app/admin token issue \
  --handle "$MAINTAINER_HANDLE" \
  --email  "$MAINTAINER_EMAIL"  \
  --scopes "contributions:moderate,contributions:submit"
```
Save the printed plaintext token; use it to drive moderation via curl or
the future admin UI.

### 1.2  NAS reachability — Cloudflare Tunnel

The website's PHP shim has to talk to the Go service on the NAS. The NAS
is on the home LAN (192.168.178.x); Linevast's web host isn't on that
LAN. Cloudflare Tunnel is the no-port-forward bridge:

```bash
# 1.2.1  On the NAS (Synology DSM, package "Container Manager"):
docker run -d --name cloudflared --restart unless-stopped \
  --network host \
  cloudflare/cloudflared:latest \
  tunnel --no-autoupdate login

# Open the URL it prints, log into your Cloudflare account, authorize
# (or sign up — free tier suffices).

# 1.2.2  Create the tunnel and a hostname for it. The hostname doesn't
# need to be a real domain you own; CF auto-issues one. But if you want
# to use it for HTTPS clients, point a real DNS CNAME at it.
docker exec cloudflared cloudflared tunnel create devicedb-bridge
docker exec cloudflared cloudflared tunnel route dns devicedb-bridge \
  devicedb-bridge.<your-cf-zone>.com

# 1.2.3  Configure routing. On the NAS, create  ~/cloudflared/config.yml:
cat <<EOF > ~/cloudflared/config.yml
tunnel: devicedb-bridge
credentials-file: /etc/cloudflared/<UUID>.json
ingress:
  - hostname: devicedb-bridge.<your-cf-zone>.com
    service: http://localhost:8090
  - service: http_status:404
EOF

# 1.2.4  Run the tunnel.
docker run -d --name cloudflared-run --restart unless-stopped \
  -v ~/cloudflared:/etc/cloudflared \
  cloudflare/cloudflared:latest tunnel run devicedb-bridge

# 1.2.5  Test: from anywhere on the internet, including your laptop
# (not on the home LAN):
curl -sf https://devicedb-bridge.<your-cf-zone>.com/v1/health
```

The PHP shim's `$UPSTREAM` then becomes
`https://devicedb-bridge.<your-cf-zone>.com` and the NAS keeps **zero open
ports** to the public internet.

**Alternative (no Cloudflare):** open NAS firewall + router port-forward
`8090 → 192.168.178.21:8090`. Then `$UPSTREAM = http://YOUR-DDNS:8090`.
Add `DEVICEDB_SHARED_SECRET` so random scrapers can't probe the NAS port
directly. (The Go service doesn't enforce this header today — 6-line
follow-up in `internal/api/middleware.go`.)

### 1.3  Website: deploy the shim + static frontend

Copy three things into `/public_html/devicedb/` (rsync them into
RipperDocWeb so the next `deploy.sh` push includes them):

```
/public_html/devicedb/
├── .htaccess              ← from ripperdoc-devicedb/deploy/php-shim/.htaccess
├── index.php              ← from ripperdoc-devicedb/deploy/php-shim/index.php
├── index.html             ← from ripperdoc-devicedb/web/index.html
├── register.html          ← from ripperdoc-devicedb/web/register.html
└── recent.html            ← from ripperdoc-devicedb/web/recent.html
```

Edit `index.php`:
```php
$UPSTREAM       = 'http://YOUR-NAS-HOST:8090';   // line ~32
$SHARED_SECRET  = 'pick-32-bytes-or-leave-blank';
```

The `.htaccess` does the routing:

- Real files (`*.html`, future `*.css`, images) → served directly by
  Apache. Fast, no PHP overhead.
- `/devicedb/api/v1/*` and any other unknown path → routed through
  `index.php`, which `curl`s the NAS and streams the response back.
- The shim handles GET, POST, DELETE, OPTIONS; passes auth headers
  (`Authorization`, `X-BoardRipper-Install-Token`); streams the binary
  snapshot tarball without buffering it whole (so multi-MB downloads
  don't blow PHP's `memory_limit`).

### 1.4  Verify

```bash
# Public reads:
curl -s https://www.ripperdoc.de/devicedb/api/v1/health
curl -s https://www.ripperdoc.de/devicedb/api/v1/entities | jq '.brands | length'
open https://www.ripperdoc.de/devicedb/

# Authenticated (use the install token from BR Settings):
TOKEN=$(curl -s http://localhost:1336/api/contribdb/install-token | jq -r .install_token)
curl -s -H "X-BoardRipper-Install-Token: $TOKEN" \
  https://www.ripperdoc.de/devicedb/api/v1/contributions/mine
```

### 1.5  Limits to know

The PHP shim is fine for the **prototype scale**:

- Snapshot tarballs are ~640 KB today. At ~10× growth (a few MB) it's
  still fine — the shim streams. At hundreds of MB you'll hit shared-host
  `max_execution_time` (often 30 s) and `max_input_time` limits.
- Outbound `curl` from PHP usually has no per-connection upload cap, but
  hosts vary. Test before relying.
- Streaming SSE / websockets is **not supported**. The devicedb wire
  surface doesn't use either.
- The shim runs in the website's PHP process. A 5xx from the NAS becomes
  a 502 from the website — log to investigate via the shim's
  `X-Boardripper-Error-Code` response header.

When you hit these, move to one of the two subdomain options below.

---

## 2. Alternative: subdomain on the NAS via Synology Reverse Proxy

If you can afford a different URL (`https://db.ripperdoc.de/`), this is
the cleaner path:

1. DSM → Control Panel → External Access → Advanced → enter your custom
   domain. Set up a Let's Encrypt cert for `db.ripperdoc.de`.
2. DSM → Login Portal → Advanced → Reverse Proxy: add a rule
   `db.ripperdoc.de:443/*` → `localhost:8090/*`.
3. Open 443 on the router → NAS.
4. Add a DNS A-record `db.ripperdoc.de → <NAS public IP>` (or use DDNS).
5. Update `src/backend/main.go` default `DEVICEDB_BASE_URL` to point at
   the new subdomain, rebuild + ship BoardRipper.

Pros: zero PHP, full HTTP feature support, fast.
Cons: different URL; opens NAS to the internet.

---

## 3. Alternative: Cloudflare Tunnel

If you don't want to open NAS ports at all:

1. `cloudflared` daemon on the NAS, login with `cloudflared tunnel login`.
2. `cloudflared tunnel create devicedb`.
3. `~/.cloudflared/config.yml`:
   ```yaml
   tunnel: <UUID>
   credentials-file: ~/.cloudflared/<UUID>.json
   ingress:
     - hostname: db.ripperdoc.de
       service: http://localhost:8090
     - service: http_status:404
   ```
4. `cloudflared tunnel route dns devicedb db.ripperdoc.de`.
5. `cloudflared tunnel run devicedb` (or run as a service).

Cloudflare terminates TLS; the NAS only ever speaks outbound.

Pros: no port forwarding, auto-TLS, free tier covers this load.
Cons: Cloudflare is in the trust path; different URL.

---

## 4. BoardRipper-side configuration

Per install (only DEVICEDB_BASE_URL changes between deploy shapes):

```
CONTRIBDB_ENABLED=true
DEVICEDB_BASE_URL=https://www.ripperdoc.de       # PHP-shim shape
# or
DEVICEDB_BASE_URL=https://db.ripperdoc.de        # subdomain shape
```

For BoardRipper to verify snapshot signatures, bake the pubkey at build:
```
go build -ldflags "-X main.DBPubKey=$(cat data/snapshot.pubkey)" \
  ./src/backend
```
Currently `SnapshotPubKey` is empty in `main.go` so verification is
skipped — wiring the ldflags is a follow-up in `scripts/release.sh`.

---

## 5. Snapshot freshness on release

The spec calls for `scripts/release.sh` to bake the latest canonical
snapshot into the BoardRipper image at build time (spec §6.5). One-line
addition not yet implemented in the prototype; until it ships, a fresh
install pulls the snapshot on its first scheduled sync (default 24 h, or
manual via Settings → Database Contributions → Sync now).

---

## 6. Troubleshooting

| Symptom | Likely cause |
|---|---|
| 502 with `X-Boardripper-Error-Code: shim_upstream_unreachable` | The NAS port isn't reachable from the website host. Test from the web host: `curl -v http://NAS_HOST:8090/v1/health`. |
| 404 from `/devicedb/api/v1/*` on the website | `.htaccess` not active. Confirm `mod_rewrite` is enabled in the host's panel. |
| BR's `outbox_failed` keeps climbing | Network issue OR signature verification failing. Inspect BR log for `[contribdb]` lines. |
| Snapshot pull never advances counter | Admin accepted a patch but didn't trigger `snapshot regenerate`. Run: `docker compose exec devicedb /app/admin snapshot regenerate`. |
| 503 `snapshots_disabled` on `/v1/snapshots/latest` | Service couldn't write to `./data/snapshots/`. Check NAS bind-mount permissions. |
| 401 `auth_required` on POST `/v1/contributions` | Install token missing or revoked. Inspect BR Settings → Database Contributions. |
