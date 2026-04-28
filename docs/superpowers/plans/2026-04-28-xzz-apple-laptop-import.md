# XZZ Apple Laptop Skeleton Import — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `scripts/import-xzz-apple-laptops.py` — a half-automated importer that walks the user's local XZZ Synology Drive folder, regex-extracts `(A-number, board_number, codename)` triples from folder names, writes a reviewable staging JSON, and (on `--apply`) merges new model + board rows into `Board Database/boards.db` via `INSERT OR IGNORE`. Family per A-number is the only field requiring human curation.

**Architecture:** Single Python script with two modes — default (filesystem walk → staging JSON) and `--apply <path>` (read staging → merge to DB). Reuses the proven staging-then-apply pattern from the (retired) Wikidata path. Tests use a synthetic XZZ-shaped folder fixture built programmatically in `setUp()` — no real-NAS dependency.

**Tech Stack:** Python 3 stdlib (`os`, `pathlib`, `re`, `json`, `sqlite3`, `argparse`, `unittest`). No third-party deps. Same toolchain as `migrate-boarddb-v2.py`.

**Spec:** [docs/superpowers/specs/2026-04-28-xzz-apple-laptop-import-design.md](../specs/2026-04-28-xzz-apple-laptop-import-design.md)

**Working directory:** `/Users/besitzer/Desktop/Boardviewer/.worktrees/wikidata-macs-import/`. Branch `feat/wikidata-macs-import` is reused (will get a more accurate name when the branch lands on main; renaming mid-stream just complicates things). Branch currently has 3 commits ahead of main implementing the dead-end Wikidata path; Task 1 deletes those files.

---

## File map

| File | Action | Responsibility |
|------|--------|----------------|
| `scripts/import-wikidata-macs.py` | DELETE | Dead-end Wikidata importer; Wikidata coverage is line-level only, useless for skeleton |
| `scripts/test_import_wikidata_macs.py` | DELETE | Tests for the deleted script |
| `import-staging/wikidata-macs-2026-04-28.json` | DELETE | The 0-row staging file from the failed live extract |
| `scripts/import-xzz-apple-laptops.py` | CREATE | The XZZ importer (extract + apply, single file) |
| `scripts/test_import_xzz_apple_laptops.py` | CREATE | Unit tests against a programmatic fixture; no real-NAS access |
| `Board Database/boards.db` | MUTATE | Phase B only, after the user reviews the staging JSON |

---

## Task 1: Retire Wikidata script + scaffold XZZ script + parser tests

**Files:**
- Delete: `scripts/import-wikidata-macs.py`
- Delete: `scripts/test_import_wikidata_macs.py`
- Delete: `import-staging/wikidata-macs-2026-04-28.json` (and any `import-staging/` folder if empty)
- Create: `scripts/import-xzz-apple-laptops.py`
- Create: `scripts/test_import_xzz_apple_laptops.py`

- [ ] **Step 1: Delete the Wikidata files**

```bash
cd /Users/besitzer/Desktop/Boardviewer/.worktrees/wikidata-macs-import
git rm scripts/import-wikidata-macs.py scripts/test_import_wikidata_macs.py
rm -rf import-staging/
```

`import-staging/` is gitignored, so the staging JSON inside isn't tracked — `rm -rf` cleans it up. The directory will be re-created on first `extract()` run.

- [ ] **Step 2: Create the script scaffold with the folder-name parser**

Create `scripts/import-xzz-apple-laptops.py`:

```python
#!/usr/bin/env python3
"""
Walk the user's local XZZ Synology Drive Apple-laptop folder, extract
A-number/board-code linkage from folder names, and merge into boards.db.

Two phases:
  1. EXTRACT (default): scan filesystem → write
     import-staging/xzz-apple-laptops-<date>.json. Nothing touches
     boards.db. Reviewer eyeballs the staging file, fills in 'family'
     per A-number (the only manual field), sets skip:true on bad rows.
  2. APPLY (--apply <staging-file>): read staging → INSERT OR IGNORE
     into boards.db. Existing rows preserved; manual curation always wins.

Usage:
  scripts/import-xzz-apple-laptops.py
  scripts/import-xzz-apple-laptops.py --xzz-root /path/to/XZZ/Computers/1\\ Laptop/APPLE
  scripts/import-xzz-apple-laptops.py --apply import-staging/xzz-apple-laptops-2026-04-28.json
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

DEFAULT_XZZ_ROOT = Path(
    '/Users/besitzer/Library/CloudStorage/SynologyDrive-Mac/'
    'XZZ/Computers/1 Laptop/APPLE'
)

# Buckets are folders named A<digits>xx — e.g., A12xx, A14xx, A22xx.
BUCKET_RE = re.compile(r'^A\d+xx$')

# Each individual board folder begins with the A-number, then either
# underscore or space, then the 820-NNNN(N) board code (4 or 5 digits)
# with optional revision suffix (-A through -Z), then optional trailing
# context (codename like J113, year hints in parens, etc.).
ENTRY_RE = re.compile(r'^(A\d{4})[_ ](820-\d+(?:-[A-Z])?)(.*)$')

# Codename pattern (J followed by 1–3 digits) found in the trailing text.
CODENAME_RE = re.compile(r'\b(J\d{1,3})\b')

# Year hint pattern: any 4-digit year inside parens.
YEAR_HINT_RE = re.compile(r'\((?:[^)]*?)(\d{4})(?:[^)]*?)\)')

# Canonical Apple laptop families. Phase B reviewer must pick one of these
# (or the catch-all 'MacBook (other)') for each unique A-number.
CANONICAL_LAPTOP_FAMILIES = {
    'MacBook Pro', 'MacBook Air', 'MacBook', 'MacBook (other)',
}


def parse_folder_name(name: str) -> Optional[dict]:
    """Parse one board-folder name into structured fields, or None if it doesn't match.

    Examples:
      'A1466_820-00165 J113'              -> {a_number, board_number, codename='J113', year_hint=None}
      'A1419 820-00292(At the end of 2015)' -> {a_number, board_number, codename=None, year_hint='2015'}
      '0 A14xx Repair Case'               -> None  (regex doesn't match)
    """
    m = ENTRY_RE.match(name)
    if not m:
        return None
    a_number, board_number, trailer = m.groups()
    cm = CODENAME_RE.search(trailer)
    ym = YEAR_HINT_RE.search(trailer)
    return {
        'a_number': a_number,
        'board_number': board_number,
        'codename': cm.group(1) if cm else None,
        'year_hint': ym.group(1) if ym else None,
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    ap.add_argument('--apply', metavar='STAGING_FILE',
                    help='read STAGING_FILE and merge rows into boards.db')
    ap.add_argument('--xzz-root', metavar='PATH', default=str(DEFAULT_XZZ_ROOT),
                    help='path to XZZ Apple-laptop folder root '
                         '(default: ~/Library/CloudStorage/SynologyDrive-Mac/XZZ/...)')
    ap.add_argument('--db', default=str(Path(__file__).resolve().parent.parent / 'Board Database' / 'boards.db'),
                    help='path to boards.db (default: Board Database/boards.db relative to repo)')
    args = ap.parse_args()

    if args.apply:
        sys.exit(apply_staging(Path(args.apply), Path(args.db)))
    else:
        sys.exit(extract(Path(args.xzz_root)))


def extract(xzz_root: Path) -> int:
    print("Phase A (extract) not yet implemented — Task 2 fills in.", file=sys.stderr)
    return 1


def apply_staging(staging_path: Path, db_path: Path) -> int:
    print("Phase B (apply) not yet implemented — Task 3 fills in.", file=sys.stderr)
    return 1


if __name__ == '__main__':
    main()
```

