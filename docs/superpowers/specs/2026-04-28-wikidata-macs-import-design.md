# Wikidata → boards.db Macs Import (Slice 1)

**Status:** design approved, ready for implementation plan
**Date:** 2026-04-28
**Sub-project:** boards.db content expansion — first slice of a multi-source ingestion sequence
**Builds on:** [2026-04-28-boards-db-schema-redesign-design.md](2026-04-28-boards-db-schema-redesign-design.md) (v2 schema with Brand → Family → Model → Board hierarchy is in place; current count: 13 brands / 31 families / 47 models / 66 boards)

---

## Goal

Bulk-import Apple Mac model scaffolding from Wikidata into `boards.db`, growing the `models` table from ~12 Apple entries to ~150-250. Each imported model lands as a row under the correct family (`MacBook Pro`, `MacBook Air`, `MacBook`, `iMac`, `Mac mini`, `Mac Pro`, `Mac Studio`), with the canonical Apple A-number as `model_number` and the marketing string as `display_name`. Year, EMC, and Wikidata Q-id are stuffed into `notes` as free-form key-value pairs for now; promotion to typed columns is deferred to a future schema-v3 migration.

This slice deliberately leaves `boards` (the entity below `models`) untouched — most newly-imported models will have zero attached boards. That's expected: the next slice (logi.wiki) attaches 820-NNNNN board codes to these models.

The slice is **carefully** scoped: a staged-review JSON file is the only thing the script writes on its first run. Nothing touches `boards.db` until the developer reviews the JSON, optionally edits it, and reruns with `--apply`.

## Non-goals

- iPhone, iPad, Apple Watch, AirPods, HomePod — separate Slice 1B (same Wikidata pattern, different SPARQL filter).
- Board-level entities (820-NNNNN) — Slice 2 (logi.wiki).
- Schema changes to add `year` / `emc` / `source` columns — deferred until we've seen one batch of Wikidata data and know the shape.
- Cross-brand expansion (Lenovo, Dell, etc.) — separate sub-project; devicedb.xyz is the better source there.
- Any UI surface for the import — script-only, run from the command line.

## Tooling

- **Language:** Python 3 stdlib (`urllib.request`, `json`, `sqlite3`, `re`). No third-party deps. Same toolchain as `migrate-boarddb-v2.py`.
- **Endpoint:** `https://query.wikidata.org/sparql` (public SPARQL endpoint, no auth, ~5 sec/query at this scale).
- **Output:** `import-staging/wikidata-macs-<date>.json` (gitignored) — review file. After `--apply`, it merges into `Board Database/boards.db` directly. Standard "static reference DB" mutation pattern.

---

## Phase A — Extract (no DB write)

`scripts/import-wikidata-macs.py` (no flag, default mode).

### SPARQL query

```sparql
SELECT ?item ?itemLabel ?aNumber ?emc ?year ?series ?seriesLabel WHERE {
  ?item wdt:P176 wd:Q312.                    # manufacturer = Apple Inc.
  ?item wdt:P31/wdt:P279* wd:Q3962655.       # instance of (subclass of) Macintosh family
  OPTIONAL { ?item wdt:P3618 ?aNumber. }     # Apple model identifier
  OPTIONAL { ?item wdt:P9216 ?emc. }         # EMC number
  OPTIONAL { ?item wdt:P571 ?year. }         # inception
  OPTIONAL { ?item wdt:P179 ?series. }       # part of series
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
```

Property IDs are best-effort. The implementer validates by running the query first time and inspecting output. If any property has been renumbered or doesn't return data for Macs, fall back to extracting the value from `itemLabel` (which usually contains "MacBook Pro 16-inch (Late 2019)" — full marketing string) plus a small regex pass to parse the year.

