# Filename Scan — Observation Pass — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `scripts/scan-board-filenames.py` — a one-shot Python script that walks 3 local source directories, extracts board identifiers via 8 regex patterns plus a substring-frequency catch-all, cross-references each unique code against `boards.db`, and writes a Markdown report + JSON sidecar to `import-staging/`. **Read-only** with respect to `boards.db` (one `SELECT` per code); **no `--apply` mode**.

**Architecture:** Single Python script, single mode (no flags except `--source` repeatable + `--db`). Pure stdlib. Tests use programmatic fixtures: a synthetic file tree built by `tempfile.mkdtemp()` + `Path.touch()` and a synthetic `boards.db` matching v2 schema.

**Tech Stack:** Python 3 stdlib (`os`, `re`, `json`, `sqlite3`, `argparse`, `pathlib`, `collections.Counter`, `datetime`, `unittest`). Same toolchain as `migrate-boarddb-v2.py` and `import-xzz-apple-laptops.py`.

**Spec:** [docs/superpowers/specs/2026-04-29-filename-scan-observation-design.md](../specs/2026-04-29-filename-scan-observation-design.md)

**Working directory:** `/Users/besitzer/Desktop/Boardviewer/.worktrees/wikidata-macs-import/` (reused — same branch as the XZZ work; `feat/wikidata-macs-import` is increasingly mis-named but a rename mid-stream costs more than it saves at this stage).

---

## File map

| File | Action | Responsibility |
|------|--------|----------------|
| `scripts/scan-board-filenames.py` | CREATE | The scanner: pattern table, walk, cross-ref, report writer |
| `scripts/test_scan_board_filenames.py` | CREATE | Unit + integration tests against synthetic fixtures |
| `import-staging/filename-scan-<date>.md` | RUNTIME-CREATED | Markdown report (gitignored) |
| `import-staging/filename-scan-<date>.json` | RUNTIME-CREATED | JSON sidecar (gitignored) |
| `docs/superpowers/specs/filename-scan-<date>.md` | (Task 4 archive) | Snapshot of report for record-keeping |

---

## Task 1: Pattern table + extraction unit + tests

**Files:**
- Create: `scripts/scan-board-filenames.py`
- Create: `scripts/test_scan_board_filenames.py`

- [ ] **Step 1: Create the script scaffold**

Create `scripts/scan-board-filenames.py`:

```python
#!/usr/bin/env python3
r"""
Walk local source directories, extract board identifiers from filenames,
cross-reference each against boards.db, and write a Markdown report +
JSON sidecar to import-staging/.

OBSERVATION PASS ONLY — no DB writes, no --apply, no online lookups.

Usage:
  scripts/scan-board-filenames.py
  scripts/scan-board-filenames.py --source /path/A --source /path/B
  scripts/scan-board-filenames.py --db /path/to/boards.db
"""
from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Optional

# ---------------------------------------------------------------------------
# Pattern table
# ---------------------------------------------------------------------------
# Each entry: (name, owner, compiled regex). Patterns run case-insensitively
# over the bare filename (no folder path). re.findall() collects all matches
# per filename.

PATTERNS: list[tuple[str, str, re.Pattern]] = [
    ('apple_820',      'Apple',          re.compile(r'820-\d{4,5}(?:-[A-Z])?', re.IGNORECASE)),
    ('compal_la',      'Compal',         re.compile(r'LA-[A-Z]\d{3,4}[A-Z]?', re.IGNORECASE)),
    ('lcfc_nm',        'LCFC',           re.compile(r'NM-[A-Z]\d{3,4}', re.IGNORECASE)),
    ('quanta_da0',     'Quanta',         re.compile(r'DA0[A-Z0-9]{8,12}', re.IGNORECASE)),
    ('msi_ms',         'MSI',            re.compile(r'\bMS-\d{4,5}[A-Z]?\d?\b', re.IGNORECASE)),
    ('asus_60nr',      'ASUS internal',  re.compile(r'60NR\d{4}[A-Z]?\d{0,4}', re.IGNORECASE)),
    ('oem_6050',       'OEM (Foxconn et al.)', re.compile(r'6050[A-Z]?\d{7}', re.IGNORECASE)),
    ('apple_a_number', 'Apple A-number', re.compile(r'\bA\d{4}\b', re.IGNORECASE)),
]

# Tokens dropped from the substring-frequency catch-all. Lowercase compared.
STOPWORDS = {
    'apple', 'asus', 'acer', 'compal', 'quanta', 'lenovo', 'dell', 'hp', 'msi',
    'gigabyte', 'samsung', 'sony', 'toshiba', 'huawei', 'foxconn', 'wistron',
    'boardview', 'bios', 'firmware', 'rev', 'revision', 'schematic',
    'motherboard', 'mainboard', 'logic', 'board', 'mlb',
    'jpg', 'jpeg', 'png', 'pdf', 'bin', 'tvw', 'brd', 'bdv', 'fz', 'cad', 'xzz',
    'docx', 'doc', 'txt', 'zip', 'rar', '7z',
    'circuit', 'diagram', 'schematics', 'service', 'manual',
    'mb', 'gb', 'tb',
}

TOKENIZE_SPLIT_RE = re.compile(r'[\s_\-./()\[\]+,]+')

# ---------------------------------------------------------------------------
# Public API (also imported by tests)
# ---------------------------------------------------------------------------


def extract_matches(filename: str) -> dict[str, list[str]]:
    """Return {pattern_name: [matches]} for one filename. Empty lists omitted."""
    out: dict[str, list[str]] = {}
    for name, _owner, pat in PATTERNS:
        hits = pat.findall(filename)
        if hits:
            # Normalize to uppercase for consistency (Apple revisions stay as-is).
            out[name] = [h.upper() for h in hits]
    return out


def main():
    print("Phase: scaffold (Task 1) — main not implemented yet.", file=sys.stderr)
    return 1


if __name__ == '__main__':
    sys.exit(main())
```

