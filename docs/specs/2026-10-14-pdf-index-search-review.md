# PDF text index and search — review and improvement plan

Date: 2026-10-14. Scope: `src/backend/pdfindex/`, `src/backend/handlers/pdfindex*.go`, the
wiring in `src/backend/main.go`, `src/frontend/src/pdf/pdf-index-client.ts`, the index and
search parts of `pdf-store.ts`, `databank-store.ts`, `LibraryPanel.tsx`, `SettingsPanel.tsx`.
Trigger: "PDF index / PDF search stalls on many users' devices".

Raw material (five agents, read-only, all under
[`2026-10-14-pdf-index-review-evidence/`](2026-10-14-pdf-index-review-evidence/)):
`backend-review.md` (code review + two benches), `frontend-review.md`, `test-report.md`
(Go experiments, synthetic 200k- and 500k-page indexes), `field-evidence.md` (the live NAS
install, read-only), `docs-audit.md` (doc vs code, test inventory). The experiment source
is `experiments_test.go.txt`; the bench generator `gen-bench-db.py`.

## 1. What actually stalls

Three mechanisms, all confirmed. They look like one symptom from the outside.

**A. Search ranks the whole match set.** `SearchPages` / `SearchPagesStream`
(`search.go`) run `… WHERE pdf_text MATCH ? ORDER BY rank LIMIT 1000`. FTS5 then computes
BM25 for every matching page before it can return the first row. On a schematic corpus a
term like `10UF`, `25V`, `PP3V3`, `C` or `1` matches nearly every page, so the cost is the
size of the index, not of the answer. Measured on the 500k-page synthetic index: about 1 s
per 500k matches warm; `LIMIT 100` is no faster than `LIMIT 1000`; dropping `snippet()`
saves 3–10 %. An unranked scan returns the same first 1000 pages in 0–23 ms for multi-term
queries and 0.4–0.6 s for one-character terms. The live NAS index has 1.9 M pages in a
15 GB file on a host whose swap is full: `10UF 25V` took 96 s, `PP3V3` 29 s, `C`/`1`/`U`
did not answer within 120 s.

**B. A slow search takes the rest of the API with it.** The search cursor has no context
(`search.go:99`, the handler ignores `r.Context()`), so an aborted or superseded search
runs to the end on the server. The reader pool has four connections (`db.go:34`), shared
with `Stats`, `Status`, `ListFailed` and the sweep's own `DoneOrActiveFileIDs`. The
frontend polls progress + stats every 1.5 s with no in-flight guard and no fetch timeout
(`databank-store.ts:1593–1608`). Four searches in flight → every stats call queues → the
browser's six-connection cap fills with queued polls → file opens, board loads and the
library all wait. On the NAS `/api/pdfindex/stats` did not answer within 60 s while
`/api/health` answered in 39 ms. `Stats` itself is 1.5 ms warm; it was starved.

**C. The indexer leaves work behind and re-does known-bad work.** Failed files are
re-claimed on every sweep start: `enumeratePending` skips only
`indexed|empty|duplicate|indexing` (`store.go:322`), `Claim` wins on `failed`
(`store.go:43`), and there is no attempt counter. The per-file kill is a flat 2 minutes
(`engine.go:61`), and the timeout path discards every page extracted so far
(`engine.go:142–151`). Dense pages cost ~55 ms each on an M-series Mac and the apollolake
NAS is ~7× slower, so the kill lands around page 300–400 of a dense PDF: the NAS log shows
exactly that, five kills within four minutes of boot on 20–27 MB / 500–3,400-page PDFs
(`page 408/504`, `1153/1637`, `1078/1780`, `803/2504`, `1131/3463`), every boot. After the
kill the `extract` goroutine keeps calling `GetPageText` on the dead instance for every
remaining page (5,315 `instance is closed` log lines on the NAS). Rows that the watchdog
reclaims, or that a scan marks pending, trigger no run: the NAS has had one `indexing` row
and seven `pending` rows idle for two days with `running:false`.

