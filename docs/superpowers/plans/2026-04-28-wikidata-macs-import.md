# Wikidata Macs Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `scripts/import-wikidata-macs.py` — a one-shot Python tool that pulls Apple Mac models from Wikidata's SPARQL endpoint, writes a reviewable JSON staging file, and (on `--apply`) merges new model rows into `Board Database/boards.db` with `INSERT OR IGNORE` semantics.

**Architecture:** Single script with two modes — default (extract → write staging) and `--apply <staging-path>` (read staging → merge to DB). Family resolution layered: prefer Wikidata `seriesLabel`, fall back to `derive_family()` imported from `migrate-boarddb-v2.py`. Year/EMC/Q-id stuffed into `models.notes` as `wikidata:Q123; year:2019; emc:3348` — schema-v3 promotes these to typed columns later. Tests use a synthetic SPARQL response fixture; only the final task hits the real Wikidata endpoint.

**Tech Stack:** Python 3 stdlib (`urllib.request`, `json`, `sqlite3`, `re`, `argparse`, `unittest`). No third-party deps. Same toolchain as `migrate-boarddb-v2.py`.

**Spec:** [docs/superpowers/specs/2026-04-28-wikidata-macs-import-design.md](../specs/2026-04-28-wikidata-macs-import-design.md)

---

## File map

| File | Action | Responsibility |
|------|--------|----------------|
| `scripts/import-wikidata-macs.py` | CREATE | The importer (extract + apply, single file) |
| `scripts/test_import_wikidata_macs.py` | CREATE | Unit tests against a synthetic fixture; mocked HTTP |
| `.gitignore` | MODIFY | Add `import-staging/` so review files never get committed |
| `Board Database/boards.db` | MUTATE | Phase B only, after the user reviews the staging JSON |
| `import-staging/` | CREATE (transient) | Generated at runtime; gitignored |

---

## Task 1: Scaffold script + family-resolution helper

**Files:**
- Create: `scripts/import-wikidata-macs.py`
- Create: `scripts/test_import_wikidata_macs.py`
- Modify: `.gitignore`

- [ ] **Step 1: Add `import-staging/` to `.gitignore`**

Open `.gitignore` and append at the end:

```
# Transient import-review staging files; never committed
import-staging/
```

(If the file already has a similar entry, leave it alone.)

- [ ] **Step 2: Create the test fixture file**

Create `scripts/test_import_wikidata_macs.py`:

```python
#!/usr/bin/env python3
"""Tests for import-wikidata-macs.py."""
from __future__ import annotations

import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

REPO_ROOT = Path(__file__).resolve().parent.parent
SCRIPT = REPO_ROOT / 'scripts' / 'import-wikidata-macs.py'

# Pre-v2 → v2 migration must already have run; we reuse the v2 schema directly
# (the same DDL the migration produces).
V2_SCHEMA = """
PRAGMA foreign_keys=ON;
CREATE TABLE schema_version (version INTEGER NOT NULL);
INSERT INTO schema_version (version) VALUES (2);
CREATE TABLE colors (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, hex TEXT, sort_order INTEGER NOT NULL DEFAULT 0);
CREATE TABLE brands (uuid TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, notes TEXT);
CREATE TABLE families (
    uuid TEXT PRIMARY KEY,
    brand_uuid TEXT NOT NULL REFERENCES brands(uuid) ON DELETE CASCADE,
    name TEXT NOT NULL,
    notes TEXT,
    UNIQUE (brand_uuid, name)
);
CREATE TABLE models (
    uuid TEXT PRIMARY KEY,
    family_uuid TEXT NOT NULL REFERENCES families(uuid) ON DELETE CASCADE,
    model_number TEXT NOT NULL,
    display_name TEXT,
    notes TEXT,
    UNIQUE (family_uuid, model_number)
);
"""


def build_db(db_path: Path) -> str:
    """Create a v2-schema fixture DB with Apple brand + an existing 'A1466' model. Returns Apple's brand_uuid."""
    conn = sqlite3.connect(db_path)
    conn.executescript(V2_SCHEMA)
    apple_uuid = '00000000-0000-4000-8000-000000000001'
    family_uuid = '00000000-0000-4000-8000-000000000002'
    conn.execute("INSERT INTO brands (uuid, name) VALUES (?, ?)", (apple_uuid, 'Apple'))
    conn.execute(
        "INSERT INTO families (uuid, brand_uuid, name) VALUES (?, ?, ?)",
        (family_uuid, apple_uuid, 'MacBook Air'),
    )
    # Pre-existing manual row that --apply must not overwrite.
    conn.execute(
        "INSERT INTO models (uuid, family_uuid, model_number, display_name, notes) VALUES (?, ?, ?, ?, ?)",
        ('00000000-0000-4000-8000-000000000003', family_uuid, 'A1466', 'MacBook Air 13" (manual)', 'manual:original'),
    )
    conn.commit()
    conn.close()
    return apple_uuid


# A synthetic SPARQL response — shape mirrors the real Wikidata SPARQL JSON
# (head/results/bindings) so the parser doesn't need a separate test for the
# wire format vs the structural test.
FIXTURE_SPARQL_RESPONSE = {
    "head": {"vars": ["item", "itemLabel", "aNumber", "emc", "year", "series", "seriesLabel"]},
    "results": {
        "bindings": [
            # 1. Direct family via seriesLabel — should land cleanly
            {
                "item":        {"type": "uri", "value": "http://www.wikidata.org/entity/Q9001"},
                "itemLabel":   {"type": "literal", "value": "MacBook Pro 16-inch (Late 2019)"},
                "aNumber":     {"type": "literal", "value": "A2141"},
                "emc":         {"type": "literal", "value": "3348"},
                "year":        {"type": "literal", "value": "2019-11-13T00:00:00Z"},
                "series":      {"type": "uri",     "value": "http://www.wikidata.org/entity/Q304108"},
                "seriesLabel": {"type": "literal", "value": "MacBook Pro"},
            },
            # 2. No seriesLabel; family resolved via derive_family() fallback on label
            {
                "item":      {"type": "uri", "value": "http://www.wikidata.org/entity/Q9002"},
                "itemLabel": {"type": "literal", "value": "iMac (Mid 2011)"},
                "aNumber":   {"type": "literal", "value": "A1311"},
                "year":      {"type": "literal", "value": "2011-05-03T00:00:00Z"},
            },
            # 3. Pre-existing model — INSERT OR IGNORE skip; manual row preserved
            {
                "item":        {"type": "uri", "value": "http://www.wikidata.org/entity/Q9003"},
                "itemLabel":   {"type": "literal", "value": "MacBook Air 13-inch Mid 2013"},
                "aNumber":     {"type": "literal", "value": "A1466"},
                "year":        {"type": "literal", "value": "2013-06-10T00:00:00Z"},
                "seriesLabel": {"type": "literal", "value": "MacBook Air"},
            },
            # 4. Model with no aNumber — staging-validation should reject without --apply
            {
                "item":      {"type": "uri", "value": "http://www.wikidata.org/entity/Q9004"},
                "itemLabel": {"type": "literal", "value": "Mystery Mac"},
                "year":      {"type": "literal", "value": "2025-01-01T00:00:00Z"},
            },
        ]
    },
}


def run_script(args, env=None):
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args],
        capture_output=True, text=True, env=env,
    )


class TestFamilyResolution(unittest.TestCase):
    """Phase A internal: resolve_family() picks the right family for each row."""

    def test_series_label_direct_match(self):
        from importlib.util import spec_from_file_location, module_from_spec
        spec = spec_from_file_location('iwm', SCRIPT)
        m = module_from_spec(spec)
        spec.loader.exec_module(m)
        # seriesLabel is canonical → use as-is
        family, matched = m.resolve_family(series_label='MacBook Pro', label='MacBook Pro 16-inch (Late 2019)')
        self.assertEqual(family, 'MacBook Pro')
        self.assertTrue(matched)

    def test_series_label_unknown_falls_back_to_label(self):
        from importlib.util import spec_from_file_location, module_from_spec
        spec = spec_from_file_location('iwm', SCRIPT)
        m = module_from_spec(spec)
        spec.loader.exec_module(m)
        # seriesLabel is a Wikidata-internal value not in our canonical list →
        # fall back to FAMILY_PATTERNS pattern matching on label.
        family, matched = m.resolve_family(series_label='Apple Inc. desktop product line',
                                            label='iMac (Mid 2011)')
        self.assertEqual(family, 'iMac')
        self.assertTrue(matched)

    def test_no_series_label_falls_back_to_label(self):
        from importlib.util import spec_from_file_location, module_from_spec
        spec = spec_from_file_location('iwm', SCRIPT)
        m = module_from_spec(spec)
        spec.loader.exec_module(m)
        family, matched = m.resolve_family(series_label=None, label='Mac mini Late 2018')
        self.assertEqual(family, 'Mac mini')
        self.assertTrue(matched)

    def test_completely_unrecognized_returns_none(self):
        from importlib.util import spec_from_file_location, module_from_spec
        spec = spec_from_file_location('iwm', SCRIPT)
        m = module_from_spec(spec)
        spec.loader.exec_module(m)
        family, matched = m.resolve_family(series_label=None, label='Xerox Alto Reissue')
        self.assertIsNone(family)
        self.assertFalse(matched)


if __name__ == '__main__':
    unittest.main()
```

- [ ] **Step 3: Create the script scaffold**

Create `scripts/import-wikidata-macs.py`:

```python
#!/usr/bin/env python3
"""
Pull Apple Mac models from Wikidata and merge into boards.db.

Two phases:
  1. EXTRACT (default): fetch SPARQL → write import-staging/wikidata-macs-<date>.json.
     Nothing touches boards.db. Reviewer eyeballs the staging file, sets
     skip:true on bad rows, edits typos, etc.
  2. APPLY (--apply <staging-file>): read staging → INSERT OR IGNORE into
     boards.db. Existing rows preserved; manual curation always wins.

Usage:
  scripts/import-wikidata-macs.py
  scripts/import-wikidata-macs.py --apply import-staging/wikidata-macs-2026-04-28.json
"""
from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

# Reuse the canonical family-pattern table from the v2 migration script. This
# is the single source of truth for family extraction. We import dynamically
# because the script filename has a hyphen (not a valid Python identifier).
def _import_migrate_module():
    from importlib.util import spec_from_file_location, module_from_spec
    here = Path(__file__).resolve().parent
    spec = spec_from_file_location('_mig', here / 'migrate-boarddb-v2.py')
    m = module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


_MIG = _import_migrate_module()
derive_family = _MIG.derive_family
FAMILY_PATTERNS = _MIG.FAMILY_PATTERNS
BRAND_FALLBACK = _MIG.BRAND_FALLBACK


# Canonical family names (the seriesLabel direct-match list). Anything outside
# these falls through to derive_family() pattern matching on the row's label.
CANONICAL_MAC_FAMILIES = {
    'MacBook', 'MacBook Air', 'MacBook Pro',
    'iMac', 'Mac mini', 'Mac Pro', 'Mac Studio',
}


def resolve_family(series_label: Optional[str], label: str) -> tuple[Optional[str], bool]:
    """Return (family_name, was_matched).

    Layered:
      1. If series_label is one of CANONICAL_MAC_FAMILIES → use it.
      2. Else fall back to derive_family('Apple', label) — pattern-matches
         on the label string (e.g., 'MacBook Pro 16-inch (Late 2019)').
      3. If derive_family returns the brand fallback ('Mac (other)' /
         'Uncategorized'), treat as no-match (None, False).
    """
    if series_label and series_label in CANONICAL_MAC_FAMILIES:
        return series_label, True
    family, matched = derive_family('Apple', label)
    if matched:
        return family, True
    return None, False


def main():
    ap = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    ap.add_argument('--apply', metavar='STAGING_FILE',
                    help='read STAGING_FILE and merge rows into boards.db')
    ap.add_argument('--db', default=str(Path(__file__).resolve().parent.parent / 'Board Database' / 'boards.db'),
                    help='path to boards.db (default: Board Database/boards.db relative to repo)')
    args = ap.parse_args()

    if args.apply:
        sys.exit(apply_staging(Path(args.apply), Path(args.db)))
    else:
        sys.exit(extract())


def extract() -> int:
    print("Phase A (extract) not yet implemented — Task 2 fills in.", file=sys.stderr)
    return 1


def apply_staging(staging_path: Path, db_path: Path) -> int:
    print("Phase B (apply) not yet implemented — Task 3 fills in.", file=sys.stderr)
    return 1


if __name__ == '__main__':
    main()
```

- [ ] **Step 4: Make both files executable**

```bash
chmod +x scripts/import-wikidata-macs.py scripts/test_import_wikidata_macs.py
```

- [ ] **Step 5: Run the test suite — confirm 4 family-resolution tests pass**

```bash
cd /Users/besitzer/Desktop/Boardviewer && python3 scripts/test_import_wikidata_macs.py -v 2>&1 | tail -15
```

Expected: `Ran 4 tests in <T>s — OK`. The four `TestFamilyResolution` tests pass because `resolve_family()` is fully implemented; the SPARQL-fetch and apply tests aren't written yet.

- [ ] **Step 6: Commit**

```bash
git add .gitignore scripts/import-wikidata-macs.py scripts/test_import_wikidata_macs.py
git commit -m "$(cat <<'EOF'
feat(import): scaffold Wikidata Macs importer + family resolver

scripts/import-wikidata-macs.py:
  - CLI scaffold with --apply flag (extract default; --apply STAGING)
  - resolve_family() — layered: canonical seriesLabel direct match,
    fallback to derive_family('Apple', label) imported from
    migrate-boarddb-v2.py (single source of truth for family patterns)
  - Phase A (extract) and Phase B (apply) stubbed; later tasks fill in

Tests: 4 unit tests for resolve_family covering direct-match,
seriesLabel-fallback, no-seriesLabel-fallback, and unrecognized rows.

.gitignore: added import-staging/ so review files never get committed.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Phase A extract — SPARQL fetch + staging file write

**Files:**
- Modify: `scripts/import-wikidata-macs.py` (replace `extract()` stub + add `parse_sparql_row` + `fetch_wikidata_macs`)
- Modify: `scripts/test_import_wikidata_macs.py` (add tests for parse_sparql_row + the extract pipeline against the FIXTURE_SPARQL_RESPONSE)

- [ ] **Step 1: Add `parse_sparql_row` + `fetch_wikidata_macs` + real `extract()` to the script**

In `scripts/import-wikidata-macs.py`, replace the `extract()` stub at the bottom with the following block. Insert just before `def main()`:

```python
WIKIDATA_SPARQL_URL = 'https://query.wikidata.org/sparql'

# Wikidata's polite-use rule requires a User-Agent identifying the client.
USER_AGENT = (
    'BoardRipper-Wikidata-Macs-Import/1.0 '
    '(https://github.com/AlexeyInwerp/BoardRipper)'
)

# SPARQL: Apple Macs with optional A-number / EMC / year / series.
# Property IDs are best-effort — implementer should validate empirically
# the first time the script runs against the live endpoint.
SPARQL_QUERY = """
SELECT ?item ?itemLabel ?aNumber ?emc ?year ?series ?seriesLabel WHERE {
  ?item wdt:P176 wd:Q312.
  ?item wdt:P31/wdt:P279* wd:Q3962655.
  OPTIONAL { ?item wdt:P3618 ?aNumber. }
  OPTIONAL { ?item wdt:P9216 ?emc. }
  OPTIONAL { ?item wdt:P571 ?year. }
  OPTIONAL { ?item wdt:P179 ?series. }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
"""


def _qid_from_uri(uri: str) -> str:
    """Strip 'http://www.wikidata.org/entity/' prefix to get bare 'Q12345'."""
    return uri.rsplit('/', 1)[-1]