- [ ] **Step 2: Create the test file**

Create `scripts/test_scan_board_filenames.py`:

```python
#!/usr/bin/env python3
"""Tests for scan-board-filenames.py."""
from __future__ import annotations

import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from importlib.util import spec_from_file_location, module_from_spec
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SCRIPT = REPO_ROOT / 'scripts' / 'scan-board-filenames.py'


def load_script():
    spec = spec_from_file_location('sbf', SCRIPT)
    m = module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


# v2 schema for fixture DB (subset matching the cross-reference query needs).
V2_SCHEMA_FIXTURE = """
PRAGMA foreign_keys=ON;
CREATE TABLE schema_version (version INTEGER NOT NULL);
INSERT INTO schema_version (version) VALUES (2);
CREATE TABLE brands (uuid TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, notes TEXT);
CREATE TABLE families (
    uuid TEXT PRIMARY KEY,
    brand_uuid TEXT NOT NULL,
    name TEXT NOT NULL
);
CREATE TABLE models (
    uuid TEXT PRIMARY KEY,
    family_uuid TEXT NOT NULL,
    model_number TEXT NOT NULL,
    display_name TEXT,
    notes TEXT
);
CREATE TABLE boards (
    uuid TEXT PRIMARY KEY,
    model_uuid TEXT NOT NULL,
    board_number TEXT NOT NULL,
    notes TEXT
);
CREATE TABLE board_aliases (
    uuid TEXT PRIMARY KEY,
    board_uuid TEXT NOT NULL,
    alias TEXT NOT NULL,
    alias_type TEXT
);
"""


def build_fixture_db(db_path: Path):
    """v2-schema fixture with one Apple model (A1466) and one board (820-00165) + alias."""
    conn = sqlite3.connect(db_path)
    conn.executescript(V2_SCHEMA_FIXTURE)
    conn.execute("INSERT INTO brands (uuid, name) VALUES ('b1', 'Apple')")
    conn.execute("INSERT INTO families (uuid, brand_uuid, name) VALUES ('f1', 'b1', 'MacBook Air')")
    conn.execute("INSERT INTO models (uuid, family_uuid, model_number, display_name) "
                 "VALUES ('m1', 'f1', 'A1466', 'MacBook Air 13\" 2015')")
    conn.execute("INSERT INTO boards (uuid, model_uuid, board_number) "
                 "VALUES ('bo1', 'm1', '820-00165')")
    conn.execute("INSERT INTO board_aliases (uuid, board_uuid, alias, alias_type) "
                 "VALUES ('a1', 'bo1', '820-00165-A', 'apple_820_no_rev')")
    conn.commit()
    conn.close()


class TestExtractMatches(unittest.TestCase):
    """Pattern-by-pattern verification for extract_matches()."""

    @classmethod
    def setUpClass(cls):
        cls.m = load_script()

    def test_apple_820_with_revision(self):
        self.assertEqual(
            self.m.extract_matches('820-00165-A_logic_board.brd')['apple_820'],
            ['820-00165-A']
        )

    def test_apple_820_short_4digit(self):
        self.assertEqual(
            self.m.extract_matches('820-2530_K24.pdf')['apple_820'],
            ['820-2530']
        )

    def test_compal_la(self):
        # 'C5V01' is part of an ACER chassis name; LA-E891P is the Compal code.
        out = self.m.extract_matches('ACER C5V01 LA-E891P REV 2A.pdf')
        self.assertIn('LA-E891P', out['compal_la'])

    def test_lcfc_nm(self):
        out = self.m.extract_matches('Lenovo ThinkPad T450 NM-A251 schematic.pdf')
        self.assertIn('NM-A251', out['lcfc_nm'])

    def test_quanta_da0(self):
        out = self.m.extract_matches('Dell_Inspiron_DA0R09MB6H1_schematic.pdf')
        self.assertIn('DA0R09MB6H1', out['quanta_da0'])

    def test_msi_ms(self):
        out = self.m.extract_matches('MSI Stealth MS-16GF1 boardview.tvw')
        self.assertIn('MS-16GF1', out['msi_ms'])

    def test_asus_60nr(self):
        out = self.m.extract_matches('ASUS FX705DD REV2.0 - 60NR02A0-MB1100.pdf')
        self.assertIn('60NR02A0', out['asus_60nr'])

    def test_oem_6050(self):
        out = self.m.extract_matches('6050A3426501-MB-A02 schematic.pdf')
        self.assertIn('6050A3426501', out['oem_6050'])

    def test_apple_a_number(self):
        out = self.m.extract_matches('A1466_820-00165 J113.pdf')
        # Both apple_a_number AND apple_820 should match
        self.assertIn('A1466', out['apple_a_number'])
        self.assertIn('820-00165', out['apple_820'])

    def test_normalization_to_uppercase(self):
        out = self.m.extract_matches('820-00165 la-6901p ms-16gf1.pdf')
        self.assertIn('820-00165', out['apple_820'])
        self.assertIn('LA-6901P', out['compal_la'])
        self.assertIn('MS-16GF1', out['msi_ms'])

    def test_no_match_returns_empty_dict(self):
        out = self.m.extract_matches('readme.txt')
        self.assertEqual(out, {})

    def test_multiple_codes_same_filename(self):
        # T-line ThinkPad with two NM codes inside parens
        out = self.m.extract_matches('A1706/A1708_TConn_Backlight.pdf')
        self.assertEqual(set(out['apple_a_number']), {'A1706', 'A1708'})


if __name__ == '__main__':
    unittest.main()
```

