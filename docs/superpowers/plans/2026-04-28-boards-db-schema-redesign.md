# boards.db v2 Schema Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate `boards.db` from a flat `boards` table with denormalized brand/model strings to a four-level entity hierarchy (Brand → Family → Model → Board), all UUID-keyed, with cascading metadata via `entity_color`. Propagate the new fields through the Go resolver, the databank cache, and the Library panel UI.

**Architecture:** A one-shot Python migration script does the heavy lift on `boards.db` itself — creates the new tables, populates them by parsing the existing flat data with a hand-coded family-extraction pattern table, drops the obsolete columns. The Go resolver gets a 4-JOIN query with a `COALESCE` color cascade. Databank cache and Library panel changes mirror the v1 plan (board_uuid + board_color denormalization), since the wire shape doesn't change — only the source.

**Tech Stack:** Python 3 stdlib (`sqlite3`, `uuid`, `re`), SQLite 3.35+ (for `ALTER TABLE DROP COLUMN`), Go 1.22 (modernc.org/sqlite driver), TypeScript + React 19.

**Spec:** [docs/superpowers/specs/2026-04-28-boards-db-schema-redesign-design.md](../specs/2026-04-28-boards-db-schema-redesign-design.md)

---

## File map

| File | Action | Responsibility |
|------|--------|----------------|
| `scripts/migrate-boarddb-v2.py` | CREATE | One-shot migration script: pre-v2 → v2 |
| `scripts/test_migrate_boarddb_v2.py` | CREATE | Tests for the migration against a fixture DB |
| `Board Database/boards.db` | MUTATE | Migrated in place |
| `Board Database/create_mockup_db.sql` | MODIFY | New v2-shape schema (rewrite) |
| `Board Database/build_full_db.sql.archived` | RENAME | Old data file kept for historical reference |
| `src/backend/boarddb/boarddb.go` | MODIFY | `BoardMatch` adds UUID, Family, Color fields |
| `src/backend/boarddb/resolve.go` | MODIFY | New 4-JOIN resolver query + alias key changes |
| `src/backend/databank/db.go` | MODIFY | Schema migration v6 + FileRecord shape |
| `src/backend/databank/metadata.go` | MODIFY | Pass UUID/Color from match → Metadata |
| `src/frontend/src/store/databank-store.ts` | MODIFY | DatabankFile interface adds board_uuid + board_color |
| `src/frontend/src/panels/LibraryPanel.tsx` | MODIFY | "Color: <name>" row in detail meta |

---

## Task 1: Migration script — fixture and scaffold

**Files:**
- Create: `scripts/migrate-boarddb-v2.py`
- Create: `scripts/test_migrate_boarddb_v2.py`

- [ ] **Step 1: Create the test fixture builder**

Create `scripts/test_migrate_boarddb_v2.py` with a fixture that mirrors the diverse real cases:

```python
#!/usr/bin/env python3
"""Tests for migrate-boarddb-v2.py against a synthetic fixture."""
import os
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
        for f in Path(self.tmpdir).glob('*'):
            f.unlink()
        os.rmdir(self.tmpdir)

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
```

- [ ] **Step 2: Verify the fixture builder works in isolation**

Run:

```bash
python3 -c "
import sys, tempfile
from pathlib import Path
sys.path.insert(0, 'scripts')
from test_migrate_boarddb_v2 import build_fixture
import sqlite3
p = Path(tempfile.mktemp(suffix='.db'))
build_fixture(p)
c = sqlite3.connect(p)
print('boards:', c.execute('SELECT count(*) FROM boards').fetchone()[0])
print('aliases:', c.execute('SELECT count(*) FROM board_aliases').fetchone()[0])
print('m_aliases:', c.execute('SELECT count(*) FROM model_aliases').fetchone()[0])
p.unlink()
"
```

Expected: `boards: 8`, `aliases: 7`, `m_aliases: 3`. (Counts derived from `FIXTURE_DATA`.)

- [ ] **Step 3: Create the migration script scaffold**

Create `scripts/migrate-boarddb-v2.py`:

```python
#!/usr/bin/env python3
"""
One-shot migration: boards.db pre-v2 → v2 (entity hierarchy).

Builds Brand → Family → Model → Board hierarchy from the existing flat
boards table, with a hand-coded family-extraction pattern table.

Idempotent: detects v2 and exits 0 cleanly. Atomic: runs in one transaction;
any failure rolls back.

Usage:
    python3 scripts/migrate-boarddb-v2.py "Board Database/boards.db"
"""
import re
import sqlite3
import sys
import uuid
from pathlib import Path

# Family-extraction pattern table (brand, model_regex, family_name).
# Evaluated in order; first match wins. Anything that doesn't match falls
# through to BRAND_FALLBACK[brand] (or BRAND_FALLBACK['_'] if brand absent).
FAMILY_PATTERNS = [
    ('Apple',  r'^MacBook Pro\b',       'MacBook Pro'),
    ('Apple',  r'^MacBook Air\b',       'MacBook Air'),
    ('Apple',  r'^MacBook\b',           'MacBook'),
    ('Apple',  r'^iMac\b',              'iMac'),
    ('Apple',  r'^Mac mini\b',          'Mac mini'),
    ('Apple',  r'^Mac Pro\b',           'Mac Pro'),
    ('Apple',  r'^Mac Studio\b',        'Mac Studio'),
    ('Lenovo', r'^ThinkPad\b',          'ThinkPad'),
    ('Lenovo', r'^Legion\b',            'Legion'),
    ('Lenovo', r'^IdeaPad\b',           'IdeaPad'),
    ('Lenovo', r'^Yoga\b',              'Yoga'),
    ('Lenovo', r'^ThinkBook\b',         'ThinkBook'),
    ('Dell',   r'^Inspiron\b',          'Inspiron'),
    ('Dell',   r'^Latitude\b',          'Latitude'),
    ('Dell',   r'^XPS\b',               'XPS'),
    ('Dell',   r'^Precision\b',         'Precision'),
    ('Dell',   r'^Vostro\b',            'Vostro'),
    ('Dell',   r'^Alienware\b',         'Alienware'),
    ('HP',     r'^EliteBook\b',         'EliteBook'),
    ('HP',     r'^ProBook\b',           'ProBook'),
    ('HP',     r'^Pavilion\b',          'Pavilion'),
    ('HP',     r'^Spectre\b',           'Spectre'),
    ('HP',     r'^Omen\b',              'Omen'),
    ('HP',     r'^ZBook\b',             'ZBook'),
    ('Acer',   r'^Aspire\b',            'Aspire'),
    ('Acer',   r'^Predator\b',          'Predator'),
    ('Acer',   r'^Swift\b',             'Swift'),
    ('Asus',   r'^ZenBook\b',           'ZenBook'),
    ('Asus',   r'^VivoBook\b',          'VivoBook'),
    ('Asus',   r'^ROG\b',               'ROG'),
    ('Asus',   r'^TUF\b',               'TUF'),
]

BRAND_FALLBACK = {
    'Apple':  'Mac (other)',
    'Lenovo': 'Laptop',
    'Dell':   'Laptop',
    'HP':     'Laptop',
    'Acer':   'Laptop',
    'Asus':   'Laptop',
    'MSI':    'Laptop',
    '_':      'Uncategorized',
}

COLOR_SEED = [
    (1, 'black', 1),  (2, 'red', 2),    (3, 'green', 3),  (4, 'blue', 4),
    (5, 'white', 5),  (6, 'yellow', 6), (7, 'purple', 7), (8, 'orange', 8),
    (9, 'pink', 9),   (10, 'brown', 10),(11, 'silver', 11),(12, 'gold', 12),
]


def gen_uuid() -> str:
    return str(uuid.uuid4())


def derive_family(brand: str, model: str | None) -> tuple[str, bool]:
    """Return (family_name, was_matched). False = used fallback."""
    if model:
        for pat_brand, pat_re, fam in FAMILY_PATTERNS:
            if pat_brand == brand and re.search(pat_re, model):
                return fam, True
    return BRAND_FALLBACK.get(brand, BRAND_FALLBACK['_']), False


def get_schema_version(conn: sqlite3.Connection) -> int:
    cur = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'"
    )
    if cur.fetchone() is None:
        return 0  # legend: 0 = pre-v2 (no version table)
    row = conn.execute("SELECT version FROM schema_version LIMIT 1").fetchone()
    return row[0] if row else 0


def main():
    if len(sys.argv) != 2:
        print(f"usage: {sys.argv[0]} <path-to-boards.db>", file=sys.stderr)
        sys.exit(2)
    db_path = Path(sys.argv[1])
    if not db_path.exists():
        print(f"error: {db_path} does not exist", file=sys.stderr)
        sys.exit(1)

    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA foreign_keys=ON")

    ver = get_schema_version(conn)
    if ver >= 2:
        print(f"already at schema version {ver}; nothing to do.")
        conn.close()
        sys.exit(0)

    print("starting migration to v2…")
    try:
        conn.execute("BEGIN")
        # Steps 1-13 from the spec. Implemented in subsequent tasks.
        # PLACEHOLDER: real implementation lives in Task 1 Step 5+.
        raise NotImplementedError("Task 1 only stubs main(); steps fill in")
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


if __name__ == '__main__':
    main()
```

