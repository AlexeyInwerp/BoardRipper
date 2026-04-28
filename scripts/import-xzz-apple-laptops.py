#!/usr/bin/env python3
r"""
Walk the user's local XZZ Synology Drive Apple-laptop folder, extract
A-number/board-code linkage from folder names, and merge into boards.db.

Two phases:
  1. EXTRACT (default): scan filesystem → write
     import-staging/xzz-apple-laptops-<date>.json. Nothing touches
     boards.db. Reviewer eyeballs the staging file, fills in 'family'
     per A-number (the only manual field), sets skip:true on bad rows.
  2. APPLY (--apply <staging-file>): read staging → INSERT OR IGNORE
     into boards.db. Existing rows preserved; manual curation always wins.

Usage:
  scripts/import-xzz-apple-laptops.py
  scripts/import-xzz-apple-laptops.py --xzz-root /path/to/XZZ/Computers/1\ Laptop/APPLE
  scripts/import-xzz-apple-laptops.py --apply import-staging/xzz-apple-laptops-2026-04-28.json
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

DEFAULT_XZZ_ROOT = Path(
    '/Users/besitzer/Library/CloudStorage/SynologyDrive-Mac/'
    'XZZ/Computers/1 Laptop/APPLE'
)

# Buckets are folders named A<digits>xx — e.g., A12xx, A14xx, A22xx.
BUCKET_RE = re.compile(r'^A\d+xx$')

# Each individual board folder begins with the A-number, then either
# underscore or space, then the 820-NNNN(N) board code (4 or 5 digits)
# with optional revision suffix (-A through -Z), then optional trailing
# context (codename like J113, year hints in parens, etc.).
ENTRY_RE = re.compile(r'^(A\d{4})[_ ](820-\d+(?:-[A-Z])?)(.*)$')

# Codename pattern (J followed by 1–3 digits) found in the trailing text.
CODENAME_RE = re.compile(r'\b(J\d{1,3})\b')

# Year hint pattern: any 4-digit year inside parens.
YEAR_HINT_RE = re.compile(r'\((?:[^)]*?)(\d{4})(?:[^)]*?)\)')

# Canonical Apple laptop families. Phase B reviewer must pick one of these
# (or the catch-all 'MacBook (other)') for each unique A-number.
CANONICAL_LAPTOP_FAMILIES = {
    'MacBook Pro', 'MacBook Air', 'MacBook', 'MacBook (other)',
}


def parse_folder_name(name: str) -> Optional[dict]:
    """Parse one board-folder name into structured fields, or None if it doesn't match.

    Examples:
      'A1466_820-00165 J113'              -> {a_number, board_number, codename='J113', year_hint=None}
      'A1419 820-00292(At the end of 2015)' -> {a_number, board_number, codename=None, year_hint='2015'}
      '0 A14xx Repair Case'               -> None  (regex doesn't match)
    """
    m = ENTRY_RE.match(name)
    if not m:
        return None
    a_number, board_number, trailer = m.groups()
    cm = CODENAME_RE.search(trailer)
    ym = YEAR_HINT_RE.search(trailer)
    return {
        'a_number': a_number,
        'board_number': board_number,
        'codename': cm.group(1) if cm else None,
        'year_hint': ym.group(1) if ym else None,
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    ap.add_argument('--apply', metavar='STAGING_FILE',
                    help='read STAGING_FILE and merge rows into boards.db')
    ap.add_argument('--xzz-root', metavar='PATH', default=str(DEFAULT_XZZ_ROOT),
                    help='path to XZZ Apple-laptop folder root '
                         '(default: ~/Library/CloudStorage/SynologyDrive-Mac/XZZ/...)')
    ap.add_argument('--db', default=str(Path(__file__).resolve().parent.parent / 'Board Database' / 'boards.db'),
                    help='path to boards.db (default: Board Database/boards.db relative to repo)')
    args = ap.parse_args()

    if args.apply:
        sys.exit(apply_staging(Path(args.apply), Path(args.db)))
    else:
        sys.exit(extract(Path(args.xzz_root)))


def extract(xzz_root: Path) -> int:
    if not xzz_root.exists():
        print(f"error: XZZ root does not exist: {xzz_root}", file=sys.stderr)
        print("hint: Synology Drive may be paused or the path may be wrong.",
              file=sys.stderr)
        print(f"hint: pass --xzz-root <path> to override (default: {DEFAULT_XZZ_ROOT})",
              file=sys.stderr)
        return 1

    print(f"scanning {xzz_root} …", file=sys.stderr)

    boards: list[dict] = []
    a_numbers_acc: dict[str, list[str]] = {}  # a_number -> sorted list of source folders
    bucket_count = 0

    for bucket in sorted(xzz_root.iterdir()):
        if not bucket.is_dir():
            continue
        if not BUCKET_RE.match(bucket.name):
            continue
        bucket_count += 1
        for entry in sorted(bucket.iterdir()):
            if not entry.is_dir():
                continue
            parsed = parse_folder_name(entry.name)
            if parsed is None:
                continue
            boards.append({
                'a_number': parsed['a_number'],
                'board_number': parsed['board_number'],
                'codename': parsed['codename'],
                'year_hint': parsed['year_hint'],
                'source_folder': entry.name,
                'bucket': bucket.name,
                'skip': False,
            })
            a_numbers_acc.setdefault(parsed['a_number'], []).append(entry.name)

    a_number_rows = [
        {
            'a_number': a,
            'family': None,
            'display_name': None,
            'source_folders': sorted(set(folders)),
            'skip': False,
        }
        for a, folders in sorted(a_numbers_acc.items())
    ]

    out_dir = Path(__file__).resolve().parent.parent / 'import-staging'
    out_dir.mkdir(exist_ok=True)
    today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
    out_path = out_dir / f'xzz-apple-laptops-{today}.json'

    payload = {
        'fetched_at': datetime.now(timezone.utc).isoformat(),
        'source_root': str(xzz_root),
        'bucket_count': bucket_count,
        'board_count': len(boards),
        'unique_a_numbers': len(a_number_rows),
        'a_numbers': a_number_rows,
        'boards': boards,
    }
    out_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False))

    print(f"wrote {out_path}", file=sys.stderr)
    print(f"  {bucket_count} buckets scanned", file=sys.stderr)
    print(f"  {len(boards)} boards extracted, "
          f"{len(a_number_rows)} unique A-numbers", file=sys.stderr)
    print(f"\nReview {out_path} and fill in 'family' for each A-number, "
          f"then run:", file=sys.stderr)
    print(f"  scripts/import-xzz-apple-laptops.py --apply {out_path}", file=sys.stderr)
    return 0


def apply_staging(staging_path: Path, db_path: Path) -> int:
    if not staging_path.exists():
        print(f"error: staging file not found: {staging_path}", file=sys.stderr)
        return 1
    if not db_path.exists():
        print(f"error: database not found: {db_path}", file=sys.stderr)
        return 1

    payload = json.loads(staging_path.read_text())
    a_number_rows = payload.get('a_numbers', [])
    board_rows = payload.get('boards', [])

    conn = sqlite3.connect(db_path)
    try:
        conn.execute("PRAGMA foreign_keys=ON")

        # Schema-version guard.
        ver_row = conn.execute(
            "SELECT version FROM schema_version LIMIT 1"
        ).fetchone()
        if not ver_row or ver_row[0] < 2:
            print("error: boards.db is below schema_version 2 — run migrate-boarddb-v2.py first",
                  file=sys.stderr)
            return 1

        # Apple brand must exist.
        apple_row = conn.execute(
            "SELECT uuid FROM brands WHERE name = 'Apple'"
        ).fetchone()
        if not apple_row:
            print("error: Apple brand not in DB — bootstrap from create_mockup_db.sql first",
                  file=sys.stderr)
            return 1
        apple_uuid = apple_row[0]

        # Validate A-number rows. Any non-skipped row must have a canonical family.
        actionable_a: list[dict] = []
        skipped_a = 0
        for r in a_number_rows:
            if r.get('skip'):
                skipped_a += 1
                continue
            if not r.get('family'):
                print(f"error: A-number {r['a_number']} has no family "
                      f"(set skip:true or fill it in)", file=sys.stderr)
                return 2
            if r['family'] not in CANONICAL_LAPTOP_FAMILIES:
                print(f"error: A-number {r['a_number']} has invalid family "
                      f"{r['family']!r} (must be one of {sorted(CANONICAL_LAPTOP_FAMILIES)})",
                      file=sys.stderr)
                return 2
            actionable_a.append(r)

        # Validate board rows. Each must reference an A-number that's either
        # in the staging file's a_numbers (non-skipped) or already in the DB.
        actionable_b: list[dict] = []
        skipped_b = 0
        for r in board_rows:
            if r.get('skip'):
                skipped_b += 1
                continue
            if not r.get('a_number'):
                print(f"error: board {r.get('board_number','?')} has no a_number",
                      file=sys.stderr)
                return 2
            if not r.get('board_number'):
                print(f"error: board entry {r.get('source_folder','?')} has no board_number",
                      file=sys.stderr)
                return 2
            actionable_b.append(r)

        # Family cache.
        family_uuids: dict[str, str] = {}
        for fam_uuid, fam_name in conn.execute(
            "SELECT uuid, name FROM families WHERE brand_uuid = ?", (apple_uuid,)
        ):
            family_uuids[fam_name] = fam_uuid

        new_families: list[str] = []
        models_inserted = 0
        models_existing = 0
        boards_inserted = 0
        boards_existing = 0

        conn.execute("BEGIN")

        # Pass 1: A-numbers → models.
        for r in actionable_a:
            family = r['family']
            if family not in family_uuids:
                new_uuid = str(uuid.uuid4())
                conn.execute(
                    "INSERT INTO families (uuid, brand_uuid, name) VALUES (?, ?, ?)",
                    (new_uuid, apple_uuid, family),
                )
                family_uuids[family] = new_uuid
                new_families.append(family)
            family_uuid = family_uuids[family]

            folders = r.get('source_folders') or []
            shown = folders[:5]
            extra = len(folders) - len(shown)
            notes_folders = ','.join(shown)
            if extra > 0:
                notes_folders += f',...{extra} more'
            notes = f'xzz:{notes_folders}'
            display_name = r.get('display_name') or r['a_number']

            cur = conn.execute(
                "INSERT OR IGNORE INTO models "
                "(uuid, family_uuid, model_number, display_name, notes) "
                "VALUES (?, ?, ?, ?, ?)",
                (str(uuid.uuid4()), family_uuid, r['a_number'], display_name, notes),
            )
            if cur.rowcount > 0:
                models_inserted += 1
            else:
                models_existing += 1

        # Build a_number → model_uuid map (incl. pre-existing models).
        a_to_model: dict[str, str] = {}
        for a, model_uuid_val in conn.execute(
            """
            SELECT m.model_number, m.uuid
            FROM models m
            JOIN families f ON m.family_uuid = f.uuid
            WHERE f.brand_uuid = ?
            """, (apple_uuid,)
        ):
            a_to_model[a] = model_uuid_val

        # Pass 2: boards.
        for r in actionable_b:
            a = r['a_number']
            model_uuid_val = a_to_model.get(a)
            if model_uuid_val is None:
                # Parent A-number was skipped or doesn't exist; refuse.
                print(f"error: board {r['board_number']} references A-number {a} "
                      f"which is not in DB (was its A-number row skipped?)",
                      file=sys.stderr)
                conn.rollback()
                return 2
            board_notes_parts = [f"xzz:{r.get('source_folder','')}"]
            if r.get('codename'):
                board_notes_parts.append(f"codename:{r['codename']}")
            if r.get('year_hint'):
                board_notes_parts.append(f"year_hint:{r['year_hint']}")
            board_notes = '; '.join(board_notes_parts)

            cur = conn.execute(
                "INSERT OR IGNORE INTO boards "
                "(uuid, model_uuid, board_number, board_number_type, source, notes) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (str(uuid.uuid4()), model_uuid_val, r['board_number'],
                 'apple_820', 'xzz', board_notes),
            )
            if cur.rowcount > 0:
                boards_inserted += 1
            else:
                boards_existing += 1

        conn.commit()

        print(f"xzz-apple-laptops apply complete:")
        print(f"  {len(a_number_rows)} A-number rows in staging "
              f"({models_inserted} inserted, {models_existing} existing, "
              f"{skipped_a} skipped)")
        print(f"  {len(board_rows)} board rows in staging "
              f"({boards_inserted} inserted, {boards_existing} existing, "
              f"{skipped_b} skipped)")
        if new_families:
            print(f"  new families created: {', '.join(new_families)}")

        return 1 if (skipped_a > 0 or skipped_b > 0) else 0
    except Exception as e:
        conn.rollback()
        print(f"apply failed: {e}", file=sys.stderr)
        raise
    finally:
        conn.close()


if __name__ == '__main__':
    main()
