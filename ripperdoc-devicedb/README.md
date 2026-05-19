# ripperdoc-devicedb

Canonical online boards database for the BoardRipper ecosystem. Implements
the Phase 2 service described in
`docs/superpowers/specs/2026-05-18-online-boards-db-design.md`:

- v2 entity tables shared with the BoardRipper-shipped `boards.db`
- contribution + token machinery (5 new tables from spec §4)
- REST API per spec §5 plus a prototype `POST /v1/users/register`
- signed `.tar.gz` snapshots over Ed25519
- admin CLI for queue review + token issuance
- single static-Go binary, Dockerized

This is the **Phase 2 prototype** — no GitHub OAuth, no production
signing-oracle, no Litestream wiring. Signing key generation falls back
to an ephemeral dev key with a warning when no key path is configured.

## Layout

```
ripperdoc-devicedb/
├── cmd/server/main.go          # HTTP service (PID 1 in container)
├── cmd/admin/main.go           # ripperdoc-db-cli admin tool
├── internal/schema/schema.sql  # v2 + spec §4 schema (embedded)
├── internal/store/             # SQLite layer
├── internal/api/               # HTTP handlers (one file per group)
├── internal/snapshot/          # Ed25519-signed tarball generator
├── web/                        # static frontend (.gitkeep — parallel work)
├── scripts/                    # seed + token helpers
├── Dockerfile                  # multi-stage golang:1.23-alpine → alpine:3
└── docker-compose.yml          # one-command local stack
```

## Quick start

### Option A — `go run` against the project boards.db

```bash
cd ripperdoc-devicedb
mkdir -p data
SEED_DB_PATH="../Board Database/boards.db" go run ./cmd/server
```

In another shell:

```bash
curl -s localhost:8090/v1/entities | jq '.brands | length'
```

### Option B — Docker compose

```bash
cd ripperdoc-devicedb
docker compose up --build
# In another shell:
curl -s localhost:8090/v1/health
```

The compose file bind-mounts `../Board Database` read-only into `/seed`
so the canonical SQLite is seeded on first boot.

## Environment variables

| Var | Default | Notes |
|---|---|---|
| `LISTEN_ADDR` | `:8090` | TCP listener address |
| `DATA_DIR` | `./data` | Canonical SQLite + snapshot output |
| `SEED_DB_PATH` | `/seed/boards.db` | One-shot seed source; skipped if absent |
| `WEB_DIR` | `./web` | Static frontend dir served at `/devicedb/` |
| `CORS_ALLOWED_ORIGINS` | `*` | Comma list or `*` |
| `SNAPSHOT_PRIVATE_KEY_PATH` | (unset) | Raw 64-byte Ed25519 private key. Without this, dev-key is generated and a warning is logged. |
| `SNAPSHOT_TARBALL_BASE_URL` | `http://localhost:8090/v1/snapshots` | Prefix written into manifests' `tarball_url`. |

## API surface

All paths are routed under both `/v1/` (canonical) and
`/devicedb/api/v1/` (alias for the static frontend).

### Reads (public, no auth)

```bash
curl -s localhost:8090/v1/entities
curl -s localhost:8090/v1/entities/board/<uuid>
curl -s localhost:8090/v1/entities/board/<uuid>/contributions?status=accepted
curl -s 'localhost:8090/v1/resolve?q=820-02016'
curl -s localhost:8090/v1/snapshots/latest
curl -sO localhost:8090/v1/snapshots/1/tarball
curl -s localhost:8090/v1/openapi.json
```

### Install registration (one-shot, no auth)

```bash
curl -s -X POST localhost:8090/v1/installs/register \
    -H 'content-type: application/json' \
    -d '{"token":"my-fresh-install-token","version_hint":"boardripper/0.30.7"}'
# → {"contributor_uuid":"...","created":true}
```

Re-running the same body returns `"created":false`. Tokens are argon2id-hashed
server-side; the plaintext is never retained beyond the request body.

### Submitting a contribution (auth required)

```bash
curl -s -X POST localhost:8090/v1/contributions \
    -H "X-BoardRipper-Install-Token: my-fresh-install-token" \
    -H 'content-type: application/json' \
    -d '{
      "target": {"type":"board","uuid":"<UUID>","field":"odm"},
      "to":   "Quanta",
      "from": "",
      "evidence": {
        "source_url": null,
        "board_in_hand": false,
        "rationale": "Silkscreen lists Quanta logo near U200"
      },
      "confidence": "high",
      "client_ts": "2026-05-18T12:00:00Z"
    }'
# → {"uuid":"...","status":"submitted","queue_position":1}
```

`from` is mandatory. If the canonical value moves between submission and
review-accept, the contribution auto-transitions to `superseded`.

### Listing your own submissions

