#!/usr/bin/env python3
"""Enrich boards.db Apple entries from api.appledb.dev.

Two passes:

  1. ENRICH — for every Apple model whose model_number is an A-number
     present in AppleDB, append/refresh an `appledb:` segment in
     models.notes carrying released date, Mac identifier(s), Apple
     internal board codename(s), and SoC. The segment is idempotent —
     re-running the script replaces the previous segment in place.

  2. INSERT — for every A-number AppleDB knows but our DB doesn't,
     create a new (Apple / <type> / <A-number>) family-model row, with
     the same `appledb:` notes segment.

The script never writes board records — AppleDB has no 820-XXXXX board
numbers, so newly-inserted models start with zero boards. They are
reference entries that will pick up boards once user files arrive.

Source: https://api.appledb.dev/device/main.json.gz (~600 KB).
Stdlib only (urllib + gzip + json).

Usage:
  python3 scripts/import-appledb.py            # apply
  python3 scripts/import-appledb.py --dry-run
"""
from __future__ import annotations

import argparse
import collections
import gzip
import io
import json
import re
import sqlite3
import sys
import urllib.request
import uuid
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DB = REPO_ROOT / "Board Database" / "boards.db"
APPLEDB_URL = "https://api.appledb.dev/device/main.json.gz"

# Mac product types we care about — laptops, desktops, workstations.
# AppleDB also lists accessories (cases, cables) which we ignore.
MAC_TYPES = {
    "MacBook", "MacBook Air", "MacBook Pro",
    "iMac", "iMac Pro",
    "Mac mini", "Mac Pro", "Mac Studio",
}

# Match `appledb:<anything until ;-or-end>` so we can replace the
# previous segment in place without disturbing other notes content.
_APPLEDB_RE = re.compile(r"appledb:[^;]*(?:;|$)")


def fetch_appledb() -> list[dict]:
    """Returns the gunzipped, json-decoded list of devices."""
    req = urllib.request.Request(
        APPLEDB_URL,
        headers={"User-Agent": "boardripper-import/1.0 (+https://github.com/AlexeyInwerp/BoardRipper)"},
    )
    with urllib.request.urlopen(req, timeout=30.0) as resp:
        raw = resp.read()
    decompressed = gzip.GzipFile(fileobj=io.BytesIO(raw)).read()
    return json.loads(decompressed)


def collapse_a_numbers(devices: list[dict]) -> dict[str, dict]:
    """Group AppleDB devices by A-number (Mac-type only). One A-number
    often spans multiple year-revisions (A1181 → 8 MacBook 13" gens),
    so we union identifiers/codenames/SoCs and keep the earliest
    release date — which is when that physical board form factor first
    shipped.

    Returns: {A-number: {name, type, released, identifiers, codenames, socs}}
    """
    grouped: dict[str, dict] = {}
    for e in devices:
        if e.get("type") not in MAC_TYPES:
            continue
        for a in (e.get("model") or []):
            if not (a and a.startswith("A") and a[1:].isdigit()):
                continue
            slot = grouped.setdefault(a, {
                "names": [],
                "type": e["type"],
                "released_dates": [],
                "identifiers": [],
                "codenames": [],
                "socs": [],
            })
            slot["names"].append(e.get("name", ""))
            # `released` may be a string ("2022-07-15") or a list of strings
            # (multiple ship dates for some Mac Pro generations).
            rel = e.get("released")
            if isinstance(rel, list):
                slot["released_dates"].extend(d for d in rel if d)
            elif rel:
                slot["released_dates"].append(rel)
            for ident in (e.get("identifier") or []):
                if ident:
                    slot["identifiers"].append(ident)
            for brd in (e.get("board") or []):
                if brd:
                    slot["codenames"].append(brd)
            soc = e.get("soc")
            if soc:
                slot["socs"].append(soc)

    # Dedupe + condense
    out: dict[str, dict] = {}
    for a, slot in grouped.items():
        out[a] = {
            # Pick the EARLIEST release date — when this A-number first shipped.
            "released": min(slot["released_dates"]) if slot["released_dates"] else "",
            # First name seen makes for the cleanest display_name.
            "name": slot["names"][0] if slot["names"] else "",
            "type": slot["type"],
            "identifiers": sorted(set(slot["identifiers"])),
            "codenames": sorted(set(slot["codenames"])),
            "socs": sorted(set(slot["socs"])),
        }
    return out


def format_appledb_segment(meta: dict) -> str:
    """Build a single `appledb:` notes segment. Empty fields omitted."""
    parts: list[str] = []
    if meta.get("released"):
        parts.append(f"released={meta['released']}")
    if meta.get("identifiers"):
        parts.append(f"identifier={','.join(meta['identifiers'])}")
    if meta.get("codenames"):
        parts.append(f"codename={','.join(meta['codenames'])}")
    if meta.get("socs"):
        parts.append(f"soc={','.join(meta['socs'])}")
    if not parts:
        return ""
    return "appledb:" + "|".join(parts)


