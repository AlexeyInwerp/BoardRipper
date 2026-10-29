# PDF index / search backend review — 2026-10-14

Scope: `src/backend/pdfindex/*`, `handlers/{pdfindex,pdfindex_source,donor_indexer,dedup}.go`, `handlers/serve.go` (`readFileEager`), `main.go` wiring, go-pdfium v1.19.3 pool, go-commons-pool v2.1.2, wazero v1.11.0, modernc sqlite v1.50.1. Read-only. Measurements below were taken on this Mac (M-series); the NAS target (apollolake Celeron) is 5–10× slower on CPU and disk-bound — stated where it matters.

Two measurement harnesses in this scratchpad: `gen.py` → `bench.db` (80 000 pages / 4 675 files / 161 MB text / 493 MB file, production schema incl. `prefix='2 3 4'`), and `engbench/` (links the real `pdfindex` package, times `NewEngine` + `ExtractFile` on the sample PDFs and reports Go heap).

## Ranked findings (likelihood of explaining the field symptom first)

### F1 — Failed files are retried on EVERY sweep start, forever; a NAS hits the fixed 2-minute kill at a few hundred pages — blocker, confirmed by code (NAS per-page cost is an estimate)

What the code does:
- `indexer.go:281-297` `enumeratePending` skips only `DoneOrActiveFileIDs()` = `indexed|empty|duplicate|indexing` (`store.go:322`). `failed` rows are *in* every sweep's work list and `Claim` (`store.go:43`, `WHERE status IN ('pending','failed')`) wins on them. There is no attempts column, no backoff, no quarantine.
- `engine.go:61/68` `perFileTimeout = 2 * time.Minute` — a flat wall clock regardless of page count; on timeout (`engine.go:142-151`) every page extracted so far is discarded (the `progress` counter knows the page reached, the pages are not returned).
- Sweeps start from: boot auto-resume (`main.go:455-461`), every scan that added/updated anything (`main.go:402-406`), Settings toggles, Reindex, and `PriorityIndex` (see F7).

Measured (engbench, M-series): `NR2201ZE_2.1.pdf` 18 MiB / 101 pages → 5.56 s = **55 ms/page**; a sparse 87-page PDF 8 ms/page; a 2-page scan 254 ms/page. On an apollolake NAS (CLAUDE.md: ~10 s wasm compile vs 1.5 s here, i.e. ~7×) a dense schematic costs ~350–400 ms/page → **the 2-minute kill lands at roughly 300–350 pages**. Service manuals, datasheet bundles and multi-board schematic packs exceed that routinely.

Failure scenario: library with k such PDFs. Each sweep spends `k × 120 s / 2 workers` on known-bad files, marks them failed again, `Progress.Errors` grows, and the next scan/boot does it again. `Progress.Total` includes the failed rows, so the user sees the same "Indexing N/M (k err)" after every restart — "never finishes / restarts endlessly". With `restart: unless-stopped` and auto-resume defaulting on, nothing the user does short of switching auto-resume off stops it.

Fix (small, in project style):
1. `pdf_index_status.attempts INTEGER NOT NULL DEFAULT 0` (additive `ALTER` like `canonical_file_id` in `db.go:115`); `Fail` does `attempts = attempts + 1`; `Claim` adds `AND (status = 'pending' OR attempts < 3)`; `DoneOrActiveFileIDs` (or a new `SkipIDs`) also returns `failed` rows with `attempts >= 3`. The UI's "Retry failed" (`ResetForReindex('failed')`) resets `attempts` to 0, so a deliberate retry still works.
2. Make the kill proportional: `timeout = 2 min + pageCount × 1 s` (page count is known after `FPDF_GetPageCount`, so start the timer in `extract` after it, or let `ExtractFile` read `progress` and extend once), **and** on timeout return the pages already extracted (`extract` can write into a shared slice guarded by the `progress` atomic; `ExtractFile` returns `pages[:p-1]` + the timeout error, and `process` stores them with `Finalize` → `indexed`/partial). A partial index of a 1 000-page manual beats a permanently failed one.

### F2 — Donor-scoped search is O(pages in the donor set) with a full FTS5 probe per page: 87 s measured on 34 k pages — blocker, confirmed by measurement