User-Agent header **must** identify the script (Wikidata's politeness requirement):

```
User-Agent: BoardRipper-Wikidata-Macs-Import/1.0 (https://github.com/AlexeyInwerp/BoardRipper)
```

### Family resolution

Each Wikidata row resolves to a canonical family using a layered strategy:

1. **If `seriesLabel` is present** and matches a known canonical family name (`MacBook Pro`, `MacBook Air`, `MacBook`, `iMac`, `Mac mini`, `Mac Pro`, `Mac Studio`), use it directly.
2. **Otherwise**, fall back to `derive_family('Apple', label)` from `migrate-boarddb-v2.py` — same `FAMILY_PATTERNS` table that drove the original migration. Reuses single source of truth for family extraction.
3. **If both fail**, the row gets `family: null` in the staging JSON. The reviewer must fill it in or set `skip: true`.

Family names that don't yet exist in the `families` table are created lazily during `--apply` (`INSERT OR IGNORE`). New families like `Mac Studio` may not exist in the current DB; that's fine.

### Staging file

Path: `import-staging/wikidata-macs-<YYYY-MM-DD>.json` (timestamped to allow re-runs without overwriting prior reviews).

Shape:

```json
{
  "fetched_at": "2026-04-28T18:00:00Z",
  "source_query": "<the SPARQL query verbatim>",
  "row_count": 187,
  "rows": [
    {
      "wikidata_qid": "Q12345",
      "family": "MacBook Pro",
      "model_number": "A2141",
      "display_name": "MacBook Pro 16-inch (Late 2019)",
      "year": 2019,
      "emc": "3348",
      "raw_label": "MacBook Pro (16-inch, Late 2019)",
      "skip": false
    }
  ]
}
```

Field semantics:
- `wikidata_qid` — frozen at fetch time, used for traceability.
- `family` — one of the 7 canonical Mac family names, or `null` if both resolution paths failed.
- `model_number` — Apple A-number (`A2141`). May be empty string if Wikidata didn't surface one. Reviewer must fill it in or set `skip: true`.
- `display_name` — the cleaned marketing string for UI display. Reviewer can rewrite for clarity.
- `year`, `emc` — numeric/string fields. Either may be null if Wikidata didn't have them.
- `raw_label` — the unaltered Wikidata `itemLabel` for reference during review.
- `skip` — defaults to `false`. Reviewer flips to `true` to drop a row.

The staging file is the human-edit surface. Anything goes in there: typo fixes, family reassignments, manually populating missing model_numbers from external knowledge.

### `import-staging/` directory

New top-level directory at repo root. Add to `.gitignore`:

```
# Transient import-review staging files; never committed
import-staging/
```

Files inside are throwaway after `--apply` succeeds (or after the reviewer abandons the import).

---

## Phase B — Apply (DB write)

`scripts/import-wikidata-macs.py --apply <path-to-staging-file>`.

### Merge algorithm

Inside a single SQLite transaction:

1. Open `Board Database/boards.db`. Verify `schema_version >= 2` (else fail with "run migrate-boarddb-v2.py first").
2. Look up Apple's `brand_uuid`:
   ```sql
   SELECT uuid FROM brands WHERE name = 'Apple'
   ```
   If no row, fail loudly: "Apple brand not in DB; bootstrap fresh from create_mockup_db.sql first."
3. Read staging JSON. Filter `skip != true`. Validate each remaining row has non-null `family` and non-empty `model_number`. Rows that fail validation block the entire run with an error pointing at the offending `wikidata_qid`.
4. For each valid row:
   - Find or create family: `INSERT OR IGNORE INTO families (uuid, brand_uuid, name) VALUES (?, ?, ?)` then `SELECT uuid FROM families WHERE brand_uuid = ? AND name = ?`. New family UUIDs use `uuid.uuid4()`.
   - Build notes string: `"wikidata:{qid}; year:{year}; emc:{emc}"` — fields with null values are omitted (e.g., `"wikidata:Q12345; year:2019"` if EMC unknown).
   - `INSERT OR IGNORE INTO models (uuid, family_uuid, model_number, display_name, notes) VALUES (?, ?, ?, ?, ?)`. The UNIQUE constraint on `(family_uuid, model_number)` ensures duplicates skip silently.
5. Track: `inserted` (new models), `existing` (skipped because `(family_uuid, model_number)` already in DB), `skipped` (rows with `skip: true`).
6. Commit transaction. If any error in steps 1-4, rollback and exit non-zero.
7. Print summary:
   ```
   wikidata-macs apply complete:
     N rows in staging file
     X inserted (new models)
     Y existing (already in DB, untouched)
     Z skipped (skip:true in staging)
     <new-families-list> created in families table
   ```
8. Exit non-zero if `Z > 0` (signals "human review surfaced something to inspect later").

### Conflict resolution

`INSERT OR IGNORE` is intentional: existing models — including hand-curated rows from the `migrate-boarddb-v2.py` seed — are **never overwritten**. Wikidata import is strictly additive. If a row in staging has the same `(family_uuid, model_number)` as an existing model, the import skips it.

This means: re-running `--apply` after editing the staging file only inserts the rows that are still missing. Idempotent.

### Provenance

Imported models carry `notes = "wikidata:Q12345; year:2019; emc:3348"`. Future filtering / re-import / cleanup can use `notes LIKE 'wikidata:%'` to identify Wikidata-sourced rows.

When schema-v3 lands and adds typed `year` / `emc` / `source` columns, a one-shot script will parse `notes` and populate the new columns; this is a future migration, not part of this slice.

---

## Verification

After `--apply`:

```sql
-- Count Wikidata-sourced models
SELECT count(*) FROM models WHERE notes LIKE 'wikidata:%';

-- Apple family distribution
SELECT br.name AS brand, f.name AS family, count(m.uuid) AS models
FROM brands br
JOIN families f ON f.brand_uuid = br.uuid
JOIN models m   ON m.family_uuid = f.uuid
WHERE br.name = 'Apple'
GROUP BY br.name, f.name
ORDER BY models DESC;
-- Expect: ~7 rows, MacBook Pro highest count, then MacBook Air, iMac, etc.

-- Spot-check: a famous A-number
SELECT m.model_number, m.display_name, f.name AS family, m.notes
FROM models m
JOIN families f ON m.family_uuid = f.uuid
WHERE m.model_number = 'A2141';
-- Expect: A2141 / MacBook Pro 16-inch (Late 2019) / MacBook Pro / wikidata:Q...; year:2019; emc:...

-- JOIN-chain integrity (no orphan models)
SELECT count(*) FROM models m
LEFT JOIN families f ON m.family_uuid = f.uuid
WHERE f.uuid IS NULL;
-- Expect: 0
```

Then open the Database Editor (Settings → Open Database Editor), navigate to Apple in the tree, expand all 7 families. Each should now have many models compared to today's sparse list. Models without boards (most newly-imported ones) show empty board lists — expected.

---

## Failure modes and recovery

| Symptom | Cause | Fix |
|---------|-------|-----|
| SPARQL returns 429 (rate limit) | Hit Wikidata's polite-use threshold | Add 5s sleep before retry; rerun |
| SPARQL returns 0 rows | Property ID changed or query is malformed | Validate query manually at query.wikidata.org/embed.html |
| Family resolution fails for many rows | `seriesLabel` missing AND `derive_family()` doesn't match | Extend `FAMILY_PATTERNS` in `migrate-boarddb-v2.py` (it's the source of truth); rerun extraction |
| `--apply` fails: "Apple brand not in DB" | Schema not at v2 yet, or DB freshly bootstrapped without seed | Run `migrate-boarddb-v2.py` first |
| User edits staging JSON wrong | Invalid JSON or missing required fields | Script validates on `--apply`, prints offending row's `wikidata_qid` |
| Model already exists in DB | Hand-curated seed had this A-number too | Expected; `INSERT OR IGNORE` skips. Counted in "existing" summary |