def merge_notes(existing: str | None, segment: str) -> str:
    """Replace any previous `appledb:...;` segment in-place; otherwise
    append. Preserves all other notes content."""
    existing = (existing or "").strip()
    if _APPLEDB_RE.search(existing):
        # In-place replacement. Re-add trailing `;` so subsequent
        # segments stay parseable.
        new = _APPLEDB_RE.sub(segment + ("; " if existing.rstrip().endswith(";") else ""), existing, count=1)
    elif existing:
        new = existing.rstrip(";").rstrip() + "; " + segment
    else:
        new = segment
    # Tidy whitespace and stray `;`.
    new = re.sub(r"\s*;\s*;\s*", "; ", new)
    new = re.sub(r"\s+", " ", new).strip()
    return new


def get_or_create_family(conn: sqlite3.Connection, brand_uuid: str,
                        family_name: str) -> str:
    row = conn.execute(
        "SELECT uuid FROM families WHERE brand_uuid = ? AND name = ?",
        (brand_uuid, family_name),
    ).fetchone()
    if row:
        return row[0]
    fam_uuid = str(uuid.uuid4())
    conn.execute(
        "INSERT INTO families (uuid, brand_uuid, name, notes) VALUES (?, ?, ?, ?)",
        (fam_uuid, brand_uuid, family_name, "appledb:from-import"),
    )
    return fam_uuid


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--db", type=Path, default=DEFAULT_DB)
    p.add_argument("--dry-run", action="store_true",
                   help="Report what would change. No DB writes.")
    p.add_argument("--skip-insert", action="store_true",
                   help="Only enrich existing models; skip inserting new "
                        "families/models for unknown A-numbers.")
    args = p.parse_args()

    if not args.db.exists():
        print(f"FATAL: {args.db} not found", file=sys.stderr)
        return 1

    print("fetching appledb…", file=sys.stderr)
    devices = fetch_appledb()
    print(f"  {len(devices)} entries", file=sys.stderr)

    grouped = collapse_a_numbers(devices)
    print(f"  {len(grouped)} unique A-numbers (Mac-type only)", file=sys.stderr)

    conn = sqlite3.connect(str(args.db))

    # Apple brand uuid
    row = conn.execute(
        "SELECT uuid FROM brands WHERE name = 'Apple'"
    ).fetchone()
    if not row:
        print("FATAL: no 'Apple' brand in boards.db", file=sys.stderr)
        return 1
    apple_uuid = row[0]

    # Existing Apple models keyed by A-number
    existing = conn.execute("""
        SELECT m.uuid, m.model_number, m.display_name, m.notes,
               f.name AS family_name, f.uuid AS family_uuid
        FROM models m
        JOIN families f ON m.family_uuid = f.uuid
        WHERE f.brand_uuid = ? AND m.model_number LIKE 'A%'
    """, (apple_uuid,)).fetchall()
    by_anum = {row[1]: row for row in existing}

    enriched_n = 0
    inserted_n = 0
    family_ensure_n = 0

    for a_num, meta in sorted(grouped.items()):
        seg = format_appledb_segment(meta)
        if not seg:
            continue

        if a_num in by_anum:
            m_uuid, m_num, m_dname, m_notes, m_fam, m_fam_uuid = by_anum[a_num]
            new_notes = merge_notes(m_notes, seg)
            if new_notes != (m_notes or ""):
                if args.dry_run:
                    print(f"  ENRICH {a_num} ({m_fam}/{m_dname or m_num}):")
                    print(f"    notes: {m_notes!r}")
                    print(f"        → {new_notes!r}")
                else:
                    conn.execute(
                        "UPDATE models SET notes = ? WHERE uuid = ?",
                        (new_notes, m_uuid),
                    )
                enriched_n += 1
        elif not args.skip_insert:
            family_name = meta["type"]  # "MacBook Pro", "Mac Studio", …
            if args.dry_run:
                print(f"  INSERT {a_num} → Apple/{family_name}/{a_num} "
                      f"({meta['name']!r})")
            else:
                fam_uuid = get_or_create_family(conn, apple_uuid, family_name)
                m_uuid = str(uuid.uuid4())
                conn.execute(
                    "INSERT INTO models (uuid, family_uuid, model_number, "
                    "display_name, notes) VALUES (?, ?, ?, ?, ?)",
                    (m_uuid, fam_uuid, a_num, meta["name"], seg),
                )
            inserted_n += 1

    if not args.dry_run:
        conn.commit()
    conn.close()

    print()
    print("appledb import summary:")
    print(f"  enriched existing models: {enriched_n}")
    print(f"  inserted new models:      {inserted_n}")
    if args.dry_run:
        print("  (dry-run — no DB writes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
