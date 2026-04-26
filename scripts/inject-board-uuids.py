#!/usr/bin/env python3
"""
Inject UUID v4 literals into INSERT INTO boards (...) statements in a SQL file.

Idempotent: rows that already declare `uuid` in their column list are skipped.

Usage:
    python3 scripts/inject-board-uuids.py "Board Database/build_full_db.sql"

Writes the augmented SQL back to the same file. A backup is saved alongside
with a .bak extension on first run.
"""
import re
import sys
import uuid
from pathlib import Path

# Match `INSERT INTO boards (` followed by a column list and `VALUES (` with a values list.
# Captures the column list and values list separately so we can prepend uuid to both.
# Tolerates whitespace, newlines, and comments between INSERT and VALUES.
INSERT_RE = re.compile(
    r'(INSERT\s+INTO\s+boards\s*\()'   # 1: opening
    r'([^)]*)'                           # 2: column list
    r'(\)\s*VALUES\s*\()'                # 3: between
    r'([^;]*?)'                          # 4: values list (non-greedy, up to ;)
    r'(\)\s*;)',                         # 5: closing
    re.IGNORECASE | re.DOTALL,
)


def has_uuid_column(columns: str) -> bool:
    """Check if 'uuid' is already in the column list (case-insensitive, word-boundary)."""
    return bool(re.search(r'\buuid\b', columns, re.IGNORECASE))


def inject(match: re.Match) -> str:
    open_, columns, between, values, close = match.groups()
    if has_uuid_column(columns):
        return match.group(0)  # already has uuid; no-op

    new_uuid = str(uuid.uuid4())
    # Prepend uuid to column list (preserve existing whitespace style)
    new_columns = 'uuid, ' + columns.lstrip()
    # Prepend the UUID literal to values list (preserve existing whitespace style)
    leading_ws = re.match(r'\s*', values).group(0)
    values_body = values[len(leading_ws):]
    new_values = leading_ws + f"'{new_uuid}', " + values_body
    return f'{open_}{new_columns}{between}{new_values}{close}'


def main():
    if len(sys.argv) != 2:
        print(f"usage: {sys.argv[0]} <path-to-sql-file>", file=sys.stderr)
        sys.exit(2)
    path = Path(sys.argv[1])
    if not path.exists():
        print(f"error: {path} does not exist", file=sys.stderr)
        sys.exit(1)

    src = path.read_text()

    backup = path.with_suffix(path.suffix + '.bak')
    if not backup.exists():
        backup.write_text(src)
        print(f"backup written: {backup}")

    new_src, n = INSERT_RE.subn(inject, src)

    # Count how many were actually injected vs. skipped
    injected = sum(
        1 for m in INSERT_RE.finditer(src) if not has_uuid_column(m.group(2))
    )
    skipped = n - injected

    path.write_text(new_src)
    print(f"injected {injected} UUIDs, skipped {skipped} already-augmented rows")


if __name__ == '__main__':
    main()
