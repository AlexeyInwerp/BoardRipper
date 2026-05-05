# DnD Folder Import — Design Spec

**Date:** 2026-05-05
**Status:** Design approved, ready for implementation plan
**Sub-project:** Persist drag-and-drop board files into a structured, library-indexed folder when an optional Drop folder is configured.
**Related:**
- [2026-04-22 library-rework-design](2026-04-22-library-rework-design.md) — Library panel scan/views.
- [2026-04-27 binding-categorization-design](2026-04-27-binding-categorization-design.md) — board↔PDF bindings (reused for PDF pairing).
- [2026-04-29 filename-scan-importer-design](2026-04-29-filename-scan-importer-design.md) — `Unsorted/<ODM>/(unknown)` placeholder hierarchy in boards.db (reused by the resolver).
- [2026-04-03 databank-folder-registry-design](2026-04-03-databank-folder-registry-design.md) — `folders` table & cascade (relied on by the new scan root).

---

## Goal

Today, dropping a board or PDF file onto BoardRipper parses it client-side and caches the result in IndexedDB only — the backend never sees the file, it does not appear in the Library, and it disappears when browser cache is cleared.

Add a **Drop folder** — a writable subfolder **inside `/library/`** (default `/library/incoming`, overridable by power users). When the folder exists and is writable, a dropped file is:

1. Checked for duplicates against the existing `/library/` tree (which now includes the Drop folder, since it lives under the same root).
2. Identified (brand + board number) via parser metadata + boarddb lookup.
3. Imported atomically into `<drop>/<brand>/<board#>/<original-filename>` (or `unstructured/` / `pdfs/unsorted/` when uncertain).
4. Picked up by the existing scanner and shown in the Library — no scanner changes needed.
5. Opened from disk so there is one source of truth.

**Auto-enable behavior:** the default path `/library/incoming` is used silently if it exists and is writable — no Settings interaction required. The user enables the feature simply by adding a writable Docker volume mount at `/library/incoming`. If the path is missing or unwritable, the drop flow falls back to today's in-memory behavior and a one-time **Docker-only** popup explains how to enable persistence by adding the share. The popup does not appear in the Electron build (it has its own filesystem persistence).

The Drop folder is constrained to live under `/library/` so BoardRipper writes nothing outside the user's existing mount tree.

## Non-goals

- **Content-hash dedup at drop time.** Filename + size is sufficient; opportunistic SHA256 backfill is a future concern.
- **ML / heuristic brand inference from filename.** The boarddb resolver and parser metadata are the only identification sources in v1.
- **Editing existing library files.** The drop flow only writes into the configured Drop folder (a writable subfolder under `/library/`); the rest of the user's `/library/` tree (RO subfolders, NAS shares, etc.) is never touched.
- **Bulk-import of pre-existing files.** Filename-scan importer handles that ([2026-04-29 spec](2026-04-29-filename-scan-importer-design.md)).
- **Settings UX for Docker volume mounting.** The user mounts the host folder via Docker as today; we only consume the mount path inside the container.

## Today's Behavior (baseline)

