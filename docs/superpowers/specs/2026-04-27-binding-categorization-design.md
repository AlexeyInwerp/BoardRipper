# Binding categorization & auto-open filter

**Date:** 2026-04-27
**Scope:** `bindings` table schema, backend handlers, `databank-store`, `LibraryPanel.FileDetailPane`.

## Goal

Today, every binding on a board file is auto-opened when the user opens the board (when `autoPdf` is on). This conflates two kinds of documents:

- **Schematics** — the board's service manual / repair schematic. The user wants this to open with the board.
- **Datasheets / other reference material** — useful to have listed, but opening them every time is noise.

Add a per-binding **category** label and a per-binding **auto-open** flag. Auto-PDF only opens bindings where `auto_open=true`. The detail pane groups bindings by category for visual scannability.

## Non-Goals

- No metadata-extraction pipeline (e.g., parsing PDFs to detect part numbers).
- No board ↔ datasheet many-to-many table population. The architecture accommodates it (see § Future-plan accommodation), but no rows are derived in this spec.
- No bulk operations (re-categorize all auto-matched, etc.).
- No UI for adding new categories beyond the v1 vocabulary. The schema is open-vocabulary, but the dropdown is fixed for v1.

## User Story

> *I have a Mac logic board open. The Apple service manual schematic auto-opens beside it (the schematic is what I need on every job). I also have the SN8F25E14S datasheet bound to this board because it covers a chip I sometimes look up — but that datasheet doesn't auto-open every time. It's listed in the binding panel, two clicks away when I want it.*

## Design

### Schema

```sql
ALTER TABLE bindings ADD COLUMN category TEXT NOT NULL DEFAULT 'schematic';
ALTER TABLE bindings ADD COLUMN auto_open INTEGER NOT NULL DEFAULT 1;
```

Stored in `src/backend/databank/db.go` as part of the existing `bindings` schema in `initSchema`. Existing rows pick up the defaults during the additive migration, preserving today's behavior (every binding auto-opens, every binding labeled `schematic`).

- `category` — TEXT, open vocabulary. v1 dropdown choices: `schematic` | `datasheet` | `other`. Stored as plain text so future curated sources can introduce richer labels (`silkscreen`, `bom`, `errata`, …) without a schema change.
- `auto_open` — INTEGER 0/1. The Auto-PDF flow filters on this flag.

### Migration

SQLite supports `ADD COLUMN ... NOT NULL DEFAULT ...`. The existing `initSchema` in `db.go` runs the `CREATE TABLE IF NOT EXISTS` for new installs; for existing databanks we need additive `ALTER TABLE` calls guarded by an introspection check (`PRAGMA table_info(bindings)`). The migration runs on every startup and is idempotent.

### Go types

```go
// src/backend/databank/db.go (Binding struct)
type Binding struct {
    ID            int64  `json:"id"`
    BoardFileID   int64  `json:"board_file_id"`
    PdfFileID     int64  `json:"pdf_file_id"`
    AutoMatched   bool   `json:"auto_matched"`
    Category      string `json:"category"`
    AutoOpen      bool   `json:"auto_open"`
    BoardFilename string `json:"board_filename,omitempty"`
    BoardPath     string `json:"board_path,omitempty"`
    PdfFilename   string `json:"pdf_filename,omitempty"`
    PdfPath       string `json:"pdf_path,omitempty"`
}
```

`InsertBinding(boardFileID, pdfFileID int64, autoMatched bool, category string, autoOpen bool) (int64, error)` — extend the existing function to accept the two new columns. Keep the same `INSERT OR IGNORE` semantics so duplicate inserts are no-ops.

### API

**`POST /api/databank/bindings`** — extend existing handler in `src/backend/handlers/databank.go`:

```json
{
  "board_file_id": 1,
  "pdf_file_id":   2,
  "category":      "schematic",   // optional, defaults to "schematic"
  "auto_open":     true            // optional, defaults to true
}
```

**`PATCH /api/databank/bindings/{id}`** — new handler. Accepts a partial body:

```json
{
  "category":  "datasheet",   // optional
  "auto_open": false           // optional
}
```

Empty body or only-unrecognized fields → 400. Returns `{ "status": "ok" }` on success. New `db.UpdateBinding(id int64, category *string, autoOpen *bool) error` builds a dynamic SET clause, leaving unset fields untouched.

**`DELETE /api/databank/bindings/{id}`** — unchanged.

### Auto-open flow

