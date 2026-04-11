# Backend Agent — Memory

## Architecture

- Single Go binary, stdlib net/http, no frameworks
- CGO_ENABLED=0 with modernc.org/sqlite (pure Go)
- Two SQLite databases:
  1. **databank.db** — user's indexed library (read-write, WAL mode)
  2. **boards.db** — reference board database (read-only, optional)

## Board Database Integration (Priority Work)

Design spec exists at `docs/superpowers/specs/2026-04-03-board-database-integration-design.md`
Implementation plan at `docs/superpowers/plans/2026-04-03-board-database-integration.md`

Status: boarddb package partially implemented (matcher, resolver, ODM). 9 tasks remain:
1. Complete boarddb package
2. Wire into handlers (resolve endpoint exists)
3. Add board lookup panel API
4. Resolution indicators
5. Filename editing API
6. Scan-time lookup + on-demand
7. Bulk re-resolve after DB update
8. Expand boards.db with missing entries
9. Test against user library (~470 unknowns)

## ODM Matching

ODM = Original Design Manufacturer. Board numbers encode manufacturer:
- Apple: `820-XXXXX` pattern
- ASUS: `60NB`, `90NB` patterns
- Dell: `CN-0XXXX`, `LA-XXXX`
- etc.

Regex patterns in `boarddb/odm.go`. Current match rate: 96% on full library, 100% on samples/.

## Known Constraints

- PDF text extraction has 2-minute timeout per file (rsc.io/pdf can hang)
- Scanner is async with background worker — non-blocking
- FTS5 indices for instant search
- Static files served with immutable cache headers (1 year max-age)
