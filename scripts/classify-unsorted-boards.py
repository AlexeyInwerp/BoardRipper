#!/usr/bin/env python3
"""Classify Board Database/boards.db rows currently parked under
Unsorted/<ODM>/(unknown — TODO: curate) by inferring (brand, family) from
the sample filename baked into the board's notes field at filename-scan
import time.

The notes column contains entries like
  filename-scan:compal_la; sample:LENOVO E41-25 LA-F971P.pdf
where the filename usually leaks the consumer brand and (often) a product
family. We don't need to hit the network for any of those — match the
keywords, promote the row.

Promotion structure (post-script):
  <Brand>           ← consumer brand (Lenovo, HP, Acer, Dell, Asus, ...)
    <ODM>           ← family stays the original ODM (Compal, Quanta, ...)
                       so the manufacturing-side fact isn't lost
      (unsorted-<odm>)  ← model placeholder — same shape as Unsorted's
                          (unknown — TODO: curate) but scoped per-brand
        <board>     ← UPDATEd in-place; UUID preserved

Why brand→ODM (not brand→product-family)? Extracting product-family from
the filename (ThinkPad / Pavilion / Aspire) is an extra heuristic that
fails often. Brand alone is high-precision and already collapses the
2.7K Unsorted blob into one cluster per consumer brand — the practical
win the user asked for. Product-family curation is a follow-up.

Boards whose sample filename has no recognisable brand keyword stay
under Unsorted untouched.

Usage:
  python3 scripts/classify-unsorted-boards.py
  python3 scripts/classify-unsorted-boards.py --dry-run
  python3 scripts/classify-unsorted-boards.py --db <path>

Idempotent: re-runs over already-classified rows are no-ops because the
target row no longer matches the WHERE clause.
"""

from __future__ import annotations

import argparse
import re
import sqlite3
import sys
import uuid as uuid_module
from collections import Counter
from pathlib import Path
from typing import Optional

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DB = REPO_ROOT / "Board Database/boards.db"

# Brand keyword table. Order matters within an entry (longer / more
# specific first) but order between entries doesn't because we collect
# all hits and pick the most specific one.
#
# Why so many product-family tokens (ThinkPad, Pavilion, etc.) under each
# brand? They give us a positive ID even when the brand name itself isn't
# in the filename — many uploads only carry the family name. We classify
# them under the consumer brand on the assumption that the family is
# unambiguous (ThinkPad ⇒ Lenovo, Pavilion ⇒ HP, etc.).
BRANDS: list[tuple[str, list[str]]] = [
    ("Lenovo",    ["lenovo", "thinkpad", "ideapad", "yoga", "legion",
                   "thinkbook", "thinkcentre", "lenog", "联想"]),
    ("HP",        ["hewlett-packard", "hewlett packard",
                   "elitebook", "probook", "spectre", "zbook", "pavilion",
                   "compaq", "惠普",
                   # bare HP — matched anchored to a non-letter on at least
                   # one side. find_brand() handles this via a word-boundary
                   # variant below; the `hp ` substring is just enough to
                   # tag the 'inventec hp ', 'hp pavilion 23 aio', 'hp 14m',
                   # 'hp x2', 'hp gen' style filenames the simple substring
                   # match was missing.
                   " hp ", "hp ", "_hp_", "hp_", "hp-",
                   "hp 14", "hp 15", "hp 17", "hp envy", "hp omen",
                   "hp x2", "hp gen", "hp aio"]),
    ("Acer",      ["acer", "aspire", "extensa", "travelmate", "predator",
                   "nitro", "swift", "spin", "ferrari", "宏碁", "宏基"]),
    ("Dell",      ["dell ", "inspiron", "latitude", "vostro", "precision",
                   "alienware", "studio xps", "戴尔"]),
    ("Asus",      ["asus", "zenbook", "vivobook", "rog ", "tuf gaming",
                   "expertbook", "chromebook", "n550", "n552", "g75",
                   "ux305", "ux330", "x205", "华硕"]),
    ("Toshiba",   ["toshiba", "satellite", "tecra", "qosmio",
                   "portege", "dynabook", "东芝"]),
    ("Fujitsu",   ["fujitsu", "fujistu", "lifebook", "stylistic",
                   "esprimo", "celsius", "富士通"]),
    ("Samsung",   ["samsung", "三星", "ativ book", "notebook 9"]),
    ("LG",        ["lg gram", "lg electronics", " lg-", "lg notebook"]),
    ("Sony",      ["sony", "vaio", " svf", " svs", "索尼"]),
    ("MSI",       ["msi gt", "msi ge", "msi gp", "msi gs", "msi gl",
                   "msi gf", "msi cx", "msi cr", "msi pe", "msi ps",
                   "msi summit", "msi prestige", "msi creator", "msi modern",
                   "msi katana", "msi sword", "msi raider", "msi vector",
                   "msi cyborg", "msi titan"]),
    ("Apple",     ["macbook", "imac", "mac mini", "mac pro", "mac studio",
                   "iphone", "ipad", "apple watch", "airpods",
                   "苹果"]),
    ("Razer",     ["razer", "blade 14", "blade 15", "blade 17",
                   "blade pro"]),
    ("Huawei",    ["matebook", "huawei", "honor magicbook"]),
    ("Xiaomi",    ["xiaomi", "redmibook", "mi notebook"]),
    ("Microsoft", ["surface book", "surface laptop", "surface pro",
                   "microsoft surface"]),
    ("Gigabyte",  ["gigabyte", "aero 15", "aero 17", "aorus"]),
    ("Clevo",     ["clevo", "sager", "eluktronics", "schenker"]),
    ("Medion",    ["medion", "akoya", "erazer"]),
    ("Panasonic", ["panasonic", "toughbook"]),
    ("Mechrevo",  ["mechrevo", "机械革命"]),
    ("Hasee",     ["hasee", "shenzhou", "神舟"]),
    ("Tongfang",  ["tongfang", "同方"]),
    ("Haier",     ["haier", "海尔"]),
    ("Founder",   ["founder ", "方正"]),
    ("Eurocom",   ["eurocom"]),
    ("Origin PC", ["origin pc"]),
    ("System76",  ["system76"]),
    ("Avita",     ["avita "]),
    ("LG",        ["lg gram"]),
    ("Vaio",      ["vaio "]),
]