def parse_sparql_row(binding: dict) -> dict:
    """Convert one SPARQL JSON binding into a staging-row dict.

    Output shape (matches spec):
      {
        wikidata_qid, family, model_number, display_name,
        year, emc, raw_label, skip
      }

    Notes:
      - 'year' is parsed from the ISO timestamp Wikidata returns (e.g.,
        '2019-11-13T00:00:00Z') down to just the integer year.
      - 'family' is resolved here so the staging file already has a best-guess;
        the reviewer can override.
      - 'skip' defaults to False.
    """
    qid = _qid_from_uri(binding['item']['value'])
    label = binding['itemLabel']['value']
    a_number = binding.get('aNumber', {}).get('value', '')
    emc = binding.get('emc', {}).get('value', '')
    year_raw = binding.get('year', {}).get('value', '')
    series_label = binding.get('seriesLabel', {}).get('value')

    year: Optional[int] = None
    if year_raw:
        m = re.match(r'^(\d{4})', year_raw)
        if m:
            year = int(m.group(1))

    family, _ = resolve_family(series_label, label)

    # display_name = label, with a light cleanup pass: strip trailing series
    # parens that just repeat the family.
    display_name = label

    return {
        'wikidata_qid': qid,
        'family': family,
        'model_number': a_number,
        'display_name': display_name,
        'year': year,
        'emc': emc or None,
        'raw_label': label,
        'skip': False,
    }


def fetch_wikidata_macs() -> dict:
    """POST the SPARQL query to Wikidata, return parsed JSON."""
    body = urllib.parse.urlencode({'query': SPARQL_QUERY, 'format': 'json'}).encode('utf-8')
    req = urllib.request.Request(
        WIKIDATA_SPARQL_URL,
        data=body,
        headers={
            'User-Agent': USER_AGENT,
            'Accept': 'application/sparql-results+json',
            'Content-Type': 'application/x-www-form-urlencoded',
        },
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode('utf-8'))


def extract() -> int:
    print('fetching Wikidata Mac models …', file=sys.stderr)
    response = fetch_wikidata_macs()
    bindings = response.get('results', {}).get('bindings', [])
    rows = [parse_sparql_row(b) for b in bindings]

    out_dir = Path(__file__).resolve().parent.parent / 'import-staging'
    out_dir.mkdir(exist_ok=True)
    today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
    out_path = out_dir / f'wikidata-macs-{today}.json'

    payload = {
        'fetched_at': datetime.now(timezone.utc).isoformat(),
        'source_query': SPARQL_QUERY.strip(),
        'row_count': len(rows),
        'rows': rows,
    }
    out_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False))

    family_counts: dict[str, int] = {}
    null_count = 0
    for r in rows:
        if r['family'] is None:
            null_count += 1
        else:
            family_counts[r['family']] = family_counts.get(r['family'], 0) + 1

    print(f"wrote {out_path} — {len(rows)} rows", file=sys.stderr)
    print(f"  family distribution: {family_counts}", file=sys.stderr)
    if null_count:
        print(f"  {null_count} row(s) without a resolved family — review manually", file=sys.stderr)
    print(f"\nReview {out_path}, then run:", file=sys.stderr)
    print(f"  scripts/import-wikidata-macs.py --apply {out_path}", file=sys.stderr)
    return 0
```

Also add `import urllib.parse` to the imports near the top of the file (just under `import urllib.request`).

- [ ] **Step 2: Add tests for parse_sparql_row + the staging-file pipeline**

Append these to `scripts/test_import_wikidata_macs.py`, before the `if __name__ == '__main__'` block:

```python
class TestParseSparqlRow(unittest.TestCase):
    """Phase A internal: each SPARQL binding maps to a well-shaped staging row."""

    @classmethod
    def setUpClass(cls):
        from importlib.util import spec_from_file_location, module_from_spec
        spec = spec_from_file_location('iwm', SCRIPT)
        cls.m = module_from_spec(spec)
        spec.loader.exec_module(cls.m)

    def test_full_row_with_series_label(self):
        binding = FIXTURE_SPARQL_RESPONSE['results']['bindings'][0]  # MacBook Pro 16
        row = self.m.parse_sparql_row(binding)
        self.assertEqual(row['wikidata_qid'], 'Q9001')
        self.assertEqual(row['family'], 'MacBook Pro')
        self.assertEqual(row['model_number'], 'A2141')
        self.assertEqual(row['display_name'], 'MacBook Pro 16-inch (Late 2019)')
        self.assertEqual(row['year'], 2019)
        self.assertEqual(row['emc'], '3348')
        self.assertEqual(row['raw_label'], 'MacBook Pro 16-inch (Late 2019)')
        self.assertFalse(row['skip'])

    def test_no_emc_no_series(self):
        binding = FIXTURE_SPARQL_RESPONSE['results']['bindings'][1]  # iMac (Mid 2011)
        row = self.m.parse_sparql_row(binding)
        self.assertEqual(row['family'], 'iMac')
        self.assertEqual(row['model_number'], 'A1311')
        self.assertEqual(row['year'], 2011)
        self.assertIsNone(row['emc'])

    def test_no_a_number_yields_empty_string(self):
        binding = FIXTURE_SPARQL_RESPONSE['results']['bindings'][3]  # Mystery Mac
        row = self.m.parse_sparql_row(binding)
        self.assertEqual(row['model_number'], '')
        self.assertIsNone(row['family'])  # 'Mystery Mac' doesn't match any pattern
        self.assertEqual(row['year'], 2025)


