# boards.db — Schema Redesign (v2)

**Status:** design approved, ready for implementation plan
**Date:** 2026-04-28
**Sub-project:** schema redesign — first of a multi-sub-project sequence
**Supersedes:** [2026-04-26-boards-db-uuid-color-design.md](2026-04-26-boards-db-uuid-color-design.md) (v1 — UUID + flat color column). The v1 spec was not implemented; v2 replaces it entirely. UUID-as-CRM-handle and the `colors` palette table both survive into v2; the flat `boards.color_id` column does not.

---

## Goal

Restructure `boards.db` from a flat `boards` table with denormalized brand/model strings into a four-level entity hierarchy (Brand → Family → Model → Board), all UUID-keyed, with cascading metadata attached at the most appropriate scope. This is the foundation for everything that follows — Database Editor UI, CRM-facing API endpoints, datasheet/documentation DB, OpenBoardData per-net measurements.

The redesign:
- Eliminates string duplication (Apple's brand name doesn't get retyped on every board row).
- Makes brand-wide and family-wide attributes (color, future per-family quirks) expressible without a brand-pattern hack layer.
- Gives every entity a UUID for cross-system references (CRM tickets, future external_refs, future knowledge anchors).
- Untangles model aliases (currently scoped wrong, attached to boards instead of models).

## Non-goals (this sub-project)

These are explicitly out of scope and will land as separate sub-projects, each with its own spec:

- **Database Editor UI** — new Library tab for CRUD over Brand/Family/Model/Board + their metadata + future doc bindings.
- **CRM-facing API endpoints** — `GET /api/boards/open?...` deep-link, `GET /api/lookup?q=...` flexible search.
- **Datasheet / documentation DB** — datasheets keyed to entities at any scope, with binding categories (chipset / charger / CPU). Brainstorming pending.
- **Hide-list** (`board_hidden_parts`) — per-board collection of refdes to hide from rendering. Schema documented in Future Work below; table not created in this sub-project.
- **OpenBoardData population** — the `board_openboarddata` table is created here, but the actual import pipeline that walks GitHub `inflex/OpenBoardData` and inserts rows is a separate sub-project.
- **devicedb.xyz / Telegram channel ingestion** — separate sub-project; the schema accommodates them by giving boards UUIDs that any future `external_refs` table can reference.
- **Adaptive color scheme** (Apple→black, Dell→blue, Lenovo→green, Lenovo Legion→blue) — once Brand/Family rows exist, this is just `INSERT INTO entity_color`. Lands with theming work.

---

## Schema

### Entity tables

```sql
CREATE TABLE brands (
    uuid TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,        -- 'Apple', 'Lenovo', 'Dell'
    notes TEXT
);

CREATE TABLE families (
    uuid TEXT PRIMARY KEY,
    brand_uuid TEXT NOT NULL REFERENCES brands(uuid) ON DELETE CASCADE,
    name TEXT NOT NULL,               -- 'MacBook Pro', 'Legion', 'Inspiron', 'Laptop' (fallback)
    notes TEXT,
    UNIQUE (brand_uuid, name)
);
CREATE INDEX idx_families_brand ON families(brand_uuid);

CREATE TABLE models (
    uuid TEXT PRIMARY KEY,
    family_uuid TEXT NOT NULL REFERENCES families(uuid) ON DELETE CASCADE,
    model_number TEXT NOT NULL,       -- canonical: 'A2141', '20BU/20BX', 'N5720'
    display_name TEXT,                -- one canonical marketing string for UI
    notes TEXT,
    UNIQUE (family_uuid, model_number)
);
CREATE INDEX idx_models_family ON models(family_uuid);
CREATE INDEX idx_models_number ON models(model_number);

CREATE TABLE boards (
    uuid TEXT PRIMARY KEY,
    model_uuid TEXT NOT NULL REFERENCES models(uuid) ON DELETE CASCADE,
    board_number TEXT NOT NULL,       -- '820-02016-A', 'NM-A251', 'DA0R09MB6H1'
    board_name TEXT,                  -- 'X1757' codename
    odm TEXT,                         -- 'Compal', 'Quanta', 'Apple'
    board_number_type TEXT,           -- 'apple_820', 'compal_la'
    source TEXT,
    source_url TEXT,
    notes TEXT,
    UNIQUE (board_number, model_uuid)
);
CREATE INDEX idx_boards_model ON boards(model_uuid);
CREATE INDEX idx_boards_number ON boards(board_number);
```