- [ ] **Step 3: Make both files executable**

```bash
cd /Users/besitzer/Desktop/Boardviewer/.worktrees/wikidata-macs-import
chmod +x scripts/scan-board-filenames.py scripts/test_scan_board_filenames.py
```

- [ ] **Step 4: Run tests; confirm 12 pattern tests pass**

```bash
cd /Users/besitzer/Desktop/Boardviewer/.worktrees/wikidata-macs-import && python3 scripts/test_scan_board_filenames.py -v 2>&1 | tail -20
```

Expected: `Ran 12 tests in <T>s — OK`. All 12 `TestExtractMatches` tests pass.

If `test_msi_ms` fails because `MS-16GF1` matches but is also matched by the `oem_6050` regex spuriously: the `\b` word-boundary in the MSI regex prevents this. If a different test fails, inspect the offending pattern in `PATTERNS` and tighten the regex.

If `test_apple_a_number` fails because the regex catches non-A-number `A####` strings (e.g., `A1234` in some random ASUS code): word boundaries on `\bA\d{4}\b` are doing the work; if it's still catching false positives, narrow to `\bA\d{4}\b(?!\d)` or similar — but for this task's scope, the test is the spec.

- [ ] **Step 5: Commit**

```bash
cd /Users/besitzer/Desktop/Boardviewer/.worktrees/wikidata-macs-import
git add scripts/scan-board-filenames.py scripts/test_scan_board_filenames.py
git commit -m "$(cat <<'EOF'
feat(scan): scaffold filename scanner + pattern battery

scripts/scan-board-filenames.py:
  - 8-pattern regex battery (apple_820, compal_la, lcfc_nm, quanta_da0,
    msi_ms, asus_60nr, oem_6050, apple_a_number) compiled with re.IGNORECASE
  - extract_matches(filename) returns {pattern_name: [uppercase_matches]}
  - main() stubbed (Task 2/3 fill in DB cross-ref, walk, and report writer)

Tests: 12 unit tests covering each pattern + multi-code filenames +
no-match + normalization.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: DB cross-reference + tokenizer + tests

**Files:**
- Modify: `scripts/scan-board-filenames.py` (add `cross_reference_db`, `tokenize_unmatched`)
- Modify: `scripts/test_scan_board_filenames.py` (add 2 test classes)

- [ ] **Step 1: Add `cross_reference_db()` and `tokenize_unmatched()` to the script**

In `scripts/scan-board-filenames.py`, **insert** these two functions immediately after `extract_matches()` (and before `def main()`):

```python
def cross_reference_db(
    db_path: Optional[Path],
    codes_by_pattern: dict[str, set[str]],
) -> dict[str, dict[str, set[str]]]:
    """Split each pattern's unique codes into 'already_in_db' vs 'new'.

    Returns {pattern_name: {'already_in_db': set, 'new': set}}.
    If db_path is None or schema is wrong, returns 'unknown_db_state' for all.
    """
    if db_path is None or not db_path.exists():
        return {p: {'unknown_db_state': set(codes)} for p, codes in codes_by_pattern.items()}

    conn = sqlite3.connect(f'file:{db_path}?mode=ro', uri=True)
    try:
        ver_row = conn.execute(
            "SELECT version FROM schema_version LIMIT 1"
        ).fetchone()
        if not ver_row or ver_row[0] < 2:
            return {p: {'unknown_db_state': set(codes)} for p, codes in codes_by_pattern.items()}

        result: dict[str, dict[str, set[str]]] = {}
        for pattern_name, codes in codes_by_pattern.items():
            already: set[str] = set()
            new: set[str] = set()
            for code in codes:
                if pattern_name == 'apple_a_number':
                    row = conn.execute(
                        "SELECT 1 FROM models WHERE upper(model_number) = ? LIMIT 1",
                        (code.upper(),)
                    ).fetchone()
                else:
                    row = conn.execute(
                        "SELECT 1 FROM boards WHERE upper(board_number) = ? "
                        "OR uuid IN (SELECT board_uuid FROM board_aliases WHERE upper(alias) = ?) "
                        "LIMIT 1",
                        (code.upper(), code.upper())
                    ).fetchone()
                if row:
                    already.add(code)
                else:
                    new.add(code)
            result[pattern_name] = {'already_in_db': already, 'new': new}
        return result
    finally:
        conn.close()


def tokenize_unmatched(filenames: Iterable[str]) -> Counter:
    """Tokenize filenames that didn't strongly match any pattern.

    Drops STOPWORDS, drops tokens shorter than 4 chars, drops pure-digit
    tokens shorter than 5 chars. Returns Counter of token frequencies.
    """
    counter: Counter = Counter()
    for name in filenames:
        # Strip extension
        stem = name.rsplit('.', 1)[0] if '.' in name else name
        for tok in TOKENIZE_SPLIT_RE.split(stem):
            tok_lower = tok.lower()
            if len(tok) < 4:
                continue
            if tok_lower in STOPWORDS:
                continue
            if tok.isdigit() and len(tok) < 5:
                continue
            counter[tok] += 1
    return counter
