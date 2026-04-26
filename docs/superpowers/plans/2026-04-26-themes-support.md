# Themes Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a global theme system with two presets (BoardRipper Default — current colors, Landrex Classic — black UI/canvas, white parts, yellow selection), a "Use board metadata color" toggle wired to the boards.db colors table's hex values, and refactor the 1543-line SettingsPanel into a 4-tab layout (Theme / Board / Input / System) matching the LibraryPanel tab pattern.

**Architecture:** New `themeStore` singleton (Emitter-based, mirrors `renderSettingsStore`) holds the active theme id and writes its `ui.*` colors to CSS custom properties on `document.documentElement` while its `board.*` colors are read by a converted-to-getter `BOARD_COLORS` object in `board-scene.ts`. Hardcoded color literals scattered through `BoardRenderer.ts` are replaced with `BOARD_COLORS` references. The metadata-color toggle is a new `useMetadataBoardColor: boolean` field in `RenderSettings`; a new `resolveBoardFillColor(boardColorHex, theme, useMetadata)` helper picks between the theme default and the per-board hex at draw time, while the existing `boardFillAlpha` slider continues to control opacity. The hex flows: `colors.hex` SQL seed → `BoardMatch.ColorHex` (Go resolver) → databank `files.board_color_hex` denormalization → `DatabankFile.board_color_hex` (frontend) → renderer.

**Tech Stack:** TypeScript + React 19, PixiJS v8, Go 1.22 (`net/http` + `modernc.org/sqlite`), SQLite 3, Vite 7 build, Playwright 1.58 tests.

**Spec:** [docs/superpowers/specs/2026-04-26-themes-support-design.md](../specs/2026-04-26-themes-support-design.md)

**Prerequisites:** This plan assumes [docs/superpowers/plans/2026-04-26-boards-db-uuid-color.md](2026-04-26-boards-db-uuid-color.md) is fully implemented and merged. Specifically, the following must already exist: `colors` table in boards.db, `boards.color_id` column, `BoardMatch.Color string` field in Go, `files.board_color` column in the databank cache, `DatabankFile.board_color` field in the frontend. If any of these are missing, stop and complete that plan first.

---

## Phase 1: Backend hex propagation

### Task 1: Populate `colors.hex` seed values in build SQL

**Files:**
- Modify: `Board Database/build_full_db.sql` (the `INSERT INTO colors` block added by the boards.db plan)

- [ ] **Step 1: Locate the colors seed block**

Run:

```bash
grep -n "INSERT INTO colors\|INSERT OR IGNORE INTO colors" "Board Database/build_full_db.sql" "Board Database/create_mockup_db.sql"
```

Expected: one match in `create_mockup_db.sql` (the seed block added by Task 1 Step 4 of the boards.db plan). If you see matches in `build_full_db.sql` instead, the seed lives there — adapt the next step to the file you actually find.

- [ ] **Step 2: Replace the seed values block to include hex tints**

Open the file containing the colors seed (`Board Database/create_mockup_db.sql` per the boards.db plan). Replace the entire `INSERT OR IGNORE INTO colors (id, name, sort_order) VALUES (...)` block with:

```sql
-- Color seed (12 entries: 4 core + 8 exceptions, hex tints populated for themes work)
INSERT OR IGNORE INTO colors (id, name, hex, sort_order) VALUES
    (1,  'black',  '#1a1a1a', 1),
    (2,  'red',    '#8a1a1a', 2),
    (3,  'green',  '#1a4a2a', 3),
    (4,  'blue',   '#1a3a8a', 4),
    (5,  'white',  '#e0e0e0', 5),
    (6,  'yellow', '#a89030', 6),
    (7,  'purple', '#5a2a8a', 7),
    (8,  'orange', '#c06030', 8),
    (9,  'pink',   '#c060a0', 9),
    (10, 'brown',  '#6a4a2a', 10),
    (11, 'silver', '#a8a8b0', 11),
    (12, 'gold',   '#a89050', 12);
```

The hex column was already created by the boards.db plan (`hex TEXT,` — nullable). We're just adding values.

- [ ] **Step 3: Verify the SQL parses against an empty in-memory DB**

Run:

```bash
sqlite3 ":memory:" < "Board Database/create_mockup_db.sql" 2>&1 | head
```

Expected: no output. Any "near \"...\"": fix the syntax and re-run.

- [ ] **Step 4: Verify the seed produces the expected rows**

Run:

```bash
sqlite3 ":memory:" "$(cat 'Board Database/create_mockup_db.sql'; echo; echo 'SELECT id, name, hex FROM colors ORDER BY id;')"
```

Expected: 12 rows printed with format `1|black|#1a1a1a`, `2|red|#8a1a1a`, etc., matching the table above.

---

### Task 2: Extend `BoardMatch` with `ColorHex` and update resolver SQL

**Files:**
- Modify: `src/backend/boarddb/boarddb.go` (BoardMatch struct, added by the boards.db plan)
- Modify: `src/backend/boarddb/resolve.go` (boardQuery const, queryBoard function — both touched by the boards.db plan)

- [ ] **Step 1: Add `ColorHex` field to `BoardMatch`**

Open `src/backend/boarddb/boarddb.go`. Find the `BoardMatch` struct (a `Color` field already exists from the boards.db plan). Add `ColorHex` immediately after `Color`:

```go
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
	ColorHex     string   `json:"color_hex,omitempty"`
	Aliases      []string `json:"aliases,omitempty"`
	ModelAliases []string `json:"model_aliases,omitempty"`
	Source       string   `json:"source,omitempty"`
}
```

(Preserve any other fields that exist in your tree; only add the `ColorHex` line.)

- [ ] **Step 2: Add `c.hex` to the boardQuery SELECT list**

In `src/backend/boarddb/resolve.go`, find the `const boardQuery` line (added by Task 5 of the boards.db plan, which already includes the `LEFT JOIN colors c ON b.color_id = c.id`). Replace its value with:

```go
const boardQuery = `SELECT b.id, b.uuid, b.brand, b.model, b.model_number, b.board_number, b.board_name, b.odm, b.board_number_type, c.name AS color, c.hex AS color_hex, b.source FROM boards b LEFT JOIN colors c ON b.color_id = c.id`
```

(One column added: `, c.hex AS color_hex` immediately after `c.name AS color`.)

- [ ] **Step 3: Scan the new column in `queryBoard`**

Still in `src/backend/boarddb/resolve.go`, find the `queryBoard` function. The current Scan call (added by the boards.db plan) looks roughly like:

```go
var model, modelNum, boardName, odm, boardType, color, source *string

err := db.reader.QueryRow(query, args...).Scan(
    &id, &m.UUID, &m.Brand, &model, &modelNum, &m.BoardNumber, &boardName, &odm, &boardType, &color, &source,
)
```

Replace those two lines with:

```go
var model, modelNum, boardName, odm, boardType, color, colorHex, source *string

err := db.reader.QueryRow(query, args...).Scan(
    &id, &m.UUID, &m.Brand, &model, &modelNum, &m.BoardNumber, &boardName, &odm, &boardType, &color, &colorHex, &source,
)
```

Then find the existing `if color != nil { m.Color = *color }` block. Add immediately after it:

```go
if colorHex != nil {
    m.ColorHex = *colorHex
}
```

- [ ] **Step 4: Build the backend**

Run:

```bash
cd src/backend && go build ./...
```

Expected: clean build, no output. If you see "wrong number of arguments", a column count is off between SELECT and Scan.

- [ ] **Step 5: Run handlers tests**

Run:

```bash
cd src/backend && go test ./handlers/... ./boarddb/... -v 2>&1 | tail -30
```

Expected: all pass.

- [ ] **Step 6: Commit Phase 1.1 + 1.2**

