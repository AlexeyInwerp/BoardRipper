#!/usr/bin/env python3
"""Normalize the family layer of boards.db.

The classifier + multiple ad-hoc imports have left families with case
duplicates ("ENVY"/"Envy"), ODM-as-family pollution ("Lenovo/Compal"),
and model-level entries promoted to family ("HP/Compaq 6730B"). This
script consolidates them into a canonical taxonomy without touching
board records — only family rows are merged and models repointed.

Phases run independently and idempotently. Each phase is gated by a
flag so you can stop after any safe checkpoint.

  --phase-a  Case-fold equivalents (lowest risk)
  --phase-b  Promote suffix-only family names to model_number under a
             canonical parent family
  --phase-c  Quarantine ODM-named families ("HP/Compal" etc.) into a
             single per-brand "(unknown family — research needed)"
             bucket so the family layer represents consumer product
             lines, not PCB manufacturers

  --all      Run A + B + C
  --dry-run  Report planned changes without writing

The migration is mechanical: when two families collide, the *target*
family keeps its UUID and absorbs the source's models. Empty families
are dropped after migration. Board UUIDs and notes are unchanged.
"""
from __future__ import annotations

import argparse
import sqlite3
import sys
from collections import defaultdict
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DB = REPO_ROOT / "Board Database" / "boards.db"


# ─── Phase A: case-fold + obvious typo merges ───────────────────────────

# (brand, source_family) → canonical_family. Source is matched
# case-sensitively; canonical is what survives. Order matters when
# multiple sources collapse to the same target — they all just point at
# the same row.
PHASE_A_MERGES: list[tuple[str, str, str]] = [
    # HP
    ("HP", "ENVY",            "Envy"),
    ("HP", "PAVILION",        "Pavilion"),
    ("HP", "OMEN",            "Omen"),
    ("HP", "Elitebook",       "EliteBook"),
    # Lenovo
    ("Lenovo", "Ideapad",     "IdeaPad"),
    ("Lenovo", "Ideacentre",  "IdeaCentre"),
]


# ─── Phase B: promote suffix-bearing family names to model_number ───────

