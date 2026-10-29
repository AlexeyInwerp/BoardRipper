# PDF index / PDF search — frontend review (2026-10-14)

Scope: `src/frontend/src/pdf/pdf-index-client.ts`, `store/pdf-store.ts`, `store/databank-store.ts`, `panels/LibraryPanel.tsx`, `panels/SettingsPanel.tsx`, `store/pdf-filter-actions.ts`, `store/cross-target-search.ts`, `components/ContextMenu.tsx`, the two specs. Backend read only where the frontend's contract depends on it (route registration, SPA fallback, CSRF, claim/watchdog, stream shape). All paths below are under `src/frontend/src/` unless prefixed `backend/`.

Ranked by how likely each one explains "PDF search stalls / spinner forever / no results / index UI stuck / opened PDFs never searchable".

---

## FE-1 — A backend whose PDF index failed to open is indistinguishable from an empty index (High, confirmed by code)

**What the code does.** The Go side registers every `/api/pdfindex/*` route *and* `/api/databank/search` + `/search/stream` only when `pdfindex.db` opened (`backend/main.go:341-343`, `:429-433`; `:192` logs "pdfindex.db unavailable — PDF search disabled this boot"). Any other path falls into the SPA handler, which serves **`index.html` with 200** for every unknown URL, `/api/...` included (`backend/main.go:571-589`). So a degraded backend answers each index/search request with 200 + `text/html`.

On the frontend:
- `pdf-index-client.ts:47-57` — `jfetch` returns `null` for `!ok`, non-JSON content type, and thrown fetch alike. Nothing records *why*.
- `pdf-index-client.ts:110-122` — `ensureIndexed`: `status` → null (HTML) → treated as "not indexed" → `begin` POST → `index.html` 200 → `begin.ok === true` → the whole text is PUT in 50-page batches to the SPA handler, `finalize` likewise. Every PDF open, every time, silently "succeeds" into nothing.
- `databank-store.ts:1919-1921` — `searchPdfsStream`: `res.ok && res.body` → reads HTML, no line parses as JSON (`:1934`), loop ends → `onDone` never fires but the `.finally` in `LibraryPanel.tsx:347-355` clears `pdfSearching`.
- `LibraryPanel.tsx:1327-1329` — then renders **`No results for "<query>"`**.
- Stats: `_pdfIndexStats` stays null → Library summary shows `N boards · M PDFs` with the ` · indexed` part simply absent (`LibraryPanel.tsx:846`); Settings ▸ Database info shows `—` (`SettingsPanel.tsx:960`); the indexing card renders nothing (`SettingsPanel.tsx:1231-1238`). There is **no "PDF search unavailable" state anywhere** in the UI.

The same mapping applies to 401/403/5xx/network-down: all become `null` → "not indexed" / "no results".

**Failure scenario.** `/data/pdfindex.db` locked, corrupt, or unwritable after an interrupted update or a permissions change on the NAS. The container is healthy, boards open, the library lists, Ctrl-F works in the viewer — only PDF search returns "No results" for every term, and the index counters are blank. Users read it as "the index is stuck".

**Rule check** (CLAUDE.md ▸ "waiting is not a fact"): rule 1 violated — a terminal claim ("No results") is made without the source's completion signal; rule 3 — the empty index card promises nothing and explains nothing.