- [ ] **Step 3: Create the test file with parser tests**

Create `scripts/test_import_xzz_apple_laptops.py`:

```python
#!/usr/bin/env python3
"""Tests for import-xzz-apple-laptops.py."""
from __future__ import annotations

import json
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from importlib.util import spec_from_file_location, module_from_spec

REPO_ROOT = Path(__file__).resolve().parent.parent
SCRIPT = REPO_ROOT / 'scripts' / 'import-xzz-apple-laptops.py'


def load_script():
    spec = spec_from_file_location('ixzz', SCRIPT)
    m = module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


# Pre-v2 → v2 schema (same as boards.db v2 — see migrate-boarddb-v2.py)
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
    """v2 fixture DB with Apple brand + a 'MacBook Air' family + a manual A1466 model.
    Returns Apple's brand_uuid."""
    conn = sqlite3.connect(db_path)
    conn.executescript(V2_SCHEMA)
    apple_uuid = '00000000-0000-4000-8000-000000000001'
    family_uuid = '00000000-0000-4000-8000-000000000002'
    model_uuid = '00000000-0000-4000-8000-000000000003'
    conn.execute("INSERT INTO brands (uuid, name) VALUES (?, ?)", (apple_uuid, 'Apple'))
    conn.execute(
        "INSERT INTO families (uuid, brand_uuid, name) VALUES (?, ?, ?)",
        (family_uuid, apple_uuid, 'MacBook Air'),
    )
    # Pre-existing manual model
    conn.execute(
        "INSERT INTO models (uuid, family_uuid, model_number, display_name, notes) "
        "VALUES (?, ?, ?, ?, ?)",
        (model_uuid, family_uuid, 'A1466', 'MacBook Air 13" (manual)', 'manual:original'),
    )
    conn.commit()
    conn.close()
    return apple_uuid


def build_xzz_fixture(root: Path):
    """Create a synthetic XZZ-shape folder tree for testing extraction.
    Mirrors observed real folder structure: bucket folders + entry folders.
    """
    # Buckets that match BUCKET_RE
    a14xx = root / 'A14xx'
    a22xx = root / 'A22xx'
    a14xx.mkdir(parents=True)
    a22xx.mkdir(parents=True)
    # Entry folders inside A14xx
    (a14xx / 'A1466_820-00165 J113').mkdir()
    (a14xx / 'A1466 820-3209 J13').mkdir()           # space-separated; older 4-digit code
    (a14xx / 'A1419 820-00292(At the end of 2015)').mkdir()
    (a14xx / '0 A14xx Repair Case').mkdir()           # IGNORE — doesn't match ENTRY_RE
    # Entry folders inside A22xx
    (a22xx / 'A2141_820-02141').mkdir()              # no codename, no year hint
    # Top-level non-bucket folders that should be skipped
    (root / 'Old model').mkdir()
    (root / 'Power on sequence').mkdir()
    (root / '0 A12xx Repair Case').mkdir()


def run_script(args, env=None):
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args],
        capture_output=True, text=True, env=env,
    )


class TestParseFolderName(unittest.TestCase):
    """Phase A internal: each XZZ folder name maps to a structured row, or None."""

    @classmethod
    def setUpClass(cls):
        cls.m = load_script()

    def test_underscore_separator_with_codename(self):
        r = self.m.parse_folder_name('A1466_820-00165 J113')
        self.assertEqual(r, {
            'a_number': 'A1466', 'board_number': '820-00165',
            'codename': 'J113', 'year_hint': None,
        })

    def test_space_separator_short_board_number(self):
        r = self.m.parse_folder_name('A1466 820-3209 J13')
        self.assertEqual(r, {
            'a_number': 'A1466', 'board_number': '820-3209',
            'codename': 'J13', 'year_hint': None,
        })

    def test_year_hint_in_parens(self):
        r = self.m.parse_folder_name('A1419 820-00292(At the end of 2015)')
        self.assertEqual(r, {
            'a_number': 'A1419', 'board_number': '820-00292',
            'codename': None, 'year_hint': '2015',
        })

    def test_revision_suffix(self):
        r = self.m.parse_folder_name('A1418_820-00431-A')
        self.assertEqual(r['board_number'], '820-00431-A')
        self.assertEqual(r['a_number'], 'A1418')

    def test_no_codename_no_year(self):
        r = self.m.parse_folder_name('A2141_820-02141')
        self.assertEqual(r, {
            'a_number': 'A2141', 'board_number': '820-02141',
            'codename': None, 'year_hint': None,
        })

    def test_repair_case_returns_none(self):
        self.assertIsNone(self.m.parse_folder_name('0 A14xx Repair Case'))

    def test_unrelated_folder_returns_none(self):
        self.assertIsNone(self.m.parse_folder_name('Old model'))
        self.assertIsNone(self.m.parse_folder_name('Power on sequence'))


if __name__ == '__main__':
    unittest.main()
```

