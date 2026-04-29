# Filename-Scan Importer (Slice 1) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `scripts/import-filename-scan.py` — a one-shot Python tool that reads the observation-pass JSON sidecar, filters to NEW codes (per-pattern), and INSERT-OR-IGNOREs them into `boards.db` under a synthetic placeholder hierarchy (one `Unsorted` brand, 7 ODM families, 7 `(unknown — TODO: curate)` models). Boards table grows from 145 → ~3,032.

**Architecture:** Single Python script, one mode (no `--apply` — input JSON is already the staged artifact). Reads `import-staging/filename-scan-<date>.json` (positional arg). Mutates `boards.db` (default at the worktree's `Board Database/boards.db`; overridable via `--db`). Single transaction; placeholder hierarchy created find-or-create. Reuses the staging-then-apply pattern's `INSERT OR IGNORE` so re-runs are safe.

**Tech Stack:** Python 3 stdlib (`json`, `sqlite3`, `argparse`, `uuid`, `pathlib`, `unittest`). No third-party deps. Same toolchain as everything else.

**Spec:** [docs/superpowers/specs/2026-04-29-filename-scan-importer-design.md](../specs/2026-04-29-filename-scan-importer-design.md)

**Working directory:** `/Users/besitzer/Desktop/Boardviewer/.worktrees/filename-scan/`. Branch `feat/filename-scan-observation` (continues the work that produced the scanner). At the end, the importer SCRIPT lives on this branch; when actually run for real (Task 4), it points at the XZZ-migrated boards.db at `/Users/besitzer/Desktop/Boardviewer/.worktrees/wikidata-macs-import/Board Database/boards.db` via `--db`.

---

## File map

| File | Action | Responsibility |
|------|--------|----------------|
| `scripts/scan-board-filenames.py` | MODIFY | Add `new_full` per pattern + per-code first-filename map to JSON output |
| `scripts/test_scan_board_filenames.py` | MODIFY | Update integration test to assert new fields |
| `scripts/import-filename-scan.py` | CREATE | The importer — one file with all logic |
| `scripts/test_import_filename_scan.py` | CREATE | Unit + integration tests |
| `Board Database/boards.db` | MUTATE | Task 4 only, with `--db` pointing at the XZZ-migrated DB on the other worktree |

---

## Task 1: Extend observation pass — `new_full` + per-code first-filename

The importer needs (a) the *full* list of net-new codes per pattern (current JSON only has top-20 samples) and (b) one example source filename per code (for the `boards.notes` field). Both are small additions to `write_json_sidecar()`.

**Files:**
- Modify: `scripts/scan-board-filenames.py:write_json_sidecar` (and the `scan_sources` data flow if needed)
- Modify: `scripts/test_scan_board_filenames.py:TestScanIntegration.test_main_writes_both_reports` (assert new fields)

- [ ] **Step 1: Modify `scan_sources()` to capture per-code first filename**

In `scripts/scan-board-filenames.py`, find the `scan_sources()` function. The `matches` list already records `(pat_name, value, source_path, file_path)` for every match. We need to derive a per-code first-encountered filename from this list — but it's cleaner to compute it inside `write_json_sidecar()` rather than pass extra state through the pipeline.

Look at the existing JSON-writer; we'll add the new fields there in Step 2. No `scan_sources()` change needed.

- [ ] **Step 2: Update `write_json_sidecar()` to emit `new_full` + `first_filename` per code**

In `scripts/scan-board-filenames.py`, find the `write_json_sidecar` function. Locate this loop (around the per_pattern computation):

```python
for pat_name, _owner, _pat in PATTERNS:
    codes = {m[1] for m in scan_data['matches'] if m[0] == pat_name}
    files = sorted({m[3] for m in scan_data['matches'] if m[0] == pat_name})
    xref_p = xref.get(pat_name, {})
    already = sorted(xref_p.get('already_in_db', set()))
    new = sorted(xref_p.get('new', set()))
    unknown = sorted(xref_p.get('unknown_db_state', set()))
    per_pattern[pat_name] = {
        'unique_codes': len(codes),
        'file_count': len(files),
        'already_in_db_count': len(already),
        'new_count': len(new),
        'unknown_db_state_count': len(unknown),
        'samples_new': new[:20],
        'samples_already_in_db': already[:5],
    }
```

**Replace it** with this expanded version that adds two new fields per pattern:

```python
for pat_name, _owner, _pat in PATTERNS:
    codes = {m[1] for m in scan_data['matches'] if m[0] == pat_name}
    files = sorted({m[3] for m in scan_data['matches'] if m[0] == pat_name})
    xref_p = xref.get(pat_name, {})
    already = sorted(xref_p.get('already_in_db', set()))
    new = sorted(xref_p.get('new', set()))
    unknown = sorted(xref_p.get('unknown_db_state', set()))

    # First-encountered filename per code (basename only — not the full path).
    # Iterates scan_data['matches'] in original (deterministic) order;
    # setdefault keeps the FIRST match per code.
    first_filename: dict[str, str] = {}
    for m_pat, m_value, _src, m_path in scan_data['matches']:
        if m_pat == pat_name:
            first_filename.setdefault(m_value, Path(m_path).name)

    per_pattern[pat_name] = {
        'unique_codes': len(codes),
        'file_count': len(files),
        'already_in_db_count': len(already),
        'new_count': len(new),
        'unknown_db_state_count': len(unknown),
        'samples_new': new[:20],
        'samples_already_in_db': already[:5],
        # New fields for the importer:
        'new_full': new,                # full sorted list of net-new codes
        'first_filename': first_filename,  # code -> sample filename (basename)
    }
```

The `first_filename` dict has every unique code (regardless of new/already-in-db status), keyed for O(1) lookup by the importer.

- [ ] **Step 3: Update the test to assert the new fields**

In `scripts/test_scan_board_filenames.py`, find `TestScanIntegration.test_main_writes_both_reports`. After the existing assertions on `payload['per_pattern']['apple_820']['already_in_db_count']` and `['new_count']`, **append**:

```python
        # new_full has all net-new codes (not just top-20 samples)
        self.assertEqual(payload['per_pattern']['apple_820']['new_full'],
                         ['820-99999'])  # 1 new apple_820 code in fixture
        # first_filename maps each unique code to a sample filename
        self.assertIn('820-00165', payload['per_pattern']['apple_820']['first_filename'])
        self.assertEqual(
            payload['per_pattern']['apple_820']['first_filename']['820-99999'],
            '820-99999_unknown.pdf'
        )
```

- [ ] **Step 4: Run all tests**

```bash
cd /Users/besitzer/Desktop/Boardviewer/.worktrees/filename-scan && python3 scripts/test_scan_board_filenames.py 2>&1 | tail -3
```

Expected: `Ran 28 tests in <T>s — OK`. The 3 new assertions in `test_main_writes_both_reports` should pass.

If `test_main_writes_both_reports` fails because `Path` isn't imported in the script: it already is (`from pathlib import Path` is at the top of `scan-board-filenames.py`). If Python complains about `dict[str, str]` annotation, the file already has `from __future__ import annotations` so this is lazy-evaluated.

- [ ] **Step 5: Commit**

```bash
cd /Users/besitzer/Desktop/Boardviewer/.worktrees/filename-scan
git add scripts/scan-board-filenames.py scripts/test_scan_board_filenames.py
git commit -m "$(cat <<'EOF'
feat(scan): emit new_full + first_filename per pattern in JSON sidecar

The Markdown report keeps the top-20 samples_new for human eyeball;
the JSON sidecar now also carries:
  - new_full: full sorted list of net-new codes per pattern (consumed
    by the importer; up to ~1000 codes for compal_la, total payload
    grows from ~3 KB to ~50 KB — still trivial)
  - first_filename: dict {code -> first-encountered filename basename}
    so the importer can populate boards.notes with sample provenance

Tests: extend test_main_writes_both_reports with 3 new assertions.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Importer scaffold + find-or-create helpers + unit tests

**Files:**
- Create: `scripts/import-filename-scan.py`
- Create: `scripts/test_import_filename_scan.py`

- [ ] **Step 1: Create the importer script with helpers stubbed**

Create `scripts/import-filename-scan.py`:

```python
#!/usr/bin/env python3
"""
Import filename-scan observation results into boards.db under a synthetic
placeholder hierarchy.

Reads the observation-pass JSON sidecar, filters to NEW codes per pattern,
and INSERT OR IGNOREs them into the boards table under
'Unsorted/<ODM>/(unknown)' placeholder rows.

Usage:
  scripts/import-filename-scan.py import-staging/filename-scan-2026-04-29.json
  scripts/import-filename-scan.py <staging-json> --db /path/to/boards.db
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
import uuid
from pathlib import Path

# Map each importable pattern → (placeholder family name, placeholder model_number)
# under the single 'Unsorted' brand. apple_a_number deliberately excluded —
# it's a model identifier, not a board code; separate slice will handle it.
PATTERN_TO_FAMILY: dict[str, tuple[str, str]] = {
    'apple_820':  ('Apple',   '(unknown-apple)'),
    'compal_la':  ('Compal',  '(unknown-compal)'),
    'lcfc_nm':    ('LCFC',    '(unknown-lcfc)'),
    'quanta_da0': ('Quanta',  '(unknown-quanta)'),
    'msi_ms':     ('MSI',     '(unknown-msi)'),
    'asus_60nr':  ('ASUS',    '(unknown-asus)'),
    'oem_6050':   ('Foxconn', '(unknown-foxconn)'),
}

PLACEHOLDER_BRAND = 'Unsorted'
PLACEHOLDER_MODEL_DISPLAY = '(unknown — TODO: curate)'


def find_or_create_brand(conn: sqlite3.Connection, name: str) -> str:
    """Return brand uuid, creating row if missing."""
    row = conn.execute("SELECT uuid FROM brands WHERE name = ?", (name,)).fetchone()
    if row:
        return row[0]
    new_uuid = str(uuid.uuid4())
    conn.execute("INSERT INTO brands (uuid, name) VALUES (?, ?)", (new_uuid, name))
    return new_uuid


def find_or_create_family(conn: sqlite3.Connection, brand_uuid: str, name: str) -> str:
    """Return family uuid for (brand_uuid, name), creating row if missing."""
    row = conn.execute(
        "SELECT uuid FROM families WHERE brand_uuid = ? AND name = ?",
        (brand_uuid, name),
    ).fetchone()
    if row:
        return row[0]
    new_uuid = str(uuid.uuid4())
    conn.execute(
        "INSERT INTO families (uuid, brand_uuid, name) VALUES (?, ?, ?)",
        (new_uuid, brand_uuid, name),
    )
    return new_uuid


def find_or_create_model(conn: sqlite3.Connection, family_uuid: str,
                         model_number: str, display_name: str) -> str:
    """Return model uuid for (family_uuid, model_number), creating row if missing."""
    row = conn.execute(
        "SELECT uuid FROM models WHERE family_uuid = ? AND model_number = ?",
        (family_uuid, model_number),
    ).fetchone()
    if row:
        return row[0]
    new_uuid = str(uuid.uuid4())
    conn.execute(
        "INSERT INTO models (uuid, family_uuid, model_number, display_name) "
        "VALUES (?, ?, ?, ?)",
        (new_uuid, family_uuid, model_number, display_name),
    )
    return new_uuid


def main():
    print("Importer body not implemented yet — Task 3 fills in.", file=sys.stderr)
    return 1


if __name__ == '__main__':
    sys.exit(main())
```

- [ ] **Step 2: Create the test file with helper tests**

Create `scripts/test_import_filename_scan.py`:

```python
#!/usr/bin/env python3
"""Tests for import-filename-scan.py."""
from __future__ import annotations

import json
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from importlib.util import spec_from_file_location, module_from_spec
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SCRIPT = REPO_ROOT / 'scripts' / 'import-filename-scan.py'


def load_script():
    spec = spec_from_file_location('ifs', SCRIPT)
    m = module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


# Subset v2 schema sufficient for importer testing
V2_SCHEMA = """
PRAGMA foreign_keys=ON;
CREATE TABLE schema_version (version INTEGER NOT NULL);
INSERT INTO schema_version (version) VALUES (2);
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
CREATE TABLE boards (
    uuid TEXT PRIMARY KEY,
    model_uuid TEXT NOT NULL REFERENCES models(uuid) ON DELETE CASCADE,
    board_number TEXT NOT NULL,
    board_name TEXT,
    odm TEXT,
    board_number_type TEXT,
    source TEXT,
    source_url TEXT,
    notes TEXT,
    UNIQUE (board_number, model_uuid)
);
"""


def build_db(db_path: Path) -> str:
    """v2 fixture DB with one Apple brand + one MacBook Air family + one A1466 model.
    Returns Apple's brand_uuid."""
    conn = sqlite3.connect(db_path)
    conn.executescript(V2_SCHEMA)
    apple_uuid = '11111111-1111-4111-8111-111111111111'
    family_uuid = '22222222-2222-4222-8222-222222222222'
    model_uuid = '33333333-3333-4333-8333-333333333333'
    conn.execute("INSERT INTO brands (uuid, name) VALUES (?, ?)", (apple_uuid, 'Apple'))
    conn.execute("INSERT INTO families (uuid, brand_uuid, name) VALUES (?, ?, ?)",
                 (family_uuid, apple_uuid, 'MacBook Air'))
    conn.execute("INSERT INTO models (uuid, family_uuid, model_number, display_name) "
                 "VALUES (?, ?, ?, ?)",
                 (model_uuid, family_uuid, 'A1466', 'MacBook Air 13"'))
    conn.commit()
    conn.close()
    return apple_uuid


def run_script(args, env=None):
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args],
        capture_output=True, text=True, env=env,
    )


