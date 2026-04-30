#!/usr/bin/env python3
"""Retroactive cleanup for boards.db: strip the `sample:` segment from
notes when the filename's extension is not in the boardviewer whitelist.

Past runs of `scan-board-filenames.py` walked every file regardless of
extension, so BIOS dumps, archives, and disk images ended up as the
provenance for thousands of board records — the codes are real, but the
sample filenames pollute the DB editor UI. This script preserves the
board record + classifier output and only edits the `sample:...` segment.

Idempotent and safe to re-run. Read-only via --dry-run.
"""
from __future__ import annotations

import argparse
import re
import sqlite3
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DB = REPO_ROOT / "Board Database" / "boards.db"

# Same whitelist scan-board-filenames.py uses. Lowercase, no dot stripping.
ALLOWED_EXTENSIONS: set[str] = {
    ".bvr", ".bv", ".brd", ".bdv", ".fz", ".cad", ".pcb", ".tvw", ".pdf",
}

# Capture the full `sample:<filename>` segment up to the next `;` (or end).
# Filenames may contain spaces, parens, dots, etc. The terminator is `;` or
# end-of-string.
_SAMPLE_RE = re.compile(r"sample:([^;]+?)(\s*;|\s*$)", re.IGNORECASE)


def _filename_extension(s: str) -> str:
    """Extract the lowercased final extension from a filename. Returns ''
    when there is no `.` at all. `archive.zip.bin` returns `.bin`."""
    s = s.strip()
    if "." not in s:
        return ""
    return "." + s.rsplit(".", 1)[1].lower()


_JUNK_EXT_RE = re.compile(r"\.(zip|rar|7z|bin|rom|exe|fd|cap|wph|efi|iso|dmg)\b",
                          re.IGNORECASE)


def transform_notes(notes: str) -> tuple[str, bool]:
    """Returns (new_notes, changed). Drops any `sample:<file>` whose <file>
    has a non-whitelisted extension. As a fallback, also drops any
    semicolon-delimited segment that contains a junk extension (caught
    legacy entries where the filename was glued onto notes without the
    `sample:` prefix). Other segments untouched."""
    if not notes:
        return notes, False

    # First pass: structured `sample:<file>` segments.
    def _sub(m: re.Match) -> str:
        filename = m.group(1).strip()
        ext = _filename_extension(filename)
        if ext in ALLOWED_EXTENSIONS:
            return m.group(0)
        return ""

    new_notes = _SAMPLE_RE.sub(_sub, notes)

    # Second pass: any remaining segment that mentions a junk extension.
    # Splits on `;` (NB: filenames with embedded `;` will lose surrounding
    # context, but those rows are already broken — this just makes them
    # presentable). Skip whitelisted segments wholesale.
    parts = [p.strip() for p in new_notes.split(";")]
    parts = [p for p in parts if p and not _JUNK_EXT_RE.search(p)]
    new_notes = "; ".join(parts)

    new_notes = re.sub(r"\s+", " ", new_notes).strip()
    return new_notes, new_notes != notes


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--db", type=Path, default=DEFAULT_DB)
    ap.add_argument("--dry-run", action="store_true",
                    help="Report counts without writing.")
    ap.add_argument("--limit", type=int, default=0,
                    help="Cap rows updated (0 = all).")
    args = ap.parse_args()

    if not args.db.exists():
        print(f"FATAL: {args.db} not found", file=sys.stderr)
        return 1

    conn = sqlite3.connect(str(args.db))
    # Pull every row whose notes might mention either the structured
    # `sample:` prefix or any junk-extension token. Two LIKE clauses keep
    # the SQL fast on a 5k-row table while still catching the legacy
    # malformed entries that lack `sample:`.
    rows = conn.execute(
        """
        SELECT uuid, notes FROM boards
        WHERE notes LIKE '%sample:%'
           OR notes LIKE '%.zip%'   OR notes LIKE '%.rar%'  OR notes LIKE '%.7z%'
           OR notes LIKE '%.bin%'   OR notes LIKE '%.rom%'  OR notes LIKE '%.exe%'
           OR notes LIKE '%.fd%'    OR notes LIKE '%.cap%'  OR notes LIKE '%.wph%'
           OR notes LIKE '%.efi%'   OR notes LIKE '%.iso%'  OR notes LIKE '%.dmg%'
        """
    ).fetchall()

    changes: list[tuple[str, str, str]] = []  # (uuid, old, new)
    for uuid, notes in rows:
        new, changed = transform_notes(notes or "")
        if changed:
            changes.append((uuid, notes, new))
            if args.limit and len(changes) >= args.limit:
                break

    print(f"boards with sample notes: {len(rows)}")
    print(f"boards needing strip:    {len(changes)}")
    if changes:
        print()
        print("first 5 examples:")
        for uuid, old, new in changes[:5]:
            print(f"  {uuid[:8]}…")
            print(f"    - {old}")
            print(f"    + {new or '(notes cleared)'}")

    if args.dry_run:
        conn.close()
        return 0

    if not changes:
        conn.close()
        return 0

    cur = conn.cursor()
    cur.executemany(
        "UPDATE boards SET notes = ? WHERE uuid = ?",
        [(new, uuid) for uuid, _old, new in changes],
    )
    conn.commit()
    conn.close()
    print()
    print(f"updated {len(changes)} row(s).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