# (brand, source_family, canonical_family, model_number_for_these_models)
# When source_family is migrated, every model under it has its
# model_number rewritten to the value below (concatenating the existing
# model_number when meaningful), then the family is repointed to
# canonical_family. Example: a board under "HP / Compaq 6730B / X" with
# model_number=X moves to "HP / Compaq / 6730B" with model_number=6730B
# if the existing model_number is a placeholder, otherwise becomes
# "6730B-X".
PHASE_B_MERGES: list[tuple[str, str, str, str]] = [
    # HP — Compaq sub-models that should fold into "Compaq" family
    ("HP", "Compaq 420",                "Compaq", "420"),
    ("HP", "Compaq 610",                "Compaq", "610"),
    ("HP", "Compaq 620",                "Compaq", "620"),
    ("HP", "Compaq 6530S/6730S",        "Compaq", "6530S/6730S"),
    ("HP", "Compaq 6730B",              "Compaq", "6730B"),
    ("HP", "Compaq CQ42",               "Compaq", "CQ42"),
    ("HP", "Compaq CQ515/CQ615",        "Compaq", "CQ515/CQ615"),
    ("HP", "Compaq Presario",           "Compaq", "Presario"),
    ("HP", "CQ35",                      "Compaq", "CQ35"),
    ("HP", "CQ40 / CQ45",               "Compaq", "CQ40/CQ45"),
    ("HP", "CQ42",                      "Compaq", "CQ42"),
    ("HP", "Presario",                  "Compaq", "Presario"),
    ("HP", "Presario CQ40",             "Compaq", "Presario CQ40"),
    ("HP", "Presario CQ61",             "Compaq", "Presario CQ61"),
    # HP — Pavilion sub-lines (DV-series)
    ("HP", "DV",                        "Pavilion", "DV"),
    ("HP", "DV2000",                    "Pavilion", "DV2000"),
    ("HP", "DV4",                       "Pavilion", "DV4"),
    ("HP", "DV6",                       "Pavilion", "DV6"),
    ("HP", "Pavilion DV4",              "Pavilion", "DV4"),
    ("HP", "Pavilion DV7",              "Pavilion", "DV7"),
    # HP — Envy sub-lines
    ("HP", "ENVY SLEEKBOOK",            "Envy", "Sleekbook"),
    ("HP", "ENVY TouchSmart",           "Envy", "TouchSmart"),
    ("HP", "ENVY X360",                 "Envy", "x360"),
    ("HP", "Envy 15",                   "Envy", "15"),
    ("HP", "Envy Ultrabook",            "Envy", "Ultrabook"),
    # HP — Spectre sub-lines
    ("HP", "Spectre Folio",             "Spectre", "Folio"),
    # HP — generic "HP Notebook XX-YY" line: collapse all numeric
    # prefixes into a single "Notebook" family with the suffix as model.
    ("HP", "14 Series",                 "Notebook", "14"),
    ("HP", "14-AM",                     "Notebook", "14-AM"),
    ("HP", "14-CK",                     "Notebook", "14-CK"),
    ("HP", "14-CM",                     "Notebook", "14-CM"),
    ("HP", "14-CM 245 G7",              "Notebook", "14-CM / 245 G7"),
    ("HP", "14-DQ",                     "Notebook", "14-DQ"),
    ("HP", "15",                        "Notebook", "15"),
    ("HP", "15-AC",                     "Notebook", "15-AC"),
    ("HP", "15-AF",                     "Notebook", "15-AF"),
    ("HP", "15-B Series",               "Notebook", "15-B"),
    ("HP", "15-BF002AX",                "Notebook", "15-BF002AX"),
    ("HP", "15-BS",                     "Notebook", "15-BS"),
    ("HP", "15-DA SERIES",              "Notebook", "15-DA"),
    ("HP", "15-DW",                     "Notebook", "15-DW"),
    ("HP", "15-DY",                     "Notebook", "15-DY"),
    ("HP", "15-FH",                     "Notebook", "15-FH"),
    ("HP", "15-R",                      "Notebook", "15-R"),
    ("HP", "15-series",                 "Notebook", "15"),
    ("HP", "15S-EQ",                    "Notebook", "15s-eq"),
    ("HP", "15s",                       "Notebook", "15s"),
    ("HP", "15s-eq",                    "Notebook", "15s-eq"),
    ("HP", "17-BY",                     "Notebook", "17-BY"),
    ("HP", "17-CN",                     "Notebook", "17-CN"),
    ("HP", "2000",                      "Notebook", "2000"),
    ("HP", "2000 Series",               "Notebook", "2000"),
    ("HP", "240 G3",                    "Notebook", "240 G3"),
    ("HP", "250",                       "Notebook", "250"),
    ("HP", "250 G5",                    "Notebook", "250 G5"),
    ("HP", "250 G8",                    "Notebook", "250 G8"),
    ("HP", "348 G4",                    "Notebook", "348 G4"),
    ("HP", "620/621",                   "Notebook", "620/621"),
    ("HP", "Pavilion DV4",              "Pavilion", "DV4"),
    # HP — non-product-line junk family names → Notebook fallback
    ("HP", "Notebook",                  "Notebook", "(unknown)"),
    ("HP", "Laptop",                    "Notebook", "(unknown)"),
    ("HP", "G Series",                  "Notebook", "G"),
    ("HP", "G4",                        "Notebook", "G4"),
    ("HP", "R Series",                  "Notebook", "R"),
    ("HP", "HDX 9200",                  "HDX", "9200"),
    # Lenovo — sub-line consolidation
    ("Lenovo", "IdeaPad Slim",          "IdeaPad", "Slim"),
    ("Lenovo", "IdeaPad Gaming",        "IdeaPad", "Gaming"),
    ("Lenovo", "Ideacentre AIO",        "IdeaCentre", "AIO"),
    ("Lenovo", "ThinkPad Edge",         "ThinkPad", "Edge"),
    ("Lenovo", "ThinkPad Yoga",         "ThinkPad", "Yoga"),
    ("Lenovo", "Yoga Slim 7 Pro",       "Yoga", "Slim 7 Pro"),
    ("Lenovo", "Yoga Slim 7 ProX",      "Yoga", "Slim 7 ProX"),
    # Lenovo — model-as-family entries
    ("Lenovo", "G460e",                 "G-series", "G460e"),
    ("Lenovo", "G50",                   "G-series", "G50"),
    ("Lenovo", "G570",                  "G-series", "G570"),
    ("Lenovo", "K23",                   "K-series", "K23"),
    ("Lenovo", "V15 G4",                "V-series", "V15 G4"),
    ("Lenovo", "V15-IGL",               "V-series", "V15-IGL"),
    ("Lenovo", "Flex",                  "Flex",     "(unknown)"),
    ("Lenovo", "3000",                  "3000-series", "(unknown)"),
    ("Lenovo", "Tianyi",                "Tianyi", "(unknown)"),
    ("Lenovo", "AIO",                   "IdeaCentre", "AIO"),
]