class TestFindOrCreate(unittest.TestCase):
    """find_or_create_{brand,family,model} are idempotent and case-strict."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.db = self.tmp / 'boards.db'
        build_db(self.db)
        self.m = load_script()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_brand_create_then_find_returns_same_uuid(self):
        with sqlite3.connect(self.db) as c:
            u1 = self.m.find_or_create_brand(c, 'Unsorted')
            u2 = self.m.find_or_create_brand(c, 'Unsorted')
            self.assertEqual(u1, u2)
            # Apple was pre-existing
            apple = self.m.find_or_create_brand(c, 'Apple')
            self.assertEqual(apple, '11111111-1111-4111-8111-111111111111')

    def test_family_within_brand_idempotent(self):
        with sqlite3.connect(self.db) as c:
            brand = self.m.find_or_create_brand(c, 'Unsorted')
            f1 = self.m.find_or_create_family(c, brand, 'Compal')
            f2 = self.m.find_or_create_family(c, brand, 'Compal')
            self.assertEqual(f1, f2)
            # Different family name yields different uuid
            f3 = self.m.find_or_create_family(c, brand, 'Quanta')
            self.assertNotEqual(f1, f3)

    def test_model_within_family_idempotent(self):
        with sqlite3.connect(self.db) as c:
            brand = self.m.find_or_create_brand(c, 'Unsorted')
            family = self.m.find_or_create_family(c, brand, 'Compal')
            m1 = self.m.find_or_create_model(c, family, '(unknown-compal)',
                                              '(unknown — TODO: curate)')
            m2 = self.m.find_or_create_model(c, family, '(unknown-compal)',
                                              'different display name')
            self.assertEqual(m1, m2)
            # display_name passed on second call is ignored when row exists
            row = c.execute("SELECT display_name FROM models WHERE uuid = ?",
                            (m1,)).fetchone()
            self.assertEqual(row[0], '(unknown — TODO: curate)')

    def test_pattern_to_family_map_covers_7_patterns(self):
        self.assertEqual(set(self.m.PATTERN_TO_FAMILY.keys()), {
            'apple_820', 'compal_la', 'lcfc_nm', 'quanta_da0',
            'msi_ms', 'asus_60nr', 'oem_6050',
        })
        # Each maps to a (family_name, model_number) tuple
        for pattern, (family, model_number) in self.m.PATTERN_TO_FAMILY.items():
            self.assertIsInstance(family, str)
            self.assertIsInstance(model_number, str)
            self.assertTrue(model_number.startswith('(unknown'),
                            f"placeholder model_number for {pattern} should start with '(unknown'")


if __name__ == '__main__':
    unittest.main()
```

- [ ] **Step 3: Make both files executable**

```bash
cd /Users/besitzer/Desktop/Boardviewer/.worktrees/filename-scan
chmod +x scripts/import-filename-scan.py scripts/test_import_filename_scan.py
```

- [ ] **Step 4: Run tests; confirm 4 helper tests pass**

```bash
cd /Users/besitzer/Desktop/Boardviewer/.worktrees/filename-scan && python3 scripts/test_import_filename_scan.py -v 2>&1 | tail -10
```

Expected: `Ran 4 tests in <T>s — OK`.

If `test_model_within_family_idempotent` fails because the second `find_or_create_model` call DOES update the display_name: the helper should NOT update; it returns the existing uuid and leaves the row untouched. The test verifies this contract.

- [ ] **Step 5: Commit**

```bash
cd /Users/besitzer/Desktop/Boardviewer/.worktrees/filename-scan
git add scripts/import-filename-scan.py scripts/test_import_filename_scan.py
git commit -m "$(cat <<'EOF'
feat(import-scan): scaffold importer + find-or-create helpers

scripts/import-filename-scan.py:
  - PATTERN_TO_FAMILY constant maps the 7 importable patterns to
    (placeholder_family, placeholder_model_number) tuples
  - find_or_create_brand / family / model: simple idempotent
    'INSERT IF NOT EXISTS, return uuid' helpers
  - main() stubbed (Task 3 fills in the import body)

Tests: 4 unit tests covering helper idempotency + PATTERN_TO_FAMILY
shape. apple_a_number explicitly NOT in the map (model-level
identifier, separate slice).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Importer body + integration tests

**Files:**
- Modify: `scripts/import-filename-scan.py` (replace `main()` stub)
- Modify: `scripts/test_import_filename_scan.py` (add `TestImporterIntegration`)

- [ ] **Step 1: Replace `main()` stub with the real import body**

In `scripts/import-filename-scan.py`, **replace the stub `main()`** with:

```python
def main():
    ap = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    ap.add_argument('staging_json', metavar='STAGING_JSON',
                    help='Path to import-staging/filename-scan-<date>.json')
    ap.add_argument('--db', metavar='PATH',
                    default=str(Path(__file__).resolve().parent.parent /
                                'Board Database' / 'boards.db'),
                    help='Path to boards.db (default: Board Database/boards.db relative to repo)')
    args = ap.parse_args()

    staging_path = Path(args.staging_json)
    db_path = Path(args.db)

    if not staging_path.exists():
        print(f"error: staging file not found: {staging_path}", file=sys.stderr)
        return 1
    if not db_path.exists():
        print(f"error: database not found: {db_path}", file=sys.stderr)
        return 1

    payload = json.loads(staging_path.read_text())

    conn = sqlite3.connect(db_path)
    try:
        # Schema-version guard
        ver_row = conn.execute(
            "SELECT version FROM schema_version LIMIT 1"
        ).fetchone()
        if not ver_row or ver_row[0] < 2:
            print("error: boards.db is below schema_version 2 — run migrate-boarddb-v2.py first",
                  file=sys.stderr)
            return 1

        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("BEGIN")

        # Find-or-create the placeholder hierarchy (1 brand + 7 families + 7 models)
        brand_uuid = find_or_create_brand(conn, PLACEHOLDER_BRAND)
        pattern_to_model_uuid: dict[str, str] = {}
        for pattern, (family_name, model_number) in PATTERN_TO_FAMILY.items():
            family_uuid = find_or_create_family(conn, brand_uuid, family_name)
            model_uuid = find_or_create_model(conn, family_uuid, model_number,
                                               PLACEHOLDER_MODEL_DISPLAY)
            pattern_to_model_uuid[pattern] = model_uuid

        # Insert boards per pattern
        inserted_per_pattern: dict[str, int] = {}
        existing_per_pattern: dict[str, int] = {}
        for pattern in PATTERN_TO_FAMILY:
            inserted_per_pattern[pattern] = 0
            existing_per_pattern[pattern] = 0
            stats = payload.get('per_pattern', {}).get(pattern, {})
            new_full = stats.get('new_full', [])
            first_filename = stats.get('first_filename', {})
            if not new_full:
                continue

            model_uuid = pattern_to_model_uuid[pattern]
            for code in new_full:
                sample = first_filename.get(code, '(unknown)')
                notes = f"filename-scan:{pattern}; sample:{sample}"
                cur = conn.execute(
                    "INSERT OR IGNORE INTO boards "
                    "(uuid, model_uuid, board_number, board_number_type, source, notes) "
                    "VALUES (?, ?, ?, ?, ?, ?)",
                    (str(uuid.uuid4()), model_uuid, code, pattern,
                     'filename-scan', notes),
                )
                if cur.rowcount > 0:
                    inserted_per_pattern[pattern] += 1
                else:
                    existing_per_pattern[pattern] += 1

        conn.commit()

        # Summary
        total_inserted = sum(inserted_per_pattern.values())
        total_existing = sum(existing_per_pattern.values())
        print(f"filename-scan import complete:")
        print(f"  {total_inserted} board(s) inserted")
        print(f"  {total_existing} board(s) skipped (already in DB)")
        print(f"  per pattern:")
        for pattern in PATTERN_TO_FAMILY:
            ins = inserted_per_pattern.get(pattern, 0)
            ex = existing_per_pattern.get(pattern, 0)
            if ins or ex:
                print(f"    {pattern}: {ins} inserted, {ex} existing")

        return 0
    except Exception as e:
        conn.rollback()
        print(f"import failed: {e}", file=sys.stderr)
        raise
    finally:
        conn.close()
```

- [ ] **Step 2: Add integration tests**

In `scripts/test_import_filename_scan.py`, **append** before the `if __name__ == '__main__'` block:

```python
class TestImporterIntegration(unittest.TestCase):
    """End-to-end: synthetic JSON + fixture DB → INSERT OR IGNORE merge."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.db = self.tmp / 'boards.db'
        build_db(self.db)
        self.staging = self.tmp / 'staging.json'

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _write_staging(self, per_pattern_data: dict):
        """per_pattern_data: {pattern: {'new_full': [...], 'first_filename': {...}}}"""
        full = {p: {} for p in [
            'apple_820', 'compal_la', 'lcfc_nm', 'quanta_da0',
            'msi_ms', 'asus_60nr', 'oem_6050', 'apple_a_number',
        ]}
        for pattern, data in per_pattern_data.items():
            full[pattern] = data
        self.staging.write_text(json.dumps({
            'fetched_at': '2026-04-29T12:00:00Z',
            'sources_scanned': ['/test'],
            'summary': {},
            'per_pattern': full,
            'per_source': {},
            'unmatched_top50': [],
        }))

    def test_inserts_new_boards_under_placeholders(self):
        self._write_staging({
            'apple_820': {
                'new_full': ['820-99001', '820-99002'],
                'first_filename': {'820-99001': 'A_test_file.brd',
                                   '820-99002': 'another.pdf'},
            },
            'compal_la': {
                'new_full': ['LA-Z999P'],
                'first_filename': {'LA-Z999P': 'compal_test.pdf'},
            },
        })
        result = run_script([str(self.staging), '--db', str(self.db)])
        self.assertEqual(result.returncode, 0,
                         f"unexpected exit: stdout={result.stdout} stderr={result.stderr}")
        self.assertIn('3 board(s) inserted', result.stdout)
        with sqlite3.connect(self.db) as c:
            # Boards landed under correct placeholders
            row = c.execute(
                "SELECT b.board_number, b.notes, b.source, b.board_number_type, "
                "       m.model_number, f.name AS family, br.name AS brand "
                "FROM boards b "
                "JOIN models m ON b.model_uuid = m.uuid "
                "JOIN families f ON m.family_uuid = f.uuid "
                "JOIN brands br ON f.brand_uuid = br.uuid "
                "WHERE b.board_number = '820-99001'"
            ).fetchone()
            self.assertEqual(row[0], '820-99001')
            self.assertEqual(row[1], 'filename-scan:apple_820; sample:A_test_file.brd')
            self.assertEqual(row[2], 'filename-scan')
            self.assertEqual(row[3], 'apple_820')
            self.assertEqual(row[4], '(unknown-apple)')
            self.assertEqual(row[5], 'Apple')
            self.assertEqual(row[6], 'Unsorted')

    def test_creates_one_brand_seven_families_seven_models(self):
        self._write_staging({
            'apple_820': {'new_full': ['820-99001'],
                          'first_filename': {'820-99001': 'a.brd'}},
        })
        result = run_script([str(self.staging), '--db', str(self.db)])
        self.assertEqual(result.returncode, 0)
        with sqlite3.connect(self.db) as c:
            # Only 1 'Unsorted' brand
            row = c.execute("SELECT count(*) FROM brands WHERE name = 'Unsorted'").fetchone()
            self.assertEqual(row[0], 1)
            # 7 families under Unsorted
            row = c.execute(
                "SELECT count(*) FROM families WHERE brand_uuid = "
                "(SELECT uuid FROM brands WHERE name = 'Unsorted')"
            ).fetchone()
            self.assertEqual(row[0], 7)
            # 7 placeholder models (one per family)
            row = c.execute(
                "SELECT count(*) FROM models WHERE family_uuid IN "
                "(SELECT uuid FROM families WHERE brand_uuid = "
                "(SELECT uuid FROM brands WHERE name = 'Unsorted'))"
            ).fetchone()
            self.assertEqual(row[0], 7)

    def test_idempotent_rerun(self):
        self._write_staging({
            'apple_820': {'new_full': ['820-99001'],
                          'first_filename': {'820-99001': 'a.brd'}},
        })
        first = run_script([str(self.staging), '--db', str(self.db)])
        self.assertEqual(first.returncode, 0)
        self.assertIn('1 board(s) inserted', first.stdout)

        second = run_script([str(self.staging), '--db', str(self.db)])
        self.assertEqual(second.returncode, 0)
        self.assertIn('0 board(s) inserted', second.stdout)
        self.assertIn('1 board(s) skipped', second.stdout)

        # Still only 1 board with that number
        with sqlite3.connect(self.db) as c:
            row = c.execute(
                "SELECT count(*) FROM boards WHERE board_number = '820-99001'"
            ).fetchone()
            self.assertEqual(row[0], 1)

    def test_apple_a_number_pattern_skipped(self):
        self._write_staging({
            'apple_a_number': {'new_full': ['A9999'],
                               'first_filename': {'A9999': 'A9999.pdf'}},
        })
        result = run_script([str(self.staging), '--db', str(self.db)])
        self.assertEqual(result.returncode, 0)
        # No board should land for A9999
        with sqlite3.connect(self.db) as c:
            row = c.execute(
                "SELECT count(*) FROM boards WHERE board_number = 'A9999'"
            ).fetchone()
            self.assertEqual(row[0], 0)

    def test_missing_staging_file_returns_1(self):
        result = run_script(['/nonexistent/staging.json', '--db', str(self.db)])
        self.assertEqual(result.returncode, 1)
        self.assertIn('staging file not found', result.stderr)

    def test_db_below_schema_v2_fails(self):
        with sqlite3.connect(self.db) as c:
            c.execute("DELETE FROM schema_version")
            c.execute("INSERT INTO schema_version (version) VALUES (1)")
            c.commit()
        self._write_staging({
            'apple_820': {'new_full': ['820-99001'],
                          'first_filename': {'820-99001': 'a.brd'}},
        })
        result = run_script([str(self.staging), '--db', str(self.db)])
        self.assertEqual(result.returncode, 1)
        self.assertIn('schema_version 2', result.stderr)

    def test_missing_first_filename_uses_unknown(self):
        # If a code lacks a sample (shouldn't happen but defensive):
        self._write_staging({
            'compal_la': {'new_full': ['LA-9999'],
                          'first_filename': {}},  # empty
        })
        result = run_script([str(self.staging), '--db', str(self.db)])
        self.assertEqual(result.returncode, 0)
        with sqlite3.connect(self.db) as c:
            row = c.execute(
                "SELECT notes FROM boards WHERE board_number = 'LA-9999'"
            ).fetchone()
            self.assertEqual(row[0], 'filename-scan:compal_la; sample:(unknown)')
