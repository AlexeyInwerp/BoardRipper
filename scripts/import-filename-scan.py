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
    print("Importer body not implemented yet — Task 3 fills in.", file=sys.stderr)
    return 1


if __name__ == '__main__':
    sys.exit(main())
