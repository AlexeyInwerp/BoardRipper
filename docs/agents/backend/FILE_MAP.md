# Backend Agent — File Map

**git_hash:** a7bbb79
**last_updated:** 2026-04-11

## Staleness Check

```bash
git log --oneline a7bbb79..HEAD -- src/backend/ "Board Database/"
```

## Domain: Go Backend (`src/backend/`)

### Entry Point

| File | Lines | Purpose |
|------|-------|---------|
| `main.go` | ~120 | Server startup, route registration, static file serving, SPA fallback |

### Handlers (`handlers/`)

| File | ~Lines | Purpose | Key Routes |
|------|--------|---------|-----------|
| `files.go` | ~100 | File upload/list/get/delete | POST /api/upload, GET /api/files, DELETE /api/files/{name} |
| `databank.go` | ~540 | Library management, scanning, PDF text extraction | POST /api/databank/scan, GET /api/databank/files, GET /api/databank/search, GET /api/databank/tree |
| `boards.go` | ~150 | Board reference DB resolution | GET /api/boards/resolve, GET /api/boards/stats |
| `update.go` | ~200 | Self-update status/check/apply/SSE | GET /api/update/status, POST /api/update/check, POST /api/update/apply |
| `handlers_test.go` | ~100 | Path traversal, upload validation tests |

### Databank (`databank/`)

| File | ~Lines | Purpose |
|------|--------|---------|
| `db.go` | ~400 | SQLite wrapper, WAL mode, read/write pools (1 writer, 4 readers), schema v4 |
| `scanner.go` | ~300 | Async file scanner, background PDF extraction, status tracking |
| `metadata.go` | ~100 | Board number/part count/net count extraction from filenames |
| `pdftext.go` | ~200 | PDF text extraction via rsc.io/pdf, noise filtering, FTS5 index |
| `db_test.go` | ~100 | SQLite wrapper tests |

### Board Database (`boarddb/`)

| File | ~Lines | Purpose |
|------|--------|---------|
| `boarddb.go` | ~80 | Read-only SQLite handle for boards.db (graceful if missing) |
| `matcher.go` | ~150 | Board number extraction from filenames (regex patterns) |
| `odm.go` | ~100 | ODM registry (regex → manufacturer) |
| `resolve.go` | ~150 | Resolution engine: extract → match → resolve brand/model |

### Updater (`updater/`)

| File | ~Lines | Purpose |
|------|--------|---------|
| `updater.go` | ~420 | GitHub API polling, release checking, version comparison |
| `docker.go` | ~340 | Docker socket API for in-place container update |

**Total backend: ~5,310 lines across 19 Go files**

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
