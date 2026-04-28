#!/usr/bin/env python3
"""
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
    print("Phase A (extract) not yet implemented — Task 2 fills in.", file=sys.stderr)
    return 1


def apply_staging(staging_path: Path, db_path: Path) -> int:
    print("Phase B (apply) not yet implemented — Task 3 fills in.", file=sys.stderr)
    return 1


if __name__ == '__main__':
    main()