- [ ] **Step 4: Make both files executable**

```bash
chmod +x scripts/import-xzz-apple-laptops.py scripts/test_import_xzz_apple_laptops.py
```

- [ ] **Step 5: Run the test suite — confirm 7 parser tests pass**

```bash
cd /Users/besitzer/Desktop/Boardviewer/.worktrees/wikidata-macs-import && python3 scripts/test_import_xzz_apple_laptops.py -v 2>&1 | tail -15
```

Expected: `Ran 7 tests in <T>s — OK`. The 7 `TestParseFolderName` tests pass; `extract()` and `apply_staging()` are stubs filled in by Tasks 2 and 3.

If `test_year_hint_in_parens` fails:
- The `YEAR_HINT_RE` is `r'\((?:[^)]*?)(\d{4})(?:[^)]*?)\)'`. Make sure it doesn't get confused by other digits inside the parens. The lazy `*?` quantifiers should handle this; if a future fixture has `(2015 release at end of 2014)`, the test should be revised to assert which year wins (currently it'll grab the first 4-digit run inside parens).

If `test_revision_suffix` fails:
- The `ENTRY_RE` group 2 is `(820-\d+(?:-[A-Z])?)`. Confirm it matches `820-00431-A` not `820-00431-A` minus the `-A`.

- [ ] **Step 6: Commit**

```bash
cd /Users/besitzer/Desktop/Boardviewer/.worktrees/wikidata-macs-import
git add scripts/import-xzz-apple-laptops.py scripts/test_import_xzz_apple_laptops.py
# The deletes from Step 1 are already staged via 'git rm'.
git commit -m "$(cat <<'EOF'
feat(import): scaffold XZZ Apple-laptop importer; retire Wikidata path

Wikidata's coverage of Apple devices turned out to be line-level only
(~7 entities, useless for the per-A-number skeleton). XZZ's Synology
Drive folder structure encodes A-number ↔ 820-NNNNN linkage in path
names (e.g., 'A1466_820-00165 J113'), so a single regex pass yields
fully-linked board records with no content scraping.

scripts/import-xzz-apple-laptops.py:
  - CLI scaffold with --apply / --xzz-root flags
  - parse_folder_name() — regex-extract (a_number, board_number,
    codename, year_hint) from XZZ folder names
  - BUCKET_RE filters non-bucket dirs ('Old model', 'Power on sequence',
    '0 A12xx Repair Case')
  - ENTRY_RE handles both underscore and space separators, both 4-digit
    and 5-digit board codes, and optional -A revision suffix
  - Phase A (extract) and Phase B (apply) stubbed; later tasks fill in

Tests: 7 unit tests covering separator variations, codename/year-hint
extraction, revision suffix, and rejection of repair-case / non-entry
folders.

Deletes scripts/import-wikidata-macs.py + tests + the empty staging
file from the failed Wikidata extract.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Phase A extract — filesystem walk + staging write

**Files:**
- Modify: `scripts/import-xzz-apple-laptops.py` (replace `extract()` stub)
- Modify: `scripts/test_import_xzz_apple_laptops.py` (add `TestExtractPipeline`)

- [ ] **Step 1: Replace `extract()` stub with the real walk + staging write**

In `scripts/import-xzz-apple-laptops.py`, **replace the stub `extract()`** with:

```python
def extract(xzz_root: Path) -> int:
    if not xzz_root.exists():
        print(f"error: XZZ root does not exist: {xzz_root}", file=sys.stderr)
        print("hint: Synology Drive may be paused or the path may be wrong.",
              file=sys.stderr)
        print(f"hint: pass --xzz-root <path> to override (default: {DEFAULT_XZZ_ROOT})",
              file=sys.stderr)
        return 1

    print(f"scanning {xzz_root} …", file=sys.stderr)

    boards: list[dict] = []
    a_numbers_acc: dict[str, list[str]] = {}  # a_number -> sorted list of source folders
    bucket_count = 0

    for bucket in sorted(xzz_root.iterdir()):
        if not bucket.is_dir():
            continue
        if not BUCKET_RE.match(bucket.name):
            continue
        bucket_count += 1
        for entry in sorted(bucket.iterdir()):
            if not entry.is_dir():
                continue
            parsed = parse_folder_name(entry.name)
            if parsed is None:
                continue
            boards.append({
                'a_number': parsed['a_number'],
                'board_number': parsed['board_number'],
                'codename': parsed['codename'],
                'year_hint': parsed['year_hint'],
                'source_folder': entry.name,
                'bucket': bucket.name,
                'skip': False,
            })
            a_numbers_acc.setdefault(parsed['a_number'], []).append(entry.name)

    a_number_rows = [
        {
            'a_number': a,
            'family': None,
            'display_name': None,
            'source_folders': sorted(set(folders)),
            'skip': False,
        }
        for a, folders in sorted(a_numbers_acc.items())
    ]

    out_dir = Path(__file__).resolve().parent.parent / 'import-staging'
    out_dir.mkdir(exist_ok=True)
    today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
    out_path = out_dir / f'xzz-apple-laptops-{today}.json'

    payload = {
        'fetched_at': datetime.now(timezone.utc).isoformat(),
        'source_root': str(xzz_root),
        'bucket_count': bucket_count,
        'board_count': len(boards),
        'unique_a_numbers': len(a_number_rows),
        'a_numbers': a_number_rows,
        'boards': boards,
    }
    out_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False))

    print(f"wrote {out_path}", file=sys.stderr)
    print(f"  {bucket_count} buckets scanned", file=sys.stderr)
    print(f"  {len(boards)} boards extracted, "
          f"{len(a_number_rows)} unique A-numbers", file=sys.stderr)
    print(f"\nReview {out_path} and fill in 'family' for each A-number, "
          f"then run:", file=sys.stderr)
    print(f"  scripts/import-xzz-apple-laptops.py --apply {out_path}", file=sys.stderr)
    return 0
