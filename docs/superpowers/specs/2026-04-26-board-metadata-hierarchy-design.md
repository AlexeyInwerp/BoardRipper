# Board Metadata Inheritance Hierarchy (v1) — IN PROGRESS

**Status:** brainstorm paused mid-design; resume from "Open questions" before implementation
**Date:** 2026-04-26
**Scope:** identity layer only (brand → subseries → model → board hierarchy with property inheritance, color as the first consumer)
**Out of scope:** knowledge layer (datasheets / articles / chips / wiki), boards.db crawler/scraper, metadata edit UI

---

## Motivation

Boards in `boards.db` today are a flat list with `brand` and `model` as TEXT strings. Color metadata is a single `color_id` per board. This doesn't model real product taxonomy:

- Lenovo ThinkPads are green; Lenovo Legions are blue; Legion GO is black; Yogas are black.
- All Apple boards are black; all Dell boards are blue.
- The user has 10–20k files; only ~66 are in the curated reference set. The other ~99% need useful metadata derived from filenames.

Without a hierarchy, color (and every future property) has to be set per-board, can't be inherited or overridden cleanly, and the user's bulk library files inherit nothing.

---

## Decisions captured (Q1–Q8)

| Q | Decision | Implication |
|---|---|---|
| Q1 | General property-inheritance schema (not color-only) | Color is the first consumer of a generic mechanism |
| Q2 | Identity layer only this brainstorm; knowledge layer is future work | Schema for nodes + properties; not for datasheets/articles |
| Q3 | Fixed 4-level tree (brand → subseries → model → board), subseries optional | Real product taxonomies fit; arbitrary depth is YAGNI |
| Q4 | Per-node override table, no editor in v1 | Edits live in databank.db, layered on top of read-only boards.db |
| Q5 | Hybrid: typed columns for structured properties + key-value tag table | Color is `color_id FK`; long-tail metadata via `node_tags` |
| Q6 | UUIDs at every node level | Future joins to knowledge entities, CRM, wiki — all UUID-based |
| Q7 | Schema migration + 66-board hand-edit + scanner subseries detection | Without scanner subseries detection, hierarchy buys nothing for ~99% of files |
| Q8 | Files with brand-only metadata land at brand level (nullable middle layers) | No synthetic "Other" subseries; tree just has nullable parents |

**Bonus discovery:** [src/frontend/src/store/apple-boards.ts](src/frontend/src/store/apple-boards.ts) already contains 166 Apple boards with `model` strings that map to ~8 subseries. Migration script can ingest this rather than hand-editing 166 entries.

---

## Schema (approved)

### Identity tables — `boards.db` (read-only)

```sql
brands (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    uuid        TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL UNIQUE,           -- "Apple", "Lenovo", "Dell"
    color_id    INTEGER REFERENCES colors(id),
    sort_order  INTEGER NOT NULL DEFAULT 0
);

subseries (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    uuid        TEXT NOT NULL UNIQUE,
    brand_id    INTEGER NOT NULL REFERENCES brands(id),
    name        TEXT NOT NULL,                  -- "ThinkPad", "Legion", "MacBook Pro"
    color_id    INTEGER REFERENCES colors(id),
    UNIQUE (brand_id, name)
);

models (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    uuid         TEXT NOT NULL UNIQUE,
    brand_id     INTEGER NOT NULL REFERENCES brands(id),
    subseries_id INTEGER REFERENCES subseries(id),  -- NULLABLE: brands w/o meaningful subseries
    name         TEXT NOT NULL,                     -- "T450", "MacBook Pro 16\"", "Inspiron 5720"
    model_number TEXT,                              -- "20BU/20BX", "A1706", "N5720"
    color_id     INTEGER REFERENCES colors(id),
    UNIQUE (brand_id, name)
);

boards (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    uuid              TEXT NOT NULL UNIQUE,
    model_id          INTEGER REFERENCES models(id),  -- NULLABLE: orphan boards
    board_number      TEXT NOT NULL,
    board_name        TEXT,
    odm               TEXT,
    board_number_type TEXT,
    color_id          INTEGER REFERENCES colors(id),  -- per-board override
    source            TEXT NOT NULL,
    source_url        TEXT,
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP
    -- brand/model strings derived via JOIN at query time, not duplicated as columns
);
```

`board_aliases` and `model_aliases` keep their existing FK to `boards.id`.

### Override table — `databank.db` (writable)

```sql
node_overrides (
    node_type     TEXT NOT NULL,    -- 'brand' | 'subseries' | 'model' | 'board'
    node_uuid     TEXT NOT NULL,    -- FK by UUID, cross-DB-safe (no SQL JOIN)
    property_key  TEXT NOT NULL,    -- 'color', 'odm_default', etc.
    value         TEXT,             -- nullable: explicit clear (suppresses inheritance)
    updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (node_type, node_uuid, property_key)
);
```