`search.go:86-87` (same in `SearchPages`, `:32-33`):
```go
innerWhere += ` AND pdf_text.rowid IN (SELECT rowid FROM pdf_pages WHERE file_id IN (` + strings.Join(ph, ",") + `))`
```
SQLite turns `rowid IN (subselect)` on a virtual table into a loop of `rowid = ?` probes. `EXPLAIN QUERY PLAN` on bench.db: `SCAN pdf_text VIRTUAL TABLE INDEX 32:=M1` + `LIST SUBQUERY` + `USE TEMP B-TREE FOR ORDER BY` — FTS5 re-evaluates the MATCH for every rowid in the list and the ORDER BY rank is no longer consumed by FTS5 (the unrestricted plan is `INDEX 32:M1` with no temp b-tree).

Measured (bench.db, `"gnd"*`):
- unrestricted, production shape: **0.21 s**
- restricted to 2 000 file ids = 33 920 pages, production shape: **87.1 s** (~2.5 ms per restricted page)
- restricted to 10 ids = 172 pages: 0.40 s (already 2× the unrestricted query)
- alternative A — join instead of `rowid IN`: `FROM pdf_text JOIN pdf_pages p ON p.rowid = pdf_text.rowid WHERE pdf_text MATCH ? AND p.file_id IN (…) ORDER BY rank LIMIT ?` → **0.44 s**, plan `INDEX 32:M1` + `SEARCH p USING INTEGER PRIMARY KEY`
- alternative B — FTS5 sorted inner query, filter outside: `SELECT r.rowid, r.rank FROM (SELECT rowid, rank FROM pdf_text WHERE pdf_text MATCH ? ORDER BY rank) r JOIN pdf_pages p ON p.rowid = r.rowid WHERE p.file_id IN (…) LIMIT ?` → **0.037 s**

On a NAS the 87 s is minutes. The donor scope is what the context-menu "Search in donors" path (`LibraryPanel.tsx:303`, pending-search) and the Bench tab use, and `/api/databank/search` (MCP `pdf_search`, `tools_native.go:161`) shares the clause. Nothing aborts it server-side (F3), so every retry stacks another one on the 4-connection reader pool.

Fix: replace the `rowid IN (subselect)` clause with alternative B (or A) in both `SearchPages` and `SearchPagesStream`; the `snippet()` can stay in the outer select because FTS5 computes it only for rows actually stepped (bench: snippet adds ~0.1 s for 1 000 rows, it is not evaluated for every match — the `32` in `INDEX 32:M1` is `FTS5_BI_ORDER_RANK`, FTS5 sorts `(rowid, rank)` internally: `SELECT rowid, rank FROM %Q.%Q ORDER BY …` in `fts5CursorFirstSorted`). Donor id lists ≤ 32 766 placeholders (modernc `SQLITE_MAX_VARIABLE_NUMBER = 32766`) — fine in practice; a temp table would remove the ceiling.

### F3 — A search runs to completion after the client aborts; the 4-connection reader pool is shared with the progress poll, which has no timeout and no re-entrancy guard — high, confirmed by code

- `search.go:99` `db.reader.Query(q, args...)` — no context. `handlers/pdfindex.go:538` passes nothing from `r.Context()`. When the browser aborts a superseded search (`LibraryPanel.tsx:306`, every new search aborts the previous), `enc.Encode` to the dead connection returns an error that `emit` discards (`:508`), `fn` returns nil, and the cursor is drained to the end. modernc **does** honour `QueryContext`: `stmt.go:295 defer interruptOnDone(ctx, s.c, &done)()` → `sqlite3_interrupt`, so a context would actually stop the statement — it is simply not wired.
- `db.go:34` `reader.SetMaxOpenConns(4)`; `Stats()` (`store.go:192-209`), `Status()`, `ListFailed`, `DoneOrActiveFileIDs` (sweep enumeration!) all draw from the same pool with ctx-less calls → they block indefinitely once four searches are in flight.
- `databank-store.ts:1593-1608`: `setInterval(tick, 1500)` where `tick` awaits `progress()` + `stats()` — no in-flight guard, `jfetch` (`pdf-index-client.ts:48`) has no timeout. When the pool is saturated, a new pair of requests is queued every 1.5 s; browsers allow 6 HTTP/1.1 connections per host, so after ~5 s *every* other API call from that tab (file open, board load, library) waits behind them. That is "the whole UI hangs after a PDF search".
- `withTimeout` (`middleware_timeout.go:22-30`) only attaches a deadline to `r.Context()`; no pdfindex handler reads it, so the "30 s read / 10 s write" budgets in `main.go:200-204` are nominal for this feature.

