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


if __name__ == '__main__':
    unittest.main()