- [ ] **Step 4: Make the script executable**

Run:

```bash
chmod +x scripts/migrate-boarddb-v2.py scripts/test_migrate_boarddb_v2.py
```

- [ ] **Step 5: Verify the test runner can find the script and the smoke-test fails as expected**

Run:

```bash
cd /Users/besitzer/Desktop/Boardviewer && python3 scripts/test_migrate_boarddb_v2.py -v 2>&1 | tail -20
```

Expected: 2 tests run, both FAIL (because `main()` raises `NotImplementedError`). This is the expected red state — we have a failing test to drive the next steps.

- [ ] **Step 6: Commit the scaffold + tests**

```bash
git add scripts/migrate-boarddb-v2.py scripts/test_migrate_boarddb_v2.py
git commit -m "$(cat <<'EOF'
feat(boarddb): scaffold v2 migration script + tests

One-shot Python script that walks pre-v2 boards.db and produces
the v2 entity hierarchy. This commit ships the scaffold:
- Family-extraction pattern table (~30 patterns + per-brand fallback)
- Color seed for the colors lookup table
- Schema-version detection + idempotency guard
- Test fixture with 8 representative rows across Apple / Lenovo /
  Dell / Acer + a no-brand row to exercise the fallback path
- Two smoke tests (currently failing — main() is a stub)

Implementation steps follow in subsequent commits.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Migration script — entity hierarchy creation

**Files:**
- Modify: `scripts/migrate-boarddb-v2.py`
- Modify: `scripts/test_migrate_boarddb_v2.py`

- [ ] **Step 1: Replace the stubbed `main()` body with real migration logic**

In `scripts/migrate-boarddb-v2.py`, replace the `try` block in `main()` (the part after `print("starting migration to v2…")`) with:

```python
    try:
        conn.execute("BEGIN")

        # 1. Bootstrap schema_version
        conn.execute("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)")
        if conn.execute("SELECT count(*) FROM schema_version").fetchone()[0] == 0:
            conn.execute("INSERT INTO schema_version (version) VALUES (1)")

        # 2. Create colors lookup table and seed
        conn.execute("""
            CREATE TABLE IF NOT EXISTS colors (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL UNIQUE,
                hex TEXT,
                sort_order INTEGER NOT NULL DEFAULT 0
            )
        """)
        conn.executemany(
            "INSERT OR IGNORE INTO colors (id, name, sort_order) VALUES (?, ?, ?)",
            COLOR_SEED,
        )

        # 3. Create entity tables
        conn.executescript("""
            CREATE TABLE brands (
                uuid TEXT PRIMARY KEY,
                name TEXT NOT NULL UNIQUE,
                notes TEXT
            );
            CREATE TABLE families (
                uuid TEXT PRIMARY KEY,
                brand_uuid TEXT NOT NULL REFERENCES brands(uuid) ON DELETE CASCADE,
                name TEXT NOT NULL,
                notes TEXT,
                UNIQUE (brand_uuid, name)
            );
            CREATE INDEX idx_families_brand ON families(brand_uuid);
            CREATE TABLE models (
                uuid TEXT PRIMARY KEY,
                family_uuid TEXT NOT NULL REFERENCES families(uuid) ON DELETE CASCADE,
                model_number TEXT NOT NULL,
                display_name TEXT,
                notes TEXT,
                UNIQUE (family_uuid, model_number)
            );
            CREATE INDEX idx_models_family ON models(family_uuid);
            CREATE INDEX idx_models_number ON models(model_number);
            CREATE TABLE boards_v2 (
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
            CREATE INDEX idx_boards_v2_model ON boards_v2(model_uuid);
            CREATE INDEX idx_boards_v2_number ON boards_v2(board_number);
            CREATE TABLE board_aliases_v2 (
                uuid TEXT PRIMARY KEY,
                board_uuid TEXT NOT NULL REFERENCES boards_v2(uuid) ON DELETE CASCADE,
                alias TEXT NOT NULL,
                alias_type TEXT,
                UNIQUE (alias, alias_type)
            );
            CREATE INDEX idx_baliases_v2_alias ON board_aliases_v2(alias);
            CREATE TABLE model_aliases_v2 (
                uuid TEXT PRIMARY KEY,
                model_uuid TEXT NOT NULL REFERENCES models(uuid) ON DELETE CASCADE,
                alias TEXT NOT NULL,
                alias_type TEXT,
                UNIQUE (alias, alias_type)
            );
            CREATE INDEX idx_maliases_v2_alias ON model_aliases_v2(alias);
            CREATE TABLE entity_color (
                scope_type TEXT NOT NULL CHECK(scope_type IN ('brand','family','model','board')),
                scope_uuid TEXT NOT NULL,
                color_id INTEGER NOT NULL REFERENCES colors(id),
                PRIMARY KEY (scope_type, scope_uuid)
            );
            CREATE INDEX idx_entity_color_uuid ON entity_color(scope_uuid);
            CREATE TABLE board_openboarddata (
                board_uuid TEXT NOT NULL REFERENCES boards_v2(uuid) ON DELETE CASCADE,
                external_id TEXT NOT NULL,
                notes TEXT,
                PRIMARY KEY (board_uuid, external_id)
            );
            CREATE INDEX idx_obd_board ON board_openboarddata(board_uuid);
        """)

        # 4. Populate brands
        brands = {}
        for (brand,) in conn.execute("SELECT DISTINCT brand FROM boards"):
            u = gen_uuid()
            brands[brand] = u
            conn.execute("INSERT INTO brands (uuid, name) VALUES (?, ?)", (u, brand))

        # 5. Populate families (with unmatched-pattern logging)
        families = {}  # (brand_uuid, family_name) -> uuid
        unmatched_count = 0
        for board in conn.execute(
            "SELECT brand, model FROM boards"
        ).fetchall():
            brand, model = board
            family, matched = derive_family(brand, model)
            if not matched:
                unmatched_count += 1
                print(f"  [family fallback] brand={brand!r} model={model!r} -> {family!r}",
                      file=sys.stderr)
            key = (brands[brand], family)
            if key not in families:
                u = gen_uuid()
                families[key] = u
                conn.execute(
                    "INSERT INTO families (uuid, brand_uuid, name) VALUES (?, ?, ?)",
                    (u, brands[brand], family),
                )

        # 6. Populate models
        # Key: (brand, model_number) -> models.uuid; display_name = first encountered boards.model
        models = {}
        for brand, model_text, model_number in conn.execute(
            "SELECT brand, model, model_number FROM boards"
        ).fetchall():
            mkey = (brand, model_number or '')
            if mkey in models:
                continue
            family, _ = derive_family(brand, model_text)
            family_uuid = families[(brands[brand], family)]
            u = gen_uuid()
            models[mkey] = u
            # model_number can be NULL/empty; treat empty as canonical placeholder
            mn = model_number if model_number else '(unknown)'
            conn.execute(
                "INSERT INTO models (uuid, family_uuid, model_number, display_name) VALUES (?, ?, ?, ?)",
                (u, family_uuid, mn, model_text),
            )

        # 7. Populate boards_v2 with fresh UUIDs
        old_to_new = {}  # old boards.id -> new boards_v2.uuid
        for old_id, brand, model_number, board_number, board_name, odm, btype, source, source_url in conn.execute("""
            SELECT id, brand, model_number, board_number, board_name, odm,
                   board_number_type, source, source_url FROM boards
        """):
            mkey = (brand, model_number or '')
            new_uuid = gen_uuid()
            old_to_new[old_id] = (new_uuid, models[mkey])
            conn.execute("""
                INSERT INTO boards_v2 (uuid, model_uuid, board_number, board_name, odm,
                                       board_number_type, source, source_url)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """, (new_uuid, models[mkey], board_number, board_name, odm, btype, source, source_url))

        # 8. Populate board_aliases_v2
        for old_id, alias, alias_type in conn.execute(
            "SELECT board_id, alias_number, alias_type FROM board_aliases"
        ):
            new_uuid, _ = old_to_new[old_id]
            conn.execute(
                "INSERT OR IGNORE INTO board_aliases_v2 (uuid, board_uuid, alias, alias_type) "
                "VALUES (?, ?, ?, ?)",
                (gen_uuid(), new_uuid, alias, alias_type),
            )

        # 9. Populate model_aliases_v2 (semantic fix: now keyed by model_uuid, deduplicated)
        seen = set()
        for old_id, alias in conn.execute(
            "SELECT board_id, model_name FROM model_aliases"
        ):
            _, model_uuid = old_to_new[old_id]
            key = (model_uuid, alias)
            if key in seen:
                continue
            seen.add(key)
            # alias_type: marketing-style strings get 'apple_marketing', OS-style identifiers
            # like 'MacBookPro13,3' get 'apple_model_id'. Heuristic: comma-prefixed = OS id.
            alias_type = 'apple_model_id' if ',' in alias else 'oem_marketing'
            conn.execute(
                "INSERT OR IGNORE INTO model_aliases_v2 (uuid, model_uuid, alias, alias_type) "
                "VALUES (?, ?, ?, ?)",
                (gen_uuid(), model_uuid, alias, alias_type),
            )

        # 10. Drop obsolete tables and rename _v2 → final names
        conn.executescript("""
            DROP TABLE board_aliases;
            DROP TABLE model_aliases;
            DROP TABLE boards;
            ALTER TABLE boards_v2 RENAME TO boards;
            ALTER TABLE board_aliases_v2 RENAME TO board_aliases;
            ALTER TABLE model_aliases_v2 RENAME TO model_aliases;
            -- Recreate indexes that referenced _v2 names
            DROP INDEX IF EXISTS idx_boards_v2_model;
            DROP INDEX IF EXISTS idx_boards_v2_number;
            DROP INDEX IF EXISTS idx_baliases_v2_alias;
            DROP INDEX IF EXISTS idx_maliases_v2_alias;
            CREATE INDEX idx_boards_model ON boards(model_uuid);
            CREATE INDEX idx_boards_number ON boards(board_number);
            CREATE INDEX idx_board_aliases_alias ON board_aliases(alias);
            CREATE INDEX idx_model_aliases_alias ON model_aliases(alias);
        """)

        # 11. Bump schema_version
        conn.execute("UPDATE schema_version SET version = 2")

        conn.commit()
        n_boards = conn.execute("SELECT count(*) FROM boards").fetchone()[0]
        n_models = conn.execute("SELECT count(*) FROM models").fetchone()[0]
        n_families = conn.execute("SELECT count(*) FROM families").fetchone()[0]
        n_brands = conn.execute("SELECT count(*) FROM brands").fetchone()[0]
        print(f"migration complete: {n_brands} brands, {n_families} families, "
              f"{n_models} models, {n_boards} boards")
        if unmatched_count > 0:
            print(f"warning: {unmatched_count} board(s) fell back to brand-default family. "
                  f"Add patterns to FAMILY_PATTERNS to fix.", file=sys.stderr)
            sys.exit(1)
    except Exception as e:
        conn.rollback()
        print(f"migration failed: {e}", file=sys.stderr)
        raise
    finally:
        conn.close()