```

- [ ] **Step 2: Add tests for the extract pipeline**

In `scripts/test_import_xzz_apple_laptops.py`, **append** before the `if __name__ == '__main__'` block:

```python
class TestExtractPipeline(unittest.TestCase):
    """Phase A end-to-end: filesystem walk + staging file write."""

    @classmethod
    def setUpClass(cls):
        cls.m = load_script()

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.xzz_root = self.tmp / 'XZZ_apple_root'
        self.xzz_root.mkdir()
        build_xzz_fixture(self.xzz_root)
        # Patch the script's __file__ so the staging dir lands in tmp.
        self._orig_file = self.m.__file__
        scripts_dir = self.tmp / 'scripts'
        scripts_dir.mkdir()
        self.m.__file__ = str(scripts_dir / 'import-xzz-apple-laptops.py')

    def tearDown(self):
        self.m.__file__ = self._orig_file
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_extract_writes_staging_file(self):
        ret = self.m.extract(self.xzz_root)
        self.assertEqual(ret, 0)
        staging_files = list((self.tmp / 'import-staging').glob('xzz-apple-laptops-*.json'))
        self.assertEqual(len(staging_files), 1)
        payload = json.loads(staging_files[0].read_text())
        self.assertEqual(payload['bucket_count'], 2)        # A14xx + A22xx
        self.assertEqual(payload['board_count'], 4)         # 4 entry folders matched
        self.assertEqual(payload['unique_a_numbers'], 3)    # A1466, A1419, A2141

    def test_extract_aggregates_a_number_source_folders(self):
        self.m.extract(self.xzz_root)
        staging_files = list((self.tmp / 'import-staging').glob('xzz-apple-laptops-*.json'))
        payload = json.loads(staging_files[0].read_text())
        a1466 = next(r for r in payload['a_numbers'] if r['a_number'] == 'A1466')
        # Both A1466 entries should be in source_folders
        self.assertEqual(set(a1466['source_folders']),
                         {'A1466_820-00165 J113', 'A1466 820-3209 J13'})

    def test_extract_skips_repair_case_and_non_bucket_dirs(self):
        self.m.extract(self.xzz_root)
        staging_files = list((self.tmp / 'import-staging').glob('xzz-apple-laptops-*.json'))
        payload = json.loads(staging_files[0].read_text())
        # 'Old model', 'Power on sequence', '0 A12xx Repair Case' should be ignored
        # '0 A14xx Repair Case' inside A14xx bucket should also be ignored
        self.assertNotIn('Old model',
                         {b['source_folder'] for b in payload['boards']})
        self.assertNotIn('Power on sequence',
                         {b['source_folder'] for b in payload['boards']})
        self.assertNotIn('0 A14xx Repair Case',
                         {b['source_folder'] for b in payload['boards']})

    def test_extract_codename_and_year_hint(self):
        self.m.extract(self.xzz_root)
        staging_files = list((self.tmp / 'import-staging').glob('xzz-apple-laptops-*.json'))
        payload = json.loads(staging_files[0].read_text())
        a1466_first = next(b for b in payload['boards']
                           if b['source_folder'] == 'A1466_820-00165 J113')
        self.assertEqual(a1466_first['codename'], 'J113')
        self.assertIsNone(a1466_first['year_hint'])
        a1419 = next(b for b in payload['boards']
                     if b['source_folder'].startswith('A1419'))
        self.assertEqual(a1419['year_hint'], '2015')

    def test_extract_missing_xzz_root_returns_1(self):
        ret = self.m.extract(Path('/nonexistent/xzz/root'))
        self.assertEqual(ret, 1)
```

- [ ] **Step 3: Run all tests — confirm 7 + 5 = 12 pass**

```bash
cd /Users/besitzer/Desktop/Boardviewer/.worktrees/wikidata-macs-import && python3 scripts/test_import_xzz_apple_laptops.py -v 2>&1 | tail -20
```

Expected: `Ran 12 tests in <T>s — OK`.

If `test_extract_writes_staging_file` fails because the staging file lands in the wrong place: the script uses `Path(__file__).resolve().parent.parent / 'import-staging'`. The test patches `self.m.__file__` to a temp path so the staging dir lands in `tmp`. If the `__file__` patch doesn't take effect (some Python versions), the staging dir might land in the real repo's `import-staging/` — visible by inspecting the test's tmpdir contents. Either way, debug by printing `self.m.__file__` before calling `extract()` to confirm.

If `test_extract_aggregates_a_number_source_folders` fails: confirm both A1466 entries (`A1466_820-00165 J113` and `A1466 820-3209 J13`) are correctly being deduplicated and sorted. The Set assertion handles ordering.

- [ ] **Step 4: Commit**

```bash
cd /Users/besitzer/Desktop/Boardviewer/.worktrees/wikidata-macs-import
git add scripts/import-xzz-apple-laptops.py scripts/test_import_xzz_apple_laptops.py
git commit -m "$(cat <<'EOF'
feat(import): Phase A — XZZ filesystem walk + staging write

scripts/import-xzz-apple-laptops.py:
  - extract() walks the XZZ root, filters via BUCKET_RE (A<digits>xx),
    parses each entry-folder name via parse_folder_name(), and emits
    a two-list staging JSON (a_numbers[] + boards[]).
  - A-number rows aggregate source_folders across multiple boards
    sharing the same A-number (e.g., A1466 has two boards).
  - Bucket count + board count + unique A-number count printed to
    stderr alongside the staging-file path.
  - Missing --xzz-root path returns 1 with hints (Synology paused,
    --xzz-root override).

Tests: 5 new (writes staging file with correct counts; aggregates
A-number source folders; skips repair-case/non-bucket dirs; extracts
codename + year_hint correctly; missing root returns 1).
Total 12/12 passing.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Phase B apply — DB merge with INSERT OR IGNORE

