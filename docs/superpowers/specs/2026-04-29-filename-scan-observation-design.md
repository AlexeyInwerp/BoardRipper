# Filename Scan — Observation Pass (no DB writes)

**Status:** design approved, ready for implementation plan
**Date:** 2026-04-29
**Sub-project:** filename-driven board-identifier extraction — observation phase
**Builds on:** [2026-04-28-boards-db-schema-redesign-design.md](2026-04-28-boards-db-schema-redesign-design.md)
**Followed by:** an importer slice that turns observed identifiers into `boards.db` rows. The shape of that importer is informed by what this scan reports — schema-decision-on-NULL-model_uuid vs synthetic-model-rows, pattern set, brand attribution strategy.

---

## Goal

Single-shot Python script that walks three local source directories, extracts board-level identifiers via 8 known ODM regex patterns plus a substring-frequency catch-all, cross-references each extracted code against the current `boards.db`, and produces a Markdown report + JSON sidecar in `import-staging/`. **No DB writes, no online lookups.**

Pure observation pass. The output answers the questions: how many board codes do these sources contain, how distinct are they per ODM, how many are already in our DB vs net-new, and what filename patterns are we missing in our regex battery.

## Non-goals

- **No DB writes.** This slice never touches `boards.db` for mutation; only one read-only SELECT per code for the cross-reference.
- **No staging file for `--apply`.** This is observation, not staging-then-apply. The importer is a separate sub-project.
- **No brand-name attribution from filename context.** Heuristic and lossy; defer to the importer slice.
- **No online lookups** (vinafix, Badcaps, etc.). Separate sub-projects.
- **No file-content inspection.** Only filenames are read. Cheap, deterministic, zero parser fragility.

## Tooling

- Python 3 stdlib only: `os`, `re`, `json`, `sqlite3`, `argparse`, `pathlib`, `collections.Counter`, `datetime`. Same toolchain as `migrate-boarddb-v2.py` and `import-xzz-apple-laptops.py`.
- Read-only SQLite connection to `Board Database/boards.db` (one query per unique code).
- Output to gitignored `import-staging/` (existing convention).

## Sources

Defaults (CLI `--source <path>` repeatable, overrides defaults):

1. `/Users/besitzer/Desktop/Boardviewer/samples/` — dev sample tree (~305 files, mixed Apple boardview + PDFs).
2. `/Users/besitzer/Library/CloudStorage/SynologyDrive-Mac/XZZ/` — full XZZ archive (Apple, plus DELL/HP/ASUS/MSI/Lenovo/etc.). 10,000+ files.
3. `/Users/besitzer/Library/CloudStorage/SynologyDrive-Mac/DESKTOP/BOARDS STUFF/` — user's primary library. ~16,829 files.

If a source path doesn't exist (e.g., Synology Drive paused), the scan logs a warning and continues with the others.

The script walks files, not directories. Folder names are not inspected (XZZ-style folder-encoded data was already covered in the prior slice). This pass focuses on what's in the wild outside structured trees.

## Pattern set

Initial regex battery, case-insensitive, word-boundary anchored where it makes sense:

| Name | Regex | Owner | Notes |
|---|---|---|---|
| `apple_820` | `820-\d{4,5}(?:-[A-Z])?` | Apple | 4- and 5-digit codes; optional revision suffix |
| `compal_la` | `LA-[A-Z]\d{3,4}[A-Z]?` | Compal | e.g. `LA-6901P`, `LA-K371P` |
| `lcfc_nm` | `NM-[A-Z]\d{3,4}` | LCFC | e.g. `NM-A251`, `NM-D862` |
| `quanta_da0` | `DA0[A-Z0-9]{8,12}` | Quanta | e.g. `DA0R09MB6H1` |
| `msi_ms` | `MS-\d{4,5}[A-Z]?\d?` | MSI | e.g. `MS-16GF1`, `MS-17K3` |
| `asus_60nr` | `60NR\d{4}[A-Z]?\d{0,4}` | ASUS internal | e.g. `60NR02A0-MB1100` (tail varies) |
| `oem_6050` | `6050[A-Z]?\d{7}` | Foxconn / generic OEM | e.g. `6050A3426501` |
| `apple_a_number` | `\bA\d{4}\b` | Apple A-number | model-level, not board-level |

