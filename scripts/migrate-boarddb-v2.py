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
from __future__ import annotations

import re
import sqlite3
import sys
import uuid
from pathlib import Path

# Family-extraction pattern table (brand, model_regex, family_name).
# Evaluated in order; first match wins. Anything that doesn't match falls
# through to BRAND_FALLBACK[brand] (or BRAND_FALLBACK['_'] if brand absent).
#
# Brand key matching is case-insensitive (real-world DB has 'ASUS' alongside
# 'Apple' / 'Dell' / 'HP'). Pattern regexes use IGNORECASE.
FAMILY_PATTERNS = [
    ('Apple',  r'^MacBook Pro\b',         'MacBook Pro'),
    ('Apple',  r'^MacBook Air\b',         'MacBook Air'),
    ('Apple',  r'^MacBook\b',             'MacBook'),
    ('Apple',  r'^iMac\b',                'iMac'),
    ('Apple',  r'^Mac mini\b',            'Mac mini'),
    ('Apple',  r'^Mac Pro\b',             'Mac Pro'),
    ('Apple',  r'^Mac Studio\b',          'Mac Studio'),
    ('Lenovo', r'^ThinkPad\b',            'ThinkPad'),
    ('Lenovo', r'^Legion\b',              'Legion'),
    ('Lenovo', r'^IdeaPad\b',             'IdeaPad'),
    ('Lenovo', r'^Yoga\b',                'Yoga'),
    ('Lenovo', r'^ThinkBook\b',           'ThinkBook'),
    ('Dell',   r'^Inspiron\b',            'Inspiron'),
    ('Dell',   r'^Latitude\b',            'Latitude'),
    ('Dell',   r'^XPS\b',                 'XPS'),
    ('Dell',   r'^Precision\b',           'Precision'),
    ('Dell',   r'^Vostro\b',              'Vostro'),
    ('Dell',   r'^Alienware\b',           'Alienware'),
    ('Dell',   r'^G[357]\b',              'G Series'),
    ('HP',     r'^EliteBook\b',           'EliteBook'),
    ('HP',     r'^ProBook\b',             'ProBook'),
    ('HP',     r'^Pavilion\b',            'Pavilion'),
    ('HP',     r'^Spectre\b',             'Spectre'),
    ('HP',     r'^OMEN\b',                'Omen'),
    ('HP',     r'^ENVY\b',                'Envy'),
    ('HP',     r'^ZBook\b',               'ZBook'),
    ('Acer',   r'^Aspire\b',              'Aspire'),
    ('Acer',   r'^Predator\b',            'Predator'),
    ('Acer',   r'^Swift\b',               'Swift'),
    ('Acer',   r'^Nitro\b',               'Nitro'),
    ('Acer',   r'^Spin\b',                'Spin'),
    ('ASUS',   r'^ZenBook\b',             'ZenBook'),
    ('ASUS',   r'^VivoBook\b',            'VivoBook'),
    ('ASUS',   r'^ROG\b',                 'ROG'),
    ('ASUS',   r'^TUF\b',                 'TUF'),
    ('ASUS',   r'\bDesktop Motherboard\b','Motherboard'),
    ('Gigabyte', r'^Z\d+',                 'Motherboard'),
    ('MSI',    r'^GS\d+\b.*Stealth\b',    'Stealth'),
    ('MSI',    r'^Stealth\b',             'Stealth'),
]