# ─── Phase C: ODM-named families → "(unknown family)" quarantine ────────

# Per brand, these family names actually denote the PCB manufacturer
# (ODM), not the consumer product line. Move them to a single
# per-brand placeholder so the family layer represents what users
# expect.
PHASE_C_ODM_FAMILIES = {
    "Compal", "Foxconn", "Quanta", "LCFC", "Wistron", "Inventec",
    "Pegatron", "Clevo", "ASUS",  # NB: "ASUS" appears as a sub-family
                                  # under e.g. Samsung; ASUS-as-brand
                                  # families are skipped (handled below)
}

PHASE_C_QUARANTINE_NAME = "(unknown family — research needed)"


# ─── Migration primitives ───────────────────────────────────────────────


def find_brand_uuid(conn: sqlite3.Connection, brand: str) -> str | None:
    row = conn.execute(
        "SELECT uuid FROM brands WHERE name = ?", (brand,)
    ).fetchone()
    return row[0] if row else None


def find_family_uuid(
    conn: sqlite3.Connection, brand_uuid: str, family: str
) -> str | None:
    row = conn.execute(
        "SELECT uuid FROM families WHERE brand_uuid = ? AND name = ?",
        (brand_uuid, family),
    ).fetchone()
    return row[0] if row else None


def find_or_create_family(
    conn: sqlite3.Connection, brand_uuid: str, family: str
) -> str:
    uid = find_family_uuid(conn, brand_uuid, family)
    if uid:
        return uid
    import uuid as _uuid
    new_uuid = str(_uuid.uuid4())
    conn.execute(
        "INSERT INTO families (uuid, brand_uuid, name) VALUES (?, ?, ?)",
        (new_uuid, brand_uuid, family),
    )
    return new_uuid


def repoint_models(
    conn: sqlite3.Connection, src_family_uuid: str, dst_family_uuid: str,
) -> int:
    """Move every model under src to dst. Idempotent: if dst already
    has a model with the same model_number, the source model's boards
    are repointed and the source model is dropped (keeps history clean
    without UNIQUE-violation crashes)."""
    moved = 0
    src_models = conn.execute(
        "SELECT uuid, model_number, display_name, notes FROM models WHERE family_uuid = ?",
        (src_family_uuid,),
    ).fetchall()
    for src_uuid, mnum, dname, notes in src_models:
        existing = conn.execute(
            "SELECT uuid FROM models WHERE family_uuid = ? AND model_number = ?",
            (dst_family_uuid, mnum),
        ).fetchone()
        if existing and existing[0] != src_uuid:
            # Collision: repoint boards from src model to existing
            # model, then drop src model.
            conn.execute(
                "UPDATE boards SET model_uuid = ? WHERE model_uuid = ?",
                (existing[0], src_uuid),
            )
            conn.execute("DELETE FROM models WHERE uuid = ?", (src_uuid,))
        else:
            conn.execute(
                "UPDATE models SET family_uuid = ? WHERE uuid = ?",
                (dst_family_uuid, src_uuid),
            )
        moved += 1
    return moved


