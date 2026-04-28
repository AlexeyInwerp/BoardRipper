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
import urllib.parse
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


WIKIDATA_SPARQL_URL = 'https://query.wikidata.org/sparql'

# Wikidata's polite-use rule requires a User-Agent identifying the client.
USER_AGENT = (
    'BoardRipper-Wikidata-Macs-Import/1.0 '
    '(https://github.com/AlexeyInwerp/BoardRipper)'
)

# SPARQL: Apple Macs with optional A-number / EMC / year / series.
# Property IDs are best-effort — implementer should validate empirically
# the first time the script runs against the live endpoint.
SPARQL_QUERY = """
SELECT ?item ?itemLabel ?aNumber ?emc ?year ?series ?seriesLabel WHERE {
  ?item wdt:P176 wd:Q312.
  ?item wdt:P31/wdt:P279* wd:Q3962655.
  OPTIONAL { ?item wdt:P3618 ?aNumber. }
  OPTIONAL { ?item wdt:P9216 ?emc. }
  OPTIONAL { ?item wdt:P571 ?year. }
  OPTIONAL { ?item wdt:P179 ?series. }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
"""


def _qid_from_uri(uri: str) -> str:
    """Strip 'http://www.wikidata.org/entity/' prefix to get bare 'Q12345'."""
    return uri.rsplit('/', 1)[-1]


def parse_sparql_row(binding: dict) -> dict:
    """Convert one SPARQL JSON binding into a staging-row dict.

    Output shape (matches spec):
      {
        wikidata_qid, family, model_number, display_name,
        year, emc, raw_label, skip
      }

    Notes:
      - 'year' is parsed from the ISO timestamp Wikidata returns (e.g.,
        '2019-11-13T00:00:00Z') down to just the integer year.
      - 'family' is resolved here so the staging file already has a best-guess;
        the reviewer can override.
      - 'skip' defaults to False.
    """
    qid = _qid_from_uri(binding['item']['value'])
    label = binding['itemLabel']['value']
    a_number = binding.get('aNumber', {}).get('value', '')
    emc = binding.get('emc', {}).get('value', '')
    year_raw = binding.get('year', {}).get('value', '')
    series_label = binding.get('seriesLabel', {}).get('value')

    year: Optional[int] = None
    if year_raw:
        m = re.match(r'^(\d{4})', year_raw)
        if m:
            year = int(m.group(1))

    family, _ = resolve_family(series_label, label)

    # display_name = label, with a light cleanup pass: strip trailing series
    # parens that just repeat the family.
    display_name = label

    return {
        'wikidata_qid': qid,
        'family': family,
        'model_number': a_number,
        'display_name': display_name,
        'year': year,
        'emc': emc or None,
        'raw_label': label,
        'skip': False,
    }


def fetch_wikidata_macs() -> dict:
    """POST the SPARQL query to Wikidata, return parsed JSON."""
    body = urllib.parse.urlencode({'query': SPARQL_QUERY, 'format': 'json'}).encode('utf-8')
    req = urllib.request.Request(
        WIKIDATA_SPARQL_URL,
        data=body,
        headers={
            'User-Agent': USER_AGENT,
            'Accept': 'application/sparql-results+json',
            'Content-Type': 'application/x-www-form-urlencoded',
        },
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode('utf-8'))


def extract() -> int:
    print('fetching Wikidata Mac models …', file=sys.stderr)
    response = fetch_wikidata_macs()
    bindings = response.get('results', {}).get('bindings', [])
    rows = [parse_sparql_row(b) for b in bindings]

    out_dir = Path(__file__).resolve().parent.parent / 'import-staging'
    out_dir.mkdir(exist_ok=True)
    today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
    out_path = out_dir / f'wikidata-macs-{today}.json'

    payload = {
        'fetched_at': datetime.now(timezone.utc).isoformat(),
        'source_query': SPARQL_QUERY.strip(),
        'row_count': len(rows),
        'rows': rows,
    }
    out_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False))

    family_counts: dict[str, int] = {}
    null_count = 0
    for r in rows:
        if r['family'] is None:
            null_count += 1
        else:
            family_counts[r['family']] = family_counts.get(r['family'], 0) + 1

    print(f"wrote {out_path} — {len(rows)} rows", file=sys.stderr)
    print(f"  family distribution: {family_counts}", file=sys.stderr)
    if null_count:
        print(f"  {null_count} row(s) without a resolved family — review manually", file=sys.stderr)
    print(f"\nReview {out_path}, then run:", file=sys.stderr)
    print(f"  scripts/import-wikidata-macs.py --apply {out_path}", file=sys.stderr)
    return 0


def apply_staging(staging_path: Path, db_path: Path) -> int:
    print("Phase B (apply) not yet implemented — Task 3 fills in.", file=sys.stderr)
    return 1


if __name__ == '__main__':
    main()
