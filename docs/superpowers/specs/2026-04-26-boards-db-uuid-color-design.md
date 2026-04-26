# boards.db — UUIDs and Color (v1)

**Status:** design approved, ready for implementation plan
**Date:** 2026-04-26
**Scope:** narrow, single-session implementation
**Out of scope:** knowledge anchors, wiki integration, devicedb/Telegram/OpenBoardData ingestion, adaptive coloring scheme (all documented as future work below)

---

## Goal

Add two pieces of metadata to the board reference database:

1. **UUID per board** — a stable, universally unique identifier intended as the canonical join key for linking board records to other datapoints (future CRM tickets, repair logs, external metadata sources, knowledge graph entries). Independent of internal `id INTEGER PRIMARY KEY` and independent of any user-visible field that might be renamed.
2. **Color per board** — the physical PCB substrate color, drawn from a controlled vocabulary, surfaced in the Library panel's lower details area. Powers a future "adaptive theming" scheme (Apple→black, Dell→blue, Lenovo→green, Lenovo Legion→blue) when the themes work lands.

Without UUIDs, every cross-system join becomes a fragile composite key (brand + board_number) that breaks on rename. Without color metadata committed now, themes work later has no surface to read from.

## Non-goals (this session)

- Knowledge anchors (chip families, wiki references, board overrides)
- repair.wiki / logi.wiki integration
- devicedb.xyz / Telegram-channel / OpenBoardData ingestion pipelines
- Adaptive color scheme (brand-pattern defaults: Apple→black, Dell→blue, etc.)
- `external_refs` table for cross-source provenance
- Brand/model resolver improvements

Each is a separate brainstorm; the schema deliberately leaves room (see "Future work" below).

---

## Schema changes

The DB schema lives in `Board Database/create_mockup_db.sql` (CREATE TABLE statements). The data-loading file `Board Database/build_full_db.sql` does `DELETE FROM ... ; INSERT INTO ...` against the existing schema. Both files are edited; no `ALTER TABLE` migrations are issued at runtime — the rebuild flow drops and recreates everything.

### `colors` table (new — added to `create_mockup_db.sql`)

```sql
CREATE TABLE IF NOT EXISTS colors (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,    -- canonical name, lowercase
    hex         TEXT,                    -- nullable now; populated by themes work later
    sort_order  INTEGER NOT NULL DEFAULT 0
);
```

Seed data inserted at the top of `build_full_db.sql` (before any `INSERT INTO boards`), 12 entries — the 99% set + likely exceptions:

| id | name   | sort_order | notes |
|----|--------|-----------:|-------|
| 1  | black  | 1 | Apple boards, many high-end PC boards |
| 2  | red    | 2 | rare but distinctive (some MSI, ASRock) |
| 3  | green  | 3 | most generic Lenovo, classic FR-4 default |
| 4  | blue   | 4 | most Dell, Lenovo Legion gaming, some HP |
| 5  | white  | 5 | rare premium boards |
| 6  | yellow | 6 | rare |
| 7  | purple | 7 | rare |
| 8  | orange | 8 | rare |
| 9  | pink   | 9 | rare |
| 10 | brown  | 10 | rare |
| 11 | silver | 11 | rare premium / industrial |
| 12 | gold   | 12 | rare premium |

`hex` left NULL for now. Themes work will populate it (e.g. `'#1a1a1a'` for black, `'#1a3a8a'` for blue) and can extend the table without an `ALTER TABLE`.

### `boards` table (extended — modified in `create_mockup_db.sql`)

The existing `CREATE TABLE IF NOT EXISTS boards (...)` in `create_mockup_db.sql` is rewritten to add two columns: `uuid` (UNIQUE, NOT NULL) and `color_id` (FK to `colors`, nullable). The fresh schema:

```sql
CREATE TABLE IF NOT EXISTS boards (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    uuid              TEXT NOT NULL UNIQUE,
    brand             TEXT NOT NULL,
    model             TEXT,
    model_number      TEXT,
    board_number      TEXT NOT NULL,
    board_name        TEXT,
    odm               TEXT,
    board_number_type TEXT,
    color_id          INTEGER REFERENCES colors(id),
    source            TEXT NOT NULL,
    source_url        TEXT,
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_board_uuid ON boards(uuid);
```

`id INTEGER PRIMARY KEY AUTOINCREMENT` is **kept** — `board_aliases` and `model_aliases` reference it via `board_id INTEGER REFERENCES boards(id)`. UUID is purely the *external* identifier; rowid stays internal. Smaller blast radius than swapping primary keys.