Fix: `SearchPagesStream`/`SearchPages` take a `ctx` and use `QueryContext`; the handler passes `r.Context()` (the net/http server cancels it on client disconnect, which is exactly the abort case). Same for `Stats`/`Status` (`QueryRowContext(r.Context())`), so the `read()` wrapper's deadline becomes real. Frontend: skip a tick while the previous is pending, and give `jfetch` an `AbortSignal.timeout(10_000)`.

### F4 — OOM restart loop has no brake: deterministic order, no poison detection, orphan requeued at boot — high, plausible; needs a field log (`exit 137` + repeated "boot requeued N orphaned 'indexing' row(s)")

Code facts:
- `databank/db.go:1500-1506` `CanonicalPDFs … ORDER BY id` → same order every sweep; `sweep` feeds files in that order (`indexer.go:357`).
- A process killed mid-extraction leaves the row `indexing`; `main.go:365` `RequeueIndexing` flips it to `pending` at boot and `main.go:455-461` resumes → the same file is the first pending one again.
- Memory per worker, measured: engine compile alone **heapSys 255 MiB** (`engbench`, "after init"; RSS 286 MB); extracting an 18 MiB schematic peaks at **171–196 MiB heapInuse** and leaves heapSys at 390→518 MiB (Go retains the arena; `madvdontneed` in the image returns pages but cgroup RSS still spikes at peak). wazero's linear memory is a plain Go `[]byte` (`wazero/internal/wasm/memory.go:91-93`) grown with `append` (`:267`) — so `memory.Grow` briefly holds old+new buffers. Cap per worker 512 MiB (`engine.go:22`), two workers (`PDFINDEX_POOL_MAX=2`), plus the raw PDF in Go heap (`readFileEager`, up to 512 MiB, `serve.go:27/140`) and pdfium's own copy of it inside the wasm heap (`FPDF_LoadMemDocument64`).
- `configureMemoryLimit` (`main.go:40-55`) sets GOMEMLIMIT to 90 % of the cgroup cap. Because the wasm heap is Go heap, GOMEMLIMIT *does* see it — but near the limit the GC runs continuously (Go caps GC at ~50 % CPU under memory-limit pressure), which halves extraction speed and pushes more files into F1's 2-minute kill before any OOM.

Scenario: 1 GB container (README says 512 M boot-fails; many users will have 1 G), two workers each on a 100+ MB datasheet → > 1 GiB → OOM kill → restart → requeue → same two files first → OOM. No row ever reaches `failed`, so F1's attempt counter does not help here unless attempts are counted at **Claim** time (increment on claim, not on fail) — do that: `Claim` sets `attempts = attempts + 1`, and `DoneOrActiveFileIDs` skips `attempts >= 3` regardless of status. Also log the file name *before* extraction (it is only logged on failure today, `indexer.go:409-416`), so a crash loop is attributable from `docker logs`. Default `PDFINDEX_POOL_MAX` to 1 when the cgroup limit is < 2 GiB (`cgroupMemoryLimit` is already there).

### F5 — Reindex / Reindex-watermark / set-auto-resume do nothing while a sweep is running, but report `running: true` — medium, confirmed by code

`handlers/pdfindex.go:93-118`: `ResetForReindex(scope)` flips rows to `pending`, then `_ = h.ix.Run()` → `startScoped` returns `ErrAlreadyRunning` (`indexer.go:235-237`) → swallowed (`:173-175`). The running sweep's work list was enumerated at its start (`indexer.go:263`), so the freshly reset rows are not in it. Response: `{"reset": n, "running": true}`. The rows wait for the next boot / scan-with-changes / click. `ReindexWatermark` is the path behind every watermark-term change, so "I added a watermark term and the index never re-ran" is this. Fix: in those handlers, if `Run()` found a sweep running, call `Restart`'s sequence (`StopAndWait` + `RequeueIndexing` + `Run`), or have `startScoped` record a `rerun` flag that the deferred cleanup turns into one more `Run()`.