---

## Future work (deferred)

These extend the same pattern; not in scope for this slice:

- **Schema-v3 migration.** Adds `models.year INTEGER`, `models.emc_number TEXT`, `models.source TEXT`. One-shot script parses `notes` field to populate. Promotes free-form provenance to queryable columns. Lands after Slice 1's data has been validated empirically.
- **Slice 1B — iPhone / iPad / Watch / AirPods.** Same script structure, different SPARQL filter (e.g., `Q3502066` for iPhone family). These devices don't have 820-NNNNN board codes; they'd live as pure model-level scaffolding until a board-level source lands.
- **Slice 2 — logi.wiki backend → 820-NNNNN boards.** Pull board pages via your backend access (no public scraping), match each to an A-number from this slice's models, insert as `boards` rows. Likely grows boards from 66 to ~300-500.
- **devicedb.xyz import.** Cross-brand boards (Lenovo, Dell, HP, Acer, Asus). Different script, different source, same staging-then-apply pattern.
- **Telegram channel index.** ~18K-post anonymous crawler producing similar staging JSON. Lower-quality data, requires more aggressive review.

The staging-then-apply pattern is the durable shape. Each new source gets its own `import-{source}-{domain}.py` script + its own staging JSON + its own provenance prefix in `notes` (`devicedb:N123`, `telegram:post-456`, etc.).

---

## Open questions for implementation plan

(none — design is locked; implementation plan handles the SPARQL query refinement when the script first runs)