`color_id` is nullable. Boards without a known color stay NULL; the Library panel hides the row when NULL.

The existing index set (`idx_board_unique`, `idx_board_number`, `idx_brand_model`, `idx_alias_number`, `idx_model_alias`) is preserved unchanged.

---

## UUID generation strategy

**Strategy (i): hardcoded UUID v4 strings in `build_full_db.sql`.**

The DB is built statically from `Board Database/build_full_db.sql` (~406 lines, ~100 hand-written `INSERT` statements). Go opens the resulting `boards.db` read-only — no runtime mutations. UUIDs therefore live as literal strings in the SQL source, version-controlled, immutable.

Generation happens once via a small one-shot helper:

```
scripts/inject-board-uuids.py     (or .go — language TBD by implementation plan)
```

The helper reads `build_full_db.sql`, finds every `INSERT INTO boards (...)` statement, generates a UUID v4 for each, and rewrites the SQL with the UUID prepended to the column list. Running it twice on already-augmented SQL is a no-op (it skips inserts that already have a `uuid` column).

After running once and committing the augmented SQL, **the helper is not part of the build** — UUIDs are static data in the file. New boards added to the SQL by hand get a UUID via `uuidgen` (or running the helper, which only fills missing ones).

**Why not v5 (derived from `brand + board_number`):** more elegant in theory (auto-stable, no manual generation step), but requires a build-time preprocessor in the critical path and ties UUID stability to the assumption that `board_number` never changes. v4 hardcoded survives any field rename trivially.

**Why not generated at Go runtime:** Go opens the DB read-only; UUIDs would have to be assigned at INSERT-time during build, then they'd be non-deterministic across rebuilds. v4 hardcoded in SQL gives stability for free.

### Stability guarantees

