# Board↔PDF binding persistence — implementation plan

- **Status:** PLAN (approved to plan; not yet implemented)
- **Date:** 2026-06-30
- **Problem owner:** the `∞` BindLink in tab headers creates bindings that vanish on reload, while "main" (Library-created) bindings persist. See the investigation summary below.

## 1. Problem / current state

One `∞` glyph (`BindLink`, purely presentational) sits over **three** separately-stored link systems:

| # | Link | Stored | Persistent | Written from |
|---|------|--------|-----------|--------------|
| A | board↔PDF binding | backend SQLite `bindings` (`board_file_id`, `pdf_file_id`, `category`, `auto_open`) | **yes (server)** | Library `+` UI; auto-promotion on PDF-open |
| B | runtime tab board↔PDF | `tab.pdfFileNames: string[]` in `boardStore` (memory) | **no** | **the tab `∞` button** |
| C | PDF↔PDF cross-link | `localStorage` (`pdf-link:`) | local | PDF tab `∞` |

**Root cause of "sloppy":** the tab `∞` writes only to **B** (runtime), never to **A**:
- `BoardTab.handleToggle` ([BoardTab.tsx:77-84](src/frontend/src/components/BoardTab.tsx#L77)) → `boardStore.togglePdfBinding` / `removePdfBinding` (runtime only).
- `PdfTab.handleBindBoard` ([PdfTab.tsx:80-88](src/frontend/src/components/PdfTab.tsx#L80)) → `removePdfBinding` + `addPdfBinding` (runtime only).
- `openBoardEntries()` ([board-store.ts:545](src/frontend/src/store/board-store.ts#L545)) **excludes `pdfFileNames`**, so even local runtime bindings die on reload.
- The backend row is only written from `LibraryPanel` ([promotion ~LibraryPanel.tsx:455-470](src/frontend/src/panels/LibraryPanel.tsx#L455)) and hydrated A→B only on **Library** board open ([LibraryPanel.tsx:401-424](src/frontend/src/panels/LibraryPanel.tsx#L401)).
- **Asymmetric removal:** a tab-`∞` unlink doesn't delete the backend row, so the next Library open of that board re-loads the `auto_open` PDF and re-adds the runtime binding → the unlink "comes back" (the flakiness).

## 2. Goal

The tab `∞` becomes authoritative and durable: creating/removing a board↔PDF link there **writes through to the backend** (when both files are in the databank) and **survives reload** (even when they aren't). Removal is authoritative (no resurrection). One code path for create/remove across the tab `∞` and the Library.

## 3. Design

### 3.1 Shared helper (single source of truth for promote/demote)
Add to `databankStore`:
```ts
/** Promote/demote a runtime board↔PDF link to the backend `bindings` table.
 *  Returns 'persisted' | 'local-only' (one side not in databank) | 'noop'. */
async setBoardPdfBinding(boardFileName: string, pdfFileName: string, linked: boolean):
  Promise<'persisted' | 'local-only' | 'noop'>
```
Logic (extracted from the existing LibraryPanel promotion):
- Resolve `board = fileByFilename(boardFileName)`, `pdf = fileByFilename(pdfFileName)`.
- If either missing or not the right `file_type` → return `'local-only'` (no backend op).
- `linked === true`: `fetchFileDetail(board.id)`; if no existing row for `pdf.id` → `createBinding(board.id, pdf.id, 'schematic', true)`. (Guard double-create like LibraryPanel.)
- `linked === false`: `fetchFileDetail(board.id)`; find the row with `pdf_file_id === pdf.id`; if found → `deleteBinding(row.id)`.
- Refresh the selected-file detail if one is open (mirror existing LibraryPanel behavior).

`createBinding`/`updateBinding`/`deleteBinding` already exist ([databank-store.ts:1547/1566/1577](src/frontend/src/store/databank-store.ts#L1547)); `fetchFileDetail(id)` returns `{ bindings: [{ id, pdf_file_id, board_file_id, category, auto_open }] }`.

### 3.2 Wire the tab `∞` through the helper
- `BoardTab.handleToggle`: after the existing `togglePdfBinding`/`removePdfBinding`, call `databankStore.setBoardPdfBinding(tab.fileName, name, linked)` (fire-and-forget with a `.catch(log.ui.warn)`; UI stays optimistic). Determine `linked` from the post-toggle state.
- `PdfTab.handleBindBoard`: same — on bind call helper with `linked=true` for the new board, `linked=false` for the unbound one(s).
- Keep the runtime mutation first (instant UI), backend second (durable).

### 3.3 Refactor LibraryPanel to use the helper
Replace the inline promotion block ([LibraryPanel.tsx:455-470](src/frontend/src/panels/LibraryPanel.tsx#L455)) with a call to `setBoardPdfBinding(...)`. One code path → consistent behavior; removes duplication.

### 3.4 Survive reload for non-databank (drag-dropped) links
For boards/PDFs not in the databank, the backend can't hold the binding (no `file.id`). Persist the runtime link in the session instead:
- `openBoardEntries()` ([board-store.ts:545](src/frontend/src/store/board-store.ts#L545)): add `pdfFileNames: t.pdfFileNames` to each entry.
- `SessionEntry` / snapshot: carry `pdfFileNames?` for board entries.
- `restoreSession` ([session-store.ts](src/frontend/src/store/session-store.ts)): after a board's PDFs are (re)opened, re-apply `boardStore.addPdfBinding(tabId, pdfName)` for each persisted name. (Backend bindings already rehydrate via the Library/board-open path; this covers the non-databank gap.)

### 3.5 Make removal authoritative (no resurrection)
Because 3.2 now deletes the backend row on tab-`∞` unlink, the Library re-open path ([LibraryPanel.tsx:405-412](src/frontend/src/panels/LibraryPanel.tsx#L405)) won't find an `auto_open` row to resurrect. No extra work beyond 3.1's delete — verify with the test in §6.

## 4. Files to change
| File | Change |
|------|--------|
| `store/databank-store.ts` | new `setBoardPdfBinding()` helper |
| `components/BoardTab.tsx` | `handleToggle` → call helper after runtime mutation |
| `components/PdfTab.tsx` | `handleBindBoard` → call helper |
| `panels/LibraryPanel.tsx` | replace inline promotion with helper (dedup) |
| `store/board-store.ts` | `openBoardEntries()` include `pdfFileNames` |
| `store/session-store.ts` | `SessionEntry.pdfFileNames`; rehydrate runtime bindings |

## 5. Open questions (confirm before coding)
1. **Unlink semantics:** on tab-`∞` unlink, **delete** the backend row (plan's choice — the toggle is binary "linked or not"), or keep the row and set `auto_open=false`? Delete is simpler and matches the glyph's meaning; downside is a Library-set `category` is lost.
2. **Drag-dropped persistence:** OK to persist `pdfFileNames` in the local session (survives reload on this browser, not cross-device)? It's the only option without databank ids.
3. **Promote on any board open?** Today A→B hydration only runs on **Library** board open. Should a drag-dropped board that name-matches a databank file also hydrate its backend bindings on open? (Nice-to-have; can defer.)
4. **Failure UX:** tab-`∞` backend write is fire-and-forget. Surface a toast on failure, or stay silent (log only)? Plan: silent log; the runtime link still works for the session.

## 6. Test plan
- **Persist:** open board+PDF (both in databank), link via tab `∞`, reload → binding present (backend row exists AND runtime rehydrated). (E2E: drive `boardStore`/`databankStore` test globals; assert a `bindings` row via `/api/databank/bindings` or `fetchFileDetail`.)
- **Authoritative unlink:** link, reload, unlink via tab `∞`, reopen board from Library → **stays unlinked** (no resurrection).
- **Drag-dropped:** link two drag-dropped files, reload → link survives via session `pdfFileNames`.
- **No double-create:** linking an already-bound pair is a no-op (no duplicate row).
- **Backend unit:** `bindings` row created/deleted; `UNIQUE(board_file_id, pdf_file_id)` honored.
- `tsc -b` clean; existing binding/session specs pass.

## 7. Risks
- The tab `∞` handlers are currently synchronous; introducing async backend writes must not block or reorder the optimistic UI. Keep runtime-first, backend-after, fire-and-forget.
- Two ID spaces (tab id + filename vs databank file ids) — the helper resolves by filename, which is the only stable key the tab has; a board with no databank match silently falls back to session-only persistence (3.4), which is correct, not a bug.