**Fix.**
- `databank-store.ts`: add `pdfIndexState: 'unknown' | 'ok' | 'unavailable'` (+ `pdfIndexError: string | null`), written by one place, from `fetchPdfIndexStats` / the poll tick: a JSON 200 → `ok`; a non-JSON answer or `!ok` → `unavailable` with `HTTP <status>` / `not JSON` / the thrown message. Expose through `useDatabank`'s snapshot (`hooks/useDatabank.ts:91-92` already carries the two fields).
- `pdf-index-client.ts`: make `jfetch` return a discriminated result (`{ok:true,data} | {ok:false,status,reason}`) and have `ensureIndexed` parse `begin`'s JSON (`{status:'indexing'}`) before uploading — a 200 that is not that body is not a claim. Log one `log.pdf.warn` per fileId per reason.
- `LibraryPanel.tsx` search tab + Settings card: branch failure → waiting → empty → content. `unavailable` renders "PDF text search is not available on this server (<reason>)" in the status strip, the input disabled; the card says the same instead of `null`.
- Backend (one line, outside this review's scope but load-bearing): when `pdfIndex == nil`, register `/api/pdfindex/` and `/api/databank/search` as a JSON 503 `{error:"pdf index unavailable"}`, and make the SPA fallback answer `/api/*` with 404, never `index.html`.

---

## FE-2 — Any failed or torn search stream renders as "No results" (High, confirmed by code)

**What the code does.** `databank-store.ts:1910-1946` `searchPdfsStream`:
- `:1920` `if (!res.ok || !res.body) return;` — 404, 500 (FTS cursor error before headers), 502/504 from a reverse proxy: silent return.
- `:1941-1945` catch — network error, a connection cut mid-stream, a `WriteTimeout` at the server (5 min, `backend/main.go:618`): `log.scan.warn` only.
- `:1937` the backend's trailing `{"type":"error"}` line (`backend/handlers/pdfindex.go:578-582`) is logged, not surfaced.
- `:1916` no client timeout; nothing watches for "no bytes for N seconds".
The panel's `.finally` (`LibraryPanel.tsx:347-355`) clears `pdfSearching` in every case, so the DOM at `:1327` says `No results for "…"`.

**While searching:** `LibraryPanel.tsx:1322-1325` shows `Searching…` + spinner with zero rows — correct as *waiting*. **After `done` with 0:** `No results` — correct only when `done` arrived. The same text is shown for every failure above. The Search button is `disabled={pdfSearching}` (`:1288`) — while a stream hangs there is no way to cancel or retry from the UI.

**"Spinner forever" is bounded by the server, not the client:** the stream handler is not wrapped in `read(...)`'s 30 s timeout (`backend/main.go:433` vs `:429`), so a slow FTS query runs until `http.Server.WriteTimeout` (5 min). Through a buffering reverse proxy (plain nginx `proxy_buffering on`, Synology's reverse proxy, Cloudflare tunnel) the NDJSON arrives in one piece at the end — not a hang, but the spinner for the whole query and no progressive rows; Cloudflare's 100 s origin limit converts a long query into a 524 → "No results".

**Abort/supersede/unmount:** correct. `streamPdfSearch` aborts the previous controller (`:305-307`), the superseded run's `.finally` is guarded by controller identity (`:350-354`), unmount aborts and clears the flush timer (`:365-368`), `stopFlush` is idempotent. No leak found.

**Fix.**
- `searchPdfsStream` returns an outcome: `Promise<{ kind: 'done'; total: number } | { kind: 'failed'; reason: string } | { kind: 'aborted' }>`; `!res.ok` → `failed` with `HTTP ${res.status}`; the `error` line → `failed` (keep rows already delivered); stream end without `done` → `failed('stream ended early')`.
- Add a client watchdog: `AbortController` + a timer reset on every `reader.read()` resolve (e.g. 60 s idle) → `failed('no answer from the server for 60 s')`.
- `LibraryPanel.tsx`: replace `pdfSearching: boolean` with `pdfSearchState: 'idle' | 'searching' | 'done' | 'failed'` (+ reason). Render: `failed` → one line in the status strip ("Search failed — HTTP 502 · Retry"), the rows that did arrive stay; `done && 0` → `No results`; `searching` → spinner. Turn the Search button into **Cancel** while searching (`pdfSearchAbort.current?.abort()`).

---

## FE-3 — `ensureIndexed` never checks a PUT, swallows the rest, and an interrupted upload parks the file as `indexing` with nothing to retry it (High, confirmed by code)