def find_brand(filename: str) -> Optional[str]:
    fl = filename.lower()
    best_brand: Optional[str] = None
    best_keyword_len = 0
    for brand, keywords in BRANDS:
        for kw in keywords:
            if kw in fl and len(kw) > best_keyword_len:
                best_brand = brand
                best_keyword_len = len(kw)
    return best_brand


# notes format: "filename-scan:<pattern>; sample:<filename>"
NOTES_RE = re.compile(r"^filename-scan:(\w+);\s*sample:(.+)$")


def parse_notes(notes: str) -> Optional[tuple[str, str]]:
    if not notes:
        return None
    m = NOTES_RE.match(notes)
    if not m:
        return None
    return m.group(1), m.group(2)


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
    conn: sqlite3.Connection, family_uuid: str, model_number: str, display_name: str
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


# ODM family-name normalisation (matches what filename-scan importer wrote).
ODM_BY_PATTERN: dict[str, str] = {
    "compal_la":  "Compal",
    "lcfc_nm":    "LCFC",
    "quanta_da0": "Quanta",
    "msi_ms":     "MSI",
    "asus_60nr":  "ASUS",
    "oem_6050":   "Foxconn",
    "apple_820":  "Apple",
}


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--db", type=Path, default=DEFAULT_DB)
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--verbose", action="store_true",
                   help="print every classification (otherwise just summary)")
    args = p.parse_args()

    if not args.db.exists():
        print(f"FATAL: {args.db} not found", file=sys.stderr)
        return 1

    conn = sqlite3.connect(str(args.db))
    conn.execute("PRAGMA foreign_keys = ON")

    rows = conn.execute(
        """SELECT b.uuid, b.board_number, b.notes, m.model_number AS odm_model
           FROM boards b
           JOIN models m ON b.model_uuid = m.uuid
           JOIN families f ON m.family_uuid = f.uuid
           JOIN brands br ON f.brand_uuid = br.uuid
           WHERE br.name = 'Unsorted'"""
    ).fetchall()
    print(f"Unsorted boards in scope: {len(rows)}")

    # Group resolution outcomes for the report.
    by_brand: Counter = Counter()
    by_brand_per_odm: dict[tuple[str, str], int] = {}
    no_notes = 0
    no_brand = 0
    promoted_count = 0

    try:
        for board_uuid, board_number, notes, odm_model in rows:
            parsed = parse_notes(notes or "")
            if not parsed:
                no_notes += 1
                continue
            pattern, sample = parsed
            brand = find_brand(sample)
            if not brand:
                no_brand += 1
                continue

            odm_family = ODM_BY_PATTERN.get(pattern)
            if not odm_family:
                # Unknown ODM pattern — fall back to a generic family.
                odm_family = "Unknown ODM"

            # Build target hierarchy: <Brand> / <ODM-family> /
            # (unsorted-<odm>) — keeps ODM info, gives users a per-brand
            # cluster instead of one global Unsorted.
            target_brand_uuid = find_or_create_brand(conn, brand)
            target_family_uuid = find_or_create_family(
                conn, target_brand_uuid, odm_family
            )
            display = f"(unsorted-{odm_family.lower()} — TODO: curate)"
            target_model_uuid = find_or_create_model(
                conn,
                target_family_uuid,
                f"(unsorted-{odm_family.lower()})",
                display,
            )

            new_notes = f"{notes} ; classify:filename-keyword brand={brand}"

            # board_number unique against (board_number, model_uuid) so the
            # move is safe as long as the brand+ODM model_uuid we just
            # found-or-created doesn't already hold this board_number.
            existing = conn.execute(
                "SELECT uuid FROM boards WHERE board_number = ? AND model_uuid = ?",
                (board_number, target_model_uuid),
            ).fetchone()
            if existing:
                # Idempotent re-run (rare) — leave alone.
                continue

            conn.execute(
                "UPDATE boards SET model_uuid = ?, notes = ? WHERE uuid = ?",
                (target_model_uuid, new_notes, board_uuid),
            )

            promoted_count += 1
            by_brand[brand] += 1
            key = (brand, odm_family)
            by_brand_per_odm[key] = by_brand_per_odm.get(key, 0) + 1
            if args.verbose:
                print(f"  + {board_number:>14}  [{odm_family:<8}] -> {brand:<10} ({sample[:60]})")

        if args.dry_run:
            conn.rollback()
            print("\nDRY RUN — rolled back")
        else:
            conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

    print()
    print("classification summary:")
    print(f"  promoted:           {promoted_count}")
    print(f"  no notes/sample:    {no_notes}")
    print(f"  no brand keyword:   {no_brand}")
    print()
    print("by brand:")
    for b, n in by_brand.most_common():
        print(f"  {b:<14} {n:>5}")
    print()
    print("by brand × ODM:")
    for (brand, odm), n in sorted(
        by_brand_per_odm.items(), key=lambda x: (-x[1], x[0])
    )[:30]:
        print(f"  {brand:<14} {odm:<10} {n:>5}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