```bash
git add "Board Database/create_mockup_db.sql" src/backend/boarddb/boarddb.go src/backend/boarddb/resolve.go
git commit -m "$(cat <<'EOF'
feat(boarddb): populate colors.hex seed + expose ColorHex in BoardMatch

12 hex tints added to the colors seed (desaturated PCB-substrate
colors so a green Lenovo board reads as a faint green wash at the
default boardFillAlpha). BoardMatch.ColorHex propagates the hex
through the resolver API for the upcoming themes work.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Databank `migrateV7` — add `board_color_hex` column

**Files:**
- Modify: `src/backend/databank/db.go` (schemaVersion bump, migrateV7 function, migrate() switch)

- [ ] **Step 1: Bump `schemaVersion`**

In `src/backend/databank/db.go`, find the line `const schemaVersion = 6` (set by the boards.db plan). Change to:

```go
const schemaVersion = 7
```

- [ ] **Step 2: Add `migrateV7` function**

Append after the existing `migrateV6` function (the one added by the boards.db plan):

```go
// migrateV7 adds board_color_hex to the files table for theme-driven
// board fill rendering. Hex is denormalized from boards.db colors.hex
// at scan time so the frontend can render without a per-file fetch.
func (db *DB) migrateV7() error {
	tx, err := db.writer.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	if _, err := tx.Exec(`ALTER TABLE files ADD COLUMN board_color_hex TEXT`); err != nil {
		return fmt.Errorf("add board_color_hex: %w", err)
	}

	if _, err := tx.Exec(`DELETE FROM schema_version`); err != nil {
		return err
	}
	if _, err := tx.Exec(`INSERT INTO schema_version (version) VALUES (?)`, 7); err != nil {
		return err
	}

	return tx.Commit()
}
```

- [ ] **Step 3: Wire migrateV7 into the migration runner**

Find the `migrate` function. After the block:

```go
if ver < 6 {
    if err := db.migrateV6(); err != nil {
        return err
    }
}
```

Add immediately after:

```go
if ver < 7 {
    if err := db.migrateV7(); err != nil {
        return err
    }
}
```

- [ ] **Step 4: Build to catch errors**

Run:

```bash
cd src/backend && go build ./...
```

Expected: clean build.

---

### Task 4: Add `BoardColorHex` to `FileRecord` + INSERT/SELECT updates

**Files:**
- Modify: `src/backend/databank/db.go` (FileRecord struct, INSERT/SELECT statements)
- Modify: `src/backend/databank/scanner.go` (or wherever boards.db resolution writes back into the file row — added by the boards.db plan; grep to find it)

- [ ] **Step 1: Add `BoardColorHex` to `FileRecord`**

In `src/backend/databank/db.go`, find the `FileRecord` struct. The boards.db plan already added a `BoardColor` field. Add `BoardColorHex` immediately after it:

```go
BoardColor    string `json:"board_color,omitempty"`
BoardColorHex string `json:"board_color_hex,omitempty"`
```

- [ ] **Step 2: Update INSERT statements**

Find every `INSERT INTO files` SQL string in `db.go`:

```bash
cd src/backend && grep -n "INSERT INTO files\|INSERT OR REPLACE INTO files" databank/db.go
```

For each match, add `, board_color_hex` to the column list (immediately after `board_color`) and one extra `?` to the VALUES list. Update the corresponding `db.writer.Exec(...)` arg list to pass `nullStr(rec.BoardColorHex)` (or whatever null-string helper the surrounding code uses for `BoardColor` — match the pattern verbatim).

- [ ] **Step 3: Update SELECT statements**

Find every SELECT against `files`:

```bash
cd src/backend && grep -n "FROM files" databank/db.go
```

For each match, add `, board_color_hex` to the column list (immediately after `board_color`). For the matching `Scan(...)` call, add `&rec.BoardColorHex` (or the nullable-string-pointer pattern used for `BoardColor`).

There are typically 3–4 SELECT call sites (`ListFiles`, `GetFile`, `GetFileByPath`, `SearchFiles`). Update them all.

- [ ] **Step 4: Update the resolver-write path**

The boards.db plan added a function that populates `BoardUUID` and `BoardColor` on a file record after resolving its board number against `boards.db`. Find it:

```bash
cd src/backend && grep -rn "BoardColor\b" databank/
```

In the assignment block (e.g. `rec.BoardColor = match.Color`), add immediately after:

```go
rec.BoardColorHex = match.ColorHex
```

- [ ] **Step 5: Build the backend**

Run:

```bash
cd src/backend && go build ./...
```

Expected: clean build. If you see "wrong number of arguments to Scan", a SELECT got the new column but its Scan didn't get the new arg.

- [ ] **Step 6: Run databank tests**

Run:

```bash
cd src/backend && go test ./databank/... -v 2>&1 | tail -30
```

Expected: all pass.

---

### Task 5: Rebuild `boards.db`, re-resolve files, verify end-to-end

**Files:**
- Regenerate: `Board Database/boards.db`
- Trigger: a databank scan to re-resolve files and populate the new column

- [ ] **Step 1: Rebuild boards.db**

Run:

```bash
rm -f "Board Database/boards.db" "Board Database/boards.db-shm" "Board Database/boards.db-wal"
sqlite3 "Board Database/boards.db" < "Board Database/create_mockup_db.sql"
sqlite3 "Board Database/boards.db" < "Board Database/build_full_db.sql"
```

Expected: no errors.

- [ ] **Step 2: Verify the colors hex seed**

Run:

```bash
sqlite3 -header -column "Board Database/boards.db" "SELECT id, name, hex FROM colors ORDER BY id;"
```

Expected: 12 rows with hex values matching Task 1 Step 2 (e.g., `1  black  #1a1a1a`).

- [ ] **Step 3: Smoke-test the resolver with hex output**

Run:

```bash
cd src/backend && cat > /tmp/themes_smoke.go <<'EOF'
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
go run /tmp/themes_smoke.go
rm /tmp/themes_smoke.go
```