Each pattern uses `re.IGNORECASE` and `re.findall()` over the bare filename (no folder path). Multiple matches per filename are recorded individually.

The pattern table is a constant in the script. Adding patterns later is a one-line addition.

## Substring-frequency catch-all

For pattern *discovery*: identify candidate ODM-style identifiers we haven't enumerated yet.

Algorithm:
1. After all matched extractions, for filenames where **zero patterns matched** OR **only `apple_a_number` matched** (the latter being a weak match — A-number alone doesn't tell us about board codes), tokenize the filename.
2. Tokenization: split on `[\s_\-./()\[\]+]+`, drop tokens shorter than 4 characters, drop tokens that are pure digits ≤ 4 chars or pure alphabetic in a stopword set (`apple`, `asus`, `acer`, `compal`, `quanta`, `lenovo`, `dell`, `hp`, `msi`, `gigabyte`, `boardview`, `bios`, `pdf`, `bin`, `rev`, `revision`, `schematic`, `motherboard`, …).
3. Count remaining tokens with `collections.Counter`. Keep top 50.
4. For each top token, log 3 sample filenames where it appeared.

This surfaces things like new ODM prefixes (`DABTU…`, `DALA0…`), Intel SSpec codes (`SR1YJ`), or family codenames (`cezanne`, `phoenix`) we might want to add later.

## DB cross-reference

For each unique extracted code per pattern (skipping `apple_a_number` since it's a model identifier):

```sql
SELECT 1 FROM boards
 WHERE board_number = ?
    OR uuid IN (SELECT board_uuid FROM board_aliases WHERE alias = ?)
 LIMIT 1
```

If the row exists → tag the code as `already_in_db`. Else → `new`.

For `apple_a_number` specifically, query `models.model_number` instead:

```sql
SELECT 1 FROM models WHERE model_number = ? LIMIT 1
```

The result of cross-reference is a per-pattern split: `{pattern: {already_in_db: N, new: M}}`.

If `boards.db` is missing or below schema-v2, the script skips the cross-reference (logs a warning, sets all codes to `unknown_db_state`).

## Algorithm summary

```python
for source_root in sources:
    for path in walk_files(source_root):
        for pattern in PATTERN_BATTERY:
            for value in pattern.findall(path.name):
                record_match(pattern, value, source_root, path)
        if no_pattern_matched(path):
            substring_corpus.add(tokenize(path.name))

# Post-pass:
for pattern, matches in matches_by_pattern.items():
    for value in unique(matches):
        cross_reference_db(value, pattern)

substring_top50 = Counter(substring_corpus).most_common(50)

write_markdown_report(...)
write_json_sidecar(...)
```

## Output

### Markdown report — `import-staging/filename-scan-<YYYY-MM-DD>.md`

```markdown
# Filename Scan — 2026-04-29

## Summary

| metric | value |
|---|---:|
| sources scanned | 3 |
| files scanned | 17,433 |
| files with at least one pattern match | 4,217 |
| total pattern matches (with duplicates) | 5,891 |
| unique board codes extracted | 1,243 |
| unique A-numbers extracted | 87 |

## Per-pattern results

### apple_820 — 612 unique codes
- already_in_db: 134 (22%)
- new: 478 (78%)
- Sample of 10 new: 820-00138, 820-00440, 820-00461, …

### compal_la — 187 unique codes
- already_in_db: 5 (3%)
- new: 182 (97%)
- Sample of 10 new: LA-6901P, LA-K371P, LA-E891P, …

[... one section per pattern ...]

## Per-source breakdown

| source | files | matches | unique codes |
|---|---:|---:|---:|
| samples/ | 305 | 412 | 156 |
| XZZ/ | 10,113 | 2,847 | 891 |
| BOARDS STUFF/ | 16,829 | 2,632 | 743 |

## Top 50 unmatched substrings

| token | count | sample filename |
|---|---:|---|
| cezanne | 47 | 203075-1_cezanne |
| DABTU14 | 31 | DABTU14MB6E0_xxxx |
| SR1YJ | 22 | SR1YJ_testpoints.jpg |
[...]
```

### JSON sidecar — `import-staging/filename-scan-<YYYY-MM-DD>.json`

```json
{
  "fetched_at": "2026-04-29T18:00:00Z",
  "sources": ["/Users/besitzer/.../samples", ...],
  "summary": {"files_scanned": 17433, "matches_total": 5891, ...},
  "per_pattern": {
    "apple_820": {
      "unique_codes": 612,
      "already_in_db": 134,
      "new": 478,
      "samples_new": ["820-00138", "820-00440", ...],
      "files_per_match_sample": {"820-00138": ["/path/...", ...]}
    },
    ...
  },
  "per_source": {...},
  "unmatched_top_substrings": [{"token": "cezanne", "count": 47, "samples": [...]}, ...]
}
```

The JSON is the machine-readable form for the next slice (importer) to consume directly. Not a `--apply` staging file — different shape — but the importer can read this to drive its own staging-write step.

## Verification

After running:

```bash
python3 scripts/scan-board-filenames.py
```

Expected order-of-magnitude (rough estimates from peeking at the source trees):

| metric | estimate |
|---|---|
| files scanned | 15,000-20,000 |
| `apple_820` unique codes | 500-1,500 |
| `compal_la` unique | 50-300 |
| `lcfc_nm` unique | 20-150 |
| `apple_a_number` unique | 50-150 |
| runtime | < 60s on local SSD |

If runtime exceeds 5 minutes, something's wrong (likely a regex catastrophic backtrack — investigate via `re.compile(..., re.DEBUG)`).

If `apple_820` "new" rate is < 5% (most codes already in DB), the importer's ROI for Apple is low — don't bother. If "new" rate is > 50%, importer is high-value.

If `compal_la` / `lcfc_nm` / etc. "new" rate is high (likely 90%+, since we have almost no non-Apple boards), the schema-NULL-model_uuid decision becomes urgent.

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| Source path not accessible | Synology Drive paused or wrong path | Log warning per source; continue with remaining sources; final report notes which sources were skipped |
| Permission denied on subtree | macOS sandbox / Spotlight indexing conflict | Catch `PermissionError`, log path to stderr, continue |
| `boards.db` missing or < v2 | Fresh checkout or wrong cwd | Skip cross-reference; report mode is "no DB context"; warn at top of report |
| Catastrophic regex backtrack | Bad pattern in battery | Each pattern compiled with timeout via `re.compile(..., re.IGNORECASE)`; on a per-filename basis the regex is applied to a string typically < 256 chars, so no realistic backtrack risk; if it happens, stderr the offending filename + pattern and continue |
| Output dir doesn't exist | `import-staging/` not yet created | Script creates `import-staging/` if missing (same as XZZ importer) |

## Future-work pointers (next sub-project, informed by this report)

The observation pass produces *signal*, not action. Once we read the report we'll know:

- **Schema decision** — does the volume of orphan board codes (no parent A-number) justify a `migrateV3` to allow `boards.model_uuid` NULL? Or do we auto-generate synthetic placeholder models? Or restrict the importer to Apple-820 only?
- **Pattern set extension** — top unmatched tokens reveal new ODM patterns we should encode (`DABTU…`, `60050…`, etc.).
- **Brand attribution strategy** — for non-Apple ODM codes, the report doesn't tell us the brand. Importer would need either (a) brand mapping from ODM-prefix to common-brand-OEMs (LA-codes appear in Acer/HP/Lenovo, NM-codes are Lenovo, MS-codes are MSI, …), (b) filename-context-based brand detection, or (c) hand-curated review per code. Choice depends on volume.
- **Online cross-reference candidates** — codes flagged "new" become inputs to vinafix.com / Badcaps lookup if we choose to scrape (separate sub-projects).

---

## Open questions for implementation plan

(none — design is locked; the implementation plan handles regex tightening on the unmatched-substring tokenizer if needed)