class TestExtractPipeline(unittest.TestCase):
    """Phase A end-to-end with mocked HTTP. Confirms the staging file is written
    in the documented shape with the correct counts."""

    @classmethod
    def setUpClass(cls):
        from importlib.util import spec_from_file_location, module_from_spec
        spec = spec_from_file_location('iwm', SCRIPT)
        cls.m = module_from_spec(spec)
        spec.loader.exec_module(cls.m)

    def test_extract_writes_staging_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            out_dir = Path(tmp) / 'import-staging'
            # Patch the staging directory location inside the module by
            # patching its __file__-derived path.
            with patch.object(self.m, 'fetch_wikidata_macs', return_value=FIXTURE_SPARQL_RESPONSE), \
                 patch.object(self.m, '__file__', str(Path(tmp) / 'scripts' / 'import-wikidata-macs.py')):
                # Make sure the parent of the patched __file__ exists so mkdir
                # finds its target.
                (Path(tmp) / 'scripts').mkdir(parents=True, exist_ok=True)
                ret = self.m.extract()
            self.assertEqual(ret, 0)
            files = list(out_dir.glob('wikidata-macs-*.json'))
            self.assertEqual(len(files), 1, 'expected exactly one staging file written')
            payload = json.loads(files[0].read_text())
            self.assertEqual(payload['row_count'], 4)
            qids = {r['wikidata_qid'] for r in payload['rows']}
            self.assertEqual(qids, {'Q9001', 'Q9002', 'Q9003', 'Q9004'})
            # Spot-check the canonical row
            mbp = next(r for r in payload['rows'] if r['wikidata_qid'] == 'Q9001')
            self.assertEqual(mbp['family'], 'MacBook Pro')
            self.assertEqual(mbp['model_number'], 'A2141')
```

- [ ] **Step 3: Run tests — confirm 4 + 3 + 1 = 8 pass**

```bash
cd /Users/besitzer/Desktop/Boardviewer && python3 scripts/test_import_wikidata_macs.py -v 2>&1 | tail -20
```

Expected: `Ran 8 tests in <T>s — OK`. All 8 pass — TestFamilyResolution (4), TestParseSparqlRow (3), TestExtractPipeline (1).

If `test_extract_writes_staging_file` fails because of `__file__`-patching subtleties, debug by inspecting where the staging file actually gets written. The test patches `__file__` so the script's own path resolution (`Path(__file__).resolve().parent.parent / 'import-staging'`) lands inside the temp dir.

- [ ] **Step 4: Commit**

```bash
git add scripts/import-wikidata-macs.py scripts/test_import_wikidata_macs.py
git commit -m "$(cat <<'EOF'
feat(import): Phase A — SPARQL fetch + staging-file write

scripts/import-wikidata-macs.py:
  - SPARQL_QUERY constant for Apple Macs (manufacturer=Q312,
    instance of subclass of Macintosh family Q3962655) with
    optional aNumber/emc/year/series properties
  - fetch_wikidata_macs(): POSTs the query with proper User-Agent
    (Wikidata politeness requirement) and parses JSON response
  - parse_sparql_row(): one binding → one staging row, with year
    parsed from ISO timestamp and family resolved layer-by-layer
  - extract(): glues fetch + parse + write to
    import-staging/wikidata-macs-<date>.json with the spec-defined
    payload shape (fetched_at, source_query, row_count, rows)

Tests: 4 new (3 parse_sparql_row + 1 extract pipeline against
FIXTURE_SPARQL_RESPONSE with mocked HTTP). Total 8/8 passing.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Phase B apply — DB merge with INSERT OR IGNORE

**Files:**
- Modify: `scripts/import-wikidata-macs.py` (replace `apply_staging()` stub with real implementation)
- Modify: `scripts/test_import_wikidata_macs.py` (add tests against a fixture DB)

- [ ] **Step 1: Replace `apply_staging()` stub with the real implementation**

In `scripts/import-wikidata-macs.py`, replace the `apply_staging()` function with:

```python
def apply_staging(staging_path: Path, db_path: Path) -> int:
    if not staging_path.exists():
        print(f"error: staging file not found: {staging_path}", file=sys.stderr)
        return 1
    if not db_path.exists():
        print(f"error: database not found: {db_path}", file=sys.stderr)
        return 1

    payload = json.loads(staging_path.read_text())
    rows = payload.get('rows', [])

    conn = sqlite3.connect(db_path)
    try:
        conn.execute("PRAGMA foreign_keys=ON")

        # Schema-version guard.
        ver_row = conn.execute(
            "SELECT version FROM schema_version LIMIT 1"
        ).fetchone()
        if not ver_row or ver_row[0] < 2:
            print("error: boards.db is below schema_version 2 — run migrate-boarddb-v2.py first",
                  file=sys.stderr)
            return 1

        # Apple brand must exist.
        apple_row = conn.execute(
            "SELECT uuid FROM brands WHERE name = 'Apple'"
        ).fetchone()
        if not apple_row:
            print("error: Apple brand not in DB — bootstrap from create_mockup_db.sql first",
                  file=sys.stderr)
            return 1
        apple_uuid = apple_row[0]

        # Validate. Any non-skipped row missing family or model_number is fatal.
        actionable: list[dict] = []
        skipped_count = 0
        for r in rows:
            if r.get('skip'):
                skipped_count += 1
                continue
            if not r.get('family'):
                print(f"error: row {r['wikidata_qid']} has no family (set skip:true or fill it in)",
                      file=sys.stderr)
                return 2
            if not r.get('model_number'):
                print(f"error: row {r['wikidata_qid']} has no model_number (set skip:true or fill it in)",
                      file=sys.stderr)
                return 2
            actionable.append(r)

        # Family cache: (brand_uuid, family_name) -> family_uuid
        family_uuids: dict[str, str] = {}
        for fam_uuid, fam_name in conn.execute(
            "SELECT uuid, name FROM families WHERE brand_uuid = ?", (apple_uuid,)
        ):
            family_uuids[fam_name] = fam_uuid

        new_families: list[str] = []
        inserted = 0
        existing = 0

        conn.execute("BEGIN")
        for r in actionable:
            family = r['family']
            if family not in family_uuids:
                new_uuid = str(uuid.uuid4())
                conn.execute(
                    "INSERT INTO families (uuid, brand_uuid, name) VALUES (?, ?, ?)",
                    (new_uuid, apple_uuid, family),
                )
                family_uuids[family] = new_uuid
                new_families.append(family)
            family_uuid = family_uuids[family]

            # Build notes string from non-null provenance fields.
            parts = [f"wikidata:{r['wikidata_qid']}"]
            if r.get('year') is not None:
                parts.append(f"year:{r['year']}")
            if r.get('emc'):
                parts.append(f"emc:{r['emc']}")
            notes = '; '.join(parts)

            cur = conn.execute(
                "INSERT OR IGNORE INTO models "
                "(uuid, family_uuid, model_number, display_name, notes) "
                "VALUES (?, ?, ?, ?, ?)",
                (str(uuid.uuid4()), family_uuid, r['model_number'], r['display_name'], notes),
            )
            if cur.rowcount > 0:
                inserted += 1
            else:
                existing += 1
        conn.commit()

        print(f"wikidata-macs apply complete:")
        print(f"  {len(rows)} rows in staging file")
        print(f"  {inserted} inserted (new models)")
        print(f"  {existing} existing (already in DB, untouched)")
        print(f"  {skipped_count} skipped (skip:true in staging)")
        if new_families:
            print(f"  new families created: {', '.join(new_families)}")

        return 1 if skipped_count > 0 else 0
    except Exception as e:
        conn.rollback()
        print(f"apply failed: {e}", file=sys.stderr)
        raise
    finally:
        conn.close()
```

