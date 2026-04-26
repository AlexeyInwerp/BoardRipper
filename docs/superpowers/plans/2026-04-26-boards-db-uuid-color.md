# boards.db UUID + Color Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a stable per-board UUID v4 (CRM-ready external join key) and a color metadata field (FK to a 12-entry `colors` lookup table) to the BoardRipper reference database, propagating through the Go resolver API, the databank cache layer, and the Library panel UI.

**Architecture:** Two new database concepts in `boards.db` (UUID literal column + `colors` FK lookup), denormalized through the existing `databank` cache pipeline so the frontend gets `board_uuid` and `board_color` as plain fields on `DatabankFile` (no async fetch in UI). UUIDs are baked into `build_full_db.sql` as literal strings via a one-shot Python helper; once committed, they never change unless a board row is deleted entirely.

**Tech Stack:** SQLite 3, Go 1.22 (modernc.org/sqlite driver), Python 3 (stdlib `uuid`/`re` for the one-shot helper), TypeScript + React for the Library panel.

**Spec:** [docs/superpowers/specs/2026-04-26-boards-db-uuid-color-design.md](../specs/2026-04-26-boards-db-uuid-color-design.md)

---

## Phase 1: Reference DB schema (`Board Database/`)

### Task 1: Extend `create_mockup_db.sql` with colors table + new `boards` columns

**Files:**
- Modify: `Board Database/create_mockup_db.sql`

- [ ] **Step 1: Replace the `CREATE TABLE IF NOT EXISTS boards` block to add `uuid` and `color_id` columns**

Open `Board Database/create_mockup_db.sql` and replace lines 8–21 (the `CREATE TABLE IF NOT EXISTS boards (...)` block) with:

```sql
-- Core boards table
CREATE TABLE IF NOT EXISTS boards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uuid TEXT NOT NULL UNIQUE,
    brand TEXT NOT NULL,
    model TEXT,
    model_number TEXT,
    board_number TEXT NOT NULL,
    board_name TEXT,
    odm TEXT,
    board_number_type TEXT,
    color_id INTEGER REFERENCES colors(id),
    source TEXT NOT NULL,
    source_url TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

- [ ] **Step 2: Insert the `colors` lookup table CREATE statement immediately before `CREATE TABLE IF NOT EXISTS boards`**

Add this block above the `boards` table definition:

```sql
-- Color lookup (FK target for boards.color_id)
CREATE TABLE IF NOT EXISTS colors (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    hex TEXT,                                   -- nullable; populated by themes work later
    sort_order INTEGER NOT NULL DEFAULT 0
);
```

- [ ] **Step 3: Add the UUID index next to existing indexes**

Find the existing indexes section (line ~38–43, starting with `CREATE UNIQUE INDEX IF NOT EXISTS idx_board_unique`) and add at the end of that block:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_board_uuid ON boards(uuid);
```

- [ ] **Step 4: Seed the `colors` table immediately after its CREATE TABLE**

Add this block right after the `CREATE TABLE IF NOT EXISTS colors (...)` block (before `CREATE TABLE IF NOT EXISTS boards`):

```sql
-- Color seed (12 entries: 4 core + 8 exceptions)
INSERT OR IGNORE INTO colors (id, name, sort_order) VALUES
    (1, 'black',   1),
    (2, 'red',     2),
    (3, 'green',   3),
    (4, 'blue',    4),
    (5, 'white',   5),
    (6, 'yellow',  6),
    (7, 'purple',  7),
    (8, 'orange',  8),
    (9, 'pink',    9),
    (10, 'brown',  10),
    (11, 'silver', 11),
    (12, 'gold',   12);
```

`INSERT OR IGNORE` is critical — without it, re-running `create_mockup_db.sql` on an existing DB raises a UNIQUE constraint violation.

- [ ] **Step 5: Update the 3 mockup `INSERT INTO boards` statements at the bottom of the file to include `uuid`**

For each of the 3 mockup inserts (lines 50, 60, 80), prepend `uuid` to the column list and a generated UUID v4 string to the values list. Run this in a terminal to get three UUIDs:

```bash
python3 -c "import uuid; [print(uuid.uuid4()) for _ in range(3)]"
```

Suppose the output is:
```
a1b2c3d4-e5f6-4789-abcd-1234567890ab
b2c3d4e5-f6a7-4890-bcde-2345678901bc
c3d4e5f6-a7b8-4901-cdef-3456789012cd
```

(Use whatever your `python3 -c ...` actually produces — these are just placeholders for this plan document.)

Replace the 3 mockup insert lines with their UUID-augmented versions:

```sql
-- 1. Lenovo ThinkPad T450 — NM-A251
INSERT INTO boards (uuid, brand, model, model_number, board_number, board_name, odm, board_number_type, source, source_url)
VALUES ('a1b2c3d4-e5f6-4789-abcd-1234567890ab', 'Lenovo', 'ThinkPad T450', '20BU/20BX', 'NM-A251', 'AIVL0', 'LCFC', 'lenovo_nm', 'boardschematic', 'https://boardschematic.com/lenovo-thinkpad-t450-uma-gpu-schematic-aivl0-nm-a251/');
```

```sql
-- 2. Apple MacBook Air 13" M1 (Late 2020) — 820-02016-A
INSERT INTO boards (uuid, brand, model, model_number, board_number, board_name, odm, board_number_type, source, source_url)
VALUES ('b2c3d4e5-f6a7-4890-bcde-2345678901bc', 'Apple', 'MacBook Air 13" M1 Late 2020', 'A2337', '820-02016-A', 'X1757', 'Apple', 'apple_820', 'logiwiki', 'https://logi.wiki/index.php/Board_Number_by_A_Number');
```