**Files:**
- Modify: `scripts/import-xzz-apple-laptops.py` (replace `apply_staging()` stub)
- Modify: `scripts/test_import_xzz_apple_laptops.py` (add `TestApplyStaging`)

- [ ] **Step 1: Replace `apply_staging()` stub with the real implementation**

In `scripts/import-xzz-apple-laptops.py`, **replace the stub** with:

```python
def apply_staging(staging_path: Path, db_path: Path) -> int:
    if not staging_path.exists():
        print(f"error: staging file not found: {staging_path}", file=sys.stderr)
        return 1
    if not db_path.exists():
        print(f"error: database not found: {db_path}", file=sys.stderr)
        return 1

    payload = json.loads(staging_path.read_text())
    a_number_rows = payload.get('a_numbers', [])
    board_rows = payload.get('boards', [])

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

        # Validate A-number rows. Any non-skipped row must have a canonical family.
        actionable_a: list[dict] = []
        skipped_a = 0
        for r in a_number_rows:
            if r.get('skip'):
                skipped_a += 1
                continue
            if not r.get('family'):
                print(f"error: A-number {r['a_number']} has no family "
                      f"(set skip:true or fill it in)", file=sys.stderr)
                return 2
            if r['family'] not in CANONICAL_LAPTOP_FAMILIES:
                print(f"error: A-number {r['a_number']} has invalid family "
                      f"{r['family']!r} (must be one of {sorted(CANONICAL_LAPTOP_FAMILIES)})",
                      file=sys.stderr)
                return 2
            actionable_a.append(r)

        # Validate board rows. Each must reference an A-number that's either
        # in the staging file's a_numbers (non-skipped) or already in the DB.
        actionable_b: list[dict] = []
        skipped_b = 0
        actionable_a_set = {r['a_number'] for r in actionable_a}
        for r in board_rows:
            if r.get('skip'):
                skipped_b += 1
                continue
            if not r.get('a_number'):
                print(f"error: board {r.get('board_number','?')} has no a_number",
                      file=sys.stderr)
                return 2
            if not r.get('board_number'):
                print(f"error: board entry {r.get('source_folder','?')} has no board_number",
                      file=sys.stderr)
                return 2
            actionable_b.append(r)

        # Family cache.
        family_uuids: dict[str, str] = {}
        for fam_uuid, fam_name in conn.execute(
            "SELECT uuid, name FROM families WHERE brand_uuid = ?", (apple_uuid,)
        ):
            family_uuids[fam_name] = fam_uuid

        new_families: list[str] = []
        models_inserted = 0
        models_existing = 0
        boards_inserted = 0
        boards_existing = 0

        conn.execute("BEGIN")

        # Pass 1: A-numbers → models.
        for r in actionable_a:
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

            folders = r.get('source_folders') or []
            shown = folders[:5]
            extra = len(folders) - len(shown)
            notes_folders = ','.join(shown)
            if extra > 0:
                notes_folders += f',...{extra} more'
            notes = f'xzz:{notes_folders}'
            display_name = r.get('display_name') or r['a_number']

            cur = conn.execute(
                "INSERT OR IGNORE INTO models "
                "(uuid, family_uuid, model_number, display_name, notes) "
                "VALUES (?, ?, ?, ?, ?)",
                (str(uuid.uuid4()), family_uuid, r['a_number'], display_name, notes),
            )
            if cur.rowcount > 0:
                models_inserted += 1
            else:
                models_existing += 1

        # Build a_number → model_uuid map (incl. pre-existing models).
        a_to_model: dict[str, str] = {}
        for a, model_uuid_val in conn.execute(
            """
            SELECT m.model_number, m.uuid
            FROM models m
            JOIN families f ON m.family_uuid = f.uuid
            WHERE f.brand_uuid = ?
            """, (apple_uuid,)
        ):
            a_to_model[a] = model_uuid_val

        # Pass 2: boards.
        for r in actionable_b:
            a = r['a_number']
            model_uuid_val = a_to_model.get(a)
            if model_uuid_val is None:
                # Parent A-number was skipped or doesn't exist; refuse.
                print(f"error: board {r['board_number']} references A-number {a} "
                      f"which is not in DB (was its A-number row skipped?)",
                      file=sys.stderr)
                conn.rollback()
                return 2
            board_notes_parts = [f"xzz:{r.get('source_folder','')}"]
            if r.get('codename'):
                board_notes_parts.append(f"codename:{r['codename']}")
            if r.get('year_hint'):
                board_notes_parts.append(f"year_hint:{r['year_hint']}")
            board_notes = '; '.join(board_notes_parts)

            cur = conn.execute(
                "INSERT OR IGNORE INTO boards "
                "(uuid, model_uuid, board_number, board_number_type, source, notes) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (str(uuid.uuid4()), model_uuid_val, r['board_number'],
                 'apple_820', 'xzz', board_notes),
            )
            if cur.rowcount > 0:
                boards_inserted += 1
            else:
                boards_existing += 1

        conn.commit()

        print(f"xzz-apple-laptops apply complete:")
        print(f"  {len(a_number_rows)} A-number rows in staging "
              f"({models_inserted} inserted, {models_existing} existing, "
              f"{skipped_a} skipped)")
        print(f"  {len(board_rows)} board rows in staging "
              f"({boards_inserted} inserted, {boards_existing} existing, "
              f"{skipped_b} skipped)")
        if new_families:
            print(f"  new families created: {', '.join(new_families)}")

        return 1 if (skipped_a > 0 or skipped_b > 0) else 0
    except Exception as e:
        conn.rollback()
        print(f"apply failed: {e}", file=sys.stderr)
        raise
    finally:
        conn.close()
```

- [ ] **Step 2: Add tests against fixture DB**