### F6 — Reclaims and scanner re-queues never trigger a run; a fast-path orphan is unsearchable for 10–15 min and then waits for the next trigger — medium, confirmed by code; docs disagree with code

- `main.go:360` `StartWatchdog(5*time.Minute, 600)` → a row is reclaimed 10–15 min after its last heartbeat; `docs/PDF_VIEWER.md` ▸ state machine says "every minute … older than 2 minutes". The doc is wrong.
- `indexer.go:465-467`: `ReclaimStale` only logs. A browser tab closed between `begin` and `finalize` leaves a `pdfjs` row `indexing`; the sweep skips it (`DoneOrActiveFileIDs` includes `indexing`); on reopen `ensureIndexed` returns early on `indexing` (`pdf-index-client.ts:109-116`). After reclaim it is `pending` and nothing starts a sweep. On a library that is not rescanned, it stays pending until the next boot.
- The backend path cannot be reclaimed while live: Claim → ReadFile ≤ 30 s → GetInstance ≤ 30 s → extract ≤ 120 s → ReplacePages refreshes `attempted_at`; worst case ≈ 3 min + `db.mu` wait vs the 600 s floor. (`Heartbeat` exists but is unused — fine given the budget.)

Fix: when `ReclaimStale` returns n > 0 (and in `MarkPending`'s caller), call `ix.Run()` if auto-resume is on; or better, `ensureIndexed` treats `indexing` with `attempted_at` older than 10 min as claimable (expose `attempted_at`, it is already in `StatusRow`).

### F7 — `PriorityIndex` starts a full library sweep as a side effect of one file's fallback — medium, confirmed by code

`handlers/pdfindex.go:196-197`: `_ = h.ix.Run(); h.ix.Enqueue(id)`. When idle, `Run()` enumerates the whole library and sweeps every pending **and failed** file (F1), regardless of the auto-resume setting — triggered by any PDF whose pdf.js extraction threw (`pdf-index-client.ts:154-160`). `Indexer.Submit` (`indexer.go:105-128`) already does the right thing (one-file sweep when idle, lane when running); use it here.

### F8 — Engine init failure makes every sweep read every PDF from disk and fail it — medium, confirmed by code; init memory measured

`engine.go:67-82`: on a compile failure `initErr` is set and every `ExtractFile` returns `pdfium unavailable` — but `process` runs `ReadFile` (`indexer.go:407`, a full eager read) **before** `ExtractFile` (`:413`), then `Fail`s. With F1 every sweep re-reads the whole PDF corpus for nothing; the scan-complete hook (`main.go:402-406`) and auto-resume are not gated on `engine.Ready()`. The failure is visible only as `failed` rows (Library "N failed") with error `extract: pdfium unavailable: …` and one log line. Init cost measured: 1.5 s and 255 MiB heapSys on M-series (the NAS takes ~10 s per `docs/specs/2026-09-12-fresh-install-review.md`), so a 512 MB/1 GB box under load can fail the compile. Arch fallback is not a factor: images are `linux/amd64,linux/arm64` only (`release.sh:341`), both wazevo-compiled. Fix: `Indexer` checks `extract` readiness once per sweep (add `Ready() bool` to a narrow interface, or call `engine.Err()` before `ReadFile`) and aborts the sweep with one log line + a `Progress.Error` string the UI can show; gate the scan-complete/auto-resume kicks on it.

### F9 — Priority lane: ids submitted while the sweep is draining sit until the next sweep — medium, confirmed by code

`indexer.go:113-119`: `Submit` sees `running == true` and `Enqueue`s. If the sweep is already past `close(bulk)` (`:365`) — its workers have returned from the `bulk` branch (`:346-348`) and `wg.Wait()` is waiting on the last `process()` (up to ~3 min) — nobody reads `ix.priority` again until the next sweep. The dropped PDF is then "indexed within seconds" only after the next trigger. Same for `EnsureIndexed` (`donor_indexer.go:19-27`) and the `PriorityIndex` handler. The 256-slot buffer drops silently (`:91-96`), relevant for the boot donor backfill (> 256 donors); `RunFiles` covers those, so low. Fix: in `startScoped`'s deferred cleanup, if `len(ix.priority) > 0`, start one more sweep (`Run()`), or make workers keep draining the lane with a short timeout after `bulk` closes.

### F10 — Request handlers that block the HTTP request for minutes or write into a reset DB — low, confirmed by code

- `Restart` (`handlers/pdfindex.go:125`) `StopAndWait` blocks until the in-flight files finish (≤ ~3 min); the `write()` 10 s deadline is not read. The UI's Restart button appears hung.
- `ResetPdf` (`:85`) uses `Stop()` (async) then `ResetAll()`: a worker still inside `process` later calls `ReplacePages`/`Finalize` on the recreated file — stale rows in a "reset" index. Use `StopAndWait`.
- `ResetAll` (`store.go:236`) `db.reader.Close()` waits for in-flight queries — behind an F2 donor search it waits ~minutes while holding `db.mu`, during which every `Claim`/`Fail` blocks.
- `IndexFolder` 409 flow (`LibraryPanel.tsx:709-716`): `stop()` + 600 ms + retry; the sweep is still draining, the second call 409s again and its result is ignored.

### F11 — H1 refuted: `Kill()` does free the pool slot — low

`webassembly.go:366-395`: `Kill` cancels the worker context, deletes the instance ref and calls `InvalidateObject`; `go-commons-pool/pool.go:460-476` → `doDestroy` (`:217-229`) removes it from `allObjects`, calls `DestroyObject` (module close) and **`createCount.DecrementAndGet()`**, then `ensureIdle(1)`. `create` (`:190-211`) allows a new worker once `createCount ≤ MaxTotal`. So after `poolMax` kills `GetInstance` still succeeds. Also: `Config.ReuseWorkers` defaults to false (`webassembly.go:24`), so the normal `Close()` path (`:346-349`) **also** `InvalidateObject`s — every file gets a fresh module instance (which is what frees the linear memory; the engine.go comment about MaxIdle is moot). `WithCloseOnContextDone` is honoured: every pdfium call uses `p.Context` = the worker context (`implementation.go:190/200`), wazevo checks it on entry (`call_engine.go:208-216`) and periodically, so a cancelled context does close the module and the `extract` goroutine returns (recover at `engine.go:160-164`, `done` is buffered) — no goroutine leak. One caveat: the `extract` goroutine's defers run on a closed instance after Kill (harmless errors).

### F12 — H7: WAL and FTS5 maintenance — low, plausible

Single writer behind a Go mutex → `busy_timeout` never engages between our own connections; `DEFAULT_WAL_AUTOCHECKPOINT=1000` applies. Long readers (an F2 donor query, the 1.5 s polls) only delay WAL *reset*, bounded by their duration — F2/F3 fix this. Nothing ever runs `INSERT INTO pdf_text(pdf_text) VALUES('optimize')`/`'merge'`, so FTS5 segment levels grow with the corpus and query cost drifts up; a `merge` after each sweep (bounded, incremental) is cheap insurance. `prefix='2 3 4'` roughly quadruples index size — expected, not a bug.

### F13 — H6: Stats COUNT(*) is cheap — low, measured

`SELECT COUNT(*) FROM pdf_pages` on 80 k rows: 0.6 ms warm (covering index scan). Cold on a NAS: tens of ms. It only hurts through F3 (pool saturation + unguarded poll).

### F14 — H8: no auth to bypass, no behavioural difference — low, docs wrong

There is no auth middleware on `/api/*` (only `/api/update/*` and `/api/mcp*`); the global `withCSRFCheck` (`middleware_security.go:53`) covers mutating methods by Origin. `write()` is a ctx deadline nobody reads (F3). `docs/PDF_VIEWER.md` ▸ API "require the standard auth cookie" is false.

### F15 — H10: enumeration is fine; failure path aborts silently — low

`CanonicalPDFs` uses `idx_files_content_hash` (partial, `db.go:269`) for the correlated subquery; `DoneOrActiveFileIDs` is one indexed scan. The `0/0 running` window is the enumeration only. If enumeration errors (e.g. reader pool starved by F3), `startScoped` logs and releases the slot (`indexer.go:264-270`) — no retry, nothing in `Progress` — the user just sees the sweep vanish.

### F16 — Fast path can finalize a partial index as `indexed` — low, confirmed by code

`pdf-index-client.ts:134-138`: `fetch` does not throw on 4xx/5xx, so a rejected `PUT …/pages` (16 MB cap at `handlers/pdfindex.go:240`, or a 500) is ignored and `finalize` marks the file `indexed` with holes; `indexed` is terminal. Check `res.ok` and fall through to `fail` + `priorityIndex`.

### F17 — Porter stems the prefix term — low

`fts5PorterCb` stems any token ≥ 3 chars without checking `FTS5_TOKENIZE_PREFIX`, so `"conne"*` becomes `conn*` (superset, harmless) but a prefix ending in a stemmable suffix can also shrink or shift (`"power"*` → `power`, fine; `"ies"`-type endings change). Not a stall; worth a unit test if results ever look odd.

## Hypothesis scorecard

| H | Verdict |
|---|---|
| H1 pool exhaustion after Kill | **Refuted** (F11) — `InvalidateObject` decrements `createCount`; every `Close()` already invalidates (ReuseWorkers=false). |
| H2 OOM restart loop | **Structure confirmed, occurrence plausible** (F4) — deterministic order, no poison detection, orphans requeued at boot; wasm memory is Go heap (GOMEMLIMIT counts it, GC thrash precedes OOM). |
| H3 watchdog/claims | **Partly** (F6) — docs wrong (5 min/600 s, not 1/2 min); live backend jobs cannot be reclaimed; fast-path orphans idle 10–15 min then pending with no trigger. |
| H4 priority lane | **Confirmed** (F9) narrow drain window + `PriorityIndex` misuse (F7). |
| H5 search cost | **Confirmed and bigger than hypothesised** (F2/F3): unrestricted 1-char prefix 0.2–0.8 s on 80 k pages (rank over all matches; snippet is *not* per-match), donor scope 87 s; no server-side cancel. |
| H6 Stats | **Mostly refuted** (F13) — cheap; matters only via pool saturation. |
| H7 WAL | **Low** (F12) — bounded by reader duration; no FTS5 merge/optimize. |
| H8 unwrapped routes | **Refuted as auth** (F14) — there is no auth; wrappers are inert. |
| H9 engine init | **Confirmed** (F8) — churn reads every PDF per sweep; not surfaced beyond `failed` rows. |
| H10 enumeration | **Refuted** (F15) — indexed; silent abort on error is the only gap. |

## Confirmed by code vs needs measurement

Confirmed by code or measured here: F1 (retry-forever structure; 55 ms/page M-series), F2 (87 s), F3, F5, F6, F7, F8 (code), F9, F10, F11, F14, F15, F16.
Needs a field measurement: F1's per-page cost and timeout rate on apollolake (`scripts/devdeploy.sh` to rd-nas:1234, then `docker logs` for `FAIL extract … timed out`), F4 (container exit code + "boot requeued" repeats in `update-orchestrator.log`/`docker logs`), F12 (WAL size on a long-running NAS install), F8's compile failure on 512 MB/1 GB.

## Suggested order of fixes

1. F2 + F3 (search): one query rewrite, `QueryContext(r.Context())` everywhere in `pdfindex`, poll guard — removes "search hangs" and the UI freeze that follows it.
2. F1 + F4 (indexer): `attempts` counted at `Claim`, skip at 3; proportional timeout with partial pages kept; log file name before extract; pool size 1 under 2 GiB cgroup.
3. F5/F6/F7/F9: route the three "kick a run" handlers through `Submit`/`Restart`, re-run when the lane is non-empty at sweep end, run after reclaim.
4. F8, F10, F16, docs (watchdog numbers, auth claim).
