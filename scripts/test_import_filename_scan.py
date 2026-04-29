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
                 (model_uuid, family_uuid, 'A1466', 'MacBook Air 13\"'))
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