Expected: each result includes `"color_hex"` either populated (when the row has a `color_id`) or absent (when `color_id` is NULL — the boards.db v1 plan ships every row with NULL color_id, so all `color_hex` values will be absent at this point — that's fine).

- [ ] **Step 4: Manually populate one row's color_id for end-to-end verification**

Run:

```bash
# Pick the first Apple 820-* row, set its color_id to 1 (black)
sqlite3 "Board Database/boards.db" "UPDATE boards SET color_id = 1 WHERE board_number = '820-00165';"
sqlite3 "Board Database/boards.db" "SELECT board_number, color_id FROM boards WHERE board_number = '820-00165';"
```

Expected: `820-00165|1`.

- [ ] **Step 5: Re-run smoke test — Apple board now has color_hex**

Run:

```bash
cd src/backend && cat > /tmp/themes_smoke.go <<'EOF'
package main

import (
	"encoding/json"
	"fmt"

	"boardripper/boarddb"
)

func main() {
	db := boarddb.Open("../../Board Database/boards.db")
	defer db.Close()
	m := db.Resolve("820-00165")
	out, _ := json.MarshalIndent(m, "", "  ")
	fmt.Println(string(out))
}
EOF
go run /tmp/themes_smoke.go
rm /tmp/themes_smoke.go
```

Expected: JSON includes `"color": "black"` and `"color_hex": "#1a1a1a"`.

- [ ] **Step 6: Revert the manual color_id (keep the DB clean for commit)**

Run:

```bash
sqlite3 "Board Database/boards.db" "UPDATE boards SET color_id = NULL WHERE board_number = '820-00165';"
```

- [ ] **Step 7: Commit Phase 1**

```bash
git add "Board Database/boards.db" src/backend/databank/db.go
# Track sidecars only if they exist in git
git ls-files "Board Database/boards.db-shm" 2>/dev/null && git add "Board Database/boards.db-shm"
git ls-files "Board Database/boards.db-wal" 2>/dev/null && git add "Board Database/boards.db-wal"
git commit -m "$(cat <<'EOF'
feat(databank): denormalize board_color_hex through file cache

migrateV7 adds files.board_color_hex (TEXT, nullable). FileRecord
exposes BoardColorHex; INSERT/SELECT statements and the resolver
write-back path propagate it from BoardMatch.ColorHex. Frontend
reads it via DatabankFile to apply per-board fill colors.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 2: Frontend theme store + DatabankFile extension

### Task 6: Add `board_color_hex` to `DatabankFile`

**Files:**
- Modify: `src/frontend/src/store/databank-store.ts` (DatabankFile interface)

- [ ] **Step 1: Add the field to the interface**

In `src/frontend/src/store/databank-store.ts`, find the `DatabankFile` interface (~line 12). The boards.db plan already added `board_color`. Add `board_color_hex` immediately after it:

```ts
export interface DatabankFile {
  // ... existing fields ...
  board_color: string;
  board_color_hex: string;
  // ... remaining fields ...
}
```

(The exact `;` vs `,` and surrounding fields depend on what the boards.db plan produced — match the surrounding style.)

- [ ] **Step 2: TypeScript build check**

Run:

```bash
cd src/frontend && npx tsc -b --noEmit 2>&1 | tail -20
```

Expected: no new errors. The new field is optional in JSON (`omitempty`) so the runtime payload will sometimes be missing it; TypeScript treats it as a required `string` because we declared it that way and the deserializer (`fetch().then(r => r.json())`) returns `any`. This matches the existing pattern for `board_color`.

- [ ] **Step 3: Commit**

```bash
git add src/frontend/src/store/databank-store.ts
git commit -m "$(cat <<'EOF'
feat(store): expose board_color_hex on DatabankFile

Mirrors the new files.board_color_hex column in the databank cache.
Consumed by the renderer for theme-driven per-board fill colors.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Create the `themes.ts` store

**Files:**
- Create: `src/frontend/src/store/themes.ts`

- [ ] **Step 1: Write the file**

Create `src/frontend/src/store/themes.ts` with:

```ts
import { Emitter } from './emitter';
import { log } from './log-store';

/**
 * A theme bundles every color that's currently configurable across the app —
 * UI chrome (CSS custom properties), board canvas (PixiJS scene constants),
 * and selection accents. Two presets ship in v1; adding a third is one entry.
 */
export interface Theme {
  id: string;
  label: string;

  /** UI chrome — drives CSS custom properties on document.documentElement. */
  ui: {
    bgPrimary: string;
    bgSecondary: string;
    bgTertiary: string;
    textPrimary: string;
    textSecondary: string;
    accent: string;
    border: string;
  };

  /** Board canvas — drives PixiJS scene constants via BOARD_COLORS getter. */
  board: {
    canvasBackground: string;
    boardFill: string;
    selection: string;
    butterflySelection: string;
    labelText: string;
  };
}

export const THEMES: Record<string, Theme> = {
  default: {
    id: 'default',
    label: 'BoardRipper Default',
    ui: {
      bgPrimary:     '#0f0f1a',
      bgSecondary:   '#1a1a2e',
      bgTertiary:    '#16213e',
      textPrimary:   '#e0e0e0',
      textSecondary: '#a0a0b0',
      accent:        '#4a9eff',
      border:        '#2a2a40',
    },
    board: {
      canvasBackground:   '#1a1a2e',
      boardFill:          '#ffffff',
      selection:          '#ffff44',
      butterflySelection: '#44aaff',
      labelText:          '#ffffff',
    },
  },
  landrex: {
    id: 'landrex',
    label: 'Landrex Classic',
    ui: {
      bgPrimary:     '#000000',
      bgSecondary:   '#0a0a0a',
      bgTertiary:    '#141414',
      textPrimary:   '#ffffff',
      textSecondary: '#b0b0b0',
      accent:        '#ffff44',
      border:        '#262626',
    },
    board: {
      canvasBackground:   '#000000',
      boardFill:          '#ffffff',
      selection:          '#ffff44',
      butterflySelection: '#44aaff',
      labelText:          '#ffffff',
    },
  },
};

const STORAGE_KEY = 'boardripper-theme';
const DEFAULT_ID = 'default';

interface PersistedTheme {
  activeId: string;
}

function loadFromStorage(): string {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_ID;
    const parsed = JSON.parse(raw) as PersistedTheme;
    if (parsed?.activeId && THEMES[parsed.activeId]) return parsed.activeId;
    log.ui.warn(`themes: unknown activeId in localStorage: ${parsed?.activeId} — falling back to '${DEFAULT_ID}'`);
    return DEFAULT_ID;
  } catch {
    return DEFAULT_ID;
  }
}

function saveToStorage(activeId: string) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ activeId } as PersistedTheme));
  } catch { /* quota — ignore */ }
}

/** Apply a theme's `ui.*` colors to CSS custom properties on <html>. */
export function applyThemeToDOM(theme: Theme) {
  const root = document.documentElement;
  root.style.setProperty('--bg-primary',     theme.ui.bgPrimary);
  root.style.setProperty('--bg-secondary',   theme.ui.bgSecondary);
  root.style.setProperty('--bg-tertiary',    theme.ui.bgTertiary);
  root.style.setProperty('--text-primary',   theme.ui.textPrimary);
  root.style.setProperty('--text-secondary', theme.ui.textSecondary);
  root.style.setProperty('--accent',         theme.ui.accent);
  root.style.setProperty('--border',         theme.ui.border);
  root.style.setProperty('--canvas-bg',      theme.board.canvasBackground);
}

/** Convert '#rrggbb' to a 24-bit integer for PixiJS color arguments. */
export function hexToInt(hex: string): number {
  return parseInt(hex.slice(1), 16);
}

class ThemeStore extends Emitter {
  private _activeId: string = DEFAULT_ID;
  private _initialized = false;

  /** Call once at app startup. Safe to call multiple times — second call no-ops. */
  init(): void {
    if (this._initialized) return;
    this._activeId = loadFromStorage();
    applyThemeToDOM(this.activeTheme());
    this._initialized = true;
  }

  get activeId(): string {
    return this._activeId;
  }

  activeTheme(): Theme {
    return THEMES[this._activeId] ?? THEMES[DEFAULT_ID];
  }

  setTheme(id: string): void {
    if (!THEMES[id]) {
      log.ui.warn(`themes: setTheme called with unknown id '${id}' — ignored`);
      return;
    }
    if (id === this._activeId) return;
    this._activeId = id;
    saveToStorage(id);
    applyThemeToDOM(this.activeTheme());
    this.notify();
  }

  /** All available themes, sorted by label for UI display. */
  list(): Theme[] {
    return Object.values(THEMES).sort((a, b) => a.label.localeCompare(b.label));
  }
}

export const themeStore = new ThemeStore();
```

- [ ] **Step 2: TypeScript build**

Run:

```bash
cd src/frontend && npx tsc -b --noEmit 2>&1 | tail
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/frontend/src/store/themes.ts
git commit -m "$(cat <<'EOF'
feat(store): add themeStore with two presets (Default, Landrex)

Holds the active theme id, persists to localStorage, applies ui.*
colors as CSS custom properties on <html>. Board renderer subscribes
in a follow-up commit. THEMES registry is open-ended — adding a
third preset is one record entry.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Wire `--canvas-bg` in CSS + initialize themeStore in App

**Files:**
- Modify: `src/frontend/src/index.css` (add `--canvas-bg`, switch `body`/`#root` background)
- Modify: `src/frontend/src/App.tsx` (call `themeStore.init()` early)

- [ ] **Step 1: Add `--canvas-bg` to the `:root` block**

In `src/frontend/src/index.css`, find the `:root { ... }` block at lines 1–16. Add `--canvas-bg: #1a1a2e;` immediately after the existing `--bg-tertiary` line:

```css
:root {
  --bg-primary: #0f0f1a;
  --bg-secondary: #1a1a2e;
  --bg-tertiary: #16213e;
  --canvas-bg: #1a1a2e;
  --text-primary: #e0e0e0;
  --text-secondary: #a0a0b0;
  --accent: #4a9eff;
  --accent-hover: #6bb3ff;
  --green: #44cc44;
  --red: #cc4444;
  --orange: #ffaa00;
  --yellow: #ffff44;
  --border: #2a2a40;
  --toolbar-height: 40px;
  --statusbar-height: 24px;
}
```

- [ ] **Step 2: Switch the body/#root background to `--canvas-bg`**

In the same file, find the `html, body, #root { ... }` block (lines 24–32). Replace:

```css
  background: var(--bg-primary);
```

with:

```css
  background: var(--canvas-bg);
```

This means the page area surrounding the PixiJS canvas matches the canvas's own background — no contrast flash during scene rebuilds.

- [ ] **Step 3: Initialize themeStore at App startup**

Open `src/frontend/src/App.tsx`. Find the imports at the top and add:

```ts
import { themeStore } from './store/themes';
```

Find the body of the `App` component function. Add as the very first statement inside the function body (before any hooks or JSX):

```tsx
themeStore.init();
```

This runs synchronously on every render but `init()` is idempotent after the first call (the `_initialized` flag guards it). Calling it inline (rather than in a `useEffect`) ensures the saved theme's CSS variables are applied **before** React commits the first render — no flash of unthemed content.

- [ ] **Step 4: Build the frontend**

Run:

```bash
cd src/frontend && npx tsc -b --noEmit 2>&1 | tail
cd src/frontend && npx vite build 2>&1 | tail
```

Expected: clean build.

- [ ] **Step 5: Smoke-test in dev mode**

Run:

```bash
cd src/frontend && npm run dev &
DEV_PID=$!
sleep 3
echo "Open http://localhost:8082 — confirm UI looks identical to before. Press Enter to stop."
read
kill $DEV_PID
```

Expected: app loads with current colors. Open browser DevTools → check `document.documentElement.style.getPropertyValue('--canvas-bg')` returns `#1a1a2e`.

- [ ] **Step 6: Commit**

```bash
git add src/frontend/src/index.css src/frontend/src/App.tsx
git commit -m "$(cat <<'EOF'
feat(theme): wire themeStore.init() at App startup + --canvas-bg var

Applies the saved theme's CSS variables before first render (no
flash). New --canvas-bg var lets body and #root track the canvas
background so scene rebuilds don't show a contrast flash through
the canvas frame.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 3: PixiJS canvas wiring

### Task 9: Convert `BOARD_COLORS` to a theme-driven getter object

**Files:**
- Modify: `src/frontend/src/renderer/board-scene.ts:40-52` (the existing `BOARD_COLORS` const)

- [ ] **Step 1: Locate the current BOARD_COLORS definition**

Run:

```bash
grep -n "BOARD_COLORS\|^export const COLORS\|netHighlight\|labelPin" src/frontend/src/renderer/board-scene.ts | head -20
```

Note the line range of the current `BOARD_COLORS` const definition (~lines 40–52 per the spec). Confirm the exact key names.

- [ ] **Step 2: Replace BOARD_COLORS with a getter object**

In `src/frontend/src/renderer/board-scene.ts`, add the import at the top:

```ts
import { themeStore, hexToInt } from '../store/themes';
```

Then replace the existing `export const BOARD_COLORS = { ... };` block with:

```ts
/**
 * Themed color constants used throughout the renderer. Each property is a
 * getter that reads from the active theme — switching themes is reflected
 * on the next read (next scene rebuild). Static color literals (e.g. shadow
 * black, drill black, debug overlay red) stay as raw 0xRRGGBB constants.
 */
export const BOARD_COLORS = {
  get background() { return hexToInt(themeStore.activeTheme().board.canvasBackground); },
  get netHighlight() { return hexToInt(themeStore.activeTheme().board.selection); },
  get labelPin() { return hexToInt(themeStore.activeTheme().board.labelText); },
  get boardFillDefault() { return hexToInt(themeStore.activeTheme().board.boardFill); },
  get butterflySelection() { return hexToInt(themeStore.activeTheme().board.butterflySelection); },
  // Existing non-themed entries stay as plain numeric constants.
  // (If your tree has more entries — outline, gridDark, etc. — leave them
  //  as-is unless they map to a theme slot.)
  outline: 0x666688,
};
```

If the current BOARD_COLORS has additional entries (e.g. `outline`, `gridDark`), preserve them as plain numeric constants — only the entries listed in the spec table become getters. Run `grep -A 15 "export const BOARD_COLORS" src/frontend/src/renderer/board-scene.ts.bak` (or use git diff) to confirm you preserved every original entry.

- [ ] **Step 3: Replace the hardcoded board-fill literal at line ~313**

In the same file, find the lines (~310–315):

```ts
  if (s.boardFillAlpha > 0) {
    gfx.fill({ color: 0xffffff, alpha: s.boardFillAlpha });
  }
```

Replace with:

```ts
  if (s.boardFillAlpha > 0) {
    gfx.fill({ color: BOARD_COLORS.boardFillDefault, alpha: s.boardFillAlpha });
  }
```

(Task 13 will replace `BOARD_COLORS.boardFillDefault` with a per-board resolver call.)

- [ ] **Step 4: Replace label-text literals in board-scene.ts**

Find both occurrences of `fill: 0xffffff` in `board-scene.ts` that draw label text:

```bash
grep -n "fill: 0xffffff" src/frontend/src/renderer/board-scene.ts
```

For each — confirm by reading the surrounding 5 lines that it's a label or selection draw, not the board fill (which we already changed) — replace `0xffffff` with `BOARD_COLORS.labelPin`.

- [ ] **Step 5: TypeScript build**

Run:

```bash
cd src/frontend && npx tsc -b --noEmit 2>&1 | tail -20
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/frontend/src/renderer/board-scene.ts
git commit -m "$(cat <<'EOF'
refactor(renderer): drive BOARD_COLORS from active theme

Convert the BOARD_COLORS const to a getter object that reads from
themeStore.activeTheme().board on each access. Replaces hardcoded
0xffffff board-fill and label-text literals with theme references.
Scene rebuilds pick up the new colors automatically.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Replace remaining hardcoded literals in `BoardRenderer.ts`

**Files:**
- Modify: `src/frontend/src/renderer/BoardRenderer.ts` (literals at multiple line numbers)

- [ ] **Step 1: Locate all theme-affected literals**

Run:

```bash
grep -n "0x44aaff\|0xffff44\|fill: 0xffffff\|color: 0xffffff" src/frontend/src/renderer/BoardRenderer.ts
```

Expected matches (line numbers approximate — actual file may have shifted):
- `~716` `const labelStyle = { fontSize: 12, fill: 0xffffff, ... }` — debug labels
- `~840` `const labelStyle = { fontSize: 12, fill: 0xffffff, ... }` — debug labels
- `~2353` `style: { fontSize: srcFontSize, fill: 0xffffff, ... }` — net source label
- `~2483` `gfx.fill({ color: 0xffffff, alpha: s.selectionFillAlpha * 0.5 })` — butterfly selection fill
- `~2484` `gfx.stroke({ width: ..., color: 0x44aaff, alpha: 0.5 })` — butterfly selection stroke
- `~2488` `gfx.fill({ color: 0xffffff, alpha: s.selectionFillAlpha * 0.5 })` — butterfly selection fill
- `~2489` `gfx.stroke({ width: ..., color: 0x44aaff, alpha: 0.5 })` — butterfly selection stroke
- `~2504` `gfx.fill({ color: 0xffffff, alpha: s.selectionFillAlpha })` — selection fill
- `~2645/2650` `gfx.fill({ color: 0xffffff, alpha: s.selectionFillAlpha })` — selection fill
- `~3284` `gfx.stroke({ width: ..., color: ghostColor, ... })` — already a variable, leave alone

(Your file may have additional matches; treat the grep output as authoritative.)

- [ ] **Step 2: Replace butterfly selection strokes**

For each `color: 0x44aaff` occurrence, replace with `color: BOARD_COLORS.butterflySelection`. Verify the import at the top of `BoardRenderer.ts` (line ~25) already includes `BOARD_COLORS` — it does per the existing grep output.

- [ ] **Step 3: Replace label-text fills**

For every `fill: 0xffffff` occurrence in a `Text(...)` style or BitmapText style, replace with `fill: BOARD_COLORS.labelPin`.

- [ ] **Step 4: Replace selection fills**

For every `gfx.fill({ color: 0xffffff, alpha: s.selectionFillAlpha ... })` occurrence (selection or butterfly selection fill), replace `0xffffff` with `BOARD_COLORS.labelPin`.

(Selection fill is technically the highlight overlay color; on Default it's white. On Landrex it's still white. Both themes keep this as `labelText` since the same surface color makes sense for "selected" overlays. If a future theme wants a different selection fill color, add a `selectionFill` field to the theme.)

- [ ] **Step 5: Verify no theme-relevant literals remain**

Run:

```bash
grep -n "0x44aaff\|color: 0xffffff" src/frontend/src/renderer/BoardRenderer.ts
```

Expected: empty output (or only matches inside string literals / comments — visually inspect any remaining lines).

- [ ] **Step 6: TypeScript build**

Run:

```bash
cd src/frontend && npx tsc -b --noEmit 2>&1 | tail
```

Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/frontend/src/renderer/BoardRenderer.ts
git commit -m "$(cat <<'EOF'
refactor(renderer): replace hardcoded color literals with BOARD_COLORS

Selection fill (0xffffff), butterfly selection stroke (0x44aaff),
and net-source/debug label text fills all flow through the themed
BOARD_COLORS getter. No visual change on Default theme; Landrex
will pick up white labels on a black background automatically.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: BoardRenderer subscribes to themeStore + live background swap

**Files:**
- Modify: `src/frontend/src/renderer/BoardRenderer.ts` (subscription + onSettingsUpdate hook + dispose)

- [ ] **Step 1: Add the import**

In `src/frontend/src/renderer/BoardRenderer.ts`, add to the imports near the top:

```ts
import { themeStore } from '../store/themes';
```

- [ ] **Step 2: Locate the existing `unsubscribeSettings` field + subscription**

Run:

```bash
grep -n "unsubscribeSettings\|renderSettingsStore.subscribe\|onSettingsUpdate" src/frontend/src/renderer/BoardRenderer.ts
```

Note the field declaration line (~where `unsubscribeSettings` is declared) and the subscribe call line (~909 per earlier grep).

- [ ] **Step 3: Add an `unsubscribeTheme` field and theme subscription**

Find the field declaration `private unsubscribeSettings...` and add immediately after:

```ts
  private unsubscribeTheme: (() => void) | null = null;
```

Find the existing subscription `this.unsubscribeSettings = renderSettingsStore.subscribe(() => this.onSettingsUpdate());` and add immediately after:

```ts
    this.unsubscribeTheme = themeStore.subscribe(() => this.onThemeUpdate());
```

- [ ] **Step 4: Add the `onThemeUpdate` method**

Add a new method on the `BoardRenderer` class (place it near `onSettingsUpdate`):

```ts
  /**
   * Theme switched — swap the live PixiJS background color and trigger a full
   * scene rebuild so getter-driven colors (BOARD_COLORS) take effect.
   */
  private onThemeUpdate(): void {
    if (this.app && this.app.renderer) {
      this.app.renderer.background.color = themeStore.activeTheme().board.canvasBackground;
    }
    // Re-run the same code path as a settings change — drops the cached scene
    // and rebuilds with the new BOARD_COLORS values on next activate.
    this.onSettingsUpdate();
  }
```

- [ ] **Step 5: Confirm Application init reads through the themed background getter**

Run:

```bash
grep -n "background: BOARD_COLORS.background\|background: COLORS.background\|background: 0x" src/frontend/src/renderer/BoardRenderer.ts
```

Expected: two matches at ~lines 667 and 776, both passing either `background: COLORS.background` (the local alias) or `background: BOARD_COLORS.background` to the PixiJS `Application` init. Both forms work — `COLORS` is aliased to `BOARD_COLORS` near line 32 of `BoardRenderer.ts`, so the read goes through the same theme-driven getter we set up in Task 9. No edit needed unless either match shows a bare hex literal (e.g. `background: 0x1a1a2e`); if so, change it to `COLORS.background`.

- [ ] **Step 6: Add cleanup to the dispose path**

Find the `dispose` method (or `teardownForReinit` — whichever clears `unsubscribeSettings`):

```bash
grep -n "this.unsubscribeSettings()" src/frontend/src/renderer/BoardRenderer.ts
```

For each call to `this.unsubscribeSettings?.()` or `if (this.unsubscribeSettings) { this.unsubscribeSettings(); ... }`, add an analogous block immediately after for `unsubscribeTheme`:

```ts
    if (this.unsubscribeTheme) {
      this.unsubscribeTheme();
      this.unsubscribeTheme = null;
    }
```

- [ ] **Step 7: TypeScript build**

Run:

```bash
cd src/frontend && npx tsc -b --noEmit 2>&1 | tail
```

Expected: clean.

- [ ] **Step 8: Smoke-test theme switching**

Start the dev server:

```bash
cd src/frontend && npm run dev &
DEV_PID=$!
sleep 3
```

Open http://localhost:8082, open DevTools console, run:

```js
import('/src/store/themes.ts').then(m => m.themeStore.setTheme('landrex'))
```

Expected: UI panels turn black (CSS vars updated) and the canvas background turns black (PixiJS background updated). Selection (click any component) is still yellow. Run `themeStore.setTheme('default')` to revert.

Stop the dev server:

```bash
kill $DEV_PID
```

- [ ] **Step 9: Commit**

```bash
git add src/frontend/src/renderer/BoardRenderer.ts
git commit -m "$(cat <<'EOF'
feat(renderer): subscribe to themeStore + live canvas background swap

Theme switches trigger a scene rebuild (same code path as settings
changes) and an in-place app.renderer.background.color update. No
app.destroy() — see CLAUDE.md PixiJS v8 batchPool safety rule.
Subscription cleanup mirrors the existing settings unsubscribe.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 4: Metadata color toggle

### Task 12: Add `useMetadataBoardColor` flag to render-settings DEFAULTS

**Files:**
- Modify: `src/frontend/src/store/render-settings.ts` (RenderSettings interface, DEFAULTS)

- [ ] **Step 1: Add to the RenderSettings interface**

In `src/frontend/src/store/render-settings.ts`, find the `RenderSettings` interface. Locate the `boardFillAlpha: number;` line (~line 100) and add immediately after:

```ts
  /** When true, board fill uses the matched colors.hex value instead of the
   *  theme default. Falls back to theme default when no metadata color is set. */
  useMetadataBoardColor: boolean;
```

- [ ] **Step 2: Add to DEFAULTS**

Find `export const DEFAULTS: RenderSettings = { ... }`. Find the `boardFillAlpha: 0.08,` line (~line 263) and add immediately after:

```ts
  useMetadataBoardColor: false,
```

- [ ] **Step 3: TypeScript build**

Run:

```bash
cd src/frontend && npx tsc -b --noEmit 2>&1 | tail
```

Expected: clean. The `loadFromStorage` merge-over-DEFAULTS pattern handles existing localStorage payloads gracefully — absent key → `false`.

- [ ] **Step 4: Commit**

```bash
git add src/frontend/src/store/render-settings.ts
git commit -m "$(cat <<'EOF'
feat(settings): add useMetadataBoardColor flag (default off)

Composes with boardFillAlpha to render the per-board substrate color
when the resolver match has a populated colors.hex. Wired into the
renderer in the next commit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: Implement `resolveBoardFillColor` and thread through scene builder

**Files:**
- Modify: `src/frontend/src/renderer/board-scene.ts` (add helper + change `drawOutline` signature)
- Modify: `src/frontend/src/renderer/BoardRenderer.ts` (pass active board's color_hex to drawOutline)

- [ ] **Step 1: Add the resolver helper to board-scene.ts**

In `src/frontend/src/renderer/board-scene.ts`, add this exported helper near the top of the file (just below the imports + `BOARD_COLORS` definition):

```ts
/**
 * Pick the effective board fill color for the current draw.
 * Returns metadata hex when (a) `useMetadata` is true AND (b) the board has a
 * non-empty hex string. Otherwise returns the theme's default board fill.
 */
export function resolveBoardFillColor(
  metadataHex: string | undefined,
  useMetadata: boolean,
): number {
  if (useMetadata && metadataHex) {
    return hexToInt(metadataHex);
  }
  return BOARD_COLORS.boardFillDefault;
}
```

- [ ] **Step 2: Find the drawOutline function and its call site**

Run:

```bash
grep -n "export function drawOutline\b\|drawOutline(" src/frontend/src/renderer/board-scene.ts src/frontend/src/renderer/BoardRenderer.ts
```

Note the function signature (currently around line 250 of board-scene.ts — verify) and its call site in BoardRenderer.ts.

- [ ] **Step 3: Extend drawOutline to accept the metadata hex**

In `src/frontend/src/renderer/board-scene.ts`, find the `drawOutline` function. Its current signature is something like:

```ts
export function drawOutline(gfx: Graphics, board: BoardData, s: RenderSettings): void {
```

Change to:

```ts
export function drawOutline(gfx: Graphics, board: BoardData, s: RenderSettings, metadataHex?: string): void {
```

Find the line we touched in Task 9 Step 3:

```ts
  if (s.boardFillAlpha > 0) {
    gfx.fill({ color: BOARD_COLORS.boardFillDefault, alpha: s.boardFillAlpha });
  }
```

Replace with:

```ts
  if (s.boardFillAlpha > 0) {
    gfx.fill({
      color: resolveBoardFillColor(metadataHex, s.useMetadataBoardColor),
      alpha: s.boardFillAlpha,
    });
  }
```

- [ ] **Step 4: Pass metadata hex from BoardRenderer**

The renderer needs to look up the active file's `board_color_hex` from the databank store. In `src/frontend/src/renderer/BoardRenderer.ts`, add to the imports:

```ts
import { databankStore } from '../store/databank-store';
```

Find every call to `drawOutline(...)`. Run:

```bash
grep -n "drawOutline(" src/frontend/src/renderer/BoardRenderer.ts
```

For each call, the renderer knows the active file via `boardStore.activeFile()` or similar. Add a helper method on `BoardRenderer` (place it near `buildScene`):

```ts
  /**
   * Look up the metadata color hex for the currently-active file from the
   * databank store. Returns undefined when there is no active file or no
   * resolver match for it.
   */
  private activeBoardColorHex(): string | undefined {
    const fileName = renderSettingsStore.activeBoard;  // active file basename
    if (!fileName) return undefined;
    const file = databankStore.getFileByName(fileName);
    return file?.board_color_hex || undefined;
  }
```

If `databankStore` does not expose `getFileByName`, add it — find an existing accessor like `getFileById` (search with `grep -n "getFileById\|getFile(" src/frontend/src/store/databank-store.ts`). Add an analogous getter:

```ts
  getFileByName(name: string): DatabankFile | undefined {
    for (const f of this._files.values()) {
      if (f.filename === name) return f;
    }
    return undefined;
  }
```

(Adapt the field/Map name to what the store actually uses — the existing `getFileById` should reveal the pattern.)

- [ ] **Step 5: Update each `drawOutline` call site to pass the hex**

For every `drawOutline(gfx, board, settings)` call in `BoardRenderer.ts`, change to:

```ts
drawOutline(gfx, board, settings, this.activeBoardColorHex());
```

- [ ] **Step 6: Trigger a rebuild when `useMetadataBoardColor` changes**

The existing `onSettingsUpdate` already rebuilds the scene on any settings change, so flipping `useMetadataBoardColor` will work automatically. No extra wiring needed.

But — the active file's `board_color_hex` may change after a fresh databank scan. The renderer doesn't currently subscribe to `databankStore`. Skip this case for v1; the user can flip the toggle off and back on (or reload the file) to refresh. Document as a known caveat in the spec's "Edge cases" section if not already there (it isn't — leave for follow-up).

- [ ] **Step 7: TypeScript build**

Run:

```bash
cd src/frontend && npx tsc -b --noEmit 2>&1 | tail
```

Expected: clean. If you see "Property 'getFileByName' does not exist", you skipped Task 13 Step 4's getter addition.

- [ ] **Step 8: Commit**

```bash
git add src/frontend/src/renderer/board-scene.ts src/frontend/src/renderer/BoardRenderer.ts src/frontend/src/store/databank-store.ts
git commit -m "$(cat <<'EOF'
feat(renderer): resolveBoardFillColor + per-board metadata fill

drawOutline takes an optional metadata-hex string and picks between
the theme default and the per-board hex via resolveBoardFillColor.
BoardRenderer looks up the active file's board_color_hex from the
databank store via a new getFileByName accessor.

When useMetadataBoardColor is off (default) or the board has no
hex, behavior is identical to before — theme-default fill at the
configured alpha. When on and the board has a hex, the color
becomes the substrate tint (e.g. faint green for Lenovo).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 5: SettingsPanel tabs refactor

### Task 14: Add tab strip + content router to SettingsPanel

**Files:**
- Modify: `src/frontend/src/panels/SettingsPanel.tsx` (orchestrator only — section components stay untouched)
- Modify: `src/frontend/src/index.css` (reuse existing `.library-tab*` classes, add aliases)

- [ ] **Step 1: Add the SettingsTabId type and constants**

In `src/frontend/src/panels/SettingsPanel.tsx`, add near the top (just below the existing `type SectionId = ...` line at ~line 37):

```ts
export type SettingsTabId = 'theme' | 'board' | 'input' | 'system';

const TAB_ORDER: SettingsTabId[] = ['theme', 'board', 'input', 'system'];

const TAB_LABELS: Record<SettingsTabId, string> = {
  theme:  'Theme',
  board:  'Board',
  input:  'Input',
  system: 'System',
};

/** Maps each section id to the tab that owns it. Used by focusSection. */
export const SECTION_TO_TAB: Record<SectionId, SettingsTabId> = {
  // Theme tab — no SectionId here yet (Task 16 adds the Theme section)
  // Board tab
  outline:           'board',
  parts:             'board',
  pins:              'board',
  partTypeOverrides: 'board',
  netColors:         'board',
  selection:         'board',
  netLines:          'board',
  // Input tab
  zoomLod:    'input',
  navigation: 'input',
  shortcuts:  'input',
  // System tab
  performance: 'system',
  pdf:         'system',
  server:      'system',
};

const ACTIVE_TAB_KEY = 'boardripper-settings-active-tab';

function loadActiveTab(): SettingsTabId {
  try {
    const raw = localStorage.getItem(ACTIVE_TAB_KEY);
    if (raw && TAB_ORDER.includes(raw as SettingsTabId)) {
      return raw as SettingsTabId;
    }
  } catch { /* ignore */ }
  return 'board';
}

function saveActiveTab(id: SettingsTabId) {
  try {
    localStorage.setItem(ACTIVE_TAB_KEY, id);
  } catch { /* ignore */ }
}

function openSectionsKey(tab: SettingsTabId): string {
  return `boardripper-settings-open-sections-${tab}`;
}

function loadOpenSections(tab: SettingsTabId): Set<SectionId> {
  try {
    const raw = localStorage.getItem(openSectionsKey(tab));
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as SectionId[];
    return new Set(parsed);
  } catch {
    return new Set();
  }
}

function saveOpenSections(tab: SettingsTabId, sections: Set<SectionId>) {
  try {
    localStorage.setItem(openSectionsKey(tab), JSON.stringify(Array.from(sections)));
  } catch { /* ignore */ }
}
```

- [ ] **Step 2: Replace the openSections + activeTab state**

In `src/frontend/src/panels/SettingsPanel.tsx`, find the line:

```tsx
const [openSections, setOpenSections] = useState<Set<SectionId>>(new Set(INITIALLY_OPEN));
```

(Currently around line 1115.) Replace with:

```tsx
const [activeTab, setActiveTabState] = useState<SettingsTabId>(() => loadActiveTab());
const [openSections, setOpenSections] = useState<Set<SectionId>>(() => loadOpenSections(loadActiveTab()));

// Persist openSections per-tab
useEffect(() => {
  saveOpenSections(activeTab, openSections);
}, [activeTab, openSections]);

// On tab switch, hydrate openSections from the new tab's persistence
const setActiveTab = useCallback((id: SettingsTabId) => {
  setActiveTabState(id);
  saveActiveTab(id);
  setOpenSections(loadOpenSections(id));
}, []);
```

`INITIALLY_OPEN` (the const at line ~1032 — currently `const INITIALLY_OPEN: SectionId[] = [];`) becomes dead code; delete it.

- [ ] **Step 3: Update `focusSection` to switch tabs first**

Find `focusSection` (around line 1149). Replace with:

```tsx
const focusSection = useCallback((id: SectionId) => {
  const targetTab = SECTION_TO_TAB[id];
  if (targetTab && targetTab !== activeTab) {
    setActiveTab(targetTab);
  }
  setOpenSections(prev => { const next = new Set(prev); next.add(id); return next; });
  requestAnimationFrame(() => {
    sectionRefsMapRef.current[id]?.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
  if (focusTimerRef.current) clearTimeout(focusTimerRef.current);
  setFocusedSection(id);
  focusTimerRef.current = setTimeout(() => setFocusedSection(null), 1400);
}, [activeTab, setActiveTab]);
```

- [ ] **Step 4: Add the tab strip JSX**

Find the return statement around line 1265 (`return (<div className="panel-content settings-panel" ...`). Just inside the outer div, immediately after `<CacheControlBar hasBoard={hasBoard} />`, insert:

```tsx
        {/* Tab strip — same visual pattern as LibraryPanel */}
        <div className="library-tabs-row settings-tabs-row">
          <div className="library-tabs">
            {TAB_ORDER.map(tab => (
              <button
                key={tab}
                type="button"
                className={`library-tab ${activeTab === tab ? 'active' : ''}`}
                onClick={() => setActiveTab(tab)}
              >
                {TAB_LABELS[tab]}
              </button>
            ))}
          </div>
        </div>
```

- [ ] **Step 5: Wrap each existing CollapsibleSection with a tab guard**

Find every `<CollapsibleSection id="..." title="..." ...>` block (lines ~1309 through ~1520). For each, wrap the rendering with a tab check. The simplest pattern: add a conditional render around each section. Example for the outline section:

```tsx
{activeTab === SECTION_TO_TAB.outline && (
  <CollapsibleSection id="outline" title="Board Outline" isOpen={openSections.has('outline')}
    onToggle={toggleSection} sectionRef={outlineRef} focused={focusedSection === 'outline'}>
    {/* ... existing children ... */}
  </CollapsibleSection>
)}
```

Wrap each of the 13 existing CollapsibleSection blocks similarly, using `SECTION_TO_TAB.<id>` as the tab key. Order them in the JSX in the order they should appear within the tab (the order shown in the spec's tab structure table).

This is repetitive but mechanical — work through them one-by-one. After all 13 are wrapped, run a quick check:

```bash
grep -c "<CollapsibleSection " src/frontend/src/panels/SettingsPanel.tsx
grep -c "activeTab === SECTION_TO_TAB" src/frontend/src/panels/SettingsPanel.tsx
```

Both numbers should equal 13. Mismatch means a section is missing its tab guard.

- [ ] **Step 6: Add a Theme tab placeholder content area**

Add near the top of the JSX section list (immediately before the first wrapped CollapsibleSection):

```tsx
{activeTab === 'theme' && (
  <ThemeTab />
)}
```

We'll define `ThemeTab` in Task 16. For now, add a temporary stub at the bottom of the file (right above `function formatSize(bytes: number)` if it exists, or at the end):

```tsx
function ThemeTab() {
  return <div style={{ padding: 16, color: 'var(--text-secondary)' }}>Theme tab — content added in Task 16.</div>;
}
```

- [ ] **Step 7: Add a small CSS tweak for the settings tabs row**

In `src/frontend/src/index.css`, append to the end of the file (or wherever settings-panel CSS lives — search with `grep -n "settings-panel" src/frontend/src/index.css`):

```css
/* Settings panel reuses LibraryPanel tab visuals; tighten the surrounding
 * spacing so it sits flush above CollapsibleSection content. */
.settings-tabs-row {
  margin-bottom: 4px;
}
```

- [ ] **Step 8: TypeScript + Vite build**

Run:

```bash
cd src/frontend && npx tsc -b --noEmit 2>&1 | tail
cd src/frontend && npx vite build 2>&1 | tail
```

Expected: clean. Any "JSX element type 'ThemeTab' has no construct" means the stub component isn't in scope where it's referenced — move it above its first use.

- [ ] **Step 9: Smoke-test in dev**

Run `npm run dev`, open the Settings panel, confirm:
- Four tabs visible: Theme, Board, Input, System.
- Defaults to Board on first open (clear localStorage to simulate fresh install: in DevTools console run `localStorage.removeItem('boardripper-settings-active-tab')`).
- Clicking each tab shows only that tab's sections.
- Section open/closed state persists across tab switches (open Outline in Board tab, switch to Input, switch back — Outline still open).
- Section open/closed state survives page reload.

- [ ] **Step 10: Commit**

```bash
git add src/frontend/src/panels/SettingsPanel.tsx src/frontend/src/index.css
git commit -m "$(cat <<'EOF'
refactor(settings): split panel into 4 tabs (Theme/Board/Input/System)

Reuses LibraryPanel's library-tab CSS for visual consistency. Per-tab
open-section persistence (boardripper-settings-open-sections-${tab}).
Active tab persisted to boardripper-settings-active-tab. focusSection
now switches tabs first, then scrolls — toolbar deep-links work.
Theme tab content lands in the next commit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 15: Build the Theme tab content

**Files:**
- Modify: `src/frontend/src/panels/SettingsPanel.tsx` (replace the ThemeTab stub)

- [ ] **Step 1: Add useThemeStore hook (small reactive wrapper)**

In `src/frontend/src/panels/SettingsPanel.tsx`, near the top (after the existing imports):

```ts
import { themeStore, THEMES, type Theme } from '../store/themes';
```

If the file already has a `useSyncExternalStore` import, keep it. Otherwise add:

```ts
import { useSyncExternalStore } from 'react';
```

Then add a small hook right above the `function ThemeTab()` stub:

```ts
function useThemeId(): string {
  return useSyncExternalStore(
    (cb) => themeStore.subscribe(cb),
    () => themeStore.activeId,
  );
}
```

- [ ] **Step 2: Replace the ThemeTab stub with real content**

Replace the `function ThemeTab()` stub from Task 14 Step 6 with:

```tsx
function ThemeTab() {
  const activeId = useThemeId();
  const themes: Theme[] = themeStore.list();

  // Wire useMetadataBoardColor through the existing draft/dirty machinery.
  // We read directly from renderSettingsStore (preview/cancel doesn't apply
  // to this single boolean — the toggle takes effect immediately).
  const useMetadata = useSyncExternalStore(
    (cb) => renderSettingsStore.subscribe(cb),
    () => renderSettingsStore.settings.useMetadataBoardColor,
  );

  const onToggleMetadata = (next: boolean) => {
    const current = renderSettingsStore.globalSnapshot();
    renderSettingsStore.applyGlobal({ ...current, useMetadataBoardColor: next });
  };

  return (
    <div className="settings-section-body" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 16 }}>

      <div>
        <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--text-secondary)', marginBottom: 6 }}>
          Theme
        </div>
        <div role="radiogroup" aria-label="Theme" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {themes.map(t => (
            <label key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 4, cursor: 'pointer', background: activeId === t.id ? 'var(--bg-secondary)' : 'transparent' }}>
              <input
                type="radio"
                name="theme-picker"
                value={t.id}
                checked={activeId === t.id}
                onChange={() => themeStore.setTheme(t.id)}
              />
              <span>{t.label}</span>
              <span style={{
                marginLeft: 'auto',
                width: 14, height: 14, borderRadius: 3,
                background: t.board.canvasBackground,
                border: `1px solid ${t.ui.border}`,
                boxShadow: `inset 0 0 0 1px ${t.board.boardFill}`,
              }} />
            </label>
          ))}
        </div>
      </div>

      <div>
        <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--text-secondary)', marginBottom: 6 }}>
          Board fill
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={useMetadata}
            onChange={(e) => onToggleMetadata(e.target.checked)}
          />
          <span>Use board metadata color</span>
        </label>
        <div style={{ fontSize: 11, color: 'var(--text-secondary)', padding: '0 8px', marginTop: 4 }}>
          When on, boards with a known PCB color (Apple → black, Dell → blue, etc.)
          render with that tint instead of the theme default. Boards without a
          metadata match silently fall back to the theme default. Adjust intensity
          with the Board Outline → Board Fill slider.
        </div>
      </div>

    </div>
  );
}
```

- [ ] **Step 3: Build**

Run:

```bash
cd src/frontend && npx tsc -b --noEmit 2>&1 | tail
```

Expected: clean. If you see "Cannot find name 'renderSettingsStore'", check the existing imports — it's likely already imported.

- [ ] **Step 4: Smoke-test the full theme flow**

Run `npm run dev`, open Settings → Theme tab. Confirm:
- Two radio buttons: BoardRipper Default (selected), Landrex Classic.
- Tiny color swatch on the right of each option (canvas bg + board fill inset).
- Click Landrex — entire UI turns black. Switch to Board tab — sections still readable on black.
- Open a board file. Selection ring is yellow on both themes. Canvas background matches.
- Tick "Use board metadata color". With no metadata-color-populated board open, no visual change (silent fallback).
- Manually populate `color_id = 1` on the open board's row in `boards.db`, restart backend, re-open the file. Board fill becomes a faint dark gray.
- Reload the page — theme persists, toggle persists.

- [ ] **Step 5: Commit**

```bash
git add src/frontend/src/panels/SettingsPanel.tsx
git commit -m "$(cat <<'EOF'
feat(settings): Theme tab — picker + metadata color toggle

Radio-list theme picker with a swatch preview (canvas bg + board fill
inset) for each theme. "Use board metadata color" checkbox writes
directly to renderSettingsStore.applyGlobal — takes effect on next
scene rebuild. Hint text guides the user to Board Outline → Board
Fill for intensity adjustment.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 6: LibraryPanel — PCB color indicator

### Task 16: Add the read-only PCB Color row to the metadata edit modal

**Files:**
- Modify: `src/frontend/src/panels/LibraryPanel.tsx:1264-1333` (MetadataEditModal)
- Modify: `src/frontend/src/index.css` (small styles for the indicator)

- [ ] **Step 1: Read the current modal**

Open `src/frontend/src/panels/LibraryPanel.tsx`, find the `MetadataEditModal` function (around line 1264). Note the current structure — title, filename, three input fields, action buttons.

- [ ] **Step 2: Add the PCB Color row above the input fields**

Find the line `<div className="library-modal-filename">{detail.filename}</div>`. Add immediately after:

```tsx
        <PcbColorRow detail={detail} />
```

- [ ] **Step 3: Define the PcbColorRow component**

Add this small component immediately above `MetadataEditModal`:

```tsx
function PcbColorRow({ detail }: { detail: FileDetail }) {
  const colorName = detail.board_color || '';
  const colorHex = detail.board_color_hex || '';

  let dotColor: string;
  let labelText: string;
  if (!colorName) {
    dotColor = '#666';
    labelText = '— (no resolver match)';
  } else if (!colorHex) {
    dotColor = '#666';
    labelText = `${colorName} (no hex yet)`;
  } else {
    dotColor = colorHex;
    labelText = `${colorName} (hex set)`;
  }

  return (
    <div className="library-modal-pcb-color">
      <span>PCB Color:</span>
      <span className="library-modal-pcb-color-dot" style={{ background: dotColor }} aria-hidden="true" />
      <span className="library-modal-pcb-color-text">{labelText}</span>
    </div>
  );
}
```

- [ ] **Step 4: Add the styles**

In `src/frontend/src/index.css`, find the existing `.library-modal-` rules (search with `grep -n "library-modal-filename" src/frontend/src/index.css`). Append after them:

```css
.library-modal-pcb-color {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.9em;
  color: var(--text-secondary);
  margin: 4px 0 12px 0;
  padding: 4px 0;
}
.library-modal-pcb-color-dot {
  width: 12px;
  height: 12px;
  border-radius: 2px;
  border: 1px solid var(--border);
  flex-shrink: 0;
}
.library-modal-pcb-color-text {
  font-family: monospace;
  font-size: 12px;
}
```

- [ ] **Step 5: TypeScript build**

Run:

```bash
cd src/frontend && npx tsc -b --noEmit 2>&1 | tail
```

Expected: clean. (If `FileDetail` doesn't include `board_color` / `board_color_hex`, the boards.db plan or Task 6 of this plan was incomplete — go back and fix.)

- [ ] **Step 6: Smoke-test the modal**

Run `npm run dev`, open the Library panel, click the edit (pencil) icon on a few files:
- File whose board has `color_id` populated AND hex non-NULL → row shows the hex-colored dot + "blue (hex set)".
- File whose board has `color_id` populated but hex is NULL (transitional) → row shows gray dot + "blue (no hex yet)". This shouldn't happen after Task 1 (all 12 colors have hex), but the state is reachable if a future color is added without hex.
- File with no resolver match → row shows gray dot + "— (no resolver match)".

- [ ] **Step 7: Commit**

```bash
git add src/frontend/src/panels/LibraryPanel.tsx src/frontend/src/index.css
git commit -m "$(cat <<'EOF'
feat(library): PCB Color indicator row in MetadataEditModal

Shows the resolver-derived color name + a hex-tinted dot (or gray
when hex isn't populated). Read-only — purely informational so the
user can tell whether "Use board metadata color" will affect this
particular board.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 7: Verification + Playwright smoke test

### Task 17: Add a Playwright theme-switch smoke test

**Files:**
- Create: `src/frontend/tests/themes-smoke.spec.ts`

- [ ] **Step 1: Write the spec**

Create `src/frontend/tests/themes-smoke.spec.ts`:

```ts
import { test, expect } from '@playwright/test';

test.describe('Themes', () => {
  test('default theme applies on first load', async ({ page }) => {
    // Clear any persisted theme so we get a fresh-install baseline.
    await page.addInitScript(() => {
      localStorage.removeItem('boardripper-theme');
    });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const bgPrimary = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--bg-primary').trim()
    );
    expect(bgPrimary).toBe('#0f0f1a');

    const canvasBg = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--canvas-bg').trim()
    );
    expect(canvasBg).toBe('#1a1a2e');
  });

  test('switching to Landrex Classic flips UI + canvas to black', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Programmatically switch the theme via the store (avoids depending on the
    // Settings panel UI structure which is allowed to evolve).
    await page.evaluate(async () => {
      const mod = await import('/src/store/themes.ts');
      mod.themeStore.setTheme('landrex');
    });

    // Allow one animation frame for the DOM update + scene rebuild.
    await page.waitForTimeout(100);

    const bgPrimary = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--bg-primary').trim()
    );
    expect(bgPrimary).toBe('#000000');

    const canvasBg = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--canvas-bg').trim()
    );
    expect(canvasBg).toBe('#000000');

    // Persistence: reload and confirm Landrex sticks.
    await page.reload();
    await page.waitForLoadState('networkidle');

    const bgAfterReload = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--bg-primary').trim()
    );
    expect(bgAfterReload).toBe('#000000');
  });

  test('Settings panel renders four tabs', async ({ page }) => {
    // Reset to default theme + clear active-tab so we land on the canonical Board tab.
    await page.addInitScript(() => {
      localStorage.removeItem('boardripper-theme');
      localStorage.removeItem('boardripper-settings-active-tab');
    });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Open Settings panel — the toolbar has a settings button. Find it by aria-label.
    // (If the selector breaks, update to whatever the Toolbar.tsx actually uses.)
    const settingsButton = page.getByRole('button', { name: /settings/i }).first();
    await settingsButton.click();

    // Wait for the panel to be present.
    const panel = page.locator('[data-testid="settings-panel"]');
    await expect(panel).toBeVisible();

    // Check all four tab labels are present in the panel's tab strip.
    const tabsRow = panel.locator('.settings-tabs-row, .library-tabs-row').first();
    await expect(tabsRow.getByText('Theme', { exact: true })).toBeVisible();
    await expect(tabsRow.getByText('Board', { exact: true })).toBeVisible();
    await expect(tabsRow.getByText('Input', { exact: true })).toBeVisible();
    await expect(tabsRow.getByText('System', { exact: true })).toBeVisible();
  });
});
```

- [ ] **Step 2: Run the smoke test**

The Playwright config typically requires the dev server running. Start it in one terminal:

```bash
cd src/frontend && npm run dev
```

In another terminal:

```bash
cd src/frontend && npx playwright test themes-smoke.spec.ts --reporter=list
```

Expected: all three tests pass. If the third (Settings panel renders four tabs) fails because the settings button selector doesn't match, update the selector — open `src/frontend/src/components/Toolbar.tsx` and find the settings button to read its actual `aria-label` or text.

- [ ] **Step 3: If tests pass, commit**

```bash
git add src/frontend/tests/themes-smoke.spec.ts
git commit -m "$(cat <<'EOF'
test(themes): Playwright smoke — default applies, Landrex flips, tabs render

Three end-to-end checks: (1) default theme's CSS vars present on
fresh load, (2) setTheme('landrex') flips both --bg-primary and
--canvas-bg to black and persists across reload, (3) Settings panel
shows Theme/Board/Input/System tabs.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 18: Manual end-to-end verification

**Files:**
- (no file changes — manual smoke pass against the running app)

- [ ] **Step 1: Fresh-install baseline**

Clear all themes-related localStorage keys in DevTools console:

```js
['boardripper-theme', 'boardripper-settings-active-tab']
  .concat(['theme','board','input','system'].map(t => `boardripper-settings-open-sections-${t}`))
  .forEach(k => localStorage.removeItem(k));
location.reload();
```

Confirm: UI looks identical to before this work (no visible regression). Open Settings → defaults to Board tab, no sections open.

- [ ] **Step 2: Theme switch + persistence**

Open Settings → Theme tab. Select Landrex Classic. Confirm:
- Toolbar, sidebar, panels turn black.
- Canvas background turns black.
- Open a board → board fill stays white, selection stays yellow.
- Tabs in Settings still navigable.

Reload the page. Confirm Landrex Classic is still active. Switch back to BoardRipper Default. Reload. Default sticks.

- [ ] **Step 3: Metadata color toggle**

In `boards.db`, manually populate one board's color (e.g., Apple 820-00165 → color_id=1=black):

```bash
sqlite3 "Board Database/boards.db" "UPDATE boards SET color_id = 1 WHERE board_number = '820-00165';"
```

Restart the backend (or re-trigger a databank scan to refresh `files.board_color_hex`). Open the Apple file. Toggle "Use board metadata color" on in the Theme tab. Confirm:
- Board fill becomes a faint dark gray (`#1a1a1a` at 0.08 alpha).
- Open a different file with no color match — board fill stays white (theme default).

Crank Settings → Board → Board Outline → Board Fill slider up to ~0.4. Confirm the gray on the Apple file becomes more visible.

Toggle "Use board metadata color" off. Confirm Apple board's fill returns to white.

Revert the manual color_id:

```bash
sqlite3 "Board Database/boards.db" "UPDATE boards SET color_id = NULL WHERE board_number = '820-00165';"
```

- [ ] **Step 4: Metadata editor indicator**

Open Library panel, find the Apple 820-00165 file. Click the pencil/edit icon. The PCB Color row should show:
- Before the manual UPDATE: `— (no resolver match)` (gray dot) since color_id reverted to NULL.
- (Re-run the UPDATE temporarily if you want to see "black (hex set)" with a dark dot.)

Confirm a file with no boards.db match (e.g., a generic test BVR) shows `— (no resolver match)`.

- [ ] **Step 5: Tab persistence + deep links**

Open Settings → Board tab. Open the "Part Types" section. Switch to Input tab. Switch back to Board. Part Types should still be open. Reload — still open.

Use the toolbar deep-link to Part Types (look for "Part Types" or similar button — search Toolbar.tsx for `focusSection('partTypeOverrides')`). Click it. Settings should switch to Board tab with Part Types expanded and scrolled into view.

- [ ] **Step 6: Multi-canvas theme sync**

If Dockview floating windows are available, drag the Board Viewer panel to a floating window. Switch theme. Both canvases should re-theme in lockstep.

- [ ] **Step 7: TypeScript + full Playwright suite**

Run:

```bash
cd src/frontend && npx tsc -b --noEmit 2>&1 | tail
cd src/frontend && npm run dev &
DEV_PID=$!
sleep 5
cd src/frontend && npx playwright test --reporter=list 2>&1 | tail -30
kill $DEV_PID
```

Expected: TypeScript clean, all existing Playwright tests still pass plus the new themes-smoke spec.

- [ ] **Step 8: If everything looks good, push**

```bash
git push
```

---

## Done — what you have

- `boards.db` ships with hex tints for all 12 colors. The resolver propagates `color_hex` end-to-end (Go → databank cache → frontend).
- A `themeStore` singleton owns the active theme, persists it, and writes CSS variables on switch.
- Two presets: BoardRipper Default (zero visual change) and Landrex Classic (black UI + canvas, white parts, yellow selection). Adding a third = one entry in `THEMES`.
- `BOARD_COLORS` is theme-driven; every previously-hardcoded color in the renderer now flows through it.
- A new `useMetadataBoardColor` toggle composes with the existing `boardFillAlpha` slider to render per-board substrate tints.
- `SettingsPanel` is reorganized into four tabs (Theme / Board / Input / System) with per-tab persistence; the new Theme tab houses the picker + metadata-color toggle.
- The metadata edit modal in LibraryPanel shows a read-only PCB color indicator so the user can tell at a glance whether the toggle will affect a given board.
- A small Playwright smoke spec verifies CSS-var application, theme switch + persistence, and tab rendering.