```

- [ ] **Step 3: Run all tests; confirm 4 + 7 = 11 pass**

```bash
cd /Users/besitzer/Desktop/Boardviewer/.worktrees/filename-scan && python3 scripts/test_import_filename_scan.py -v 2>&1 | tail -20
```

Expected: `Ran 11 tests in <T>s — OK`.

If `test_inserts_new_boards_under_placeholders` fails on `'3 board(s) inserted'`: the substring assertion expects literal `'3 board(s) inserted'`. The summary line is `f"  {total_inserted} board(s) inserted"`. Confirm that two leading spaces are present in the print, but `assertIn` only checks substring presence so the leading whitespace doesn't matter.

If `test_idempotent_rerun` fails on `'1 board(s) skipped'`: the summary uses `total_existing = sum(existing_per_pattern.values())`. On the second run all codes are existing, so total_existing = 1. The print line is `f"  {total_existing} board(s) skipped (already in DB)"` — substring `'1 board(s) skipped'` matches.

- [ ] **Step 4: Commit**

```bash
cd /Users/besitzer/Desktop/Boardviewer/.worktrees/filename-scan
git add scripts/import-filename-scan.py scripts/test_import_filename_scan.py
git commit -m "$(cat <<'EOF'
feat(import-scan): apply with INSERT OR IGNORE under placeholders