**What the code does.** `pdf-index-client.ts:104-168`:
- `:110`, `:120` — `status` and `begin` are **outside** the `try`. A thrown `fetch` (backend restarting, Wi-Fi drop, iPad page suspended) rejects the task; every caller is `void ensureIndexed(...)` (`pdf-store.ts:691, 933, 1026`) → unhandled rejection; `:166` `task.finally(() => …)` creates a **second** unhandled rejection from the same failure. Neither reaches `log.pdf`.
- `:134-138`, `:149-153` — the page PUTs and `finalize` are `await fetch(...)` with **no `res.ok` test**. A 5xx on one batch (SQLite busy during a bulk sweep, proxy 502) is ignored; `finalize` then runs on a partial upload, and `Finalize` counts whatever pages landed and marks the file **`indexed`** (`backend/pdfindex/store.go:138-144`). Result: a file that is "indexed" with holes — searches for text on the missing pages return nothing, and nothing will ever re-index it (status is terminal).
- Interrupted between `begin` and `finalize` (tab closed, navigation, iPadOS discarding the page, a laptop lid): `Claim` has written `status='indexing', source='pdfjs'` (`backend/pdfindex/store.go:34-42`). The watchdog reclaims after 10 min (`backend/pdfindex/indexer.go:402, 466`). Until then every re-open hits `:115` `st.status === 'indexing'` → return — **no re-upload, and `begin` does not enqueue a backend pass**, so no fallback either. After the watchdog the row is `pending` and waits for an auto-resume sweep.
- No `beforeunload`/`pagehide` handler and no `keepalive` anywhere in the index path (the only `beforeunload` listener is `session-store.ts:88`, session capture).
- Batching: sequential `await flush()` every 50 pages; a 500-page schematic is 10 PUTs of up to ~1–1.6 MB (backend cap 16 MiB, `backend/handlers/pdfindex.go:240`) — size is fine, the serial chain is what gives a slow link time to die mid-way.

**Failure scenario (matches "opening PDFs never makes them searchable").** On an iPad a user opens a schematic from the Library, reads two pages, switches apps; iPadOS suspends the page mid-upload. The row is `indexing` for 10 min; reopening the PDF does nothing (`:115`); after 10 min it is `pending` and is indexed only if auto-resume runs. With auto-resume off, never — and the user has done "the thing that should index it" three times.

**Fix.**
- Inside `ensureIndexed`: `const ok = (r: Response) => { if (!r.ok) throw new Error(\`HTTP ${r.status} ${r.url}\`); return r; }` on every PUT and on `finalize`; move `status`/`begin` into the `try` so the existing catch (`/fail` + `priorityIndex`) is the one failure path; end the task with `.catch(err => log.pdf.warn(...))` so `void` callers never produce unhandled rejections; keep `inflight.delete` in a non-rethrowing finally.
- Abort on unload: one module-level `AbortController` per fileId; on `pagehide` abort it and `fetch('/api/pdfindex/files/<id>/fail', { method:'POST', keepalive:true, body: '{"error":"page unloaded"}' })` so the row is `failed`, which the next open re-claims (`:111-117` does not treat `failed` as terminal — correct).
- Orphan recovery on the next open: when `status === 'indexing'` and `inflight` has no entry for the id, call `pdfIndexClient.priorityIndex(fileId)` (backend already 409s if it is genuinely in flight, `backend/handlers/pdfindex.go:185-198`) — or have the backend return `source`+`attempted_at` so the client can re-`begin` a stale `pdfjs` claim.
- `getTextPages` is called **after** `begin` — if it throws, the catch path runs; fine. But it is also called on a `pdfDoc` that may have been reparsed meanwhile; harmless, noted.

---

## FE-4 — Index polling: the Run button races its own poll, a silent backend keeps the poll alive for ever, and the strip claims "idle" meanwhile (Medium-High, confirmed by code)