- [ ] **Step 2: Add tests against a fixture DB**

Append to `scripts/test_import_wikidata_macs.py`:

```python
class TestApplyStaging(unittest.TestCase):
    """Phase B end-to-end: staging JSON + fixture DB → INSERT OR IGNORE merge."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.db = self.tmp / 'boards.db'
        build_db(self.db)
        self.staging = self.tmp / 'staging.json'

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _write_staging(self, rows: list[dict]):
        self.staging.write_text(json.dumps({
            'fetched_at': '2026-04-28T18:00:00Z',
            'source_query': 'TEST',
            'row_count': len(rows),
            'rows': rows,
        }))

    def test_inserts_new_models_skips_existing(self):
        self._write_staging([
            # New
            {'wikidata_qid': 'Q9001', 'family': 'MacBook Pro', 'model_number': 'A2141',
             'display_name': 'MacBook Pro 16-inch (Late 2019)', 'year': 2019, 'emc': '3348',
             'raw_label': 'MacBook Pro 16-inch (Late 2019)', 'skip': False},
            # Existing — manual A1466 row should be untouched
            {'wikidata_qid': 'Q9003', 'family': 'MacBook Air', 'model_number': 'A1466',
             'display_name': 'MacBook Air 13-inch Mid 2013', 'year': 2013, 'emc': None,
             'raw_label': 'MacBook Air 13-inch Mid 2013', 'skip': False},
        ])
        result = run_script(['--apply', str(self.staging), '--db', str(self.db)])
        self.assertEqual(result.returncode, 0,
                         f"unexpected exit: stdout={result.stdout} stderr={result.stderr}")
        self.assertIn('1 inserted', result.stdout)
        self.assertIn('1 existing', result.stdout)

        with sqlite3.connect(self.db) as c:
            # New row landed
            new = c.execute(
                "SELECT display_name, notes FROM models WHERE model_number = 'A2141'"
            ).fetchone()
            self.assertIsNotNone(new)
            self.assertEqual(new[0], 'MacBook Pro 16-inch (Late 2019)')
            self.assertEqual(new[1], 'wikidata:Q9001; year:2019; emc:3348')
            # Existing row preserved
            existing = c.execute(
                "SELECT display_name, notes FROM models WHERE model_number = 'A1466'"
            ).fetchone()
            self.assertEqual(existing[0], 'MacBook Air 13" (manual)')
            self.assertEqual(existing[1], 'manual:original')

    def test_skipped_rows_yield_exit_1(self):
        self._write_staging([
            {'wikidata_qid': 'Q9001', 'family': 'MacBook Pro', 'model_number': 'A2141',
             'display_name': 'X', 'year': 2019, 'emc': None,
             'raw_label': 'X', 'skip': False},
            {'wikidata_qid': 'Q9999', 'family': None, 'model_number': '',
             'display_name': 'Junk', 'year': None, 'emc': None,
             'raw_label': 'Junk', 'skip': True},
        ])
        result = run_script(['--apply', str(self.staging), '--db', str(self.db)])
        # Exit 1 signals "human review surfaced something" (skip=true)
        self.assertEqual(result.returncode, 1, f"stderr={result.stderr}")
        self.assertIn('1 skipped', result.stdout)

    def test_missing_family_is_fatal(self):
        self._write_staging([
            {'wikidata_qid': 'Q9001', 'family': None, 'model_number': 'A2141',
             'display_name': 'X', 'year': 2019, 'emc': None,
             'raw_label': 'X', 'skip': False},
        ])
        result = run_script(['--apply', str(self.staging), '--db', str(self.db)])
        self.assertEqual(result.returncode, 2)
        self.assertIn('no family', result.stderr)

    def test_missing_model_number_is_fatal(self):
        self._write_staging([
            {'wikidata_qid': 'Q9001', 'family': 'MacBook Pro', 'model_number': '',
             'display_name': 'X', 'year': 2019, 'emc': None,
             'raw_label': 'X', 'skip': False},
        ])
        result = run_script(['--apply', str(self.staging), '--db', str(self.db)])
        self.assertEqual(result.returncode, 2)
        self.assertIn('no model_number', result.stderr)

    def test_creates_new_family(self):
        self._write_staging([
            {'wikidata_qid': 'Q9001', 'family': 'Mac Studio', 'model_number': 'A2615',
             'display_name': 'Mac Studio (2022)', 'year': 2022, 'emc': None,
             'raw_label': 'Mac Studio (2022)', 'skip': False},
        ])
        result = run_script(['--apply', str(self.staging), '--db', str(self.db)])
        self.assertEqual(result.returncode, 0)
        self.assertIn('Mac Studio', result.stdout)  # mentioned in "new families created"
        with sqlite3.connect(self.db) as c:
            row = c.execute(
                "SELECT f.name FROM families f JOIN brands b ON f.brand_uuid=b.uuid "
                "WHERE b.name='Apple' AND f.name='Mac Studio'"
            ).fetchone()
            self.assertIsNotNone(row)

    def test_idempotent_rerun(self):
        rows = [{'wikidata_qid': 'Q9001', 'family': 'MacBook Pro', 'model_number': 'A2141',
                 'display_name': 'MacBook Pro 16-inch', 'year': 2019, 'emc': None,
                 'raw_label': 'X', 'skip': False}]
        self._write_staging(rows)
        first = run_script(['--apply', str(self.staging), '--db', str(self.db)])
        self.assertEqual(first.returncode, 0)
        self.assertIn('1 inserted', first.stdout)

        second = run_script(['--apply', str(self.staging), '--db', str(self.db)])
        self.assertEqual(second.returncode, 0)
        self.assertIn('0 inserted', second.stdout)
        self.assertIn('1 existing', second.stdout)

    def test_db_below_schema_v2_fails(self):
        # Wipe the schema_version to 1
        with sqlite3.connect(self.db) as c:
            c.execute("DELETE FROM schema_version")
            c.execute("INSERT INTO schema_version (version) VALUES (1)")
            c.commit()
        self._write_staging([{'wikidata_qid': 'Q1', 'family': 'MacBook Pro', 'model_number': 'A1',
                              'display_name': 'X', 'year': 2020, 'emc': None,
                              'raw_label': 'X', 'skip': False}])
        result = run_script(['--apply', str(self.staging), '--db', str(self.db)])
        self.assertEqual(result.returncode, 1)
        self.assertIn('schema_version 2', result.stderr)
```