scripts/import-filename-scan.py:
  - main() reads staging JSON, validates DB schema-v2, opens
    transaction, find-or-creates the 1 + 7 + 7 = 15-row placeholder
    hierarchy upfront, then iterates 7 patterns and INSERT OR
    IGNOREs each new code as a board with notes carrying
    'filename-scan:<pattern>; sample:<filename>'
  - apple_a_number deliberately not in PATTERN_TO_FAMILY → skipped
  - Missing staging file / missing DB / schema < v2 all exit 1
    with actionable stderr
  - Summary prints total + per-pattern counts

Tests: 7 new (insert + placeholder-creation + idempotent-rerun +
apple_a_number-skip + missing-staging-fatal + schema-too-old +
missing-first_filename-uses-(unknown)). Total 11/11 passing.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Run on real JSON + commit migrated DB

**Files:**
- Mutate: `Board Database/boards.db` on the **XZZ worktree** (the v2-migrated DB with 145 existing boards). Specifically:
  `/Users/besitzer/Desktop/Boardviewer/.worktrees/wikidata-macs-import/Board Database/boards.db`

- [ ] **Step 1: Re-run the observation pass on the XZZ worktree's DB so cross-reference reflects the latest state**

The observation-pass JSON committed previously (`fde8fa5`) was generated against this branch's main-equivalent boards.db (47 models, 66 boards). Now we want cross-reference against the **XZZ-migrated** boards.db (65 models, 145 boards) so the "already_in_db" count is accurate.

