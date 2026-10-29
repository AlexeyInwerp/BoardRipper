# PDF index test/measurement report

Machine: macOS (Apple silicon), Go 1.27, warm OS page cache throughout (no sudo, so no `purge`; "cold" below = first call after `Open`, fresh SQLite page cache only). Experiment source: `scratchpad/zz_experiment_test.go.txt` (removed from the repo; `git status --porcelain` empty).

## T1 Baseline
`cd src/backend && go test ./pdfindex/... ./handlers/... -race -count=1`
- handlers: ok (2.9 s). pdfindex: FAIL, 1 test, one DATA RACE:
  `TestSubmitMidSweepReachesUnlistedFile` - Write at indexer_test.go:404 (test mutates `src.data["late.pdf"]` map) vs previous read at indexer.go:407 `process()` -> fakeSource.ReadFile (map read in worker goroutine). The race is in the test's fake (unsynchronised map), not in production code. Otherwise all pdfindex tests pass.

## T2 Pool exhaustion after Kill
Command: `go test -run TestZZPoolKill` (NewEngine(2), many-page-text.pdf 16 pp; wazero WithCloseOnContextDone).
| step | result |
|---|---|
| NewEngine(2) | 1.48 s |
| normal ExtractFile x5 | 7.6-9.2 ms each |
| 6 rounds: GetInstance x2, Kill both, third GetInstance(30s) | 0.62-1.27 ms each, all succeed; extraction on the replacement 5.9-6.2 ms, 16/16 pages |
| ExtractFile with perFileTimeout=1ms x8 | each returns "timed out ... page 1" in 1.7-2.4 ms |
| normal extract after the 8 timeouts | 7.6 ms OK |
Reading pool code: Kill -> `InvalidateObject` (pool slot freed, module closed); Close() also Invalidates (ReuseWorkers=false), so EVERY file gets a fresh wasm instance. Killed instances are replaced; no exhaustion after N kills. Side observation: after a timeout the orphaned `extract` goroutine keeps looping over all remaining pages (each logs "GetPageText failed: instance is closed"), i.e. log spam + a goroutine that runs to the end of the page count; harmless for CPU here but for a 2,000-page PDF it is 2,000 log lines. I could NOT make pdfium genuinely slow (no pathological PDF available), so the pool check used direct kills + a 1 ms timeout, not a real 2-minute hang. Interpretation: pool exhaustion after timeouts is not a defect.

## T3 Search cost
Corpus (seeded, rand 42): ~1.5 KB/page of refdes/values/nets/words. Built via real `Open`+`ReplacePages` (one tx per file). WARNING: my corpus is dense - almost every page matches every term (match-set ~490-500k of 500k for "10UF 25V", "PP3V3", "C", "1"), so these are worst-case match-set sizes; real schematics will have far smaller sets for rare terms.

### T3a 2,000 files x 100 pages (200k pages), DB 835 MB
Stats cold 69.5 ms / warm 1.5 ms; DoneOrActiveFileIDs 0.68 ms (2000 rows).
| query (limit 1000) | cold | warm x3 |
|---|---|---|
| "10UF 25V" | 665 ms | 427/412/415 ms |
| "PP3V3" | 523 ms | 391/401/385 |
| "C" | 1019 ms | 829/837/837 |
| "1" | 1372 ms | 1203/1337/1174 |
| "A" | 486 ms | 383/385/387 |
| "U12" | 157 ms | 59/59/59 |
| "SMC_RESET_L" | 1329 ms | 1128/1133/1129 |
| "10UF 25V 0402" | 539 ms | 494/497/501 |