[LibraryPanel.tsx:180](src/frontend/src/panels/LibraryPanel.tsx#L180): change the loop to skip bindings whose `auto_open` is false:

```ts
for (const binding of detail.bindings) {
  if (!binding.auto_open) continue;  // ← new filter
  // ... fetch & load PDF
}
```

No other behavior change in this code path.

### Frontend types

`src/frontend/src/store/databank-store.ts`, the `DatabankBinding` interface gains:

```ts
export interface DatabankBinding {
  id: number;
  board_file_id: number;
  pdf_file_id: number;
  auto_matched: boolean;
  category: string;
  auto_open: boolean;
  board_filename: string;
  board_path: string;
  pdf_filename: string;
  pdf_path: string;
}
```

New store methods:

```ts
async createBinding(
  boardFileId: number,
  pdfFileId: number,
  category?: string,
  autoOpen?: boolean,
): Promise<void>;

async updateBinding(
  id: number,
  patch: { category?: string; auto_open?: boolean },
): Promise<void>;
```

Both refetch the affected file's detail on success (today's `createBinding` already drives a `fetchFileDetail` from the panel; we keep that pattern).

### UI — `FileDetailPane` binding row

Today (1 row):

```
[icon] [filename]                 [A?]  [x]
```

After:

```
[icon] [filename]    [category ▾]  [pin*]  [A?]  [x]
```

- **Category dropdown** — small chip rendering the current label. Click opens a `<select>`-style menu with `Schematic / Datasheet / Other`. Changing it: `databankStore.updateBinding(id, { category, auto_open: defaultFor(category) })` where `defaultFor('schematic') = true` and `defaultFor` of anything else is `false`. **Exception:** if the user has explicitly toggled the pin since the binding was created (server-side `auto_open` no longer matches the category default), changing category does *not* clobber `auto_open` — only the label changes. This preserves user intent.
- **Pin** — `IconPinFilled` if `auto_open=true`, `IconPin` outline if false. Visibility rule:
  - Always visible when `auto_open` *contradicts* the category default (e.g., a datasheet with `auto_open=true` shows the filled pin permanently as an indicator that it deviates from convention).
  - Hover-revealed when `auto_open` matches the category default.
- **`[A?]`** — existing auto-matched badge, unchanged.
- **`[x]`** — existing remove button, unchanged. Already `stopPropagation` from the previous task.

### Visual grouping

Render bindings grouped by category with subtle 1px dividers (reuse `library-history-divider`):

1. Schematics
2. Datasheets
3. Other

Empty groups omit themselves and their leading divider. Within a group, sort by `auto_matched ASC` then `pdf_filename ASC` (manual user-curated entries above scanner heuristics).

### New-binding flow (`+` button)

The bind-picker (`library-bind-picker`) gets a category dropdown above the candidate list, defaulting to `schematic`. The user selects a category (and implicitly auto-open via the category default), then clicks a candidate. For session UX, the picker remembers the most recently used category in component state (no persistence).

### CSS additions

```css
.library-binding-category {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 8px;
  background: var(--bg-secondary);
  color: var(--text-secondary);
  cursor: pointer;
  border: 1px solid var(--border);
  flex-shrink: 0;
}
.library-binding-category:hover { color: var(--text-primary); }

.library-binding-pin {
  visibility: hidden;
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 0 2px;
  display: flex;
  align-items: center;
  flex-shrink: 0;
}
.library-binding-row:hover .library-binding-pin,
.library-binding-pin.is-overriding {  /* deviates from category default */
  visibility: visible;
}
.library-binding-pin.is-pinned {
  color: var(--accent);
}

.library-binding-group-header {
  font-size: 10px;
  text-transform: uppercase;
  color: var(--text-secondary);
  padding: 6px 8px 2px;
  letter-spacing: 0.04em;
}
```

Keeps visual continuity with the History pin styling shipped in `ecf267c`.

### Future-plan accommodation (board ↔ datasheet M2M)

A future spec will introduce a many-to-many table linking boards (by `board_number`) to datasheet PDFs, populated from a curated external source (similar to how `Board Database/` ships today):

```sql
-- FUTURE — not in this spec, shape only.
CREATE TABLE board_datasheets (
  board_number TEXT NOT NULL,
  pdf_file_id  INTEGER NOT NULL,
  category     TEXT NOT NULL DEFAULT 'datasheet',
  PRIMARY KEY (board_number, pdf_file_id)
);
```

At board-open time, a backend join will return matching rows alongside the file's persisted `bindings`. To avoid reshaping the UI later, **today's design adds a `source` field to the rendered binding-row type**:

```ts
type RenderedBinding =
  | (DatabankBinding & { source: 'binding' })           // from `bindings` table
  | { source: 'derived'; pdf_file_id; pdf_filename; category };  // future
```

For v1, every row has `source: 'binding'` (the type union has only one populated arm). The detail pane:

- Iterates `detail.bindings` and tags each with `source: 'binding'`.
- Renders the row using a single component that branches on `source`:
  - `'binding'`: full row with category dropdown, pin, A-badge, x-button.
  - `'derived'`: filename, an "auto-detected" badge, no controls. Always grouped under Datasheets.

`'derived'` is unreachable in v1 — no backend produces it. The branch exists so a future PR adding the M2M lookup only touches the API payload and a single render branch, not the row layout.

The `category` enum is open-vocabulary TEXT in both tables, so curated sources can introduce richer labels without schema migration on either side.

## Affected Files

- `src/backend/databank/db.go` — schema migration, `Binding` struct, `InsertBinding` signature, `UpdateBinding` new func, `BindingsByBoardFileID` / `BindingsByPdfFileID` SELECT lists.
- `src/backend/databank/scanner.go` — auto-match path passes the category default `'schematic'` and `autoOpen=true`.
- `src/backend/handlers/databank.go` — `CreateBinding` accepts new fields, new `UpdateBinding` handler.
- `src/backend/main.go` — register `PATCH /api/databank/bindings/{id}`.
- `src/frontend/src/store/databank-store.ts` — extend `DatabankBinding` interface, update `createBinding` signature, add `updateBinding`.
- `src/frontend/src/panels/LibraryPanel.tsx` — auto-open filter, binding row redesign, group rendering, picker category dropdown.
- `src/frontend/src/index.css` — new classes `.library-binding-category`, `.library-binding-pin`, `.library-binding-group-header`.

## Edge Cases

- **Existing databases without the new columns.** Startup migration adds them with defaults; existing bindings come back with `category='schematic'`, `auto_open=true`. No behavioral change for current users.
- **Updating a row to the same value.** `db.UpdateBinding` should still issue the UPDATE — cheap, and avoids a no-op branch that adds complexity. SQLite handles it.
- **Toggling pin on a `schematic` (no override needed).** Setting `auto_open=false` on a schematic stores the override; the pin then renders permanently (filled-or-outline, regardless of hover) so the user can see the deviation. Outline + permanently visible = "this schematic won't open."
- **Changing category on a row with an explicit pin override.** Don't clobber `auto_open`. A frontend-side check: send `auto_open` in the PATCH only if the current value matches the *current* category's default (we're not preserving an override). When it deviates (override active), send only `category`.
- **Deleting one of the underlying files.** Existing cascade behavior unchanged — bindings get garbage-collected at scan time or remain dangling depending on current code. Not in scope to fix here.
- **Race: user clicks pin twice fast.** The PATCH endpoint is idempotent given the same body, and the second click toggles back the local state. `updateBinding` should debounce only if we observe issues; v1 doesn't bother.
- **Auto-matched binding the user re-categorized.** The `auto_matched` badge stays (it reflects creation provenance, not current state). Re-running the scanner with `INSERT OR IGNORE` won't overwrite the row, so the user's category stays.

## Testing

- **Manual schema migration:** copy a databank from before the change, start the server, verify `PRAGMA table_info(bindings)` shows the new columns and existing bindings come back with defaults.
- **Manual UI:** bind a PDF as `schematic`, open the board → PDF auto-opens. Re-categorize as `datasheet` → close and re-open the board → PDF doesn't auto-open but is listed. Toggle pin override on the datasheet → PDF auto-opens despite the category. Toggle off again → reverts.
- **Manual edge case:** clear `auto_open` on a schematic (override) → close and re-open the board → PDF doesn't auto-open. Re-toggle → it does.
- **Backend unit:** `TestUpdateBindingPartial` — POST a binding with defaults, PATCH only `category`, verify `auto_open` unchanged. PATCH only `auto_open`, verify `category` unchanged. PATCH both, verify both. (Skip if no Go test scaffolding exists for handlers; verify by curl instead.)
- **No new automated frontend tests.** The change is localized UI state best validated by hand.

## Out of Scope / Follow-Ups

- The `board_datasheets` M2M table and its lookup join.
- A "category presets" UI for the user to define their own labels.
- Bulk re-categorization (e.g., "mark all `auto_matched` rows as schematic").
- Per-tab override of auto-open behavior (e.g., a one-off "open this binding for the current open" without flipping the row's stored flag).