```bash
cd /Users/besitzer/Desktop/Boardviewer/.worktrees/filename-scan && \
  python3 scripts/scan-board-filenames.py \
    --db "/Users/besitzer/Desktop/Boardviewer/.worktrees/wikidata-macs-import/Board Database/boards.db" 2>&1 | tail -10
```

Expected output:
```
scanning 3 source(s) …
scanned 132,077 files; 10,606 had pattern matches
  Markdown: <...>/import-staging/filename-scan-2026-04-29.md
  JSON:     <...>/import-staging/filename-scan-2026-04-29.json
```

Compared to the snapshot already on disk, we should see slightly **lower** "new" counts for `apple_820` (since the XZZ-migrated DB has 79 more Apple boards). Other patterns (compal_la, etc.) are unchanged because XZZ Apple-laptop import was Apple-only.

- [ ] **Step 2: Backup the XZZ-migrated boards.db**

```bash
cd /Users/besitzer/Desktop/Boardviewer/.worktrees/wikidata-macs-import
cp "Board Database/boards.db" "Board Database/boards.db.pre-filename-scan-backup"
```

The backup is throwaway — deleted at Step 6 if the import succeeds.

- [ ] **Step 3: Run the importer**

```bash
cd /Users/besitzer/Desktop/Boardviewer/.worktrees/filename-scan && \
  python3 scripts/import-filename-scan.py \
    "/Users/besitzer/Desktop/Boardviewer/.worktrees/filename-scan/import-staging/filename-scan-2026-04-29.json" \
    --db "/Users/besitzer/Desktop/Boardviewer/.worktrees/wikidata-macs-import/Board Database/boards.db" 2>&1 | tail -15
```