In `scripts/test_import_xzz_apple_laptops.py`, **append**:

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

    def _write(self, a_numbers, boards):
        self.staging.write_text(json.dumps({
            'fetched_at': '2026-04-28T20:00:00Z',
            'source_root': '/test',
            'bucket_count': 1,
            'board_count': len(boards),
            'unique_a_numbers': len(a_numbers),
            'a_numbers': a_numbers,
            'boards': boards,
        }))

    def test_inserts_new_models_and_boards_skips_existing(self):
        self._write(
            a_numbers=[
                # New
                {'a_number': 'A2141', 'family': 'MacBook Pro',
                 'display_name': 'MacBook Pro 16" 2019',
                 'source_folders': ['A2141_820-02141'], 'skip': False},
                # Already in DB (A1466 was seeded by build_db)
                {'a_number': 'A1466', 'family': 'MacBook Air',
                 'display_name': None,
                 'source_folders': ['A1466_820-00165 J113'], 'skip': False},
            ],
            boards=[
                {'a_number': 'A2141', 'board_number': '820-02141',
                 'codename': None, 'year_hint': None,
                 'source_folder': 'A2141_820-02141', 'bucket': 'A22xx', 'skip': False},
                {'a_number': 'A1466', 'board_number': '820-00165',
                 'codename': 'J113', 'year_hint': None,
                 'source_folder': 'A1466_820-00165 J113',
                 'bucket': 'A14xx', 'skip': False},
            ],
        )
        result = run_script(['--apply', str(self.staging), '--db', str(self.db)])
        self.assertEqual(result.returncode, 0,
                         f"unexpected exit: stdout={result.stdout} stderr={result.stderr}")
        self.assertIn('1 inserted, 1 existing', result.stdout)  # A-number summary
        with sqlite3.connect(self.db) as c:
            # New A2141 model created
            row = c.execute(
                "SELECT display_name, notes FROM models WHERE model_number='A2141'"
            ).fetchone()
            self.assertEqual(row[0], 'MacBook Pro 16" 2019')
            self.assertEqual(row[1], 'xzz:A2141_820-02141')
            # Existing A1466 preserved (not overwritten)
            row = c.execute(
                "SELECT display_name, notes FROM models WHERE model_number='A1466'"
            ).fetchone()
            self.assertEqual(row[0], 'MacBook Air 13" (manual)')
            self.assertEqual(row[1], 'manual:original')
            # Both boards inserted
            board = c.execute(
                "SELECT board_number, source, notes FROM boards WHERE board_number='820-02141'"
            ).fetchone()
            self.assertIsNotNone(board)
            self.assertEqual(board[1], 'xzz')
            self.assertEqual(board[2], 'xzz:A2141_820-02141')

    def test_skip_true_yields_exit_1(self):
        self._write(
            a_numbers=[
                {'a_number': 'A2141', 'family': 'MacBook Pro',
                 'display_name': None, 'source_folders': ['x'], 'skip': False},
                {'a_number': 'A9999', 'family': None,
                 'display_name': None, 'source_folders': ['x'], 'skip': True},
            ],
            boards=[
                {'a_number': 'A2141', 'board_number': '820-02141',
                 'codename': None, 'year_hint': None,
                 'source_folder': 'x', 'bucket': 'X', 'skip': False},
            ],
        )
        result = run_script(['--apply', str(self.staging), '--db', str(self.db)])
        self.assertEqual(result.returncode, 1)
        self.assertIn('1 skipped', result.stdout)

    def test_missing_family_is_fatal(self):
        self._write(
            a_numbers=[
                {'a_number': 'A2141', 'family': None,
                 'display_name': None, 'source_folders': ['x'], 'skip': False},
            ],
            boards=[],
        )
        result = run_script(['--apply', str(self.staging), '--db', str(self.db)])
        self.assertEqual(result.returncode, 2)
        self.assertIn('no family', result.stderr)

    def test_invalid_family_is_fatal(self):
        self._write(
            a_numbers=[
                {'a_number': 'A2141', 'family': 'Macbook 8K Plus',  # not in canonical set
                 'display_name': None, 'source_folders': ['x'], 'skip': False},
            ],
            boards=[],
        )
        result = run_script(['--apply', str(self.staging), '--db', str(self.db)])
        self.assertEqual(result.returncode, 2)
        self.assertIn('invalid family', result.stderr)

    def test_orphan_board_is_fatal(self):
        # Board references an A-number whose row was skipped → fatal
        self._write(
            a_numbers=[
                {'a_number': 'A2141', 'family': None,
                 'display_name': None, 'source_folders': ['x'], 'skip': True},
            ],
            boards=[
                {'a_number': 'A2141', 'board_number': '820-02141',
                 'codename': None, 'year_hint': None,
                 'source_folder': 'x', 'bucket': 'X', 'skip': False},
            ],
        )
        result = run_script(['--apply', str(self.staging), '--db', str(self.db)])
        self.assertEqual(result.returncode, 2)
        self.assertIn('not in DB', result.stderr)

    def test_creates_new_family(self):
        self._write(
            a_numbers=[
                {'a_number': 'A2141', 'family': 'MacBook Pro',
                 'display_name': None,
                 'source_folders': ['A2141_820-02141'], 'skip': False},
            ],
            boards=[],
        )
        result = run_script(['--apply', str(self.staging), '--db', str(self.db)])
        self.assertEqual(result.returncode, 0)
        self.assertIn('MacBook Pro', result.stdout)  # in "new families created" line
        with sqlite3.connect(self.db) as c:
            row = c.execute(
                "SELECT f.name FROM families f JOIN brands b ON f.brand_uuid=b.uuid "
                "WHERE b.name='Apple' AND f.name='MacBook Pro'"
            ).fetchone()
            self.assertIsNotNone(row)

    def test_idempotent_rerun(self):
        self._write(
            a_numbers=[
                {'a_number': 'A2141', 'family': 'MacBook Pro',
                 'display_name': None,
                 'source_folders': ['A2141_820-02141'], 'skip': False},
            ],
            boards=[
                {'a_number': 'A2141', 'board_number': '820-02141',
                 'codename': None, 'year_hint': None,
                 'source_folder': 'A2141_820-02141', 'bucket': 'A22xx', 'skip': False},
            ],
        )
        first = run_script(['--apply', str(self.staging), '--db', str(self.db)])
        self.assertEqual(first.returncode, 0)
        self.assertIn('1 inserted', first.stdout)
        second = run_script(['--apply', str(self.staging), '--db', str(self.db)])
        self.assertEqual(second.returncode, 0)
        # Second run: 0 inserted, 1 existing for both A-numbers and boards
        self.assertIn('0 inserted, 1 existing', second.stdout)

    def test_db_below_schema_v2_fails(self):
        with sqlite3.connect(self.db) as c:
            c.execute("DELETE FROM schema_version")
            c.execute("INSERT INTO schema_version (version) VALUES (1)")
            c.commit()
        self._write(
            a_numbers=[
                {'a_number': 'A2141', 'family': 'MacBook Pro',
                 'display_name': None, 'source_folders': ['x'], 'skip': False},
            ],
            boards=[],
        )
        result = run_script(['--apply', str(self.staging), '--db', str(self.db)])
        self.assertEqual(result.returncode, 1)
        self.assertIn('schema_version 2', result.stderr)
