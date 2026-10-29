# PDF Text Index Documentation Audit

## Table 1: Documentation vs. Code Discrepancies

| Doc Claim | Code Reality | Location |
|-----------|--------------|----------|
| "Watchdog: ReclaimStale is called periodically (every minute)" | Called every 5 minutes | main.go:359 `StartWatchdog(5*time.Minute, 600)` |
| "Any row stuck in `indexing` with `attempted_at` older than 2 minutes is reset to `pending`" | 600 seconds = 10 minutes | main.go:359 second arg; store.go:ReclaimStale uses maxAgeSeconds parameter |
| State machine lists "Five states stored in `pdf_index_status.status`" | Six states exist: pending, indexing, indexed, empty, failed, duplicate | pdf-index-client.ts:12 IndexStatus includes 'duplicate'; store_test.go:219 TestMarkDuplicate |
| State machine diagram does not include `duplicate` state | `duplicate` is a terminal state | db.go MarkDuplicate; store_test.go:219 proof |
| "Watchdog: ReclaimStale is called periodically (every minute) by the indexer sweep" (line 532) | ReclaimStale is called by the watchdog ticker, not "by the indexer sweep" — the indexer.Run() does not call ReclaimStale | indexer.go:StartWatchdog runs ticker independently |
| API table (line 468-488) lists 7 index-control endpoints | Code registers 9 endpoints: missing /api/pdfindex/restart, /api/pdfindex/auto-resume GET, /api/pdfindex/auto-resume POST, /api/pdfindex/index-folder | main.go:413-428; handlers/pdfindex.go:Restart, GetAutoResume, SetAutoResume, IndexFolder |
| "The earlier `index-folder('incoming')` call from the client was dropped" (line 436) | Endpoint still exists and is registered in main.go:428 | main.go:428 `mux.HandleFunc("POST /api/pdfindex/index-folder"...); handlers/pdfindex.go:IndexFolder |
| "All `/api/pdfindex/*` routes require the standard auth cookie" but also "GET routes are read-only and accept the read middleware; POST/PUT/DELETE accept the write middleware" (lines 462-464) | PUT /api/pdfindex/files/{id}/pages is NOT wrapped in read() or write() — runs bare with no middleware | main.go:423; handlers/pdfindex.go comment at line 430 explains the 30s context-deadline conflict |
| API table does not describe `/api/pdfindex/files/{id}/finalize` body | Frontend sends `{"total_pages": N}` (pdf-index-client.ts:152) but handler ignores it (handlers/pdfindex.go:Finalize reads no body) | pdf-index-client.ts:149-153; handlers/pdfindex.go:263-275 Finalize |
| API table does not document `/api/databank/search/stream` endpoint | Exists and is bare (no middleware) | main.go:433; handlers/pdfindex.go:SearchStream |
| API table does not document `/api/databank/reset-pdf` endpoint | Exists and is wrapped in write() | main.go:434; handlers/pdfindex.go:84-91 ResetPdf |
| "Dropped PDFs" section: "the backend hands the new id to `Indexer.Submit` right after the databank insert" | ID is handed via fileHandler.SetPdfSubmitHook (main.go:385) called when file is inserted, then indexer.Submit runs in a goroutine (main.go:386-390) | main.go:385-390 |
| Progress JSON has `running`, `total`, `done`, `errors`, `current_file`, `started_at` (implied by state machine section) | Progress struct has additional fields: `workers` and `active_workers` | indexer.go:45-54 Progress struct; pdf-index-client.ts:17-26 matches code |
| No mention of "duplicate" status in state machine (only 5 states listed, line 509) | "duplicate" is a terminal state, tracked as `canonical_file_id` in pdf_index_status table | CLAUDE.md lines 605, 621-625; store.go MarkDuplicate; store_test.go:219 |
| "/" routes described in API tables (line 500) don't include /api/databank/dedup/* | Dedup endpoints exist in backend (handlers/databank.go, referenced in CLAUDE.md) | CLAUDE.md §"Content deduplication"; docs/PDF_VIEWER.md lines 613-625 mentions dedup but separate from "API" table section |
| API table "POST /api/pdfindex/files/{id}/index" description: "Priority-enqueue `{id}`" | Endpoint only checks conflict status and calls Run() + Enqueue(); it does not re-queue the file if already indexing — 409 conflict returned | handlers/pdfindex.go:185-199 PriorityIndex |

---

## Table 2: Go Test Inventory

| Test Name | File | Line | What It Proves |
|-----------|------|------|----------------|
| TestOpenCreatesSchema | db_test.go | 8 | DB schema initialization and version tracking |
| TestClaimIsExclusive | store_test.go | 19 | Claim() locks file atomically, 409 on conflict, exactly one winner in race |
| TestFinalizeEmptyVsIndexed | store_test.go | 41 | Finalize() sets "empty" if no pages, "indexed" if pages exist |
| TestReclaimAfterFail | store_test.go | 58 | Failed file can be Claimed again (retryable) |
| TestConcurrentClaimExactlyOneWins | store_test.go | 72 | Multiple threads claiming same file: only one succeeds |
| TestUpsertPagesFTS5Searchable | store_test.go | 101 | Pages written via UpsertPages are queryable by SearchPages() |
| TestReclaimStale | store_test.go | 121 | ReclaimStale() resets 'indexing' rows older than maxAge back to 'pending' |
| TestStatsAndDelete | store_test.go | 143 | Stats() counts per-state rows; Delete() removes pages and status row |
| TestListFailedAndReset | store_test.go | 174 | ListFailed() returns terminal-failed rows; ResetForReindex() transitions them to pending |
| TestResetAll | store_test.go | 192 | ResetAll() clears pages, status, and FTS index |
| TestMarkDuplicate | store_test.go | 219 | MarkDuplicate(id, canonical) sets status='duplicate' with canonical_file_id; row is not claimable |
| TestSearchPages | search_test.go | 8 | FTS5 search finds pages by substring match in stored text |
| TestSearchPrefixMatchesPartNumberVariants | search_test.go | 37 | Prefix tokenizer matches part-number variants (e.g. "U1" in "U100") |
| TestEngineExtractsText | engine_test.go | 20 | Pdfium WASM instance extracts text per page from a real PDF or test data |
| TestIndexerRunIndexesAll | indexer_test.go | 61 | Run() enumerates all pending files and transitions them through the indexing pipeline |
| TestPendingFilter | indexer_test.go | 80 | DoneOrActiveFileIDs skips non-pending rows and returns canonical only once (no duplicates in output) |
| TestRunFolder | indexer_test.go | 121 | RunFolder(prefix) indexes only files under that path prefix; returns ErrAlreadyRunning if sweep active |
| TestRunFolderConflict | indexer_test.go | 162 | RunFolder(path1) and RunFolder(path2) in parallel: second returns ErrAlreadyRunning |
| TestRunFolderClaimsBeforeEnumeration | indexer_test.go | 218 | Claim on a file enumerated by RunFolder before it was added to source still succeeds (via Lookup fallback) |
| TestStartWatchdogStops | indexer_test.go | 261 | StartWatchdog() ticker stops when you close the returned channel |
| TestRunFilesIndexesOnlyListed | indexer_test.go | 286 | RunFiles([]id) indexes only those IDs, not all pending |
| TestRunFilesEmptyIsNoop | indexer_test.go | 311 | RunFiles([]) returns ErrAlreadyRunning if sweep active, else no-op |
| TestIndexerSkipsDuplicate | indexer_test.go | 322 | Indexer.Run() skips files marked 'duplicate'; Progress.Done still reaches Total |
| TestSubmitIdleIndexesOneFile | indexer_test.go | 352 | Submit(id) when idle starts a one-file sweep; when running goes to priority queue |
| TestSubmitMidSweepReachesUnlistedFile | indexer_test.go | 389 | Submit(id) enqueued mid-sweep is resolved via Source.Lookup even if not in initial enumeration |
| TestIsWatermark | watermark_test.go | 5 | IsWatermark() NFKC-normalises, strips whitespace, lowercases, and substring-matches terms |
| TestCleanPageTextDropsWatermarkLines | watermark_test.go | 26 | CleanPageText() drops lines matching any watermark term; returns count of dropped lines |
| TestStatusEndpoint404ThenClaim | pdfindex_test.go | 28 | GET /api/pdfindex/status/{id}: 404 when never attempted; 200 after Claim() |
| TestSearchCollapsesContentGroup | pdfindex_test.go | 52 | Search results collapse duplicate files to canonical; canonical shows page count sum |
| TestSearchStreamEmitsResultPerFile | pdfindex_test.go | 120 | GET /api/databank/search/stream emits one JSON line per file (streaming output) |
| TestSearchCollapsesPagesToOneRowWithCount | pdfindex_test.go | 234 | Search returns one row per file with `page_count`, not per-page hits |
| TestPdfDonorIndexerStatusFor | donor_indexer_test.go | 10 | Donor indexer reports status for each file in the donor set (indexed, failed, pending, etc.) |

---

## Table 3: Playwright Spec Inventory

| Spec Name | File | Fixture/Sample Required | Can Run on Clean Checkout? | What It Tests |
|-----------|------|------------------------|---------------------------|---------------|
| pdf-index (2 tests) | pdf-index.spec.ts | samples/820-02016.pdf (proprietary); go backend required for test 1 | No (proprietary PDF + backend dependency) | Fast-path indexing on PDF open; in-document Ctrl-F independence from backend |
| pdf-search (3 tests) | pdf-search.spec.ts | Backend on :8080 required; uses pre-seeded library with PDFs containing "connector" | No (backend dependency; no fixture listed) | Backend search API; library panel PDF search UI; pre-populated viewer search from results |
| donor-search (multiple) | donor-search.spec.ts | samples/820-02016.bvr, samples/820-02935-05.brd (proprietary boards) | No (proprietary board samples) | Right-click "find on other board"; global search auto-select |
| pdf-single-match-refocus | pdf-single-match-refocus.spec.ts | ? | ? | ? (not examined in detail) |
| pdf-rotation (possibly includes search) | pdf-rotation.spec.ts | tests/fixtures/two-page-text.pdf (public); may skip if proprietary boards needed | Likely yes for parts, depends on what's tested | PDF rotation + mirror + page modes (may include search state survival) |
| library-layout (references pdfindex) | library-layout.spec.ts | ? | ? | ? (not examined in detail) |
| pdf-highlight-canvas (references pdfindex) | pdf-highlight-canvas.spec.ts | ? | ? | ? (not examined in detail) |
| nav-history (references pdfindex) | nav-history.spec.ts | tests/fixtures/two-page-text.pdf (public) + public KiCad sample | Likely yes | Navigation history record/restore across PDFs and boards |
| library-panel (references pdfindex) | library-panel.spec.ts | ? | ? | ? (not examined in detail) |
| donor-bench (benchmarks) | donor-bench.spec.ts | Backend on :8080 required; benchmarks search performance | No (backend dependency) | PDF search performance metrics |

---

## Table 4: Behaviours With No Test Coverage

| Behavior | Why Untested | Impact |
|-----------|-------------|--------|
| Heartbeat() call during long extractions | Function defined (store.go:56) but never called from any code path | The "claimant refreshes `attempted_at` via `Heartbeat`" claim (doc line 524) is dead code; long extractions may hit watchdog reclaim incorrectly if > 10 min |
| Watchdog reclaim of a live indexing job mid-extraction | Only tested in isolation (store_test.go:121 ReclaimStale); never tested as part of a real extraction flow that hits the timeout | Race condition risk if pdfium extraction genuinely takes 10+ minutes |
| Pool exhaustion after Kill timeout (pdfium instance wazero.Runtime.Close) | No test exercises pool overflow + timeout + instance cleanup | Potential for goroutine leaks or dangling WASM instances |
| Fast-path abandonment mid-upload | pdf-index-client.ts ensureIndexed catches errors but no test verifies partial page batches are ignored | Partial index entries from failed uploads may exist |
| Search stream timeout (no explicit timeout mentioned in code or doc) | SearchStream handler (main.go:433) is bare with no context timeout named | Client may hang indefinitely on a stalled response |
| Index-folder conflict handling with auto-resume | IndexFolder can conflict with auto-resume background Run(); no test covers this race | Confusing progress state if both fire simultaneously |
| Dedup canonical resolution during fast-path Begin | pdf-index-client.ts Begin (line 120) never calls CanonicalFor; only handler Begin does (pdfindex.go:213) | Two tabs opening duplicate files may extract both instead of deferring to canonical |
| ResetForReindex with "failed" scope | API exists (pdfindex_test.go never exercises it); handler Reindex always posts a Run() | If reset during an active sweep, workers may be working on about-to-be-reset rows |
| Settings API watermark-term sync to pdfindex backend | Backend loads terms via loadWatermarkTerms callback (main.go:356), never tests verify they stay in sync with frontend's getActiveWatermarkFilter | Watermark strip may diverge between frontned (Ctrl-F) and backend (FTS5 index) |