- [ ] **Step 3: Run all tests — confirm 8 + 7 = 15 pass**

```bash
cd /Users/besitzer/Desktop/Boardviewer && python3 scripts/test_import_wikidata_macs.py -v 2>&1 | tail -25
```

Expected: `Ran 15 tests in <T>s — OK`.

If a test fails on the cur.rowcount check (the `INSERT OR IGNORE` rowcount-of-zero detection), some Python/SQLite versions report -1 instead of 0 on ignore. Adjust the check from `if cur.rowcount > 0` to `if cur.rowcount == 1`.

- [ ] **Step 4: Commit**

```bash
git add scripts/import-wikidata-macs.py scripts/test_import_wikidata_macs.py
git commit -m "$(cat <<'EOF'
feat(import): Phase B — apply staging to boards.db

scripts/import-wikidata-macs.py:
  - apply_staging(): reads staging JSON, validates, runs INSERT
    OR IGNORE for each non-skipped row inside a single transaction
  - Schema-version guard fails if boards.db is < v2
  - Apple-brand-exists guard fails with actionable message
  - Validation rejects rows with no family or no model_number
    (return 2 — distinct from skipped:true → return 1)
  - Family cache: looks up existing Apple families upfront,
    creates new ones lazily as needed (Mac Studio etc.)
  - Notes string: 'wikidata:Q123; year:2019; emc:3348' with
    null fields omitted
  - Summary: inserted / existing / skipped + new families list

Tests: 7 new (insert+skip-existing, exit-1-on-skip, missing-family,
missing-model_number, new-family-creation, idempotent-rerun,
schema-too-old). Total 15/15 passing.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Run extract against real Wikidata, review, apply

**Files:**
- Mutate: `Board Database/boards.db` (only after staging review)

This task is the human-in-the-loop step. The implementing engineer (and/or reviewer) **must not** automate past the review gate.

- [ ] **Step 1: Run extract against the live Wikidata endpoint**

```bash
cd /Users/besitzer/Desktop/Boardviewer && python3 scripts/import-wikidata-macs.py
```

Expected stderr output:
```
fetching Wikidata Mac models …
wrote /Users/besitzer/Desktop/Boardviewer/import-staging/wikidata-macs-2026-04-28.json — N rows
  family distribution: {'MacBook Pro': X, 'MacBook Air': Y, ...}
  K row(s) without a resolved family — review manually

Review .../wikidata-macs-2026-04-28.json, then run:
  scripts/import-wikidata-macs.py --apply .../wikidata-macs-2026-04-28.json
```

If the SPARQL query returns 0 rows or fails:
- Visit `https://query.wikidata.org/embed.html` and paste the `SPARQL_QUERY` constant content. Run it interactively to confirm the query is valid.
- If `P3618` (Apple model identifier) doesn't exist or returns nothing, find the current Wikidata property for "Apple model identifier" by searching `https://www.wikidata.org/wiki/Property:` and update `SPARQL_QUERY` accordingly. Recommit if changed.

If 429 (rate limit) on retry, wait 60 seconds and try again.

- [ ] **Step 2: Review the staging file**

