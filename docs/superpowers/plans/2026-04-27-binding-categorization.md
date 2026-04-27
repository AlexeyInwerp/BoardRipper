# Binding Categorization Implementation Plan

**Goal:** Add per-binding `category` (schematic/datasheet/other) and `auto_open` flag to the `bindings` table. Filter the Auto-PDF flow on `auto_open`. Group bindings in the FileDetailPane by category. Plumb a `source` discriminator into the rendered row type so a future board↔datasheet M2M lookup slots in without UI rework.

**Spec:** [docs/superpowers/specs/2026-04-27-binding-categorization-design.md](../specs/2026-04-27-binding-categorization-design.md)

**Tech Stack:** Go 1.22 (`net/http` + `modernc.org/sqlite`), SQLite 3, TypeScript + React 19, Vite 7.

**Prerequisites:** None. Touches `bindings` independently of the boards.db v2 work.

---

## Phase 1: Backend

### Task 1: Schema migration

**Files:**
- Modify: `src/backend/databank/db.go`

- [ ] **Step 1: Add the new columns to the `CREATE TABLE bindings` statement** in `initSchema` (or the equivalent block) so fresh installs get them. Default `category='schematic'`, `auto_open=1`.
- [ ] **Step 2: Add an idempotent additive migration.** Use `PRAGMA table_info(bindings)` to detect missing columns; for each missing column, run `ALTER TABLE bindings ADD COLUMN ...`. Run on every startup. Idempotent because the introspection check skips columns that already exist.
- [ ] **Step 3: Verify** by deleting the dev databank, restarting the server, and confirming `PRAGMA table_info(bindings)` shows the new columns.

### Task 2: `Binding` struct + `InsertBinding` + `UpdateBinding`

**Files:**
- Modify: `src/backend/databank/db.go`

- [ ] **Step 1: Extend the `Binding` struct** with `Category string` (json `category`) and `AutoOpen bool` (json `auto_open`).
- [ ] **Step 2: Update `InsertBinding`** signature to `InsertBinding(boardFileID, pdfFileID int64, autoMatched bool, category string, autoOpen bool) (int64, error)`. Update the SQL `INSERT OR IGNORE` to include the two new columns.
- [ ] **Step 3: Update SELECT lists** in `BindingsByBoardFileID` / `BindingsByPdfFileID` (and the joined-bindings query around line 857) to read the new columns. Map `auto_open INTEGER` to bool via `intToBool`.
- [ ] **Step 4: Add `UpdateBinding(id int64, category *string, autoOpen *bool) error`**. Builds a dynamic `UPDATE bindings SET ... WHERE id = ?` with only the non-nil fields. Returns `nil` even if the row didn't exist (the handler validates first).

### Task 3: Scanner call site

**Files:**
- Modify: `src/backend/databank/scanner.go`

- [ ] **Step 1:** At the auto-match insert (around line 539), pass `'schematic'` and `true` as the new args to `InsertBinding`.

### Task 4: Handlers

**Files:**
- Modify: `src/backend/handlers/databank.go`
- Modify: `src/backend/main.go`

- [ ] **Step 1: Update `CreateBinding`** request struct to include optional `Category *string` and `AutoOpen *bool`. If `nil`, use `'schematic'` and `true`. Pass through to `InsertBinding`.
- [ ] **Step 2: Add `UpdateBinding` handler.** Parses `{id}` from path, decodes body into `{ Category *string; AutoOpen *bool }`, calls `db.UpdateBinding`. Returns `400` if both are nil. Returns `{"status":"ok"}` on success.
- [ ] **Step 3: Register the new route** in `main.go`: `mux.HandleFunc("PATCH /api/databank/bindings/{id}", dbHandler.UpdateBinding)`.

### Task 5: Build + smoke test backend

- [ ] **Step 1:** `cd src/backend && go build ./...` — must compile clean.
- [ ] **Step 2:** Restart the server, hit `curl -X PATCH localhost:8080/api/databank/bindings/<id> -d '{"category":"datasheet","auto_open":false}'` against an existing binding row, verify the row updates via `curl /api/databank/files/<board_id>` and inspecting the binding's fields.

---

## Phase 2: Frontend

### Task 6: Type updates

**Files:**
- Modify: `src/frontend/src/store/databank-store.ts`

- [ ] **Step 1:** Extend `DatabankBinding` interface: add `category: string` and `auto_open: boolean`.
- [ ] **Step 2:** Update `createBinding(boardFileId, pdfFileId, category?: string, autoOpen?: boolean)` signature. Body sends optional fields; backend defaults handle `undefined`.
- [ ] **Step 3:** Add `async updateBinding(id: number, patch: { category?: string; auto_open?: boolean }): Promise<void>`. POST … no, PATCH to `/api/databank/bindings/${id}` with the JSON body. On success, no automatic refetch — the caller (FileDetailPane) refetches via `fetchFileDetail(selectedFileId)`.