```sql
-- 3. Dell Inspiron 17R 5720/7720 — DA0R09MB6H1
INSERT INTO boards (uuid, brand, model, model_number, board_number, board_name, odm, board_number_type, source, source_url)
VALUES ('c3d4e5f6-a7b8-4901-cdef-3456789012cd', 'Dell', 'Inspiron 17R 5720', 'N5720', 'DA0R09MB6H1', 'Quanta R09', 'Quanta', 'quanta_da0', 'ebay', 'https://www.ebay.com/p/1981179302');
```

- [ ] **Step 6: Verify the SQL parses by running it against an empty in-memory DB**

Run:

```bash
sqlite3 ":memory:" < "Board Database/create_mockup_db.sql" 2>&1 | head -20
```

Expected: no output (success). If you see any "near \"...\": syntax error", fix the syntax and re-run.

- [ ] **Step 7: Verify the schema is what we want**

Run:

```bash
sqlite3 ":memory:" "$(cat 'Board Database/create_mockup_db.sql'; echo; echo '.schema')"
```

Expected output includes `colors` table with `name TEXT NOT NULL UNIQUE` and `boards` table with `uuid TEXT NOT NULL UNIQUE` and `color_id INTEGER REFERENCES colors(id)`.

---

### Task 2: Write the one-shot UUID injection helper

**Files:**
- Create: `scripts/inject-board-uuids.py`

- [ ] **Step 1: Write a tiny test fixture**

Create `scripts/_test_inject_uuids_input.sql`:

```sql
-- 820-AAAAA: Test board A
INSERT INTO boards (brand, model, model_number, board_number, board_name, odm, board_number_type, source)
VALUES ('Apple', 'TestA', 'A1', '820-AAAAA-A', 'TA', 'Apple', 'apple_820', 'test');

-- 820-BBBBB: Test board B (already has uuid — must be skipped)
INSERT INTO boards (uuid, brand, model, model_number, board_number, board_name, odm, board_number_type, source)
VALUES ('00000000-0000-4000-8000-000000000000', 'Apple', 'TestB', 'A2', '820-BBBBB-A', 'TB', 'Apple', 'apple_820', 'test');

-- LA-CCCC: Test board C (multi-line)
INSERT INTO boards (
    brand, model, model_number, board_number, board_name, odm, board_number_type, source
)
VALUES (
    'Lenovo', 'TestC', 'A3', 'LA-CCCC', 'TC', 'Compal', 'compal_la', 'test'
);
```

- [ ] **Step 2: Write the helper script**

Create `scripts/inject-board-uuids.py`:

```python
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
```

- [ ] **Step 3: Make the helper executable and run the smoke test**

Run:

```bash
chmod +x scripts/inject-board-uuids.py
python3 scripts/inject-board-uuids.py scripts/_test_inject_uuids_input.sql
cat scripts/_test_inject_uuids_input.sql
```

Expected:
- Test board A's INSERT now starts with `INSERT INTO boards (uuid, brand, model, ...)` and `VALUES ('<some-uuid>', 'Apple', ...)`.
- Test board B's INSERT is unchanged (still `'00000000-0000-4000-8000-000000000000'`).
- Test board C's multi-line INSERT now has `uuid` first in the column list and a generated UUID first in the values list.
- A `_test_inject_uuids_input.sql.bak` file exists with the original content.
- Output prints `injected 2 UUIDs, skipped 1 already-augmented rows`.

- [ ] **Step 4: Run the helper a second time to verify idempotency**

Run:

```bash
python3 scripts/inject-board-uuids.py scripts/_test_inject_uuids_input.sql
```

Expected: `injected 0 UUIDs, skipped 3 already-augmented rows`. The file content is unchanged from after the first run.

- [ ] **Step 5: Clean up the test fixture**

Run:

```bash
rm scripts/_test_inject_uuids_input.sql scripts/_test_inject_uuids_input.sql.bak
```

- [ ] **Step 6: Commit Phase 1.1 + 1.2**