```

- [ ] **Step 2: Add tests**

In `scripts/test_scan_board_filenames.py`, **append** these test classes before the `if __name__ == '__main__'` block:

```python
class TestCrossReferenceDB(unittest.TestCase):
    """Each unique extracted code is split into already_in_db vs new."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.db = self.tmp / 'boards.db'
        build_fixture_db(self.db)
        self.m = load_script()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_known_apple_820_marked_already_in_db(self):
        result = self.m.cross_reference_db(
            self.db, {'apple_820': {'820-00165', '820-99999'}}
        )
        self.assertEqual(result['apple_820']['already_in_db'], {'820-00165'})
        self.assertEqual(result['apple_820']['new'], {'820-99999'})

    def test_alias_match_counts_as_already_in_db(self):
        # The fixture has alias '820-00165-A' for board '820-00165'
        result = self.m.cross_reference_db(
            self.db, {'apple_820': {'820-00165-A'}}
        )
        self.assertEqual(result['apple_820']['already_in_db'], {'820-00165-A'})

    def test_apple_a_number_queries_models_table(self):
        # Fixture has model A1466
        result = self.m.cross_reference_db(
            self.db, {'apple_a_number': {'A1466', 'A9999'}}
        )
        self.assertEqual(result['apple_a_number']['already_in_db'], {'A1466'})
        self.assertEqual(result['apple_a_number']['new'], {'A9999'})

    def test_missing_db_returns_unknown_state(self):
        result = self.m.cross_reference_db(
            Path('/nonexistent/db.db'),
            {'apple_820': {'820-00165'}}
        )
        self.assertIn('unknown_db_state', result['apple_820'])
        self.assertEqual(result['apple_820']['unknown_db_state'], {'820-00165'})

    def test_db_below_schema_v2_returns_unknown(self):
        # Wipe schema_version → 1
        with sqlite3.connect(self.db) as c:
            c.execute("DELETE FROM schema_version")
            c.execute("INSERT INTO schema_version (version) VALUES (1)")
            c.commit()
        result = self.m.cross_reference_db(
            self.db, {'apple_820': {'820-00165'}}
        )
        self.assertIn('unknown_db_state', result['apple_820'])


class TestTokenizeUnmatched(unittest.TestCase):
    """Unmatched-substring tokenization for pattern-discovery."""

    @classmethod
    def setUpClass(cls):
        cls.m = load_script()

    def test_drops_stopwords(self):
        counter = self.m.tokenize_unmatched(['Apple Boardview Schematic.pdf'])
        self.assertNotIn('Apple', counter)
        self.assertNotIn('apple', counter)
        self.assertNotIn('Boardview', counter)
        self.assertNotIn('Schematic', counter)
        self.assertNotIn('pdf', counter)

    def test_drops_short_tokens(self):
        counter = self.m.tokenize_unmatched(['ABC ab DEF abc.txt'])
        self.assertNotIn('abc', counter)  # 3 chars
        self.assertNotIn('ABC', counter)  # 3 chars
        self.assertNotIn('ab', counter)   # 2 chars
        self.assertNotIn('DEF', counter)  # 3 chars

    def test_keeps_likely_codes(self):
        counter = self.m.tokenize_unmatched([
            '203075-1_cezanne.pdf',
            'SR1YJ_testpoints.jpg',
            'DABTU14MB6E0_layout.pdf',
        ])
        self.assertGreater(counter.get('cezanne', 0), 0)
        self.assertGreater(counter.get('SR1YJ', 0), 0)
        self.assertGreater(counter.get('DABTU14MB6E0', 0), 0)

    def test_drops_pure_short_digits(self):
        counter = self.m.tokenize_unmatched(['part_1234_revision_5.pdf'])
        self.assertNotIn('1234', counter)
        self.assertNotIn('5', counter)

    def test_keeps_long_digit_runs(self):
        counter = self.m.tokenize_unmatched(['serial_12345678.bin'])
        self.assertEqual(counter.get('12345678', 0), 1)

    def test_counts_repeats_across_filenames(self):
        counter = self.m.tokenize_unmatched([
            '203075-1_cezanne.pdf',
            'A1234_cezanne.pdf',
            'B2345_cezanne_layout.pdf',
        ])
        self.assertEqual(counter['cezanne'], 3)
```

- [ ] **Step 3: Run tests; confirm 12 + 5 + 6 = 23 pass**

```bash
cd /Users/besitzer/Desktop/Boardviewer/.worktrees/wikidata-macs-import && python3 scripts/test_scan_board_filenames.py -v 2>&1 | tail -30
```

Expected: `Ran 23 tests in <T>s — OK`. All 23 tests pass.

If `test_alias_match_counts_as_already_in_db` fails: the SQL query subselect `SELECT board_uuid FROM board_aliases WHERE upper(alias) = ?` should match the alias. Verify the fixture inserted the alias correctly by adding a `print(c.execute("SELECT * FROM board_aliases").fetchall())` in the failing test.

If `test_apple_a_number_queries_models_table` fails: the `cross_reference_db` function's special branch for `pattern_name == 'apple_a_number'` should query `models.model_number`, not `boards.board_number`.

- [ ] **Step 4: Commit**

```bash
cd /Users/besitzer/Desktop/Boardviewer/.worktrees/wikidata-macs-import
git add scripts/scan-board-filenames.py scripts/test_scan_board_filenames.py
git commit -m "$(cat <<'EOF'
feat(scan): DB cross-reference + unmatched-substring tokenizer

scripts/scan-board-filenames.py:
  - cross_reference_db(): one read-only SQLite connection (mode=ro
    URI), splits each pattern's unique codes into already_in_db vs new
    via a single SELECT per code. apple_a_number queries models
    table; everything else queries boards + board_aliases.
  - Missing DB or schema_version<2 returns 'unknown_db_state'
    bucket — script still produces report, just with a banner.
  - tokenize_unmatched(): split on whitespace/separators, drop
    STOPWORDS (apple/asus/boardview/etc.), drop tokens <4 chars,
    drop pure-digit tokens <5 chars. Returns Counter for top-50
    extraction in the report.

Tests: 11 new (5 cross-reference + 6 tokenizer). Total 23/23 passing.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Walk + report writer + integration tests

**Files:**
- Modify: `scripts/scan-board-filenames.py` (add `scan_sources`, `write_markdown_report`, `write_json_sidecar`, real `main`)
- Modify: `scripts/test_scan_board_filenames.py` (add `TestScanIntegration`)

- [ ] **Step 1: Add walk + report writer + real `main`**

In `scripts/scan-board-filenames.py`, **replace the stub `main()` and add scan/report functions**. Insert these immediately before `def main()`:

```python
DEFAULT_SOURCES = [
    Path('/Users/besitzer/Desktop/Boardviewer/samples'),
    Path('/Users/besitzer/Library/CloudStorage/SynologyDrive-Mac/XZZ'),
    Path('/Users/besitzer/Library/CloudStorage/SynologyDrive-Mac/DESKTOP/BOARDS STUFF'),
]
DEFAULT_DB = Path(__file__).resolve().parent.parent / 'Board Database' / 'boards.db'


def scan_sources(sources: list[Path]) -> dict:
    """Walk all sources, extract matches per filename. Returns aggregated data.

    Output shape:
      {
        'sources': [{path, files_scanned, files_with_match, accessible}],
        'matches': [(pattern_name, value, source_path, file_path), ...],
        'unmatched_filenames': [filename, ...],
        'a_number_only_filenames': [filename, ...],
      }
    """
    sources_meta: list[dict] = []
    matches: list[tuple[str, str, str, str]] = []
    unmatched_filenames: list[str] = []
    a_number_only_filenames: list[str] = []

    for src in sources:
        meta = {'path': str(src), 'files_scanned': 0,
                'files_with_match': 0, 'accessible': src.exists()}
        if not src.exists():
            print(f"warning: source path does not exist: {src}", file=sys.stderr)
            sources_meta.append(meta)
            continue

        for p in _walk(src):
            meta['files_scanned'] += 1
            extracted = extract_matches(p.name)
            if extracted:
                meta['files_with_match'] += 1
                for pat_name, vals in extracted.items():
                    for v in vals:
                        matches.append((pat_name, v, str(src), str(p)))
                # If only apple_a_number matched (weak signal), still tokenize
                if set(extracted.keys()) == {'apple_a_number'}:
                    a_number_only_filenames.append(p.name)
            else:
                unmatched_filenames.append(p.name)
        sources_meta.append(meta)

    return {
        'sources': sources_meta,
        'matches': matches,
        'unmatched_filenames': unmatched_filenames,
        'a_number_only_filenames': a_number_only_filenames,
    }


def _walk(root: Path) -> Iterable[Path]:
    """Yield all files under root. Skips hidden dirs/files (dotfiles).
    Catches PermissionError per-subtree and continues."""
    try:
        for entry in root.iterdir():
            if entry.name.startswith('.'):
                continue
            try:
                if entry.is_dir():
                    yield from _walk(entry)
                elif entry.is_file():
                    yield entry
            except PermissionError as e:
                print(f"warning: {e}", file=sys.stderr)
    except PermissionError as e:
        print(f"warning: {e}", file=sys.stderr)
    except OSError as e:
        print(f"warning: {e}", file=sys.stderr)


def write_json_sidecar(out_path: Path, scan_data: dict, xref: dict,
                       unmatched_top50: list[tuple[str, int]],
                       db_path: Optional[Path]) -> None:
    """Write the machine-readable JSON output."""
    # Build per-pattern stats
    per_pattern: dict[str, dict] = {}
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

    # Per-source
    per_source = {
        s['path']: {
            'files_scanned': s['files_scanned'],
            'files_with_match': s['files_with_match'],
            'accessible': s['accessible'],
        }
        for s in scan_data['sources']
    }

    # Sample filenames per top-50 token
    samples_per_token: dict[str, list[str]] = {}
    pool = scan_data['unmatched_filenames'] + scan_data['a_number_only_filenames']
    for token, _count in unmatched_top50:
        samples_per_token[token] = [
            f for f in pool if token.lower() in f.lower()
        ][:3]

    payload = {
        'fetched_at': datetime.now(timezone.utc).isoformat(),
        'db_path': str(db_path) if db_path else None,
        'sources_scanned': [s['path'] for s in scan_data['sources']],
        'summary': {
            'files_scanned_total': sum(s['files_scanned'] for s in scan_data['sources']),
            'files_with_match_total': sum(s['files_with_match'] for s in scan_data['sources']),
            'unique_codes_total': sum(p['unique_codes'] for p in per_pattern.values()),
        },
        'per_pattern': per_pattern,
        'per_source': per_source,
        'unmatched_top50': [
            {'token': t, 'count': c, 'samples': samples_per_token.get(t, [])}
            for t, c in unmatched_top50
        ],
    }
    out_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False))


def write_markdown_report(out_path: Path, scan_data: dict, xref: dict,
                          unmatched_top50: list[tuple[str, int]],
                          db_path: Optional[Path]) -> None:
    """Write the human-readable Markdown report."""
    pattern_owner = {name: owner for name, owner, _ in PATTERNS}
    lines: list[str] = []
    lines.append(f"# Filename Scan — {datetime.now(timezone.utc).strftime('%Y-%m-%d')}")
    lines.append("")
    if not db_path or not db_path.exists():
        lines.append("> ⚠️ DB cross-reference disabled (boards.db not found)")
        lines.append("")

    # Summary table
    files_total = sum(s['files_scanned'] for s in scan_data['sources'])
    files_match = sum(s['files_with_match'] for s in scan_data['sources'])
    matches_total = len(scan_data['matches'])
    unique_codes = sum(
        len({m[1] for m in scan_data['matches'] if m[0] == p[0]}) for p in PATTERNS
    )
    lines.append("## Summary")
    lines.append("")
    lines.append("| metric | value |")
    lines.append("|---|---:|")
    lines.append(f"| sources scanned | {len(scan_data['sources'])} |")
    lines.append(f"| files scanned | {files_total:,} |")
    lines.append(f"| files with at least one pattern match | {files_match:,} |")
    lines.append(f"| total pattern matches (with duplicates) | {matches_total:,} |")
    lines.append(f"| unique board+model codes extracted | {unique_codes:,} |")
    lines.append("")

    # Per-pattern
    lines.append("## Per-pattern results")
    lines.append("")
    for pat_name, owner, _ in PATTERNS:
        codes = {m[1] for m in scan_data['matches'] if m[0] == pat_name}
        if not codes:
            lines.append(f"### {pat_name} ({owner}) — 0 matches")
            lines.append("")
            continue
        xref_p = xref.get(pat_name, {})
        already = xref_p.get('already_in_db', set())
        new = xref_p.get('new', set())
        unknown = xref_p.get('unknown_db_state', set())
        lines.append(f"### {pat_name} ({owner}) — {len(codes)} unique codes")
        if already or new:
            pct_new = 100 * len(new) / len(codes) if codes else 0
            lines.append(f"- already_in_db: {len(already)}")
            lines.append(f"- new: {len(new)} ({pct_new:.0f}%)")
        if unknown:
            lines.append(f"- unknown_db_state: {len(unknown)}")
        sample_new = sorted(new)[:10]
        if sample_new:
            lines.append(f"- Sample of {min(10, len(new))} new: {', '.join(sample_new)}")
        lines.append("")

    # Per-source
    lines.append("## Per-source breakdown")
    lines.append("")
    lines.append("| source | files | with match |")
    lines.append("|---|---:|---:|")
    for s in scan_data['sources']:
        flag = '' if s['accessible'] else ' ⚠️ inaccessible'
        lines.append(
            f"| `{s['path']}`{flag} | {s['files_scanned']:,} | {s['files_with_match']:,} |"
        )
    lines.append("")

    # Top unmatched substrings
    lines.append("## Top 50 unmatched substrings")
    lines.append("")
    if not unmatched_top50:
        lines.append("(none)")
    else:
        lines.append("| token | count | sample filename |")
        lines.append("|---|---:|---|")
        pool = scan_data['unmatched_filenames'] + scan_data['a_number_only_filenames']
        for token, count in unmatched_top50:
            sample = next((f for f in pool if token.lower() in f.lower()), '')
            lines.append(f"| `{token}` | {count} | {sample} |")
    lines.append("")

    out_path.write_text('\n'.join(lines))


def main():
    ap = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    ap.add_argument('--source', metavar='PATH', action='append',
                    help='Source directory to walk (repeatable). Defaults to 3 known paths.')
    ap.add_argument('--db', metavar='PATH', default=str(DEFAULT_DB),
                    help='Path to boards.db (read-only). Default: Board Database/boards.db')
    args = ap.parse_args()

    sources = [Path(s) for s in args.source] if args.source else DEFAULT_SOURCES
    db_path: Optional[Path] = Path(args.db) if args.db else None
    if db_path and not db_path.exists():
        print(f"note: --db path not found: {db_path} (cross-reference disabled)",
              file=sys.stderr)
        db_path = None

    print(f"scanning {len(sources)} source(s) …", file=sys.stderr)
    scan_data = scan_sources(sources)

    # Collect unique codes per pattern for cross-reference
    codes_by_pattern: dict[str, set[str]] = {p[0]: set() for p in PATTERNS}
    for pat_name, value, _src, _path in scan_data['matches']:
        codes_by_pattern[pat_name].add(value)

    xref = cross_reference_db(db_path, codes_by_pattern)

    # Tokenize unmatched filenames
    weak_pool = scan_data['unmatched_filenames'] + scan_data['a_number_only_filenames']
    counter = tokenize_unmatched(weak_pool)
    unmatched_top50 = counter.most_common(50)

    # Output
    out_dir = Path(__file__).resolve().parent.parent / 'import-staging'
    out_dir.mkdir(exist_ok=True)
    today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
    md_path = out_dir / f'filename-scan-{today}.md'
    json_path = out_dir / f'filename-scan-{today}.json'
    write_markdown_report(md_path, scan_data, xref, unmatched_top50, db_path)
    write_json_sidecar(json_path, scan_data, xref, unmatched_top50, db_path)

    files_total = sum(s['files_scanned'] for s in scan_data['sources'])
    files_match = sum(s['files_with_match'] for s in scan_data['sources'])
    print(f"\nscanned {files_total:,} files; {files_match:,} had pattern matches",
          file=sys.stderr)
    print(f"  Markdown: {md_path}", file=sys.stderr)
    print(f"  JSON:     {json_path}", file=sys.stderr)
    return 0
```

- [ ] **Step 2: Add integration tests**

In `scripts/test_scan_board_filenames.py`, **append**:

```python
class TestScanIntegration(unittest.TestCase):
    """End-to-end: walk a synthetic file tree, run cross-ref, write reports."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.db = self.tmp / 'boards.db'
        build_fixture_db(self.db)
        self.src = self.tmp / 'src'
        self.src.mkdir()
        # Build a synthetic file tree with diverse filenames
        for name in [
            'A1466_820-00165 J113.brd',           # known apple
            '820-99999_unknown.pdf',              # new apple
            'ACER C5V01 LA-E891P REV 2A.pdf',     # new compal
            'Lenovo NM-A251.pdf',                 # known LCFC (alias)
            '203075-1_cezanne.pdf',               # unmatched -> tokenize
            'SR1YJ_testpoints.jpg',               # unmatched
            'readme.txt',                         # noise
        ]:
            (self.src / name).touch()
        # Subdir with one more file
        sub = self.src / 'subdir'
        sub.mkdir()
        (sub / 'DA0R09MB6H1_test.pdf').touch()
        # Hidden file/dir should be skipped
        (self.src / '.hidden_file').touch()
        hidden_dir = self.src / '.hidden_dir'
        hidden_dir.mkdir()
        (hidden_dir / 'should_not_appear.pdf').touch()
        # Patch __file__ so import-staging lands in tmp
        self.m = load_script()
        self._orig_file = self.m.__file__
        scripts_dir = self.tmp / 'scripts'
        scripts_dir.mkdir()
        self.m.__file__ = str(scripts_dir / 'scan-board-filenames.py')

    def tearDown(self):
        self.m.__file__ = self._orig_file
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_scan_walks_and_extracts(self):
        scan_data = self.m.scan_sources([self.src])
        self.assertEqual(scan_data['sources'][0]['accessible'], True)
        # 8 files (incl. subdir), 1 hidden (skipped) -> files_scanned=8
        self.assertEqual(scan_data['sources'][0]['files_scanned'], 8)
        # 6 of those have at least one pattern match
        self.assertEqual(scan_data['sources'][0]['files_with_match'], 6)
        # readme.txt and one other are fully unmatched (203075-1_cezanne is tokenized
        # but not pattern-matched, SR1YJ_testpoints is also not pattern-matched)
        self.assertGreaterEqual(len(scan_data['unmatched_filenames']), 3)

    def test_scan_skips_hidden(self):
        scan_data = self.m.scan_sources([self.src])
        for _pat, _val, _src, path in scan_data['matches']:
            self.assertNotIn('.hidden', path)

    def test_scan_handles_missing_source(self):
        scan_data = self.m.scan_sources([Path('/nonexistent/path')])
        self.assertEqual(scan_data['sources'][0]['accessible'], False)
        self.assertEqual(scan_data['sources'][0]['files_scanned'], 0)

    def test_main_writes_both_reports(self):
        # Patch DEFAULT_SOURCES and DEFAULT_DB so the no-flag invocation
        # doesn't hit the user's real paths.
        # Simpler: invoke scan_sources + write helpers directly.
        scan_data = self.m.scan_sources([self.src])
        codes_by_pattern = {p[0]: set() for p in self.m.PATTERNS}
        for pat_name, value, _src, _path in scan_data['matches']:
            codes_by_pattern[pat_name].add(value)
        xref = self.m.cross_reference_db(self.db, codes_by_pattern)
        weak_pool = scan_data['unmatched_filenames'] + scan_data['a_number_only_filenames']
        counter = self.m.tokenize_unmatched(weak_pool)
        top50 = counter.most_common(50)

        out_dir = self.tmp / 'import-staging'
        out_dir.mkdir()
        md = out_dir / 'filename-scan-test.md'
        json_p = out_dir / 'filename-scan-test.json'
        self.m.write_markdown_report(md, scan_data, xref, top50, self.db)
        self.m.write_json_sidecar(json_p, scan_data, xref, top50, self.db)

        self.assertTrue(md.exists())
        self.assertTrue(json_p.exists())

        # Check Markdown content
        md_text = md.read_text()
        self.assertIn('Filename Scan', md_text)
        self.assertIn('Per-pattern results', md_text)
        self.assertIn('820-99999', md_text)  # appears as a "new" sample

        # Check JSON content
        payload = json.loads(json_p.read_text())
        self.assertEqual(payload['summary']['files_scanned_total'], 8)
        self.assertIn('apple_820', payload['per_pattern'])
        self.assertEqual(payload['per_pattern']['apple_820']['already_in_db_count'], 1)
        self.assertEqual(payload['per_pattern']['apple_820']['new_count'], 1)

    def test_xref_disabled_when_db_missing(self):
        scan_data = self.m.scan_sources([self.src])
        codes_by_pattern = {p[0]: set() for p in self.m.PATTERNS}
        for pat_name, value, _src, _path in scan_data['matches']:
            codes_by_pattern[pat_name].add(value)
        xref = self.m.cross_reference_db(None, codes_by_pattern)
        # All buckets should be 'unknown_db_state'
        for pat_name in xref:
            self.assertIn('unknown_db_state', xref[pat_name])
