#!/usr/bin/env python3
"""Import Apple board metadata from src/frontend/src/store/apple-boards.ts
into Board Database/boards.db, promoting any matching placeholder rows from
the Unsorted/Apple/(unknown-apple) hierarchy into proper Apple/<size-family>/
<A-number> models.

Why a TypeScript-source as input: apple-boards.ts is a hand-curated table
(repair.wiki / logi.wiki sources) with richer per-A-number display strings
than the XZZ-imported flat hierarchy. We don't have a JSON sidecar; parsing
the .ts directly avoids forking the data into another file.

Family normalisation: apple-boards.ts uses size-specific family names
(MacBook Pro 14"). The existing XZZ-imported boards use flat family names
(MacBook Pro). To keep the existing XZZ-imported A-numbers and the new
apple-boards.ts entries co-located in the same model rows, this importer
normalises the size-specific family back to the flat one (MacBook Pro 14"
-> MacBook Pro). Size info lives only in models.display_name.

Promotion: a board_number currently sitting under
Unsorted / Apple / (unknown-apple) gets its model_uuid UPDATEd in-place to
point at the proper Apple/<family>/<A-number> model. The board's UUID
stays the same so any external references (databank.files.board_uuid)
remain valid; just the placement in the hierarchy changes.

Usage:
  python3 scripts/import-apple-boards.py             # default db path
  python3 scripts/import-apple-boards.py --db <path>
  python3 scripts/import-apple-boards.py --dry-run   # report only

Idempotent: re-running yields zero changes.
"""

from __future__ import annotations

import argparse
import re
import sqlite3
import sys
import uuid as uuid_module
from pathlib import Path
from typing import Optional

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_TS = REPO_ROOT / "src/frontend/src/store/apple-boards.ts"
DEFAULT_DB = REPO_ROOT / "Board Database/boards.db"

# Pattern that captures one BOARDS array entry. apple-boards.ts uses double
# quotes consistently (with \" inside strings), so we tolerate \" but not
# arbitrary escapes — keeps the regex small.
ENTRY_RE = re.compile(
    r'\{\s*board_number:\s*"([^"]+)",\s*'
    r'a_number:\s*"([^"]+)",\s*'
    r'model:\s*"((?:[^"\\]|\\.)+)",\s*'
    r'info:\s*"((?:[^"\\]|\\.)+)"\s*\}'
)

PLACEHOLDER_BRAND = "Unsorted"
PLACEHOLDER_FAMILY = "Apple"
PLACEHOLDER_MODEL_NUMBER = "(unknown-apple)"
APPLE_BRAND = "Apple"


def parse_apple_boards_ts(path: Path) -> list[dict[str, str]]:
    text = path.read_text(encoding="utf-8")
    entries: list[dict[str, str]] = []
    for m in ENTRY_RE.finditer(text):
        bn, an, model, info = m.groups()
        entries.append(
            {
                "board_number": bn,
                "a_number": an,
                "model": model.replace('\\"', '"'),
                "info": info.replace('\\"', '"'),
            }
        )
    return entries


def normalize_family(model: str) -> str:
    """Map apple-boards.ts size-specific family to the flat family used by
    the XZZ-imported Apple hierarchy so both data sources land under the
    same family row."""
    if model.startswith("MacBook Pro"):
        return "MacBook Pro"
    if model.startswith("MacBook Air"):
        return "MacBook Air"
    if model.startswith("MacBook"):
        return "MacBook"
    if model.startswith("iMac Pro"):
        return "iMac Pro"
    if model.startswith("iMac"):
        return "iMac"
    if model == "Mac mini":
        return "Mac mini"
    return model


def find_brand(conn: sqlite3.Connection, name: str) -> Optional[str]:
    row = conn.execute("SELECT uuid FROM brands WHERE name = ?", (name,)).fetchone()
    return row[0] if row else None


def find_or_create_brand(conn: sqlite3.Connection, name: str) -> str:
    existing = find_brand(conn, name)
    if existing:
        return existing
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
) -> tuple[str, bool]:
    """Returns (uuid, created)."""
    row = conn.execute(
        "SELECT uuid, display_name FROM models WHERE family_uuid = ? AND model_number = ?",
        (family_uuid, model_number),
    ).fetchone()
    if row:
        # Keep existing display_name unless it's empty/null — XZZ import has
        # rich strings we don't want to overwrite blindly.
        if not row[1]:
            conn.execute(
                "UPDATE models SET display_name = ? WHERE uuid = ?",
                (display_name, row[0]),
            )
        return row[0], False
    new_uuid = str(uuid_module.uuid4())
    conn.execute(
        "INSERT INTO models (uuid, family_uuid, model_number, display_name) VALUES (?, ?, ?, ?)",
        (new_uuid, family_uuid, model_number, display_name),
    )
    return new_uuid, True