Expected stdout:
```
filename-scan import complete:
  ~2,800 board(s) inserted
  ~30-40 board(s) skipped (already in DB)
  per pattern:
    apple_820: ~360-400 inserted, ~70 existing  (XZZ already had ~79)
    compal_la: ~1,043 inserted, ~6 existing
    lcfc_nm: ~234 inserted, ~8 existing
    quanta_da0: ~423 inserted, ~2 existing
    msi_ms: ~327 inserted, ~1 existing
    asus_60nr: ~59 inserted, 0 existing
    oem_6050: ~303 inserted, ~2 existing
```

(Counts approximate. The absolute numbers depend on whether the observation pass cross-referenced against the right DB.)

- [ ] **Step 4: Verify counts via SQL**

```bash
sqlite3 "/Users/besitzer/Desktop/Boardviewer/.worktrees/wikidata-macs-import/Board Database/boards.db" "
SELECT (SELECT count(*) FROM boards WHERE source = 'filename-scan') AS scan_boards,
       (SELECT count(*) FROM boards) AS total_boards,
       (SELECT count(*) FROM brands WHERE name = 'Unsorted') AS unsorted_brand,
       (SELECT count(*) FROM models WHERE display_name LIKE '(unknown — TODO%') AS placeholder_models,
       (SELECT count(*) FROM boards b LEFT JOIN models m ON b.model_uuid=m.uuid
        LEFT JOIN families f ON m.family_uuid=f.uuid LEFT JOIN brands br ON f.brand_uuid=br.uuid
        WHERE m.uuid IS NULL OR f.uuid IS NULL OR br.uuid IS NULL) AS orphans;
"
```