Lives in `databank.db` (per-installation, writable). The cross-DB UUID reference works because we never SQL-JOIN it — the resolver fetches the canonical node, then asks "any overrides?" as a separate query.

### Tag table — `databank.db` (writable, future use)

```sql
node_tags (
    node_type   TEXT NOT NULL,
    node_uuid   TEXT NOT NULL,
    key         TEXT NOT NULL,
    value       TEXT,
    PRIMARY KEY (node_type, node_uuid, key)
);
```

Empty in v1. Schema present so future "tag a board with common failures" doesn't need a migration.

---

## Open questions (resume here)

These were not reached before the brainstorm paused. Answer before writing the implementation plan.

### Section 2 of 5 — Resolution algorithm

How does the resolver compute the effective color for a given file?

- Walk: `board.color_id || override(board) || model.color_id || override(model) || subseries.color_id || override(subseries) || brand.color_id || override(brand) || NULL`
- "Cleared" sentinel: how does a child explicitly *suppress* the parent's color? `node_overrides.value = NULL` means "use inheritance"; `node_overrides.value = ''` means "explicit clear, no color"? Or some other sentinel?
- Multi-property variant: same walk for any property key (`color`, `odm_default`, etc.) — generic helper takes a property key and returns the first non-NULL match up the chain.

### Section 3 of 5 — Migration & data sources

Where does the data come from?

- **Apple subtree**: import `apple-boards.ts` (166 entries) via a one-shot Python helper. Extract subseries from `model` strings (`MacBook Pro 13"` → subseries=`MacBook Pro`). Hand-review for size-variant edge cases.
- **Non-Apple**: hand-edit the 42 existing entries in `build_full_db.sql` into the new shape.
- **`apple-boards.ts` retirement**: frontend `lookupBoard()` fallback gets removed once the data is unified — the resolver becomes the single source of truth.
- **Future ingestion (out of scope)**: devicedb.xyz / Telegram / OpenBoardData crawlers stay future work.

### Section 4 of 5 — Scanner classifier

Without subseries detection in the scanner, the hierarchy is useless for the ~99% of user files that don't exact-match `boards.db`. Need to extend `metadata.go` `ExtractMetadata`:

- Add a subseries keyword table (Lenovo: thinkpad/legion/yoga/ideapad/thinkbook; Apple: macbook pro/macbook air/imac/mac mini/mac pro/mac studio; Dell: inspiron/xps/latitude/precision/alienware; HP: elitebook/probook/pavilion/spectre/omen; ASUS: rog/zenbook/vivobook/tuf; etc.).
- Match priority: longest-keyword-wins (so "macbook pro" matches before "macbook").
- When a subseries matches but no exact board matches: file lands at brand+subseries level — inherits subseries color, joins the right node in the library tree.
- When no subseries matches: file lands at brand-only level (Q8 decision).
- Resolution status values gain `'subseries_matched'` between `'pattern_matched'` and `'unresolved'`.

### Section 5 of 5 — Resolver API & frontend changes

What does the API look like? What does the library/renderer consume?

- `BoardMatch` Go struct gains `Subseries`, `SubseriesUUID`, `BrandUUID`, `ModelUUID` fields.
- `resolveColor(board)` helper in Go does the inheritance walk; returns final `color_id` + `color_hex` + `inheritedFrom` ('board' | 'model' | 'subseries' | 'brand' | 'default').
- `databank.files` columns: add `brand_uuid`, `subseries_uuid`, `model_uuid` denormalized at scan time. Existing `manufacturer` / `model` TEXT stays for backwards compat.
- Library `MetadataGroup` becomes 4-level: brand → subseries → model → board_number → files.
- Library `ModelGroup` retired (subsumed by the new 4-level metadata view).
- Renderer's `useMetadataBoardColor` toggle now resolves via inheritance walk; per-board metadata color works as before, but ALSO works for files that only matched at subseries/brand level.

---

## Non-goals (reaffirmed)

- Knowledge layer (datasheets, articles, chips, wiki) — separate brainstorm.
- Metadata edit UI — schema supports it via `node_overrides`, but no UI in this iteration.
- Crawler / scraper to expand `boards.db` beyond curated entries.
- Multi-parent hierarchy (a board belonging to multiple subseries).
- Free-form depth (Lenovo Legion Pro 7 = 5 levels). Q3 ruled this out.

---

## Resume checklist

When picking this up:

1. Re-read decisions Q1–Q8 above.
2. Answer the four open-question sections (resolution algorithm, migration, scanner classifier, resolver API).
3. Run brainstorming spec self-review (placeholders, contradictions, ambiguity, scope).
4. Move spec out of `IN PROGRESS` state.
5. Hand to writing-plans skill.
