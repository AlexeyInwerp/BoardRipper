# Board Database Integration — Design Spec

**Date:** 2026-04-03
**Status:** Design approved (user pre-approved all decisions)

---

## Problem

Repair shops have chaotic archives of schematics, boardviews, BIOS dumps, and datasheets with inconsistent naming. Files like `random_junk_820-02016.brd` or `Compal GPR31 LA-J481P Rev 1.0` require manual identification. The existing databank scanner only extracts Apple 820-XXXXX board numbers and basic manufacturer keywords from filenames — covering a fraction of the real-world board landscape.

## Solution

Integrate a **Board Database** (`boards.db`) as a read-only reference SQLite DB alongside the existing `databank.db`. This DB maps board numbers → Brand (OEM) / Model / Board Manufacturer (ODM) with high confidence, covering all major ODMs and naming conventions.

---

## Architecture Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| DB separation | Separate `boards.db` (reference) vs `databank.db` (user data) | Independent update cycles, clean backup/reset semantics |
| Population | Pre-built DB shipped with Docker image, external crawlers, import mechanism | Crawlers are messy (HTML parsing, API keys) — don't belong in lean Go backend |
| Lookup triggers | Scan-time + on-demand API + bulk re-resolve | Re-resolve needed after importing updated `boards.db` |
| Matching engine | Go (server-side only) | Scanner runs in Go; frontend calls API |
| Canonical rename | Board number only (e.g., `820-02016-A.brd`) | Repair shop convention — the board number IS the identity |

---

## The ODM Layer

A key architectural insight: **the regex pattern tells you the board manufacturer (ODM), not the brand (OEM)**. This is a first-class concept.

```
LA-K371P  →  ODM: Compal  →  could be Dell, Lenovo, Acer, HP, Framework
NM-B291   →  ODM: LCFC    →  always Lenovo
DA0R09MB6H1 → ODM: Quanta →  could be HP, Dell, Acer, Toshiba
820-02016-A → ODM: Apple   →  always Apple
```

### ODM Pattern Registry

Each regex pattern maps to an ODM. Priority order (most distinctive first):

| # | Pattern | ODM | Notes |
|---|---------|-----|-------|
| 1 | `820-\d{4,5}(-[A-Z])?` | Apple | Always Apple |
| 2 | `661-\d{5}` | Apple | Service part number |
| 3 | `NM-[A-Z]\d{3,4}` | LCFC | Always Lenovo |
| 4 | `LA-[A-Z]?\d{3,4}[A-Z]?` | Compal | Multi-brand (Dell, Lenovo, HP, Acer) |
| 5 | `DA[0A-Z][A-Z0-9]{2,4}MB[0-9A-Z]{3,5}` | Quanta | Multi-brand (HP, Acer, ASUS, Lenovo) |
| 6 | `60N[BR][A-Z0-9]{4}-MB[A-Z0-9]{4,5}` | ASUS | NB=consumer, NR=gaming |
| 7 | `448\.\d{2}[A-Z]\d{2}\.\d{3,4}` | Wistron | 448-series manufacturing number |
| 8 | `6050A\d{7,10}` | Inventec* | *Actually HP's assembly numbering — may be Inventec or Wistron |
| 9 | `MB\.[A-Z0-9]{5}\.\d{3}` | Acer | Acer internal part number |
| 10 | `5B\d{2}[A-Z]\d{5}` | Lenovo | FRU number (newer format) |
| 11 | `\d{2}X\d{4,5}` | Lenovo | FRU number (older format) |
| 12 | `MS-\d{4,5}` | MSI | First 2 digits = screen size |
| 13 | `MBX-\d{2,3}` | Sony | Sony VAIO internal |
| 14 | `BA4[12]-\d{5}` | Samsung | BA41=bare PCB, BA92=assembly |
| 15 | `RZ09-\d{4}` | Razer | Razer model number |
| 16 | `N[HPB]\d{2}[A-Z]{2,4}` | Clevo | Chassis code |
| 17 | `[A-Z]?\d{5,6}-\d{3}` | HP | HP spare part number |
| 18 | `\d{4,5}-\d[A-Z]?` | Wistron | Numeric project code (least distinctive) |

