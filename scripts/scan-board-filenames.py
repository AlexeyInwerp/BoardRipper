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


DEFAULT_SOURCES = [
    Path('/Users/besitzer/Desktop/Boardviewer/samples'),
    Path('/Users/besitzer/Library/CloudStorage/SynologyDrive-Mac/XZZ'),
    Path('/Users/besitzer/Library/CloudStorage/SynologyDrive-Mac/DESKTOP/BOARDS STUFF'),
]
DEFAULT_DB = Path(__file__).resolve().parent.parent / 'Board Database' / 'boards.db'


def scan_sources(sources: list[Path]) -> dict:
    """Walk all sources, extract matches per filename. Returns aggregated data.

    Output shape:
      {
        'sources': [{path, files_scanned, files_with_match, accessible}],
        'matches': [(pattern_name, value, source_path, file_path), ...],
        'unmatched_filenames': [filename, ...],
        'a_number_only_filenames': [filename, ...],
      }
    """
    sources_meta: list[dict] = []
    matches: list[tuple[str, str, str, str]] = []
    unmatched_filenames: list[str] = []
    a_number_only_filenames: list[str] = []

    for src in sources:
        meta = {'path': str(src), 'files_scanned': 0,
                'files_with_match': 0, 'accessible': src.exists()}
        if not src.exists():
            print(f"warning: source path does not exist: {src}", file=sys.stderr)
            sources_meta.append(meta)
            continue

        for p in _walk(src):
            meta['files_scanned'] += 1
            extracted = extract_matches(p.name)
            if extracted:
                meta['files_with_match'] += 1
                for pat_name, vals in extracted.items():
                    for v in vals:
                        matches.append((pat_name, v, str(src), str(p)))
                # If only apple_a_number matched (weak signal), still tokenize
                if set(extracted.keys()) == {'apple_a_number'}:
                    a_number_only_filenames.append(p.name)
            else:
                unmatched_filenames.append(p.name)
        sources_meta.append(meta)

    return {
        'sources': sources_meta,
        'matches': matches,
        'unmatched_filenames': unmatched_filenames,
        'a_number_only_filenames': a_number_only_filenames,
    }


def _walk(root: Path) -> Iterable[Path]:
    """Yield all files under root. Skips hidden dirs/files (dotfiles).
    Catches PermissionError per-subtree and continues."""
    try:
        for entry in root.iterdir():
            if entry.name.startswith('.'):
                continue
            try:
                if entry.is_dir():
                    yield from _walk(entry)
                elif entry.is_file():
                    yield entry
            except PermissionError as e:
                print(f"warning: {e}", file=sys.stderr)
    except PermissionError as e:
        print(f"warning: {e}", file=sys.stderr)
    except OSError as e:
        print(f"warning: {e}", file=sys.stderr)


def write_json_sidecar(out_path: Path, scan_data: dict, xref: dict,
                       unmatched_top50: list[tuple[str, int]],
                       db_path: Optional[Path]) -> None:
    """Write the machine-readable JSON output."""
    # Build per-pattern stats
    per_pattern: dict[str, dict] = {}
    for pat_name, _owner, _pat in PATTERNS:
        codes = {m[1] for m in scan_data['matches'] if m[0] == pat_name}
        files = sorted({m[3] for m in scan_data['matches'] if m[0] == pat_name})
        xref_p = xref.get(pat_name, {})
        already = sorted(xref_p.get('already_in_db', set()))
        new = sorted(xref_p.get('new', set()))
        unknown = sorted(xref_p.get('unknown_db_state', set()))

        # First-encountered filename per code (basename only — not the full path).
        # Iterates scan_data['matches'] in original (deterministic) order;
        # setdefault keeps the FIRST match per code.
        first_filename: dict[str, str] = {}
        for m_pat, m_value, _src, m_path in scan_data['matches']:
            if m_pat == pat_name:
                first_filename.setdefault(m_value, Path(m_path).name)

        per_pattern[pat_name] = {
            'unique_codes': len(codes),
            'file_count': len(files),
            'already_in_db_count': len(already),
            'new_count': len(new),
            'unknown_db_state_count': len(unknown),
            'samples_new': new[:20],
            'samples_already_in_db': already[:5],
            # New fields for the importer:
            'new_full': new,                # full sorted list of net-new codes
            'first_filename': first_filename,  # code -> sample filename (basename)
        }

    # Per-source
    per_source = {
        s['path']: {
            'files_scanned': s['files_scanned'],
            'files_with_match': s['files_with_match'],
            'accessible': s['accessible'],
        }
        for s in scan_data['sources']
    }

    # Sample filenames per top-50 token
    samples_per_token: dict[str, list[str]] = {}
    pool = scan_data['unmatched_filenames'] + scan_data['a_number_only_filenames']
    for token, _count in unmatched_top50:
        samples_per_token[token] = [
            f for f in pool if token.lower() in f.lower()
        ][:3]

    payload = {
        'fetched_at': datetime.now(timezone.utc).isoformat(),
        'db_path': str(db_path) if db_path else None,
        'sources_scanned': [s['path'] for s in scan_data['sources']],
        'summary': {
            'files_scanned_total': sum(s['files_scanned'] for s in scan_data['sources']),
            'files_with_match_total': sum(s['files_with_match'] for s in scan_data['sources']),
            'unique_codes_total': sum(p['unique_codes'] for p in per_pattern.values()),
        },
        'per_pattern': per_pattern,
        'per_source': per_source,
        'unmatched_top50': [
            {'token': t, 'count': c, 'samples': samples_per_token.get(t, [])}
            for t, c in unmatched_top50
        ],
    }
    out_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False))