**What the code does.** `databank-store.ts:1593-1628`:
- `startPdfIndexPolling` fires `tick()` immediately (`:1612`) then every 1.5 s; the tick stops the interval only when `this._pdfIndexProgress && !running` (`:1603-1605`).
- `SettingsPanel.tsx:1191` — `onClick={() => { void pdfIndexClient.run(); databankStore.startPdfIndexPolling(); }}` — the POST and the first GET `progress` are **concurrent**. `startScoped` claims `running` synchronously (`backend/pdfindex/indexer.go:232-247`), so the race is purely HTTP ordering (separate connections / HTTP/2 streams); when `progress` lands first it reads `running:false` → the interval stops → the UI never shows the sweep that is now running. Every other starter awaits its POST first (`SettingsPanel.tsx:1083-1086, 1107-1108, 1534-1535`; `LibraryPanel.tsx:277-278, 707-716`), so only "Index all PDFs / Continue" is affected — the most-used button.
- When `jfetch` returns `null` (backend restarting, 502 from a proxy, pdfindex unavailable): `_pdfIndexProgress = null` → the stop condition is false → **the interval runs for ever**, two requests every 1.5 s, until the tab reloads; no `visibilitychange` gating (none in the three files). Meanwhile `pdfIndexProgress?.running` is falsy → the strip's summary falls back to `N boards · M PDFs` (`LibraryPanel.tsx:844-846`) and the Settings card to the idle stats or nothing — i.e. the UI says *idle*, not *lost contact*.
- A sweep the backend starts on its own (auto-resume at boot / after a scan, `backend/main.go:456`) is learned only by `fetchPdfIndexStats`, which runs at app boot (`databank-store.ts:1052`), on Settings ▸ Database info mount (`SettingsPanel.tsx:877`) and after `resetPdf` (`:2158`). The scan poll does **not** chain into it when a scan ends (`_startScanPolling` body: `fetchFiles` only). So a user who opens the Library after a scan sees `N boards · M PDFs`, no "Indexing" line, while the backend is sweeping — until they happen to open Settings.
- Enumeration window: the backend reports `running:true, total:0` while listing (`backend/pdfindex/indexer.go:222-226`, "tens of seconds on a large databank"). The UI shows `Indexing PDFs 0/0` (`LibraryPanel.tsx:845`), `0 / 0 (0%)` and an empty bar (`SettingsPanel.tsx:1211-1216`), no ETA (`fmtIndexEta` returns '' for `done <= 0`, `LibraryPanel.tsx:137`). On a 10k-PDF NAS library that is a long "stuck at 0/0".
- Multiple callers → one interval: `startPdfIndexPolling` calls `_stopPdfIndexPolling` first (`:1594`). No leak there. The interval is never cleared on panel unmount by design (store-level), which is fine while it terminates.

**Fix.**
- `SettingsPanel.tsx:1191`: `onClick={async () => { await pdfIndexClient.run(); databankStore.startPdfIndexPolling(); }}` (like the other five sites).
- `databank-store.ts` tick: keep `lastContactAt`; on a null answer increment `misses`, after e.g. 5 set `pdfIndexState = 'unavailable'` (see FE-1) and stop; on `running:false` stop only after a non-null answer. Pause the interval while `document.hidden`, resync via `fetchPdfIndexStats()` on `visibilitychange` → visible and when `_startScanPolling` observes `running:false`.
- Render `total === 0 && running` as `Indexing PDFs — counting files…` in both places.

---

## FE-5 — Opening a hit can wait 10 s and then search partial text; a synthesized row defeats the text cache (Medium, confirmed by code)

**What the code does.** `LibraryPanel.tsx:634-652` `handleOpenSearchHit`: `await handleOpenFile(file, r.page_num)` (download via `fetchWithCloudRetry`, up to 3 min on a cloud placeholder; then `pdfStore.loadFile`), then `await pdfStore.whenTextReady(file.filename, r.page_num ?? 1)` — readiness is `textPages.length >= pageNum` (`pdf-store.ts:780-781`), pages are extracted **in order**, extraction starts only after first paint or 1.5 s (`pdf-store.ts:889-897`), cap 10 s. A hit on page 300 of a 400-page schematic on an iPad is not ready in 10 s → `searchText(query, 'lookup')` runs on partial text → the viewer shows `0/0` with a **"Library ⌕"** button that sends the user back to the library search (`PdfViewerPanel.tsx:4093-4104`). A loop that reads as "search finds it, the viewer says it isn't there".

It does not hang the click path (the handler is async, the panel keeps rendering), but there is no feedback during the wait.

`fileById` miss → synthesized `mod_time: 0` (`:636-644`) → `fetchFileBuffer` builds the `File` with `lastModified: file.mod_time * 1000 = 0` (`databank-store.ts:2428`) → the IndexedDB text cache keyed `name:size:lastModified` (`pdf-store.ts:914`) misses the entry written by a tree open → full re-extraction and a second `putPdfText` under a different key. `openLibraryFileById` already has the right tool: `fetchFileRows([id])` (`store/file-actions.ts:157`).

**Fix.** In `handleOpenSearchHit`: `databankStore.fileById(r.file_id) ?? (await databankStore.fetchFileRows([r.file_id]))[0] ?? synthesized`. For the search: wait on "page's text present OR extraction finished" with a longer cap (60 s), and while waiting let the viewer's own extraction progress show (it already has `textExtractProgress`); if the cap elapses, run the search anyway but set `crossProbeHint` ("still extracting text — results may be incomplete") instead of a bare `0/0`.

