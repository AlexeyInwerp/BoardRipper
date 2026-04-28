# XZZ Apple Laptop Skeleton Import — Design

**Status:** design approved, ready for implementation plan
**Date:** 2026-04-28
**Sub-project:** boards.db content expansion, Apple-laptop focus
**Builds on:** [2026-04-28-boards-db-schema-redesign-design.md](2026-04-28-boards-db-schema-redesign-design.md) (v2 schema with Brand → Family → Model → Board hierarchy)
**Supersedes:** [2026-04-28-wikidata-macs-import-design.md](2026-04-28-wikidata-macs-import-design.md). Wikidata's coverage of Apple devices turned out to be **line-level** (~7 entities) rather than per-A-number. The script + tests from that path remain on branch `feat/wikidata-macs-import` (commits `83e650f`, `effa49d`, `44ee8c7`) but produce no useful data and should be retired in the implementation plan.

---

## Goal

Bulk-import Apple laptop board records from the user's local **XZZ Synology Drive folder** into `boards.db`. The XZZ team's folder structure encodes the A-number ↔ 820-NNNNN linkage in path names like `A1466_820-00165 J113`, so a single regex pass over directory listings yields fully-linked `(A-number, board_number, codename)` triples. **Family** still needs human curation per unique A-number (ambiguity between MacBook / MacBook Air / MacBook Pro that the path doesn't encode), but the bulk of the data — A-number-to-board mapping — comes free from the filesystem.

Expected outcome at this scale: ~50-80 unique Apple laptop A-numbers (models) and ~119 board entries, each with `notes = "xzz:<original-folder-name>"` for provenance. Boards count grows from 66 to ~150-180.

The "carefully" instruction is honored by:
- Only **folder names** are read. No file contents are touched. Same `index facts, never mirror content` posture as the broader research.
- A Phase B human-curation step gates every row before it touches `boards.db`. The user fills in family per unique A-number (with Mactracker as visual reference).
- `INSERT OR IGNORE` preserves existing rows in `boards.db` — manual curation always wins.

## Non-goals

- **Apple desktops** (iMac / Mac mini / Mac Pro / Mac Studio). XZZ's `Computers/3 Graphics card/5 Apple iMAC` folder is GPU-card-organized, not per-A-number; out of scope for this slice. Future slice with a different source needed.
- **Non-Apple brands** in XZZ (`HP`, `DELL`, `ASUS`, `Lenovo ThinkPad`, etc.). Each has different folder conventions; address per-brand in separate slices.
- **File extraction or parsing** of any board file inside the XZZ folders. We only read directory names. The actual `.brd` / `.pdf` files belong to the XZZ collection and stay there.
- **Schema changes** to add typed `year` / `codename` / `source` columns. Same notes-field-as-provenance approach as the Wikidata-attempt path. Schema-v3 deferred.

## Tooling

- **Language:** Python 3 stdlib (`os`, `re`, `json`, `sqlite3`, `argparse`, `pathlib`). Same toolchain as `migrate-boarddb-v2.py`.
- **Source path:** `/Users/besitzer/Library/CloudStorage/SynologyDrive-Mac/XZZ/Computers/1 Laptop/APPLE/` — Synology Drive sync of the NAS folder. Local filesystem; no network. (Override-able via `--xzz-root` CLI flag for portability.)
- **Output:** Same staging-then-apply pattern as the Wikidata script. Staging file at `import-staging/xzz-apple-laptops-<YYYY-MM-DD>.json`.

---

## XZZ folder layout (observed)

```
.../XZZ/Computers/1 Laptop/APPLE/
├── 0 A12xx Repair Case/                 # repair-case PDFs, IGNORE (folder name doesn't match the A_820 pattern)
├── A12xx/
│   ├── 0 A12xx Repair Case/             # IGNORE (same — repair-case bucket inside the bucket)
│   ├── A1278_820-2530/                  # A1278, board 820-2530
│   ├── A1278_820-2936-A J57/            # A1278, board 820-2936-A, codename J57
│   └── ...
├── A14xx/
│   ├── A1466_820-00165 J113/            # A1466, board 820-00165, codename J113
│   ├── A1466 820-3209 J13/              # A1466, board 820-3209 (note: space separator instead of underscore)
│   ├── A1419 820-00292(At the end of 2015)/  # A1419, board 820-00292, free-text comment in parens
│   └── ...
├── ...
├── Old model/                            # legacy stuff, no consistent naming, IGNORE
├── Power on sequence/                    # documentation, IGNORE
└── ...
```

Buckets: `A12xx`, `A13xx`, `A14xx`, `A15xx`, `A17xx`, `A18xx`, `A19xx`, `A21xx`, `A22xx`, `A23xx`, `A24xx`, `A26xx`, `A27xx`, `A29xx`, `A31xx` (15 buckets observed).

Inside each bucket, individual board folders follow one of these conventions (regex-tolerant):

```
^(A\d{4})[_ ](820-\d+(?:-[A-Z])?)(.*)$
```

- Group 1: A-number (e.g., `A1466`)
- Group 2: 820-code with optional revision suffix (e.g., `820-00165`, `820-2936-A`)
- Group 3: trailing text — codename like `J113`, parenthetical year hint, etc. (kept verbatim in notes for context)

**Note:** XZZ's 820-codes vary in width — some are `820-NNNNN` (5 digits, modern Apple convention) and some are `820-NNNN` (4 digits, older models). The regex uses `\d+` to accept both.

Folders that don't match this regex are explicitly ignored (legacy "Repair Case" buckets, "Old model", "Power on sequence" documentation folders).

---

## Phase A — Extract (automatic)

`scripts/import-xzz-apple-laptops.py` (default mode, no flag).

### Algorithm

```python
ROOT = Path('/Users/besitzer/Library/CloudStorage/SynologyDrive-Mac/XZZ/Computers/1 Laptop/APPLE')
ENTRY_RE = re.compile(r'^(A\d{4})[_ ](820-\d+(?:-[A-Z])?)(.*)$')

records: list[dict] = []  # one per board folder
unique_a_numbers: dict[str, list[str]] = {}  # a_number -> [folder_names]

for bucket in sorted(ROOT.iterdir()):
    if not bucket.is_dir():
        continue
    if not re.match(r'^A\d+xx$', bucket.name):
        continue  # skip "Old model", "Power on sequence", "0 A12xx Repair Case"
    for board_folder in sorted(bucket.iterdir()):
        if not board_folder.is_dir():
            continue
        m = ENTRY_RE.match(board_folder.name)
        if not m:
            continue  # skip "0 A14xx Repair Case" subfolders, anything else
        a_number, board_number, trailer = m.groups()
        codename, year_hint = parse_trailer(trailer)
        records.append({
            'a_number': a_number,
            'board_number': board_number,
            'codename': codename,        # e.g. 'J113' or null
            'year_hint': year_hint,      # e.g. '2015' or null
            'folder_name': board_folder.name,
            'bucket': bucket.name,       # e.g. 'A14xx'
            'skip': False,
        })
        unique_a_numbers.setdefault(a_number, []).append(board_folder.name)
```

`parse_trailer()` extracts the codename (`J\d+` pattern) and year hint (`\(.*\d{4}.*\)` pattern) if present; both fields are best-effort.

### Staging file shape

`import-staging/xzz-apple-laptops-<YYYY-MM-DD>.json`:

```json
{
  "fetched_at": "2026-04-28T20:00:00Z",
  "source_root": "/Users/besitzer/Library/CloudStorage/SynologyDrive-Mac/XZZ/Computers/1 Laptop/APPLE",
  "bucket_count": 15,
  "board_count": 119,
  "unique_a_numbers": 47,
  "a_numbers": [
    {
      "a_number": "A1466",
      "family": null,
      "display_name": null,
      "source_folders": ["A1466_820-00165 J113", "A1466 820-3209 J13", ...],
      "skip": false
    }
  ],
  "boards": [
    {
      "a_number": "A1466",
      "board_number": "820-00165",
      "codename": "J113",
      "year_hint": null,
      "source_folder": "A1466_820-00165 J113",
      "bucket": "A14xx",
      "skip": false
    }
  ]
}
```

`a_numbers` and `boards` are kept as separate lists (not nested) because the apply phase treats them as two sequential merge passes — A-numbers first (so `model_uuid` is available), then boards.

The `family` field on each A-number entry is the **only field that requires human curation**. Everything else is auto-populated.

---

## Phase B — Curate (manual)

User opens the staging JSON. With Mactracker open as visual reference, fills in:

### For each A-number row

- `family`: one of the 4 canonical Apple laptop families:
  - `MacBook Pro`
  - `MacBook Air`
  - `MacBook` (the 12-inch unibody line and earlier generic MacBooks)
  - Or the catch-all `MacBook (other)` for legacy models that don't cleanly map (rare)
- `display_name`: optional marketing name (e.g., `"MacBook Pro 13\" Late 2008"`). Defaults to the A-number string if left null.
- `skip`: set to `true` if the A-number is a false-positive or non-Mac device that snuck into the laptop folder.

### For each board row

- `skip`: set to `true` to drop a board entry. Useful for duplicates (same 820-code in two different folders due to naming variations) or non-board entries.
- All other fields (`a_number`, `board_number`, `codename`, etc.) are pre-filled by Phase A and **do not require user action**.
- The board's parent A-number is already known from the folder structure; no `parent_a_number` field needed.

### Curation cost

~47 unique A-numbers × ~30 seconds each = ~25 minutes. Significantly less than logi.wiki's expected ~75 minutes (which would have required filling in `parent_a_number` per board *and* `family` per A-number). XZZ's pre-encoded linkage saves the second of those passes.

---

## Phase C — Apply (automatic)

`scripts/import-xzz-apple-laptops.py --apply <staging-file>`.

### Merge algorithm

Single SQLite transaction:

1. Open `Board Database/boards.db`. Verify `schema_version >= 2`.
2. Look up Apple's `brand_uuid`. Fail if missing.
3. **Validate** all non-skipped rows:
   - A-number row: `family` MUST be one of `{MacBook Pro, MacBook Air, MacBook, MacBook (other)}`. `a_number` matches `A\d{4}`.
   - Board row: `a_number` MUST exist as a non-skipped row in the staging file's `a_numbers` list OR already exist as a model in the DB. `board_number` matches `820-\d+(?:-[A-Z])?`.
   - Any failure: print the offending row's `source_folder`, return exit code 2.
4. **Family cache**: load existing Apple families upfront.
5. **A-number loop** (process before boards, so `model_uuid` is available):
   - Find or create family.
   - Build notes: `xzz:<comma-separated-source-folders, capped at 5>`.
   - `INSERT OR IGNORE INTO models (uuid, family_uuid, model_number=a_number, display_name, notes)`.
6. **Build a_number → model_uuid map** (post-loop, includes pre-existing models too).
7. **Board loop**:
   - Look up `a_number` in the map.
   - Build notes: `xzz:<source_folder>`. Codename and year_hint, if present, get appended: `xzz:A1466_820-00165 J113; codename:J113`.
   - `INSERT OR IGNORE INTO boards (uuid, model_uuid, board_number, board_number_type='apple_820', source='xzz', notes)`.
8. Commit. Print summary.

### Notes string composition

- A-number: `xzz:<folder1>,<folder2>,...,<folderN>` (capped at 5; rest become `,...3 more`)
- Board: `xzz:<folder>` plus optional `; codename:Jxx` and `; year_hint:YYYY`

### Conflict resolution

`INSERT OR IGNORE` preserves all existing rows. The `(family_uuid, model_number)` UNIQUE constraint on `models` and `(board_number, model_uuid)` UNIQUE on `boards` handle the dedup automatically.

### Exit codes

- `0` — clean run, no skipped rows, no errors.
- `1` — clean run, some `skip:true` rows in staging (signals "human review surfaced something to inspect").
- `2` — validation error (missing family, malformed identifier, orphan board with no parent A-number). No DB mutation.

---

## Verification

After `--apply`:

```sql
-- Count XZZ-sourced models and boards
SELECT (SELECT count(*) FROM models WHERE notes LIKE 'xzz:%') AS xzz_models,
       (SELECT count(*) FROM boards WHERE notes LIKE 'xzz:%') AS xzz_boards;

-- Apple-laptop family distribution
SELECT br.name AS brand, f.name AS family,
       count(DISTINCT m.uuid) AS models,
       count(b.uuid) AS boards
FROM brands br
JOIN families f ON f.brand_uuid = br.uuid
JOIN models m   ON m.family_uuid = f.uuid
LEFT JOIN boards b ON b.model_uuid = m.uuid
WHERE br.name = 'Apple' AND f.name LIKE 'MacBook%'
GROUP BY br.name, f.name
ORDER BY models DESC;

-- Spot-check a known board: A1466 + 820-00165
SELECT m.model_number, m.display_name, f.name AS family, b.board_number, b.notes
FROM boards b
JOIN models m ON b.model_uuid = m.uuid
JOIN families f ON m.family_uuid = f.uuid
WHERE m.model_number = 'A1466' AND b.board_number = '820-00165';
-- Expect: A1466 / MacBook Air 13" 2015 / MacBook Air / 820-00165 / xzz:A1466_820-00165 J113

-- JOIN-chain integrity
SELECT count(*) FROM boards b
LEFT JOIN models m ON b.model_uuid = m.uuid
WHERE m.uuid IS NULL;
-- Expect: 0
```

Open the Database Editor (Settings → Open Database Editor), navigate Apple → MacBook Air / MacBook Pro. Each family should now have ~10-30 models, each with one or more boards.

---

## Failure modes and recovery

| Symptom | Cause | Fix |
|---------|-------|-----|
| `--xzz-root` not found | Synology Drive paused/not synced | Resume sync, retry |
| 0 boards extracted | Folder structure changed | Inspect `ls "$XZZ_ROOT"` manually; update `BUCKET_RE` if needed |
| Duplicate `(family_uuid, model_number)` warnings | A-number appears in multiple buckets (rare) | Phase A dedup at extraction; verify single row per A-number in staging |
| Board's `a_number` not in staging | Phase B reviewer set the parent A-number's `skip:true` but missed corresponding boards | Phase C validation rejects with row-level error and the offending board's `source_folder` |
| Codename / year-hint extraction wrong | Regex misparses the trailer | Phase B reviewer can manually fix; trailing text remains in `notes` regardless |

---

## Future work (not in this slice)

- **iMac / Mac mini / Mac Pro / Mac Studio coverage.** XZZ's iMac folder is GPU-card-organized, not useful here. Sources to consider: hand-curate from Mactracker, scrape iFixit per-A-number pages, or wait for logi.wiki.
- **logi.wiki as supplemental Apple source.** For A-numbers that appear on logi.wiki but not in XZZ. Would surface page titles only (factual identifiers); same staging-then-apply pattern, different extract phase.
- **Cross-brand expansion via XZZ.** XZZ has well-organized folders for HP, DELL, ASUS, Lenovo ThinkPad, etc. Each has different naming conventions; one importer per brand or a parameterized importer that takes a regex per brand.
- **Schema-v3 migration.** Promote `notes`-field-encoded codename/year-hint to typed columns once the data shape is validated empirically.
- **Retire the unused Wikidata script.** `scripts/import-wikidata-macs.py` and its 15 tests work but produce no useful data (Wikidata coverage is too coarse). Decision during implementation plan: delete or rename to `.unused` for archival reference.

---

## Open questions for implementation plan

(none — design is locked; implementation plan handles regex tightening, dedup edge cases, and the Wikidata-script retirement decision)