```

- [ ] **Step 2: Add structural assertions to the test suite**

In `scripts/test_migrate_boarddb_v2.py`, add these test methods to the `MigrationTests` class (place them after `test_schema_version_is_2`):

```python
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
        # Fixture has 7 board aliases, 3 model aliases.
        self.assertEqual(n, 7)
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
```

- [ ] **Step 3: Run tests and watch them progress through pass/fail**

Run:

```bash
cd /Users/besitzer/Desktop/Boardviewer && python3 scripts/test_migrate_boarddb_v2.py -v 2>&1 | tail -40
```

Expected:
- `test_apple_macbook_pro_family_extracted` — PASS
- `test_brand_fallback_for_nobrand_row` — PASS (returncode=1 because of unmatched fallback)
- `test_entity_counts` — PASS
- `test_every_board_has_full_chain` — PASS
- `test_idempotent` — PASS
- `test_lenovo_legion_family_extracted` — PASS
- `test_migration_runs_clean` — **FAIL** (returncode=1 due to NoBrand fallback)
- `test_model_alias_type_inference` — PASS
- `test_old_columns_dropped` — PASS
- `test_schema_version_is_2` — PASS
- `test_uuid_uniqueness` — PASS
- `test_aliases_carried_over` — PASS

The single failure (`test_migration_runs_clean`) is the engineer's signal that "exit non-zero on fallback" is a feature; the test that asserts clean exit is the wrong test for a fixture that intentionally includes a fallback row.

- [ ] **Step 4: Fix the misleading "runs clean" test to allow either 0 or 1 exit code**

In `scripts/test_migrate_boarddb_v2.py`, replace `test_migration_runs_clean` with:

```python
    def test_migration_runs_without_crashing(self):
        # Fixture intentionally includes a NoBrand row that triggers the fallback warning,
        # so exit 1 is the expected non-error outcome. Assert no crash and no exception.
        result = run_migration(self.db_path)
        self.assertIn(result.returncode, (0, 1),
                      f"unexpected exit: returncode={result.returncode} "
                      f"stderr={result.stderr}")
        self.assertNotIn("Traceback", result.stderr,
                         f"migration crashed: stderr={result.stderr}")
```

- [ ] **Step 5: Re-run the full test suite, confirm all green**

Run:

```bash
cd /Users/besitzer/Desktop/Boardviewer && python3 scripts/test_migrate_boarddb_v2.py -v 2>&1 | tail -20
```

Expected: 12 tests, all PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/migrate-boarddb-v2.py scripts/test_migrate_boarddb_v2.py
git commit -m "$(cat <<'EOF'
feat(boarddb): implement v2 migration logic with full test coverage

Migration walks the pre-v2 boards table and produces:
- brands  (one per DISTINCT brand)
- families (extracted via FAMILY_PATTERNS, brand-fallback otherwise)
- models  (one per (brand, model_number); display_name = old boards.model)
- boards  (fresh UUIDs, model_uuid FK populated)
- board_aliases (renamed alias_number -> alias, fresh row UUIDs)
- model_aliases (semantic fix: now keyed by model_uuid, deduplicated;
  alias_type heuristically inferred 'apple_model_id' when comma-suffixed)
- entity_color (empty)
- board_openboarddata (empty)
- colors (12-entry palette, INSERT OR IGNORE)
- schema_version = 2

12 unit tests cover entity counts, JOIN chain integrity, UUID uniqueness,
family extraction (Apple MacBook Pro / Lenovo Legion), brand fallback,
old-column drop, alias preservation, alias-type inference, idempotency,
and crash-free execution.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Run migration on real `boards.db`

**Files:**
- Mutate: `Board Database/boards.db`

- [ ] **Step 1: Make a backup**

Run:

```bash
cp "Board Database/boards.db" "Board Database/boards.db.pre-v2-backup"
```

The backup is throwaway — committed only if something goes wrong. We delete it at the end of this task.

- [ ] **Step 2: Run the migration**

Run:

```bash
python3 scripts/migrate-boarddb-v2.py "Board Database/boards.db"
```

Expected:
- Stderr: zero or more `[family fallback]` warnings, one per board whose marketing string didn't match any `FAMILY_PATTERNS` regex.
- Stdout: `migration complete: N brands, N families, N models, N boards`.
- Exit code: 0 if no fallbacks were needed, 1 if any board fell back. Either is acceptable here — fallback rows are still migrated correctly, just into `'Laptop'` / `'Mac (other)'` / `'Uncategorized'`.

- [ ] **Step 3: Review fallback warnings (if any)**

If stderr listed any `[family fallback]` warnings, decide whether to extend `FAMILY_PATTERNS` to capture them:

- For brands you recognize (e.g., a new HP family the pattern table missed), add the pattern, then re-run from Step 1 (restore from backup, re-migrate).
- For genuinely uncategorized rows (no clear family), leave the fallback in place.

Run:

```bash
sqlite3 "Board Database/boards.db" "
  SELECT br.name AS brand, f.name AS family, count(*) AS boards
  FROM boards b JOIN models m ON b.model_uuid = m.uuid
  JOIN families f ON m.family_uuid = f.uuid
  JOIN brands br ON f.brand_uuid = br.uuid
  WHERE f.name IN ('Laptop','Desktop','Mac (other)','Uncategorized')
  GROUP BY br.name, f.name
  ORDER BY boards DESC;