### ODM Naming Anatomy (Research Summary)

**Compal (LA-):** Letter after LA- = generation (A=2013 → M=2024, skips I/J/L/O). 3 digits = sequential project number. Trailing P = production revision. Each board has a 5-char codename (e.g., AAZ80, CAZ60, GDL56).

**LCFC/Lenovo (NM-):** Same letter-generation pattern as Compal (A→F). 3 digits = sequential. Always Lenovo. LCFC project codenames are 4-5 char alphanumeric (EYG70, FX490, HY56F).

**Quanta (DA0/DAx):** `DA` + project code + `MB` + layer/revision suffix. 4th char evolved from always "0" to letters (Y=HP, Z=Acer, G=HP Omen, N=ASUS). Project codes are 2-4 chars. Digit after MB = PCB layer count (6/8) in legacy format.

**Wistron:** 5-digit sequential project number + dash + revision (-1, -2, -3M). Codenames are single words (WOODY, CAMELLIA, DOH40). Platform suffixes (_KBL, _CFL, _TGL).

**6050A (HP numbering):** This is HP's assembly numbering, not ODM-specific. 7 digits after 6050A, roughly chronological. `-MB-A01` suffix = motherboard revision A01. The ODM (Inventec or Wistron) must be determined from board codenames.

---

## Backend Design

### New Package: `boarddb/`

Located at `src/backend/boarddb/`. Opens `boards.db` as read-only SQLite.

**Files:**
- `boarddb.go` — DB connection, lifecycle, stats
- `odm.go` — ODM pattern registry (compiled regexes + ODM mapping)
- `matcher.go` — `ExtractBoardNumbers(filename) → []ExtractedNumber`
- `resolve.go` — `Resolve(boardNumber) → *BoardMatch`

#### `ExtractBoardNumbers(filename string) → []ExtractedNumber`

Applies all ODM patterns in priority order against the filename. Returns all matches with:
```go
type ExtractedNumber struct {
    Number  string // "LA-K371P"
    ODM     string // "Compal"
    Type    string // "compal_la"
    Pattern string // regex that matched
}
```

#### `Resolve(boardNumber string) → *BoardMatch`

1. Exact match on `boards.board_number`
2. LIKE match for partial numbers (e.g., `820-02016` matches `820-02016-A`)
3. Check `board_aliases.alias_number`
4. Return full record + all aliases + all model aliases

```go
type BoardMatch struct {
    BoardNumber   string
    Brand         string   // OEM: "Dell", "Apple", "HP"
    Model         string   // "XPS 13 9350"
    ModelNumber   string   // "A2337", "9350"
    BoardName     string   // Codename: "AAZ80", "X1757"
    ODM           string   // Board manufacturer: "Compal", "Apple"
    Aliases       []string // All known aliases
    ModelAliases  []string // Compatible model names
    Source        string   // Data provenance
}
```

### Enhanced Scanner Integration

`databank/metadata.go` `ExtractMetadata()` enhanced:

1. Call `boarddb.ExtractBoardNumbers(filename)` (replaces limited Apple-only regex)
2. For each extracted number, call `boarddb.Resolve()`
3. Populate `files` columns:

| Column | Source | Example |
|--------|--------|---------|
| `board_number` | regex extraction (canonical from DB if resolved) | `LA-K371P` |
| `board_manufacturer` | ODM registry (always known from pattern) | `Compal` |
| `manufacturer` | DB lookup (OEM brand) | `Dell` |
| `model` | DB lookup | `XPS 13 9350` |
| `resolution_status` | logic | `resolved` / `pattern_matched` / `unresolved` |

### Schema Migration (v4)

New columns on `files` table:
```sql
ALTER TABLE files ADD COLUMN board_manufacturer TEXT;
ALTER TABLE files ADD COLUMN resolution_status TEXT DEFAULT 'unresolved';
CREATE INDEX idx_files_resolution ON files(resolution_status);
CREATE INDEX idx_files_board_mfg ON files(board_manufacturer);
```