- **Rebuild-stable**: re-running `build_full_db.sql` produces identical UUIDs (they're literal strings).
- **Rename-stable**: changing `brand`, `board_number`, `model`, or any other field does not affect the UUID.
- **Globally unique**: UUID v4 collision probability is negligible at our scale (random 122 bits).
- **Cross-system safe**: future CRM rows, knowledge anchors, external_refs, etc., can store `boards.uuid` as a string FK without coordination with this codebase.

---

## API surface

`BoardMatch` struct in `src/backend/boarddb/boarddb.go` gains two fields:

```go
type BoardMatch struct {
    UUID         string   `json:"uuid"`
    BoardNumber  string   `json:"board_number"`
    Brand        string   `json:"brand"`
    Model        string   `json:"model"`
    ModelNumber  string   `json:"model_number,omitempty"`
    BoardName    string   `json:"board_name,omitempty"`
    ODM          string   `json:"odm"`
    Type         string   `json:"board_number_type,omitempty"`
    Color        string   `json:"color,omitempty"`     // resolved name, e.g. "blue"
    Aliases      []string `json:"aliases,omitempty"`
    ModelAliases []string `json:"model_aliases,omitempty"`
    Source       string   `json:"source,omitempty"`
}
```

The resolver SQL (`Board Database/resolve_board.sql` and the runtime queries in `boarddb/resolve.go`) gain a `LEFT JOIN colors ON boards.color_id = colors.id` and select `colors.name AS color`. Frontend consumers receive `color` as the canonical lowercase name (or absent when NULL) — no IDs leak past the API boundary.

---

## Frontend surface

The Library panel's lower details area (`src/frontend/src/panels/LibraryPanel.tsx`) gains a single new row:

```
Color: blue
```

Rendered only when `match.color` is non-empty. Plain text for now. The themes work will later replace the text with a colored swatch + label and use `match.color` to apply theme variants.

UUIDs are surfaced in the API but **not displayed in the UI** in this iteration — they're an integration concern, not a user-facing one.

---

## Migration

The existing `build_full_db.sql` does a clean data rebuild every time (`DELETE FROM model_aliases; DELETE FROM board_aliases; DELETE FROM boards; DELETE FROM sqlite_sequence;`). Combined with the rewritten `create_mockup_db.sql`, the rebuild flow is "drop the DB, run schema SQL, run data SQL". No incremental migration logic, no `ALTER TABLE` needed.

**Sequence:**

1. **Edit `create_mockup_db.sql`**: add the `colors` CREATE TABLE; add `uuid` and `color_id` columns to `boards` CREATE TABLE; add `idx_board_uuid` UNIQUE index.
2. **Edit `build_full_db.sql`** — top of file, before any `INSERT INTO boards`: add the 12 `INSERT INTO colors` seed rows.
3. **Run the one-shot UUID helper** against `build_full_db.sql` to inject UUID v4 literals into every `INSERT INTO boards` statement (adds `uuid` to the column list and a generated UUID to the values list). Helper is idempotent — skips inserts that already have a `uuid` column.
4. **Update `BoardMatch` Go struct** (`src/backend/boarddb/boarddb.go`) and resolver queries (`src/backend/boarddb/resolve.go` + `Board Database/resolve_board.sql`) to select `uuid` and `LEFT JOIN colors`.
5. **Update `LibraryPanel.tsx`** (`src/frontend/src/panels/LibraryPanel.tsx`) to render a "Color: <name>" row when `match.color` is non-empty.
6. **Rebuild the DB.** Exact invocation TBD by implementation plan, but conceptually: `rm boards.db boards.db-shm boards.db-wal && sqlite3 boards.db < create_mockup_db.sql && sqlite3 boards.db < build_full_db.sql`.
7. **Verify** (see next section).
8. **Commit.** Single commit covering: both SQL files, the helper script, the rebuilt `boards.db` (currently tracked), the Go API changes, the React panel change. WAL/SHM sidecar files (`boards.db-shm`, `boards.db-wal`) are currently tracked — implementation plan decides whether to keep tracking them or `.gitignore` them; not a design concern.

---

## Verification

After implementation:

```bash
# Schema check
sqlite3 boards.db ".schema boards" | grep -E 'uuid|color_id'
sqlite3 boards.db ".schema colors"

# Data check — every board has a UUID
sqlite3 boards.db "SELECT count(*) FROM boards WHERE uuid IS NULL OR uuid = '';"
# expect: 0

# UUID uniqueness
sqlite3 boards.db "SELECT uuid, count(*) FROM boards GROUP BY uuid HAVING count(*) > 1;"
# expect: empty

# Sample
sqlite3 boards.db "SELECT uuid, brand, board_number, (SELECT name FROM colors WHERE id = boards.color_id) AS color FROM boards LIMIT 10;"
```

Then:

- Run the existing `boarddb` Go test suite — no regressions.
- Open the BoardRipper Library panel, click an Apple `820-NNNNN` board (one we manually populated `color_id = 1` for as a smoke test), confirm "Color: black" row appears.
- Confirm `BoardMatch` JSON over the resolver HTTP endpoint includes `"uuid": "..."` and (when populated) `"color": "..."`.

---

## Future work (documented now, deferred)

These are designed-around in the current schema so they can land later without `ALTER TABLE` pain:

### Adaptive color scheme

When the theming work lands, derive a default color per board from its brand/model when `color_id` is NULL:

- Apple → black
- Dell → blue
- Lenovo (Legion subseries) → blue
- Lenovo (other) → green
- HP → varies (mostly black on consumer, blue on EliteBook)
- … (palette TBD)

Likely shape: a `brand_color_defaults(brand_pattern, model_pattern, color_id)` table with a small precedence rule (most-specific match wins). Or pure code in the frontend theme module reading from a JS map. To be brainstormed when themes start.

### Knowledge anchors (chip families, wiki references)

A separate `chip_families`, `wiki_anchors`, `board_chips`, and `board_overrides` cluster of tables. Hand-curated, not auto-derived from parsed parts (boardview formats don't reliably surface chip part numbers). Live wiki integration uses repair.wiki + logi.wiki REST `/rest.php/v1/search/page?q=...` at click time, with a small TTL cache. Cross-cutting agent research is captured in this session's research swarm; no schema impact yet.

### External-source ingestion

`external_refs(board_id, source, external_id)` table will let devicedb.xyz file IDs, Telegram-channel post IDs, OpenBoardData filenames, and any future source attach to a single board without coordination. UUIDs make this trivial: each ingestion pipeline stores `boards.uuid` as the FK, no need to look up internal `id`. Schema work is one tiny table; the heavy lift is the importer scripts.

### Per-net measurements (OpenBoardData)

A `board_measurements(board_uuid, net_name, diode_value, normal_voltage, resistance, comment)` table, attached by board UUID. ODbL-licensed source; ship as optional data layer, not in the Docker image. No work required now beyond keeping `boards.uuid` as the integration handle.

---

## Open questions for implementation plan

(none — design is locked; implementation plan handles ordering and tooling choice)
