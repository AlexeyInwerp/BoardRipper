# Backend Agent — File Map

**git_hash:** 99e08c6
**last_updated:** 2026-05-02

## Staleness Check

```bash
git log --oneline a7bbb79..HEAD -- src/backend/ "Board Database/"
```

## Domain: Go Backend (`src/backend/`)

### Entry Point

| File | Lines | Purpose |
|------|-------|---------|
| `main.go` | 283 | Server startup, route registration, static file serving, SPA fallback, librarysync engine + scheduler |

### Handlers (`handlers/`)

| File | Lines | Purpose | Key Routes |
|------|-------|---------|-----------|
| `files.go` | 228 | File upload/list/get/delete | POST /api/upload, GET /api/files, DELETE /api/files/{name} |
| `databank.go` | 667 | Library management, scanning, PDF text extraction | POST /api/databank/scan, GET /api/databank/files, GET /api/databank/search, GET /api/databank/tree |
| `boards.go` | 64 | Board reference DB resolution | GET /api/boards/resolve, GET /api/boards/stats |
| `update.go` | 96 | Self-update status/check/apply/SSE | GET /api/update/status, POST /api/update/check, POST /api/update/apply |
| `sync.go` | 361 | Library sync (WebDAV pull) config + control | GET/PUT /api/sync/config, POST /api/sync/{test,start,stop}, GET /api/sync/status, GET /api/sync/check-target |
| `handlers_test.go` | 73 | Path traversal, upload validation tests |

### Library Sync (`librarysync/`)

| File | Lines | Purpose |
|------|-------|---------|
| `sync.go` | 529 | `Engine` (Status struct, Start/Stop/Status, manifest→diff→download goroutine, .part atomic rename, optional strict prune, persists last_run_*) |
| `scheduler.go` | 109 | 60s ticker, computes next-due slot for daily/weekly/monthly@03:00 local, fires Engine.Start when due |
| `client.go` | 69 | Stdlib-only HTTP helper: Basic-auth `fetch`, `pathEncode`, `joinURL` |

### Databank (`databank/`)

| File | Lines | Purpose |
|------|-------|---------|
| `db.go` | 820 | SQLite wrapper, WAL mode, read/write pools (1 writer, 4 readers), schema v4 |
| `scanner.go` | 723 | Async file scanner, background PDF extraction, status tracking |
| `metadata.go` | 319 | Board number/part count/net count extraction from filenames |
| `pdftext.go` | 674 | PDF text extraction via rsc.io/pdf, noise filtering, FTS5 index |
| `search.go` | 174 | FTS5 full-text search, snippet extraction, multi-term AND queries |
| `db_test.go` | 71 | SQLite wrapper tests |
| `pdftext_test.go` | 273 | PDF extraction + cleaning tests |

### Board Database (`boarddb/`)

| File | Lines | Purpose |
|------|-------|---------|
| `boarddb.go` | 119 | Read-only SQLite handle for boards.db (graceful if missing) |
| `matcher.go` | 33 | Board number extraction from filenames (regex patterns) |
| `odm.go` | 43 | ODM registry — 19 patterns (Apple, LCFC, Compal, Quanta, ASUS, etc.) |
| `resolve.go` | 152 | Resolution engine: exact → prefix → alias lookup |

### Updater (`updater/`)

| File | Lines | Purpose |
|------|-------|---------|
| `updater.go` | 417 | GitHub API polling, release checking, version comparison |
| `docker.go` | 334 | Docker socket API for in-place container update |

**Total backend: 5,469 lines across 19 Go files (14 production + 3 test)**

## Domain: Board Database (`Board Database/`)

| File | Purpose |
|------|---------|
| `boards.db` | SQLite reference DB — 3,364 boards, 85 aliases |
| `boards.db-shm` / `boards.db-wal` | WAL mode artifacts (transient) |

## API Surface (43 endpoints)

### Files
- `POST /api/upload` — 50MB max, extension validation, traversal protection
- `GET /api/files` — list all
- `GET /api/files/{name}` — serve file
- `DELETE /api/files/{name}`

### Databank (20+ endpoints)
- `POST /api/databank/scan` — start scan
- `POST /api/databank/scan/stop` — stop
- `GET /api/databank/scan/status` — progress
- `GET /api/databank/files` — indexed files
- `GET /api/databank/search` — FTS5 text search
- `GET /api/databank/tree` — folder structure
- `POST /api/databank/bindings` — board↔PDF link
- ... (see handlers/databank.go for full list)

### Board Resolution
- `GET /api/boards/resolve?q=` — extract + match + resolve
- `GET /api/boards/stats` — DB statistics

### Config + Update
- `GET/PUT /api/config`
- `GET /api/update/status`, `POST /api/update/check`, `POST /api/update/apply`, `GET /api/update/progress` (SSE)

## Key Constraints

- **stdlib only** — no external web frameworks (net/http)
- **CGO_ENABLED=0** — pure Go SQLite via modernc.org/sqlite
- **Dependencies:** modernc.org/sqlite + rsc.io/pdf only
- **WAL mode** — concurrent readers (4) don't block writer (1)
- **boards.db is read-only** — never write to reference DB at runtime

## Pending Work

- Board database integration: 9 tasks from design spec (boarddb package, API, UI)
- Backend test coverage expansion (databank scanner, PDF extraction, board resolution)

## Recent churn (a7bbb79..a5a2f8e)

- 93d78e3 — feat(cache): granular cache control — per-entry parser versioning + scoped reset UI (primarily frontend; may touch backend cache-header hints in static serving)

Backend is very low-churn in this window — no direct handler/databank/boarddb/updater changes.