Hypotheses from the first read that the evidence **refuted**: pdfium pool exhaustion after
`Kill()` (slots are freed, every file gets a fresh module; measured, T2); `snippet()` cost
(T3c); `COUNT(*)` in `Stats` (1.5 ms warm, starved not slow); the unwrapped routes as an
auth hole (there is no auth on `/api/*` at all — `read`/`write` are timeouts only,
`main.go:203–204`; the doc's "auth cookie" claim is false); enumeration cost (`H10`, uses
the partial `idx_files_content_hash`).

## 2. Field evidence (live NAS, 2026-10-14, read-only)

| | |
|---|---|
| Host | Synology, 4 cores, 5.8 GB RAM, swap 5519/5519 MB used, ~10 other containers |
| Container | no memory limit (`HostConfig.Memory=0`, so no GOMEMLIMIT), RestartCount 0, 69 MiB idle |
| `pdfindex.db` | 15.0 GB, WAL 9 MB |
| `pdf_index_status` | indexed 64,282 · empty 5,779 · failed 92 · pending 7 · duplicate 3 · indexing 1 |
| `pdf_pages` | 1,902,700 rows |
| failed causes | 86 `incorrect format` / `invalid password` (fast, harmless), 6 two-minute timeouts |
| stuck | file 110420 `indexing` since 2026-10-11 20:55 with 15 pages stored; 7 pending with 0 pages; pool idle |
| search | `10UF 25V` 96 s · `PP3V3` 29 s · `C`, `1`, `U` > 120 s · `/stats` > 60 s · `/health` 39 ms |

The local dev container has an empty index and shows nothing. The NAS `sqlite3` has no
FTS5, so SQL could not be timed in isolation there; the synthetic benches stand in.

## 3. Findings

Severity: **B** blocker, **H** high, **M** medium, **L** low. "Measured" = reproduced with
numbers; "code" = confirmed by reading; "plausible" = needs a device.

### Search

| id | sev | where | finding | fix |
|---|---|---|---|---|
| S1 | B, measured | `search.go:47–52, 103–108` | `ORDER BY rank` scores every matching page; cost ∝ index size for common terms (§1A). | Unranked streaming scan with caps (§4 Phase 1). |
| S2 | B, measured | `search.go:32–33, 86–87` | Donor scope `AND pdf_text.rowid IN (SELECT rowid FROM pdf_pages WHERE file_id IN (…))` makes FTS5 probe `rowid = ?` per page + temp b-tree sort: `"gnd"*` 0.21 s unrestricted → **87 s** restricted to 2,000 files / 34k pages; even 10 files cost 0.40 s. Join on `pdf_pages` → 0.44 s; FTS5 inner query filtered outside → 0.037 s. Used by "Search in donors", the Bench tab and MCP `pdf_search`. | Rewrite as join/outer filter; ids via `json_each` or a temp table (32,766 variable cap). |
| S3 | H, code | `search.go:99`, `handlers/pdfindex.go:508, 538` | No `QueryContext`; `emit` discards write errors; aborted searches run to completion. modernc honours ctx (`stmt.go:295`). | `QueryContext(r.Context())` in both search paths, `Stats`, `Status`; a server deadline per search. |
| S4 | H, measured | `db.go:34`, `databank-store.ts:1593–1608`, `pdf-index-client.ts:48` | 4-conn reader pool shared with stats/status/enumeration; poll has no in-flight guard or timeout → queue → browser connection cap → whole UI waits (§1B). | Skip a tick while one is pending; `AbortSignal.timeout(10 s)`; separate (or larger) reader pool for search vs status. |
| S5 | M, measured | T3b | WAL grows unbounded (~27 MB/s) whenever readers overlap continuously and never shrinks after; bounded (13 MB) with the writer alone. On a NAS this is the disk filling during a sweep with an open search tab. | `journal_size_limit`; `wal_checkpoint(TRUNCATE)` at sweep end; S3 shortens readers. |
| S6 | L, code | `search.go:123–135`, `LibraryPanel.tsx:1275` | No minimum term length; a one-character prefix is a full scan. Operators are neutralised (quoted + `*`), porter stems prefixes (superset, harmless). | Require ≥ 2 characters, say so inline. |
| S7 | L, measured | T3c prefix | `prefix='2 3 4'` is ~34 % of the file (≈5 GB of 15 GB); without it `C` is 2× slower, multi-term unchanged. | Decide in Phase 4; needs a full reindex to change. |

