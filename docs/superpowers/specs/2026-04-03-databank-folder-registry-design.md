# Databank Folder Registry & DB Tooling

**Date:** 2026-04-03
**Status:** Design approved

## Problem

1. When a library mount disappears or a top-level folder is removed, the scanner's cleanup phase iterates every DB entry individually (N+1 DELETEs), blocking the app for minutes on large libraries (8500+ files = 1.5GB DB).
2. DB size is not visible to the user — no way to know if the 1.5GB DB needs optimization.
3. No way to rename, delete, or discard files/folders from the library UI.
4. The flat `files` table has no structural concept of directories, making subtree operations expensive.

## Solution

Add a `folders` table that tracks every directory as a tree. Files link to their parent folder. This enables:
- Instant offline detection (check root folders only)
- Cascade deletion of entire subtrees (one query)
- Foundation for future library organizer (rearrange files between folders)

---

## Database Changes

### New Table: `folders`

```sql
CREATE TABLE folders (
  id        INTEGER PRIMARY KEY,
  parent_id INTEGER REFERENCES folders(id) ON DELETE CASCADE,
  name      TEXT NOT NULL,
  path      TEXT NOT NULL UNIQUE,
  status    TEXT NOT NULL DEFAULT 'online',  -- 'online' | 'offline'
  scan_time INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_folders_parent ON folders(parent_id);
CREATE INDEX idx_folders_status ON folders(status);
```

### Altered Table: `files`

```sql
ALTER TABLE files ADD COLUMN folder_id INTEGER REFERENCES folders(id) ON DELETE CASCADE;
CREATE INDEX idx_files_folder ON files(folder_id);
```

### Migration (schema version 4)

1. Create `folders` table
2. Add `folder_id` column to `files` (nullable initially)
3. Backfill: extract folder paths from existing `files.path`, create folder rows, set `folder_id`
4. After backfill, `folder_id` should be NOT NULL for all rows (but keep nullable in schema for safety during migration)

### Cascade Behavior

`DELETE FROM folders WHERE id = X` automatically deletes:
- All child folders (via `parent_id` cascade)
- All files in those folders (via `folder_id` cascade)
- All bindings for those files (via `board_file_id`/`pdf_file_id` cascade)
- All pdf_pages for those files (via `file_id` cascade)
- All pdf_scan_errors for those files (via `file_id` cascade)
- FTS5 `pdf_text` entries must be deleted explicitly before file deletion (no cascade support)

---

## Scanner Redesign

### Phase 0: Mount Health Check (new, instant)

```
SELECT id, path FROM folders WHERE parent_id IS NULL
```

For each root folder:
- `os.Stat(scanRoot + "/" + path)`
- Missing → `UPDATE folders SET status='offline' WHERE id=?`
- Present but was offline → `UPDATE folders SET status='online' WHERE id=?`

Cost: one stat call per root folder. Instant.

### Phase 1: Walk Filesystem (modified)

- Skip paths under offline root folders
- As directories are encountered: upsert into `folders` (get-or-create with correct parent_id)
- Each collected diskFile records its folder_id

### Phase 2: Compare with DB (unchanged logic)

- `AllFilePaths()` now also returns folder_id per record
- Only loads files from online folders

### Phase 3: Process Files (minor change)

- New files get folder_id set during batch insert
- Otherwise unchanged

### Phase 4: Cleanup (redesigned)

Two-level approach:

1. **Folder-level cleanup:** For all online folders in DB, check if they still exist on disk. Missing → `DELETE FROM folders WHERE id=?` (cascade handles all children + files). One query per missing folder.
2. **Leaf file cleanup:** For files in online folders that are no longer on disk, batch delete: `DELETE FROM files WHERE id IN (?, ?, ?, ...)` inside a single transaction. Explicit `DELETE FROM pdf_text WHERE file_id IN (...)` first for FTS5.
3. **Offline folders: skip entirely.** No checking, no deleting.

### Phase 5: Auto-matching (unchanged)

---

## New API Endpoints

### `DELETE /api/databank/folders/{id}`

Remove a folder and all its children from the DB. Does NOT touch disk (designed for discarding offline branches).

**Response:** `{ "deleted_files": N, "deleted_folders": N }`

**Pre-step:** Delete FTS5 entries for all files in the subtree before cascade.

### `PATCH /api/databank/files/{id}/rename`

**Body:** `{ "name": "new-filename.brd" }`

1. Validate: file must be online, new name must have valid extension
2. Rename physical file on disk (`os.Rename`)
3. Update `files.path` and `files.filename` in DB
4. Return updated file record

### `DELETE /api/databank/files/{id}`

Delete a single file from disk + DB.

1. If file is in an offline folder → return 409 (use "remove from DB" via folder delete instead)
2. `os.Remove` the physical file
3. Delete FTS5 entries, then delete file record from DB

### `POST /api/databank/vacuum`

Run SQLite `VACUUM` to reclaim space after mass deletions.

**Response:** `{ "before_bytes": N, "after_bytes": N }`

Runs synchronously (may take seconds for large DBs).

### `GET /api/databank/folders`

Returns the folder tree with status and file counts.

```json
[
  {
    "id": 1,
    "name": "Apple Boards By Number",
    "path": "Apple Boards By Number",
    "status": "online",
    "parent_id": null,
    "file_count": 234,
    "child_count": 45
  },
  ...
]
```

---

## Frontend Changes

### Settings / Library Panel — DB Info

Display in the library panel header:
```
DB: 1.4 GB — 7029 files, 456 PDFs | [Optimize DB]
```

"Optimize DB" button calls `POST /api/databank/vacuum`, shows before/after size.

### Scan Status — Verbose Progress

Show current phase prominently:
```
Checking mounts...
Walking filesystem (1234 files)...
Processing 1234/5000...
Cleaning 12 removed files...
Matching PDFs...
```

After completion, show per-phase breakdown:
```
7029 files — scan: +45 -12 (walk 2.1s, process 5.3s, cleanup 0.1s)
3 folders offline (1,200 files cached)
```

### Offline Folder Indicators

- Offline root folders: dimmed style + "offline" badge in folder tree
- Files under offline folders: greyed out, not clickable
- Hover tooltip: "Source unavailable — folder offline"
- The offline branch is visually distinct (e.g., italic + muted color)

### Right-Click Context Menu — Files

| Action | Condition | Behavior |
|--------|-----------|----------|
| **Rename** | File is online | Inline rename → `PATCH /api/databank/files/{id}/rename` |
| **Delete** | File is online | Confirm → deletes from disk + DB |
| **Remove from database** | File is under offline folder | Removes DB entry only (disk unavailable) |

### Right-Click Context Menu — Folders

| Action | Condition | Behavior |
|--------|-----------|----------|
| **Discard from database** | Folder is offline | Confirm ("Remove N files from database?") → `DELETE /api/databank/folders/{id}` |

---

## Migration Strategy

Schema version bump: 3 → 4.

The migration must:
1. Create `folders` table
2. Add `folder_id` column to `files`
3. Backfill folders from existing file paths:
   - Extract unique directory paths from `files.path`
   - Build parent chain for each
   - Insert folder rows
   - Update `files.folder_id` to point to the correct folder

This is a one-time cost on first startup after upgrade. For a DB with 8500 files, expect ~1-2 seconds.

---

## Out of Scope (Future)

- Library organizer (rearrange files based on board-number-to-model mapping) — the folder registry is the foundation, but the organizer logic is a separate feature
- Drag-and-drop file moving between folders in the UI
- Multi-library support (multiple scan roots)