BRAND_FALLBACK = {
    'Apple':  'Mac (other)',
    'Lenovo': 'Laptop',
    'Dell':   'Laptop',
    'HP':     'Laptop',
    'Acer':   'Laptop',
    'ASUS':   'Laptop',
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
    """Return (family_name, was_matched). False = used fallback.

    Brand keys and regexes match case-insensitively so 'ASUS'/'Asus'/'asus'
    in source data all hit the same patterns.
    """
    if model:
        brand_ci = brand.casefold()
        for pat_brand, pat_re, fam in FAMILY_PATTERNS:
            if pat_brand.casefold() == brand_ci and re.search(pat_re, model, re.IGNORECASE):
                return fam, True
    # Brand fallback also case-insensitive
    for k, v in BRAND_FALLBACK.items():
        if k != '_' and k.casefold() == brand.casefold():
            return v, False
    return BRAND_FALLBACK['_'], False


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
    try:
        conn.execute("PRAGMA foreign_keys=ON")

        ver = get_schema_version(conn)
        if ver >= 2:
            print(f"already at schema version {ver}; nothing to do.")
            return

        print("starting migration to v2…")
        current_step = "init"
        try:
            conn.execute("BEGIN")

            current_step = "1: schema_version bootstrap"
            # 1. Bootstrap schema_version
            conn.execute("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)")
            if conn.execute("SELECT count(*) FROM schema_version").fetchone()[0] == 0:
                conn.execute("INSERT INTO schema_version (version) VALUES (1)")

            current_step = "2: create colors table + seed"
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

            current_step = "3: create entity tables"
            # 3. Create entity tables (with _v2 suffix; renamed at step 10)
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

            current_step = "4: populate brands"
            # 4. Populate brands
            brands = {}
            for (brand,) in conn.execute("SELECT DISTINCT brand FROM boards"):
                u = gen_uuid()
                brands[brand] = u
                conn.execute("INSERT INTO brands (uuid, name) VALUES (?, ?)", (u, brand))

            current_step = "5: populate families"
            # 5. Populate families (with unmatched-pattern logging)
            families = {}  # (brand_uuid, family_name) -> uuid
            unmatched_count = 0
            for board in conn.execute("SELECT brand, model FROM boards").fetchall():
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

            current_step = "6: populate models"
            # 6. Populate models — one per (brand, model_number)
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
                mn = model_number if model_number else '(unknown)'
                conn.execute(
                    "INSERT INTO models (uuid, family_uuid, model_number, display_name) VALUES (?, ?, ?, ?)",
                    (u, family_uuid, mn, model_text),
                )

            current_step = "7: populate boards_v2"
            # 7. Populate boards_v2 with fresh UUIDs
            old_to_new = {}  # old boards.id -> (new boards_v2.uuid, model_uuid)
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

            current_step = "8: populate board_aliases_v2"
            # 8. Populate board_aliases_v2
            for old_id, alias, alias_type in conn.execute(
                "SELECT board_id, alias_number, alias_type FROM board_aliases"
            ):
                if old_id not in old_to_new:
                    raise RuntimeError(
                        f"orphan board_aliases row references nonexistent boards.id={old_id} "
                        f"(alias={alias!r}); clean source DB before migrating"
                    )
                new_uuid, _ = old_to_new[old_id]
                conn.execute(
                    "INSERT OR IGNORE INTO board_aliases_v2 (uuid, board_uuid, alias, alias_type) "
                    "VALUES (?, ?, ?, ?)",
                    (gen_uuid(), new_uuid, alias, alias_type),
                )

            current_step = "9: populate model_aliases_v2"
            # 9. Populate model_aliases_v2 — semantic fix (model_uuid not board_uuid), dedup
            seen = set()
            for old_id, alias in conn.execute(
                "SELECT board_id, model_name FROM model_aliases"
            ):
                if old_id not in old_to_new:
                    raise RuntimeError(
                        f"orphan model_aliases row references nonexistent boards.id={old_id} "
                        f"(alias={alias!r}); clean source DB before migrating"
                    )
                _, model_uuid = old_to_new[old_id]
                key = (model_uuid, alias)
                if key in seen:
                    continue
                seen.add(key)
                # Heuristic: comma-suffixed strings (MacBookPro13,3) are OS-level identifiers.
                alias_type = 'apple_model_id' if ',' in alias else 'oem_marketing'
                conn.execute(
                    "INSERT OR IGNORE INTO model_aliases_v2 (uuid, model_uuid, alias, alias_type) "
                    "VALUES (?, ?, ?, ?)",
                    (gen_uuid(), model_uuid, alias, alias_type),
                )

            current_step = "10: drop+rename+reindex"
            # 10. Drop old tables and rename _v2 -> final names
            conn.executescript("""
                DROP TABLE board_aliases;
                DROP TABLE model_aliases;
                DROP TABLE boards;
                ALTER TABLE boards_v2 RENAME TO boards;
                ALTER TABLE board_aliases_v2 RENAME TO board_aliases;
                ALTER TABLE model_aliases_v2 RENAME TO model_aliases;
                DROP INDEX IF EXISTS idx_boards_v2_model;
                DROP INDEX IF EXISTS idx_boards_v2_number;
                DROP INDEX IF EXISTS idx_baliases_v2_alias;
                DROP INDEX IF EXISTS idx_maliases_v2_alias;
                CREATE INDEX idx_boards_model ON boards(model_uuid);
                CREATE INDEX idx_boards_number ON boards(board_number);
                CREATE INDEX idx_board_aliases_alias ON board_aliases(alias);
                CREATE INDEX idx_model_aliases_alias ON model_aliases(alias);
            """)

            current_step = "11: bump schema_version"
            # 11. Bump schema_version
            conn.execute("UPDATE schema_version SET version = 2")

            current_step = "post-commit"
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
            print(f"migration failed at step {current_step}: {e}", file=sys.stderr)
            conn.rollback()
            raise
    finally:
        conn.close()


if __name__ == '__main__':
    main()