```bash
curl -s -H "X-BoardRipper-Install-Token: my-fresh-install-token" \
    localhost:8090/v1/contributions/mine
```

### Withdrawing a pending submission

```bash
curl -s -X DELETE -H "X-BoardRipper-Install-Token: my-fresh-install-token" \
    localhost:8090/v1/contributions/<uuid>
```

### User registration (prototype)

Password-less, no email verification, no OAuth. Returns a plaintext token
that is shown exactly once.

```bash
curl -s -X POST localhost:8090/v1/users/register \
    -H 'content-type: application/json' \
    -d '{"handle":"alice","email":"alice@example.com"}'
# → {"user_uuid":"...","token":"...","warning":"save this token now ..."}
```

Use the returned token as `Authorization: Bearer <token>` for subsequent
write calls.

### Admin endpoints (scope `contributions:moderate`)

```bash
curl -s -H "Authorization: Bearer $REVIEWER_TOKEN" \
    'localhost:8090/v1/admin/contributions/queue?status=submitted'

curl -s -X POST -H "Authorization: Bearer $REVIEWER_TOKEN" \
    localhost:8090/v1/admin/contributions/<uuid>/accept

curl -s -X POST -H "Authorization: Bearer $REVIEWER_TOKEN" \
    -H 'content-type: application/json' \
    -d '{"reason":"unverified"}' \
    localhost:8090/v1/admin/contributions/<uuid>/reject

curl -s -X POST -H "Authorization: Bearer $REVIEWER_TOKEN" \
    -d '{"reason":"spam"}' \
    localhost:8090/v1/admin/contributors/<contributor-uuid>/block

curl -s -X POST -H "Authorization: Bearer $REVIEWER_TOKEN" \
    localhost:8090/v1/admin/snapshot/regenerate
```

## Field allowlist

The set of (target_type, field) tuples that the API will accept is
hard-coded in `internal/store/allowlist.go` per spec §9 invariant #8.

| target_type | writable fields |
|---|---|
| `brand` | `notes` |
| `family` | `name`, `notes` |
| `model` | `display_name`, `notes` |
| `board` | `odm`, `board_name`, `notes`, `source`, `source_url` |
| `entity_color` | `color_id` (target_uuid is `scope_type:scope_uuid`) |

Submissions for any other field fail with HTTP 400 and `error: "field_not_writable"`.

## Admin CLI (`devicedb-cli`)

Speaks to the SQLite file directly — no HTTP roundtrip. Honours `DATA_DIR`.

```bash
# Build
go build -o ./bin/devicedb-cli ./cmd/admin

# Or inside the container:
docker exec -it ripperdoc-devicedb devicedb-cli queue list

# Subcommands:
./bin/devicedb-cli queue list --status submitted --order oldest_first --limit 50
./bin/devicedb-cli queue show <uuid>
./bin/devicedb-cli accept <uuid>
./bin/devicedb-cli reject <uuid> --reason "unverified"
./bin/devicedb-cli block  <contributor-uuid> --reason "spam"
./bin/devicedb-cli user register --handle maintainer --email me@example.com
./bin/devicedb-cli token issue --user-uuid <U> --name "reviewer" --scopes "contributions:submit,contributions:moderate"
./bin/devicedb-cli snapshot regenerate
```

### Creating a maintainer reviewer token (manual)

```bash
go build -o ./bin/devicedb-cli ./cmd/admin

# 1. Create a user
./bin/devicedb-cli user register --handle maintainer
# user_uuid=<U>
# token=<plaintext>

# 2. Issue a reviewer-scoped token (overrides the default scopes from step 1)
./bin/devicedb-cli token issue \
    --user-uuid <U> \
    --name reviewer \
    --scopes "contributions:submit,contributions:moderate"
# → <reviewer-token>
```

Or run `./scripts/make-test-tokens.sh` to do all of the above and print
both tokens to stdout.

## Snapshot signing

For Phase 2 prototype, a missing `SNAPSHOT_PRIVATE_KEY_PATH` makes the
service generate an ephemeral Ed25519 keypair at startup and log the
public key (base64). Every restart rolls the keypair — fine for local
testing, never acceptable in production.

To generate a real long-lived key:

```bash
# 64-byte raw Ed25519 private key
openssl genpkey -algorithm Ed25519 -out /tmp/k.pem
openssl pkey -in /tmp/k.pem -outform DER -out /tmp/k.der
# Extract the 32-byte seed + 32-byte pubkey concatenation … the standard
# way is to use a small Go program; see internal/snapshot for details.
```

In production the **private key should never live next to the service**
(spec §7.2 "offline-signing chore"). For Phase 2 we accept the
simplification — a key file mounted as a Docker secret is sufficient.

## License

AGPL-3.0 — inherits the BoardRipper project's license envelope. See the
parent repository's `LICENSE` file.