---

## FE-6 — Lite and desktop builds fire PDF-search `/api` requests and then claim "No results" (Medium, confirmed by code)

**What the code does.**
- `LibraryPanel.tsx` has no `isLiteBuild()` / `hasBackend()` gate on the PDF tab (`:1103-1119`) nor on `streamPdfSearch` (`:303`); `searchPdfsStream` uses raw `fetch` (`databank-store.ts:1919`), not `apiFetch`, whose `hasBackend()` backstop (`:872`) exists precisely for this. Entry points: Enter / Search button (`LibraryPanel.tsx:1275, 1286`), context menu "Search all donors" (`ContextMenu.tsx:265-275`), the viewer's "Library ⌕" (`PdfViewerPanel.tsx:4101`), all via `requestPdfSearch` (`databank-store.ts:2229-2233`).
- Lite (static host, folder library): the request goes to `/boardripper/web/api/databank/search/stream` → 404 or the host's HTML → "No results for …". Breaks the lite build's zero-`/api` rule (CLAUDE.md ▸ lite library).
- Electron without the sidecar (`file://`): `fetch` throws → `log.scan.warn` → "No results".
- `ensureIndexed` is gated on `isLiteBuild()` only (`pdf-index-client.ts:105`). `build-mode.ts:14-18` says explicitly that `hasBackend()` is false on the desktop app while `isLiteBuild()` is not. Library PDFs are opened **with** `file.id` on the desktop (`LibraryPanel.tsx:595`, `file-actions.ts:193`, `session-store.ts:139`), so every desktop PDF open runs `fetch('/api/pdfindex/status/N')` against `file://` → throws → `null` → `fetch(begin)` throws → unhandled rejection (FE-3), twice.
- Polling/stats are safe: `fetchPdfIndexStats` is only reached in the backend branch of `ensureLoaded` (`:1030-1052`); the Settings `library` tab is filtered out in lite (`SettingsPanel.tsx:85`); `DatabaseInfoSection` gates on `backendAvailable` (`:872, 884`). `LibrarySettingsSection` calls `pdfIndexClient.getAutoResume()` unguarded on mount (`:1070-1071`) — unreachable in lite, a thrown-and-swallowed `file://` fetch on the desktop.

**Fix.** `ensureIndexed`: `if (!hasBackend()) return Promise.resolve();` (import from `databank-store`; no cycle — `pdf-index-client` is already imported by `pdf-store`, which imports `databank-store`… verify, else pass a `hasBackend` predicate from the caller). `streamPdfSearch`/`searchPdfsStream`: `if (!hasBackend()) → outcome failed('no server')` and the tab renders "PDF text search needs the BoardRipper server — the folder library has no text index" instead of the input (the folder library cannot be indexed). `requestPdfSearch` callers can hide their menu rows on `!hasBackend()`.

---

## FE-7 — The "backend pass covers it" comment is true only for drops; a library open whose extraction fails on one page is never indexed and never falls back (Low-Medium, confirmed by code)

**What the code does.** `pdf-store.ts:681-694` `_indexWhenTextReady` is called only from `setDocFileId` (`:673-679`), whose only caller is `incoming-upload.ts:71` (a drop that was ingested). For that path the comment holds: the upload handler's `SetPdfSubmitHook` queues the backend extraction (`backend/main.go:384-390`). Library opens never reach it; they use the two sites in `_extractText` — cache hit (`:932-936`) and completion (`:1021-1029`, gated on `textPages.length === pageCount`). An extraction that throws on a page is caught (`:1009-1012`), logged, and falls through: no cache write, no `ensureIndexed`, no `priorityIndex`. The file stays `pending` in the backend until an auto-resume sweep; with auto-resume off, indefinitely. The 180 s poll (`:688`) is moot for library opens.