Open `import-staging/wikidata-macs-<today>.json` in an editor. For each row, eyeball:
- Is `family` correct? (Common Wikidata oddity: `seriesLabel` says "Apple Mac line" or similar non-canonical string.) If wrong, edit the `family` field.
- Is `model_number` an actual A-number (`A1466`, `A2141`, …)? If empty or junk, set `skip: true`.
- Is `display_name` reasonable for UI? Edit if cluttered.
- Are there obvious duplicates (same A-number twice from different Wikidata items)? Set the duplicate's `skip: true`.

Report back what you found before proceeding to Step 3. (If running automated, exit and let the user manually review.)

- [ ] **Step 3: Apply (only after review passes)**

```bash
cd /Users/besitzer/Desktop/Boardviewer && python3 scripts/import-wikidata-macs.py \
  --apply import-staging/wikidata-macs-<today>.json
```

Replace `<today>` with the actual date in the filename.

Expected stdout:
```
wikidata-macs apply complete:
  N rows in staging file
  X inserted (new models)
  Y existing (already in DB, untouched)
  Z skipped (skip:true in staging)
  new families created: <list-or-empty>
```

- [ ] **Step 4: Verify counts**

Run:

```bash
sqlite3 "Board Database/boards.db" "
SELECT (SELECT count(*) FROM models WHERE notes LIKE 'wikidata:%') AS wikidata_models,
       (SELECT count(*) FROM models) AS total_models,
       (SELECT count(*) FROM families WHERE brand_uuid IN (SELECT uuid FROM brands WHERE name='Apple')) AS apple_families;
"
```

Expected: `wikidata_models` matches the "X inserted" from the apply step. `apple_families` >= 7 (the canonical Mac families).

Spot-check a known model:

```bash
sqlite3 -header -column "Board Database/boards.db" "
SELECT m.model_number, m.display_name, f.name AS family, m.notes
FROM models m
JOIN families f ON m.family_uuid = f.uuid
WHERE m.model_number = 'A2141'
LIMIT 1;
"
```

Expected: A2141 / MacBook Pro 16-inch (Late 2019) / MacBook Pro / `wikidata:Q…; year:2019; emc:…`.

- [ ] **Step 5: JOIN-chain integrity**

```bash
sqlite3 "Board Database/boards.db" "
SELECT count(*) FROM models m
LEFT JOIN families f ON m.family_uuid = f.uuid
WHERE f.uuid IS NULL;
"
```

Expected: `0`.

- [ ] **Step 6: Commit the migrated DB + staging file as a record**

The `import-staging/` directory is gitignored — by design — but for this initial run, save a copy of the staging file as a permanent record in the spec directory:

```bash
cp import-staging/wikidata-macs-<today>.json docs/superpowers/specs/wikidata-macs-staging-<today>.json
git add "Board Database/boards.db" docs/superpowers/specs/wikidata-macs-staging-<today>.json
git ls-files "Board Database/boards.db-shm" 2>/dev/null && git add "Board Database/boards.db-shm"
git ls-files "Board Database/boards.db-wal" 2>/dev/null && git add "Board Database/boards.db-wal"
git commit -m "$(cat <<'EOF'
build(boarddb): import Wikidata Macs (Slice 1)

Ran scripts/import-wikidata-macs.py against the live Wikidata
SPARQL endpoint, reviewed the staging file, applied to boards.db.

Models grew from <pre-count> to <post-count>. <N> new families
created where missing (e.g., Mac Studio if not yet in the seed).

Snapshot of the staging file included for record-keeping:
docs/superpowers/specs/wikidata-macs-staging-<today>.json

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

Replace `<pre-count>`, `<post-count>`, `<N>`, `<today>` with actual values.

---

## Task 5: Final verification

- [ ] **Step 1: Confirm all tests still pass**

```bash
cd /Users/besitzer/Desktop/Boardviewer && python3 scripts/test_import_wikidata_macs.py 2>&1 | tail -3
```

Expected: `Ran 15 tests` + `OK`.

- [ ] **Step 2: Confirm git history**

```bash
git log --oneline -8
```

Expected commits in order (oldest to newest):
1. `feat(import): scaffold Wikidata Macs importer + family resolver`
2. `feat(import): Phase A — SPARQL fetch + staging-file write`
3. `feat(import): Phase B — apply staging to boards.db`
4. `build(boarddb): import Wikidata Macs (Slice 1)`

(4 commits.)

- [ ] **Step 3: Confirm Database Editor shows the new models**

Restart the dev backend (so the read-only `boards.db` connection picks up the mutated DB). Visit the Database Editor in the running BoardRipper. Apple should now have ~7 families with substantive model lists (vs the sparse 3 families × few models before).

- [ ] **Step 4: Done — no commit needed**

Verification only.

---

## Future-work pointers (not in this plan)

- **Schema-v3 migration** — promotes `models.year`, `models.emc`, `models.source` from notes-field encoding to typed columns. Worth doing once the data shape has been validated empirically (this slice is that validation).
- **Slice 1B — iPhone / iPad / Watch / AirPods.** Same script structure, different SPARQL filter. Adapt the `instance of` constraint (e.g., `Q3502066` for iPhone family) and the `CANONICAL_MAC_FAMILIES` list (rename and broaden).
- **Slice 2 — logi.wiki backend → 820-NNNNN board codes.** Uses MediaWiki API via the user's backend access; matches each board page to an A-number that's now in the models table from Slice 1; inserts as `boards` rows.
- **devicedb.xyz cross-brand import.** Different script (`scripts/import-devicedb.py`), same staging-then-apply pattern, source prefix in notes (`devicedb:N12345`).

The staging-then-apply pattern is the durable shape; each new source bolts on.
