# PDF viewer performance — review

**Date:** 2026-10-03 · **Reviewed:** `main` at 489aca6 · pdf.js 5.5.207

Five investigations, each measured with Playwright on the real schematic PDFs,
followed by a second pass that tried to refute every finding by re-measuring it.
Where the second pass changed a number or a conclusion, this document carries
the corrected version and says so. Findings that did not survive are kept in
[Checked and not a cause](#checked-and-not-a-cause) so nobody measures them
again.

Test rig: `samples/pdf/GU603HE.pdf` (13.5 MB, 103 pages) and
`samples/pdf/NR2201ZE_2.1.pdf` (19.1 MB, 101 pages), Chromium, device pixel
ratio 2 unless stated, CPU throttle 1× and 4× (the 4× runs stand in for a
tablet). Details in [How to measure](#how-to-measure).

Three limits apply to everything below:

- **Safari was not measured.** Playwright's WebKit is the Mac port. It showed
  17 ms frames on every gesture and does not reproduce "worst in Safari". Every
  Safari statement here is inference and is marked as such.
- **Most timings are from the Vite dev server.** React costs are upper bounds;
  pdf.js and canvas costs are not inflated. Where a production build was
  measured, it says so.
- **CDP throttling slows the main thread only.** The pdf.js worker ran at full
  speed in the 4× runs, so worker-side times understate a tablet.

Reference numbers:

| | |
|---|---|
| Default render mode | `standard` — full page at every zoom, tiles never used (`render-settings.ts:724`) |
| Canvases in the wrapper at ~780 %, DPR 2, inner page | main 8192×5060 + **4 neighbours ~8192 px wide, all off screen** — 608 MB of neighbours alone; 283 MP ≈ 1.1 GB in the worst run |
| Pinch at ~170 %, 4× CPU, long-task time, standard vs auto | GU603HE 2985 ms vs 810 ms · NR2201ZE 7468 ms vs 2868 ms |
| 8-notch Ctrl+wheel zoom on NR2201 p68, 4× CPU | 15 `page.render` calls, 7 cancelled, 5.2 s to quiet, ~3.2 s of it neighbours + preview |
| Panel re-renders during a pinch | 169 of 170 frames; ~15 ms each at 4× (dev build) |
| Paint of one heavy page (74 k ops), 4× CPU | 260–607 ms from 914 px to 8192 px; one 1024² tile 153–236 ms, **empty tile the same** |
| Pan and pinch frames, real GPU, production build, 4× CPU | median 16.67 ms, p95 16.67 ms |
| File pick → first page, local file | 0.3–1.0 s at 1×, 0.9–1.2 s at 4×, **nothing on screen meanwhile** |
| Text extraction, first open | 2.5–6 s; ends in one IndexedDB put that blocks 85 ms (1×) / 357 ms (4×) |

---

## Summary: what makes it feel laggy

In order of what the user feels.

1. **Every zoom settle renders the whole page and four neighbours nobody can
   see.** In the default mode the page is drawn in full at tier × DPR (up to
   8192 px wide) on the main thread, then two pages on each side are drawn at
   up to tier 4. On an 8-notch zoom at 4× CPU, about 3.2 s of the 5.2 s until
   the viewer goes quiet is neighbours and the tier-1 preview. Removing the
   neighbour canvases took a software-raster pan from up to 14 long tasks to 0.
2. **Zooming past the canvas clamp re-renders the same bitmap.** At DPR 2 every
   tier from 4 to 10 clamps to the same 8192-px canvas, but the page cache is
   keyed by the nominal tier. Each half-tier step is a fresh 63 MP render of
   pixel-identical output: 7–8 full renders per 8→4 or 4→8 zoom leg, and the
   8192×5789 render was started five times and cancelled before it finished
   once.
3. **The whole 4100-line panel re-renders on every zoom frame to update the
   `%` readout.** 169 of 170 pinch frames. With the readout written straight
   to the DOM, pinch at 100 % under 4× CPU went from a 33 ms to a 16.7 ms
   median frame and from 122–137 to 1–9 frames over 32 ms (dev build; the
   production gain is smaller and was not measured).
4. **The first zoom after reading a page for four seconds is slower.** The
   idle cleanup drops every parsed page and the worker's font cache; the next
   gesture re-parses the current page and its four neighbours. Settle time
   1.0–1.1 s vs 0.8 s at 1×, 2.6–3.3 s vs 1.6–1.9 s at 4×.
5. **Opening a PDF shows nothing until page 1 is painted.** 0.3–1.2 s locally;
   the whole download on top of that from a NAS. This is the "no progress
   indicator" report. It is not slowness — the engine opens a 19 MB file in
   10–50 ms — it is silence.
6. **A page flip while scrolling is one 50–90 ms task** at 4× CPU (32–94 ms in
   a production build): the panel re-render plus the blits plus a compositor
   commit.
7. **Text extraction ends with a freeze.** One structured clone of ~8.6 MB into
   IndexedDB: 85 ms at 1×, 357 ms at 4×, a few seconds after open, when the
   user has started zooming.
8. **Memory.** 600 MB to 1.1 GB of canvas backing at high zoom on a DPR-2
   screen, most of it off screen. On a Mac with a GPU this costs no frames. On
   Safari and iPadOS it is the most plausible reason for "worst in Safari"
   (inference; WebKit caps canvases at 4096 px, so the figures there are
   smaller, and nothing was measured on a device).

What it is **not**: per-frame pan and pinch cost on a machine with a GPU
(a flat 60 fps at 4× CPU in a production build), the watermark and prune
patches, or pdf.js opening the file.

---

## 1. Input and paint

### 1.1 The panel re-renders once per zoom frame for the `%` readout

**Evidence.** `syncTransform` (`PdfViewerPanel.tsx:1231-1240`) calls
`setZoomDisplay(zoomRef.current)` in a rAF. `zoomDisplay` is read once, at
`:4034`. The panel rendered on 169 of 170 pinch frames; a pan re-rendered it 25
times. A/B with the call replaced by a `textContent` write (dev build):

| Scenario | Frame p50, before → after | Frames > 32 ms, before → after |
|---|---|---|
| pinch at 100 %, unthrottled | 16.7 → 16.7 ms | 0 → 0 |
| pinch at 100 %, 4× CPU | 33.2 → 16.7 ms | 122–137 → 1–9 |
| pinch at 300 % tiled, 4× CPU | 34.6–48.3 → 31.4–32 ms | 148–161 → 77–84 |

Per render: ~2.6–4 ms on the M1, ~15 ms at 4×. In a production build with a
real GPU the same rAF callback is about 4 ms of an 8.4 ms frame at 4× — inside
a 60 Hz frame, over the 8.3 ms budget of a 120 Hz iPad.

**Mechanism.** `useState` in the top-level component. Pan does not pay because
an unchanged value bails out.

**Fix.** Write the readout to a ref'd span in the rAF. After the fix one root
commit per zoom frame remains from some other component; the candidate is the
per-event `log.ui.log('pdf wheel pinch (ctrlKey)')` at `:2797` feeding a
log-store subscriber. Remove that log, or log once per gesture — it is also the
per-pointer-event logging the conventions forbid.

**Expected gain.** Pinch at low zoom on a slow device: half the frame time.
At high zoom tile or page work still dominates. Smaller in production than the
dev figures above.

**Confidence.** Measured, re-measured. One correction: it is one commit per
frame, not two; the body runs twice only under dev StrictMode.

### 1.2 A page flip during a pan is one long task

**Evidence.** GU603HE, 4× CPU, 12 flips: every flip sits in a 50–91 ms task on
the dev server and a 32–94 ms task in a production build. The task is the
`PdfViewerPanel` re-render and its effects (main blit, 1–2 new neighbour blits,
highlight) at 17–54 ms, and a compositor commit at 6–29 ms. Canvas work in JS
is 2–9 ms.

**Mechanism.** `flipPagesForPan` → `pdfStore.goToPage` → `notify` →
`useSyncExternalStore` re-renders the panel synchronously, before the next
frame (`PdfViewerPanel.tsx:1095-1137`).

**Fix.** Make the panel cheaper to re-render on a `currentPage` change: move
the page-dependent UI (page number, scrubber, bookmarks) into a small child
component, or defer the store notify to the rAF. A main/neighbour canvas role
swap would remove the blits. The originally proposed fixes do not help — see
the refuted list.

**Expected gain.** Not measured. Note that in the same production trace about
25 non-flip frames were just as long (35–116 ms, Layout 15–48 ms each); those
need a separate look and removing the flip cost alone will not give a
drop-free scroll.

**Confidence.** Symptom measured in dev and production. Fix not A/B-tested.

### 1.3 Extraction progress re-renders the panel while the user pans

**Evidence.** `pdf-store.ts:923` notifies every 5 pages. Pan during extraction
at 4×: 15–18 commits = 149–275 ms of panel render in 2.4 s, wheel p50 25–30 ms
vs 22.5 ms settled. A second measurement put the per-notify frame gap at
≤ 19 ms. The window is 2.5–6 s after the first open of a file.

**Fix.** Throttle the progress notify to ≥ 250 ms. Have `getDocSnapshot`
return the previous object when nothing in it changed, so unrelated notifies
stop re-rendering `PdfTab` and the panel. `BoardTab` re-renders on every PDF
notify for its own reason (`_pdfNamesCache = null`).

**Confidence.** Measured, not re-checked. Low impact.

---

## 2. Engine (pdf.js)

### 2.1 Paint cost follows the operator count, and it is all on the main thread

**Evidence.** NR2201ZE p68, cached operator list (74,087 ops with the default
prune), main thread at 4× CPU:

| Canvas | Render time |
|---|---|
| 914×646 | 280 ms |
| 2285×1615 | 260 ms |
| 3656×2584 | 370 ms |
| 5484×3875 | 522 ms |
| 8189×5787 | 607 ms |
| one 1024² tile at tier 8.96 | 153–236 ms |
| an **empty** corner tile | the same as a mid-page tile |

Unthrottled 87–175 ms. Each render spans 13–19 rAF frames.

**Mechanism.** pdf.js has no viewport culling: every render walks the whole
operator list and the canvas clip discards pixels. It runs in 15 ms slices
(`EXECUTION_TIME`, `pdf.mjs:10471`), so up to about 3656 px the frame gap stays
at 34 ms with no long tasks; gaps of 100–150 ms appear from 5484 px. **Tiling
multiplies the op cost by the tile count** — this is why the tile path is not a
free win (see 3.3).

**Fix.** Fewer renders first (sections 3.1, 3.2). The structural fix is
painting in a worker with `OffscreenCanvas` and returning a transferred
`ImageBitmap`, which the page cache and tiles already consume. A prototype ran:
same 74,087 ops, ink present, main-thread frame gap 17 ms at every size, wall
time 61–217 ms.

**Risk of the worker route.** pdf.js has no official worker display mode. The
prototype needed a custom `CanvasFactory`, a stub `FilterFactory` (drops
SVG-filter features: transfer functions, luminosity masks),
`ownerDocument: { fonts: self.fonts }` and `useWorkerFetch: false`; it crashed
under the Vite dev client and needs its own bundling. Not verified: embedded
font fidelity (no pixel diff), Safari (nested workers and `FontFaceSet` in
workers), and memory — the render worker holds a second `PDFDocument` and its
own parse worker.

**Confidence.** Measured, re-measured. The original figure of 148 k ops was
with prune off.

### 2.2 Idle cleanup throws away the pages the user is looking at

**Evidence.** `pdf-store.ts:1022-1032` calls `doc.cleanup(true)` 4 s after
every page change (armed at `PdfViewerPanel.tsx:1325`). GU603HE p68, wait 7 s,
then 8 zoom notches, cleanup live vs stubbed, two runs each:

| | With cleanup | Without |
|---|---|---|
| Renders starting with no cached op list | 5 (pages 66–70) | 0 |
| Time to quiet, 1× | 1022 / 1098 ms | 822 / 829 ms |
| Time to quiet, 4× | 3337 / 2644 ms | 1644 / 1944 ms |

The current page's first sharp render is delayed only 20–50 ms (1×) / ~100 ms
(4×); most of the penalty is the neighbours.

**Mechanism.** `PDFDocumentProxy.cleanup` is document-wide. `startCleanup`
(`pdf.mjs:15998-16016`) sends the worker `Cleanup` first — the worker drops its
font, image and page caches — and only then checks for a page that is
rendering and throws. So the store's "retry next idle" catch runs after the
damage is done.

**Fix.** Use per-page `PDFPageProxy.cleanup()` for pages outside
`currentPage ± 3`; it sends no worker message and keeps `commonObjs`. Keep the
document-wide cleanup for memory pressure (for example more than 40 parsed
pages), and check our own in-flight render count before calling it.

**Expected gain.** 0.2–0.3 s per idle-then-zoom cycle at 1×, 0.7–1.7 s at 4×,
mostly in how fast neighbours sharpen. The originally reported 0.9 s / 4.9 s
did not reproduce.

**Confidence.** Measured, re-measured. The "currently rendering" ordering is
confirmed from the pdf.js source, not seen at runtime.

### 2.3 Text extraction shares the one worker with the first renders

**Evidence.** First open, no IndexedDB cache: 101 `GetTextContent` streams,
195,612 items, ~36 MB of worker→main traffic (NR) / 25 MB (GU); 2.5 s at 1×,
4.85 s at 4×, 10 long tasks = 1160 ms on the main thread at 4×. Fresh renders
issued during extraction were 1.8–3× slower (NR p1 77 vs 42 ms, p9 88 vs 30 ms;
GU p5 126 vs 41 ms). `GetPage → StartRenderPage` for page 1: 37–61 ms with
extraction, 7–15 ms with it stubbed.

**Mechanism.** `_extractText` starts inside `loadFile` (`pdf-store.ts:815`),
in the same instant as the panel's first render, and the single worker
interleaves both at 20 ms slots.

**Fix.** Start extraction after the first blit (the same hook the loading
indicator needs, section 4). Extract `currentPage ± 1` first. Later: a second
`getDocument` on the same buffer so extraction uses another core.

**Expected gain.** 30–50 ms on the first page on this Mac; more on a slow
worker (inferred). First open of a file only.

**Confidence.** Measured, not re-checked.

### 2.4 The end of extraction blocks the main thread

**Evidence.** `pdf-store.ts:934` → `board-cache.ts:477-486`: one `store.put` of
the whole `textPages` array (GU603HE: 103 pages, 63,868 items, 8.6 MB as JSON).
It blocks 85 ms at 1× and 357 ms at 4×; a bare `structuredClone` of the same
array costs 86 / 308 ms, so the clone is the whole cost.

**Fix.** Either measured to work: ten-page puts cost 0.6–5 ms each at 1× and
2.6–18 ms at 4×; a compact form (one `Float32Array` plus string arrays per
page) clones in 11 / 45 ms for the whole document. Chunked puts must yield
between slices — one transaction per slice or a `setTimeout` chain — or they
add up to the same freeze.

**Confidence.** Measured, re-measured, both fixes measured.

---

### 2.5 pdf.js itself: where a render's time goes, upstream, and whether to fork

Measured on 2026-10-04 against pdfjs-dist 5.5.207 (what we ship), Chromium on an M1, NR2201ZE_2.1.pdf page 68 (148 k operators, the heaviest page in the samples).

#### Where a render's time goes

A warm render — operator list and `Path2D` objects already cached — of one 1024×1024 tile at 8× costs the same whether the tile is in the middle of the page or in an empty corner: 45–60 ms either way (10 runs each). A full-page render at 914 px costs 63–73 ms warm. The cost is the **operator walk**, not the pixels: `CanvasGraphics.executeOperatorList` visits all 148 k operators for every render, and the canvas clip only discards what they draw.

CPU profile of ten warm tile renders (self time):

| share | where |
|---|---|
| 30 % | `(program)` — native canvas and V8 internals |
| 22 % | `ctx.save` / `ctx.restore` / `CanvasExtraState.clone` — one state clone per `q` |
| 12 % | text: `showText`, `fillText`, `setFont` |
| 8 % | garbage collector |
| 6 % | `FontInfo.#readBoolean` — font flags read from a `DataView` with an `assert` on every access |
| 4 % | `executeOperatorList` dispatch |
| ~5 % | paths: `constructPath`, `stroke`, `rescaleAndStroke`, `getTransform` |

Nothing in that table is a 2× fork. The op-walk is ~0.35 µs per operator and spread across a dozen small costs.

#### Culling, tested and rejected

pdf.js already skips a **fill** whose bounding box misses the clip (`getClippedPathBoundingBox` → `null`), but not a **stroke** — and a schematic is almost all strokes. I patched the same test into `stroke()` (padded by `lineWidth/2`, × `miterLimit` for mitred joins; byte-identical output) and measured: the empty corner tile did not get cheaper (43–68 ms vs 42–70 ms). Chromium's canvas already rejects a `Path2D` outside the clip for almost nothing; the time is in reaching the call, not in the call. Culling at the canvas layer is therefore not worth a fork. Culling at the *operator-list* level (a spatial index so a tile walks only the operators that can touch it) would work, but state operators (`q`/`Q`, `cm`, colours, fonts) must still execute in order, which is what makes it a real project rather than a patch.

#### Upstream since 5.5.207

Latest is **6.4.299** (2026-10-03). Release notes 5.6 → 6.4, filtered for rendering ([releases](https://github.com/mozilla/pdf.js/releases)):

- 5.7: PostScript lexer/parser rewrite with a small Wasm compiler (function-based shadings), fewer allocations compiling CFF fonts, "avoid intermediate canvases" (#21061).
- 6.0: `[api-major]` minimum browsers raised, polyfills removed; `getDocument` requires a parameter object; `ImageDecoder` by default on Chrome; soft-mask composition faster (#21235); `getDestinations` no longer stalls on many named destinations.
- 6.1–6.4: blend-mode and appearance fixes, `Intl.Segmenter` for word search, internal structures converted to `Map`/`Set`, `MessageHandler` modernised, and — relevant to the watermark patch — `[api-minor]` the `operationsFilter` callback now receives the operator list (#21868).

None of it touches the operator walk. A bump to 6.x is maintenance (re-port the seven-site worker patch and the prune patch; check `getDocument` call shapes), not a performance step, and the 6.1 image regression (#22039, `convertRGBToRGBA` quadratic in image height, ~9× slower on scanned pages) says to wait for it to settle.

#### The two upstream designs that matter

**Render in a worker — PR #21860 "Offload canvas drawing operations to a worker"** ([link](https://github.com/mozilla/pdf.js/pull/21860)), open since 2026-09-01, under active review, off by default (`disableWorkerRendering`). The worker draws into an `OffscreenCanvas` and returns an `ImageBitmap`; partial frames every ~500 ms. Their own numbers: main-thread blocking → negligible, but **vector-heavy pages 2.4× slower warm** (201 → 485 ms for 100 k operators) because `Path2D` cannot be transferred and is rebuilt per render, plus a fixed 3–4 ms round-trip. For a schematic viewer that is a bad trade today; watch it, do not fork it. If it lands with Path2D caching on the worker side, it becomes the structural answer to "paint never blocks a gesture".

**Render only the visible area — `PDFPageDetailView`** (PR #19128, merged 2025-02, in every version we could run): the upstream viewer keeps a CSS-zoomed low-resolution base canvas and, above the canvas-size cap, renders **one** canvas covering the visible area plus a 100 % margin on each side, re-rendered when the user scrolls near its edge or zooms. That is one op-walk per settle. Our tile path does the same work as N tiles (N op-walks — six visible tiles of page 68 ≈ 300 ms where one viewport render is ≈ 60 ms), and our full-page path does it into a 50 MP canvas. The one viewport-sized canvas in 5.4 (Phase 2 item 4) is this design.

#### What this means for the plan

The engine's per-page cost is fixed at roughly 50–110 ms warm on an M1 (several × that on an A12Z) for the heaviest pages, and only the number of times we pay it is ours to change: one viewport render per settle instead of a whole page or six tiles; no neighbour pages rendered at zoom; no idle cleanup that forces the current page to be re-parsed; the settle debounced on the gesture, not on 60 ms. Those are viewer changes, and they are where the measured seconds are.

## 3. Tiles, caches and neighbours

### 3.1 Four neighbour pages are rendered at high tier whether or not they are visible

This is the largest single cost and all five investigations ran into it.

**Evidence.** `PdfViewerPanel.tsx:2258-2264`:
`adjCount = max(1, ceil(pagesInView/2)+1)`, which is 2 as soon as one page
fills the viewport, at `min(tier, maxAdjTier)` (4 on the `high` preset) × DPR,
with no test for whether the neighbour intersects the viewport.

- At ~780 %, DPR 2, inner page: four `.pdf-adjacent-page` canvases of
  8191×2411, 8192×5748, 8192×5711, 8192×5595 = **608 MB**, all outside the
  container, next to a 158 MB main canvas. At DPR 1: 167 MB.
- At ~170 %, DPR 2: four neighbours of ~15 MP each, none on screen.
- 8-notch zoom at 4× CPU: ~3.2 s of the 5.2 s to quiet is neighbours plus the
  preview.
- Pages 67 and 69 were rendered **twice concurrently** at tier 4. The likely
  cause is the idle prefetch in `renderPage` (`~1696-1720`) racing the adjacent
  effect (`~2258-2350`) for the same cache key; callers were not attributed.
- One neighbour bitmap is 34 MP. With a 63 MP main bitmap the 120 MP page cache
  (`:127`) holds one of each, so "prefetched page N tier=4" logged 7–8 times
  per zoom leg: the neighbour is evicted and rendered again each time.

**Fix.**

- Keep ±1 always — continuous mode needs them for scrolling and page flips, and
  the "blank paper" failure of 2026-09-19 is what happens without them. Drop
  ±2 when one page fills the viewport.
- Cap a neighbour that does not intersect the viewport at tier 1–2. It is only
  ever seen at a page edge.
- Start neighbour renders after the main render has painted (rAF + idle), not
  in the same settle burst.
- Make the prefetch and the adjacent effect share one in-flight map so a page
  is not rendered twice for one key.
- Give neighbours their own cache budget so they cannot evict the main page.

**Expected gain.** Roughly 60 % of zoom-settle time at 4× CPU on a heavy page
(plausible from the 3.2 s of 5.2 s; not A/B-measured). About 600 MB of canvas
backing at DPR 2 at high zoom. The page cache stops thrashing.

**Confidence.** Measured, re-measured three times independently.

### 3.2 Past the canvas clamp, every tier step re-renders the same pixels

**Evidence.** `high` preset, `maxCanvasDim` 8192, DPR 2: every tier from 4 to
10 produces the same 8192-wide bitmap. The page cache key uses the nominal
tier. Measured: 8→4 took 7 full 63 MP renders, 4→8 took 8, 8→4 again 7;
`createImageBitmap` traffic 678–775 MP per leg. On NR2201 p68 the 8192×5789
render was started five times and cancelled after 373–865 ms each before the
sixth completed.

A notch that stays inside tier hysteresis is already a cache hit.

**Fix.** Key the page cache on the clamped pixel size, and skip a render whose
clamped viewport equals the one shown or in flight.

**Expected gain.** Removes nearly all re-renders in the 4×–8× range and the
five identical restarts. Not A/B-measured.

**Confidence.** Measured; found by the second pass, in two separate runs.

### 3.3 Standard vs auto (tiles): do not flip the default yet

The two modes were compared in three runs and the answer depends on zoom.

| Run | Standard | Auto |
|---|---|---|
| Pinch to ~170 %, 4× CPU, long-task time (GU / NR) | 2985 / 7468 ms | 810 / 2868 ms |
| Same, frames > 100 ms (GU / NR) | 22 / 43 | 3 / 12 |
| One settle at 800 %, DPR 2 | 80–320 ms, one 63 MP page | **920 ms, 56 tiles** |
| Zoom back 8→4, DPR 2 | 7 full renders | 37–38 of 56 tiles re-rendered, 626–644 ms |
| Canvases at 800 %, DPR 2 | 283 MP | 124–132 MP |
| Pan and pinch with a GPU | 60 fps | 60 fps |

So auto cuts long-task time by 60–75 % at moderate zoom and roughly halves
canvas memory, but at 800 % a settle is slower than the full-page path because
the tile window is far larger than the screen. Flipping `pdfRenderMode` is
also not one constant: standard was made the default on purpose in 1b50386
(2026-05-27), the Settings text calls it the default, and installs with a
persisted mode would not pick up a new default without a migration (the
persistence code was not checked).

**The tile path's overdraw.** `TILE_RENDER_ALL_THRESHOLD = 30`
(`PdfViewerPanel.tsx:1861`) and `PAD = 2` (`:1879`); `colMax/rowMax` use
`Math.ceil(...) + PAD`, which overshoots by one more, so the pad is 2 before
and 3 after. With 1024-px tiles a 914×586 viewport at 8× spans about 2×2 tiles
and gets a window of 42 (DPR 1, the whole page) or 56 (DPR 2). The tile key
includes the exact `renderScale` (`tile-manager.ts:67`) and `quantiseTier`
steps by 0.5 (`:244`), so a ×1.1 notch at tier 8 re-renders the whole window
with zero reuse (42/42 in 700 ms, 49/49 in 821 ms). The 72 MP tile cache does
not hold two zoom windows at DPR 2. All rendered tiles are displayed in one
rAF (`:2061`), so nothing appears until the last one is done. Each tile is
also kept twice — an `ImageBitmap` in the LRU and a 4 MB DOM canvas — and at
800 % 50 of 56 displayed tiles are outside the viewport.

**Fix.** Pad in CSS px (one viewport) rather than in tiles, and use `floor`;
lower the render-all threshold or make it viewport-relative; display tiles as
they finish; whole-tier quantisation above tier 4; size the tile budget by
DPR². Keep 1024-px tiles: every tile replays the page's operator list (2.1),
so 512-px tiles quadruple a fixed cost. Hiding off-viewport tiles needs a
covered-viewport check, because old-scale tiles are kept on purpose as a
backdrop against blank flashes.

**Expected gain.** 42–56 tiles → 16–25 per settle with `PAD = 1` alone, 12–16
with the `floor` change; at ~17 ms per tile that is 200–400 ms instead of
700–920 ms — parity with the full-page path on time, with a fraction of its
allocation churn and real sharpness above the 8192 clamp.

**Confidence.** Measured, re-measured. The after-fix tile counts are derived
from the code.

### 3.4 Unconditional canvas reallocation per settle

**Evidence.** `PdfViewerPanel.tsx:1624` sets `canvas.width = viewport.width`
on every full-page render; `:1648` and `:1838-1839` size the highlight canvas
to the full page on every render, with zero matches. `blitToCanvas` (`:1460`,
`:1471`) is already guarded. Counts in one 3 s pinch at 3×, standard, 4× CPU:
57 `canvas.width` sets = 473 MPx and 15 `createImageBitmap` calls = 447 ms
(another run measured `createImageBitmap` of an 8192×5782 canvas at 1–15 ms
unthrottled in Chromium).

**What the highlight canvas really costs.** Its only `getContext` is at
`:2168`, after the "no matches" early return. A context-less canvas, or one
that was never drawn to, allocates nothing in Chromium (measured by process
RSS). So on a PDF that was never searched it is free. While a search has
matches it is a real full-page backing store (270–480 MB RSS at
6203×5815–8191×7678), and after a search is cleared the drawn backing stays
until the next tier commit.

**Fix.** Guard `:1624` on a size change. Skip the highlight resize when there
are no matches, and set its width to 1 when hiding it. Later: size it to the
viewport or use positioned divs.

**Confidence.** Counts measured; the per-call cost of `createImageBitmap` is
not settled between two runs. Not all of this was re-checked.

### 3.5 Docs say `auto` is the default

`render-settings.ts:343` (`'auto' (default)`) and `docs/PDF_VIEWER.md`
("Two render paths, one router") describe tiles above 1.05×. The shipped
default is `standard` (`:724`). Fix the comment and the doc; every
investigation here had to run twice because of it.

---

## 4. Loading UX: the progress indicator

### What happens today

From file pick to the first painted page nothing on screen changes: no panel,
banner, spinner or toast. Sampled every 25–200 ms on both files at 1× and 4×,
the `.pdf-viewer` panel first appears in the same sample as the first canvas,
and the `Loading {name}…` placeholder is never seen.

| | 1× | 4× CPU |
|---|---|---|
| GU603HE, pick → first page | 291–1009 ms (typ. 310–560) | 674–1219 ms |
| NR2201ZE, pick → first page | 361–963 ms | 811–1347 ms |

Over a NAS the wait also includes the 13–19 MB download, which happens before
any of this. That case was not timed (no backend in the test stack).

Why nothing shows:

- Every open path awaits `pdfStore.loadFile` before `ensurePdfPanel`
  (`store/file-actions.ts:78-79`, `:157-158`; `LibraryPanel.tsx:515`, `:575`,
  `:1486`; `session-store.ts:139`, `:149`). The placeholder at
  `PdfViewerPanel.tsx:3715-3719` lives in a panel that does not exist yet.
- `pdfStore._loading` (`pdf-store.ts:755`, exposed at `:573`) reaches only
  `usePdfStore` (`hooks/usePdfStore.ts:40`), which nothing imports.
- `BackgroundLoadBanner` reads `boardStore.backgroundLoads` only.
- `fetchFileBuffer` tracks download progress only for boards
  (`databank-store.ts:2333`). That gate is deliberate — see below.
- Text extraction has a progress value, shown as a 2-px unlabelled line
  (`index.css:4838-4847`, `PdfViewerPanel.tsx:4039-4043`).

### Design

**One signal: `pdfStore.loads`.** A stable snapshot `{count, names, byName}`
where each entry is `{name, phase}`, modelled on `boardStore.backgroundLoads`.
It is per file, because `_loading` is one global boolean and session restore
and multi-drop load several PDFs at once. Phases, set where the store already
knows them:

| Phase | Set | Cleared / advanced |
|---|---|---|
| `downloading` | by the open path before `fetchFileBuffer` (library opens only) | when the buffer arrives |
| `reading` | `loadFile`, before `file.arrayBuffer()` | |
| `parsing` | before `getDocument` (`pdf-store.ts:772`) | |
| `rendering` | after `getDocument` resolves | `pdfStore.markFirstPaint(name)`, called by the panel on its first blit (`PdfViewerPanel.tsx:1630`), and on load failure or tab close |

No percentage for `reading`/`parsing`: `loadFile` hands pdf.js a complete
in-memory buffer and the worker sent zero `DocProgress` messages in every run.
Phases are the honest signal. `downloading` can carry MB / % from the
`ReadableStream` loop that already exists at `databank-store.ts:2397-2417`.

**Three places it shows, following the status-message rules of 2026-09-22
(waiting is rendered as waiting, status in the strip, one transition per load).**

1. **The panel, created first.** Call `ensurePdfPanel(name)` before the fetch
   and before `loadFile` — it needs only the file name. `usePdfDoc(fileName)`
   has no document until `getDocument` resolves, so the panel needs an explicit
   "no doc yet" branch that reads `pdfStore.loads.byName[fileName]` and renders
   the file name, the phase and a spinner in the content area. On failure the
   same branch shows the error instead of leaving an empty panel.
2. **The app banner.** `BackgroundLoadBanner` renders
   `boardStore.backgroundLoads ∪ pdfStore.loads`. It is mounted in `App.tsx`
   over the dock area, so it also covers a PDF that loads into a background
   tab.
3. **A page placeholder for the first render.** Once `getPage` resolves,
   `page.getViewport({scale: 1})` gives the aspect; show a
   `.pdf-page-skeleton` of `cssW × cssH` in `.pdf-canvas-container` and remove
   it on the first blit. This also covers the 180 ms white cross-fade with the
   start page.

**Download progress: do not drop the `file_type === 'board'` gate.** The
comment above it (`databank-store.ts:2320-2327`) records why: a PDF `start()`
overwrote the in-flight board overlay during linked-PDF auto-load, and only the
board path ever calls `loadProgressStore.finish()`, so the overlay stayed until
the 30 s watchdog. Route the PDF download through `pdfStore.loads`
(`downloading` phase with bytes) instead of `LoadProgressOverlay`.

**Text extraction.** Keep `textExtractProgress`. Replace the 2-px line with a
small chip beside the search field (`Indexing 23/103`) and change the search
placeholder while `textExtracting`, so a search with no results during
indexing is not read as "not in the document".

`markFirstPaint` is also the hook for starting extraction after the first page
(2.3).

---

## 5. Compositing, memory and Safari

### 5.1 With a GPU, the gesture frames are fine

Production build, Chrome with ANGLE/Metal on the M1, DPR 2, 4× CPU, standard
mode: pan and pinch at 291 % and 782 % all median 16.67 ms, p95 16.67 ms, with
283 MP of canvases in the wrapper. Playwright WebKit: pinch at 300 % and 785 %
median 17 ms, p95 18 ms.

The 160–220 ms pan frames and the 1575 ms of
`CanvasResourceProviderSharedImage::ProduceCanvasResource` that two
investigations first reported come from **software compositing** in the default
Playwright headless shell, which copies every canvas per frame. That applies
to a GPU-blocklisted machine, not to a normal desktop. Do not judge PDF
smoothness in default headless Chromium or on the dev server.

### 5.2 Canvas memory

Sum of `width × height × 4` over the panel's canvases, GU603HE, Chromium DPR 2
(nominal: both engines can allocate lazily):

| Zoom | Standard | Auto |
|---|---|---|
| 100 % | 50 MB, 5 canvases | same |
| 291 % | 450 MB, 5 canvases | 310 MB, 47 canvases |
| 782 % | 785 MB (page 1) to ~1.1 GB (inner page) | 499 MB, 61 canvases |

Live `ImageBitmap`s add 300–430 MB. The tablet's bitmap caches are already
budgeted (30 MP + 18 MP on `medium`); the DOM canvases are not budgeted at all.
In WebKit the probe clamps canvases to 4096 px (`PdfViewerPanel.tsx:191-215`):
standard at 785 % is 124 MB of canvases + 86 MB of bitmaps, auto at 800 % is
211–268 MB + ~125 MB.

### 5.3 Safari (inference, nothing measured on a device)

Engine facts that make the same structure cost more in WebKit: no
`requestIdleCallback`, so the idle prefetch runs on a 200 ms timer
(`PdfViewerPanel.tsx:1742`) while the user is still zooming;
`createImageBitmap(canvas)` is a readback; large 2D canvases may not be
GPU-backed; iOS has a per-process canvas memory ceiling and purges backing
stores under pressure, which shows as blank or blurry pages and re-renders;
desktop Safari gets the `high` preset because only coarse pointers get
`medium`. The exact WebKit limits were quoted from memory and must be checked
against current source before anyone relies on them.

All of these scale with canvas volume and render count, so sections 3.1 and
3.2 are the Safari fixes too. A possible extra: cap `maxCanvasDim` /
`maxMainTier` on WebKit regardless of pointer type.

**The check that settles it:** real Safari and a real iPad, Web Inspector ▸
Layers on `.pdf-page-wrapper` at 800 % in standard and auto — layer count,
memory per layer, and whether the wrapper repaints during a pinch. rAF timing
cannot see a slow layer flush in the GPU process.

### 5.4 Proposed structure: one viewport-sized canvas

Keep the page and tile `ImageBitmap` caches as the only pixel store and
replace the main, tile and neighbour canvases with one canvas of container ×
DPR (1034×766 CSS at DPR 2 = 12.7 MB), redrawn per rAF when pan or zoom
changed. Highlights go in the same pass or a second viewport canvas; the touch
surface stays. `drawImage` from a cached bitmap measured at most 1–3 ms per
call in both engines (a lower bound; draws are deferred to the GPU).

Canvas memory would go from 310–785 MB to 13–25 MB plus the caches, layers
from up to 78 to about 3, and the canvas would never be resized during a zoom.
This is a rewrite of the display half of the panel (`blitToCanvas`, the tile
DOM section, neighbour canvases, `rescaleWrapperChildren`). The gain is
memory; the Safari smoothness gain is expected but not measured, so the device
check in 5.3 comes first.

---

## Checked and not a cause

| Claim | Why not |
|---|---|
| Pan and pinch lag is per-frame compositing of 150–200 MP of canvases | True only under software raster. On Metal the same 283 MP pans and pinches at 60 fps with zero long tasks. The footprint is a memory problem. |
| "0 long tasks in auto mode" | Did not reproduce: auto still had 810 ms (GU) and 2868 ms (NR) of long tasks at 4×. A 60–75 % cut, not elimination. |
| The 60 ms tier debounce causes the cancelled renders; raise it to 150–200 ms | Notches 40 ms apart (below the debounce) gave the same 7 cancels. The restarts chain every 260–320 ms. The cause is the clamp (3.2). Also the reported "10.7 s of paint" was a sum of overlapping wall times; the real figures are 5.2 s to quiet and ~3.9 s of main-thread task time. |
| A page flip re-renders five subscribers and re-blits every neighbour | Only `PdfViewerPanel` and `PdfTab` use `usePdfDoc`. 2–3 `drawImage` calls per flip; unchanged neighbours are only repositioned. A shallow compare in `getDocSnapshot` saves nothing on a flip (`currentPage` is in the snapshot), and the adjacent effect already skips unchanged canvases. |
| Cancelled neighbour renders abort the op-list stream and waste ~30 % of scroll render work | The abort happens 0–1 times per 30-notch scroll (300–500 ms of worker re-parse). Most cancelled renders redo in 9–117 ms because the op list survives. `task.cancel(extraDelay)` is a cheap tweak with a marginal gain. |
| The hidden highlight canvas holds 138–240 MB | Nominal arithmetic. Without a context or a draw it allocates nothing in Chromium. Real only while a search has matches (3.4). |
| The pdf.js worker boot costs 150–540 ms of the first open | Dev-server artifact (unminified 2.19 MB worker). Production: 95–144 ms cold, ~40 ms after. Each `getDocument` does create its own worker, so a shared pre-created one would save ~40 ms per open — small. |
| The cache-hit normalisation map delays first paint on a repeat open by ~240 ms | The map costs ~20 ms at 4× (~5 ms at 1×). The ~200 ms task is still ~185 ms with the map removed, and first paint does not move. The rest was not attributed; candidates are deserialising the ~64k-item text record and the notify-driven render. |
| The pinch `scale()` on a wrapper of 8081×20670 CSS px is the Safari lag | No measured cost (16.7–17 ms frames in both engines), and the code's own comment at `applyTransform` records that Safari GPU-upscales the cached layer. A hypothesis for the device check, nothing more. |
| Skip strokes outside the tile inside pdf.js (a culling fork) | Patched into `CanvasGraphics.stroke()` and measured: an empty corner tile stayed at 43–68 ms against 42–70 ms. The cost is the operator walk; Chromium already rejects an off-clip `Path2D` for almost nothing (2.5). |
| Upgrade pdf.js to 6.x for speed | Nothing in 5.6 → 6.4 touches the operator walk; it is a maintenance bump with two patches to re-port (2.5). |
| The watermark filter or the prune patch slows rendering | Filter on vs off and prune on vs off are within ±10 ms noise per fresh page. The filter never fires on these files: the watermark is `www.indiafix.in`, not a default term. |
| pdf.js is slow to open the file | `getDocument` 10–47 ms for 13–19 MB; page 1 parses in 285 ms at 4×. |
| The 20-event pinch to 8× takes 4.9 s | About 1.0 s in four of five runs, GPU and software alike. |
| `will-change: transform` on the wrapper | No measurable difference in real Chrome. |

---

## Plan

### Phase 1 — this release: cheap fixes with a measured gain

| # | What | Where | Verify | Risk |
|---|---|---|---|---|
| 1 | Neighbours: ±1 only once one page fills the viewport; tier ≤ 2 when off screen; start after the main render painted; one in-flight map shared with the idle prefetch; own cache budget | `PdfViewerPanel.tsx:2258-2264`, `~1696-1720`, `:127` | 8-notch zoom on NR2201 p68 at 4×: time to quiet (now 5.2 s) and render-call count (15); canvas inventory at 780 % DPR 2 (now 608 MB of neighbours) | Blank neighbour at a page edge on a fast scroll — `pdf-touch.spec.ts` ▸ "swiping through a long document" samples ink and must stay green |
| 2 | Key the page cache on clamped pixel size; skip a render whose clamped size equals the one shown or in flight | page-cache key, `renderPage` `:1559-1570` | Zoom 8→4→8 at DPR 2: full renders per leg (now 7–8); restarts of the 8192 render (now 5) | Low. A stale bitmap if the key drops something that does change pixels (rotation, clean mode) |
| 3 | Zoom readout written to the DOM; remove the per-event pinch log | `:1231-1240`, `:4034`, `:2797` | Panel render count over 170 pinch frames (now 169, target 0); frame p50 at 4× | Low |
| 4 | Per-page cleanup outside `currentPage ± 3`; document-wide cleanup only under memory pressure and never while a render is in flight | `pdf-store.ts:998-1032`, `PdfViewerPanel.tsx:1325` | Wait 7 s on p68, zoom 8 notches: renders starting without a cached op list (now 5, target 0) | Memory growth on a long read-through if the pressure rule is wrong |
| 5 | Guard `canvas.width` on a size change; no highlight resize without matches; width 1 when hiding it | `:1624`, `:1648`, `:1838-1839`, `:2160` | `canvas.width` set count and MPx per 3 s pinch (now 57 / 473 MPx) | The persistent-canvas rules in CLAUDE.md (no `alpha: false`, mirroring on reuse) — test in Safari |
| 6 | Loading indicator, section 4: panel first, `pdfStore.loads`, banner, skeleton, extraction chip | `file-actions.ts`, `LibraryPanel.tsx`, `session-store.ts`, `pdf-store.ts`, `BackgroundLoadBanner.tsx`, `PdfViewerPanel.tsx` | DOM sampled every 50 ms from pick to first canvas: a loading element in every sample; sequence test in the style of `library-unreachable-state.spec.ts` | Medium: seven open paths; a failed load must not leave an empty panel; the board overlay must not be touched |
| 7 | Chunk the text-cache put with a yield between slices; throttle the extraction notify to ≥ 250 ms; start extraction after the first blit | `pdf-store.ts:815`, `:923`, `:934`, `board-cache.ts:477-486` | Longest task at the end of extraction (now 85 / 357 ms, target < 30 ms) | Cache format change — bump the store version or old entries read wrong |
| 8 | Add `indiafix` to the default watermark terms; fix the `'auto' (default)` comment and `PDF_VIEWER.md` | `render-settings.ts:343`, `:713-719`, `pdfindex/watermark.go` (lock-step) | Watermark gone on NR2201ZE | None |
| 9 | Device check, no code: Safari Web Inspector ▸ Layers on Mac Safari and the iPad | — | Layer count, memory per layer, repaints during pinch, before and after items 1–5 on rd-nas:1234 | — |

### Phase 2 — structural

| # | What | Where | Verify | Risk |
|---|---|---|---|---|
| 1 | Tile path overdraw: pad in CSS px with `floor`, viewport-relative render-all threshold, display tiles as they finish, whole tiers above 4, budget by DPR² | `PdfViewerPanel.tsx:1861-1879`, `:2061-2104`, `tile-manager.ts:67`, `:244` | Tiles per settle at 800 % (now 42 / 56, target 12–25); settle time (now 700–920 ms); tiles re-rendered on a ×1.1 notch | Blank flashes on fast pan if the backdrop tiles go |
| 2 | Then make `auto` the default, with a migration decision for stored settings and new Settings copy | `render-settings.ts:724` | The standard-vs-auto table in 3.3, at 170 % and at 800 % | Reverses a deliberate choice (1b50386); only after item 1 |
| 3 | Cheaper page flip: page-dependent UI in a child component or notify on rAF; look at the long non-flip Layout frames | `PdfViewerPanel.tsx:1095-1137` | Flip task length at 4× in a production build (now 32–94 ms) | Medium |
| 4 | One viewport-sized canvas (5.4) | display half of `PdfViewerPanel` | Canvas MB at 782 % (now 499–785 MB, target < 30 MB); layers (now up to 78); the whole `pdf-touch` and `pdf-rotation` suites | High: a rewrite. Decide after the device check |
| 5 | Paint in a worker with `OffscreenCanvas` (2.1) | `renderPageToBitmap`, `renderPage`, `renderTiledPage` | Max frame gap during an 8192-px render at 4× (now 100–150 ms, prototype 17 ms); pixel diff against the main-thread render | High: no official pdf.js mode yet — upstream PR #21860 does exactly this, is open and off by default, and measures vector-heavy pages 2.4× slower warm (2.5); own bundling, fonts and Safari unverified, second document in memory. Prefer waiting for upstream |
| 6 | Lower `maxCanvasDim` / `maxMainTier` on WebKit regardless of pointer type | `device-profile.ts`, quality presets | Device check | Low; softer pages at high zoom on desktop Safari |

### Phase 3 — nice to have

| What | Where | Gain | Risk |
|---|---|---|---|
| One shared, pre-created `PDFWorker` | `pdf-store.ts:772`, `:975`, `:1061`, `:1147` | ~40 ms per open, ~100–140 ms on the first cold one | `doc.destroy()` and the concurrent stripped/original documents |
| Fewer copies of the file bytes; store the `Blob` in `putPdfBytes` and defer the put | `pdf-store.ts:762-769`, `databank-store.ts:2418-2426` | 20–60 ms at 1×, 100–150 ms at 4×, ~40 MB transient heap | Low |
| Do not read the whole text cache before the first blit; store per page | `pdf-store.ts:830-846` | Up to ~185 ms on a repeat open at 4× — **measure first**, the task was not attributed | Low |
| Compact text-cache form (`Float32Array` + strings) | `board-cache.ts` | Clone 86 → 11 ms | Cache migration |
| Extraction in a second worker | `pdf-store.ts:827-980` | First-open renders stop being 1.8–3× slower during extraction | Memory: a second parsed document |
| `task.cancel(extraDelay)` for neighbour renders | adjacent effect cleanup `:2368` | One saved re-parse per long scroll | Low |
| Highlights as a viewport canvas or divs | `:2160-2168` | 270–480 MB while a search has matches | Low |

---

## How to measure

Throwaway Playwright specs; none were kept. To repeat a number:

**Setup**

- PDFs: `samples/pdf/GU603HE.pdf` (heavy pages: 29, 68) and
  `samples/pdf/NR2201ZE_2.1.pdf` (p68 is the heaviest, 74 k ops). Open through
  the toolbar file input with `setInputFiles`.
- Browser: for anything about frames or compositing use real Chrome
  (`channel: 'chrome'`, or `--enable-gpu --use-angle=metal`). The default
  headless shell rasterises in software and invents a compositing cost.
- Build: `vite build` + `vite preview` for anything involving React time; the
  dev server doubles renders (StrictMode) and adds `jsxDEV` overhead. The
  DEV-only `window.__pdfStore` is not in a production bundle.
- `deviceScaleFactor: 2`; viewport 1400×900 (panel ~1034×766) or 1280×720
  (panel 914×586). Canvas sizes depend on the panel size — record it.
- CPU: `Emulation.setCPUThrottlingRate` at 1 and 4 through a CDP session. It
  throttles the main thread only.
- Run alone. Other Playwright runs on the same machine made timings noisy, and
  a broad `pkill` kills them.

**Hooks (via `addInitScript`)**

- `PerformanceObserver('longtask')`: count, total, max.
- A rAF loop recording frame gaps: p50, p95, max, counts over 32 / 50 / 100 ms.
- Input → next rAF per `wheel` / `pointermove`: p50, p90, max.
- `HTMLCanvasElement.prototype.width` setter: count, pixels, class name, stack.
- `createImageBitmap` wrapper: count, time, pixels.
- `PDFPageProxy.prototype.render` wrapper: canvas size, duration, completed or
  cancelled, whether an operator list was cached.
- `Worker.prototype.postMessage` and the `message` listener: pdf.js actions
  (`GetOperatorList`, `GetTextContent`, `Cleanup`) with timestamps.
- `IDBObjectStore.prototype.put` / `get` timing.
- A stub `__REACT_DEVTOOLS_GLOBAL_HOOK__` to count commits and walk the fiber
  tree for `PdfViewerPanel` renders and `actualDuration`.
- The panel's own `[perf]` console lines and `pdf-render-perf` events.

**Gestures**

- Dispatch `WheelEvent`s in the page at a 16 ms cadence or one per rAF.
  `page.mouse.wheel` round-trips and spaces events 50–250 ms apart, which fires
  the 60 ms debounce mid-gesture — a different gesture.
- Pinch = `ctrlKey` wheel. 20 events of ×1.035 is one doubling. Eight 120 ms
  notches from a real wheel is the "8-notch zoom".
- Pan = bare wheel `deltaY` 30; a 30-notch scroll crosses 7–13 pages.
- Touch = CDP `Input.dispatchTouchEvent`, Chromium only.

**The numbers to track**

| Number | Scenario | Now |
|---|---|---|
| `page.render` calls / cancelled / time to quiet | NR2201 p68, 8 Ctrl+wheel notches, standard, 4× | 15 / 7 / 5.2 s |
| Full renders per zoom leg | GU603HE, 8→4→8, DPR 2, standard | 7–8 |
| Long-task total, pinch to ~170 % | GU / NR, standard, 4×, DPR 2 | 2985 / 7468 ms |
| Panel renders per 170 pinch frames | GU603HE | 169 |
| Off-screen neighbour canvases | inner page, ~780 %, DPR 2 | 4, 608 MB |
| Renders without a cached op list after 7 s idle | GU603HE p68 | 5 |
| Flip task | 12 flips, 4×, production build | 32–94 ms |
| Longest task at end of extraction | GU603HE first open | 85 ms / 357 ms at 4× |
| Samples with no loading element, pick → first canvas | both files | all of them |
| Tiles per settle at 800 % (auto) | GU603HE p29, DPR 1 / 2 | 42 / 56 |
| Pan and pinch frame p95, real GPU, production | 291 % and 782 % | 16.67 ms |

**Not reachable from here**

Real Safari and iPadOS (canvas ceiling, purging, GPU-process time, 120 Hz), the
NAS download phase, worker-side time on a slow CPU, and whether off-screen
canvases are physically allocated in WebKit. These need rd-nas:1234 and the
iPad.