Call-site map (what runs when):
- Library open (tree, History, bound PDF, search hit): `loadFile(file, id)` → `_extractText` → cache hit → `ensureIndexed`; else extract → completion → `ensureIndexed`. Partial extraction → nothing.
- Cache hit: `ensureIndexed` runs on cached text (`:932`) — fine, `status` short-circuits if the backend already has it.
- Drop: `loadFile(file)` (no id) → both sites skip; the upload returns an id → `setDocFileId` → `_indexWhenTextReady` → `ensureIndexed`; on timeout the backend pass queued by the upload covers it.
- Session restore: `loadFile(file, dbFile.id)` (`session-store.ts:139`) → same as a library open.
- A PDF first dropped and later opened from the Library: `loadFile` returns at "Already loaded? Just switch." (`:810-815`) → `fileId` is never set → never indexed from this session (the drop-upload path's id, when it exists, does get set).

**Fix.** In `_extractText`'s catch, when `pdfDoc.fileId != null`: `void pdfIndexClient.priorityIndex(pdfDoc.fileId)` with `log.pdf.warn('extraction incomplete, handing <name> to the backend indexer')`. In `loadFile`'s early return, `if (fileId != null && d.fileId == null) this.setDocFileId(name, fileId)` (which already arms the fast path). Fix the comment on `_indexWhenTextReady` to say "drop path only".

---

## FE-8 — Query hygiene is fine server-side; the client has no minimum length, which is the realistic "slow search" (Low, confirmed by code)

`q` is sent raw (`databank-store.ts:1917`). The backend quotes every whitespace token as `"tok"*` and escapes `"` (`backend/pdfindex/search.go:123-135`), so FTS5 operators (`NOT`, `OR`, `:`, `*`) are neutralised — no crash path. But a 1–2 character term becomes a prefix match over the whole index, 1000-hit cap with a `SearchMeta` + `CopyPathsForFile` round-trip per distinct file (`backend/handlers/pdfindex.go:539-575`), inside no handler timeout (FE-2) — on a 10k-PDF NAS library with a cold SQLite cache this is the search that "spins". No debounce and no typed search: a run starts only on Enter / the button, so there is no typed-vs-Enter race; a context-menu `pendingPdfSearch` and a manual run both go through the abort in `streamPdfSearch` (`LibraryPanel.tsx:305-307`), and the superseded run's cleanup is identity-guarded (`:350-354`).

**Fix.** Trim and require ≥ 2 non-space characters (say so inline, not as a silent no-op); Cancel while searching (FE-2).

---

## FE-9 — Reverse proxy with a rewritten `Host` → every index POST/PUT is 403, and the frontend hides it (Plausible — needs a user's proxy config to confirm; the frontend half is confirmed)

`backend/middleware_security.go:53-85`: non-GET requests carrying an `Origin` must satisfy `sameOriginHost(origin, r.Host)` — host **and port**. Behind an nginx `proxy_pass` with the default `Host $proxy_host`, or any proxy that sets `Host` to the upstream, the browser's `Origin` is `https://nas.example` while `r.Host` is `localhost:1336` → **403 "cross-origin request rejected"** on `begin`, `run`, `stop`, `reindex`, `restart`, `auto-resume`, `index-folder`, and the watermark `PUT /api/config` (`pdf-filter-actions.ts:30-36`, `.catch(() => {})`). GETs pass, so **search works, stats show, but nothing new is ever indexed and no button does anything** — a precise match for "opening PDFs never makes them searchable". Synology's own reverse proxy forwards the original Host by default, so this is the custom nginx / Traefik / Caddy / Cloudflare-with-`httpHostHeader` cases.

Frontend side (confirmed): `ensureIndexed` returns silently on `!begin.ok` (`pdf-index-client.ts:122`); `run`/`reindex`/`restart` go through `jfetch` → `null` → the buttons' handlers do nothing visible (`SettingsPanel.tsx:1083-1086, 1107, 1191`; `LibraryPanel.tsx:277`); `indexFolder` is the one raw fetch (`pdf-index-client.ts:87-92`) and `handleIndexFolder` only looks at `409`/`ok` (`LibraryPanel.tsx:707-718`) — a 403 is a silent no-op. **Fix:** every mutating call logs `log.pdf.warn('<verb> → HTTP <status>')`, and a 403 raises one toast ("the server rejected the request as cross-origin — check the reverse proxy's Host header"); the Settings buttons show the failure inline (rule 3).

---

## FE-10 — iPad / Safari specifics (plausible, needs a device to measure)

- **Page discard mid-upload** → FE-3's orphan `indexing` row. iPadOS discards background pages routinely (CLAUDE.md, folder-library notes). The `pagehide` + `keepalive` fix in FE-3 is the mitigation; measure how often a 10-PUT upload survives an app switch.
- **Main-thread cost before the upload:** `_extractText` maps every item per page with two regexes (`pdf-store.ts:984-1001`), `getTextPages()` copies every page's strings (`:933, :1027`), `JSON.stringify` of 50-page batches (`pdf-index-client.ts:137`), then `putPdfText` (already per-page JSON strings since the 2026-10-04 review). Expect tens-of-ms tasks on an A12Z, not seconds; profile at 6× throttle before changing anything — the 2026-09-23 note's method applies.
- **Timer throttling:** `whenTextReady` polls at 100 ms (`pdf-store.ts:792-795`) and the index poll at 1.5 s; both are throttled to ≥ 1/min in a hidden Safari tab. `_indexWhenTextReady`'s 180 s cap is tested only on a tick, so a hidden tab waits longer and then still proceeds — harmless; the 1.5 s poll simply stalls while hidden and resumes (FE-4's visibility handling makes that explicit).
- **Body sizes:** ≤ ~1.6 MB per PUT vs a 16 MiB server cap — not a limit; Safari has no relevant `fetch` body ceiling here.
- **Backgrounded `fetch`** in Safari can be cancelled with a generic `TypeError: Load failed` → FE-3's unhandled rejection, no log line to find afterwards.