Expected:
- `scan_boards`: matches the inserted total from Step 3 (~2,800)
- `total_boards`: ~2,945 (was 145)
- `unsorted_brand`: 1
- `placeholder_models`: 7
- `orphans`: 0 (JOIN-chain integrity)

Spot-check one of the imported boards:

```bash
sqlite3 -header -column "/Users/besitzer/Desktop/Boardviewer/.worktrees/wikidata-macs-import/Board Database/boards.db" "
SELECT b.board_number, b.board_number_type, b.source, b.notes,
       m.model_number, f.name AS family, br.name AS brand
FROM boards b
JOIN models m ON b.model_uuid = m.uuid
JOIN families f ON m.family_uuid = f.uuid
JOIN brands br ON f.brand_uuid = br.uuid
WHERE b.source = 'filename-scan' AND b.board_number_type = 'compal_la'
LIMIT 3;
"
```

Expected: 3 rows with brand=`Unsorted`, family=`Compal`, model_number=`(unknown-compal)`, notes containing `filename-scan:compal_la; sample:<filename>`.

- [ ] **Step 5: Verify via the running dev server**

The dev server is up at http://localhost:8082. Click **Settings → Server / Library → Open Database Editor**. The Database Editor tree should now show:

- `Apple` (real) — with MacBook Air / Pro / etc.
- `Unsorted` (placeholder) — with 7 sub-families, each containing many boards under `(unknown — TODO: curate)`