**Family is required.** Every model rolls up to one. When the source data offers no meaningful family, the migration synthesizes a per-brand fallback family — `'Laptop'`, `'Desktop'`, `'Mac (other)'`, or `'Uncategorized'` — so a single-model line still has somewhere to attach.

**`models.model_number` is canonical.** For Apple, this is the A-number (`A1278`, `A2141`); for Lenovo, the SKU (`20BU/20BX`); for Dell, the marketing model (`N5720`). Apple's parallel naming systems (`MacBook7,3` OS-identifier, `MacBook Pro 13" 4 TBT ports 2020` marketing string) live in `model_aliases`, not as the canonical model_number.

**`models.display_name` is the canonical marketing string.** Free text, displayed in UI. When a model has multiple marketing names (base vs. variant configs), one becomes `display_name` and the rest become `model_aliases` rows with `alias_type='apple_marketing'`.

### Alias tables

```sql
CREATE TABLE board_aliases (
    uuid TEXT PRIMARY KEY,
    board_uuid TEXT NOT NULL REFERENCES boards(uuid) ON DELETE CASCADE,
    alias TEXT NOT NULL,              -- '00HN525', '661-16819', 'F9C71'
    alias_type TEXT,                  -- 'lenovo_fru', 'apple_service', 'dell_dpn', 'emc', 'board_variant'
    UNIQUE (alias, alias_type)
);
CREATE INDEX idx_board_aliases_alias ON board_aliases(alias);

CREATE TABLE model_aliases (
    uuid TEXT PRIMARY KEY,
    model_uuid TEXT NOT NULL REFERENCES models(uuid) ON DELETE CASCADE,
    alias TEXT NOT NULL,              -- 'MacBookPro13,3', 'MacBook Pro 13" 4 TBT ports 2020'
    alias_type TEXT,                  -- 'apple_model_id', 'apple_marketing', 'oem_codename'
    UNIQUE (alias, alias_type)
);
CREATE INDEX idx_model_aliases_alias ON model_aliases(alias);
```

`UNIQUE (alias, alias_type)` enforces that a single FRU code can't be claimed by two boards within the same alias namespace. Today's schema lacks this constraint and silently allows duplicates.

`board_aliases.uuid` and `model_aliases.uuid` columns exist for symmetry with the entity tables — stable handles for future cross-references, even though aliases themselves are unlikely to be referenced externally.

**No `brand_aliases` or `family_aliases` in this sub-project.** Brand and family names are the editor's canonical strings; aliases at those scopes don't represent real-world data today. Add later if needed with the same shape.

### Metadata tables

```sql
-- Reference palette (carried over from v1 spec, unchanged)
CREATE TABLE colors (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    hex TEXT,                         -- nullable; populated by themes work later
    sort_order INTEGER NOT NULL DEFAULT 0
);

-- Cascading scalar: color attached to brand | family | model | board
CREATE TABLE entity_color (
    scope_type TEXT NOT NULL CHECK(scope_type IN ('brand','family','model','board')),
    scope_uuid TEXT NOT NULL,
    color_id INTEGER NOT NULL REFERENCES colors(id),
    PRIMARY KEY (scope_type, scope_uuid)
);
CREATE INDEX idx_entity_color_uuid ON entity_color(scope_uuid);

-- Per-board scalar (zero, one, or many): OpenBoardData reference(s)
CREATE TABLE board_openboarddata (
    board_uuid TEXT NOT NULL REFERENCES boards(uuid) ON DELETE CASCADE,
    external_id TEXT NOT NULL,        -- 'laptops/apple/820-00045'
    notes TEXT,                       -- variant disambiguation: 'Intel variant', 'Qualcomm variant'
    PRIMARY KEY (board_uuid, external_id)
);
CREATE INDEX idx_obd_board ON board_openboarddata(board_uuid);
```