- [src/frontend/src/App.tsx:88](../../../src/frontend/src/App.tsx#L88) `handleDrop()` validates extensions and calls `boardStore.loadFiles()` / `openPdfFiles()`. No backend call.
- IndexedDB cache (`boardripper-cache`, key `name:size:mtime`) holds the parser output for fast re-open in the same browser, only.
- [src/backend/handlers/files.go:34](../../../src/backend/handlers/files.go#L34) `POST /api/upload` exists, writes to `dataDir`, but is unreachable from the UI.
- Scanner walks `library_dir` (env `LIBRARY_DIR`, default `/library`) and the historic `dataDir` if set ([src/backend/databank/scanner.go:50](../../../src/backend/databank/scanner.go#L50)).
- `bindings` table ([2026-04-27 spec](2026-04-27-binding-categorization-design.md)) tracks board↔PDF pairings with `category` and `auto_open`.

---

## Storage Layout

The Drop folder is a writable subfolder **inside `/library/`** — never a sibling. The default container path is `/library/incoming`; the user enables it by adding a writable Docker volume mount at that path (e.g. host `~/boards/incoming` → container `/library/incoming`). Power users may override the path via Settings (stored in `databank.db` config row `dnd_dir`, mirrored from env `DND_DIR` on first run).

The path must satisfy `filepath.Rel("/library", dnd_dir)` cleanly with no `..` segments — anything outside `/library/` is rejected at config-save time. This keeps everything BoardRipper writes inside the same scan root, so no scanner changes are needed.

**Effective state** is computed by the backend on every config read:

| Conditions | `dndStatus` | Behavior |
|---|---|---|
| `dnd_dir` resolves under `/library/`, exists, writable | `active` | Drop flow imports; no popup. |
| Path missing OR unwritable, Docker mode | `unmounted` | In-memory drop; Docker popup on first drop (suppressible). |
| Path missing OR unwritable, Electron mode | `unmounted` | In-memory drop; **no popup** (Electron uses native persistence). |
| Path outside `/library/` (manual override gone wrong) | `invalid` | In-memory drop; Settings shows red error; no Docker popup. |

```
/library/                           ← single scan root (existing)
├── Schematics-RO/                  ← user's existing curated tree (often RO NAS share)
│   └── Apple/820-02016/...
└── incoming/                       ← default Drop folder; user mounts a writable volume here
    │                                  (or overrides path in Settings → power users only)
    ├── <brand>/<board#>/           ← high-confidence import
    │   ├── 820-02016.bvr
    │   └── 820-02016.pdf           ← bundled-drop or filename-matched PDF
    ├── Unsorted/<board#>/          ← ODM-only resolution (uses boards.db placeholder hierarchy)
    │   └── DAG3BEMBCD0.brd
    ├── unstructured/               ← parser silent + boarddb miss + user skipped or bulk drop
    │   └── mystery-dump.brd
    └── pdfs/unsorted/              ← lone PDF, no filename match against existing library
        └── random-schematic.pdf
```

### Slugification rules

`<brand>` and `<board#>` are slugified with: `lowercase`, `[^a-z0-9.-] → -`, collapse runs of `-`, trim leading/trailing `-`, max 64 chars. Empty result → `unsorted`.

Original filenames inside the folders are preserved verbatim; this is load-bearing for the dedup pass and for matching against `Apple/820-02016/820-02016.bvr` patterns external scrapers produce.

### Why a subfolder of `/library/`, not a sibling mount

- One scan root means **no scanner changes** — the existing walk picks up dropped files automatically.
- The user already mounts everything they care about under `/library/`; adding another sibling mount would just be an extra Docker volume to remember.
- Backups, permissions, and the Library panel tree continue to treat the inbox as "just another folder under /library/" — no new abstraction.
- The user keeps full control over which subfolder is RW: their curated tree can stay on a RO NAS share, and a separate writable host folder is mounted in as `/library/<whatever>`.

---

## Settings

New section "Drop & Import" inside `SettingsPanel` → `library` tab ([src/frontend/src/panels/SettingsPanel.tsx](../../../src/frontend/src/panels/SettingsPanel.tsx)).

Surface the **status first**, since for most users the only knob they need is "is it active or not":

> **Drop folder:** `/library/incoming` &nbsp;&nbsp; ✅ Active &nbsp;&nbsp; *(87 GB free)*

or

> **Drop folder:** `/library/incoming` &nbsp;&nbsp; ⚠ Not mounted &nbsp;&nbsp; *(Mount a writable Docker volume to this path to enable.)*

Behind a "Customize…" disclosure (collapsed by default — the default path covers the 95% case):

| Field | Type | Persisted as | Behavior |
|---|---|---|---|
| Drop folder path | text input | `dnd_dir` row in `databank.db` config table, mirrored from env `DND_DIR` on first run | Container path; **must be under `/library/`**. Empty/unset → falls back to default `/library/incoming`. Path-outside-library is rejected with a clear error and the previous value is kept. |
| Test write | button | — | Hits `POST /api/import/test-write`. Server attempts `os.WriteFile(<dnd>/.boardripper-write-test, …)` then removes it. UI shows ✓ + free space or ✗ with error message. |
| Reset to default | button | — | Clears `dnd_dir`; status reverts to whatever `/library/incoming` evaluates to. |

The Test Write check runs automatically on every config change and on backend startup. The result is exposed alongside `dnd_dir` in the config-snapshot endpoint as `dnd_status: "active" | "unmounted" | "invalid"`.

The drop overlay copy adapts based on `dnd_status`:

- `unmounted` (Docker, popup not yet dismissed): `Drop board or PDF files here` / sub-line `(temporary — see how to enable saving)`
- `unmounted` (Docker, popup dismissed) or Electron: `Drop board or PDF files here` (no sub-line — keeps today's clean look)
- `active`: `Drop to import to library` / sub-line `<dnd-path>`
- `invalid`: `Drop folder misconfigured — see Settings` (red sub-line)

### Docker-only "add a share" popup

When `!isElectron()` ([databank-store.ts:7](../../../src/frontend/src/store/databank-store.ts#L7)) AND `dnd_status === "unmounted"` AND the user actually drops a file, a one-time short modal appears:

> **Saving dropped files is disabled**
>
> BoardRipper can save dropped boards into your library so they show up next time. To enable, mount a writable folder to `/library/incoming` in your Docker config (e.g. add `-v ~/boards/incoming:/library/incoming` or a volume entry in `docker-compose.yml`).
>
> Until then, dropped files only stay in this browser's cache.
>
> [ ] Don't show again &nbsp;&nbsp;&nbsp; **[ Got it ]**

Dismissal flag persists in `databank.db` config row `dnd_unmounted_popup_dismissed: 1`. The popup is **suppressed** in:

- Electron build (uses native filesystem persistence, has its own UX).
- After dismissal (until reset by user via a "Show getting-started tips again" toggle in Settings — out of scope for v1).
- When `dnd_status === "active"` (no popup needed; drop just works).
- When `dnd_status === "invalid"` (the in-Settings red error replaces the popup; pointing the user to a misconfigured custom path).

The popup never blocks the drop — the file still loads in-memory while the modal is shown, so the user can use the file immediately. The modal is informational, not a confirmation.

---

## Drop Flow (DnD set, writable)

```
drop event
  │
  ├─ frontend: client-side parse (existing)
  │     extracts board_number, manufacturer, model when the format provides them
  │
  ├─ POST /api/import/check-duplicate { filename, size }
  │     SELECT path FROM files WHERE filename=? AND size=?  (the single /library scan root)
  │     200 {match: "<path>"}  → toast "Already in library: <path>"
  │                              → open existing → ABORT upload
  │     200 {match: null}      → continue
  │
  ├─ POST /api/databank/resolve { board_number, manufacturer }
  │     Query precedence:
  │       1. exact boards.code = board_number  → confidence "high", brand from boards.db row
  │       2. ODM-prefix recognition (same prefix patterns the filename-scan importer uses:
  │            apple_820 / quanta_da0 / lcfc_nm / compal_la / msi_ms / asus_60nr / oem_6050)
  │            → confidence "placeholder", brand = "Unsorted", family-name suffix preserved
  │            in the candidate (e.g. "Unsorted/Apple/(unknown)") so the user knows which ODM was matched
  │       3. multiple equal-rank exact matches → confidence "ambiguous", candidates list
  │       4. nothing → confidence "none"
  │
  ├─ classify (per Q2d hybrid):
  │     high                              → silent
  │     placeholder                       → silent (writes to Unsorted/<board#>/, user can promote later)
  │     ambiguous + single-file drop      → modal (see § Modal)
  │     ambiguous + bulk drop (>3 files)  → silent → unstructured/
  │     none + single-file drop           → modal
  │     none + bulk drop                  → silent → unstructured/
  │
  ├─ POST /api/import { filename, target, bytes }
  │     target ∈ { "<brand>/<board#>", "unstructured", "pdfs/unsorted" }
  │     server:
  │       1. write to <dnd>/.tmp/<uuid>-<filename>
  │       2. fsync
  │       3. mkdir -p <dnd>/<target>/
  │       4. os.Rename(<tmp>, <dnd>/<target>/<filename>)   ← atomic within the same mount
  │       5. trigger incremental scan of <dnd>/<target>/   (cheap, single-folder walk —
  │            same scanner, same /library root, just a localized re-scan)
  │       6. return 200 { path: "<dnd>/<target>/<filename>", file_id: <new id> }
  │
  └─ frontend: open the on-disk path via the existing library-open code path,
              not from the dropped File object — guarantees one source of truth.
```

### Modal (single-file ambiguous / none case)

Component: new `src/frontend/src/components/ImportModal.tsx`.

Fields:
- **Brand** — text input, prefilled with parser-provided manufacturer if any. Below: chips for the top 3 boarddb candidates (clicking fills the field).
- **Board number** — text input, prefilled with parser-extracted board_number if any.
- Footer buttons: `Import` / `Skip → unstructured` / `Cancel`.

`Import` posts to `/api/import` with `target: "<brand>/<board#>"`. `Skip` posts with `target: "unstructured"`. `Cancel` aborts (no file written, no library entry — same as today's in-memory behavior for this one drop).

The modal is the same component reused by the deferred Reclassify flow (§ v2).

---

## Dedup

Match key: **filename + size** across all scan roots (`/library` + `/dnd`).

Rationale:
- Boardview filenames (`820-02016.bvr`, `DAG3BEMBCD0.brd`) are content-addressed in practice.
- Filename + size catches the realistic cases (re-drop of the same file, or a file already present in the user's RO `/library` mount) without a content-hash pass.
- Risk of false positive (different file, same name, same size, different bytes) is negligible for board files.

Behavior on hit: **block + open existing** (Q5a). Toast: `Already in library: <path>` for ~3s. The user can always rename the local file and re-drop to force a copy if they really want one.

Opportunistic SHA256 happens later in a scanner pass and is stored on the `files` row for future use; not on the drop hot path.

---

## PDF Handling

Two cases triggered in `handleDrop`:

### Bundled drop (Q7a)

If the drop event contains both `.bvr/.brd/...` and `.pdf` files:

1. Identify the board file's target (`<brand>/<board#>/`) using the rules above.
2. Each PDF in the same drop event is written to the **same** `<brand>/<board#>/` folder.
3. After import, call `db.InsertBinding(boardFileID, pdfFileID, autoMatched=true, category="schematic", autoOpen=true)` ([databank/db.go:967](../../../src/backend/databank/db.go#L967)) so the PDF auto-opens with the board in future sessions.

### Lone PDF (Q7c)

If the drop event has only PDF(s):

1. For each PDF, find candidate board rows by base-filename match. The `files` table has no `base_filename` column, so the existing pattern from [databank/metadata.go:310-314](../../../src/backend/databank/metadata.go#L310-L314) — `strings.ToLower(strings.TrimSuffix(filename, filepath.Ext(filename)))` — is reused. Implementation: `SELECT id, manufacturer, board_number FROM files WHERE file_type='board'` then filter the base in Go. (Acceptable cost: this list is small; no need to add a new index in v1.)
2. **Exactly one** match → import the PDF to `<dnd>/<slug(brand)>/<slug(board#)>/<filename>` (the matched board's brand/board#, slugified; **always inside the configured Drop folder** regardless of where the matched board file lives — the matched board may be in a sibling-RO subfolder under `/library/` and we never write there). Then `db.InsertBinding(matchedBoardID, newPdfID, autoMatched=true, "schematic", true)`. Bindings are by `file_id` so the within-`/library/`-but-different-subfolder association is fine.
3. **Zero** matches or **>1** matches → import to `pdfs/unsorted/<filename>`. No binding created.
4. If the single matched board has no brand/board# in its row (it's still in `unstructured/` or `Unsorted/`), the PDF lands in `pdfs/unsorted/` rather than guessing — no binding either, since the user hasn't classified the board yet.

Filename-match is intentionally strict (exact base, case-insensitive). Heuristic similarity is out of scope.

---

## Backend Changes

### Config defaulting

`dnd_dir` defaults to `filepath.Join(libraryRoot, "incoming")` (typically `/library/incoming`) when neither the `databank.db` config row nor the `DND_DIR` env var is set. The default is computed at request time, so changing `LIBRARY_DIR` propagates without DB migration.

The config-snapshot endpoint (`GET /api/config` — already exposed to the frontend) gains:
- `dnd_dir`: the resolved effective path (default or override).
- `dnd_status`: `"active" | "unmounted" | "invalid"` per the table in § Settings.
- `dnd_unmounted_popup_dismissed`: bool, mirrors the config row of the same name.

### New file: `src/backend/handlers/import.go`

Endpoints:
- `POST /api/config` (extend existing) — when setting `dnd_dir`, validate `filepath.Rel(libraryRoot, dnd_dir)` succeeds and the result has no `..` segments. Reject otherwise with `400 {error: "Drop folder must be under /library/"}`. When clearing `dnd_dir` (empty string), the default takes over.
- `POST /api/import/check-duplicate` — body `{filename, size}`, returns `{match: <path|null>}`. Single SQL query against the `files` table.
- `POST /api/import/test-write` — attempts the write+remove cycle in resolved `dnd_dir` plus a `disk.Usage()` for free bytes, returns `{ok, free_bytes, error?}`.
- `POST /api/import` — multipart: file bytes + form fields `target` (relative path inside resolved `dnd_dir`). Performs temp-file + fsync + atomic rename + folder-scan trigger. Returns `{path, file_id}`. Re-validates `target` is a clean relative path with no `..`. Re-checks `dnd_status === "active"` on entry; refuses with 409 if not.
- `POST /api/import/dismiss-popup` — sets `dnd_unmounted_popup_dismissed = 1` in config. No body.

### New file: `src/backend/databank/dnd_writer.go`

Helpers:
- `Slugify(s string) string` — per § Slugification rules.
- `ValidateUnderLibrary(libraryRoot, dndDir string) error` — `filepath.Rel` + `..`-segment check. Used by both config-save and import handlers (defense in depth).
- `AtomicWrite(dndDir, target, filename string, r io.Reader) (string, error)` — temp + fsync + rename, mkdir-p target, returns final path.

### `src/backend/boarddb/boarddb.go`

Add:
- `Resolve(boardNumber, manufacturer string) (ResolveResult, error)` returning `{Confidence: "high"|"placeholder"|"ambiguous"|"none", Candidates: []BoardMatch}`.
- Reuses existing `boards` table indexes; the placeholder rows from [2026-04-29 spec](2026-04-29-filename-scan-importer-design.md) are queried via the standard `code` lookup (no new schema).

### Scanner

**No changes.** The Drop folder lives under `/library/`, which the scanner already walks. After `/api/import` writes a file, it calls the existing localized-rescan helper for the target subfolder so the new row appears in `databank.db` without waiting for the next full scan.

### Removed

- `POST /api/upload` ([src/backend/handlers/files.go:34](../../../src/backend/handlers/files.go#L34)) — superseded by `/api/import`. Delete in the same PR; it was never wired up to the UI, so no compatibility concern.

---

## Frontend Changes

### `src/frontend/src/App.tsx handleDrop()`

- Read `dndStatus`, `dndUnmountedPopupDismissed` from config snapshot at top of the handler.
- If `dndStatus === "active"` → orchestrate the drop pipeline: parse → check-duplicate → resolve → classify → import → open from disk. Surface progress via the existing toast/status system. Multi-file drops show a single "Importing 5 files…" toast that resolves to "Imported 4, 1 in unstructured" when done.
- If `dndStatus !== "active"` → existing in-memory path (no change in behavior). Then, if `!isElectron() && dndStatus === "unmounted" && !dndUnmountedPopupDismissed`, show the `<UnmountedDropPopup>` modal (see below). The drop itself is **not** blocked by the popup — the file already loaded in-memory before the modal mounted.

### `src/frontend/src/components/ImportModal.tsx`

New file. Props: `{ filename, parserHints: {board_number?, manufacturer?}, candidates: BoardMatch[], onImport, onSkip, onCancel }`. ~120 lines.

### `src/frontend/src/components/UnmountedDropPopup.tsx`

New file. The Docker-only "add a share" modal described in § Settings. Props: `{ onDismiss }`. Posts to `POST /api/import/dismiss-popup` when "Don't show again" is checked + closed. ~60 lines, including the example `docker-compose.yml` snippet shown to the user.

### `src/frontend/src/panels/SettingsPanel.tsx`

New `LibrarySyncSection` sub-section "Drop & Import" with the status-first layout enumerated in § Settings. Hits the new `/api/import/test-write` endpoint and the existing `PUT /api/config` for persistence.

### Drop overlay copy

The overlay JSX lives inline in [App.tsx:205-210](../../../src/frontend/src/App.tsx#L205-L210), not in a separate component. Update in place to be a four-state adapter (active / unmounted-with-popup-pending / unmounted-dismissed-or-electron / invalid) per the table in § Settings, reading `dndStatus` and `dndUnmountedPopupDismissed` from the `useDatabank()` config snapshot. No extraction needed unless the JSX grows past ~30 lines.

---

## Testing

**Backend (Go):**
- `dnd_writer_test.go` — slugify table tests, atomic write succeeds, fails when target unwritable, handles concurrent writes to same filename (only one wins, the other gets a clear error).
- `boarddb_test.go` — resolver returns high / placeholder / ambiguous / none for known fixtures.
- `import_handler_test.go` — duplicate check, write+rename round-trip with a temp dir.

**Frontend (Playwright):**
- One spec that drives the full happy path against a mocked backend: drop board + PDF together → both land in `<brand>/<board#>/` → opened from disk → reload page → both still present in Library.
- One spec for the duplicate path: drop a file that's already on disk → toast appears → existing file opens → no new write.
- One spec for the modal path: drop a board with no parser metadata → modal appears → user fills in → submitted → file lands in correct folder.
- One spec for the unmounted-popup path: backend reports `dnd_status: "unmounted"` + `dnd_unmounted_popup_dismissed: false` → drop file → file loads in-memory + popup appears → check "Don't show again" + close → POST to dismiss-popup fires → reload page → drop again → no popup.
- One spec confirming popup suppression in Electron: same backend state but mock `window.electronAPI = {scanLibrary: …}` → drop → no popup.

The "Needs Review" UX (§ v2) is **not** tested in v1 — it does not exist yet.

---

## v2 — Specced, Not Implemented

These are designed up-front so v1 doesn't paint itself into a corner, but they ship in a follow-up PR:

### Needs Review tray

- `LibraryPanel` header gains a badge: count of files where `manufacturer IS NULL OR board_number IS NULL`.
- New top-level group in the metadata tree: "Needs Review" (auto-expanded when non-empty), grouping all `unstructured/` and `pdfs/unsorted/` entries.
- Click a row → opens the file + offers a "Classify…" action.

### Reclassify endpoint

`POST /api/import/reclassify` body `{file_id, brand, board_number}`:
- `os.Rename(<old-path>, <dnd>/<slug(brand)>/<slug(board#)>/<basename>)` (mkdir-p as needed).
- `UPDATE files SET manufacturer=?, board_number=?, path=?, folder_id=? WHERE id=?`.
- Returns the new path.

### Classify modal

Reuses `ImportModal.tsx` (already shipped in v1). Triggered from a Library context menu item "Classify…" on any file row, prefilled from the row's existing metadata.

### Bulk-drop review queue

When a bulk drop dumps >N files into `unstructured/`, surface a one-shot toast with a "Review now" action that opens the Needs Review tray pre-filtered to that batch.

---

## Open Questions

None as of approval. The bulk-drop threshold (`>3 files = silent unstructured`) is the only tuning knob; it can be adjusted without a schema change if user feedback says otherwise.

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| User configures a Drop folder outside `/library/` | Validated at config-save (`filepath.Rel` + `..` check) and re-validated at every `/api/import` call. Rejected with a clear error before write. |
| Docker user finds the "add a share" popup annoying | Modal is one-time per user. "Don't show again" checkbox sets `dnd_unmounted_popup_dismissed`; never re-appears unless user resets it from a future "show tips again" toggle (out of v1 scope). Suppressed entirely in Electron. |
| User mounts the share *after* dismissing the popup | Backend re-evaluates `dnd_status` on every config read; once it flips to `active` the drop flow just starts working. The dismissal flag never blocks the drop itself. |
| User picks a path under `/library/` that's actually a RO mount | Test Write on save + on startup catches it; `dnd_status` flips to `unmounted`; drop flow falls back to in-memory + (Docker) popup. |
| Same filename concurrently dropped from two browsers | Atomic rename + post-rename existence check; second writer gets a "duplicate (race)" error and falls into the existing dedup path. |
| Boarddb resolver returns wrong brand for ambiguous codes | Single-file ambiguous drops always show the modal; bulk drops go to `unstructured/` where v2 review can fix them. No silent miscategorization in the single-drop path. |
| `unstructured/` accumulates without v2 review UI | Documented limitation. Files are still in `databank.db` and findable via search; the user can move them on disk and rescan. v2 ships the proper UI. |
| Slugified folder name collides across different brand spellings (`HP Inc.` vs `HP`) | Resolver canonicalizes via boards.db row's brand name before slugifying — single source of truth. |

---

## Summary of v1 Scope

Ship:
1. Default `dnd_dir = /library/incoming` with `dnd_status` auto-detection on every config read
2. Settings UI: status-first display, "Customize…" disclosure for power-user override, under-`/library/` validation, Test Write
3. Docker-only `<UnmountedDropPopup>` on first drop while `dnd_status === "unmounted"`, with persistent dismissal
4. Adaptive drop overlay copy (4 states: active / unmounted+popup-pending / dismissed-or-Electron / invalid)
5. Dedup check (filename + size, single `/library/` scan root)
6. `/api/import` with atomic temp+rename + localized rescan trigger
7. Resolver `Resolve(boardNumber, manufacturer)` returning confidence + candidates
8. Hybrid classify policy (Q2d): silent for high/placeholder, modal for single-file ambiguous/none, silent unstructured for bulk
9. PDF pairing (bundled + filename-match) with auto-binding creation via existing `db.InsertBinding`
10. Removal of dead `POST /api/upload`
11. Tests as enumerated above

Notably **not** in scope (because the folder lives under `/library/`):
- No new scan root, no new env var beyond optional `DND_DIR`, no scanner changes.

Defer to v2 (specced, not built):
- Needs Review badge + tray in Library panel
- `POST /api/import/reclassify`
- Classify modal trigger from Library
- Bulk-drop review toast