---

## Tests: what runs on a clean checkout

- `tests/pdf-index.spec.ts`: test 1 needs a Go backend on `:11336`/`:8080` with pdfindex routes **and** a scanned library with ≥ 1 PDF (`:38-96`) — skips otherwise; test 2 needs `samples/820-02016.pdf` (proprietary, gitignored, `:33`) — skips otherwise. Neither drives `ensureIndexed`: test 1 enqueues through `POST /files/{id}/index` directly (`:107-110`).
- `tests/pdf-search.spec.ts`: hardcodes `http://localhost:8080` (`:30-36`) and needs extracted text for 820-00239 / 820-02890 — skips entirely without that.
- `tests/library-unreachable-state.spec.ts` mocks routes but covers the file list only, not the PDF tab.
- **Not covered anywhere:** the search tab against 404-HTML / 502 / a stream that never sends `done` / an `error` line; the index poll against `running:true,total:0` → null; `ensureIndexed` against a failed PUT or a 403 `begin`; the lite build's PDF tab. A route-mocked spec in the `library-unreachable-state` style (sample every 50 ms, fail on any "No results" while the source has not answered) would pin FE-1/2/4 and runs without fixtures.

---

## Summary table

| id | severity | status | one line |
|---|---|---|---|
| FE-1 | High | confirmed | pdfindex-disabled backend answers 200 HTML → "not indexed", uploads to nowhere, "No results", blank counters; no "unavailable" state |
| FE-2 | High | confirmed | any failed/torn/hung search stream renders "No results"; no timeout, no cancel |
| FE-3 | High | confirmed | PUT/finalize never checked (partial upload = "indexed" with holes); begin/status outside try; interrupted upload parks `indexing` 10 min with nothing retrying; two unhandled rejections per failure |
| FE-4 | Med-High | confirmed | Run button races its own poll; null answers keep the poll alive for ever while the UI says idle; enumeration shows 0/0; backend-started sweeps invisible to the Library |
| FE-5 | Medium | confirmed | hit open: 10 s cap then partial-text search → `0/0` loop; `mod_time:0` defeats the text cache |
| FE-6 | Medium | confirmed | lite/desktop fire `/api` search + index calls and claim "No results"; `ensureIndexed` gated on `isLiteBuild` not `hasBackend` |
| FE-7 | Low-Med | confirmed | library open with a failed page: no index, no fallback; the "backend pass covers it" comment is drop-only |
| FE-8 | Low | confirmed | no min length → 1-char prefix scan of the whole index, no debounce race |
| FE-9 | — | plausible (frontend half confirmed) | proxy Host rewrite → 403 on every mutation; frontend swallows it |
| FE-10 | — | plausible | iPad page discard, backgrounded fetch, timer throttling |