### Task 7: Auto-open filter

**Files:**
- Modify: `src/frontend/src/panels/LibraryPanel.tsx`

- [ ] **Step 1:** In the `handleOpenFile` board branch (around line 180), wrap the binding-loading body with `if (!binding.auto_open) continue;`. The bindings already come back from `fetchFileDetail` with the new field after Phase 1.

### Task 8: FileDetailPane row redesign

**Files:**
- Modify: `src/frontend/src/panels/LibraryPanel.tsx`

- [ ] **Step 1: Define the rendered row type:**
  ```ts
  type RenderedBinding =
    | (DatabankBinding & { source: 'binding' })
    | { source: 'derived'; pdf_file_id: number; pdf_filename: string; category: string };
  ```
  Keep this co-located with `FileDetailPane`. The `'derived'` arm is unreachable in v1 — it's a forward hook.
- [ ] **Step 2: Convert `detail.bindings` to `RenderedBinding[]`** by tagging each row with `source: 'binding'`.
- [ ] **Step 3: Group by category** before render: `{ schematic: [], datasheet: [], other: [] }`. Sort within each group by `auto_matched ASC, pdf_filename ASC`. Render each non-empty group with a `library-binding-group-header`, a 1px divider above (except the first), then the rows.
- [ ] **Step 4: Render the binding row.** A new component `<BindingRow row={row} … />` that branches on `row.source`. For `'binding'`:
  - icon + filename
  - category dropdown (`<select>` styled as a chip; options `Schematic / Datasheet / Other`)
  - pin button (`IconPinFilled` / `IconPin`) — visibility controlled by `is-overriding` class when `auto_open` deviates from category default
  - existing `[A]` auto-matched badge
  - existing `[x]` remove button
  For `'derived'`: filename + "auto-detected" badge only.
- [ ] **Step 5: Wire the category dropdown.** On change, compute the category default for `auto_open`. If the existing `auto_open` already deviates from the *current* category's default (i.e. user has overridden), preserve `auto_open` and only patch `category`. Otherwise patch both.
- [ ] **Step 6: Wire the pin toggle.** On click, `updateBinding(id, { auto_open: !current })` then refetch detail.

### Task 9: Bind-picker category dropdown

**Files:**
- Modify: `src/frontend/src/panels/LibraryPanel.tsx`

- [ ] **Step 1:** In the `library-bind-picker`, add a category `<select>` above the candidate list. Component-state `useState<string>('schematic')` for the dropdown value, persisted only for the lifetime of the picker (resets when reopened).
- [ ] **Step 2:** When the user clicks a candidate, pass the dropdown value into `createBinding(...)` along with `auto_open = (category === 'schematic')`.

### Task 10: CSS

**Files:**
- Modify: `src/frontend/src/index.css`

- [ ] **Step 1:** Add the `.library-binding-category`, `.library-binding-pin`, and `.library-binding-group-header` rules per the spec.
- [ ] **Step 2:** Sanity-check existing `.library-binding-row` styling still composes correctly (the row is now a flexbox with more children).

### Task 11: Verification

- [ ] **Step 1:** `npx tsc --noEmit` clean.
- [ ] **Step 2:** `npm run build` clean.
- [ ] **Step 3:** `npm run lint` — no new warnings. Compare warning count to baseline (currently 80).
- [ ] **Step 4: Manual smoke test:**
  - Bind a PDF as schematic → close+reopen board → it auto-opens. ✓
  - Re-categorize the binding to datasheet → close+reopen board → it does not auto-open but is listed under Datasheets. ✓
  - Toggle pin override on the datasheet → close+reopen → it auto-opens (with filled pin permanently visible). ✓
  - Toggle pin off again → stops auto-opening. ✓
  - Bind two PDFs (one schematic, one datasheet); detail pane shows both groups with a divider between. ✓
  - Open a fresh DB without the columns → server migration runs → existing bindings come back as `schematic` + `auto_open=true`, behavior unchanged. ✓

### Task 12: Commit

- [ ] **Step 1:** Commit backend changes and frontend changes together as a single logical feature. Include the spec + plan in the same commit if not already committed.

---

## Phase 3: Future-plan readiness check

- [ ] **Step 1: Sanity-verify the `'derived'` arm is structurally complete** by writing (and discarding without committing) a temporary mock that injects a fake `RenderedBinding` with `source: 'derived'` into the rendered list. Confirm it:
  - Renders in the Datasheets group regardless of the type's stated category.
  - Has no controls (category chip, pin, x).
  - Has the auto-detected badge.
  - Doesn't crash on hover or click.
  Discard the mock. This is the v0 acceptance test for the future M2M lookup spec.