Color seed (12 entries) is identical to v1 spec — black, red, green, blue, white, yellow, purple, orange, pink, brown, silver, gold.

**`entity_color.scope_uuid` has no cross-table FK.** SQLite cannot enforce "this UUID exists in `brands` OR `families` OR `models` OR `boards` depending on `scope_type`". Approved trade-off (option (i) from brainstorm): accept the orphan risk. Periodic audit query catches drift; the data is curated by us, not user-submitted, and a stray row simply doesn't cascade to anything.

**`board_openboarddata` allows multiple refs per board** — the OpenBoardData research found logical-board variants (`iP7P_Qualcomm.txt` vs `iP7P_intel.txt`). Composite PK lets one BoardRipper board carry zero, one, or many.

### Schema versioning

```sql
CREATE TABLE schema_version (
    version INTEGER NOT NULL
);
INSERT INTO schema_version (version) VALUES (2);
```

Mirroring the databank's `migrateV<N>` pattern. v1 = current flat schema, v2 = this redesign. Future schema changes (Editor UI, datasheet DB, hide-list) bump to v3, v4, …

---

## Migration strategy

One-shot Python script: `scripts/migrate-boarddb-v2.py`. Reads the existing `boards.db` (post-v1), builds the new entity hierarchy in a single transaction, drops obsolete columns. Idempotent — running twice is a no-op.

### Family extraction (the hard part)

The current `boards.model` column holds free-text marketing strings (`'MacBook Pro 13" Touch Bar Late 2016'`, `'ThinkPad T450'`, `'Inspiron 17R 5720'`). The migration parses these to derive family names.

**Hand-coded pattern table inline in the script**, evaluated in order, with per-brand fallback:

```python
FAMILY_PATTERNS = [
    # (brand, model_regex, family_name)
    ('Apple',  r'^MacBook Pro\b',       'MacBook Pro'),
    ('Apple',  r'^MacBook Air\b',       'MacBook Air'),
    ('Apple',  r'^MacBook\b',           'MacBook'),
    ('Apple',  r'^iMac\b',              'iMac'),
    ('Apple',  r'^Mac mini\b',          'Mac mini'),
    ('Apple',  r'^Mac Pro\b',           'Mac Pro'),
    ('Apple',  r'^Mac Studio\b',        'Mac Studio'),
    ('Lenovo', r'^ThinkPad\b',          'ThinkPad'),
    ('Lenovo', r'^Legion\b',            'Legion'),
    ('Lenovo', r'^IdeaPad\b',           'IdeaPad'),
    ('Lenovo', r'^Yoga\b',              'Yoga'),
    ('Lenovo', r'^ThinkBook\b',         'ThinkBook'),
    ('Dell',   r'^Inspiron\b',          'Inspiron'),
    ('Dell',   r'^Latitude\b',          'Latitude'),
    ('Dell',   r'^XPS\b',               'XPS'),
    ('Dell',   r'^Precision\b',         'Precision'),
    ('Dell',   r'^Vostro\b',            'Vostro'),
    ('Dell',   r'^Alienware\b',         'Alienware'),
    ('HP',     r'^EliteBook\b',         'EliteBook'),
    ('HP',     r'^ProBook\b',           'ProBook'),
    ('HP',     r'^Pavilion\b',          'Pavilion'),
    ('HP',     r'^Spectre\b',           'Spectre'),
    ('HP',     r'^Omen\b',              'Omen'),
    ('HP',     r'^ZBook\b',             'ZBook'),
    ('Acer',   r'^Aspire\b',            'Aspire'),
    ('Acer',   r'^Predator\b',          'Predator'),
    ('Acer',   r'^Swift\b',             'Swift'),
    ('Asus',   r'^ZenBook\b',           'ZenBook'),
    ('Asus',   r'^VivoBook\b',          'VivoBook'),
    ('Asus',   r'^ROG\b',               'ROG'),
    ('Asus',   r'^TUF\b',               'TUF'),
    # ...extend as needed when the migration logs unmatched rows
]

BRAND_FALLBACK = {
    'Apple':  'Mac (other)',
    'Lenovo': 'Laptop',
    'Dell':   'Laptop',
    'HP':     'Laptop',
    'Acer':   'Laptop',
    'Asus':   'Laptop',
    'MSI':    'Laptop',
    '_':      'Uncategorized',  # default for any brand not enumerated
}
```

