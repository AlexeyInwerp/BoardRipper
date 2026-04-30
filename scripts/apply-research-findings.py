#!/usr/bin/env python3
"""Take a JSON map {board_number: <result>} and promote each entry from
Unsorted/<ODM>/(unknown-<odm>) into proper hierarchy.

Two value shapes are accepted (mix freely in the same JSON):

  brand-only (legacy, manual research):
    "LA-7755P": "Lenovo"

  full triple (LLM classifier output):
    "LA-7755P": { "brand": "Lenovo", "family": "IdeaPad", "model": "Y570" }

Null in either shape (`null` or `{"brand": null}`) marks the board as
"tried, no match" — the row stays in Unsorted but its notes get the
`researched:no-match` tag so re-runs skip it.

Placement, in priority order:
  1. brand+family+model present → <Brand> / <Family> / <Model>
  2. brand+family present, no model → <Brand> / <Family> / (researched — TODO: model)
  3. brand only → <Brand> / <ODM> / (researched-<odm>)   (legacy behaviour)
  4. brand null → stay in Unsorted, append `researched:no-match`

Idempotent. A board already at the target row is left alone.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
import uuid as uuid_module
from collections import Counter
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DB = REPO_ROOT / "Board Database/boards.db"


def find_or_create_brand(conn: sqlite3.Connection, name: str) -> str:
    row = conn.execute("SELECT uuid FROM brands WHERE name = ?", (name,)).fetchone()
    if row:
        return row[0]
    new_uuid = str(uuid_module.uuid4())
    conn.execute("INSERT INTO brands (uuid, name) VALUES (?, ?)", (new_uuid, name))
    return new_uuid


def find_or_create_family(
    conn: sqlite3.Connection, brand_uuid: str, name: str
) -> str:
    row = conn.execute(
        "SELECT uuid FROM families WHERE brand_uuid = ? AND name = ?",
        (brand_uuid, name),
    ).fetchone()
    if row:
        return row[0]
    new_uuid = str(uuid_module.uuid4())
    conn.execute(
        "INSERT INTO families (uuid, brand_uuid, name) VALUES (?, ?, ?)",
        (new_uuid, brand_uuid, name),
    )
    return new_uuid


def find_or_create_model(
    conn: sqlite3.Connection,
    family_uuid: str,
    model_number: str,
    display_name: str,
) -> str:
    row = conn.execute(
        "SELECT uuid FROM models WHERE family_uuid = ? AND model_number = ?",
        (family_uuid, model_number),
    ).fetchone()
    if row:
        return row[0]
    new_uuid = str(uuid_module.uuid4())
    conn.execute(
        "INSERT INTO models (uuid, family_uuid, model_number, display_name) VALUES (?, ?, ?, ?)",
        (new_uuid, family_uuid, model_number, display_name),
    )
    return new_uuid


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--db", type=Path, default=DEFAULT_DB)
    p.add_argument(
        "--json",
        type=Path,
        help="JSON file with {board_number: brand|null}. Reads stdin if omitted.",
    )
    p.add_argument(
        "--insert-missing",
        action="store_true",
        help="Create new board records for codes not already in boards.db. "
             "Use when classifying filenames straight off the NAS — codes the "
             "filename-scan import never saw won't be in Unsorted, so the "
             "default 'skip' policy would silently drop them.",
    )
    args = p.parse_args()

    if args.json:
        if not args.json.exists():
            print(f"FATAL: {args.json} not found", file=sys.stderr)
            return 1
        mapping = json.loads(args.json.read_text())
    else:
        mapping = json.load(sys.stdin)

    if not isinstance(mapping, dict):
        print("FATAL: JSON root must be an object", file=sys.stderr)
        return 1

    conn = sqlite3.connect(str(args.db))
    conn.execute("PRAGMA foreign_keys = ON")

    by_brand: Counter = Counter()
    by_placement: Counter = Counter()
    promoted = 0
    inserted = 0
    tagged_only = 0
    skipped_already_classified = 0
    skipped_not_found = 0

    def _normalise(val):
        """(brand, family, model_number) tuple (each may be None) from a JSON value."""
        if val is None:
            return None, None, None
        if isinstance(val, str):
            return (val or None), None, None
        if isinstance(val, dict):
            return (
                val.get("brand") or None,
                val.get("family") or None,
                val.get("model") or val.get("model_number") or None,
            )
        return None, None, None

    for board_number, raw in mapping.items():
        brand, family, model_number = _normalise(raw)

        rows = conn.execute(
            """SELECT b.uuid, b.notes, m.uuid AS model_uuid, f.name AS odm
               FROM boards b
               JOIN models m ON b.model_uuid = m.uuid
               JOIN families f ON m.family_uuid = f.uuid
               JOIN brands br ON f.brand_uuid = br.uuid
               WHERE b.board_number = ? AND br.name = 'Unsorted'""",
            (board_number,),
        ).fetchall()

        if not rows:
            if not args.insert_missing or brand is None:
                # Default: skip. Or: --insert-missing was set but the
                # classification is null (nothing to insert).
                skipped_not_found += 1
                continue
            # --insert-missing: but first guard against duplicates —
            # if this board_number is already in the DB under any
            # non-Unsorted brand, leave it alone. The classifier may
            # have a different opinion than what's already curated;
            # silent overwrites would lose hand-fixed data.
            already = conn.execute(
                "SELECT 1 FROM boards WHERE board_number = ? LIMIT 1",
                (board_number,),
            ).fetchone()
            if already:
                skipped_already_classified += 1
                continue
            # Build the target row from scratch, then INSERT.
            target_brand_uuid = find_or_create_brand(conn, brand)
            target_family_name = family or "(researched — TODO: family)"
            target_family_uuid = find_or_create_family(
                conn, target_brand_uuid, target_family_name
            )
            if model_number:
                target_model_label = model_number
                target_display = model_number
                placement_kind = "brand+family+model" if family else "brand+model"
            else:
                target_model_label = (
                    "(researched — TODO: model)" if family
                    else "(researched — TODO: model)"
                )
                target_display = f"{family or brand} — TODO: curate model"
                placement_kind = "brand+family" if family else "brand-only"
            target_model_uuid = find_or_create_model(
                conn, target_family_uuid, target_model_label, target_display,
            )
            new_uuid = str(uuid_module.uuid4())
            note = f"researched:filename-list brand={brand}"
            if family:
                note += f"; family={family}"
            if model_number:
                note += f"; model={model_number}"
            conn.execute(
                "INSERT INTO boards (uuid, model_uuid, board_number, source, notes) "
                "VALUES (?, ?, ?, ?, ?)",
                (new_uuid, target_model_uuid, board_number, "filename-list-llm", note),
            )
            inserted += 1
            by_brand[brand] += 1
            by_placement[placement_kind] += 1
            continue

        for board_uuid, notes, _old_model_uuid, odm in rows:
            if brand is None:
                if notes and "researched:no-match" in notes:
                    skipped_already_classified += 1
                    continue
                new_notes = (notes or "") + " ; researched:no-match"
                conn.execute(
                    "UPDATE boards SET notes = ? WHERE uuid = ?",
                    (new_notes, board_uuid),
                )
                tagged_only += 1
                continue

            target_brand_uuid = find_or_create_brand(conn, brand)

            # Family rule:
            #  - if LLM extracted a real family → use it as-is
            #  - else fall back to the ODM name (legacy brand-only path)
            if family:
                target_family_name = family
            else:
                target_family_name = odm
            target_family_uuid = find_or_create_family(
                conn, target_brand_uuid, target_family_name
            )

            # Model rule:
            #  - if LLM extracted a real model_number → use it
            #  - else fall back to a per-family TODO placeholder
            if model_number:
                target_model_label = model_number
                target_display = model_number
                placement_kind = "brand+family+model" if family else "brand+model"
            else:
                target_model_label = (
                    "(researched — TODO: model)"
                    if family
                    else f"(researched-{odm.lower()})"
                )
                target_display = (
                    f"{family or odm} — TODO: curate model"
                )
                placement_kind = (
                    "brand+family"
                    if family
                    else "brand-only"
                )
            target_model_uuid = find_or_create_model(
                conn,
                target_family_uuid,
                target_model_label,
                target_display,
            )

            existing = conn.execute(
                "SELECT uuid FROM boards WHERE board_number = ? AND model_uuid = ?",
                (board_number, target_model_uuid),
            ).fetchone()
            if existing:
                skipped_already_classified += 1
                continue

            extra_notes = f" ; researched:web-search brand={brand}"
            if family:
                extra_notes += f"; family={family}"
            if model_number:
                extra_notes += f"; model={model_number}"
            new_notes = (notes or "") + extra_notes

            conn.execute(
                "UPDATE boards SET model_uuid = ?, notes = ? WHERE uuid = ?",
                (target_model_uuid, new_notes, board_uuid),
            )
            promoted += 1
            by_brand[brand] += 1
            by_placement[placement_kind] += 1

    conn.commit()
    conn.close()

    print(f"applied research findings:")
    print(f"  promoted:                    {promoted}")
    if inserted:
        print(f"  inserted (new board records): {inserted}")
    print(f"  tagged 'researched:no-match': {tagged_only}")
    print(f"  skipped (already classified): {skipped_already_classified}")
    print(f"  skipped (not in Unsorted):    {skipped_not_found}")
    if by_brand:
        print()
        print("  by brand:")
        for b, n in by_brand.most_common():
            print(f"    {b:<14} {n:>5}")
    if by_placement:
        print()
        print("  by placement granularity:")
        for k, n in by_placement.most_common():
            print(f"    {k:<22} {n:>5}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