### T3b Search while writing (ReplacePages loop ~12 files/s), 60 s, held cursor 30 s
Held cursor = `SearchPagesStream("PP3V3")` blocked in fn for 30 s. WAL (MB) at t=1,7,12,17,22,27 | 33(released at 30),38,44,49,55,60: 10,157,283,413,570,684 | 811,948,1082,1235,1377,1509. DB 835 -> 1026 MB. Search median under write load: "10UF 25V" 513 ms held / 568 after, "C" 992/1077, "SMC_RESET_L" 1332/1428, "U12" 72/74 (vs warm idle 415/835/1130/59: ~1.1-1.4x slower). WAL kept growing at ~25-28 MB/s after the cursor was released, so I ran a controlled repeat (fresh WAL each, 25 s):
| condition | WAL at 5/10/15/20/25 s |
|---|---|
| writer only | 12, 13, 13, 13, 13 MB (bounded, checkpoints+resets) |
| writer + back-to-back searches (no held cursor) | ~146 (6 s), 291, 418, 544 (22 s) MB - unbounded |
| writer + held cursor | 142, 291, 428, 556 MB |
| writer + held cursor + searches | 135, 286, 421, 529 MB |
After Close the WAL is removed. Interpretation: it is not the held cursor specifically; any continuously overlapping reader (searches 0.4-1.4 s back-to-back, a 4-conn reader pool) prevents WAL reset, so while a sweep writes and the UI searches, the WAL grows by ~27 MB/s with no `journal_size_limit`/checkpoint TRUNCATE. WAL file never shrinks afterwards (stayed 1509 MB in a later run).