```

- [ ] **Step 3: Run tests; confirm 23 + 5 = 28 pass**

```bash
cd /Users/besitzer/Desktop/Boardviewer/.worktrees/wikidata-macs-import && python3 scripts/test_scan_board_filenames.py -v 2>&1 | tail -30
```

Expected: `Ran 28 tests in <T>s — OK`. All 28 tests pass.

If `test_scan_walks_and_extracts` fails on the `files_scanned == 8` count: the hidden-skip logic should catch `.hidden_file` AND `.hidden_dir/should_not_appear.pdf` (the latter via the `entry.name.startswith('.')` short-circuit on the hidden directory). If file count is off, debug by printing what `_walk` yielded.

If `test_main_writes_both_reports` fails on JSON `already_in_db_count`: confirm the cross-ref was invoked and the fixture DB indeed has `820-00165` in `boards`. The `820-99999` case should be in `new`.

- [ ] **Step 4: Commit**

```bash
cd /Users/besitzer/Desktop/Boardviewer/.worktrees/wikidata-macs-import
git add scripts/scan-board-filenames.py scripts/test_scan_board_filenames.py
git commit -m "$(cat <<'EOF'
feat(scan): walk + Markdown report + JSON sidecar (full pipeline)

scripts/scan-board-filenames.py:
  - scan_sources() walks each source via _walk() (skips hidden
    files/dirs, catches PermissionError per-subtree), extracts via
    extract_matches(), records (pattern, value, source, path) tuples
  - DEFAULT_SOURCES + DEFAULT_DB constants; --source repeatable;
    --db path overridable; missing DB disables cross-ref
  - write_markdown_report(): summary table + per-pattern (with
    already/new counts + samples) + per-source + top-50 unmatched
  - write_json_sidecar(): same data, structured for follow-up tooling
  - main() glues scan + xref + tokenize + writers; prints output
    paths to stderr