def drop_empty_family(conn: sqlite3.Connection, family_uuid: str) -> bool:
    n = conn.execute(
        "SELECT COUNT(*) FROM models WHERE family_uuid = ?",
        (family_uuid,),
    ).fetchone()[0]
    if n == 0:
        conn.execute("DELETE FROM families WHERE uuid = ?", (family_uuid,))
        return True
    return False


# ─── Phase A ────────────────────────────────────────────────────────────


def run_phase_a(conn: sqlite3.Connection, dry_run: bool) -> dict:
    stats = defaultdict(int)
    for brand, src_name, dst_name in PHASE_A_MERGES:
        b = find_brand_uuid(conn, brand)
        if not b:
            continue
        src = find_family_uuid(conn, b, src_name)
        if not src:
            continue
        dst = find_family_uuid(conn, b, dst_name)
        action = "merge" if dst else "rename"
        n_models = conn.execute(
            "SELECT COUNT(*) FROM models WHERE family_uuid = ?", (src,)
        ).fetchone()[0]
        print(f"  [A] {brand}/{src_name}  →  {brand}/{dst_name}  "
              f"({action}, {n_models} model(s))")
        if dry_run:
            stats["families_planned"] += 1
            stats["models_planned"] += n_models
            continue
        if not dst:
            # Rename only.
            conn.execute(
                "UPDATE families SET name = ? WHERE uuid = ?",
                (dst_name, src),
            )
            stats["renamed"] += 1
        else:
            # Merge.
            stats["merged"] += 1
            stats["models_moved"] += repoint_models(conn, src, dst)
            if drop_empty_family(conn, src):
                stats["families_dropped"] += 1
    return dict(stats)


# ─── Phase B ────────────────────────────────────────────────────────────


def run_phase_b(conn: sqlite3.Connection, dry_run: bool) -> dict:
    stats = defaultdict(int)
    for brand, src_name, dst_name, suffix_label in PHASE_B_MERGES:
        b = find_brand_uuid(conn, brand)
        if not b:
            continue
        src = find_family_uuid(conn, b, src_name)
        if not src:
            continue

        n_models = conn.execute(
            "SELECT COUNT(*) FROM models WHERE family_uuid = ?", (src,)
        ).fetchone()[0]
        print(f"  [B] {brand}/{src_name}  →  {brand}/{dst_name}  "
              f"(suffix={suffix_label!r}, {n_models} model(s))")
        if dry_run:
            stats["families_planned"] += 1
            stats["models_planned"] += n_models
            continue

        # For each source model, rewrite its model_number/display_name
        # to embed the suffix label, then repoint to dst family.
        dst = find_or_create_family(conn, b, dst_name)
        src_models = conn.execute(
            "SELECT uuid, model_number, display_name FROM models WHERE family_uuid = ?",
            (src,),
        ).fetchall()
        for m_uuid, mnum, dname in src_models:
            # Compose the new model_number. If existing was a generic
            # placeholder, replace; else concatenate.
            if not mnum or mnum.startswith("(") or mnum in ("unknown", "TODO"):
                new_mnum = suffix_label
            elif suffix_label == "(unknown)":
                new_mnum = mnum  # nothing to add
            else:
                new_mnum = (
                    suffix_label if mnum in (suffix_label, src_name)
                    else f"{suffix_label} / {mnum}"
                )
            new_dname = dname or new_mnum
            # Check for collision with an existing dst model
            collision = conn.execute(
                "SELECT uuid FROM models WHERE family_uuid = ? AND model_number = ?",
                (dst, new_mnum),
            ).fetchone()
            if collision and collision[0] != m_uuid:
                conn.execute(
                    "UPDATE boards SET model_uuid = ? WHERE model_uuid = ?",
                    (collision[0], m_uuid),
                )
                conn.execute("DELETE FROM models WHERE uuid = ?", (m_uuid,))
                stats["models_collided"] += 1
            else:
                conn.execute(
                    "UPDATE models SET family_uuid = ?, model_number = ?, display_name = ? WHERE uuid = ?",
                    (dst, new_mnum, new_dname, m_uuid),
                )
                stats["models_moved"] += 1
        if drop_empty_family(conn, src):
            stats["families_dropped"] += 1
    return dict(stats)


