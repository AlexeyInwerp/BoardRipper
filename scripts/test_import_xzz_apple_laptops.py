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


if __name__ == '__main__':
    unittest.main()