Tests: 5 new (TestScanIntegration). Total 28/28 passing.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Run on real sources + commit findings snapshot

**Files:**
- Mutate (transient): `import-staging/filename-scan-2026-04-29.{md,json}` (gitignored)
- Create: `docs/superpowers/specs/filename-scan-snapshot-2026-04-29.md` (snapshot for record)

- [ ] **Step 1: Run the scanner against the real sources**

```bash
cd /Users/besitzer/Desktop/Boardviewer/.worktrees/wikidata-macs-import && python3 scripts/scan-board-filenames.py 2>&1 | tail -10
```

Expected stderr:
```
scanning 3 source(s) …
warning: source path does not exist: ...   (only if any source is paused; otherwise no warnings)
scanned ~17,000 files; ~4,000 had pattern matches
  Markdown: /Users/besitzer/Desktop/Boardviewer/.worktrees/wikidata-macs-import/import-staging/filename-scan-2026-04-29.md
  JSON:     /Users/besitzer/Desktop/Boardviewer/.worktrees/wikidata-macs-import/import-staging/filename-scan-2026-04-29.json
```

Runtime: under 60 seconds on local SSD. If it exceeds 5 minutes, the sources are larger than expected — let it complete; the script is single-pass and won't hang. If it does hang, inspect with Ctrl-C + stack trace.

