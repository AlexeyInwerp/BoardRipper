# Scanner Overhaul — Design Spec

**Date:** 2026-03-25
**Status:** Draft

## Problem

The library scanner treats file indexing and PDF text extraction as a single coupled pipeline that auto-runs on every container startup. With a large NAS library (thousands of files), this causes:

1. Slow startup — full filesystem walk on every container restart
2. No control over PDF extraction — it auto-chains after file scan, can't be triggered independently
3. Stop button doesn't work for PDF extraction phase (no cancellation support)
4. No persistence of scan state in the frontend — page reload loses scan results and can re-trigger
5. No database management UI — no way to see DB stats, reset, or review errors
6. Folders view only shows indexed data — can't browse the live filesystem

## Design

### 1. Split Scan Operations (Backend)

Decouple file indexing and PDF extraction into fully independent operations.

**Endpoints:**

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/databank/scan` | File indexing only (no auto PDF extraction) |
| `POST` | `/api/databank/scan/pdf` | PDF text extraction only (manual trigger) |
| `POST` | `/api/databank/scan/stop` | Stop whichever operation is running |
| `GET`  | `/api/databank/scan/status` | Status of both operations (adds `pdf_completed_at`) |
| `GET`  | `/api/databank/stats` | DB stats: file counts, DB size, last scan time, error count |
| `POST` | `/api/databank/reset` | Wipe all scan data (files, bindings, text, errors) |
| `POST` | `/api/databank/reset-pdf` | Wipe PDF text only (for re-extraction) |
| `GET`  | `/api/databank/browse?path=` | Live filesystem directory listing |

**Changes to `scanner.go`:**
- Remove `postScanFn` / `SetPostScanFn` — no auto-chaining
- `Scan()` / `ScanAsync()` do file indexing only

**Changes to `pdftext.go`:**
- Add cancellation support to `ExtractAll()` — accept a `done <-chan struct{}` parameter
- Workers check `done` channel between files, stop early if cancelled

**Changes to `main.go`:**
- Remove the startup goroutine that auto-runs `scanner.Scan()`
- Read `auto_scan` config key: if `"true"`, run file scan on startup (default: `"false"`)
- PDF extraction is never auto-triggered

**Deprecate `POST /api/databank/reextract`:**
- Remove the old endpoint — `reset-pdf` + `scan/pdf` replaces it cleanly

**Mutual exclusion (backend-enforced):**
- Scanner tracks an `activeOp` field: `""`, `"file"`, or `"pdf"`
- `POST /api/databank/scan` returns 409 if `activeOp != ""`
- `POST /api/databank/scan/pdf` returns 409 if `activeOp != ""`
- This prevents concurrent operations regardless of frontend state

**Cancellation architecture:**
- Scanner holds a single `cancelCh chan struct{}` and `cancelFn func()`
- `ScanAsync()` sets `activeOp = "file"`, creates `cancelCh`, passes it to `scanWorker`
- New `ScanPdfAsync()` sets `activeOp = "pdf"`, creates `cancelCh`, passes it to `ExtractAll`
- `StopScan()` closes `cancelCh` — works for whichever operation is active
- `ExtractAll` receives `done <-chan struct{}` and checks it between files AND passes a derived `context.Context` to `ExtractOne`, so cancellation also interrupts the per-file 2-minute timeout (stop takes effect immediately, not after up to 2 minutes)
- On completion, operation clears `activeOp` and `cancelFn`

**Breaking change note:**
- Auto-scan on startup is now OFF by default. Existing deployments that relied on automatic scanning must enable `auto_scan` in settings after upgrading. Document in release notes.

### 2. Live Filesystem Browser (Backend)

New endpoint `GET /api/databank/browse?path=<relative>` returns a directory listing from `ScanRoot()`:

```json
{
  "path": "Apple/MacBook",
  "entries": [
    { "name": "820-00165", "is_dir": true },
    { "name": "820-00165.brd", "is_dir": false, "size": 524288, "mod_time": 1711234567, "file_type": "board" },
    { "name": "820-00165.pdf", "is_dir": false, "size": 1048576, "mod_time": 1711234567, "file_type": "pdf" }
  ]
}
```

- Only returns supported file types (board + PDF extensions) plus directories
- Skips hidden directories (`.previews`, `.git`, etc.)
- Path is relative to `ScanRoot()`, validated to prevent directory traversal
- Symlinks resolved via `filepath.EvalSymlinks` — rejected if resolved path escapes `ScanRoot()`
- Empty `path` returns root listing

### 3. Frontend: Library Panel Changes

**Scan buttons (replace single "Scan" button):**
- "Scan Files" — triggers file indexing (`POST /api/databank/scan`)
- "Scan PDFs" — triggers PDF text extraction (`POST /api/databank/scan/pdf`)
- Both show "Stop" when their respective operation is running
- Buttons disabled during the other operation (one at a time)

**Folders tab mode switch:**
When the "Folders" tab is active, show a toggle between:
- **Database** — current behavior, shows indexed tree from DB
- **Live** — live filesystem browser, lazy-loads directories on expand

In Live mode:
- No Scan buttons shown (irrelevant)
- No PDF search (no indexed text)
- Clicking a file opens it in the viewer (same as Database mode)
- Expanding a folder fetches `GET /api/databank/browse?path=<folder>`
- Current directory cached in component state (not persisted — always starts at root)

**Scan state persistence:**
- Store last `ScanStatus` in `localStorage` key `'boardripper-scan-status'` (fast-path cache for instant display)
- Backend is source of truth — `GET /api/databank/scan/status` returns persisted state from config table on restart
- On page load, restore from localStorage for immediate display, then fetch from backend to reconcile
- If backend reports `running` or `pdf_running`, resume polling; otherwise display backend state and update localStorage
- Never auto-trigger a scan from the frontend
- After reset operations, clear localStorage cache and refresh file list + tree

**Debug logging:**
- Use existing `log.scan.*` scope for all scan-related events
- Log: scan started, scan completed with stats, individual file changes (when verbose), PDF extraction progress, errors
- Frontend logs scan status transitions: `log.scan.log('File scan complete: +5 added, 0 deleted, 42ms')`

### 4. Settings Panel: "Server / Library" Section

Expand the existing section with:

**Auto-scan toggle:**
- Checkbox: "Auto-scan files on startup"
- Writes `auto_scan` config key to backend (`PUT /api/config`)
- Default: off

**Browse mode:**
- Radio or toggle: "Folder view mode" — `Database` / `Live`
- Stored in localStorage `'boardripper-library-browse-mode'`

**Database info (read from `GET /api/databank/stats`):**
- Board files: `N`
- PDF files: `N`
- Bindings: `N`
- Database size: `N MB`
- Last scan: `<timestamp>` or "Never"
- PDF scan errors: `N` (clickable → opens error list or navigates to debug panel)

**Database actions:**
- "Reset Database" button — `POST /api/databank/reset` — clears all indexed data (files, bindings, text, errors). Confirmation dialog before executing.
- "Reset PDF Text" button — `POST /api/databank/reset-pdf` — clears extracted text only (keeps file index and bindings). Useful before re-extraction.

### 5. Backend: Stats Endpoint

`GET /api/databank/stats` returns:

```json
{
  "boards": 57,
  "pdfs": 72,
  "bindings": 45,
  "pdf_pages": 3200,
  "pdf_errors": 3,
  "db_size_bytes": 15728640,
  "last_file_scan_at": 1711234567,
  "last_pdf_scan_at": 1711230000
}
```

- `db_size_bytes`: sum of `databank.db` + `databank.db-wal` + `databank.db-shm` (WAL mode uses all three)
- `last_file_scan_at` / `last_pdf_scan_at`: stored in config table after each respective operation completes
- `pdf_errors` count sourced from `SELECT COUNT(*) FROM pdf_scan_errors` (accumulated across all scans)
- `ScanStatus` gains `pdf_completed_at int64` field — set when PDF extraction finishes, persisted alongside file scan's `completed_at`

### 6. Backend: Reset Endpoints

`POST /api/databank/reset`:
- Delete all rows from: `pdf_text`, `pdf_pages`, `bindings`, `pdf_scan_errors`, `files`
- Delete all preview PNGs from `.previews/`
- Clear `last_scan_status`, `last_file_scan_at`, `last_pdf_scan_at` config keys
- Return `{"status": "reset"}`

`POST /api/databank/reset-pdf`:
- Delete all rows from: `pdf_text`, `pdf_pages`, `pdf_scan_errors`
- Clear `last_pdf_scan_at` config key
- Return `{"status": "reset"}`

Both refuse to run if a scan is currently active (return 409 Conflict).
Reset holds the scanner mutex for the entire operation to prevent a scan from starting mid-reset.

## Files Affected

**Backend:**
- `src/backend/databank/scanner.go` — remove postScanFn, add config-driven auto-scan
- `src/backend/databank/pdftext.go` — add cancellation support
- `src/backend/databank/db.go` — add stats query, reset methods, browse query
- `src/backend/handlers/databank.go` — new endpoints (scan/pdf, stats, reset, browse)
- `src/backend/main.go` — conditional auto-scan, new route registrations

**Frontend:**
- `src/frontend/src/store/databank-store.ts` — split scan methods, localStorage persistence, live browse fetching
- `src/frontend/src/panels/LibraryPanel.tsx` — two scan buttons, folders mode toggle, live browser UI
- `src/frontend/src/panels/SettingsPanel.tsx` — DB info, auto-scan toggle, browse mode, reset buttons

## Out of Scope

- Electron mode changes (scanning via IPC is separate)
- File upload/management from live browser (read-only browsing)
- Partial/incremental PDF extraction (extract specific files)