def write_markdown_report(out_path: Path, scan_data: dict, xref: dict,
                          unmatched_top50: list[tuple[str, int]],
                          db_path: Optional[Path]) -> None:
    """Write the human-readable Markdown report."""
    pattern_owner = {name: owner for name, owner, _ in PATTERNS}
    lines: list[str] = []
    lines.append(f"# Filename Scan — {datetime.now(timezone.utc).strftime('%Y-%m-%d')}")
    lines.append("")
    if not db_path or not db_path.exists():
        lines.append("> ⚠️ DB cross-reference disabled (boards.db not found)")
        lines.append("")

    # Summary table
    files_total = sum(s['files_scanned'] for s in scan_data['sources'])
    files_match = sum(s['files_with_match'] for s in scan_data['sources'])
    matches_total = len(scan_data['matches'])
    unique_codes = sum(
        len({m[1] for m in scan_data['matches'] if m[0] == p[0]}) for p in PATTERNS
    )
    lines.append("## Summary")
    lines.append("")
    lines.append("| metric | value |")
    lines.append("|---|---:|")
    lines.append(f"| sources scanned | {len(scan_data['sources'])} |")
    lines.append(f"| files scanned | {files_total:,} |")
    lines.append(f"| files with at least one pattern match | {files_match:,} |")
    lines.append(f"| total pattern matches (with duplicates) | {matches_total:,} |")
    lines.append(f"| unique board+model codes extracted | {unique_codes:,} |")
    lines.append("")

    # Per-pattern
    lines.append("## Per-pattern results")
    lines.append("")
    for pat_name, owner, _ in PATTERNS:
        codes = {m[1] for m in scan_data['matches'] if m[0] == pat_name}
        if not codes:
            lines.append(f"### {pat_name} ({owner}) — 0 matches")
            lines.append("")
            continue
        xref_p = xref.get(pat_name, {})
        already = xref_p.get('already_in_db', set())
        new = xref_p.get('new', set())
        unknown = xref_p.get('unknown_db_state', set())
        lines.append(f"### {pat_name} ({owner}) — {len(codes)} unique codes")
        if already or new:
            pct_new = 100 * len(new) / len(codes) if codes else 0
            lines.append(f"- already_in_db: {len(already)}")
            lines.append(f"- new: {len(new)} ({pct_new:.0f}%)")
        if unknown:
            lines.append(f"- unknown_db_state: {len(unknown)}")
        sample_new = sorted(new)[:10]
        if sample_new:
            lines.append(f"- Sample of {min(10, len(new))} new: {', '.join(sample_new)}")
        lines.append("")

    # Per-source
    lines.append("## Per-source breakdown")
    lines.append("")
    lines.append("| source | files | with match |")
    lines.append("|---|---:|---:|")
    for s in scan_data['sources']:
        flag = '' if s['accessible'] else ' ⚠️ inaccessible'
        lines.append(
            f"| `{s['path']}`{flag} | {s['files_scanned']:,} | {s['files_with_match']:,} |"
        )
    lines.append("")

    # Top unmatched substrings
    lines.append("## Top 50 unmatched substrings")
    lines.append("")
    if not unmatched_top50:
        lines.append("(none)")
    else:
        lines.append("| token | count | sample filename |")
        lines.append("|---|---:|---|")
        pool = scan_data['unmatched_filenames'] + scan_data['a_number_only_filenames']
        for token, count in unmatched_top50:
            sample = next((f for f in pool if token.lower() in f.lower()), '')
            lines.append(f"| `{token}` | {count} | {sample} |")
    lines.append("")

    out_path.write_text('\n'.join(lines))


def main():
    ap = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    ap.add_argument('--source', metavar='PATH', action='append',
                    help='Source directory to walk (repeatable). Defaults to 3 known paths.')
    ap.add_argument('--db', metavar='PATH', default=str(DEFAULT_DB),
                    help='Path to boards.db (read-only). Default: Board Database/boards.db')
    args = ap.parse_args()

    sources = [Path(s) for s in args.source] if args.source else DEFAULT_SOURCES
    db_path: Optional[Path] = Path(args.db) if args.db else None
    if db_path and not db_path.exists():
        print(f"note: --db path not found: {db_path} (cross-reference disabled)",
              file=sys.stderr)
        db_path = None

    print(f"scanning {len(sources)} source(s) …", file=sys.stderr)
    scan_data = scan_sources(sources)

    # Collect unique codes per pattern for cross-reference
    codes_by_pattern: dict[str, set[str]] = {p[0]: set() for p in PATTERNS}
    for pat_name, value, _src, _path in scan_data['matches']:
        codes_by_pattern[pat_name].add(value)

    xref = cross_reference_db(db_path, codes_by_pattern)

    # Tokenize unmatched filenames
    weak_pool = scan_data['unmatched_filenames'] + scan_data['a_number_only_filenames']
    counter = tokenize_unmatched(weak_pool)
    unmatched_top50 = counter.most_common(50)

    # Output
    out_dir = Path(__file__).resolve().parent.parent / 'import-staging'
    out_dir.mkdir(exist_ok=True)
    today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
    md_path = out_dir / f'filename-scan-{today}.md'
    json_path = out_dir / f'filename-scan-{today}.json'
    write_markdown_report(md_path, scan_data, xref, unmatched_top50, db_path)
    write_json_sidecar(json_path, scan_data, xref, unmatched_top50, db_path)

    files_total = sum(s['files_scanned'] for s in scan_data['sources'])
    files_match = sum(s['files_with_match'] for s in scan_data['sources'])
    print(f"\nscanned {files_total:,} files; {files_match:,} had pattern matches",
          file=sys.stderr)
    print(f"  Markdown: {md_path}", file=sys.stderr)
    print(f"  JSON:     {json_path}", file=sys.stderr)
    return 0


if __name__ == '__main__':
    sys.exit(main())
