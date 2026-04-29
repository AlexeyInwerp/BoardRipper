#!/usr/bin/env python3
"""
Import filename-scan observation results into boards.db under a synthetic
placeholder hierarchy.

Reads the observation-pass JSON sidecar, filters to NEW codes per pattern,
and INSERT OR IGNOREs them into the boards table under
'Unsorted/<ODM>/(unknown)' placeholder rows.

Usage:
  scripts/import-filename-scan.py import-staging/filename-scan-2026-04-29.json
  scripts/import-filename-scan.py <staging-json> --db /path/to/boards.db
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
import uuid
from pathlib import Path

# Map each importable pattern → (placeholder family name, placeholder model_number)
# under the single 'Unsorted' brand. apple_a_number deliberately excluded —
# it's a model identifier, not a board code; separate slice will handle it.
PATTERN_TO_FAMILY: dict[str, tuple[str, str]] = {
    'apple_820':  ('Apple',   '(unknown-apple)'),
    'compal_la':  ('Compal',  '(unknown-compal)'),
    'lcfc_nm':    ('LCFC',    '(unknown-lcfc)'),
    'quanta_da0': ('Quanta',  '(unknown-quanta)'),
    'msi_ms':     ('MSI',     '(unknown-msi)'),
    'asus_60nr':  ('ASUS',    '(unknown-asus)'),
    'oem_6050':   ('Foxconn', '(unknown-foxconn)'),
}

PLACEHOLDER_BRAND = 'Unsorted'
PLACEHOLDER_MODEL_DISPLAY = '(unknown — TODO: curate)'


def find_or_create_brand(conn: sqlite3.Connection, name: str) -> str:
    """Return brand uuid, creating row if missing."""
    row = conn.execute("SELECT uuid FROM brands WHERE name = ?", (name,)).fetchone()
    if row:
        return row[0]
    new_uuid = str(uuid.uuid4())
    conn.execute("INSERT INTO brands (uuid, name) VALUES (?, ?)", (new_uuid, name))
    return new_uuid


def find_or_create_family(conn: sqlite3.Connection, brand_uuid: str, name: str) -> str:
    """Return family uuid for (brand_uuid, name), creating row if missing."""
    row = conn.execute(
        "SELECT uuid FROM families WHERE brand_uuid = ? AND name = ?",
        (brand_uuid, name),
    ).fetchone()
    if row:
        return row[0]
    new_uuid = str(uuid.uuid4())
    conn.execute(
        "INSERT INTO families (uuid, brand_uuid, name) VALUES (?, ?, ?)",
        (new_uuid, brand_uuid, name),
    )
    return new_uuid


def find_or_create_model(conn: sqlite3.Connection, family_uuid: str,
                         model_number: str, display_name: str) -> str:
    """Return model uuid for (family_uuid, model_number), creating row if missing."""
    row = conn.execute(
        "SELECT uuid FROM models WHERE family_uuid = ? AND model_number = ?",
        (family_uuid, model_number),
    ).fetchone()
    if row:
        return row[0]
    new_uuid = str(uuid.uuid4())
    conn.execute(
        "INSERT INTO models (uuid, family_uuid, model_number, display_name) "
        "VALUES (?, ?, ?, ?)",
        (new_uuid, family_uuid, model_number, display_name),
    )
    return new_uuid


def main():
    ap = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    ap.add_argument('staging_json', metavar='STAGING_JSON',
                    help='Path to import-staging/filename-scan-<date>.json')
    ap.add_argument('--db', metavar='PATH',
                    default=str(Path(__file__).resolve().parent.parent /
                                'Board Database' / 'boards.db'),
                    help='Path to boards.db (default: Board Database/boards.db relative to repo)')
    args = ap.parse_args()

    staging_path = Path(args.staging_json)
    db_path = Path(args.db)

    if not staging_path.exists():
        print(f"error: staging file not found: {staging_path}", file=sys.stderr)
        return 1
    if not db_path.exists():
        print(f"error: database not found: {db_path}", file=sys.stderr)
        return 1

    payload = json.loads(staging_path.read_text())

    conn = sqlite3.connect(db_path)
    try:
        # Schema-version guard
        ver_row = conn.execute(
            "SELECT version FROM schema_version LIMIT 1"
        ).fetchone()
        if not ver_row or ver_row[0] < 2:
            print("error: boards.db is below schema_version 2 — run migrate-boarddb-v2.py first",
                  file=sys.stderr)
            return 1

        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("BEGIN")

        # Find-or-create the placeholder hierarchy (1 brand + 7 families + 7 models)
        brand_uuid = find_or_create_brand(conn, PLACEHOLDER_BRAND)
        pattern_to_model_uuid: dict[str, str] = {}
        for pattern, (family_name, model_number) in PATTERN_TO_FAMILY.items():
            family_uuid = find_or_create_family(conn, brand_uuid, family_name)
            model_uuid = find_or_create_model(conn, family_uuid, model_number,
                                               PLACEHOLDER_MODEL_DISPLAY)
            pattern_to_model_uuid[pattern] = model_uuid

        # Insert boards per pattern
        inserted_per_pattern: dict[str, int] = {}
        existing_per_pattern: dict[str, int] = {}
        for pattern in PATTERN_TO_FAMILY:
            inserted_per_pattern[pattern] = 0
            existing_per_pattern[pattern] = 0
            stats = payload.get('per_pattern', {}).get(pattern, {})
            new_full = stats.get('new_full', [])
            first_filename = stats.get('first_filename', {})
            if not new_full:
                continue

            model_uuid = pattern_to_model_uuid[pattern]
            for code in new_full:
                sample = first_filename.get(code, '(unknown)')
                notes = f"filename-scan:{pattern}; sample:{sample}"
                cur = conn.execute(
                    "INSERT OR IGNORE INTO boards "
                    "(uuid, model_uuid, board_number, board_number_type, source, notes) "
                    "VALUES (?, ?, ?, ?, ?, ?)",
                    (str(uuid.uuid4()), model_uuid, code, pattern,
                     'filename-scan', notes),
                )
                if cur.rowcount > 0:
                    inserted_per_pattern[pattern] += 1
                else:
                    existing_per_pattern[pattern] += 1

        conn.commit()

        # Summary
        total_inserted = sum(inserted_per_pattern.values())
        total_existing = sum(existing_per_pattern.values())
        print(f"filename-scan import complete:")
        print(f"  {total_inserted} board(s) inserted")
        print(f"  {total_existing} board(s) skipped (already in DB)")
        print(f"  per pattern:")
        for pattern in PATTERN_TO_FAMILY:
            ins = inserted_per_pattern.get(pattern, 0)
            ex = existing_per_pattern.get(pattern, 0)
            if ins or ex:
                print(f"    {pattern}: {ins} inserted, {ex} existing")

        return 0
    except Exception as e:
        conn.rollback()
        print(f"import failed: {e}", file=sys.stderr)
        raise
    finally:
        conn.close()


if __name__ == '__main__':
    sys.exit(main())