"
```

Expected: a small table showing how many boards landed in fallback families per brand. If any line has a high count for a brand whose family is well-known, extend `FAMILY_PATTERNS` and re-run.

- [ ] **Step 4: Verify schema and counts**

Run:

```bash
sqlite3 "Board Database/boards.db" <<'EOF'
.schema brands
.schema families
.schema models
.schema boards
.schema entity_color
SELECT version FROM schema_version;
SELECT
  (SELECT count(*) FROM brands)        AS brands,
  (SELECT count(*) FROM families)      AS families,
  (SELECT count(*) FROM models)        AS models,
  (SELECT count(*) FROM boards)        AS boards,
  (SELECT count(*) FROM board_aliases) AS board_aliases,
  (SELECT count(*) FROM model_aliases) AS model_aliases,
  (SELECT count(*) FROM colors)        AS colors;
EOF
```

Expected:
- Schemas match the spec.
- `schema_version` = 2.
- `colors` = 12.
- `boards` count matches the count from the pre-migration backup (`sqlite3 "Board Database/boards.db.pre-v2-backup" "SELECT count(*) FROM boards"`).
- `brands`, `families`, `models` are sensible counts (typically 5–15, 10–30, 50–150 respectively, depending on how rich the source data is).

- [ ] **Step 5: Verify JOIN chain integrity**

Run:

```bash
sqlite3 "Board Database/boards.db" "
  SELECT count(*) FROM boards b
  LEFT JOIN models m ON b.model_uuid = m.uuid
  LEFT JOIN families f ON m.family_uuid = f.uuid
  LEFT JOIN brands br ON f.brand_uuid = br.uuid
  WHERE m.uuid IS NULL OR f.uuid IS NULL OR br.uuid IS NULL;
"
```

Expected: `0`. Every board reaches a brand.

- [ ] **Step 6: Spot-check a few representative rows**

Run:

```bash
sqlite3 -header -column "Board Database/boards.db" "
  SELECT br.name AS brand, f.name AS family, m.model_number, m.display_name AS model, b.board_number
  FROM boards b
  JOIN models m ON b.model_uuid = m.uuid
  JOIN families f ON m.family_uuid = f.uuid
  JOIN brands br ON f.brand_uuid = br.uuid
  WHERE b.board_number IN ('820-02016-A','NM-A251','DA0R09MB6H1','LA-6901P')
  ORDER BY br.name, b.board_number;
"
```

Expected:
- `820-02016-A` → Apple / MacBook Air / A2337 / "MacBook Air 13\" M1 Late 2020"
- `DA0R09MB6H1` → Dell / Inspiron / N5720
- `NM-A251` → Lenovo / ThinkPad / 20BU/20BX
- `LA-6901P` → Acer / Aspire / NV57H

Specifically: the family column shows the extracted family, not the brand fallback.

- [ ] **Step 7: Delete the backup**

Migration succeeded. Run:

```bash
rm "Board Database/boards.db.pre-v2-backup"
```

- [ ] **Step 8: Commit the migrated DB**

```bash
git add "Board Database/boards.db"
# Track the WAL/SHM sidecars only if they're already tracked
git ls-files "Board Database/boards.db-shm" 2>/dev/null && git add "Board Database/boards.db-shm"
git ls-files "Board Database/boards.db-wal" 2>/dev/null && git add "Board Database/boards.db-wal"
git commit -m "$(cat <<'EOF'
build(boarddb): migrate boards.db to v2 (entity hierarchy)

Ran scripts/migrate-boarddb-v2.py on Board Database/boards.db.
Pre-v2 flat schema replaced with Brand → Family → Model → Board
hierarchy plus colors / entity_color / board_openboarddata
metadata tables. schema_version = 2.

Old build_full_db.sql is retained as historical seed documentation;
new edits flow through the (forthcoming) Database Editor or via
small targeted migration scripts.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Update `create_mockup_db.sql` to v2 shape

**Files:**
- Modify: `Board Database/create_mockup_db.sql`
- Rename: `Board Database/build_full_db.sql` → `Board Database/build_full_db.sql.archived`

- [ ] **Step 1: Replace the entire `create_mockup_db.sql` with the v2 schema**

Overwrite `Board Database/create_mockup_db.sql` with:

```sql
-- Board Database v2 — Schema Bootstrap
-- For fresh-environment bootstrap. Edits to data flow through migrations
-- or the future Database Editor; this file produces an empty v2-shape DB.

PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
INSERT OR IGNORE INTO schema_version (version) VALUES (2);

-- ============================================================
-- Reference palette
-- ============================================================
CREATE TABLE IF NOT EXISTS colors (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    hex TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO colors (id, name, sort_order) VALUES
    (1,'black',1),  (2,'red',2),    (3,'green',3),  (4,'blue',4),
    (5,'white',5),  (6,'yellow',6), (7,'purple',7), (8,'orange',8),
    (9,'pink',9),   (10,'brown',10),(11,'silver',11),(12,'gold',12);

-- ============================================================
-- Entity hierarchy
-- ============================================================
CREATE TABLE IF NOT EXISTS brands (
    uuid TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    notes TEXT
);

CREATE TABLE IF NOT EXISTS families (
    uuid TEXT PRIMARY KEY,
    brand_uuid TEXT NOT NULL REFERENCES brands(uuid) ON DELETE CASCADE,
    name TEXT NOT NULL,
    notes TEXT,
    UNIQUE (brand_uuid, name)
);
CREATE INDEX IF NOT EXISTS idx_families_brand ON families(brand_uuid);

CREATE TABLE IF NOT EXISTS models (
    uuid TEXT PRIMARY KEY,
    family_uuid TEXT NOT NULL REFERENCES families(uuid) ON DELETE CASCADE,
    model_number TEXT NOT NULL,
    display_name TEXT,
    notes TEXT,
    UNIQUE (family_uuid, model_number)
);
CREATE INDEX IF NOT EXISTS idx_models_family ON models(family_uuid);
CREATE INDEX IF NOT EXISTS idx_models_number ON models(model_number);

CREATE TABLE IF NOT EXISTS boards (
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
CREATE INDEX IF NOT EXISTS idx_boards_model ON boards(model_uuid);
CREATE INDEX IF NOT EXISTS idx_boards_number ON boards(board_number);

-- ============================================================
-- Aliases
-- ============================================================
CREATE TABLE IF NOT EXISTS board_aliases (
    uuid TEXT PRIMARY KEY,
    board_uuid TEXT NOT NULL REFERENCES boards(uuid) ON DELETE CASCADE,
    alias TEXT NOT NULL,
    alias_type TEXT,
    UNIQUE (alias, alias_type)
);
CREATE INDEX IF NOT EXISTS idx_board_aliases_alias ON board_aliases(alias);

CREATE TABLE IF NOT EXISTS model_aliases (
    uuid TEXT PRIMARY KEY,
    model_uuid TEXT NOT NULL REFERENCES models(uuid) ON DELETE CASCADE,
    alias TEXT NOT NULL,
    alias_type TEXT,
    UNIQUE (alias, alias_type)
);
CREATE INDEX IF NOT EXISTS idx_model_aliases_alias ON model_aliases(alias);

-- ============================================================
-- Cascading metadata
-- ============================================================
CREATE TABLE IF NOT EXISTS entity_color (
    scope_type TEXT NOT NULL CHECK(scope_type IN ('brand','family','model','board')),
    scope_uuid TEXT NOT NULL,
    color_id INTEGER NOT NULL REFERENCES colors(id),
    PRIMARY KEY (scope_type, scope_uuid)
);
CREATE INDEX IF NOT EXISTS idx_entity_color_uuid ON entity_color(scope_uuid);

CREATE TABLE IF NOT EXISTS board_openboarddata (
    board_uuid TEXT NOT NULL REFERENCES boards(uuid) ON DELETE CASCADE,
    external_id TEXT NOT NULL,
    notes TEXT,
    PRIMARY KEY (board_uuid, external_id)
);
CREATE INDEX IF NOT EXISTS idx_obd_board ON board_openboarddata(board_uuid);
```

- [ ] **Step 2: Archive `build_full_db.sql`**

Run:

```bash
mv "Board Database/build_full_db.sql" "Board Database/build_full_db.sql.archived"
```

