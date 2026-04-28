#!/usr/bin/env python3
"""
Pull Apple Mac models from Wikidata and merge into boards.db.

Two phases:
  1. EXTRACT (default): fetch SPARQL → write import-staging/wikidata-macs-<date>.json.
     Nothing touches boards.db. Reviewer eyeballs the staging file, sets
     skip:true on bad rows, edits typos, etc.
  2. APPLY (--apply <staging-file>): read staging → INSERT OR IGNORE into
     boards.db. Existing rows preserved; manual curation always wins.

Usage:
  scripts/import-wikidata-macs.py
  scripts/import-wikidata-macs.py --apply import-staging/wikidata-macs-2026-04-28.json
"""
from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

# Reuse the canonical family-pattern table from the v2 migration script. This
# is the single source of truth for family extraction. We import dynamically
# because the script filename has a hyphen (not a valid Python identifier).
def _import_migrate_module():
    from importlib.util import spec_from_file_location, module_from_spec
    here = Path(__file__).resolve().parent
    spec = spec_from_file_location('_mig', here / 'migrate-boarddb-v2.py')
    m = module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


_MIG = _import_migrate_module()
derive_family = _MIG.derive_family
FAMILY_PATTERNS = _MIG.FAMILY_PATTERNS
BRAND_FALLBACK = _MIG.BRAND_FALLBACK


# Canonical family names (the seriesLabel direct-match list). Anything outside
# these falls through to derive_family() pattern matching on the row's label.
CANONICAL_MAC_FAMILIES = {
    'MacBook', 'MacBook Air', 'MacBook Pro',
    'iMac', 'Mac mini', 'Mac Pro', 'Mac Studio',
}


def resolve_family(series_label: Optional[str], label: str) -> tuple[Optional[str], bool]:
    """Return (family_name, was_matched).

    Layered:
      1. If series_label is one of CANONICAL_MAC_FAMILIES → use it.
      2. Else fall back to derive_family('Apple', label) — pattern-matches
         on the label string (e.g., 'MacBook Pro 16-inch (Late 2019)').
      3. If derive_family returns the brand fallback ('Mac (other)' /
         'Uncategorized'), treat as no-match (None, False).
    """
    if series_label and series_label in CANONICAL_MAC_FAMILIES:
        return series_label, True
    family, matched = derive_family('Apple', label)
    if matched:
        return family, True
    return None, False


def main():
    ap = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    ap.add_argument('--apply', metavar='STAGING_FILE',
                    help='read STAGING_FILE and merge rows into boards.db')
    ap.add_argument('--db', default=str(Path(__file__).resolve().parent.parent / 'Board Database' / 'boards.db'),
                    help='path to boards.db (default: Board Database/boards.db relative to repo)')
    args = ap.parse_args()

    if args.apply:
        sys.exit(apply_staging(Path(args.apply), Path(args.db)))
    else:
        sys.exit(extract())


def extract() -> int:
    print("Phase A (extract) not yet implemented — Task 2 fills in.", file=sys.stderr)
    return 1


def apply_staging(staging_path: Path, db_path: Path) -> int:
    print("Phase B (apply) not yet implemented — Task 3 fills in.", file=sys.stderr)
    return 1


if __name__ == '__main__':
    main()
