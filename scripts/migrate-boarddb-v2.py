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
    try:
        conn.execute("PRAGMA foreign_keys=ON")

        ver = get_schema_version(conn)
        if ver >= 2:
            print(f"already at schema version {ver}; nothing to do.")
            return

        print("starting migration to v2…")
        try:
            conn.execute("BEGIN")
            # Steps 1-13 from the spec. Implemented in subsequent tasks.
            # PLACEHOLDER: real implementation lives in Task 2 (subsequent tasks).
            raise NotImplementedError("Task 1 only stubs main(); steps fill in")
        except Exception:
            conn.rollback()
            raise
    finally:
        conn.close()


if __name__ == '__main__':
    main()