The file is no longer the source of truth. It's preserved (renamed, not deleted) so the historical board data remains discoverable in the repo and can serve as a reference if a future migration needs to reconstruct seed values.

- [ ] **Step 3: Smoke-test the new schema bootstrap**

Run:

```bash
sqlite3 ":memory:" "$(cat 'Board Database/create_mockup_db.sql'; echo; echo '
SELECT name FROM sqlite_master WHERE type=\"table\" ORDER BY name;
SELECT version FROM schema_version;
SELECT count(*) FROM colors;')"
```

Expected output:
```
board_aliases
board_openboarddata
boards
brands
colors
entity_color
families
model_aliases
models
schema_version
sqlite_sequence
2
12
```

(`sqlite_sequence` may or may not be present depending on AUTOINCREMENT use — okay either way.)

- [ ] **Step 4: Commit**

```bash
git add "Board Database/create_mockup_db.sql" "Board Database/build_full_db.sql.archived"
git rm --cached "Board Database/build_full_db.sql" 2>/dev/null || true
git commit -m "$(cat <<'EOF'
build(boarddb): rewrite create_mockup_db.sql to v2 schema; archive build_full_db.sql

create_mockup_db.sql now produces an empty v2-shape DB for
fresh-environment bootstrap. The old data-loading file
build_full_db.sql is preserved as build_full_db.sql.archived,
no longer maintained as a parallel source — boards.db is now
the canonical artifact.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Go boarddb — `BoardMatch` struct and resolver query

**Files:**
- Modify: `src/backend/boarddb/boarddb.go:13-25`
- Modify: `src/backend/boarddb/resolve.go`

- [ ] **Step 1: Update the `BoardMatch` struct**

In `src/backend/boarddb/boarddb.go`, replace lines 13–25 with:

```go
// BoardMatch is the result of resolving a board number against the reference DB.
type BoardMatch struct {
	UUID         string   `json:"uuid"`
	BoardNumber  string   `json:"board_number"`
	Brand        string   `json:"brand"`
	Family       string   `json:"family"`
	Model        string   `json:"model"`
	ModelNumber  string   `json:"model_number,omitempty"`
	BoardName    string   `json:"board_name,omitempty"`
	ODM          string   `json:"odm"`
	Type         string   `json:"board_number_type,omitempty"`
	Color        string   `json:"color,omitempty"`
	Aliases      []string `json:"aliases,omitempty"`
	ModelAliases []string `json:"model_aliases,omitempty"`
	Source       string   `json:"source,omitempty"`
}
```

- [ ] **Step 2: Update the `boardQuery` constant in `resolve.go`**

In `src/backend/boarddb/resolve.go`, replace line 15 (the `const boardQuery` line) with:

```go
const boardQuery = `
SELECT
    b.uuid AS board_uuid,
    b.board_number,
    b.board_name,
    b.odm,
    b.board_number_type,
    b.source,
    m.uuid AS model_uuid,
    m.model_number,
    m.display_name AS model_display,
    f.name AS family_name,
    br.name AS brand_name,
    c.name AS color_name
FROM boards b
JOIN models m   ON b.model_uuid  = m.uuid
JOIN families f ON m.family_uuid = f.uuid
JOIN brands br  ON f.brand_uuid  = br.uuid
LEFT JOIN entity_color ec_b  ON ec_b.scope_type='board'  AND ec_b.scope_uuid = b.uuid
LEFT JOIN entity_color ec_m  ON ec_m.scope_type='model'  AND ec_m.scope_uuid = m.uuid
LEFT JOIN entity_color ec_f  ON ec_f.scope_type='family' AND ec_f.scope_uuid = f.uuid
LEFT JOIN entity_color ec_br ON ec_br.scope_type='brand' AND ec_br.scope_uuid = br.uuid
LEFT JOIN colors c
    ON c.id = COALESCE(ec_b.color_id, ec_m.color_id, ec_f.color_id, ec_br.color_id)
`
```

- [ ] **Step 3: Update the `Resolve` function's WHERE clauses to use `b.` prefix and the new alias keys**

In `src/backend/boarddb/resolve.go`, replace the `Resolve` function (lines 20–64) with:

```go
// Resolve looks up a board number in the reference database.
// Checks: exact → prefix → base number (strip revision) → alias.
// Returns nil if not found.
func (db *DB) Resolve(boardNumber string) *BoardMatch {
	if !db.Available() {
		return nil
	}
	db.mu.RLock()
	defer db.mu.RUnlock()

	upper := strings.ToUpper(strings.TrimSpace(boardNumber))
	if upper == "" {
		return nil
	}

	// 1. Exact match on canonical board_number
	if m := db.queryBoard(boardQuery+" WHERE upper(b.board_number) = ?", upper); m != nil {
		return m
	}

	// 2. Prefix match (820-02016 matches 820-02016-A)
	if m := db.queryBoard(boardQuery+" WHERE upper(b.board_number) LIKE ? LIMIT 1", upper+"-%"); m != nil {
		return m
	}

	// 3. Strip Apple revision suffix (820-02098-H → 820-02098%)
	if base := appleRevisionRe.FindStringSubmatch(upper); base != nil {
		if m := db.queryBoard(boardQuery+" WHERE upper(b.board_number) LIKE ? LIMIT 1", base[1]+"%"); m != nil {
			return m
		}
	}

	// 4. Normalize LCFC no-hyphen format (NMD821 → NM-D821)
	if nm := nmNoHyphenRe.FindStringSubmatch(upper); nm != nil {
		normalized := "NM-" + nm[1]
		if m := db.queryBoard(boardQuery+" WHERE upper(b.board_number) = ?", normalized); m != nil {
			return m
		}
	}

	// 5. Alias match (board_aliases is now keyed by board_uuid)
	var boardUUID string
	err := db.reader.QueryRow(
		"SELECT board_uuid FROM board_aliases WHERE upper(alias) = ? LIMIT 1",
		upper,
	).Scan(&boardUUID)
	if err != nil {
		return nil
	}
	return db.queryBoard(boardQuery+" WHERE b.uuid = ?", boardUUID)
}
```

- [ ] **Step 4: Update `ResolveByAlias`**

In the same file, replace the `ResolveByAlias` function (lines 67–81) with:

```go
// ResolveByAlias looks up a string directly against the board_aliases table.
func (db *DB) ResolveByAlias(alias string) *BoardMatch {
	if !db.Available() || alias == "" {
		return nil
	}
	db.mu.RLock()
	defer db.mu.RUnlock()

	upper := strings.ToUpper(strings.TrimSpace(alias))
	var boardUUID string
	err := db.reader.QueryRow(
		"SELECT board_uuid FROM board_aliases WHERE upper(alias) = ? LIMIT 1",
		upper,
	).Scan(&boardUUID)
	if err != nil {
		return nil
	}
	return db.queryBoard(boardQuery+" WHERE b.uuid = ?", boardUUID)
}
```

- [ ] **Step 5: Update `queryBoard` to scan the new column set and load aliases via UUIDs**

Replace the entire `queryBoard` function (lines 100–152) with:

```go
func (db *DB) queryBoard(query string, args ...any) *BoardMatch {
	m := &BoardMatch{}
	var modelUUID string
	var boardName, odm, boardType, source, modelNumber, modelDisplay, color *string

	err := db.reader.QueryRow(query, args...).Scan(
		&m.UUID,
		&m.BoardNumber,
		&boardName,
		&odm,
		&boardType,
		&source,
		&modelUUID,
		&modelNumber,
		&modelDisplay,
		&m.Family,
		&m.Brand,
		&color,
	)
	if err != nil {
		return nil
	}
	if boardName != nil {
		m.BoardName = *boardName
	}
	if odm != nil {
		m.ODM = *odm
	}
	if boardType != nil {
		m.Type = *boardType
	}
	if source != nil {
		m.Source = *source
	}
	if modelNumber != nil {
		m.ModelNumber = *modelNumber
	}
	if modelDisplay != nil {
		m.Model = *modelDisplay
	}
	if color != nil {
		m.Color = *color
	}

	// Load board aliases (now keyed by board_uuid)
	rows, _ := db.reader.Query("SELECT alias FROM board_aliases WHERE board_uuid = ?", m.UUID)
	if rows != nil {
		defer rows.Close()
		for rows.Next() {
			var a string
			rows.Scan(&a)
			m.Aliases = append(m.Aliases, a)
		}
	}

	// Load model aliases (semantic fix: keyed by model_uuid)
	rows2, _ := db.reader.Query("SELECT alias FROM model_aliases WHERE model_uuid = ?", modelUUID)
	if rows2 != nil {
		defer rows2.Close()
		for rows2.Next() {
			var a string
			rows2.Scan(&a)
			m.ModelAliases = append(m.ModelAliases, a)
		}
	}
	return m
}
```

- [ ] **Step 6: Update `Stats()` to query the new schema**

In `src/backend/boarddb/boarddb.go`, replace the `Stats()` function (lines 87–119) with:

```go
// Stats returns board count grouped by brand and ODM.
func (db *DB) Stats() BoardStats {
	if !db.Available() {
		return BoardStats{}
	}
	db.mu.RLock()
	defer db.mu.RUnlock()

	s := BoardStats{ByBrand: map[string]int{}, ByODM: map[string]int{}}
	db.reader.QueryRow("SELECT count(*) FROM boards").Scan(&s.Total)
	db.reader.QueryRow("SELECT count(*) FROM board_aliases").Scan(&s.AliasCount)

	rows, _ := db.reader.Query(`
		SELECT br.name, count(*)
		FROM boards b
		JOIN models m   ON b.model_uuid  = m.uuid
		JOIN families f ON m.family_uuid = f.uuid
		JOIN brands br  ON f.brand_uuid  = br.uuid
		GROUP BY br.name
		ORDER BY count(*) DESC
	`)
	if rows != nil {
		defer rows.Close()
		for rows.Next() {
			var brand string
			var cnt int
			rows.Scan(&brand, &cnt)
			s.ByBrand[brand] = cnt
		}
	}
	rows2, _ := db.reader.Query(`
		SELECT odm, count(*) FROM boards
		WHERE odm IS NOT NULL AND odm != ''
		GROUP BY odm ORDER BY count(*) DESC
	`)
	if rows2 != nil {
		defer rows2.Close()
		for rows2.Next() {
			var odm string
			var cnt int
			rows2.Scan(&odm, &cnt)
			s.ByODM[odm] = cnt
		}
	}
	return s
}
```

- [ ] **Step 7: Build the backend**

Run:

```bash
cd src/backend && go build ./...
```

Expected: clean build, no output.

- [ ] **Step 8: Run existing tests**

Run:

```bash
cd src/backend && go test ./... 2>&1 | tail -30
```

Expected: tests pass. Some `handlers_test.go` assertions may need updating if they specifically inspected the v1 BoardMatch shape — fix those as needed (most likely they'll just need to be updated to expect `Family` in the response; if a test specifically asserts the old flat `model` matched a marketing string like `"MacBook Pro 13\" Touch Bar Late 2016"`, that's still the value of the new `model` field since the migration carried `boards.model` into `models.display_name`).

- [ ] **Step 9: Smoke-test the resolver against the migrated DB**

Run:

```bash
cd src/backend && cat > /tmp/boarddb_smoke.go <<'EOF'
package main