### T3c 5,000 files x 100 pages (500k pages) - addendum (Q0-Q6)
DB size: with `prefix='2 3 4'`: 2,083 MB (2,113 MB at completion incl. wal); without prefix: 1,373 MB (-34%, prefix index = ~710 MB / 34% of the DB; for 15 GB that is ~5 GB).
EXPLAIN QUERY PLAN of Q0 (verbatim): `CO-ROUTINE ranked` -> `SCAN pdf_text VIRTUAL TABLE INDEX 32:M1` -> `SCAN r` -> `SEARCH p USING INTEGER PRIMARY KEY (rowid=?)`. EQP does not itemise the ORDER BY sorter for the virtual-table scan; snippet() is in the co-routine's SELECT list, but the timings below show it is NOT the cost.
Queries (limit 1000 unless noted; first / warm; prefix DB):
| MATCH | match-set (Q5 COUNT, time) | Q0 current | Q1 two-phase | Q2 no snippet | Q3 LIMIT 100 | Q4 unranked LIMIT 1000 | Q6 per-file GROUP BY LIMIT 200 |
|---|---|---|---|---|---|---|---|
| "10UF 25V" | 488,127 (50 ms) | 1.13 s / 1.0 s | 1.1 s (1 run) | 0.93 s | 0.93 s | 0-1 ms | 2.9-7.3 s first / 0.41 s |
| "PP3V3" | 491,580 (50 ms) | 0.92 s | 29.5 s (1 run) | 0.89 s | 0.88 s | 23 ms | 0.5 s first / 0.40 s |
| "C" | 499,983 (400 ms) | 2.05 s | not finished (>5 min, aborted) | 1.99 s | 1.99 s | 374 ms | 0.8 s |
| "1" | 500,000 (618 ms) | 2.8 s | not finished (>5 min, aborted) | 2.8 s | 2.8 s | 590-750 ms | 0.97 s |
| "U12" | 43,291 (2 ms) | 0.10 s | 0.17 s | 0.075 s | 0.073 s | 0 ms | 0.065 s |
| "SMC_RESET_L" | 491,864 (655 ms) | 2.8 s | 6 min 55 s (1 run) | 2.7 s | 2.7 s | 0.4 s | 1.0 s |
Same strings, NO-prefix DB (Q0 / Q2 / Q4 / Q5): "10UF 25V" 1.08 s / 1.07 s / 45 ms / 90 ms; "PP3V3" 0.91 s / 0.88 s / 30 ms / 70 ms; "C" 3.9-4.4 s / 3.77 s / 0.96 s / 0.99 s (vs 2.05 / 1.99 / 0.37 / 0.40 with prefix).
Interpretation: (1) hypothesis "snippet() for every match" is NOT supported: Q0 vs Q2 differ by 3-10%; snippet is evaluated after the LIMIT (EQP/timing consistent). (2) The cost is ranking (bm25 over the whole match set): Q2/Q3 ~= Q0, and LIMIT 100 does not help at all; scales ~linearly with match-set size (~1 s per 500k matches here => ~4 s at 1.9M on a warm fast machine; the NAS's 96 s must therefore be dominated by disk I/O / slow CPU, which I cannot reproduce here without a cold cache). (3) Q4 unranked is 0-23 ms for multi-token/rare cases and 0.4-0.6 s for the single-char prefixes (still 5x cheaper than ranked), COUNT costs the same order as Q4 (50-650 ms). (4) The Q1 two-phase formulation as specified (`MATCH ? AND rowid IN (...)`) is catastrophically WORSE (29 s - 7 min): FTS5 re-walks the match set rather than doing rowid lookups; a fix would need per-rowid lookups or an unranked/per-file query instead. (5) Q6 (unranked, joined, group by file) is 0.07-1.0 s warm; first-run 2.9-7.3 s on "10UF 25V" was page-cache warm-up of pdf_pages. (6) The prefix index costs 34% of disk and makes single-char searches 2x faster, but does not matter for the multi-token cases.

## T4 Priority lane
- (a) Sweep with 0 pending (file 1 already indexed; file 2 exists only in Source.Lookup):
  | scenario | result |
  |---|---|
  | Enqueue(2) while sweep is in enumeration (Running, Total not set) | processed: status(2)="indexed" |
  | Enqueue(2) while one worker is busy | processed: "indexed" |
  | Enqueue(2) just after the sweep ended (Running==false) | NOT processed: status "" and 1 item left in the priority channel (it sits there until the next sweep, which will then process it first) |
- (b) 300 iterations, each: sweep with 1 pending file + a goroutine calling Submit(newID) in a tight loop (40 per iteration) while Running: 12,000 submitted, 0 ended not-indexed after Running==false, 0 left in the channel. I could not reproduce a lost Submit; the window (Submit reads running=true, sweep exits before Enqueue lands) exists structurally (Enqueue after the workers returned is never drained) but was not hit in 12,000 attempts. Also note Submit while not running starts a one-file sweep, so tight loops chain sweeps.

## T5 Watchdog vs live job
`StartWatchdog(200ms, 1)`, extractor sleeping 3 s (production uses 5 min tick / 600 s max age, main.go:359; engine kill is 2 min).
| scenario | timeline | extract calls |
|---|---|---|
| 1 file, no other trigger | indexing (0.1 s) -> pending (1.3 s, reclaimed while live) -> indexed (3.0 s) | 1 |
| same + Submit(1) at t=1.2 when it shows pending, but both workers' sweep already winding down | indexed at 3.0 | 1 |
| 5 files, 2 workers, file 1 slow (3 s), others 0.5 s; Submit(1) when file 1 flips to pending (t=1.6 s) | - | **2** (file 1 extracted twice, concurrently; final status indexed) |
Interpretation: the reclaim does flip a live job back to pending (no heartbeat is written during extraction; attempted_at only refreshes at ReplacePages). Double processing happens whenever another trigger (Submit/priority lane, or a second worker/sweep that lists it) arrives in the window while a free worker exists. With production's 600 s max age this needs a single file to stay in 'indexing' >10 min (read + 120 s extract + ReplacePages under a contended writer lock on a slow disk) - not shown to happen in the field here; the mechanism is confirmed.

## T6 Frontend unit tests
`grep -rl "pdfindex|ensureIndexed|searchPdfs" src --include='*.test.ts'` -> none. `npx vitest run src/store/databank-store` -> "No test files found". No vitest tests cover pdf-index-client / PDF search; the only coverage is Playwright (`tests/pdf-index.spec.ts`, `tests/donor-bench.spec.ts`), not run. PDF-related vitest suites that exist and pass: `src/store/pdf-night-store.test.ts` (13), `src/pdf/pdfjs-floor.test.ts` (33) = 46/46 pass.

## Not done / caveats
- No true cold-cache run (needs sudo purge); no slow-disk simulation; therefore the NAS's 29-96 s cannot be reproduced - only the CPU-side scaling is measured.
- Synthetic corpus is denser than real; match sets are ~all pages for common tokens.
- A genuinely hung pdfium extraction was not reproduced (T2).
- Q1 on "C"/"1" aborted after >5 min rather than waited out; noprefix DB measured only for Q0/Q2/Q4/Q5 on 3 strings.
