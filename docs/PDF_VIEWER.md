# PDF Viewer Architecture

Authoritative reference for BoardRipper's PDF viewer pipeline. Complements the
PDF-related bullets in `CLAUDE.md` with the level of detail needed to work on
the render path without breaking it.

## Goals

- Read large engineering schematics (50–500+ pages, A3 at 300 DPI+) smoothly in
  a browser, side-by-side with a board view
- Support zoom up to ~10× with text that stays crisp enough to read component
  designators
- Multi-page vertical scroll with seamless transitions
- Search + multi-term grouping + click-to-lookup tied back to board components
- Erase vendor watermarks (`www.chinafix.com`, etc.) before they ever reach the
  canvas
- Run on integrated-GPU laptops without melting the machine

## Core files

| File | Responsibility |
|---|---|
| `src/frontend/src/panels/PdfViewerPanel.tsx` | React panel, event handling, render orchestration, tier math, tile DOM management |
| `src/frontend/src/pdf/tile-manager.ts` | Tile grid math, `ImageBitmap` LRU tile cache |
| `src/frontend/src/store/pdf-store.ts` | Document lifecycle, text extraction, watermark skip sets, `getPageFor` |
| `src/frontend/src/hooks/usePdfStore.ts` | `useSyncExternalStore` snapshots for per-document state |
| `src/frontend/src/store/render-settings.ts` | Quality presets, watermark filter config, `isPdfWatermarkText` |
| `docs/PDF_VIEWER.md` | This file |

## Two render paths, one router

`renderActive()` in `PdfViewerPanel.tsx` routes every render request based on
`zoomRef.current`:

- **zoom ≤ 1.05 — full-page path** (`renderPage`): renders the whole current
  page to a pooled offscreen canvas, produces an `ImageBitmap`, caches it in
  `_pageCache` keyed by `(file, page, tier, cleanMode)`, blits to the visible
  main canvas. Adjacent pages (one above, one below) are rendered separately by
  `renderPageToBitmap` into `adjCanvasMapRef` for vertical scroll continuity.
- **zoom > 1.05 — tiled path** (`renderTiledPage`): divides the page into
  1024×1024 pixel tiles via `tile-manager.computeTileGrid`, checks each tile
  against the LRU tile cache, renders misses sequentially with pdf.js's
  `viewport.offsetX/offsetY` trick (no composite canvas), blits rendered tiles
  in a single `requestAnimationFrame`.

The 1.05 threshold has hysteresis built in: we don't switch paths on tiny
sub-percent zoom changes. At the boundary, `clearTileDom()` and the main-canvas
visibility toggle (`tiledMode` state) handle the handoff.

## The tier pipeline

Every render goes through four transforms before calling `page.render()`:

```
zoom → mainTierFromZoom → quantiseTier → hysteresisFilter → clampCanvasScale
```

- **`mainTierFromZoom(zoom, maxTier)`** — clamps zoom into `[1, maxTier]`.
  `maxTier` comes from the active quality preset (`QUALITY_CONFIGS[quality].maxMainTier`).
- **`quantiseTier(tier)`** — snaps to half-integer steps (1, 1.5, 2, 2.5, …).
  Reduces cache key fragmentation so a user's zoom-to-1.37× hits the same cache
  entry as zoom-to-1.52×.
- **`hysteresisFilter(rawTier)`** — module-global state (`_lastCommittedTier`)
  with 5% upgrade threshold and 10% downgrade threshold. Prevents render
  thrashing at quantisation boundaries. The hysteresis state is reset to 0
  inside the `scheduleTierRender` trailing debounce so the final settle render
  always commits to the exact requested tier.