import (
	"encoding/json"
	"fmt"
	"os"

	"boardripper/boarddb"
)

func main() {
	db := boarddb.Open("../../Board Database/boards.db")
	if db == nil {
		fmt.Fprintln(os.Stderr, "could not open boards.db")
		os.Exit(1)
	}
	defer db.Close()

	for _, q := range []string{"820-00165", "820-02016", "NM-A251", "DA0R09MB6H1", "00HN525"} {
		m := db.Resolve(q)
		if m == nil {
			fmt.Printf("%s: not found\n", q)
			continue
		}
		out, _ := json.MarshalIndent(m, "", "  ")
		fmt.Printf("%s ->\n%s\n\n", q, string(out))
	}
}
EOF
go run /tmp/boarddb_smoke.go
rm /tmp/boarddb_smoke.go
```

Expected: each query returns JSON with non-empty `uuid`, `brand`, `family`, `model`, `model_number`. `color` is absent (entity_color is empty post-migration). `aliases` and `model_aliases` populated where applicable.

- [ ] **Step 10: Commit**

```bash
git add src/backend/boarddb/
git commit -m "$(cat <<'EOF'
feat(boarddb): v2 resolver — entity hierarchy, color cascade, family field

BoardMatch struct gains UUID + Family + Color fields. Resolver
boardQuery becomes a 4-table JOIN (boards → models → families →
brands) with 4 LEFT JOINs on entity_color resolved via COALESCE
(board → model → family → brand).

Alias-loading queries updated:
- board_aliases now keyed by board_uuid (was board_id rowid)
- model_aliases now keyed by model_uuid (semantic fix; was wrongly
  keyed by board_id rowid in the v0 schema)

Stats() rewritten to JOIN through brands table for brand counts.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Databank cache — schema migration v6

**Files:**
- Modify: `src/backend/databank/db.go`

- [ ] **Step 1: Bump `schemaVersion` to 6**

In `src/backend/databank/db.go`, find the line `const schemaVersion = 5` and change it to:

```go
const schemaVersion = 6
```

- [ ] **Step 2: Add `migrateV6` function at the end of the file**

Append after the existing `migrateV5` function:

```go
// migrateV6 adds board_uuid and board_color columns to the files table.
// Both are denormalized from the boards.db v2 resolver at scan time so the
// frontend can render them without an extra round-trip to /api/boards/resolve.
func (db *DB) migrateV6() error {
	tx, err := db.writer.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	stmts := []string{
		`ALTER TABLE files ADD COLUMN board_uuid TEXT`,
		`ALTER TABLE files ADD COLUMN board_color TEXT`,
	}

	for _, stmt := range stmts {
		if _, err := tx.Exec(stmt); err != nil {
			return fmt.Errorf("exec %q: %w", stmt[:40], err)
		}
	}

	if _, err := tx.Exec(`DELETE FROM schema_version`); err != nil {
		return err
	}
	if _, err := tx.Exec(`INSERT INTO schema_version (version) VALUES (?)`, 6); err != nil {
		return err
	}

	return tx.Commit()
}
```

- [ ] **Step 3: Wire `migrateV6` into the migration runner**

In `src/backend/databank/db.go`, find the `migrate` function. After the existing `if ver < 5 { ... migrateV5 ... }` block, add:

```go
	if ver < 6 {
		if err := db.migrateV6(); err != nil {
			return err
		}
	}
```

If the existing migration code uses a `switch` instead of `if` ladder, add a `case 5:` arm calling `migrateV6()` analogous to the existing arms.

- [ ] **Step 4: Build to catch syntax errors**

Run:

```bash
cd src/backend && go build ./...
```

Expected: clean build.

---

## Task 7: Databank cache — `FileRecord` struct + SQL statements

**Files:**
- Modify: `src/backend/databank/db.go` (FileRecord struct + INSERT/SELECT/UPDATE statements)

- [ ] **Step 1: Add `BoardUUID` and `BoardColor` to `FileRecord`**

In `src/backend/databank/db.go`, find the `FileRecord` struct (around line 488). Append two fields to the struct:

```go
type FileRecord struct {
	ID                int64  `json:"id"`
	Path              string `json:"path"`
	Filename          string `json:"filename"`
	Extension         string `json:"extension"`
	FileType          string `json:"file_type"`
	Size              int64  `json:"size"`
	ModTime           int64  `json:"mod_time"`
	ScanTime          int64  `json:"scan_time"`
	BoardNumber       string `json:"board_number,omitempty"`
	Manufacturer      string `json:"manufacturer,omitempty"`
	Model             string `json:"model,omitempty"`
	FormatID          string `json:"format_id,omitempty"`
	PartCount         *int   `json:"part_count,omitempty"`
	NetCount          *int   `json:"net_count,omitempty"`
	DonorPool         bool   `json:"donor_pool"`
	HasPreview        bool   `json:"has_preview"`
	BoardManufacturer string `json:"board_manufacturer,omitempty"`
	ResolutionStatus  string `json:"resolution_status,omitempty"`
	BoardUUID         string `json:"board_uuid,omitempty"`
	BoardColor        string `json:"board_color,omitempty"`
}
```

(The exact field set above is illustrative — preserve existing fields you find. Only `BoardUUID` and `BoardColor` are new.)

- [ ] **Step 2: Update both INSERT statements to include the two new columns**

Find the two INSERT statements (around lines 545 and 561). Each looks roughly like:

```go
`INSERT INTO files (path, filename, extension, file_type, size, mod_time, scan_time, board_number, manufacturer, model, format_id, part_count, net_count, donor_pool, has_preview, board_manufacturer, resolution_status)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
```

Add `, board_uuid, board_color` to the column list and `, ?, ?` to the VALUES list:

```go
`INSERT INTO files (path, filename, extension, file_type, size, mod_time, scan_time, board_number, manufacturer, model, format_id, part_count, net_count, donor_pool, has_preview, board_manufacturer, resolution_status, board_uuid, board_color)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
```

For each INSERT, find the corresponding `db.writer.Exec(...)` arg list and append `nullStr(rec.BoardUUID), nullStr(rec.BoardColor)` to the args. (`nullStr` is the existing helper used elsewhere in the file for nullable string fields like `BoardManufacturer`.)

- [ ] **Step 3: Update every SELECT statement that reads from `files`**

Run:

```bash
cd src/backend && grep -n "FROM files" databank/db.go
```

For each SELECT statement, add `, board_uuid, board_color` to the SELECT column list. Match each Scan call by appending `&rec.BoardUUID, &rec.BoardColor` to the scan args. There are typically 3–4 SELECT sites: `ListFiles`, `GetFile`, `GetFileByPath`, possibly `SearchFiles`. Update them all.

If the existing code uses pointer-to-string for nullable fields (the `BoardManufacturer` pattern), match that convention; otherwise direct `string` is fine since we'll insert empty string when match has no UUID/color.

- [ ] **Step 4: Build**

Run:

```bash
cd src/backend && go build ./...
```

Expected: clean build. If you see "wrong number of arguments to Scan", a SELECT got new columns but the corresponding Scan didn't get new args.

- [ ] **Step 5: Run databank tests**

Run:

```bash
cd src/backend && go test ./databank/... -v 2>&1 | tail -20
```

Expected: all pass. If `db_test.go` validates a specific column count or specific schema state, update its expectation.

---

## Task 8: Databank — `metadata.go` plumbing from `BoardMatch`

**Files:**
- Modify: `src/backend/databank/metadata.go`

- [ ] **Step 1: Add `BoardUUID` and `BoardColor` to the `Metadata` struct**

In `src/backend/databank/metadata.go`, find the `type Metadata struct` definition (search for `BoardNumber` to locate it) and add two fields at the end:

```go
type Metadata struct {
	// ... existing fields ...
	BoardNumber       string
	Manufacturer      string
	Model             string
	BoardManufacturer string
	ResolutionStatus  string
	BoardUUID         string
	BoardColor        string
}
```

- [ ] **Step 2: Populate the two new fields wherever a `BoardMatch` is converted to `Metadata`**

In `metadata.go`, find each place a `match := bdb.Resolve(...)` (or `bdb.ResolveByAlias(...)`) is followed by `Metadata{...}` construction. There are 5 such sites (lines roughly 185–193, 209–213, 218–222, 225–229, 237–241 in the current file).

For each construction, add `BoardUUID: match.UUID, BoardColor: match.Color,` to the struct literal. For example, replace:

```go
return Metadata{
    BoardNumber: match.BoardNumber, Manufacturer: match.Brand,
    Model: match.Model, BoardManufacturer: match.ODM, ResolutionStatus: "resolved",
}
```

with:

```go
return Metadata{
    BoardNumber: match.BoardNumber, Manufacturer: match.Brand,
    Model: match.Model, BoardManufacturer: match.ODM, ResolutionStatus: "resolved",
    BoardUUID: match.UUID, BoardColor: match.Color,
}
```

Update all 5 sites the same way. Verify with grep:

```bash
grep -c "Manufacturer: match.Brand" src/backend/databank/metadata.go
grep -c "BoardUUID: match.UUID" src/backend/databank/metadata.go
```

The two counts should match.

- [ ] **Step 3: Wire `Metadata.BoardUUID` and `BoardColor` into `FileRecord` at the construction site**

Find the function that converts a `Metadata` to a `FileRecord` (likely in `scanner.go` — grep to locate):

```bash
grep -n "BoardNumber.*=.*m.BoardNumber\|m.Manufacturer\|Manufacturer.*=.*m\." src/backend/databank/*.go
```

Add the two new lines next to the existing `rec.BoardNumber = m.BoardNumber` (or equivalent):

```go
rec.BoardUUID = m.BoardUUID
rec.BoardColor = m.BoardColor
```

- [ ] **Step 4: Build**

Run:

```bash
cd src/backend && go build ./...
```

Expected: clean build.

- [ ] **Step 5: Run databank tests again**

Run:

```bash
cd src/backend && go test ./databank/... -v 2>&1 | tail -20
```

Expected: all pass.

- [ ] **Step 6: End-to-end smoke: rescan and verify cache propagation**

Find the databank DB (typically under user home):

```bash
DATABANK_DB=$(find ~ -name 'databank.db' -path '*boardripper*' 2>/dev/null | head -1)
echo "$DATABANK_DB"
```