### Indexer

| id | sev | where | finding | fix |
|---|---|---|---|---|
| I1 | B, measured | `indexer.go:281–297`, `store.go:43, 322` | Failed files re-claimed every sweep, forever; no attempts, backoff or quarantine (§1C). | `attempts` column incremented at **Claim** (so a crash mid-file counts); skip at ≥ 3; "Retry failed" resets. |
| I2 | B, measured | `engine.go:61, 142–151, 177–201` | Flat 2-minute kill; partial pages discarded; after the kill the page loop keeps running on the dead instance (5,315 log lines, CPU on a dead module). | Deadline = base + per-page allowance; keep pages extracted so far and finalize them (`progress` already knows the page reached); abort the loop on the first `instance is closed`. |
| I3 | H, code+field | `indexer.go:465–467`, `main.go:378–380, 455–461` | `ReclaimStale` and the scanner's `MarkPending` trigger nothing; auto-resume fires only at boot and after a scan with changes. Reclaimed/pending rows wait for a human (NAS: 8 rows idle two days). | Run after a reclaim > 0; at sweep end, re-run if pending rows exist or the lane is non-empty. |
| I4 | H, plausible | `databank/db.go:1506`, `main.go:365`, `engine.go:22`, `serve.go:27` | OOM loop has no brake: `ORDER BY id`, boot requeue, same file first; two workers × 512 MiB wasm cap + raw PDF in heap + pdfium's copy > 1 GiB on a 1 GB install. wazero memory is Go heap, so GOMEMLIMIT sees it, GC thrashes at the limit (halves speed, feeds I2) before any kill. Measured: compile 255 MiB heapSys/worker, an 18 MiB PDF peaks 171–196 MiB. | I1's attempts-at-Claim; log the file name **before** extract; `PDFINDEX_POOL_MAX` default 1 when cgroup < 2 GiB; skip PDFs over a size cap on small installs. |
| I5 | M, code | `handlers/pdfindex.go:93–118`, `indexer.go:173–175` | `Reindex` / `ReindexWatermark` / `SetAutoResume` call `Run()`, a no-op while a sweep runs, and answer `running:true`; the reset rows are not in the running list. Every watermark-term change goes through this. | Record a `rerun` flag consumed by the sweep's deferred cleanup, or use the Restart sequence. |
| I6 | M, measured | `indexer.go:365`, T4 | `Enqueue` after the sweep's workers exit sits in the channel until the next sweep (status stays `''`); 256-slot drop is silent. `Submit` tight loop lost 0 of 12,000, so the window is narrow. | At sweep end drain the lane into a follow-up run. |
| I7 | M, code | `handlers/pdfindex.go:196–197` | `PriorityIndex` does `Run()` + `Enqueue`: one PDF whose pdf.js extraction failed starts a full-library sweep, auto-resume setting ignored. `Submit` already does the right thing. | Call `Submit`. |
| I8 | M, measured | `store.go:56` (never called), T5 | No heartbeat; a live job older than the reclaim age is flipped to pending and, with a free worker, extracted twice. Production (600 s, 5-min tick) only hits this on a job stuck > 10 min, so it is latent. Docs say 1 min / 2 min; code says 5 min / 600 s. | Keep 600 s, heartbeat per N pages from `extract`'s progress, fix the docs. |
| I9 | M, code | `engine.go:67–82`, `indexer.go:407` | Engine init failure: every sweep still reads each PDF fully before "pdfium unavailable"; kicks are not gated on `engine.Ready()`; surfaced only as failed rows. | Gate `Run` on readiness; one visible status. |
| I10 | L, code | `handlers/pdfindex.go:84–91`, `store.go:233` | `ResetPdf` uses `Stop()` not `StopAndWait`: a draining worker writes into the recreated DB. `Restart` blocks the request up to ~3 min. | `StopAndWait`; make Restart async. |
| I11 | L, code | T1 | `go test -race ./pdfindex/...` fails: `TestSubmitMidSweepReachesUnlistedFile` writes the fake source's map while a worker reads it (`indexer_test.go:404`). Test-only. | Mutex in the fake. |

### Frontend

