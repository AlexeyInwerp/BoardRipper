#!/usr/bin/env python3
r"""
Walk local source directories, extract board identifiers from filenames,
cross-reference each against boards.db, and write a Markdown report +
JSON sidecar to import-staging/.

OBSERVATION PASS ONLY — no DB writes, no --apply, no online lookups.

Usage:
  scripts/scan-board-filenames.py
  scripts/scan-board-filenames.py --source /path/A --source /path/B
  scripts/scan-board-filenames.py --db /path/to/boards.db
"""
from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Optional

# ---------------------------------------------------------------------------
# Pattern table
# ---------------------------------------------------------------------------
# Each entry: (name, owner, compiled regex). Patterns run case-insensitively
# over the bare filename (no folder path). re.findall() collects all matches
# per filename.

PATTERNS: list[tuple[str, str, re.Pattern]] = [
    # apple_820: 4 or 5 digits after 820-, optional revision letter
    ('apple_820',      'Apple',          re.compile(r'820-\d{4,5}(?:-[A-Z])?', re.IGNORECASE)),
    # compal_la: leading letter optional (LA-E891P style AND LA-6901P style both occur in the wild)
    ('compal_la',      'Compal',         re.compile(r'LA-[A-Z]?\d{3,4}[A-Z]?', re.IGNORECASE)),
    ('lcfc_nm',        'LCFC',           re.compile(r'NM-[A-Z]\d{3,4}', re.IGNORECASE)),
    ('quanta_da0',     'Quanta',         re.compile(r'DA0[A-Z0-9]{8,12}', re.IGNORECASE)),
    # msi_ms: alphanumeric tail of 4-8 chars (MS-16GF1, MS-16J51, MS-16P51, MS-16R1 all valid)
    ('msi_ms',         'MSI',            re.compile(r'\bMS-[A-Z0-9]{4,8}\b', re.IGNORECASE)),
    # asus_60nr: 4-8 alphanumeric chars after 60NR (e.g., 60NR02A0, 60NR0F90)
    ('asus_60nr',      'ASUS internal',  re.compile(r'60NR[A-Z0-9]{4,8}', re.IGNORECASE)),
    ('oem_6050',       'OEM (Foxconn et al.)', re.compile(r'6050[A-Z]?\d{7}', re.IGNORECASE)),
    # apple_a_number: lookarounds prevent matching A-numbers glued to other alphanumerics
    ('apple_a_number', 'Apple A-number', re.compile(r'(?<![A-Za-z0-9])A\d{4}(?![0-9])', re.IGNORECASE)),
]

# Tokens dropped from the substring-frequency catch-all. Lowercase compared.
STOPWORDS = {
    'apple', 'asus', 'acer', 'compal', 'quanta', 'lenovo', 'dell', 'hp', 'msi',
    'gigabyte', 'samsung', 'sony', 'toshiba', 'huawei', 'foxconn', 'wistron',
    'boardview', 'bios', 'firmware', 'rev', 'revision', 'schematic',
    'motherboard', 'mainboard', 'logic', 'board', 'mlb',
    'jpg', 'jpeg', 'png', 'pdf', 'bin', 'tvw', 'brd', 'bdv', 'fz', 'cad', 'xzz',
    'docx', 'doc', 'txt', 'zip', 'rar', '7z',
    'circuit', 'diagram', 'schematics', 'service', 'manual',
    'mb', 'gb', 'tb',
}

TOKENIZE_SPLIT_RE = re.compile(r'[\s_\-./()\[\]+,]+')

# ---------------------------------------------------------------------------
# Public API (also imported by tests)
# ---------------------------------------------------------------------------


def extract_matches(filename: str) -> dict[str, list[str]]:
    """Return {pattern_name: [matches]} for one filename. Empty lists omitted."""
    out: dict[str, list[str]] = {}
    for name, _owner, pat in PATTERNS:
        hits = pat.findall(filename)
        if hits:
            # Normalize to uppercase for consistency (Apple revisions stay as-is).
            out[name] = [h.upper() for h in hits]
    return out


def cross_reference_db(
    db_path: Optional[Path],
    codes_by_pattern: dict[str, set[str]],
) -> dict[str, dict[str, set[str]]]:
    """Split each pattern's unique codes into 'already_in_db' vs 'new'.

    Returns {pattern_name: {'already_in_db': set, 'new': set}}.
    If db_path is None or schema is wrong, returns 'unknown_db_state' for all.
    """
    if db_path is None or not db_path.exists():
        return {p: {'unknown_db_state': set(codes)} for p, codes in codes_by_pattern.items()}

    conn = sqlite3.connect(f'file:{db_path}?mode=ro', uri=True)
    try:
        ver_row = conn.execute(
            "SELECT version FROM schema_version LIMIT 1"
        ).fetchone()
        if not ver_row or ver_row[0] < 2:
            return {p: {'unknown_db_state': set(codes)} for p, codes in codes_by_pattern.items()}

        result: dict[str, dict[str, set[str]]] = {}
        for pattern_name, codes in codes_by_pattern.items():
            already: set[str] = set()
            new: set[str] = set()
            for code in codes:
                if pattern_name == 'apple_a_number':
                    row = conn.execute(
                        "SELECT 1 FROM models WHERE upper(model_number) = ? LIMIT 1",
                        (code.upper(),)
                    ).fetchone()
                else:
                    row = conn.execute(
                        "SELECT 1 FROM boards WHERE upper(board_number) = ? "
                        "OR uuid IN (SELECT board_uuid FROM board_aliases WHERE upper(alias) = ?) "
                        "LIMIT 1",
                        (code.upper(), code.upper())
                    ).fetchone()
                if row:
                    already.add(code)
                else:
                    new.add(code)
            result[pattern_name] = {'already_in_db': already, 'new': new}
        return result
    finally:
        conn.close()


def tokenize_unmatched(filenames: Iterable[str]) -> Counter:
    """Tokenize filenames that didn't strongly match any pattern.

    Drops STOPWORDS, drops tokens shorter than 4 chars, drops pure-digit
    tokens shorter than 5 chars. Returns Counter of token frequencies.
    """
    counter: Counter = Counter()
    for name in filenames:
        # Strip extension
        stem = name.rsplit('.', 1)[0] if '.' in name else name
        for tok in TOKENIZE_SPLIT_RE.split(stem):
            tok_lower = tok.lower()
            if len(tok) < 4:
                continue
            if tok_lower in STOPWORDS:
                continue
            if tok.isdigit() and len(tok) < 5:
                continue
            counter[tok] += 1
    return counter


def main():
    print("Phase: scaffold (Task 1) — main not implemented yet.", file=sys.stderr)
    return 1


if __name__ == '__main__':
    sys.exit(main())