```

- [ ] **Step 3: Run all tests — confirm 12 + 8 = 20 pass**

```bash
cd /Users/besitzer/Desktop/Boardviewer/.worktrees/wikidata-macs-import && python3 scripts/test_import_xzz_apple_laptops.py -v 2>&1 | tail -25
```

Expected: `Ran 20 tests in <T>s — OK`.

If `test_inserts_new_models_and_boards_skips_existing` fails on the `'1 inserted, 1 existing'` substring check: the actual output uses parentheses so the substring is `1 inserted, 1 existing` inside `(... 1 inserted, 1 existing, 0 skipped)`. Adjust the assertion if formatting drifts.

If `test_orphan_board_is_fatal` fails: the apply code returns 2 when a board's A-number isn't in `actionable_a_set`-but-it-IS-in-the-DB scenario. The `a_to_model` dict is rebuilt from the DB after Pass 1; if A2141 wasn't inserted (because skip:true), it won't be in `a_to_model`. So the failure mode is correct.

- [ ] **Step 4: Commit**

```bash
cd /Users/besitzer/Desktop/Boardviewer/.worktrees/wikidata-macs-import
git add scripts/import-xzz-apple-laptops.py scripts/test_import_xzz_apple_laptops.py
git commit -m "$(cat <<'EOF'
feat(import): Phase B — apply XZZ staging to boards.db

scripts/import-xzz-apple-laptops.py:
  - apply_staging() reads two-list staging JSON (a_numbers + boards),
    validates, runs INSERT OR IGNORE inside a single transaction.
  - Pass 1: a_numbers → models. Validates 'family' is one of
    CANONICAL_LAPTOP_FAMILIES ({MacBook, MacBook Air, MacBook Pro,
    MacBook (other)}).
  - Pass 2: boards → boards table. Looks up parent A-number's
    model_uuid via a freshly-built a_to_model map (covers both newly-
    inserted and pre-existing Apple models).
  - Schema-v2 + Apple-brand existence guards.
  - Notes: 'xzz:<source_folder>; codename:Jxx; year_hint:YYYY' for
    boards; 'xzz:<comma-joined-folders, capped at 5>' for A-numbers.
  - Exit codes: 0 = clean, 1 = skipped rows surfaced, 2 = validation
    error or orphan board.

Tests: 8 new (insert+skip-existing, exit-1-on-skip, missing-family,
invalid-family, orphan-board, new-family, idempotent-rerun, schema-
too-old). Total 20/20 passing.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Run extract on real XZZ + manual review + apply

**Files:**
- Mutate: `Board Database/boards.db` (only after the user reviews staging)

This is the human-in-the-loop step. The implementing engineer **must not** automate past the review gate.

- [ ] **Step 1: Run extract against the real XZZ folder**

```bash
cd /Users/besitzer/Desktop/Boardviewer/.worktrees/wikidata-macs-import && python3 scripts/import-xzz-apple-laptops.py 2>&1 | tail -10
```

Expected stderr:
```
scanning /Users/besitzer/Library/CloudStorage/SynologyDrive-Mac/XZZ/Computers/1 Laptop/APPLE …
wrote /Users/besitzer/Desktop/Boardviewer/.worktrees/wikidata-macs-import/import-staging/xzz-apple-laptops-2026-04-28.json
  15 buckets scanned
  ~119 boards extracted, ~47 unique A-numbers
```

(Counts approximate — might be different by ±a few depending on whether new folders have been added since the spec was researched.)

If the path doesn't exist:
- Verify Synology Drive is running and synced. `ls "$DEFAULT_XZZ_ROOT"` should show the buckets.
- If the folder structure has moved, pass `--xzz-root <path>` explicitly.

If 0 boards extracted but the path exists:
- Run `ls $DEFAULT_XZZ_ROOT | head -5` to inspect bucket names.
- If the bucket-naming convention has shifted (e.g., new buckets like `M1xx` appear), update `BUCKET_RE` and re-run.

- [ ] **Step 2: Review the staging file**

Open `import-staging/xzz-apple-laptops-<today>.json` in an editor.

For each entry in `a_numbers[]`:
- Fill in `family` — must be one of `MacBook Pro`, `MacBook Air`, `MacBook`, or `MacBook (other)`.
- Open Mactracker as a visual reference: search for the A-number, see which family it belongs to.
- Optionally fill in `display_name` (e.g., `"MacBook Pro 13\" Late 2008"`). Falls back to the A-number string if left null.
- Set `skip: true` for any A-number that's wrong (false-positive regex match, non-Mac device).

For each entry in `boards[]`:
- Usually no edit needed. The folder structure already encoded the linkage.
- Set `skip: true` only for genuinely problematic entries (duplicates from naming variations, etc.).

Estimated review effort: ~25 minutes for ~47 unique A-numbers at ~30 seconds each.

**Report back to the user how many A-numbers needed manual family assignment, before proceeding to Step 3.** If running automated, exit and let the human review.

- [ ] **Step 3: Apply (only after review passes)**

```bash
cd /Users/besitzer/Desktop/Boardviewer/.worktrees/wikidata-macs-import && \
  python3 scripts/import-xzz-apple-laptops.py \
  --apply import-staging/xzz-apple-laptops-<today>.json
```

Replace `<today>` with the actual date in the filename.