| id | sev | where | finding | fix |
|---|---|---|---|---|
| U1 | H, code | `pdf-index-client.ts:47–57, 110–122`, `main.go:571–589` | A backend whose `pdfindex.db` failed to open registers no index routes; the SPA fallback serves `index.html` with **200** for `/api/...`. `jfetch` → null → "not indexed" → `begin` "succeeds" → the whole text is PUT to the SPA handler; search reads HTML → "No results"; counters blank. No "PDF search unavailable" state exists; 401/5xx/down look the same. | `pdfIndexState: unknown/ok/unavailable(+reason)` in `databankStore`; `jfetch` returns `{ok,status,data}`; parse `begin`'s JSON before uploading; backend answers JSON 503 on those paths and 404 on unknown `/api/*`. |
| U2 | H, code | `databank-store.ts:1910–1946`, `LibraryPanel.tsx:347–355, 1327` | Any failed, torn or buffered stream (404/5xx, `error` line, no `done`, proxy buffering NDJSON, Cloudflare 100 s → 524) ends as **"No results for …"**. No client timeout, no cancel while searching. | Stream returns `done/failed/aborted`; idle watchdog; `pdfSearchState` with a failure strip + Retry; Search button becomes Cancel. |
| U3 | H, code | `pdf-index-client.ts:104–168`, `store.go:138–144` | PUT and finalize never check `res.ok`: a 5xx on one batch → `Finalize` counts what landed → **`indexed` with holes, terminal**. `status`/`begin` outside the `try` → unhandled rejections, nothing in `log.pdf`. Tab close between `begin` and `finalize` parks the row `indexing` for 10 min and re-opens do nothing (`status==='indexing'` → return). | `if (!r.ok) throw` on every call; move `status`/`begin` into the `try`; `pagehide` → `/fail` with `keepalive`; on re-open with `indexing` and no in-flight task → `priorityIndex`. |
| U4 | M-H, code | `databank-store.ts:1593–1628`, `SettingsPanel.tsx:1191` | "Index all" fires `run()` and the first poll concurrently (poll can read `running:false` and stop). Null answers keep the interval alive for ever while the strip says idle. Backend-started sweeps are only noticed on mount. Enumeration window shows `0/0`. | Await `run()`; miss counter → `unavailable`; pause while hidden; "counting files…" for `total===0 && running`. |
| U5 | M, code | `LibraryPanel.tsx:634–652`, `pdf-store.ts:780` | Opening a hit waits ≤ 10 s for the page's text, then searches partial text → viewer `0/0` with a "Library ⌕" button back: a loop on slow devices. A synthesized row (`mod_time:0`) defeats the text cache key. | Fetch the row (`fetchFileRows`); wait on "page present or extraction finished" (60 s) with the extraction progress shown. |
| U6 | M, code | `LibraryPanel.tsx:303, 1103–1119`, `build-mode.ts:14–18` | Lite and desktop builds fire `/api` search and index calls (raw `fetch`, not `apiFetch`) and claim "No results"; `ensureIndexed` is gated on `isLiteBuild()`, not `hasBackend()`, so every desktop PDF open throws against `file://`. | Gate both on `hasBackend()`; the tab explains that text search needs the server. |
| U7 | L-M, code | `pdf-store.ts:681–694, 1009–1012` | "The backend pass covers it" is true only for drops (`SetPdfSubmitHook`); a library open whose extraction throws on one page is never indexed and never falls back. | In the catch with a `fileId`, `priorityIndex` (→ `Submit`). |
| U8 | plausible | `middleware_security.go:53–85` | Reverse proxy that rewrites `Host` → 403 on every index mutation (`begin`, `run`, `reindex`, watermark `PUT /api/config`), GETs pass: search works, nothing new is ever indexed, buttons do nothing, and the frontend swallows the 403. | Log + one toast naming the Host header. |

### Docs and tests

