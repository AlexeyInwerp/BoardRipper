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

    def test_migration_runs_without_crashing(self):
        # Fixture intentionally includes a NoBrand row that triggers the fallback warning,
        # so exit 1 is the expected non-error outcome. Assert no crash and no exception.
        result = run_migration(self.db_path)
        self.assertIn(result.returncode, (0, 1),
                      f"unexpected exit: returncode={result.returncode} "
                      f"stderr={result.stderr}")
        self.assertNotIn("Traceback", result.stderr,
                         f"migration crashed: stderr={result.stderr}")

    def test_schema_version_is_2(self):
        run_migration(self.db_path)
        with self.conn() as c:
            self.assertEqual(c.execute("SELECT version FROM schema_version").fetchone()[0], 2)

    def test_entity_counts(self):
        run_migration(self.db_path)
        with self.conn() as c:
            n_brands = c.execute("SELECT count(*) FROM brands").fetchone()[0]
            n_families = c.execute("SELECT count(*) FROM families").fetchone()[0]
            n_models = c.execute("SELECT count(*) FROM models").fetchone()[0]
            n_boards = c.execute("SELECT count(*) FROM boards").fetchone()[0]
        # Fixture has 5 distinct brands (Apple, Lenovo, Dell, Acer, NoBrand), 8 boards,
        # and at least 6 distinct (brand, model_number) pairs => 6+ models.
        self.assertEqual(n_brands, 5)
        self.assertGreaterEqual(n_families, 5)
        self.assertGreaterEqual(n_models, 6)
        self.assertEqual(n_boards, 8)

    def test_every_board_has_full_chain(self):
        run_migration(self.db_path)
        with self.conn() as c:
            row = c.execute("""
                SELECT count(*) FROM boards b
                LEFT JOIN models m ON b.model_uuid = m.uuid
                LEFT JOIN families f ON m.family_uuid = f.uuid
                LEFT JOIN brands br ON f.brand_uuid = br.uuid
                WHERE m.uuid IS NULL OR f.uuid IS NULL OR br.uuid IS NULL
            """).fetchone()[0]
        self.assertEqual(row, 0, "every board must reach a brand via JOINs")

    def test_uuid_uniqueness(self):
        run_migration(self.db_path)
        with self.conn() as c:
            for table in ('brands', 'families', 'models', 'boards', 'board_aliases', 'model_aliases'):
                dupes = c.execute(
                    f"SELECT count(*) FROM (SELECT uuid FROM {table} GROUP BY uuid HAVING count(*) > 1)"
                ).fetchone()[0]
                self.assertEqual(dupes, 0, f"{table} has duplicate UUIDs")

    def test_apple_macbook_pro_family_extracted(self):
        run_migration(self.db_path)
        with self.conn() as c:
            row = c.execute("""
                SELECT br.name, f.name, m.model_number, b.board_number
                FROM boards b
                JOIN models m ON b.model_uuid = m.uuid
                JOIN families f ON m.family_uuid = f.uuid
                JOIN brands br ON f.brand_uuid = br.uuid
                WHERE b.board_number = '820-00239-A'
            """).fetchone()
        self.assertEqual(row, ('Apple', 'MacBook Pro', 'A1706', '820-00239-A'))

    def test_lenovo_legion_family_extracted(self):
        run_migration(self.db_path)
        with self.conn() as c:
            row = c.execute("""
                SELECT f.name FROM boards b
                JOIN models m ON b.model_uuid = m.uuid
                JOIN families f ON m.family_uuid = f.uuid
                WHERE b.board_number = 'NM-D862'
            """).fetchone()
        self.assertEqual(row[0], 'Legion')

    def test_brand_fallback_for_nobrand_row(self):
        # NoBrand fixture row should land in the '_' fallback ('Uncategorized')
        # AND the migration should have warned + exited non-zero.
        result = run_migration(self.db_path)
        self.assertNotEqual(result.returncode, 0,
                            "expected non-zero exit when family fallbacks were used")
        with self.conn() as c:
            row = c.execute("""
                SELECT f.name FROM boards b
                JOIN models m ON b.model_uuid = m.uuid
                JOIN families f ON m.family_uuid = f.uuid
                WHERE b.board_number = 'XYZ-9999'
            """).fetchone()
        self.assertEqual(row[0], 'Uncategorized')

    def test_old_columns_dropped(self):
        run_migration(self.db_path)
        with self.conn() as c:
            cols = [r[1] for r in c.execute("PRAGMA table_info(boards)")]
        self.assertNotIn('brand', cols)
        self.assertNotIn('model', cols)
        self.assertNotIn('model_number', cols)
        self.assertIn('uuid', cols)
        self.assertIn('model_uuid', cols)

    def test_aliases_carried_over(self):
        run_migration(self.db_path)
        with self.conn() as c:
            n = c.execute("SELECT count(*) FROM board_aliases").fetchone()[0]
            n_m = c.execute("SELECT count(*) FROM model_aliases").fetchone()[0]
        # Fixture has 8 board aliases, 3 model aliases.
        self.assertEqual(n, 8)
        self.assertEqual(n_m, 3)

    def test_model_alias_type_inference(self):
        run_migration(self.db_path)
        with self.conn() as c:
            row = c.execute(
                "SELECT alias_type FROM model_aliases WHERE alias = 'MacBookPro13,2'"
            ).fetchone()
        self.assertEqual(row[0], 'apple_model_id')

    def test_idempotent(self):
        # First run migrates; assert non-zero exit due to NoBrand fallback warning.
        first = run_migration(self.db_path)
        self.assertNotEqual(first.returncode, 0)
        # Second run should be a clean no-op.
        second = run_migration(self.db_path)
        self.assertEqual(second.returncode, 0)
        self.assertIn("already at schema version", second.stdout)


if __name__ == '__main__':
    unittest.main()