def find_placeholder_model_uuid(conn: sqlite3.Connection) -> Optional[str]:
    row = conn.execute(
        """SELECT m.uuid FROM models m
           JOIN families f ON m.family_uuid = f.uuid
           JOIN brands b ON f.brand_uuid = b.uuid
           WHERE b.name = ? AND f.name = ? AND m.model_number = ?""",
        (PLACEHOLDER_BRAND, PLACEHOLDER_FAMILY, PLACEHOLDER_MODEL_NUMBER),
    ).fetchone()
    return row[0] if row else None


def upsert_board(
    conn: sqlite3.Connection,
    board_number: str,
    target_model_uuid: str,
    a_number: str,
    info: str,
    placeholder_model_uuid: Optional[str],
) -> str:
    """Returns one of: 'already_present', 'promoted', 'inserted'."""
    notes = f"apple-boards.ts: {info}"

    # Already at the target model? Idempotent re-run.
    target = conn.execute(
        "SELECT uuid FROM boards WHERE board_number = ? AND model_uuid = ?",
        (board_number, target_model_uuid),
    ).fetchone()
    if target:
        return "already_present"

    # Sitting in placeholder? Move it.
    if placeholder_model_uuid:
        placeholder = conn.execute(
            "SELECT uuid FROM boards WHERE board_number = ? AND model_uuid = ?",
            (board_number, placeholder_model_uuid),
        ).fetchone()
        if placeholder:
            conn.execute(
                """UPDATE boards
                   SET model_uuid = ?, board_name = ?, source = ?, notes = ?
                   WHERE uuid = ?""",
                (target_model_uuid, a_number, "apple-boards.ts", notes, placeholder[0]),
            )
            return "promoted"

    # New entry under proper hierarchy.
    new_uuid = str(uuid_module.uuid4())
    conn.execute(
        """INSERT INTO boards
           (uuid, model_uuid, board_number, board_name, board_number_type, source, notes)
           VALUES (?, ?, ?, ?, 'apple_820', 'apple-boards.ts', ?)""",
        (new_uuid, target_model_uuid, board_number, a_number, notes),
    )
    return "inserted"


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--ts", type=Path, default=DEFAULT_TS, help="apple-boards.ts path")
    p.add_argument("--db", type=Path, default=DEFAULT_DB, help="boards.db path")
    p.add_argument(
        "--dry-run", action="store_true", help="report only; rolls back at end"
    )
    args = p.parse_args()

    if not args.ts.exists():
        print(f"FATAL: {args.ts} not found", file=sys.stderr)
        return 1
    if not args.db.exists():
        print(f"FATAL: {args.db} not found", file=sys.stderr)
        return 1

    entries = parse_apple_boards_ts(args.ts)
    if not entries:
        print(f"FATAL: parsed 0 entries from {args.ts}", file=sys.stderr)
        return 1
    print(f"parsed {len(entries)} entries from {args.ts.name}")

    conn = sqlite3.connect(str(args.db))
    conn.execute("PRAGMA foreign_keys = ON")

    # Validate schema v2 — refuse to touch a v1 DB by mistake.
    try:
        ver = conn.execute("SELECT MAX(version) FROM schema_version").fetchone()[0]
    except sqlite3.OperationalError:
        ver = None
    if ver != 2:
        print(
            f"FATAL: boards.db schema_version is {ver!r}, expected 2",
            file=sys.stderr,
        )
        return 1

    placeholder_uuid = find_placeholder_model_uuid(conn)
    if placeholder_uuid is None:
        print("note: no Unsorted/Apple/(unknown-apple) placeholder found — "
              "promotion phase will skip; new entries still inserted.")

    apple_brand_uuid = find_or_create_brand(conn, APPLE_BRAND)

    counts = {"already_present": 0, "promoted": 0, "inserted": 0}
    families_touched: set[str] = set()
    models_created = 0

    try:
        for e in entries:
            family_name = normalize_family(e["model"])
            family_uuid = find_or_create_family(conn, apple_brand_uuid, family_name)
            families_touched.add(family_name)

            model_uuid, created = find_or_create_model(
                conn, family_uuid, e["a_number"], e["info"]
            )
            if created:
                models_created += 1

            outcome = upsert_board(
                conn,
                e["board_number"],
                model_uuid,
                e["a_number"],
                e["info"],
                placeholder_uuid,
            )
            counts[outcome] += 1

        if args.dry_run:
            conn.rollback()
            print("DRY RUN — rolled back")
        else:
            conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

    print()
    print("apple-boards.ts import complete:")
    print(f"  families touched:  {len(families_touched)} ({', '.join(sorted(families_touched))})")
    print(f"  models created:    {models_created}")
    print(f"  boards inserted:   {counts['inserted']}")
    print(f"  boards promoted:   {counts['promoted']} (moved from Unsorted/Apple)")
    print(f"  boards unchanged:  {counts['already_present']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