- **`clampCanvasScale(pageW, pageH, scale, maxDim)`** — clamps both individual
  canvas dimensions (`maxDim × maxDim`) and total pixel area (`maxDim²`). When
  a clamp actually reduces the requested scale, a one-shot warning is emitted
  via `log.perf.warn` (throttled per `pageW:pageH:maxDim` so it doesn't spam).

Final render scale: `hiresScale = baseScale × resTier × devicePixelRatio` then
clamped. `baseScale` is `containerWidth / unscaledViewport.width` so the page
CSS width always equals the container width.

## Adaptive throttle + trailing debounce (scheduleTierRender)

Every zoom event calls `scheduleTierRender()`, which does three things:

1. **Schedules a trailing debounce** (60 ms) that resets hysteresis and
   triggers one final crisp render. This is the "settle" — guarantees the
   final frame is at exact tier, not a CSS-scaled blurry backdrop.
2. **Fires an adaptive-throttle render** if the new candidate tier is higher
   than the currently displayed tier and the EMA of recent render times
   allows it. Throttle delay = `max(ema × 1.5, 16 ms)`. Fast pages get near-
   instant re-renders; slow pages get CSS-scaled zoom with the settle making up
   for it.
3. **Schedules a crisp-settle timer** (500 ms) that forces a full-tier render
   when the user has zoomed past the preset cap, accepting a longer wait in
   exchange for ultimate sharpness.

The "zooming out uses CSS downscale" optimisation is deliberate: tiles and
cached bitmaps at higher tiers look perfectly sharp when CSS-scaled down, so
we don't need to re-render on the way down.

## Page-level bitmap caches

Two caches, both module-level, both sized from the active quality preset:

- **`_pageCache`** (LRU) — stores rendered `ImageBitmap`s at all tiers. Keyed
  by `(file, page, tier, cleanMode)`. Bounded by BOTH entry count
  (`cacheMaxEntries`) AND total pixel area (`cacheMaxPixels`) — the tighter
  constraint wins. `getBestPageCache()` returns the highest-tier hit for a
  given `(file, page, cleanMode)` regardless of tier, used as the "no-blur
  flash" fallback while a fresh tier renders in the background.
- **`_previewCache`** (separate LRU, tier-1 only, 6 entries max) — dedicated
  to cheap backdrop fallbacks. Never evicted by hi-res bitmap pressure, so
  there's always a soft-but-present preview to blit when all else fails.

Both caches key on `cleanMode` because clean-mode renders apply a contrast
filter and must not mix with normal renders.

## Tile cache (tile-manager.ts)

A module-global LRU keyed by `(file, page, col, row, scale)`. Bounded by total
pixel area, configured via `setTileCacheLimit(maxPixels)` which follows the
active quality preset.

- `visibleTiles(viewport, grid)` returns tiles intersecting the viewport in
  center-out order so nearest tiles render first.
- `getTileCached` and `putTileCached` do their own LRU move-to-end and pixel-
  budget eviction, closing `ImageBitmap`s when evicted.
- `invalidateTileCache(file)` drops all tiles for a given document (called on
  clean mode toggle, watermark filter change, document close).

Per-tile DOM canvases live in `tileContainerRef.current` keyed by
`"${page}:${col}:${row}:${renderScale}"`. The page number is in the key so a
page transition at the same scale doesn't collide with the previous page's
tiles. When the DOM budget (`MAX_TILE_DOM = 80`) is exceeded, tiles not at the
current render scale are evicted first (oldest-insertion-order wins).

## Adjacent page rendering

When the user scrolls vertically and the next/previous page becomes visible in
the viewport, `adjCanvasMapRef` tracks a separate `HTMLCanvasElement` per
adjacent page. `renderPageToBitmap` is the shared path used by both the full-
page route and the adjacent-page effect, which lets adjacent pages reuse
`_pageCache` entries from normal navigation.

Adjacent pages render at `min(mainTier, maxAdjTier)` — capped at 4× for the
"high" preset even when the main page is at 10× — because seeing a slightly
soft next-page through the viewport edge is fine, and cutting their tier
dramatically reduces GPU pressure during high-zoom scrolling.

The adjacent-page effect is debounced (`adjSettleMs` from the quality preset,
100–300 ms) so we don't keep re-rendering neighbors during active zoom.

## Watermark filter (operator-level)

Vendor watermarks like `"w w w . c h i n a f i x . c o m"` at 50 pt rotated
45° are stripped at the pdf.js operator-list level — not by clipping, not by
post-processing:

1. `pdfStore.getWatermarkSkipSet(file, pageIndex)` computes a `Set<number>` of
   pdf.js operator indices corresponding to glyph-drawing operators
   (`OPS.showText` = 44, `OPS.showSpacedText` = 45, `OPS.nextLineShowText` =
   46, `OPS.nextLineSetSpacingShowText` = 47) whose effective font size
   (`|textMatrixScale × fontSize|`) matches any configured watermark text
   item's font size within 5% relative tolerance. The scanner walks the op
   list in order, tracking `setFont` and `setTextMatrix` to maintain the
   effective-size state.
2. `isPdfWatermarkText(str, filter)` does whitespace-insensitive,
   case-insensitive substring matching so a filter entry of
   `"www.chinafix.com"` catches `"w w w . c h i n a f i x . c o m"` as a
   literal text item on the page (from `page.getTextContent()`).
3. The computed skip set is cached per `(file, pageIndex, filterSig)` on the
   document itself (`watermarkSkipSets` array). Changing the filter clears all
   skip sets and re-triggers background prewarm.
4. All three render paths (`renderPage`, `renderTiledPage`, `renderPageToBitmap`)
   pass the skip set to pdf.js via the public `operationsFilter` parameter on
   `page.render()`. pdf.js's `CanvasGraphics.executeOperatorList` checks the
   filter before dispatching each operator — watermark glyph draws are
   **entirely bypassed**, while path/image operators run normally. Schematic
   content underneath the watermark is preserved pixel-for-pixel.

### Background prewarm

After text extraction completes, `_prewarmWatermarkSkipSets` computes skip
sets for every page in the background, one page per `requestIdleCallback`.
Falls back to `setTimeout(0)` on Safari. Running one page per idle tick
ensures the prewarm yields to user-interactive renders on the shared pdf.js
Worker queue — if the user opens a PDF and immediately starts zooming, their
renders slip in between prewarm pages.

## Canvas safety rules

These are invariants, not suggestions — violating any of them produces
visible corruption:

- **Offscreen pooled canvases** use `getContext('2d', { alpha: false })`.
  This is safe because we fully overwrite them on acquire.
- **Persistent canvases** (main visible, adjacent page canvases, tile
  canvases, highlight, glyph overlay) must NOT use `alpha: false`. Setting
  `canvas.width = N` is supposed to reset all attributes including alpha, but
  browsers are inconsistent, and a persistent canvas reused with stale alpha
  produces mirrored/flipped content. Only pooled "used once and released"
  canvases are safe to opt out of alpha.
- **Never pool pdf.js-rendered canvases.** After `page.render()` completes,
  the pdf.js Worker thread may still queue stale draw operations that reach
  the canvas microseconds later. If we return the canvas to the pool and
  another caller acquires it, those late draws land on the wrong content.
  Instead: abandon to GC by setting `width = 1; height = 1` after
  `createImageBitmap()` has captured the pixels we care about.
- **Canvas pool shrinks synchronously on release.** Never defer the `width =
  1; height = 1` step — if the pool hands out the canvas to a new caller
  before the shrink fires, the new caller starts with stale backing store.

## Stale render guards

`renderIdRef` (full-page path) and `tileRenderIdRef` (tiled path) are
monotonic counters incremented at the start of each render. Every async step
checks that the counter hasn't advanced, and bails out if it has. Without
this, a slow page mid-render followed by a user zoom would race the old
render's output against the new one and produce corruption.

## Page boundary crossing during pan

When the user scrolls vertically past a page boundary, `skipResetRef.current
= true` tells the page-change effect not to reset zoom/pan to defaults, so
the visual position stays continuous. The tile cache isn't cleared — the old
page's tiles slide out of view naturally as the new page's tiles render in.

## Click-to-lookup

Clicking on PDF text runs `hitTestWord` which:

1. Converts screen coordinates to wrapper-local coordinates via the current
   pan/zoom refs
2. Walks `textItemsForPage`, computes each item's oriented bounding box via
   `textItemRect(transform, width, vpT, scale)`, and finds the smallest-font
   item under the click point (watermark items are skipped since they always
   have the largest font)
3. Extracts the word under the click via character-width interpolation
4. If the word matches a board part or net name, triggers `focusPart` /
   `focusNet` on the board
5. Draws an orange highlight overlay and a "Double-click to search" tooltip
   above the click target for ~4 seconds

Double-click bypasses the part/net check and always stuffs the word into the
search input, overwriting any existing query.

## PDF↔PDF cross-lookup

Two open text PDFs can be explicitly linked 1:1 from the main bind (∞/○○)
menu in the PDF toolbar: the `BindLink` dropdown shows board associations on
top and, after a separator, a **Cross-link PDF** section listing the other open
PDFs (→ `PdfStore.linkDocs`/`unlinkDoc`). The bind menu renders whenever there
is a board OR another open PDF to link, so it appears even for board-less
PDF-only viewing. The link is symmetric, persisted in `localStorage`
(`pdf-link:<fileName>`, restored on `loadFile`) by the pure `pdf-links.ts`
module, and is independent of any board.

When linked, `handleTextClick` calls `PdfStore.crossProbe(sourceFile, word)`,
which runs the *existing* search machinery against the linked document via
`_runSearch(targetDoc, word, 'lookup', false)` — so navigation, snap-to-match
scroll, and highlight all reuse the in-doc search path. Re-clicking the same
token advances to the next occurrence (`_stepMatchInDoc`, cycling). Matching is
the same substring search as Ctrl-F, so short designators (`C1`) over-match;
the visible match count + cycling cover that. `crossProbe` never calls
`switchTo` (it must not steal the active-doc/keyboard context). No nets, no
pins, no OCR — text PDFs only.

Cross-lookup feedback ("No match for X in Y", "Linked PDF not open") is written
to the source doc's `crossProbeHint` field, which the source panel consumes
into a **toast** via `boardStore.addToast` (it is *not* rendered inline — the
inline path collided with the short `lookupHint` "Double-click X to search"
template and broke the toolbar layout).

## Performance envelope

Rough numbers on a modern laptop with integrated GPU, "high" quality preset:

| Scenario | Typical time |
|---|---|
| Initial page render at zoom 1× (cold) | 30–80 ms |
| Cache hit | < 5 ms |
| 12 tiles at zoom 5× (cold) | 36–120 ms total |
| Tile cache hit on pan | < 1 ms per tile |
| Text extraction, 100 pages | 2–5 s |
| Text extraction from IndexedDB cache | < 200 ms |
| Watermark skip set, per page | 5–20 ms (in pdf.js Worker) |

Memory budget at "high": ~120 MP page cache + ~80 MP tile cache, ~2 MB text
per document. `applyDeviceMemoryScaling` halves the pixel budgets on devices
reporting ≤ 2 GB RAM.

## Things that are deliberately not fixed

- **Hysteresis state is module-global.** `_lastCommittedTier` is shared across
  panels. In practice, user interaction is serialized per panel so the
  conflict window is microseconds — not worth the refactor cost.
- **`applyDeviceMemoryScaling` is one-shot at quality-config read.** No
  runtime response to memory pressure. `navigator.deviceMemory` is coarse
  anyway.
- **DPR is read fresh on every render.** No `matchMedia` listener. Moving a
  window between different-DPR monitors and never interacting will show soft
  pixels until any interaction triggers a re-render.

## Debugging tips

- Scoped loggers: `log.pdf`, `log.perf`, `log.cache` in the Debug Panel.
- Blur complaints: grep the Debug Panel for `clampCanvasScale` — if the user's
  page hit the clamp, there's a one-shot warning with the requested vs.
  clamped ratio.
- "Wrong page flashes during scroll" → check `tileRenderId` guards and the
  adjacent-page effect cleanup. The batch-display rAF in `renderTiledPage`
  removes transition-backdrop canvases once new tiles are up.
- "Mirroring / flipped tiles" → something is pooling a pdf.js-rendered
  canvas. Check canvas pool acquires and make sure we abandon (width/height
  = 1) after `createImageBitmap`, never `releaseCanvas`.
- Watermark filter not working → check `pdfStore.getWatermarkSkipSet` returned
  a non-empty set. If empty, either the filter is empty or no text items on
  the page match (check text extraction succeeded and the page actually has a
  text layer, not just a raster image).

---

## PDF text index

Backend-driven full-text index for all PDFs in the library. Pdfium (compiled to
WASM, run via wazero) extracts text from each file and stores it in a separate
`pdfindex.db` (SQLite FTS5 external-content table, porter + prefix tokenizer).
A pdf.js on-open fast-path (`ensureIndexed` in `pdf-index-client.ts`) uploads
the text extracted client-side for the currently-open file so that file is
searchable immediately, before the background indexer reaches it. The PDF Search
tab queries the index; results include donor-scoped filtering via the
`pdf_donors` membership table in `databank.db`.

### Engine

Pdfium compiled to WASM, embedded as a ~5 MB blob in the server binary and
executed via wazero (pure-Go, `CGO_ENABLED=0`). The pool is configured at
startup via `PDFINDEX_POOL_MAX` (default: 2). Each pool instance has a
**2-minute per-file kill** enforced via a `context.WithTimeout` and
`wazero.NewRuntimeConfig().WithCloseOnContextDone(true)` — a hostile or
looping PDF cannot permanently wedge a worker. Container memory floor: **1 GB**
(wazero JIT + pdfium heap; the default 512 MB scratch image is too tight for
larger corpora).

### Migration

v0→v1 migration drops the legacy `pdf_pages` and `pdf_text` columns from
`databank.db`, creates the `pdf_donors` membership table, and opens the
separate `pdfindex.db`. Migration is forward-only. If `pdfindex.db` cannot be
opened (e.g. missing write permission), the server degrades gracefully — PDF
search is unavailable but all other features continue normally.

### API

All `/api/pdfindex/*` routes require the standard auth cookie (same as other
write endpoints). `GET` routes are read-only and accept the read middleware;
`POST`/`PUT`/`DELETE` accept the write middleware.

#### Index control

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/pdfindex/stats` | Counts per state (`indexed`, `empty`, `failed`, `pending`, `indexing`) + total pages stored |
| `GET` | `/api/pdfindex/progress` | Live snapshot of the running sweep (`running`, `total`, `done`, `errors`, `current_file`, `started_at`) |
| `POST` | `/api/pdfindex/run` | Start (or resume) a background sweep over all pending files; idempotent |
| `POST` | `/api/pdfindex/stop` | Cancel the running sweep; returns final progress snapshot |
| `POST` | `/api/pdfindex/reindex` | Reset terminal rows to `pending` (body: `{"scope":"all"\|"failed"\|"empty"}`) then re-run |
| `POST` | `/api/pdfindex/reindex-watermark` | Same as `reindex` with `scope="all"` — used after watermark-terms change |
| `GET` | `/api/pdfindex/failed` | List all `StatusRow` records with `status="failed"` |

#### Per-file endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/pdfindex/status/{id}` | Returns `StatusRow` for file `{id}`; 404 if never attempted |
| `POST` | `/api/pdfindex/files/{id}/index` | Priority-enqueue `{id}` for backend pdfium extraction (fallback path when pdf.js fast-path fails) |
| `POST` | `/api/pdfindex/files/{id}/begin` | Atomic claim: transitions `{id}` to `indexing` iff currently `pending`/`failed`; 409 if already claimed |
| `PUT` | `/api/pdfindex/files/{id}/pages` | Batch-upload extracted page texts (body: `{"pages":[{"n":0,"text":"…"},…]}`); 16 MB cap |
| `POST` | `/api/pdfindex/files/{id}/finalize` | Set terminal state: `indexed` if pages were stored, `empty` if none; returns final `StatusRow` |
| `POST` | `/api/pdfindex/files/{id}/fail` | Mark `{id}` failed (body: `{"error":"…"}`); retryable on next `run` |
| `DELETE` | `/api/pdfindex/files/{id}` | Delete all index data for `{id}` (pages + status row) |

#### Donor endpoints (in `databank.db`)

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/databank/donors` | List all donor file IDs (`pdf_donors` table) |
| `PUT` | `/api/databank/donors/{id}` | Add file `{id}` to the donor set |
| `DELETE` | `/api/databank/donors/{id}` | Remove file `{id}` from the donor set |

#### Search

The search endpoint is registered on `PdfIndexHandler` but lives under the
databank path:

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/databank/search?q=…&scope=all\|donor` | FTS5 search over indexed pages; `scope=donor` restricts results to donor files; returns `{results, total, query}` |

### State machine

Five states stored in `pdf_index_status.status`:

```
pending ──(Claim)──► indexing ──(Finalize, pages>0)──► indexed
                         │                         └──(Finalize, pages=0)──► empty
                         └──(Fail)──► failed
                                          └──(Claim)──► indexing  (retry)

pending ◄──(ReclaimStale)── indexing  (watchdog: attempted_at age > 2 min)
pending ◄──(ResetForReindex)── indexed | empty | failed
```

- **`pending`** — file is known to the library but not yet indexed. All newly
  scanned PDFs start here.
- **`indexing`** — exclusively claimed by one worker (pdfium pool instance or
  pdf.js fast-path). The claimant refreshes `attempted_at` via `Heartbeat`
  during long extractions.
- **`indexed`** — at least one page of text was stored; file is searchable.
- **`empty`** — extraction ran to completion but produced no text (image-only
  PDF, encrypted, or no text layer).
- **`failed`** — extraction threw an error. Retryable: next `run` will
  `Claim` it again.

**Watchdog:** `ReclaimStale` is called periodically (every minute) by the
indexer sweep. Any row stuck in `indexing` with `attempted_at` older than
2 minutes is reset to `pending`, so a crashed worker doesn't permanently
block a file.

**Atomic claim:** `Claim` uses a single `INSERT … ON CONFLICT DO UPDATE … WHERE
status IN ('pending','failed')` and checks `RowsAffected() == 1`. No
separate `SELECT` + `UPDATE` race.

### Watermark lock-step

The watermark matching rule is shared between two implementations:

- **Frontend:** `isPdfWatermarkText(str, filter)` in
  `src/frontend/src/store/render-settings.ts` — used by the pdf.js render
  path and by the fast-path text upload to strip watermarks before indexing.
- **Backend:** `IsWatermark(s string, terms []string)` in
  `src/backend/pdfindex/watermark.go` — used by the pdfium extractor to strip
  watermarks from page text before writing to the FTS5 index.

Both apply the **same rule**: strip all whitespace from the candidate string and
from each filter term, compare case-insensitively as a substring match. The
rule is the contract. The two implementations must remain byte-for-byte
equivalent for matching behaviour. When changing the rule in one, change the
other in the same commit. Watermark terms are synced from the frontend config
key `pdf_watermark_terms` to the backend via the settings API; the backend
`CleanPageText` function applies them to every page before FTS5 insertion.

No claim is made about byte-for-byte identity of extracted text between pdfium
(backend) and pdf.js (frontend) — text layout, whitespace normalisation, and
glyph-to-Unicode mapping differ between the two engines.

### Ctrl-F

In-document find (Ctrl-F / Cmd-F) runs entirely on the in-memory pdf.js text
layer (`textPages` built from `page.getTextContent()` during document load) and
is **independent of the backend index**. It works on any open PDF regardless of
its index state (`pending`, `failed`, `empty`, or not yet known to the backend).
The backend index is used only by the library-wide PDF Search tab. Do not route
Ctrl-F queries through `/api/pdfindex/*`.

## Content deduplication

The library holds many byte-identical duplicate files — the same PDF copied
under different names/folders. Without dedup, identical content is run through
pdfium repeatedly (~10 s/file) and its FTS5 text stored N times. The dedup layer
extracts each unique PDF once and collapses copies in content-oriented views. It
is **non-destructive** — nothing on disk is touched — and **file-type-agnostic**
(PDFs and board files use one mechanism).

**Detection — size-bucket + sampled hash** (`databank/dedup.go`): a file with a
unique byte size cannot have a duplicate, so it's never read (`content_hash`
stays `NULL`). Files that collide on exact size get a content key:
`sha256(size ‖ full-file)` when ≤ 192 KiB, else `sha256(size ‖ head 64 KiB ‖
mid 64 KiB ‖ tail 64 KiB)` — a fixed ~192 KiB read regardless of file size.
Mixing the size into the digest means two different-sized files can never
collide. A 50 MB schematic and its copy match by reading 192 KiB each, not
100 MB. (Accepted: the sampled hash is near-zero, not mathematically zero,
false-positive for large files differing only in an unsampled region.)

