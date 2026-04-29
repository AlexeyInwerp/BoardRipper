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
