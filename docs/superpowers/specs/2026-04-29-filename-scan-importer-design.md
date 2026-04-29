# Filename-Scan Importer (Slice 1) — Design

**Status:** design approved, ready for implementation plan
**Date:** 2026-04-29
**Sub-project:** filename-scan importer — turn the observation-pass JSON into `boards.db` rows
**Builds on:**
- [2026-04-28-boards-db-schema-redesign-design.md](2026-04-28-boards-db-schema-redesign-design.md) (v2 schema)
- [2026-04-29-filename-scan-observation-design.md](2026-04-29-filename-scan-observation-design.md) (observation pass that produces the input JSON)
**Followed by:** UI work in the Database Editor to "promote placeholder" entries (move boards from `Unsorted/<ODM>/(unknown)` to real `<Brand>/<Family>/<Model>` rows). Separate sub-project.

---

## Goal

Read the observation-pass JSON sidecar (`import-staging/filename-scan-<date>.json`), filter to NEW codes (those not yet in `boards.db`), and INSERT OR IGNORE them into `boards` under a synthetic placeholder hierarchy. Grows the DB from 145 boards to ~3,032 in a single transaction without touching schema.

The observation pass already did the human-review-equivalent (the 28 unit tests + the full Markdown report's per-pattern stats are the review gate). At ~2,887 net-new codes, per-code manual review is impractical; instead, we file them under explicitly-tagged placeholders so the to-curate set is `WHERE brands.name = 'Unsorted'` — a queryable work-queue.

## Non-goals

- **Schema changes.** No `migrateV3`. The placeholder hierarchy fits in v2 schema as-is.
- **`apple_a_number` import** (160 codes). These are MODEL identifiers, not boards. Different concern; separate slice.
- **Brand-context inference** from filename (e.g., parsing `ACER C5V01 LA-E891P` → Acer attribution). Requires its own design + parser. Future slice.
- **Database Editor "promote placeholder" flow** (UX for moving boards from Unsorted to real). Future slice.
- **Multi-source dedup** — observation pass already deduped by code. One row per unique code regardless of how many filenames mention it.
- **Manual `--apply` review gate.** The JSON sidecar IS the staged artifact; observation-pass tests + numeric review are the gate. No second review at apply time.

## Tooling

- Python 3 stdlib (`json`, `sqlite3`, `argparse`, `uuid`, `pathlib`). Same toolchain as everything else.
- Reads `import-staging/filename-scan-<date>.json` (input — required arg, no default).
- Mutates `Board Database/boards.db` in place (default; overridable via `--db`).

## Placeholder hierarchy

A single synthetic brand and a flat per-ODM family layout:

```
brands:
  Unsorted              ← the placeholder brand

families (under Unsorted):
  Apple                 ← apple_820 NEW codes go here
  Compal                ← compal_la
  LCFC                  ← lcfc_nm
  Quanta                ← quanta_da0
  MSI                   ← msi_ms
  ASUS                  ← asus_60nr
  Foxconn               ← oem_6050

models (one per family, all named "(unknown)"):
  Apple/(unknown)
  Compal/(unknown)
  LCFC/(unknown)
  Quanta/(unknown)
  MSI/(unknown)
  ASUS/(unknown)
  Foxconn/(unknown)
```

7 ODM patterns → 7 placeholder families → 7 placeholder models.

**Why "Unsorted/Apple/(unknown)" instead of attaching new Apple-820 codes to real Apple data:**
- Real Apple data already has board records with known parent A-numbers (e.g., A1466 → 820-00165).
- New filename-scan Apple-820 codes lack the parent A-number — we have the board code but don't know which model it sits under.
- Filing under `Unsorted/Apple/(unknown)` keeps "to-be-curated" boards isolated from validated data.
- Future "promote placeholder" UI moves these to real `Apple/<Family>/<A-number>` rows once the user curates them.

**Why "Unsorted" over per-ODM brands:**
- Compal/Quanta/LCFC/Foxconn aren't *consumer brands*; they're ODMs. Adding them as `brands` rows mixes concepts.
- Single `Unsorted` brand makes the curation work-queue trivially queryable.
- Database Editor tree shows `Unsorted` as one collapsible node — visually obvious it needs cleanup.

### What's the model_number for "(unknown)"?

`models.model_number` is `NOT NULL`. Each placeholder model uses a stable identifier per family:

```
Unsorted/Apple/(unknown)     model_number = "(unknown-apple)"
Unsorted/Compal/(unknown)    model_number = "(unknown-compal)"
Unsorted/LCFC/(unknown)      model_number = "(unknown-lcfc)"
Unsorted/Quanta/(unknown)    model_number = "(unknown-quanta)"
Unsorted/MSI/(unknown)       model_number = "(unknown-msi)"
Unsorted/ASUS/(unknown)      model_number = "(unknown-asus)"
Unsorted/Foxconn/(unknown)   model_number = "(unknown-foxconn)"
```

The `(family_uuid, model_number)` UNIQUE constraint on `models` ensures only one such row per family. Display names are `"(unknown — TODO: curate)"`.

## Importer behavior

`scripts/import-filename-scan.py <staging-json-path> [--db <path>]`

### Steps

1. **Validate input file exists and parses as JSON.** If missing or malformed, exit 1 with a clear error.
2. **Open `boards.db`.** Verify `schema_version >= 2`. Else exit 1.
3. **Find or create the placeholder hierarchy** (1 brand + 7 families + 7 models). All `INSERT OR IGNORE` so re-runs don't duplicate.
4. **For each pattern in {apple_820, compal_la, lcfc_nm, quanta_da0, msi_ms, asus_60nr, oem_6050}**:
   - Read `payload['per_pattern'][pattern]`.
   - Get `samples_new` (the list of net-new codes; up to 20 per pattern in the JSON, but full list lives in `samples_new` array — note: observation pass writes top-20; importer needs **all** new codes, not just samples).
   - **Issue:** the observation-pass JSON only writes `samples_new[:20]` per pattern. To import all, we need to either:
     - **(a)** Extend the observation pass to also write the full `new[]` set per pattern (small JSON-size increase from ~3KB to ~50KB total — fine).
     - **(b)** Re-cross-reference at import time by re-querying boards.db for every code in `payload['per_pattern'][p]['samples_new']` plus the original raw matches list (which is in the JSON).
   - Choose **(a)** — extend the observation-pass `write_json_sidecar()` to include `new_full: list[str]` (sorted). Adds ~5 lines; trivial. Importer reads `new_full` per pattern.
5. **For each NEW code, INSERT OR IGNORE INTO boards** with:
   - `uuid` = fresh `uuid.uuid4()`
   - `model_uuid` = the corresponding placeholder model's UUID
   - `board_number` = the code itself (uppercase, as stored by observation pass)
   - `board_number_type` = the pattern name (`apple_820`, `compal_la`, etc.)
   - `source` = `'filename-scan'`
   - `notes` = `f"filename-scan:{pattern}; sample:{first_sample_filename}"` (the JSON's per-token samples list provides this)
6. **Track inserted vs existing per pattern.** Print summary at end.
7. **Single transaction.** Atomic; rollback on error.

### Notes string composition

`filename-scan:<pattern>; sample:<filename>`

Example: `filename-scan:compal_la; sample:ACER C5V01 LA-E891P REV 2A.pdf`

The `sample` is the *first* filename observed (from the per-source iteration order in the observation pass, which is alphabetic via `sorted(p.iterdir())`). One sample is enough as evidence — full source filename traceability lives in the JSON, not in `notes`.

### Idempotency

`INSERT OR IGNORE` on `boards (board_number, model_uuid)` UNIQUE constraint prevents re-inserts. Re-running the importer with the same JSON: 0 new inserts. Re-running with a fresher JSON (after a new observation pass that found additional codes): only the truly-new codes land.

### Exit codes

- `0` — clean run, summary printed to stdout.
- `1` — input file missing/malformed, DB missing, schema < v2, or unhandled exception.

No `2` for validation errors because there's no manual review gate to surface concerns through.

## Cross-reference with observation pass

This slice depends on the observation pass writing the **full** `new[]` set per pattern, not just the 20-element sample. The observation-pass spec (already shipped) needs a small extension:

In `write_json_sidecar()`, add to each pattern's payload:
```python
'new_full': new,  # full sorted list, currently truncated to samples_new[:20]
```

The observation script's commits are on `feat/filename-scan-observation` branch; the implementation plan for THIS slice will instruct re-running the observation pass to regenerate the JSON with the new field.

(Alternative considered: modify the observation pass NOT to truncate `samples_new` in the first place. Decided against — the report viewer benefits from a short list, and renaming to `new_full` makes the importer's contract explicit.)

## Implementation outline

### Files

- **Create:** `scripts/import-filename-scan.py` (the importer)
- **Create:** `scripts/test_import_filename_scan.py` (unit + integration tests)
- **Modify:** `scripts/scan-board-filenames.py` — add `new_full` to JSON sidecar (one-line addition in `write_json_sidecar()`)

### Algorithm sketch

```python
PATTERN_TO_FAMILY = {
    'apple_820':  ('Apple',   '(unknown-apple)'),
    'compal_la':  ('Compal',  '(unknown-compal)'),
    'lcfc_nm':    ('LCFC',    '(unknown-lcfc)'),
    'quanta_da0': ('Quanta',  '(unknown-quanta)'),
    'msi_ms':     ('MSI',     '(unknown-msi)'),
    'asus_60nr':  ('ASUS',    '(unknown-asus)'),
    'oem_6050':   ('Foxconn', '(unknown-foxconn)'),
}
PLACEHOLDER_BRAND = 'Unsorted'

def main(staging_path, db_path):
    payload = json.loads(staging_path.read_text())
    conn = sqlite3.connect(db_path)
    try:
        # Schema-v2 guard
        ...
        # Find-or-create placeholder hierarchy (1 + 7 + 7 = 15 rows)
        brand_uuid = find_or_create_brand(conn, PLACEHOLDER_BRAND)
        family_to_model_uuid: dict[str, str] = {}
        for pattern, (family_name, model_number) in PATTERN_TO_FAMILY.items():
            family_uuid = find_or_create_family(conn, brand_uuid, family_name)
            model_uuid = find_or_create_model(conn, family_uuid, model_number,
                                               '(unknown — TODO: curate)')
            family_to_model_uuid[pattern] = model_uuid

        # Insert boards
        conn.execute("BEGIN")
        inserted_per_pattern: dict[str, int] = {}
        existing_per_pattern: dict[str, int] = {}
        for pattern in PATTERN_TO_FAMILY:
            stats = payload['per_pattern'].get(pattern, {})
            new_full = stats.get('new_full', [])
            samples = stats.get('samples_per_token', {})  # for notes
            ...
            for code in new_full:
                sample_filename = first_sample_for_code(payload, pattern, code)
                notes = f"filename-scan:{pattern}; sample:{sample_filename}"
                cur = conn.execute(
                    "INSERT OR IGNORE INTO boards "
                    "(uuid, model_uuid, board_number, board_number_type, source, notes) "
                    "VALUES (?, ?, ?, ?, ?, ?)",
                    (str(uuid.uuid4()), family_to_model_uuid[pattern],
                     code, pattern, 'filename-scan', notes),
                )
                if cur.rowcount > 0:
                    inserted_per_pattern[pattern] = inserted_per_pattern.get(pattern, 0) + 1
                else:
                    existing_per_pattern[pattern] = existing_per_pattern.get(pattern, 0) + 1
        conn.commit()
        print_summary(inserted_per_pattern, existing_per_pattern)
        return 0
    finally:
        conn.close()
```

`first_sample_for_code()` looks up the code in the JSON's per-pattern matches list (need to ensure the observation pass also includes per-code source filenames; this is part of the small `write_json_sidecar` extension or a separate lookup).

### Test coverage

- Unit: `find_or_create_*` helpers idempotent across runs
- Unit: `PATTERN_TO_FAMILY` map covers all 7 importable patterns
- Integration: import a synthetic JSON → assert correct counts in fixture DB
- Integration: re-run on same JSON → 0 inserts second time
- Integration: schema_version < 2 fails

## Verification

After running:

```bash
sqlite3 "Board Database/boards.db" "
SELECT (SELECT count(*) FROM boards WHERE source = 'filename-scan') AS scan_boards,
       (SELECT count(*) FROM boards) AS total_boards,
       (SELECT count(*) FROM brands WHERE name = 'Unsorted') AS unsorted_brand,
       (SELECT count(*) FROM models WHERE display_name LIKE '(unknown — TODO%') AS placeholder_models;
"
```

Expected:
- `scan_boards`: ~2,887 (matches sum of `new_full` across 7 patterns)
- `total_boards`: ~3,032 (was 145)
- `unsorted_brand`: 1
- `placeholder_models`: 7

JOIN-chain integrity:

```bash
sqlite3 "Board Database/boards.db" "
SELECT count(*) FROM boards b
LEFT JOIN models m ON b.model_uuid = m.uuid
LEFT JOIN families f ON m.family_uuid = f.uuid
LEFT JOIN brands br ON f.brand_uuid = br.uuid
WHERE m.uuid IS NULL OR f.uuid IS NULL OR br.uuid IS NULL;
"
```

Expected: `0`.

Spot-check Database Editor: open the panel, confirm `Unsorted` brand appears in the tree with 7 sub-families and substantial board lists under each.

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| Input JSON missing `new_full` field | Observation pass not yet extended | Re-run observation pass after the one-line script change |
| `(family_uuid, model_number)` constraint hit on placeholder | Placeholder model already exists | Find-or-create handles this — INSERT OR IGNORE then SELECT |
| Boards table swells but Database Editor doesn't show Unsorted | Frontend caches hierarchy | Reload the page; the editor fetches `/api/boards/hierarchy` fresh |
| Re-run produces 0 inserts but report claims many | INSERT OR IGNORE working correctly; existing-per-pattern counts confirm | No fix needed |

## Future-work pointers

- **Database Editor "promote placeholder" flow** — UX for moving boards from `Unsorted/<ODM>/(unknown)` to real `<Brand>/<Family>/<Model>`. Multi-select + drag-drop or bulk-edit. Big UX work; separate sub-project.
- **Brand-context inference** — parse filename pre-and-post-context around the board code (e.g., `ACER C5V01 LA-E891P` → tag as `(unattributed-Acer)` so Acer-prefixed boards land in a more refined family). Iterative pattern work.
- **`apple_a_number` model imports** — separate slice. Apple A-numbers without parent context could land under `Unsorted/Apple/(unknown-models)` family — but they're MODEL rows, not BOARD rows, so the schema treatment differs.
- **Online-lookup integration** — for high-priority codes (e.g., the user's own library files), look up real brand/family/A-number on vinafix/Badcaps. Out of scope here.
- **Observation-pass pattern extension** — top unmatched substrings (`Chinafix`, `H61M`, `H81M`, etc.) hint at additional patterns. Iterate with new regex entries; re-run observation; re-import.

---

## Open questions for implementation plan

(none — design is locked; implementation plan handles the observation-pass JSON extension as Task 1 of the importer plan)