### New API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `GET /api/boards/resolve?q=NM-A251` | GET | Look up a board number, return full match |
| `POST /api/boards/re-resolve` | POST | Re-run all databank files against Board DB |
| `POST /api/boards/import` | POST | Upload a new `boards.db` file |
| `GET /api/boards/stats` | GET | Board DB stats (count by brand, ODM, etc.) |
| `PATCH /api/databank/files/{id}/rename` | PATCH | Rename file on disk + DB (for canonical renaming) |

### Board DB Location

Configurable via `config` table key `board_db_path`. Default: `./data/boards.db` (same Docker volume as `databank.db`). If missing, feature is disabled silently.

---

## Frontend Design

### Resolution Indicators

Library Panel file entries get a colored status dot:
- **Green** — `resolved`: board number found in Board DB, brand/model known
- **Yellow** — `pattern_matched`: regex matched an ODM pattern, but board not in DB
- **Grey** — `unresolved`: no board number detected

### Board Lookup Panel

A search box where users can type any board number and get instant results from the Board DB. Shows: brand, model, ODM, all aliases, compatible models.

### Filename Rename with Canonical Suggestions

When a file is `resolved`, the context menu offers **"Suggest rename"** → proposes canonical name using just the board number (e.g., `random_junk_820-02016.brd` → `820-02016-A.brd`). User confirms or edits before executing.

### Enhanced Metadata View

The existing Metadata grouping view benefits automatically — with Board DB enrichment, `manufacturer` and `board_number` fields are populated for far more files, making the Foobar2000-style tree much richer.

### Model View Expansion

Currently Apple-only (hardcoded `apple-boards.ts`). With the Board DB, the Model view can show all brands: Lenovo ThinkPad/IdeaPad/Legion, Dell XPS/Latitude/Precision, HP ProBook/EliteBook/OMEN, etc.

---

## Board Database Schema

Separate SQLite file (`boards.db`), read-only from Go backend.

```sql
CREATE TABLE boards (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    brand            TEXT NOT NULL,      -- OEM: "Apple", "Dell", "Lenovo"
    model            TEXT,               -- "MacBook Pro 16\" 2019"
    model_number     TEXT,               -- "A2141", "9350"
    board_number     TEXT NOT NULL,      -- Primary: "820-01700-A", "LA-C881P"
    board_name       TEXT,               -- Codename: "AAZ80", "Quanta G3BE"
    odm              TEXT,               -- Board manufacturer: "Apple", "Compal", "Quanta"
    board_number_type TEXT,              -- "apple_820", "compal_la", "quanta_da0"
    source           TEXT NOT NULL,      -- "logiwiki", "badcaps", "ebay"
    source_url       TEXT,
    created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at       DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE board_aliases (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    board_id    INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    alias_number TEXT NOT NULL,
    alias_type   TEXT
);

CREATE TABLE model_aliases (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    board_id    INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    model_name  TEXT NOT NULL
);
```

### Current Coverage

As of 2026-04-03: **252 boards, 71 aliases, 6 model aliases**.

| Brand | Count |
|-------|-------|
| Apple | 88 |
| Lenovo | 48 |
| HP | 27 |
| Acer | 22 |
| Dell | 19 |
| ASUS | 17 |
| Others | 31 |

**Identification rate against user's real-world archives: 99%** (208/208 unique board numbers from samples/ and BOARDS STUFF/).

---

## Import/Update Mechanism

`POST /api/boards/import` accepts a `boards.db` file upload:
1. Validate: must be valid SQLite with expected tables
2. Save to configured path (atomic rename)
3. Reopen read-only connection
4. Optionally trigger `POST /api/boards/re-resolve` to update all files

---

## Out of Scope

- Web crawlers (external tools, produce `boards.db` — see `Board Database/docs/board-database-spec.md`)
- Library organizer module (folder reorganization engine — separate spec)
- Batch rename API (needed by organizer, not this spec)
- Drag-and-drop file moving in UI
- Community contribution system