Move it aside (don't delete in case the smoke test fails):

```bash
mv "$DATABANK_DB" "${DATABANK_DB}.pre-v6.bak"
```

Start the BoardRipper backend per the project's existing dev workflow (typically `make dev` or `go run ./src/backend/main.go`). Let it scan the library. Once scan completes, query the new databank:

```bash
DATABANK_DB=$(find ~ -name 'databank.db' -path '*boardripper*' 2>/dev/null | head -1)
sqlite3 "$DATABANK_DB" "SELECT filename, board_number, board_uuid, board_color FROM files WHERE board_uuid != '' LIMIT 5;"
```

Expected: rows where `board_uuid` is populated for files that resolved against `boards.db`. `board_color` is empty for now (entity_color is empty post-migration).

Once verified, restore the backup if you want to keep your old databank state:

```bash
DATABANK_DB=$(find ~ -name 'databank.db' -path '*boardripper*' 2>/dev/null | head -1)
mv "${DATABANK_DB}.pre-v6.bak" /tmp/  # or rm if you don't want it
```

- [ ] **Step 7: Commit Phase 6**

```bash
git add src/backend/databank/
git commit -m "$(cat <<'EOF'
feat(databank): cache board_uuid and board_color from v2 resolver

- Schema migration v6 adds board_uuid + board_color columns to files
- FileRecord exposes both fields as JSON (omitempty)
- Metadata struct + 5 BoardMatch→Metadata conversion sites updated
  to plumb resolver output through into the cache
- INSERT/SELECT statements updated; UpdateFileMetadata unchanged
  (UUID/color come from the resolver, not from user edits)

The frontend reads /api/databank/files and gets uuid + color as
plain fields, no separate resolver round-trip per file.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Frontend — `DatabankFile` interface

**Files:**
- Modify: `src/frontend/src/store/databank-store.ts:12-31`

- [ ] **Step 1: Add `board_uuid` and `board_color` to `DatabankFile`**

In `src/frontend/src/store/databank-store.ts`, find the `DatabankFile` interface (around line 12) and add two optional fields at the end:

```ts
export interface DatabankFile {
  id: number;
  path: string;
  filename: string;
  extension: string;
  file_type: 'board' | 'pdf';
  size: number;
  mod_time: number;
  scan_time: number;
  board_number: string;
  manufacturer: string;
  model: string;
  format_id: string;
  part_count: number | null;
  net_count: number | null;
  donor_pool: boolean;
  has_preview: boolean;
  board_manufacturer: string;
  resolution_status: 'resolved' | 'pattern_matched' | 'unresolved' | '';
  board_uuid?: string;
  board_color?: string;
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run:

```bash
cd src/frontend && npx tsc --noEmit
```

Expected: no errors.

---

## Task 10: Frontend — Library panel "Color" row

**Files:**
- Modify: `src/frontend/src/panels/LibraryPanel.tsx:654-669`

- [ ] **Step 1: Add a "Color" line in the detail metadata block**

In `src/frontend/src/panels/LibraryPanel.tsx`, find the `library-detail-meta` block (around line 654). Locate the existing line:

```tsx
{detail.manufacturer && <span>Mfr: {detail.manufacturer}</span>}
```

Add a new `<span>` immediately after it:

```tsx
{detail.board_color && <span>Color: {detail.board_color}</span>}
```

The complete block becomes:

```tsx
<div className="library-detail-meta">
  {detail.board_number && <span>Board: {detail.board_number}</span>}
  {(() => {
    const resolved = detail.board_number ? lookupBoard(detail.board_number) : undefined;
    if (!resolved) return null;
    return <>
      <span className="library-detail-model-resolved">{resolved.a_number} {resolved.model}</span>
      <span className="library-detail-model-info" title={resolved.info}>{resolved.info}</span>
    </>;
  })()}
  {detail.manufacturer && <span>Mfr: {detail.manufacturer}</span>}
  {detail.board_color && <span>Color: {detail.board_color}</span>}
  {detail.model && <span>Model: {detail.model}</span>}
  {detail.part_count != null && <span>{detail.part_count} parts</span>}
  {detail.net_count != null && <span>{detail.net_count} nets</span>}
  <span>{formatSize(detail.size)}</span>
</div>
```

- [ ] **Step 2: Verify TypeScript compiles**

Run:

```bash
cd src/frontend && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Smoke-test by manually setting one board's color in BOTH DBs**

Color is empty post-migration (entity_color has no rows). To verify the end-to-end pipeline shows something, add one color manually.

First find one of the migrated Apple boards:

```bash
APPLE_BOARD_UUID=$(sqlite3 "Board Database/boards.db" \
  "SELECT b.uuid FROM boards b
   JOIN models m ON b.model_uuid = m.uuid
   JOIN families f ON m.family_uuid = f.uuid
   JOIN brands br ON f.brand_uuid = br.uuid
   WHERE br.name = 'Apple' LIMIT 1;")
echo "$APPLE_BOARD_UUID"
```

Insert a color row at board scope:

```bash
sqlite3 "Board Database/boards.db" \
  "INSERT INTO entity_color (scope_type, scope_uuid, color_id) VALUES ('board', '$APPLE_BOARD_UUID', 1);"
```

Find that board's number:

```bash
APPLE_BOARD_NUMBER=$(sqlite3 "Board Database/boards.db" \
  "SELECT board_number FROM boards WHERE uuid = '$APPLE_BOARD_UUID';")
echo "$APPLE_BOARD_NUMBER"
```

Update the databank cache directly so the panel reflects without a rescan:

```bash
DATABANK_DB=$(find ~ -name 'databank.db' -path '*boardripper*' 2>/dev/null | head -1)
sqlite3 "$DATABANK_DB" \
  "UPDATE files SET board_color = 'black' WHERE board_number = '$APPLE_BOARD_NUMBER';"
```

If `UPDATE` reports 0 rows, the user's library doesn't contain a file matching this board number — pick a different one whose files the user has. List the candidates:

```bash
sqlite3 "$DATABANK_DB" "SELECT DISTINCT board_number FROM files WHERE board_number != '' LIMIT 10;"
```

- [ ] **Step 4: Run the dev server and verify visually**

Start the frontend dev server (typically `cd src/frontend && npm run dev`, or `make dev` from the repo root). Open BoardRipper, navigate to the Library panel, click on the file with the populated color.

Expected lower detail area:
```
Board: 820-…
A1466 MacBook Air 13"
MacBook Air 13" Early 2015 - Mid 2017
Mfr: Apple
Color: black                           ← new row
Model: …
… parts  … nets  … MB
```

If "Color: black" doesn't appear:
- DevTools → Network → confirm `/api/databank/files` includes `board_color: "black"`. If yes, double-check the JSX condition is `detail.board_color &&`.
- If `board_color` missing from the JSON, re-check Task 7 Step 3 — a SELECT statement is missing the new column.

- [ ] **Step 5: Revert the smoke-test color edits**

```bash
sqlite3 "Board Database/boards.db" "DELETE FROM entity_color;"
DATABANK_DB=$(find ~ -name 'databank.db' -path '*boardripper*' 2>/dev/null | head -1)
sqlite3 "$DATABANK_DB" "UPDATE files SET board_color = NULL;"
```

Verify boards.db is clean:

```bash
sqlite3 "Board Database/boards.db" "SELECT count(*) FROM entity_color;"
```

Expected: `0`.

- [ ] **Step 6: Commit Phase 4 (frontend)**

```bash
git add src/frontend/src/store/databank-store.ts src/frontend/src/panels/LibraryPanel.tsx
git commit -m "$(cat <<'EOF'
feat(library): show board color in detail panel

DatabankFile gains board_uuid + board_color (both optional strings).
LibraryPanel renders "Color: <name>" row in lower detail meta when
the resolved board has an entity_color row at any cascade scope
(board → model → family → brand).

Color values themselves come from boards.db's entity_color table
via the resolver's COALESCE chain, denormalized into the databank
cache via the v6 migration.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: End-to-end verification

- [ ] **Step 1: Confirm git history**

Run:

```bash
git log --oneline -10
```

Expected: 8 commits in order:
1. `feat(boarddb): scaffold v2 migration script + tests`
2. `feat(boarddb): implement v2 migration logic with full test coverage`
3. `build(boarddb): migrate boards.db to v2 (entity hierarchy)`
4. `build(boarddb): rewrite create_mockup_db.sql to v2 schema; archive build_full_db.sql`
5. `feat(boarddb): v2 resolver — entity hierarchy, color cascade, family field`
6. `feat(databank): cache board_uuid and board_color from v2 resolver`
7. `feat(library): show board color in detail panel`

(Commits 8–11 are merged from the in-task commits above; if you split commits differently, the history will be longer but the substance is the same.)

- [ ] **Step 2: Confirm `boards.db` final state**

Run:

```bash
sqlite3 "Board Database/boards.db" <<'EOF'
SELECT version FROM schema_version;
SELECT
  (SELECT count(*) FROM brands)        AS brands,
  (SELECT count(*) FROM families)      AS families,
  (SELECT count(*) FROM models)        AS models,
  (SELECT count(*) FROM boards)        AS boards,
  (SELECT count(*) FROM board_aliases) AS board_aliases,
  (SELECT count(*) FROM model_aliases) AS model_aliases,
  (SELECT count(*) FROM colors)        AS colors,
  (SELECT count(*) FROM entity_color)  AS entity_color;
SELECT count(*) FROM boards b
LEFT JOIN models m ON b.model_uuid = m.uuid
LEFT JOIN families f ON m.family_uuid = f.uuid
LEFT JOIN brands br ON f.brand_uuid = br.uuid
WHERE m.uuid IS NULL OR f.uuid IS NULL OR br.uuid IS NULL;
EOF
```

Expected:
- `schema_version` = 2
- All counts > 0 except `entity_color` = 0
- JOIN-orphan check returns 0

- [ ] **Step 3: Confirm resolver API**

Start the backend. Run:

```bash
curl -s 'http://localhost:1336/api/boards/resolve?q=820-00165' | python3 -m json.tool
```

Expected: top-level `match` includes `"uuid"`, `"brand"`, `"family"`, `"model"`, `"model_number"` populated. `"color"` absent (entity_color empty).

- [ ] **Step 4: Confirm Library panel renders**

Open BoardRipper UI, click any board file in the Library. Detail panel renders without console errors. No `"undefined is not a function"`-style breakage related to `board_color` or `board_uuid`.

- [ ] **Step 5: Run full test suite**

Run:

```bash
cd /Users/besitzer/Desktop/Boardviewer && python3 scripts/test_migrate_boarddb_v2.py -v 2>&1 | tail -20
cd src/backend && go test ./...
cd src/frontend && npx tsc --noEmit
```

Expected: all green.

- [ ] **Step 6: Done — no commit needed**

Verification only.

---

## Future-work pointers (deferred, do NOT implement here)

These were carved out of this sub-project. The schema as built leaves clean seams for each:

- **Hide-list (`board_hidden_parts`)** — per-board collection of refdes to hide from rendering. Schema in spec; not created in this sub-project. Lands when the renderer's "Hide listed parts" toggle is implemented.
- **Database Editor UI** — new Library tab with CRUD over Brand/Family/Model/Board entities, their metadata, their aliases. Separate sub-project.
- **CRM API endpoints** — `GET /api/boards/open?uuid=...` and `GET /api/lookup?q=...`. Separate sub-project.
- **Datasheet / documentation DB** — same `(scope_type, scope_uuid)` cascading pattern as `entity_color`, with a `binding_category` tag (chipset / charger / CPU). Brainstorm pending.
- **External-source ingestion** (devicedb.xyz / Telegram channel / OpenBoardData) — separate sub-projects. UUIDs make multi-source merge trivial via a future `external_refs(board_uuid, source, external_id)` table.
- **Adaptive coloring scheme** — once Brand/Family rows exist, "Apple → black" / "Lenovo Legion → blue" / "Lenovo (other) → green" become single `INSERT INTO entity_color` rows. No code changes needed; lands with theming work.
- **Brand / family aliases** — not modeled today. Add `brand_aliases`/`family_aliases` (same shape as `model_aliases`) when real-world data demands them.
