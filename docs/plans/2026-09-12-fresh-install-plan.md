# Fresh install — implementation plan

Findings: [docs/specs/2026-09-12-fresh-install-review.md](../specs/2026-09-12-fresh-install-review.md).
Five fixes, one new modal. Order = commit order.

## A. First-run setup modal  *(covers 3, 4, 5)*

`components/FirstRunSetup.tsx`, same `.library-modal-*` shell as `FZKeyDialog`.

**Trigger is server state, not localStorage:** show when `backendAvailable && !lite`
and `stats.last_file_scan_at === 0 && boards + pdfs === 0`. `db.ResetAll` already
deletes `last_file_scan_at` and empties `files`, so the modal comes back after a
reset by itself. "Skip" hides it for this page load only (sessionStorage).

`resetAll()` in `databank-store.ts` ends with `location.reload()` — the reset
today leaves the old file list, stats and folder tree half-cleared in memory.

Contents:

```
Set up your library                                   /library · Big, Samples
─────────────────────────────────────────────────────────────────────────────
Index files          starts now, ≈200 files/s, everything depends on it
PDF text             starts by itself after the files are in, runs in the
                     background — nothing to click
☑ Link boards to their PDFs automatically      (auto_bind)
☑ Download OpenBoardData — 109 boards, ~2 min,  (obd fetch-all)
   community data under ODbL, from openboarddata.org
☑ Re-index on every start                       (auto_scan)
                                              [Skip for now]  [Start]
```

The two mounted-folder names come from `/api/databank/browse?path=` (instant,
needs no index) so the user sees the mount worked before indexing starts.

**Start** = `PUT /api/config` ×3 → `POST /api/databank/scan` → if OBD ticked,
`POST /api/obd/index/sync` then `POST /api/obd/fetch-all`. Modal closes; the
Library statsbar shows the scan.

**Settings ▸ Library ▸ Scanning & Indexing** gets the missing `auto_bind`
checkbox ("Link boards to PDFs automatically during scans") — the backend has
had the key since v0.16 and the frontend never exposed it, which is why nobody
knows where auto-binding happens.

## B. Auto-bind fast enough to default on  *(prerequisite for A)*

`scanner.go` `autoMatchBindings` is `boards × pdfs` with one DB query per board
— on the rig that is 52 k × 7.5 k = 390 M `MatchScore` calls; hence "adds hours"
and off by default.

The score rules already limit which pairs can bind: cross-folder needs ≥ 80
(same base name, or the board's `820-NNNNN` inside the PDF name); everything
else must be same-folder. So build three maps once — PDFs by folder, by
lower-cased base name, by every `820-\d{5}` in the name — and score each board
only against its folder's PDFs ∪ the two hash hits. Bound-board ids come from
one `SELECT DISTINCT board_file_id`. Inserts go in one `WriteTx` batch.

Same `MatchScore`, same thresholds → byte-identical bindings; ~1.6 M scorings
instead of 390 M. Unit test: old and new matcher produce the same set on a
fixture with same-folder, cross-folder-80, cross-folder-50 (rejected) and junk
cases.

## C. Library fills while the scan runs  *(1)*

`databank-store.ts` `_startScanPolling`: while `running`, call the existing
`fetchFiles()` + `fetchTree()` on a backoff — **5, 10, 20, 40 s, then every
60 s** — behind `_drainFilesInflight()`. Post-scan refresh unchanged.
Measured: the 60 k-row stream is 0.6 s, so the early refreshes are cheap and
the user sees rows within seconds instead of after 5 minutes.

`main.go`: move `pdfindex.NewEngine` into the boot goroutine; PDF-index routes
503 until ready. Removes the 10 s of connection-refused on every start.

`scanner.go:525`: one log line per batch, not per file.

## D. BindPicker no longer freezes  *(2)*

`LibraryPanel.tsx` `BindPicker`: render `filtered.slice(0, 200)` + a footer
`… N more — type to narrow` with **Show all**; debounce the filter 150 ms with
the file's existing `useDebounced`; run `scored` behind the same debounce.
Measured today: 251 ms to open and 66–98 ms per keystroke at 7.5 k PDFs,
linear — 200 rows is under one frame. E2E: seed 5 k PDFs, open picker, assert
≤ 200 rows.

## E. OpenBoardData fetch-all  *(5)*

Backend `obd/fetchall.go`: runner shaped like `databank.DedupRunner`
(`Progress` / `Stop` / single-flight), walks `index.json`, skips `IsFetched`,
1 req/s, reuses `Scraper.FetchBoard` + `Store.WriteBoard`. Routes
`POST /api/obd/fetch-all`, `…/stop`, `GET …/progress`.

Frontend: `obdStore.fetchAll()` + progress polling (mirror `startDedupPolling`);
on completion clear `_matchesByBn` so open boards re-match. Settings ▸ Library ▸
OpenBoardData: **Download all boards** with `n of 109 cached` next to *Sync OBD
index*.

One helper `obdBoardNumberFor(tab)` — resolved databank `board_number` when the
tab came from the Library, else today's filename regex — used at the five
viewer call sites (`BoardViewerPanel:145`, `BoardRenderer:6109`,
`BoardSidebar:277,668`, `DiodeValuesButton:16`). Without it a downloaded corpus
only lights up boards whose *filename* carries an `820-`/`LA-` code.

## Verification

- Fresh container (`docker compose` from the README block, empty `/data`, the
  60 k synthetic library): modal appears, Start → rows visible < 10 s, bindings
  created by scan end, OBD cache 109/109, no 10 s boot gap.
- Settings ▸ Reset all → reload → modal again.
- `tests/first-run-setup.spec.ts`, `tests/bind-picker-cap.spec.ts`,
  `databank/scanner_autobind_test.go`.