A row that doesn't match any pattern logs a warning during migration; the developer reviews the warnings, extends the pattern table, and reruns. Anything not added gets the brand fallback.

The pattern list is canonical, version-controlled, reviewed in the same PR as the migration script. ~30 lines of code, expanded as new brands are added to the source data.

### Source-of-truth direction

**SQLite-as-truth from migration day forward (path A).** The migration mutates `boards.db` in place. After this sub-project:

- `boards.db` is the canonical artifact, committed to the repo as today.
- `Board Database/build_full_db.sql` is preserved as historical seed documentation but no longer maintained as a parallel source. New boards/edits land in `boards.db` directly (via the future Database Editor) or via small targeted migration scripts.
- `Board Database/create_mockup_db.sql` becomes the v2-shape schema generator only — used for fresh-environment bootstrap (`sqlite3 boards.db < create_mockup_db.sql` produces an empty v2 DB ready for migrations or import).

This is the cleaner path because the future Database Editor naturally writes SQLite, not SQL. SQL-as-truth would force the editor to either generate SQL diffs or maintain SQL+SQLite in parallel.

### Starting-state assumption

**v1 was never executed.** The v1 spec/plan (UUID injection + flat color column) sits in the repo as committed-but-unimplemented design. Therefore the migration's input state is the **current production schema** as committed today: no UUIDs in `boards`, no `colors` table, no `color_id` column. The script generates everything fresh.

For robustness, the script *also* detects post-v1 state (presence of `boards.uuid` column, `colors` table) and preserves data from it if found — but this is defensive rather than expected.

### Migration steps (in transaction)

1. **Bootstrap schema_version table.** Read current version. If the table doesn't exist, insert v1 (representing pre-redesign state, regardless of which v1 schema it actually has).
2. **Bail early if already at v2.** Idempotent — exits cleanly with status 0.
3. **Create the `colors` lookup table** if it doesn't already exist; seed with the 12-entry palette (black, red, green, blue, white, yellow, purple, orange, pink, brown, silver, gold). `INSERT OR IGNORE` so re-running is safe.
4. **Create new entity + alias + metadata tables** (brands, families, models, new-shape board_aliases, new-shape model_aliases, entity_color, board_openboarddata). Indexes and FKs as specified above.
5. **Populate brands.** `SELECT DISTINCT brand FROM boards` → one row per unique value. Fresh UUIDs.
6. **Populate families.** For each existing board, derive family via the pattern table. INSERT INTO families if `(brand_uuid, family_name)` not yet present. Log unmatched rows for developer review (warnings, not errors). Fresh UUIDs.
7. **Populate models.** For each `(brand, model_number)` unique pair, insert one models row with `display_name = old boards.model` (one canonical marketing string picked arbitrarily if multiple boards of the same model have different `boards.model` strings — others become `model_aliases` rows in step 10). Fresh UUIDs.
8. **Populate boards (new shape).** One row per old board. UUID strategy:
   - If old `boards.uuid` column exists and is populated (post-v1 state), **preserve** the existing UUID.
   - Otherwise (the expected case), generate a fresh UUID v4 per board.
   `model_uuid` FK populated based on the `(brand, model_number)` lookup. `board_number`, `board_name`, `odm`, `board_number_type`, `source`, `source_url` all carried over verbatim.