Expected stdout:
```
xzz-apple-laptops apply complete:
  47 A-number rows in staging (~40 inserted, ~7 existing, 0 skipped)
  119 board rows in staging (~115 inserted, ~4 existing, 0 skipped)
  new families created: MacBook Pro, MacBook
```

(Counts approximate. The "existing" counts depend on overlap with the v2 migration's seed.)

If exit code is 1, review surfaced rows that were `skip:true` — that's expected if the user dropped any obvious typos.

If exit code is 2, validation rejected something — fix the staging JSON and re-run.

- [ ] **Step 4: Verify counts**

```bash
sqlite3 "Board Database/boards.db" "
SELECT (SELECT count(*) FROM models WHERE notes LIKE 'xzz:%') AS xzz_models,
       (SELECT count(*) FROM boards WHERE notes LIKE 'xzz:%') AS xzz_boards,
       (SELECT count(*) FROM models) AS total_models,
       (SELECT count(*) FROM boards) AS total_boards,
       (SELECT count(*) FROM families WHERE brand_uuid IN (SELECT uuid FROM brands WHERE name='Apple')) AS apple_families;
"
```

Expected: `xzz_models` matches the "inserted" count from step 3; `total_models` grew from 47 to ~85-95; `total_boards` grew from 66 to ~150-180.

Spot-check a known board:

```bash
sqlite3 -header -column "Board Database/boards.db" "
SELECT m.model_number, m.display_name, f.name AS family, b.board_number, b.notes
FROM boards b
JOIN models m ON b.model_uuid = m.uuid
JOIN families f ON m.family_uuid = f.uuid
WHERE m.model_number='A1466' AND b.board_number='820-00165';
"
```

Expected: `A1466 / MacBook Air 13" (some display name) / MacBook Air / 820-00165 / xzz:A1466_820-00165 J113; codename:J113`.

- [ ] **Step 5: Verify JOIN-chain integrity**

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

- [ ] **Step 6: Archive the staging file + commit the migrated DB**

The staging file is in gitignored `import-staging/`. Save a copy under `docs/superpowers/specs/` for record-keeping:

```bash
cp import-staging/xzz-apple-laptops-<today>.json docs/superpowers/specs/xzz-apple-laptops-staging-<today>.json
git add "Board Database/boards.db" docs/superpowers/specs/xzz-apple-laptops-staging-<today>.json
git ls-files "Board Database/boards.db-shm" 2>/dev/null && git add "Board Database/boards.db-shm"
git ls-files "Board Database/boards.db-wal" 2>/dev/null && git add "Board Database/boards.db-wal"
git commit -m "$(cat <<'EOF'
build(boarddb): import XZZ Apple laptops (Slice 1)

Ran scripts/import-xzz-apple-laptops.py against the user's XZZ
Synology Drive folder, reviewed the staging file (~25 minutes filling
in family per unique A-number with Mactracker as reference), applied
to boards.db.

Models grew <pre-models> → <post-models>. Boards grew <pre-boards>
→ <post-boards>. <N> new families created (e.g., MacBook Pro, MacBook).

Snapshot of the staging file included for record-keeping:
docs/superpowers/specs/xzz-apple-laptops-staging-<today>.json

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

Replace `<pre-models>`, `<post-models>`, `<pre-boards>`, `<post-boards>`, `<N>`, `<today>` with actual values.

---

## Task 5: Final verification

- [ ] **Step 1: Confirm all tests still pass**

```bash
cd /Users/besitzer/Desktop/Boardviewer/.worktrees/wikidata-macs-import && python3 scripts/test_import_xzz_apple_laptops.py 2>&1 | tail -3
```

Expected: `Ran 20 tests` + `OK`.

- [ ] **Step 2: Confirm Database Editor shows the new entities**

Restart the dev backend (so the read-only `boards.db` connection picks up the mutated DB):

```bash
# Find and kill the existing backend, then restart from src/backend/
lsof -i :8080 -t | xargs -r kill 2>/dev/null
sleep 1
cd /Users/besitzer/Desktop/Boardviewer/.worktrees/wikidata-macs-import/src/backend && go run . > /tmp/boardripper-backend.log 2>&1 &
```

Reload the Database Editor (Settings → Open Database Editor). Apple should now show `MacBook Air`, `MacBook Pro`, `MacBook` (and possibly `MacBook (other)`) families with substantive model + board counts vs the original sparse list.

- [ ] **Step 3: Confirm git history**

```bash
cd /Users/besitzer/Desktop/Boardviewer/.worktrees/wikidata-macs-import && git log --oneline 7d3b91c..HEAD | head -10
```

Expected commits in order (oldest to newest):
1. `feat(boarddb): scaffold v2 migration script + tests` (or similar — depends on whether prior Wikidata commits remain)
2. `feat(import): scaffold XZZ Apple-laptop importer; retire Wikidata path`
3. `feat(import): Phase A — XZZ filesystem walk + staging write`
4. `feat(import): Phase B — apply XZZ staging to boards.db`
5. `build(boarddb): import XZZ Apple laptops (Slice 1)`

(The original Wikidata commits — 83e650f, effa49d, 44ee8c7 — remain in branch history but their files are gone after Task 1's `git rm`.)

- [ ] **Step 4: Done — no commit needed**

Verification only.

---

## Future-work pointers (not in this plan)

- **Apple desktop coverage** (iMac / Mac mini / Mac Pro / Mac Studio). XZZ's iMac folder is GPU-card-organized, not per-A-number. Sources to consider: hand-curate from Mactracker, scrape iFixit per-A-number pages, or wait for a structured logi.wiki source.
- **logi.wiki as supplemental Apple source.** For A-numbers in logi.wiki page titles but not in XZZ. Same staging-then-apply pattern, different extract phase.
- **Cross-brand XZZ expansion.** XZZ has well-organized folders for HP, DELL, ASUS, Lenovo ThinkPad, etc. Each has different naming conventions; one importer per brand, or a parameterized importer that takes a regex per brand.
- **Schema-v3 migration.** Promote `notes`-encoded codename / year_hint to typed columns once the data shape is validated empirically.
