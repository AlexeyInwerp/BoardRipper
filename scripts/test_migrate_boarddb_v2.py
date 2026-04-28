#!/usr/bin/env python3
"""Tests for migrate-boarddb-v2.py against a synthetic fixture."""
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
MIGRATE_SCRIPT = REPO_ROOT / 'scripts' / 'migrate-boarddb-v2.py'

# v0/v1 schema as it exists today (from create_mockup_db.sql).
PRE_V2_SCHEMA = """
CREATE TABLE IF NOT EXISTS boards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    brand TEXT NOT NULL,
    model TEXT,
    model_number TEXT,
    board_number TEXT NOT NULL,
    board_name TEXT,
    odm TEXT,
    board_number_type TEXT,
    source TEXT NOT NULL,
    source_url TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS board_aliases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    alias_number TEXT NOT NULL,
    alias_type TEXT
);
CREATE TABLE IF NOT EXISTS model_aliases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    model_name TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_board_unique ON boards(board_number, brand);
CREATE INDEX IF NOT EXISTS idx_board_number ON boards(board_number);
CREATE INDEX IF NOT EXISTS idx_brand_model ON boards(brand, model);
CREATE INDEX IF NOT EXISTS idx_alias_number ON board_aliases(alias_number);
CREATE INDEX IF NOT EXISTS idx_model_alias ON model_aliases(model_name);
"""

FIXTURE_DATA = [
    # (brand, model, model_number, board_number, board_name, odm, type, source, [aliases], [model_aliases])
    ('Apple', 'MacBook Pro 13" Touch Bar Late 2016', 'A1706', '820-00239-A', 'X362 MLB', 'Apple', 'apple_820', 'logiwiki',
        [('820-00239', 'apple_820_no_rev')],
        ['MacBookPro13,2']),
    ('Apple', 'MacBook Air 13" M1 Late 2020', 'A2337', '820-02016-A', 'X1757', 'Apple', 'apple_820', 'logiwiki',
        [('661-16809', 'apple_service'), ('EMC 3598', 'emc')],
        ['MacBookAir10,1']),
    ('Apple', 'Mac mini 2018', 'A1993', '820-00939-A', None, 'Apple', 'apple_820', 'logiwiki',
        [('820-00939', 'apple_820_no_rev')],
        []),
    ('Lenovo', 'ThinkPad T450', '20BU/20BX', 'NM-A251', 'AIVL0', 'LCFC', 'lenovo_nm', 'boardschematic',
        [('00HN525', 'lenovo_fru'), ('00HN529', 'lenovo_fru')],
        []),
    ('Lenovo', 'Legion 5 15ACH6H', '82JU', 'NM-D862', None, 'LCFC', 'lenovo_nm', 'manual',
        [],
        []),
    ('Dell', 'Inspiron 17R 5720', 'N5720', 'DA0R09MB6H1', 'Quanta R09', 'Quanta', 'quanta_da0', 'ebay',
        [('0F9C71', 'dell_dpn'), ('72P0M', 'dell_dpn')],
        ['Inspiron 17R 7720']),
    ('Acer', 'Aspire 5750', 'NV57H', 'LA-6901P', 'JE50_HR', 'Compal', 'compal_la', 'manual',
        [],
        []),
    ('NoBrand', 'GenericLaptop', None, 'XYZ-9999', None, None, None, 'manual',
        [],
        []),
]


def build_fixture(db_path: Path):
    """Create a pre-v2 boards.db at db_path with the fixture data."""
    conn = sqlite3.connect(db_path)
    conn.executescript(PRE_V2_SCHEMA)
    cur = conn.cursor()
    for row in FIXTURE_DATA:
        brand, model, model_number, board_number, board_name, odm, btype, source, aliases, m_aliases = row
        cur.execute(
            "INSERT INTO boards (brand, model, model_number, board_number, board_name, odm, board_number_type, source) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (brand, model, model_number, board_number, board_name, odm, btype, source),
        )
        bid = cur.lastrowid
        for a, atype in aliases:
            cur.execute(
                "INSERT INTO board_aliases (board_id, alias_number, alias_type) VALUES (?, ?, ?)",
                (bid, a, atype),
            )
        for ma in m_aliases:
            cur.execute(
                "INSERT INTO model_aliases (board_id, model_name) VALUES (?, ?)",
                (bid, ma),
            )
    conn.commit()
    conn.close()


def run_migration(db_path: Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(MIGRATE_SCRIPT), str(db_path)],
        capture_output=True, text=True,
    )


class MigrationTests(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.db_path = Path(self.tmpdir) / 'fixture.db'
        build_fixture(self.db_path)

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def conn(self):
        return sqlite3.connect(self.db_path)

    def test_migration_runs_clean(self):
        result = run_migration(self.db_path)
        self.assertEqual(result.returncode, 0,
                         f"migration failed: stdout={result.stdout} stderr={result.stderr}")

    def test_schema_version_is_2(self):
        run_migration(self.db_path)
        with self.conn() as c:
            self.assertEqual(c.execute("SELECT version FROM schema_version").fetchone()[0], 2)


if __name__ == '__main__':
    unittest.main()