9. **Populate board_aliases (new shape).** Move rows from old `board_aliases` (keyed by `board_id` rowid) → new shape (keyed by `board_uuid`). Map old rowids to new UUIDs via a temporary lookup. Fresh UUIDs for the alias rows themselves. `alias_type` carried over.
10. **Populate model_aliases (new shape).** Move rows from old `model_aliases` (keyed by `board_id`, semantically wrong) → new shape (keyed by `model_uuid`, semantically correct). Multiple old rows mapping to the same `(model_uuid, alias)` collapse into one. **Also**: any `boards.model` strings that became aliases (because step 7 picked a different one as canonical `display_name`) get inserted here with `alias_type='oem_marketing'`. Fresh UUIDs.
11. **Populate entity_color from old `boards.color_id`** (post-v1 only). If the old `boards.color_id` column doesn't exist, skip. If it does, for each old board with a non-null color_id, insert `entity_color('board', board.uuid, color_id)`. Pre-v1 state has nothing to copy.
12. **Drop obsolete columns and tables.** Old `boards.brand`, `boards.model`, `boards.model_number`, `boards.color_id` (if present). Old-shape `board_aliases` and `model_aliases` tables (the new-shape ones live alongside under different names during migration; rename at the end). Use SQLite's `ALTER TABLE ... DROP COLUMN` (3.35+) or the table-rebuild idiom (`CREATE TABLE _new ... ; INSERT INTO _new SELECT ... ; DROP TABLE old; ALTER TABLE _new RENAME TO old`) — implementation plan picks one based on the SQLite version target.
13. **Update schema_version to 2.**
14. **Commit transaction.** If any step fails, the transaction rolls back and `boards.db` remains at v1.

### Migration script properties

- **Language: Python 3 stdlib** (`sqlite3`, `uuid`, `re`). Same toolchain as v1 spec's UUID injection helper. No third-party deps.
- **In-place mutation** of `boards.db`. Does not produce a new file.
- **Single transaction.** Atomic — either fully migrates or fully rolls back.
- **Idempotent.** Detects v2 by reading `schema_version`; exits cleanly if already migrated.
- **Logs unmatched family patterns to stderr** for developer review. Returns non-zero exit code if any rows fell through to the brand fallback (so CI catches missed patterns).

---

## Resolver behavior

### `BoardMatch` shape (Go)

Flat structure preserved for backward compatibility. One new field (`Family`):

```go
type BoardMatch struct {
    UUID         string   `json:"uuid"`
    BoardNumber  string   `json:"board_number"`
    Brand        string   `json:"brand"`             // from JOIN brands.name
    Family       string   `json:"family"`            // NEW — from JOIN families.name
    Model        string   `json:"model"`             // = models.display_name (marketing)
    ModelNumber  string   `json:"model_number"`      // = models.model_number (canonical)
    BoardName    string   `json:"board_name,omitempty"`
    ODM          string   `json:"odm,omitempty"`
    Type         string   `json:"board_number_type,omitempty"`
    Color        string   `json:"color,omitempty"`           // cascade-resolved server-side
    Aliases      []string `json:"aliases,omitempty"`         // from board_aliases
    ModelAliases []string `json:"model_aliases,omitempty"`   // from model_aliases (now model-scoped)
    Source       string   `json:"source,omitempty"`
}
```

Existing consumers (databank/metadata.go, frontend) read flat fields — none break. Added: `Family` (new), and the semantic fix that `ModelAliases` correctly aggregates from the model rather than from the board.

### Resolver query

Single pass with 4-LEFT-JOIN COALESCE for color cascade:

```sql
SELECT
    b.uuid, b.board_number, b.board_name, b.odm, b.board_number_type, b.source,
    m.model_number, m.display_name AS model_display,
    f.name AS family_name,
    br.name AS brand_name,
    c.name AS color_name
FROM boards b
JOIN models m   ON b.model_uuid  = m.uuid
JOIN families f ON m.family_uuid = f.uuid
JOIN brands br  ON f.brand_uuid  = br.uuid
LEFT JOIN entity_color ec_b  ON ec_b.scope_type='board'  AND ec_b.scope_uuid = b.uuid
LEFT JOIN entity_color ec_m  ON ec_m.scope_type='model'  AND ec_m.scope_uuid = m.uuid
LEFT JOIN entity_color ec_f  ON ec_f.scope_type='family' AND ec_f.scope_uuid = f.uuid
LEFT JOIN entity_color ec_br ON ec_br.scope_type='brand' AND ec_br.scope_uuid = br.uuid
LEFT JOIN colors c
    ON c.id = COALESCE(ec_b.color_id, ec_m.color_id, ec_f.color_id, ec_br.color_id)
WHERE upper(b.board_number) = ?
```

One round trip, atomic. The COALESCE expresses the cascade priority directly: `board → model → family → brand`. The most-specific non-NULL `color_id` wins.

The other resolution paths (prefix match, alias lookup, Apple revision strip, LCFC normalize) all use the same query template with different WHERE clauses.

### Alias loading queries

Two follow-up queries after the main resolve:

```sql
SELECT alias FROM board_aliases WHERE board_uuid = ?    -- was: board_id = ?
SELECT alias FROM model_aliases WHERE model_uuid = ?    -- was: board_id = ?  ← semantic fix
```

`model_uuid` is derived from the main resolver query result (`m.uuid` in the JOIN above).

---

## Downstream impact