- [ ] **Step 2: Eyeball the report**

Read the Markdown report. Specifically check:

```bash
cd /Users/besitzer/Desktop/Boardviewer/.worktrees/wikidata-macs-import
head -80 import-staging/filename-scan-2026-04-29.md
```

Look for:
- **Summary numbers** are non-zero (sources accessible, files counted)
- **`apple_820`** has hundreds of unique codes; "new" % is meaningful
- **`compal_la`/`lcfc_nm`/`quanta_da0`/`msi_ms`** each have at least some matches (these brands are well-represented in BOARDS STUFF)
- **Top 50 unmatched substrings** include candidate codes (`DABTU…` style, `60050…`, AMD codenames `cezanne`/`phoenix`, Intel SSpec codes `SR…`)

Bookmark anything surprising — that's the input to the schema-decision conversation.

- [ ] **Step 3: Archive the report snapshot**

The `import-staging/` files are gitignored. Save a snapshot of the Markdown report (NOT the JSON — too large) under `docs/superpowers/specs/` for record-keeping:

```bash
cd /Users/besitzer/Desktop/Boardviewer/.worktrees/wikidata-macs-import
cp import-staging/filename-scan-2026-04-29.md \
   docs/superpowers/specs/filename-scan-snapshot-2026-04-29.md
git add docs/superpowers/specs/filename-scan-snapshot-2026-04-29.md
git commit -m "$(cat <<'EOF'
docs(scan): archive observation-pass snapshot 2026-04-29

Snapshot of the Markdown report from running scripts/scan-board-
filenames.py against samples/ + XZZ/ + BOARDS STUFF/.

This is informational data for the next sub-project (filename →
boards.db importer) — informs the schema-NULL-model_uuid vs
synthetic-placeholder-models choice and which patterns are worth
turning into auto-importers.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 4: Final verification**

```bash
cd /Users/besitzer/Desktop/Boardviewer/.worktrees/wikidata-macs-import && python3 scripts/test_scan_board_filenames.py 2>&1 | tail -3
```

Expected: `Ran 28 tests` + `OK`.

Confirm git history:

```bash
git log --oneline 787b3c6..HEAD | head -10
```

Expected commits in order (oldest to newest):
1. `feat(scan): scaffold filename scanner + pattern battery`
2. `feat(scan): DB cross-reference + unmatched-substring tokenizer`
3. `feat(scan): walk + Markdown report + JSON sidecar (full pipeline)`
4. `docs(scan): archive observation-pass snapshot 2026-04-29`

---

## Future-work pointers (not in this plan)

The observation pass is informational only. Next sub-project decisions depend on what the report shows:

- **Importer slice** — turn the JSON sidecar into a staging file for `--apply` against `boards.db`. Schema-decision flows from observation data: if `compal_la` / `lcfc_nm` / etc. have thousands of "new" codes (likely), we need either `migrateV3` to allow `boards.model_uuid` NULL OR auto-generated synthetic placeholder models per (brand, ODM-prefix).
- **Pattern-set extension** — top unmatched substrings reveal new patterns. Common candidates: `DABTU\d+[A-Z]+\d+` (more specific Foxconn), `SR[A-Z0-9]{3}` (Intel SSpec), brand-specific marketing strings (`Aspire`, `Inspiron`, etc.).
- **Online-lookup slices** — vinafix.com / Badcaps research-then-implement. Inputs are the "new codes" lists from the observation report.
- **Brand attribution** — non-Apple ODM codes (LA-, NM-, DA0, MS-) need brand resolution. Importer would need an ODM→common-brands map (e.g., LA-codes appear in Acer/HP/Lenovo/Dell laptops at various times) plus filename-context detection.