**Data model:** `databank.files.content_hash BLOB` (`NULL` = unique-size
singleton), with a partial index `WHERE content_hash IS NOT NULL`. A **content
group** = all files sharing the same non-`NULL` `content_hash`; the **canonical**
member is `MIN(id)` (stable, deterministic). Groups are derived by `GROUP BY`,
no separate table. `pdf_index_status` gains `canonical_file_id` and a terminal
`'duplicate'` status.

**The "Find duplicates" pass** (`databank.DedupRunner`) is on-demand, not a tax
on every scan. It hashes only size-collision candidates (`SizeCollisionFiles`),
is idempotent (a file is re-hashed only when its size/mod_time changed — the
scanner clears `content_hash` to `NULL` on change), and reports live progress.
Triggered by the "Find duplicates" button in Settings ▸ Database info.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/databank/dedup/run` | start the pass |
| `POST` | `/api/databank/dedup/stop` | cancel |
| `GET` | `/api/databank/dedup/progress` | `{running,total,done,errors,current_file,started_at}` |
| `GET` | `/api/databank/dedup/stats` | `{groups,duplicate_files,bytes_dedupable}` |

**PDF-index integration:** when the indexer claims a file, if it is a
non-canonical duplicate (`Source.CanonicalFor` resolves a canonical ≠ itself) it
records `status='duplicate'` + `canonical_file_id` and **skips extraction** — no
pdfium work, no second copy of text. The canonical (`MIN(id)`) always extracts,
so exactly one member of each group is indexed regardless of worker order.
`'duplicate'` is terminal (skipped by `DoneOrActiveFileIDs`, non-claimable).

**Presentation — collapse rule:**

| Surface | Behavior |
|---|---|
| **Folder view (DB + Live)** | Show everything — every file at its real path. No collapse. |
| Board # / Model | Collapse each content group → canonical row + `×N` chip (`collapseByContent`). |
| PDF Search | One hit per group (canonical) + a `+N copies` spoiler listing the copy paths (`copies[]` on each result). |
| PDF indexing | Extract the canonical only. |

Collapsing is purely a query/render concern keyed on `content_hash`; a `NULL`
hash always renders as itself. History view is **not** collapsed — it lists
distinct user-opened paths, not a content-grouped file list.