- **Databank cache propagation** — no schema change beyond what v1 plan specified. `files.board_uuid` and `files.board_color` columns are correct as-is; their *source* changes (color now resolved via cascade) but the columns and shape are identical. The databank scanner already calls `bdb.Resolve()` for each file; that single call surfaces the cascade-resolved color now. No databank code changes beyond updating the `Metadata` struct to also carry `Family` if we want it cached (optional, can defer).
- **LibraryPanel** — `detail.board_color` field unchanged; the "Color: <name>" row renders identically. The v1 plan's Phase 4 frontend work applies as-is.
- **Existing scanned files in user databanks** — already-scanned `files.board_uuid` rows are correct (UUIDs are preserved through migration). Existing `files.board_color` rows are stale only if any boards had explicit `color_id` set in v1 (none did per the v1 plan's design). A rescan on first launch repopulates correctly.

---

## Verification

After migration script runs:

```bash
# Schema check
sqlite3 "Board Database/boards.db" ".schema brands"
sqlite3 "Board Database/boards.db" ".schema families"
sqlite3 "Board Database/boards.db" ".schema models"
sqlite3 "Board Database/boards.db" ".schema boards"
sqlite3 "Board Database/boards.db" ".schema entity_color"
sqlite3 "Board Database/boards.db" "SELECT version FROM schema_version;"
# expect: 2

# Counts
sqlite3 "Board Database/boards.db" \
  "SELECT (SELECT count(*) FROM brands) AS brands,
          (SELECT count(*) FROM families) AS families,
          (SELECT count(*) FROM models) AS models,
          (SELECT count(*) FROM boards) AS boards,
          (SELECT count(*) FROM board_aliases) AS board_aliases,
          (SELECT count(*) FROM model_aliases) AS model_aliases;"

# Every board has all four levels reachable
sqlite3 "Board Database/boards.db" \
  "SELECT count(*) FROM boards b
   LEFT JOIN models m ON b.model_uuid = m.uuid
   LEFT JOIN families f ON m.family_uuid = f.uuid
   LEFT JOIN brands br ON f.brand_uuid = br.uuid
   WHERE m.uuid IS NULL OR f.uuid IS NULL OR br.uuid IS NULL;"
# expect: 0

# UUID uniqueness across each entity table
for t in brands families models boards board_aliases model_aliases; do
  sqlite3 "Board Database/boards.db" \
    "SELECT '$t', uuid, count(*) FROM $t GROUP BY uuid HAVING count(*) > 1;"
done
# expect: empty across all tables

# Sample query: full resolve
sqlite3 -header -column "Board Database/boards.db" \
  "SELECT br.name AS brand, f.name AS family, m.model_number, m.display_name AS model, b.board_number
   FROM boards b
   JOIN models m ON b.model_uuid = m.uuid
   JOIN families f ON m.family_uuid = f.uuid
   JOIN brands br ON f.brand_uuid = br.uuid
   LIMIT 10;"
```

Then, Go side:

- `cd src/backend && go build ./...` — clean build with new query/struct.
- `cd src/backend && go test ./...` — existing tests pass after updating queries.
- Smoke: HTTP `GET /api/boards/resolve?q=820-00165` returns JSON containing `uuid`, `brand`, `family`, `model`, `model_number`, fields populated, no errors.

Frontend side:

- BoardRipper UI loads, Library panel detail renders, no console errors mentioning `family` / `board_color` / `board_uuid`.

---

## Future work (deferred, designed-around)

Each of these is explicitly out of scope for this sub-project. Listed here so they survive context resets and so the implementation plan author knows where the seams are.

### Hide-list (per-board parts to filter from rendering)

```sql
CREATE TABLE board_hidden_parts (
    board_uuid TEXT NOT NULL REFERENCES boards(uuid) ON DELETE CASCADE,
    refdes TEXT NOT NULL,            -- e.g. 'R12', 'U7'
    reason TEXT,                     -- optional: 'NC', 'depopulated', 'covered by shield'
    PRIMARY KEY (board_uuid, refdes)
);
```

Per-board collection. Manually curated via the future Database Editor. Surfaced in the renderer behind a "Hide listed parts" toggle. Not implemented in this sub-project — the schema accommodates it via the existing `boards.uuid` FK target.

### Database Editor UI (separate sub-project)

New tab in the Library panel: full CRUD over Brand, Family, Model, Board entities, plus their metadata (color, OpenBoardData refs, hide-list, future doc bindings) and aliases. Brand+Family chooser with "add family" dialog. Edits write directly to `boards.db`.

### CRM-facing API endpoints (separate sub-project)

- `GET /api/boards/open?uuid=...` — deterministic deep link from CRM tickets into BoardRipper, opens the board file if scanned.
- `GET /api/lookup?q=...` — flexible search across boards/models/aliases, returns availability info (whether the file is in the user's databank) so CRM can render an "Open in BoardRipper" link.

### Datasheet / documentation DB (separate sub-project, brainstorm pending)

Documents (datasheets, repair guides, pinouts) attach to entities at any scope, with a binding category (chipset / charger / CPU / EC / backlight driver / …). Same `(scope_type, scope_uuid)` cascading pattern as `entity_color`. Cross-referenced with future repair.wiki / logi.wiki integration.

### External-source ingestion (separate sub-projects)

- **devicedb.xyz** — sitemap-driven phase-1 import (~10K entries, slug parsing). Brainstorm done; implementation pending.
- **t.me/schematicslaptop** — index-only crawler (~18K posts, captions only, no file mirroring). Brainstorm done; implementation pending.
- **OpenBoardData** — git-clone + parse `inflex/OpenBoardData` text format, populate `board_openboarddata` and a future `board_measurements` table for per-net data.

All three converge on the same join shape: `external_refs(board_uuid, source, external_id)` table (or split per-source like `board_openboarddata` already is). UUIDs make multi-source merge trivial.

### Adaptive coloring (with theming work)

Once Brand and Family rows exist, "Apple → black" is a single insert: `INSERT INTO entity_color VALUES ('brand', <apple_uuid>, 1);`. Same for "Lenovo Legion → blue", "Dell → blue", "Lenovo (other) → green". The cascade does the rest. No code changes needed.

### Brand / family aliases

Not modeled today. Add `brand_aliases` and `family_aliases` tables (same shape as `model_aliases`) if real-world data demands them.

---

## Open questions for implementation plan

(none — design is locked; implementation plan handles task ordering and any helper-script refinements)