# ─── Phase C ────────────────────────────────────────────────────────────


def run_phase_c(conn: sqlite3.Connection, dry_run: bool) -> dict:
    stats = defaultdict(int)
    # For each brand that isn't itself an ODM, find ODM-named families
    # and quarantine.
    odm_brand_skip = {"Compal", "Foxconn", "Quanta", "LCFC", "Wistron",
                      "Inventec", "Pegatron", "Clevo", "Unsorted"}
    rows = conn.execute(
        """SELECT br.name, br.uuid, f.uuid, f.name
           FROM families f JOIN brands br ON f.brand_uuid = br.uuid
           WHERE f.name IN ({})""".format(
            ",".join("?" * len(PHASE_C_ODM_FAMILIES))
        ),
        list(PHASE_C_ODM_FAMILIES),
    ).fetchall()
    for brand_name, brand_uuid, fam_uuid, fam_name in rows:
        if brand_name in odm_brand_skip:
            continue
        n_models = conn.execute(
            "SELECT COUNT(*) FROM models WHERE family_uuid = ?",
            (fam_uuid,),
        ).fetchone()[0]
        n_boards = conn.execute(
            """SELECT COUNT(*) FROM boards b JOIN models m ON b.model_uuid = m.uuid
               WHERE m.family_uuid = ?""",
            (fam_uuid,),
        ).fetchone()[0]
        print(f"  [C] {brand_name}/{fam_name}  →  "
              f"{brand_name}/{PHASE_C_QUARANTINE_NAME}  "
              f"({n_models} model(s), {n_boards} board(s))")
        if dry_run:
            stats["families_planned"] += 1
            stats["models_planned"] += n_models
            stats["boards_planned"] += n_boards
            continue
        dst = find_or_create_family(conn, brand_uuid, PHASE_C_QUARANTINE_NAME)
        stats["models_moved"] += repoint_models(conn, fam_uuid, dst)
        if drop_empty_family(conn, fam_uuid):
            stats["families_dropped"] += 1
    return dict(stats)


# ─── Driver ─────────────────────────────────────────────────────────────


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--db", type=Path, default=DEFAULT_DB)
    p.add_argument("--phase-a", action="store_true",
                   help="Case-fold equivalents (lowest risk).")
    p.add_argument("--phase-b", action="store_true",
                   help="Promote suffix-bearing family names to model_number.")
    p.add_argument("--phase-c", action="store_true",
                   help="Quarantine ODM-named families.")
    p.add_argument("--all", action="store_true",
                   help="Run A + B + C.")
    p.add_argument("--dry-run", action="store_true",
                   help="Report planned changes without writing.")
    args = p.parse_args()

    if args.all:
        args.phase_a = args.phase_b = args.phase_c = True

    if not (args.phase_a or args.phase_b or args.phase_c):
        print("FATAL: pick at least one --phase-{a,b,c} or --all", file=sys.stderr)
        return 1

    if not args.db.exists():
        print(f"FATAL: {args.db} not found", file=sys.stderr)
        return 1

    conn = sqlite3.connect(str(args.db))
    conn.execute("PRAGMA foreign_keys = ON")

    summary = {}
    if args.phase_a:
        print("=== Phase A: case-fold ===")
        summary["A"] = run_phase_a(conn, args.dry_run)
    if args.phase_b:
        print("=== Phase B: suffix promotion ===")
        summary["B"] = run_phase_b(conn, args.dry_run)
    if args.phase_c:
        print("=== Phase C: ODM quarantine ===")
        summary["C"] = run_phase_c(conn, args.dry_run)

    if not args.dry_run:
        conn.commit()
    conn.close()

    print()
    print("normalize-families summary:")
    for phase, stats in summary.items():
        print(f"  Phase {phase}: {stats}")
    if args.dry_run:
        print("  (dry-run — no DB writes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