| id | finding |
|---|---|
| D1 | `docs/PDF_VIEWER.md` "PDF text index": watchdog 1 min / 2 min (code: 5 min / 600 s); five states (code: six, `duplicate` missing); API tables miss `restart`, `auto-resume` GET/POST, `index-folder`, `search/stream`, `reset-pdf`; "index-folder was dropped" (still registered, `main.go:428`); "all routes require the auth cookie" (no auth exists); `Heartbeat` "refreshes attempted_at" (never called); `finalize` body `total_pages` is ignored. Full table in `docs-audit.md`. |
| D2 | No unit test covers the frontend index/search path; `pdf-index.spec.ts` and `pdf-search.spec.ts` need a backend plus proprietary samples and skip on every other machine; `pdf-search.spec.ts` hardcodes `localhost:8080`. Nothing covers: search against 404-HTML / 5xx / a stream without `done`; the poll against null; `ensureIndexed` against a failed PUT; the lite PDF tab; attempts/quarantine; proportional timeout with partial pages; reclaim-triggers-run; donor-scope cost. |

## 4. Plan — iterative, each phase shippable on its own

Every phase ends with a `devdeploy.sh --head` to rd-nas:1234 and a measurement on the
real 15 GB index, because nothing here reproduces on an empty dev container. The numbers
to watch are in each phase's exit line. Phases are ordered by field impact; 1 and 2 are
independent and can ship in either order.

### Phase 0 — see what the field is doing (half a day)

- Log one line per file **before** extraction (`indexer.go:407`, name + size + page count
  once known) and one at sweep start/end with the pending/failed/reclaimed counts.
- Abort the page loop on the first `instance is closed` error (I2, the log-spam half).
- `Stats`, `Status`, both search paths take `r.Context()` (S3). No behaviour change for a
  healthy call; aborted searches stop.
- Frontend poll: in-flight guard + `AbortSignal.timeout(10_000)` (S4). Exit: on rd-nas,
  with one 1-char search running, `/api/pdfindex/stats` answers in < 1 s.

### Phase 1 — search answers in seconds on a 15 GB index

Design: the UI shows one row per file with a hit count and the lowest page; BM25 page
rank was never visible, so it is not paid for.

- One streaming scan, unranked, with `QueryContext`:
  `SELECT p.file_id, p.page_num, t.rowid FROM pdf_text t JOIN pdf_pages p ON p.rowid = t.rowid WHERE pdf_text MATCH ?`,
  donor scope as `AND p.file_id IN (SELECT value FROM json_each(?))` (S2, no variable cap).
  Emit a file the first time it appears (the stream shape today), compute `snippet()` only
  for emitted files with a second `MATCH ? AND rowid = ?` query (≤ 1000 small queries).
- Caps: stop at F distinct files (500), P pages (50,000) or a deadline (10 s); the `done`
  line carries `partial:true` and the counts seen so far. If the scan exhausts before a cap
  the result is complete and the per-file counts are exact.
- Order: files by hit count (the client already re-sorts on the `counts` line).
- Reject terms under 2 characters with an inline message (S6).
- `GET /api/databank/search` (MCP, Bench tab) uses the same scan with the same caps.
- Keep the old ranked query behind a flag for one release for A/B on the NAS.
- Tests: Go test on a 500k-page bench that the new scan returns in < 100 ms for
  `"10UF 25V"` and < 1 s for `"C"`, and donor scope over 2,000 files in < 0.5 s;
  `-race` clean (fix I11).
- Exit on rd-nas: `10UF 25V` first row < 1 s, done < 10 s (was 96 s); `C` answers (was
  never); search in donors over the whole donor set < 5 s.

### Phase 2 — the indexer finishes and stays finished

- `attempts` column (additive `ALTER`, like `canonical_file_id`), incremented in `Claim`;
  `DoneOrActiveFileIDs` skips `attempts >= 3` regardless of status; "Retry failed" resets
  attempts; the failed list shows the attempt count (I1, I4).
- Deadline = 120 s + 1 s/page known after `FPDF_GetPageCount`, capped (e.g. 20 min);
  on timeout **keep** the pages reached and finalize them (status `indexed`, error text
  "partial, stopped at page N of M") instead of failing (I2). Heartbeat every 50 pages
  from `extract` (I8).
- Triggers: `ReclaimStale` > 0 → `Run()`; at sweep end, if pending rows exist or the
  priority lane is non-empty, one follow-up `Run()` (I3, I6); `Reindex`,
  `ReindexWatermark`, `SetAutoResume` set a `rerun` flag consumed by the deferred cleanup
  instead of a swallowed `Run()` (I5); `PriorityIndex` calls `Submit` (I7).
