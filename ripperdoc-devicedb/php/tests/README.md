# Running the e2e suite against the PHP port

The shell suite lives at `scripts/e2e-scenarios-php.sh`. It boots a fresh
PHP server, walks 28 checks across 8 scenarios, and asserts wire-shape
parity with the Go reference.

## Run

```bash
bash scripts/e2e-scenarios-php.sh
# expected:
# ==============================================
#  results: 28 passed, 0 failed (of 28 checks)
# ==============================================
```

## What's covered

| # | Scenario                              | Checks |
|---|---------------------------------------|--------|
| 1 | Health + OpenAPI                      | 2      |
| 2 | Entity tree (seeded)                  | 2      |
| 3 | Install registration + idempotency    | 3      |
| 4 | User registration + duplicate handle  | 3      |
| 5 | Contribution submit + 5 error paths   | 7      |
| 6 | List mine + withdraw + double-withdraw| 3      |
| 7 | Admin accept + canonical update       | 3      |
| 8 | Signed snapshot + tarball contents    | 5      |

## Knobs

```bash
SERVER_PORT=18099 SEED_DB_PATH=/path/to/seed.db bash scripts/e2e-scenarios-php.sh
```

`SEED_DB_PATH` defaults to `Board Database/boards.db` (the BoardRipper repo's
seed source).

## Hooks

The script tears down the PHP server via `trap` on EXIT — no orphan processes.
It uses `pkill` via the trap signal, so re-running is safe even if interrupted.