If the editor doesn't refresh, kill the backend and restart so the new boards.db symlink picks up the mutated rows. The backend is at `/Users/besitzer/Desktop/Boardviewer/.worktrees/wikidata-macs-import/src/backend/data/boards.db` (symlinked to the mutated worktree DB), so the Go process picks up the change on next query.

- [ ] **Step 6: Delete the backup**

If Steps 4 and 5 passed:

```bash
rm "/Users/besitzer/Desktop/Boardviewer/.worktrees/wikidata-macs-import/Board Database/boards.db.pre-filename-scan-backup"
```

- [ ] **Step 7: Commit the migrated DB on the XZZ worktree**

```bash
cd /Users/besitzer/Desktop/Boardviewer/.worktrees/wikidata-macs-import
git add "Board Database/boards.db"
git ls-files "Board Database/boards.db-shm" 2>/dev/null && git add "Board Database/boards.db-shm"
git ls-files "Board Database/boards.db-wal" 2>/dev/null && git add "Board Database/boards.db-wal"
git commit -m "$(cat <<'EOF'
build(boarddb): import filename-scan codes (Slice 1) — 2.8K new boards

Ran scripts/import-filename-scan.py with the observation-pass JSON.
Boards table grew 145 → ~2,945 (~20× expansion). All ~2,800 new
rows live under a single 'Unsorted' synthetic brand with 7
ODM-named families and 7 '(unknown — TODO: curate)' placeholder
models — explicit work-queue for future curation.

Per-pattern yield (approximate, depends on cross-reference state):
  - apple_820:  ~370 inserted (XZZ already had ~79)
  - compal_la:  1,043 inserted
  - quanta_da0:   423 inserted
  - msi_ms:       327 inserted
  - oem_6050:     303 inserted
  - lcfc_nm:      234 inserted
  - asus_60nr:     59 inserted

Schema unchanged. Curation work happens via the (forthcoming)
Database Editor 'promote placeholder' UI.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Final verification

- [ ] **Step 1: All tests still green**

```bash
cd /Users/besitzer/Desktop/Boardviewer/.worktrees/filename-scan && python3 scripts/test_scan_board_filenames.py 2>&1 | tail -3
```

Expected: `Ran 28 tests` + `OK`.

```bash
cd /Users/besitzer/Desktop/Boardviewer/.worktrees/filename-scan && python3 scripts/test_import_filename_scan.py 2>&1 | tail -3
```

Expected: `Ran 11 tests` + `OK`.

- [ ] **Step 2: Confirm git history**

On the filename-scan worktree:

```bash
cd /Users/besitzer/Desktop/Boardviewer/.worktrees/filename-scan && git log --oneline 6296551..HEAD | head -10
```

Expected commits in order:
1. `feat(scan): scaffold filename scanner + pattern battery`
2. `feat(scan): DB cross-reference + unmatched-substring tokenizer`
3. `feat(scan): walk + Markdown report + JSON sidecar (full pipeline)`
4. `docs(scan): archive observation-pass snapshot 2026-04-29`
5. `feat(scan): emit new_full + first_filename per pattern in JSON sidecar`
6. `feat(import-scan): scaffold importer + find-or-create helpers`
7. `feat(import-scan): apply with INSERT OR IGNORE under placeholders`

On the XZZ worktree:

```bash
cd /Users/besitzer/Desktop/Boardviewer/.worktrees/wikidata-macs-import && git log --oneline -5
```

Top should be: `build(boarddb): import filename-scan codes (Slice 1) — 2.8K new boards`.

- [ ] **Step 3: Done — no commit needed**

Verification only.

---

## Future-work pointers (not in this plan)

- **Database Editor "promote placeholder" UI** — multi-select boards under `Unsorted/<ODM>/(unknown)`, drag/drop or bulk-edit to a real `<Brand>/<Family>/<Model>` row. UX work; significant.
- **Brand-context inference** — parse filename tokens around the board code to attribute consumer brand (e.g., `ACER C5V01 LA-E891P` → Acer). Iterative pattern + heuristic work.
- **`apple_a_number` model imports** — separate slice; A-numbers are model identifiers, need different schema treatment.
- **Online cross-reference** — vinafix.com / Badcaps lookups for high-priority codes. Each is its own research+spec+plan sub-project.
- **Pattern extension** — top unmatched substrings (`Chinafix`, `H61M`, `H81M`, `B85M`) hint at additional patterns. Iterative: add regex → re-run observation → re-run importer.
- **Branch consolidation** — at end of these slices, merge `feat/wikidata-macs-import` (XZZ) and `feat/filename-scan-observation` (scanner+importer) into a single integration branch, then to main, then release v0.16.0.