- Memory: `PDFINDEX_POOL_MAX` default 1 when the cgroup limit is < 2 GiB; skip PDFs over
  256 MiB on such installs with a `failed` row that says so (I4).
- `ResetPdf` uses `StopAndWait` (I10).
- Tests: attempts counted at Claim across a simulated crash (row left `indexing`, process
  restarted); partial pages kept on timeout; reclaim triggers a run; reindex while running
  reaches the reset rows; `Enqueue` after the last worker exits is processed.
- Exit on rd-nas: after one boot, no file is extracted twice across two consecutive sweeps;
  the six big PDFs end `indexed (partial)` or quarantined, not re-run every boot; zero
  `pending`/`indexing` rows one hour after a scan.

### Phase 3 — the UI tells the truth

- `pdfIndexState` tri-state + reason, surfaced in the PDF Search tab, the Library strip
  and the Settings card ("PDF text search is not available on this server: HTTP 404"),
  following the status-message rules in CLAUDE.md (U1, U4). Backend: JSON 503 on index and
  search paths when `pdfIndex == nil`; 404 for unknown `/api/*` instead of `index.html`.
- `searchPdfsStream` returns `done/failed/aborted`; failure strip with Retry; Cancel while
  searching; `partial` rendered as "first N files, refine the search" (U2).
- `ensureIndexed`: check every response, `status`/`begin` inside the `try`, `pagehide` →
  `/fail` with `keepalive`, re-open of an `indexing` row with no in-flight task →
  `priorityIndex` (U3). Extraction failure on a library open → `priorityIndex` (U7).
- `hasBackend()` gates for lite and desktop (U6); 403 toast naming the Host header (U8);
  hit-open waits on extraction progress, not a 10 s cap (U5).
- Tests: a route-mocked Playwright spec in the `library-unreachable-state` style — sample
  the tab text every 50 ms through 404-HTML, 502, a stream that never sends `done`, an
  `error` line, and a `pdfindex`-less backend — failing on any "No results" claim before
  the source answered. Vitest for `searchPdfsStream` outcomes and the poll guard.

### Phase 4 — storage

- `journal_size_limit` on both connections; `wal_checkpoint(TRUNCATE)` at sweep end and
  when `ReclaimStale` runs with the pool idle (S5).
- Decide the prefix index (S7): keeping `prefix='2 3 4'` costs ~5 GB of the NAS file and
  only helps one- and two-character terms, which Phase 1 rejects or scans unranked anyway.
  Dropping it needs a full rebuild (`ResetAll` + sweep), which on the NAS is days; offer
  it as a one-time "Rebuild compact index" action, not a migration.
- FTS5 `optimize` after a full sweep (segment merges; never run today).
- Exit: WAL stays under `journal_size_limit` through a sweep with a search tab open.

### Phase 5 — docs and the regression floor

- Rewrite the "PDF text index" section of `docs/PDF_VIEWER.md` from the code (D1): six
  states, real watchdog numbers, every route with its wrapper, no auth claim, the scan
  design and caps from Phase 1, attempts from Phase 2.
- Update the CLAUDE.md paragraph.
- Make `pdf-index.spec.ts` / `pdf-search.spec.ts` run on the public fixtures
  (`tests/fixtures/*.pdf`) against a scratch backend, so they stop skipping everywhere.

## 5. Decisions for the maintainer

1. **Unranked search as the default** (Phase 1). It changes result order from BM25 page
   rank to hit count per file. The UI never showed page rank, and a rare part number is
   fast either way; the trade is only visible on common terms, where the old order was
   paying 30–96 s for a ranking nobody could see.
2. **Partial index on timeout** (Phase 2): a 3,000-page PDF stopped at page 1,100 becomes
   searchable for those pages and is marked partial, rather than retried every boot.
3. **Prefix index** (Phase 4): keep (no rebuild, 5 GB) or offer the compact rebuild.
4. **Memory on the NAS itself**: the live container has no memory limit and the host's
   swap is full; a `mem_limit` in its compose file would at least make GOMEMLIMIT take
   effect. Not a code change.