```bash
git add "Board Database/create_mockup_db.sql" scripts/inject-board-uuids.py
git commit -m "$(cat <<'EOF'
feat(boarddb): add colors lookup table and uuid column to schema

Schema changes only — data rebuild + Go API + frontend follow.

- New colors(id, name, hex, sort_order) table with 12 seed rows
  (black, red, green, blue + 8 rare exceptions)
- boards.uuid TEXT NOT NULL UNIQUE for CRM-ready external joins
- boards.color_id INTEGER REFERENCES colors(id), nullable
- One-shot Python helper scripts/inject-board-uuids.py to inject
  UUID v4 literals into INSERT INTO boards statements (idempotent)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Inject UUIDs into `build_full_db.sql` and add color column slot

**Files:**
- Modify: `Board Database/build_full_db.sql`

- [ ] **Step 1: Run the helper against the real data file**

Run:

```bash
python3 scripts/inject-board-uuids.py "Board Database/build_full_db.sql"
```

Expected output: `injected N UUIDs, skipped 0 already-augmented rows` where N is the number of `INSERT INTO boards` statements (likely ~80–120, count depends on the file).

A backup `Board Database/build_full_db.sql.bak` is created on first run. Inspect it briefly to confirm — `head -30 "Board Database/build_full_db.sql.bak"` should show the original content.

- [ ] **Step 2: Spot-check the augmented file**

Run:

```bash
grep -c "INSERT INTO boards" "Board Database/build_full_db.sql"
grep -c "INSERT INTO boards (uuid," "Board Database/build_full_db.sql"
```

Both numbers must be equal — every `INSERT INTO boards` row should now start with `(uuid,`.

Also pick a sample row to eyeball:

```bash
grep -A 2 "INSERT INTO boards (uuid," "Board Database/build_full_db.sql" | head -10
```

Expected: each VALUES line begins with `('<UUID>',` followed by the original brand/model/etc.

- [ ] **Step 3: Verify UUIDs are unique (no accidental duplication)**

Run:

```bash
grep -oE "INSERT INTO boards \(uuid, brand, model, model_number, board_number, board_name, odm, board_number_type, source(?:, source_url)?\)\s+VALUES \('[a-f0-9-]+'" "Board Database/build_full_db.sql" \
  | grep -oE "'[a-f0-9-]+'" | sort | uniq -d
```

Expected: empty output. Any duplicates indicate a bug in the helper — bail and investigate.

- [ ] **Step 4: Verify the file still parses as SQL**

Run a dry parse:

```bash
sqlite3 ":memory:" "$(cat 'Board Database/create_mockup_db.sql' 'Board Database/build_full_db.sql')" 2>&1 | head
```

Expected: no error output. Any syntax error means the helper's whitespace handling is off — check the relevant `INSERT` block.

- [ ] **Step 5: Delete the .bak file (we have git history)**

Run:

```bash
rm "Board Database/build_full_db.sql.bak"
```

- [ ] **Step 6: Commit the data file**

```bash
git add "Board Database/build_full_db.sql"
git commit -m "$(cat <<'EOF'
feat(boarddb): inject stable UUIDs into build_full_db.sql

Ran scripts/inject-board-uuids.py to assign a UUID v4 literal to
every INSERT INTO boards row. UUIDs are now part of the SQL source
of truth and survive any future rebuild.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Rebuild `boards.db` and verify

**Files:**
- Modify: `Board Database/boards.db` (binary, regenerated)

- [ ] **Step 1: Remove the existing DB + sidecar files**

Run:

```bash
rm -f "Board Database/boards.db" "Board Database/boards.db-shm" "Board Database/boards.db-wal"
```

- [ ] **Step 2: Run the schema script then the data script**

Run:

```bash
sqlite3 "Board Database/boards.db" < "Board Database/create_mockup_db.sql"
sqlite3 "Board Database/boards.db" < "Board Database/build_full_db.sql"
```

Expected: no error output from either command.

- [ ] **Step 3: Verify schema**

Run:

```bash
sqlite3 "Board Database/boards.db" ".schema boards"
sqlite3 "Board Database/boards.db" ".schema colors"
```

Expected: `boards` schema includes `uuid TEXT NOT NULL UNIQUE` and `color_id INTEGER REFERENCES colors(id)`. `colors` schema is the new table.

- [ ] **Step 4: Verify every board has a UUID**

Run:

```bash
sqlite3 "Board Database/boards.db" "SELECT count(*) FROM boards WHERE uuid IS NULL OR uuid = '';"
```

Expected: `0`.

- [ ] **Step 5: Verify UUID uniqueness**

Run:

```bash
sqlite3 "Board Database/boards.db" "SELECT uuid, count(*) FROM boards GROUP BY uuid HAVING count(*) > 1;"
```

Expected: empty output.

- [ ] **Step 6: Verify the colors seed**

Run:

```bash
sqlite3 "Board Database/boards.db" "SELECT id, name, sort_order FROM colors ORDER BY id;"
```

Expected: 12 rows, ids 1..12, names black/red/green/blue/white/yellow/purple/orange/pink/brown/silver/gold.

- [ ] **Step 7: Sample a few real rows**

Run:

```bash
sqlite3 -header -column "Board Database/boards.db" "SELECT uuid, brand, board_number, color_id FROM boards LIMIT 5;"
```

Expected: 5 rows, every UUID populated, every color_id NULL.

- [ ] **Step 8: Commit the rebuilt DB**

```bash
git add "Board Database/boards.db"
# Track .db-shm and .db-wal only if they currently exist in git history
git ls-files "Board Database/boards.db-shm" 2>/dev/null && git add "Board Database/boards.db-shm"
git ls-files "Board Database/boards.db-wal" 2>/dev/null && git add "Board Database/boards.db-wal"
git commit -m "$(cat <<'EOF'
build(boarddb): rebuild boards.db with uuids + colors schema

Regenerated boards.db from the updated create_mockup_db.sql +
build_full_db.sql. Every board now carries a stable UUID; colors
lookup table is seeded with 12 entries. boards.color_id is NULL
on every row (manual population follows in future work).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 2: Go boarddb API

### Task 5: Extend `BoardMatch` struct + resolver query

**Files:**
- Modify: `src/backend/boarddb/boarddb.go:13-25`
- Modify: `src/backend/boarddb/resolve.go:15` (boardQuery const)
- Modify: `src/backend/boarddb/resolve.go:100-152` (queryBoard function)

- [ ] **Step 1: Update the `BoardMatch` struct**

In `src/backend/boarddb/boarddb.go`, replace lines 13–25 (the `BoardMatch` struct definition) with:

```go
// BoardMatch is the result of resolving a board number against the reference DB.
type BoardMatch struct {
	UUID         string   `json:"uuid"`
	BoardNumber  string   `json:"board_number"`
	Brand        string   `json:"brand"`
	Model        string   `json:"model"`
	ModelNumber  string   `json:"model_number,omitempty"`
	BoardName    string   `json:"board_name,omitempty"`
	ODM          string   `json:"odm"`
	Type         string   `json:"board_number_type,omitempty"`
	Color        string   `json:"color,omitempty"`
	Aliases      []string `json:"aliases,omitempty"`
	ModelAliases []string `json:"model_aliases,omitempty"`
	Source       string   `json:"source,omitempty"`
}
```

- [ ] **Step 2: Update the `boardQuery` SELECT to include `uuid` and the color name via JOIN**

In `src/backend/boarddb/resolve.go`, replace line 15 (the `const boardQuery`) with:

```go
const boardQuery = `SELECT b.id, b.uuid, b.brand, b.model, b.model_number, b.board_number, b.board_name, b.odm, b.board_number_type, c.name AS color, b.source FROM boards b LEFT JOIN colors c ON b.color_id = c.id`
```

- [ ] **Step 3: Update every WHERE clause to use the `b.` prefix**

The `boardQuery` is concatenated with `WHERE upper(board_number) = ?`, `WHERE upper(board_number) LIKE ?`, and `WHERE id = ?` strings throughout `resolve.go`. Update each call site so column references are unambiguous now that there's a JOIN.

In `src/backend/boarddb/resolve.go`, replace these lines:

- Line 33: `boardQuery+` WHERE upper(board_number) = ?`` → `boardQuery+` WHERE upper(b.board_number) = ?``
- Line 38: `boardQuery+` WHERE upper(board_number) LIKE ? LIMIT 1`` → `boardQuery+` WHERE upper(b.board_number) LIKE ? LIMIT 1``
- Line 44: `boardQuery+` WHERE upper(board_number) LIKE ? LIMIT 1`` → `boardQuery+` WHERE upper(b.board_number) LIKE ? LIMIT 1``
- Line 52: `boardQuery+` WHERE upper(board_number) = ?`` → `boardQuery+` WHERE upper(b.board_number) = ?``
- Line 63: `boardQuery+` WHERE id = ?`` → `boardQuery+` WHERE b.id = ?``
- Line 80: `boardQuery+` WHERE id = ?`` → `boardQuery+` WHERE b.id = ?``

- [ ] **Step 4: Update the `queryBoard` function to scan the two new columns**

In `src/backend/boarddb/resolve.go`, replace the entire `queryBoard` function (lines 100–152) with:

```go
func (db *DB) queryBoard(query string, args ...any) *BoardMatch {
	var id int64
	m := &BoardMatch{}
	var model, modelNum, boardName, odm, boardType, color, source *string

	err := db.reader.QueryRow(query, args...).Scan(
		&id, &m.UUID, &m.Brand, &model, &modelNum, &m.BoardNumber, &boardName, &odm, &boardType, &color, &source,
	)
	if err != nil {
		return nil
	}
	if model != nil {
		m.Model = *model
	}
	if modelNum != nil {
		m.ModelNumber = *modelNum
	}
	if boardName != nil {
		m.BoardName = *boardName
	}
	if odm != nil {
		m.ODM = *odm
	}
	if boardType != nil {
		m.Type = *boardType
	}
	if color != nil {
		m.Color = *color
	}
	if source != nil {
		m.Source = *source
	}

	// Load aliases
	rows, _ := db.reader.Query("SELECT alias_number FROM board_aliases WHERE board_id = ?", id)
	if rows != nil {
		defer rows.Close()
		for rows.Next() {
			var a string
			rows.Scan(&a)
			m.Aliases = append(m.Aliases, a)
		}
	}

	// Load model aliases
	rows2, _ := db.reader.Query("SELECT model_name FROM model_aliases WHERE board_id = ?", id)
	if rows2 != nil {
		defer rows2.Close()
		for rows2.Next() {
			var a string
			rows2.Scan(&a)
			m.ModelAliases = append(m.ModelAliases, a)
		}
	}
	return m
}
```

- [ ] **Step 5: Build the backend to catch any type mismatches**

Run:

```bash
cd src/backend && go build ./...
```

Expected: clean build, no output.

- [ ] **Step 6: Run existing handlers tests**

Run:

```bash
cd src/backend && go test ./handlers/... -v
```

Expected: all tests pass. The existing `handlers_test.go` may not specifically check the new fields, but it must not regress.

- [ ] **Step 7: Smoke-test the resolver against the real DB**

Run:

```bash
cd src/backend && cat > /tmp/boarddb_smoke.go <<'EOF'
package main

import (
	"encoding/json"
	"fmt"
	"os"

	"boardripper/boarddb"
)

func main() {
	db := boarddb.Open("../../Board Database/boards.db")
	if db == nil {
		fmt.Fprintln(os.Stderr, "could not open boards.db")
		os.Exit(1)
	}
	defer db.Close()

	for _, q := range []string{"820-00165", "NM-A251", "DA0R09MB6H1"} {
		m := db.Resolve(q)
		if m == nil {
			fmt.Printf("%s: not found\n", q)
			continue
		}
		out, _ := json.MarshalIndent(m, "", "  ")
		fmt.Printf("%s ->\n%s\n", q, string(out))
	}
}
EOF
go run /tmp/boarddb_smoke.go
rm /tmp/boarddb_smoke.go
```

Expected: each query returns a JSON blob whose top-level fields include `"uuid": "<uuid-v4-string>"` and `"color"` is absent (or empty) since no rows have `color_id` populated yet.

- [ ] **Step 8: Commit**

```bash
git add src/backend/boarddb/boarddb.go src/backend/boarddb/resolve.go
git commit -m "$(cat <<'EOF'
feat(boarddb): expose uuid + color in BoardMatch resolver API

- BoardMatch now carries UUID (always) and Color (when populated)
- Resolver SELECT joins colors to surface the canonical name string
- Every WHERE clause qualified with b. prefix for the JOIN
- /api/boards/resolve responses now include uuid + color (omitempty)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 3: Databank cache propagation

The databank caches resolved board metadata in its own SQLite DB so the frontend never needs to hit the boards.db resolver per file. We propagate `uuid` and `color` through this cache.

### Task 6: Add `migrateV6` to databank

**Files:**
- Modify: `src/backend/databank/db.go` (schemaVersion + new migrateV6 function + migrate() switch)

- [ ] **Step 1: Bump `schemaVersion` to 6**

In `src/backend/databank/db.go`, find the line `const schemaVersion = 5` (around line 240) and change it to:

```go
const schemaVersion = 6
```

- [ ] **Step 2: Add `migrateV6` function at the end of the file**

Append after the existing `migrateV5` function (around line 305):

```go
// migrateV6 adds board_uuid and board_color columns to the files table.
// These are denormalized from boards.db at scan time so the frontend can
// render them without an extra resolver fetch.
func (db *DB) migrateV6() error {
	tx, err := db.writer.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	stmts := []string{
		`ALTER TABLE files ADD COLUMN board_uuid TEXT`,
		`ALTER TABLE files ADD COLUMN board_color TEXT`,
	}

	for _, stmt := range stmts {
		if _, err := tx.Exec(stmt); err != nil {
			return fmt.Errorf("exec %q: %w", stmt[:40], err)
		}
	}

	if _, err := tx.Exec(`DELETE FROM schema_version`); err != nil {
		return err
	}
	if _, err := tx.Exec(`INSERT INTO schema_version (version) VALUES (?)`, 6); err != nil {
		return err
	}

	return tx.Commit()
}
```

- [ ] **Step 3: Wire `migrateV6` into the migration runner**

In `src/backend/databank/db.go`, find the `migrate` function (around line 245). It already has logic to call `migrateV4`, `migrateV5` based on the current version. Locate the section that looks like:

```go
if ver < 5 {
    if err := db.migrateV5(); err != nil {
        return err
    }
}
```

Add an analogous block immediately after it:

```go
if ver < 6 {
    if err := db.migrateV6(); err != nil {
        return err
    }
}
```

(If the existing code uses a `switch` instead of an `if` ladder, add a `case 5:` arm that calls `migrateV6()`.)

- [ ] **Step 4: Build to catch syntax errors**

Run:

```bash
cd src/backend && go build ./...
```

Expected: clean build.

---

### Task 7: Extend `FileRecord` struct + INSERT/SELECT/UPDATE statements

**Files:**
- Modify: `src/backend/databank/db.go` (FileRecord struct, all SQL statements that read/write files)

- [ ] **Step 1: Add `BoardUUID` and `BoardColor` to the `FileRecord` struct**

In `src/backend/databank/db.go`, find the `FileRecord` struct (around line 488) and add the two fields:

```go
type FileRecord struct {
	ID                int64  `json:"id"`
	Path              string `json:"path"`
	Filename          string `json:"filename"`
	Extension         string `json:"extension"`
	FileType          string `json:"file_type"`
	Size              int64  `json:"size"`
	ModTime           int64  `json:"mod_time"`
	ScanTime          int64  `json:"scan_time"`
	BoardNumber       string `json:"board_number,omitempty"`
	Manufacturer      string `json:"manufacturer,omitempty"`
	Model             string `json:"model,omitempty"`
	FormatID          string `json:"format_id,omitempty"`
	PartCount         *int   `json:"part_count,omitempty"`
	NetCount          *int   `json:"net_count,omitempty"`
	DonorPool         bool   `json:"donor_pool"`
	HasPreview        bool   `json:"has_preview"`
	BoardManufacturer string `json:"board_manufacturer,omitempty"`
	ResolutionStatus  string `json:"resolution_status,omitempty"`
	BoardUUID         string `json:"board_uuid,omitempty"`
	BoardColor        string `json:"board_color,omitempty"`
}
```

(The exact field set above is illustrative — preserve any existing fields you find. Only the last two lines are new.)

- [ ] **Step 2: Update INSERT statements to include the two new columns**

Find the two INSERT statements (around lines 545 and 561). Each looks roughly like:

```go
`INSERT INTO files (path, filename, extension, file_type, size, mod_time, scan_time, board_number, manufacturer, model, format_id, part_count, net_count, donor_pool, has_preview, board_manufacturer, resolution_status)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
```

Add two columns and two `?` placeholders to each:

```go
`INSERT INTO files (path, filename, extension, file_type, size, mod_time, scan_time, board_number, manufacturer, model, format_id, part_count, net_count, donor_pool, has_preview, board_manufacturer, resolution_status, board_uuid, board_color)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
```

Then update the corresponding `db.writer.Exec(...)` arg lists to pass the two new values. Look for the function signature that takes a `*FileRecord` or similar — likely `InsertFile` or `UpsertFile`. Append `nullStr(rec.BoardUUID), nullStr(rec.BoardColor)` to the args.

If you find both an INSERT and an INSERT-OR-REPLACE/UPSERT variant, update both.

- [ ] **Step 3: Update every SELECT statement that reads from `files`**

Grep for SQL strings that select from `files`:

```bash
cd src/backend && grep -n "FROM files" databank/db.go
```

For each occurrence, add `, board_uuid, board_color` to the column list (typically right after `resolution_status`). The Scan() call paired with each query also needs two new pointer args. Look for the matching `rows.Scan(...)` or `QueryRow(...).Scan(...)` and append:

```go
&rec.BoardUUID, &rec.BoardColor,
```

(or use `nullable string` pointers if the surrounding code uses that idiom — match the existing pattern for `BoardManufacturer`).

There are typically 3–4 SELECT statements (`ListFiles`, `GetFile`, `GetFileByPath`, `SearchFiles` or similar). Update them all.

- [ ] **Step 4: Update `UpdateFileMetadata` if it manages these fields**

In `src/backend/databank/db.go`, find `UpdateFileMetadata` (around line 587). It currently updates `board_number, manufacturer, model, donor_pool`. UUID and color come from the resolver, not from user edits, so this function should NOT directly update `board_uuid` or `board_color`. Leave it unchanged.

If you discover a separate function that updates resolution-derived fields (e.g., `UpdateBoardResolution`), add `board_uuid` and `board_color` to that function's UPDATE statement and arg list.

- [ ] **Step 5: Build the backend**

Run:

```bash
cd src/backend && go build ./...
```

Expected: clean build, no errors. If you see "wrong number of arguments to Scan", a SELECT got new columns but the corresponding Scan didn't get new args.

- [ ] **Step 6: Run databank tests**

Run:

```bash
cd src/backend && go test ./databank/... -v
```

Expected: all tests pass. If `db_test.go` validates a specific column count, update its expectation.

---

### Task 8: Populate `board_uuid` + `board_color` in `metadata.go`

**Files:**
- Modify: `src/backend/databank/metadata.go` (Metadata struct + every place that constructs Metadata from a BoardMatch)

- [ ] **Step 1: Add the two fields to the `Metadata` struct**

In `src/backend/databank/metadata.go`, find the `type Metadata struct` definition (search for `BoardNumber` to locate it) and add two fields:

```go
type Metadata struct {
	// ... existing fields ...
	BoardNumber       string
	Manufacturer      string
	Model             string
	BoardManufacturer string
	ResolutionStatus  string
	BoardUUID         string
	BoardColor        string
}
```

- [ ] **Step 2: Populate the two new fields wherever a `BoardMatch` is converted to `Metadata`**

In `metadata.go`, there are 5 places where a `match := bdb.Resolve(...)` (or `ResolveByAlias`) result is consumed and a `Metadata{...}` is constructed (lines 185–193, 209–213, 218–222, 225–229, 237–241 in the version we read).

For each construction site, add `BoardUUID: match.UUID, BoardColor: match.Color,` to the struct literal. For example, change:

```go
return Metadata{
    BoardNumber: match.BoardNumber, Manufacturer: match.Brand,
    Model: match.Model, BoardManufacturer: match.ODM, ResolutionStatus: "resolved",
}
```

to:

```go
return Metadata{
    BoardNumber: match.BoardNumber, Manufacturer: match.Brand,
    Model: match.Model, BoardManufacturer: match.ODM, ResolutionStatus: "resolved",
    BoardUUID: match.UUID, BoardColor: match.Color,
}
```

There are 5 such sites — update all 5. After editing, grep to confirm none were missed:

```bash
grep -n "Manufacturer: match.Brand" src/backend/databank/metadata.go
grep -n "BoardUUID: match.UUID" src/backend/databank/metadata.go
```

The two counts should be equal.

- [ ] **Step 3: Wire `Metadata.BoardUUID` and `BoardColor` into `FileRecord` at the call site**

Find the function that constructs a `FileRecord` from a `Metadata` (likely in `scanner.go` or wherever scan results are persisted). Add:

```go
rec.BoardUUID = m.BoardUUID
rec.BoardColor = m.BoardColor
```

next to the existing `rec.BoardNumber = m.BoardNumber` line. Grep to find the conversion site:

```bash
grep -n "BoardNumber = m.BoardNumber\|BoardManufacturer = m.BoardManufacturer\|m.Manufacturer\|Manufacturer = m" src/backend/databank/*.go
```

- [ ] **Step 4: Build**

Run:

```bash
cd src/backend && go build ./...
```

Expected: clean build.

- [ ] **Step 5: Re-run databank tests**

Run:

```bash
cd src/backend && go test ./databank/... -v
```

Expected: all pass.

- [ ] **Step 6: Smoke test by deleting the local databank DB and rescanning**

The databank DB lives at `~/.boardripper/databank.db` (or wherever `databank.DB.Open` points by default). For a clean smoke test:

```bash
# Find the databank DB path (varies by config — typically under user home)
find ~ -name "databank.db" -path "*boardripper*" 2>/dev/null | head -3
```

Move it aside (don't delete in case the smoke test fails):

```bash
mv "$(find ~ -name 'databank.db' -path '*boardripper*' 2>/dev/null | head -1)" "$_.bak"
```

Then start the BoardRipper backend (per the project's existing dev-run instructions — usually `make dev` or `go run ./src/backend/main.go`) and let it scan the library. Once scan completes, query:

```bash
sqlite3 "$(find ~ -name 'databank.db' -path '*boardripper*' 2>/dev/null | head -1)" \
  "SELECT filename, board_number, board_uuid, board_color FROM files WHERE board_number IS NOT NULL LIMIT 5;"
```

Expected: rows where `board_uuid` is populated for files whose board_number resolved against `boards.db`. `board_color` will be empty since no boards have a color yet.

- [ ] **Step 7: Commit Phase 3**

```bash
git add src/backend/databank/
git commit -m "$(cat <<'EOF'
feat(databank): cache board_uuid and board_color from resolver

- Schema migration v6 adds board_uuid + board_color columns to files
- FileRecord exposes the two new fields as JSON
- Metadata struct + INSERT/SELECT statements + 5 BoardMatch→Metadata
  conversion sites updated to plumb resolver output through

Frontend continues to read all metadata from /api/databank/files
without an extra resolver fetch — UUIDs and color now ride along.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 4: Frontend Library panel

### Task 9: Extend `DatabankFile` TypeScript interface

**Files:**
- Modify: `src/frontend/src/store/databank-store.ts:12-31`

- [ ] **Step 1: Add `board_uuid` and `board_color` to the `DatabankFile` interface**

In `src/frontend/src/store/databank-store.ts`, find the `DatabankFile` interface (around line 12) and add two optional fields:

```ts
export interface DatabankFile {
  id: number;
  path: string;
  filename: string;
  extension: string;
  file_type: 'board' | 'pdf';
  size: number;
  mod_time: number;
  scan_time: number;
  board_number: string;
  manufacturer: string;
  model: string;
  format_id: string;
  part_count: number | null;
  net_count: number | null;
  donor_pool: boolean;
  has_preview: boolean;
  board_manufacturer: string;
  resolution_status: 'resolved' | 'pattern_matched' | 'unresolved' | '';
  board_uuid?: string;
  board_color?: string;
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run:

```bash
cd src/frontend && npx tsc --noEmit
```

Expected: no errors.

---

### Task 10: Render "Color" row in Library panel detail

**Files:**
- Modify: `src/frontend/src/panels/LibraryPanel.tsx:654-669` (the `library-detail-meta` block)

- [ ] **Step 1: Add a "Color" line in the detail metadata block**

In `src/frontend/src/panels/LibraryPanel.tsx`, find the `library-detail-meta` block (around line 654). Locate the existing line:

```tsx
{detail.manufacturer && <span>Mfr: {detail.manufacturer}</span>}
```

Add a new `<span>` immediately after it:

```tsx
{detail.board_color && <span>Color: {detail.board_color}</span>}
```

The complete block becomes:

```tsx
<div className="library-detail-meta">
  {detail.board_number && <span>Board: {detail.board_number}</span>}
  {(() => {
    const resolved = detail.board_number ? lookupBoard(detail.board_number) : undefined;
    if (!resolved) return null;
    return <>
      <span className="library-detail-model-resolved">{resolved.a_number} {resolved.model}</span>
      <span className="library-detail-model-info" title={resolved.info}>{resolved.info}</span>
    </>;
  })()}
  {detail.manufacturer && <span>Mfr: {detail.manufacturer}</span>}
  {detail.board_color && <span>Color: {detail.board_color}</span>}
  {detail.model && <span>Model: {detail.model}</span>}
  {detail.part_count != null && <span>{detail.part_count} parts</span>}
  {detail.net_count != null && <span>{detail.net_count} nets</span>}
  <span>{formatSize(detail.size)}</span>
</div>
```

- [ ] **Step 2: Verify TypeScript compiles**

Run:

```bash
cd src/frontend && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Manually populate one board's color for a smoke test (in BOTH databases)**

Color values aren't in the SQL data yet (deferred to themes work). The Library panel reads from the *databank cache* (`databank.db`), which was populated at scan time — so just updating `boards.db` won't propagate without a rescan.

The fastest way to see the new row render is to update both DBs directly. First find the databank DB path:

```bash
DATABANK_DB=$(find ~ -name 'databank.db' -path '*boardripper*' 2>/dev/null | head -1)
echo "$DATABANK_DB"
```

Update both:

```bash
# Source-of-truth: boards.db
sqlite3 "Board Database/boards.db" \
  "UPDATE boards SET color_id = 1 WHERE brand = 'Apple' AND board_number LIKE '820-00165%';"

# Denormalized cache: databank.db (covers files whose scan resolved to this board)
sqlite3 "$DATABANK_DB" \
  "UPDATE files SET board_color = 'black' WHERE board_number LIKE '820-00165%' AND manufacturer = 'Apple';"

# Verify both
sqlite3 "Board Database/boards.db" \
  "SELECT b.board_number, c.name FROM boards b LEFT JOIN colors c ON b.color_id = c.id WHERE b.brand = 'Apple' LIMIT 3;"
sqlite3 "$DATABANK_DB" \
  "SELECT filename, board_number, board_color FROM files WHERE board_color IS NOT NULL LIMIT 5;"
```

Expected:
- `boards.db` query shows at least one Apple 820-00165 row with `color = 'black'`.
- `databank.db` query shows files (if any 820-00165 files exist in the user's library) with `board_color = 'black'`.

If `databank.db` returns no rows, the user's library doesn't contain any 820-00165 files — pick a different `board_number` that DOES match a scanned file. Inspect what's available:

```bash
sqlite3 "$DATABANK_DB" "SELECT DISTINCT board_number, manufacturer FROM files WHERE board_number != '' LIMIT 10;"
```

Then redo the UPDATEs against a board_number that has at least one cached file.

(After visual verification passes, this manual UPDATE will be undone in Step 6.)

- [ ] **Step 4: Run the dev server and verify visually**

Start the frontend dev server (per the project's existing dev workflow — typically `cd src/frontend && npm run dev`, or `make dev` from the repo root). Open BoardRipper in a browser, navigate to the Library panel, and click on the file you populated `board_color` for in Step 3.

Expected in the lower detail area:
```
Board: 820-00165...
A1466 MacBook Air 13"
MacBook Air 13" Early 2015 - Mid 2017
Mfr: Apple
Color: black                           ← new row
Model: ...
123 parts  456 nets  3.4 MB
```

If the "Color: black" row doesn't appear:
- DevTools → Network: confirm `/api/databank/files` includes `board_color: "black"` for the file in question. If yes but the UI still doesn't render it, double-check the JSX condition is `detail.board_color &&` not `detail.color &&`.
- If `board_color` is missing from the JSON response, re-check Task 7 Step 3 — a SELECT statement is missing the new column.

- [ ] **Step 5: Revert the smoke-test color edits in BOTH databases**

Reset the temporary smoke-test color so the committed `boards.db` matches what the SQL files produce, and the databank cache is consistent:

```bash
# Rebuild boards.db from source SQL (drops the manual UPDATE)
rm -f "Board Database/boards.db" "Board Database/boards.db-shm" "Board Database/boards.db-wal"
sqlite3 "Board Database/boards.db" < "Board Database/create_mockup_db.sql"
sqlite3 "Board Database/boards.db" < "Board Database/build_full_db.sql"

# Verify boards.db is back to all-null colors
sqlite3 "Board Database/boards.db" "SELECT count(*) FROM boards WHERE color_id IS NOT NULL;"

# Clear the smoke-test colors from databank.db
DATABANK_DB=$(find ~ -name 'databank.db' -path '*boardripper*' 2>/dev/null | head -1)
sqlite3 "$DATABANK_DB" "UPDATE files SET board_color = NULL;"
```

Expected: `boards.db` count is `0`. (Databank verification not strictly necessary — the next scan will repopulate from the resolver, which now returns no color.)

- [ ] **Step 6: Commit Phase 4**

```bash
git add src/frontend/src/store/databank-store.ts src/frontend/src/panels/LibraryPanel.tsx
git commit -m "$(cat <<'EOF'
feat(library): show board color in detail panel

- DatabankFile gains board_uuid + board_color (both optional strings)
- LibraryPanel renders "Color: <name>" row in lower detail meta when
  the resolved board has a color assigned in boards.db

Color values themselves come from boards.db.color_id → colors.name
JOIN in the Go resolver, denormalized into the databank cache via
the v6 schema migration.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 5: Final verification

### Task 11: End-to-end smoke + git log audit

**Files:**
- (read-only verification)

- [ ] **Step 1: Confirm git history is clean and well-described**

Run:

```bash
git log --oneline -10
```

Expected: 5 commits from this plan, in order:
1. `feat(boarddb): add colors lookup table and uuid column to schema`
2. `feat(boarddb): inject stable UUIDs into build_full_db.sql`
3. `build(boarddb): rebuild boards.db with uuids + colors schema`
4. `feat(boarddb): expose uuid + color in BoardMatch resolver API`
5. `feat(databank): cache board_uuid and board_color from resolver`
6. `feat(library): show board color in detail panel`

(Six commits if you count the rebuild as separate from the inject — that's fine.)

- [ ] **Step 2: Confirm boards.db has the expected shape one more time**

Run:

```bash
sqlite3 "Board Database/boards.db" <<'EOF'
.schema boards
.schema colors
SELECT count(*) AS total, count(uuid) AS with_uuid FROM boards;
SELECT count(*) FROM colors;
SELECT uuid, brand, board_number FROM boards LIMIT 3;
EOF
```

Expected:
- `boards` schema has `uuid TEXT NOT NULL UNIQUE` and `color_id INTEGER REFERENCES colors(id)`.
- `colors` schema is the new table.
- `total == with_uuid` (every board has a UUID).
- `colors` has 12 rows.
- 3 sample rows show non-null UUIDs.

- [ ] **Step 3: Confirm the resolver API returns the new fields**

Start the backend and curl the resolver:

```bash
# Backend should be running on localhost:1336 per the dev setup
curl -s 'http://localhost:1336/api/boards/resolve?q=820-00165' | python3 -m json.tool
```

Expected: top-level `match` object includes `"uuid": "<some-uuid>"`. `color` may or may not appear (omitempty).

- [ ] **Step 4: Confirm the Library panel works end-to-end**

Open BoardRipper in the browser, click a board file in the Library, and confirm:
- The detail panel renders.
- No console errors related to `board_color` or `board_uuid`.
- If you re-set the manual color UPDATE from Task 10 Step 3, the "Color: <name>" row reappears.

- [ ] **Step 5: Run the full test suite one last time**

Run:

```bash
cd src/backend && go test ./...
cd src/frontend && npm test 2>&1 | tail -20
```

Expected: all green. If frontend tests don't exist or aren't wired up, `npm test` may exit cleanly with no output — that's fine.

- [ ] **Step 6: Done — no commit needed**

Phase 5 is verification only. If everything above passes, the implementation is complete and the user can review the branch / merge.

---

## Future-work pointers (deferred, do NOT implement here)

These are explicitly out of scope per the spec but are referenced here so a future engineer reading the plan knows where the seams are:

- **Adaptive color scheme** (Apple → black, Dell → blue, Lenovo → green, Lenovo Legion → blue): brand-pattern table + theme code, lands with the theming work. The `color_id` column being nullable is the load-bearing seam — boards without explicit color fall through to brand-pattern matching.
- **Knowledge anchors** (chip families, wiki references, board overrides): separate spec, separate brainstorm. UUID is the join key; new tables reference `boards.uuid` directly.
- **External-source ingestion** (devicedb.xyz, Telegram channel, OpenBoardData): `external_refs(board_uuid, source, external_id)` table, separate spec.
- **OpenBoardData per-net measurements**: `board_measurements(board_uuid, net_name, ...)`, ODbL-licensed, ship as optional layer.

The schema as built does not paint any of these into a corner. UUID-as-external-handle is the universal join lever.
