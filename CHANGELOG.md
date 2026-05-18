# BoardRipper changelog

## v0.30.8 — 2026-05-18

Right-click context menu redesign and two parser fixes.

### Context menu

- **Density pass.** Font 12px, padding 4px 10px (was 0.9em / 6px 14px); the action strip is gone, replaced by inline chips inside the existing header row. Menu caps at 360px wide; long PDF / board donor names ellipsis-truncate with the full path available on hover (`title` attribute). The whole menu reads ~30% shorter at the same content. (`ac6fcc8`)
- **Header chips.** Each value (part / pin / net under the cursor) renders as a chip with a copy-on-click affordance; search-on-web and worklist-pin sit as 22px icon buttons on the chips that own them. No more "pin F11" prefix — the value alone speaks in chip context. The previous three-row Copy / Search / Worklist strip is gone; everything an action could target now lives next to its name. (`ac6fcc8`)
- **Pin chip leads + lit state for worklist membership.** The worklist pin sits FIRST inside the part chip, before the value name. When the right-clicked component is already in the active worklist the pin renders filled + accent-coloured (`IconPinFilled` on `.is-lit`), tooltip switches to "click to remove", and the click removes the entry — mirrors shift-click on the canvas. (`ac6fcc8`)
- **Donor row: chevron on the left, variant connector hairline.** The variant-expansion glyph moved from a 2em right-side icon (often misread as "submenu →") to a 1.4em left-side chevron in a fixed 18px slot, matching the file-tree disclosure pattern. Expanded variants now render inside a wrapper with a 1px left border that visually ties them to their donor row. (`ac6fcc8`)
- **Auto-expand donor groups when total donor rows < 5.** Small lists default to open — no extra clicks needed for the typical "one bound PDF + one sibling board" case. The chevron still toggles, and explicit user collapses persist for the lifetime of that menu open. (`ac6fcc8`)
- **`IconMinus` retired for the "no mark" worklist row.** Reads as "subtract"; replaced by a dim `·` (opacity 0.4). The mark-cycle popover already names the new state on click, so the row's idle look stays calm. (`ac6fcc8`)

### Parsers

- **BRD parser early-rejects the proprietary `BRD_V1.0` container.** New 16-byte ASCII header check at the top of `parseBRD` throws with a descriptive message: "proprietary, encoded boardview format. Decoding is under active investigation — support may be added in a future release." Without this gate, OpenBoardView-style decoding ran against the encoded body and emitted garbage geometry that took users a while to diagnose. (`8fe1b94`)
- **FZ alt-end fallback for non-canonical `descrSize`.** The Vietnamese GOCCANH-XJ converter writes `descrSize` 4 bytes longer than the canonical layout, which chops 4 bytes off the deflate stream and makes pako abort with "unexpected end of file". When the canonical slice fails, the parser now retries once with `contentEnd + 4` before reporting failure — symmetrical to the trailing-pointer trim already in place on the forward path. Fixes silent failures on a small but real set of community boards. (`8fe1b94`)

## v0.30.7 — 2026-05-18

PDF watermark wand toggle — fixes a long-standing bug where the user's custom watermark term list was destroyed on every wand-off→reload→wand-on cycle.

### PDF

- **Wand toggle preserves the list across reloads.** Pre-fix: clicking the wand button OFF wrote `pdfWatermarkFilter: []` to localStorage and stashed the previously-active list in a non-persistent `useRef`. On reload the ref reinitialised from `globalSettings.pdfWatermarkFilter` which was now `[]`, then fell through to a hard-coded 5-term fallback. Users who had edited their list (added a vendor watermark via right-click) lost those edits on every off/on cycle; users who toggled off and never toggled back on saw their full list as empty in Settings indefinitely with no auto-recovery path. Fix: split the on/off state into a new persistent `pdfWatermarkFilterEnabled: boolean` field — `pdfWatermarkFilter` now ALWAYS represents the user's list, the wand button only flips the flag. (`e664291`)
- **Centralised through `getActiveWatermarkFilter(settings)`.** Returns the list when enabled, `[]` when disabled. Routes all four consumers through it: the two `page.render()` call sites in `renderPageToBitmap` and `renderTiledPage`, the operator-list dispatch in `pdfStore.openDoc`, and the click-test in `mapClick`. Eliminates the "is the filter active?" question being answered by `filter.length > 0` four different times. (`e664291`)
- **Migration recovers users currently stuck with empty lists.** Existing localStorage entries with `pdfWatermarkFilter: []` and no `pdfWatermarkFilterEnabled` key get auto-bumped to `pdfWatermarkFilter: <5 current defaults>` + `pdfWatermarkFilterEnabled: false`. Toggling the wand back on then brings the 5 defaults back. Users with a non-empty list and no flag set get `enabled = true` (matches the pre-fix semantics where non-empty = active). New users get the 5 defaults + enabled = true via `DEFAULTS`. (`e664291`)
- **Context menu's "Add to watermark filter" now auto-enables the filter.** Adding a term implies the user wants it filtered now, so the right-click action sets `pdfWatermarkFilterEnabled: true` alongside appending the term. Previously, adding a term while the wand was off silently extended the list with no visible effect. (`e664291`)

## v0.30.6 — 2026-05-18

FZ format — removed the bundled ASUS RC6 decryption key. Users now obtain it themselves through a small in-app dialog (fetch from public GitHub mirror or paste).

### FZ

- **`DEFAULT_FZ_KEY` deleted from `fz-parser.ts`.** The 44 × uint32 key required to decrypt encrypted ASUS .fz boardview files is third-party material BoardRipper did not author and has no license to redistribute. Upstream OpenBoardView takes the same position — `FZFile::getBuiltinKey()` returns an empty array — and we now match. The parser still ships the parity-check fingerprint (also from OBV) so any user-supplied key is validated before use. Distributing the key alongside the binary raised exposure under anti-circumvention statutes (DMCA §1201 in the US, InfoSoc Directive Art. 6 / CDSM in the EU) even though the parsing logic itself is MIT-derived; cleaner posture is to have the user fetch it themselves. (`b09c777`)
- **Typed `FZKeyError` with `'missing' | 'invalid'` reason.** Encrypted file + no configured key → `'missing'`; configured key produces non-zlib output after RC6 → `'invalid'`. The board-store catches both and opens the FZ-key dialog; the `'invalid'` path additionally clears the bad stored key so the next fetch/paste replaces it without manual cleanup. (`b09c777`)
- **In-app FZ-key dialog (`components/FZKeyDialog.tsx`).** Opens automatically the first time a user drops an encrypted .fz file. Two paths: **Fetch** pulls from the public mirrors at `github.com/cryptonek/illegal-numbers` (primary) and `github.com/yliu-d/illegal-numbers` (fallback) in order until one yields a parity-valid key; **Paste** accepts any text containing 44 hex tokens. Both run through `validateFZKey()` before persisting to `localStorage` (`boardripper-fz-key`). A `cyrozap/pcbrepair-rs` GitHub mirror is intentionally excluded from the fallback list — its `FZ_EXPANDED_KEY[43] = 0x0945692e` is corrupted (the trailing `e` was appended to fix Rust syntax around the truncated `0x0945692` in upstream cryptonek; the canonical zero-padded value is `0x00945692`, the only one that passes parity). A collapsible "Why isn't the key bundled?" section in the dialog explains the legal reasoning in plain language. (`b09c777`)
- **`store/fz-key-store.ts`.** New singleton store extending `Emitter` for `useSyncExternalStore` integration. Exposes `getFzKey()`, `setKeyFromText()`, `clearKey()`, `fetchAndApply()`, plus a promise-based `ensureFzKey()` gate the board-store awaits before retrying an encrypted-FZ parse. `parseFzKeyText()` is regex-based (`0x[0-9a-fA-F]{1,8}|[0-9a-fA-F]{8}`), so the same parser handles cryptonek's markdown table, raw hex pastes, and Rust array literals indifferently. (`b09c777`)
- **No new CSS systems.** The dialog reuses the existing `.library-modal-*` chrome (backdrop, modal box, field rows, action row, primary-save button). Net CSS addition: `~15 lines` for a wider modal variant, a textarea that matches `.library-modal-field input`, and two inline-message colours. (`b09c777`)
- **Docs.** `docs/formats/FZ_FORMAT.md` and `THIRD_PARTY.md` updated. `THIRD_PARTY.md` now carries a dedicated *FZ decryption key — not bundled* entry that documents the posture and points users at the in-app dialog. The OpenBoardView attribution clarifies that the key is **not** part of what we inherit from upstream. (`b09c777`)

**Migration note for existing users.** After updating, the first time you open an encrypted .fz file you'll see the new dialog. One click on **Fetch** restores the previous behaviour. Unencrypted .fz files (the rare case where the raw zlib stream is already at offset 4) continue to open without prompting.

## v0.30.5 — 2026-05-17

PDF tile render path — single perf change with measurable settle-time win on fresh-tile renders.

### PDF

- **Pipeline tile `createImageBitmap` with the next tile's `page.render()`.** The tile loop in `renderTiledPage` used to await BOTH `page.render()` and `createImageBitmap` strictly in sequence per tile, leaving the pdf.js worker idle for the duration of each bitmap pump. The new structure holds each iteration's bitmap promise as `pending` and collects it at the top of the next iteration — meaning tile N+1's `page.render()` is in flight in the worker while tile N's pixels are being pumped into an `ImageBitmap` on the main thread. `page.render()` itself stays strictly serial per pdf.js's constraint (parallel calls on the same page produce flipped/mirrored tiles); only the JS-side bitmap creation overlaps. Cancellation drains the in-flight bitmap before returning so the LRU cache still gets valid pixels rendered before the cancel. Expected ~30–50% reduction on all-fresh-tile settle paths (zoom change, page change); no impact on cache-hit pan paths. Directly addresses the observation that Standard mode's crisp settle felt faster than Tiles mode's — the 2N awaits in sequence were the structural cause. (`40edb70`)

## v0.30.4 — 2026-05-16

PDF viewer feel — two complementary changes aimed at making zoom and multi-page navigation smoother on heavy schematics.

### PDF

- **Render-mode switch (Auto / Standard / Always-tile).** New control under Settings ▸ PDF ▸ Render mode. *Auto* (default) keeps the existing behaviour — tile above 1.05× zoom for crisp deep-zoom text, full-page below. *Standard* always renders the full page into one canvas (Firefox-style) — smoother during pinch/zoom and one fewer compositor layer; pixels go soft past the browser's canvas-max dimension (~5–6× on A4). *Always tile* is a debugging escape hatch. The router lives behind a `shouldUseTilesRef` predicate that reads both mode + zoom, replacing the four scattered `zoom > 1.05` literals; mode flips re-route the next render without a React-deps refresh. (`b84510a`)
- **Gesture-suspend during wheel-zoom bursts.** Adaptive-throttle renders inside `scheduleTierRender` are now paused while a trackpad pinch / Ctrl+wheel zoom is active (150 ms self-expiring `gestureActiveRef` set in `markGestureActive`). The 60 ms trailing debounce still fires once the burst ends, so the user sees CSS-transform-only motion during interaction and one crisp render at settle — same model Firefox's PDFViewer uses. Touch pinch and Safari `gesture*` paths already had this implicitly (neither calls `scheduleTierRender` mid-gesture); this brings the wheel-pinch path in line. (`b84510a`)
- **Min zoom floor dropped 1.0 → 0.5 to unstick multi-page navigation.** v0.27's fit-to-width zoom lock (`a876c74`) was masking a boundary-bounce glitch, but the side effect was that at zoom ≥ 1 each page is taller than the viewport and the wheel-pan flip threshold at `containerH/2` takes many wheel events to reach — felt like being "stuck" on one page mid-document. Restored the zoom-out-to-see-adjacent-pages workflow across all four zoom paths (wheel, Safari `gesturechange`, touch pinch, keyboard). 50% is far enough to see neighbours without re-surfacing the original glitch. (`e5ef926`)

## v0.30.3 — 2026-05-16

The headline feature is a complete rewrite of the **PDF watermark filter**: it now runs *inside* pdf.js (via a `patch-package`-managed patch) and drops watermark glyphs **at parse time** instead of at render dispatch. Plus a stack of Worklist polish (waterdamage flag, ticket note, custom soldering-iron icon) and a couple of tooltip / hover-info improvements from earlier in the session.

### Worklist

- **Per-row waterdamage flag.** Each entry has a binary "water damage observed" toggle alongside the existing mark cycle. Dim/transparent droplet icon when off, cyan-blue when on. Independent of the mark state — a part can be both water-damaged AND replaced. Roundtrips through the clipboard via a `[water]` token on the row (`R12[replaced][water] (note)`). (`762cfe5`)
- **Per-worklist ticket note.** A `Ticket note ▸` spoiler at the top of the active worklist holds a free-form note (~4 KB cap). Preview of the first line shows when collapsed. Roundtrips through the clipboard via `> `-prefixed lines immediately after the `-[name]-` header. (`762cfe5`)
- **Mark-cycle flash chip rendered through a React portal.** Previously the per-row "Replaced / Reworked / Cleaned" popover anchored to its button via `position: fixed` could land in the wrong place when an ancestor Dockview/sidebar wrapper created a containing block. Now portaled to `document.body` so `position: fixed` coords always reach viewport space. (`762cfe5`)
- **Custom soldering-iron icon for the "Reworked" mark.** New `IconSolderingIron` component in `src/icons/`: iron body from `mdi:soldering-iron` (Apache 2.0) with the cord subpath dropped and horizontally mirrored; smoke wisp hand-traced inspired by `game-icons:soldering-iron` (CC BY 3.0). Replaces the bandage emoji-substitute. Attributions in `THIRD_PARTY.md`. (`762cfe5`)
- **"Select" button renamed to "Highlight"** — matches what it does (load worklist parts into the cyan canvas overlay, not a real selection mutation). (`4bdc9ad`)

### PDF watermark filter — complete rewrite

The v0.4.2 – v0.30.2 implementation passed a `Set<number>` of pre-computed operator indices into pdf.js's public `operationsFilter` render callback. That had two latent bugs that manifested on more PDFs as the filter list grew: pdf.js's `getOperatorList` uses `NullOptimizer` (raw operator stream) while `render` uses `QueueOptimizer` (merges/reorders ops), so pre-computed indices didn't line up; and any PDF that emits one `showText` per glyph for sub-pixel positioning (Gigabyte schematics, for example) never matched substring filters per-op anyway.

The new design lives **inside the pdf.js worker**, via a `patch-package`-managed diff at `src/frontend/patches/pdfjs-dist+5.5.207.patch`. The patch:

- Adds a `watermarkFilter: string[]` option to `PDFPageProxy.render(...)`, forwarded through `_pumpOperatorList` → `GetOperatorList` worker message → `Page.getOperatorList` → `PartialEvaluator.getOperatorList`.
- In the evaluator's main switch, between `BT` and `ET`, tracks every `showText` op's `args` reference and the accumulated glyph-unicode string. Ops flow through `operatorList.addOp` in source order — no buffering, no reordering — so async-emitted state ops (`setFont`) land where pdf.js expects them.
- At `ET`, NFKC-normalises the accumulated string + each filter term, lowercases, strips whitespace, substring-matches. If any term matches, retroactively sets each tracked showText's `args[0] = []` so the op still executes but draws nothing.

Trade-offs and why this shape: we tried a per-op filter (broke on per-glyph PDFs), a whole-BT-buffer-then-emit approach (broke rendering whenever a real text block went through the buffer, because state ops emitted async to the operator list landed before the buffered BT did), and finally landed on in-place glyph-array zapping after the fact — the only approach that preserves pdf.js's strict op-stream ordering while still letting us decide at BT-block granularity.

Notable shipped fixes inside this rewrite:

- **NFKC normalisation** so Latin ligatures like `ﬁ` (U+FB01) decompose to `f` + `i`. Without it, `"Vinaﬁx.com"` never matches the user's `Vinafix` filter term. Click-test path (`isPdfWatermarkText` in `render-settings.ts`) uses the same rule, kept in lock-step by design.
- **`cMapUrl` + `standardFontDataUrl`** wired into every `pdfjsLib.getDocument` call. Some donor PDFs (Gigabyte schematics) ship fonts that reference CJK/vendor CMaps; without these URLs, pdf.js's font loader fails with `Ensure that the cMapUrl and cMapPacked API parameters are provided` and the glyphs arrive at the operator stream with no `.unicode` — the filter then has nothing to match against. Dev server points at unminified `pdf.worker.mjs` so the patch targets readable source; vite still minifies for production.
- **`flushOperatorListCache(fileName)` on filter toggle** — pdf.js's `intentStates` cacheKey doesn't include the filter, so a toggle alone leaves the cached operator list in place. We now call `page.doc.cleanup(true)` to force a re-parse with the new filter.
- **`self.` instead of `this.` in the showText branch.** The switch sits inside `new Promise(function promiseBody(resolve, reject) { … })`, a regular function — `this` is `undefined` in strict-mode module scope. The earlier `this.watermarkFilter` read threw a `TypeError` that pdf.js's `ignoreErrors` catch silently swallowed, dropping the whole operator list, which manifested as "no text renders at all". Caught via Playwright probe.
- **Right-click → "Hide as watermark"** context-menu item on PDF text. Adds the clicked text to `pdfWatermarkFilter`; the existing filter-change subscription flushes caches and triggers a re-parse with the new term.
- **Default filter expanded** to `Vinafix`, `www.chinafix.com`, `www.xinxunwei.com`, `notebookschematics.com`, `notebook-schematics.com`. Migration recognises any prior default list and upgrades automatically; explicit customisations are preserved.

The patch survives `npm install` / Docker builds via a `postinstall` script wired into `src/frontend/package.json`. Updating procedure for pdf.js version bumps is documented in `src/frontend/patches/README.md`.

### Hover tooltip

- **Value and Package surfaced in the hover tooltip.** On boards whose parsers fill `PartMeta` (primarily TVW; partial coverage from BVR/BDV/Allegro), a new line appears between `R123 · pin 2` and any OBD readings, joining `value` and `package` with ` · ` (e.g. `10uF · CHIP0603R`). Hidden entirely when both are empty so non-TVW tooltips stay compact. Matches what `ComponentInfoPanel` and `BoardSidebar` already show. (`07f018f`)
- **Trace-hover label cleaned up.** Was `Top · pin trace` (awkward). Now `trace · Top` (or just `trace` when no layer name). Net stays on line 1. (`07f018f`)

### Clipboard

- **Worklist Copy + context-menu Copy work over LAN / NAS / Tailscale, not just `localhost`.** `navigator.clipboard.writeText` is only defined on secure contexts (HTTPS or `http://localhost`); the dashboard accessed at `http://192.168.x.x:1336`, Vite's network URL, or a Tailscale `100.x.x.x` address left it undefined and the copy threw `Cannot read properties of undefined (reading 'writeText')`. A new `copyText()` helper in `src/clipboard.ts` falls back to a transient off-screen `<textarea>` + `document.execCommand('copy')`. (`4bdc9ad`)

### Renderer

- **`BoardRenderer.teardownForReinit` removes `multiHighlightGfx` alongside the other highlight layers** — was missing from one of the two teardown paths, leaking the graphics object on tab switch. (`762cfe5`)

## v0.30.2 — 2026-05-15

### Fixed

- **Worklist Copy + context-menu Copy worked over `localhost` but failed over LAN / NAS / Tailscale.** `navigator.clipboard.writeText` is only defined on secure contexts (HTTPS, or `http://localhost`). Opening BoardRipper at `http://192.168.x.x:1336`, the Vite dev server's network URL, or a Tailscale `100.x.x.x` address left `navigator.clipboard` undefined; both call sites threw `Cannot read properties of undefined (reading 'writeText')`. A new `copyText()` helper (`src/frontend/src/clipboard.ts`) tries the modern API first and falls back to a transient off-screen `<textarea>` + `document.execCommand('copy')` — works everywhere the dashboard is reachable.

### Polish

- **Worklist tab button "Select" renamed to "Highlight".** Better matches what the action actually does: it loads the worklist's parts into the cyan canvas highlight overlay, no real "selection" mutation. The Cyan-selection band's helper text was updated to match.

## v0.30.1 — 2026-05-15

### Polish

- **Hover tooltip surfaces Value and Package.** On boards whose parsers fill `PartMeta` (primarily TVW Teboview; partial coverage from BVR / BDV / Allegro), the in-canvas tooltip now shows a new line between `R123 · pin 2` and the OBD readings, joining whatever fields are present with ` · ` — e.g. `10uF · CHIP0603R`, `100K`, or `QFN32` on its own. The line is hidden entirely when both fields are empty, so boards without metadata keep the compact two-line tooltip. ComponentInfoPanel + BoardSidebar already showed these fields; the tooltip now matches without requiring a click. (`07f018f`)

- **Trace hover label is no longer "Top · pin trace".** The detail line on trace-only hits now reads `trace · Top` (or just `trace` when the source format has no layer name), keeping the trace's net name on line 1 as before. The old phrasing was a leftover from constructing the detail string from a part/pin pair; pin became optional in `showTooltip` so trace hits can drop the suffix. (`07f018f`)

## v0.30.0 — 2026-05-14

Headline addition: the **Worklist** — a per-board, persistent multi-select with named lists, marks, notes, and roundtrip clipboard sync. Plus a stack of PDF / scanner / updater fixes from the day after the v0.20.x cleanup.

The version jump from v0.20.9 to v0.30.0 marks the first release of the new stable pipeline (signed manifest + GHCR + ripperdoc.de archive + chat-runnable `release.sh`) as a milestone, distinct from the 0.20.x stabilisation series.

### New

- **Worklist** — per-board, multi-select-driven scratch list with named groups. Shift+click on the board adds/removes parts from an ephemeral multi-select set (cyan outline). Right-click ▸ "Add to worklist" or the toolbar Worklist button pushes the selection into a per-board named worklist (amber outline). Lists persist in IndexedDB (`boardripper-worklist`) keyed off the same fileName/size/mtime triple as the board cache — they survive reloads and container upgrades. Each row carries a cycling mark state (none → replaced → reworked → cleaned → bandage) plus an optional free-form note under a spoiler caret. Per-mark coloured outline + glyph on the board so you can see at-a-glance which parts are in which state. The whole list copies as `REFDES[mark] (note)` for paste-into-issue tracking. The panel lives as a tab inside the BoardSidebar (no separate Dockview window). (`2461b8c`, `59bf9ff`, `df50276`, `5cc5a02`, `872b750`, `b64f143`, `f106dac`)

- **Worklist roundtrip export + clipboard import.** Export writes the list name as the first line wrapped in a `-[<name>-<bnum>]-` marker, then `REFDES[mark] (note)` lines. Paste it back into another BoardRipper instance and the Worklist panel reads the marker, recreates the list, re-resolves refdeses against the open board, and restores marks + notes. `importFromText` is hardened against arbitrary clipboard payloads (random text doesn't accidentally create a list; only the marker-form is accepted). Survives renames + minor format drift in pasted content. (`c962d30`, `8dc817d`)

- **Butterfly mode allows board rotation.** Previously the rotation toolbar buttons were disabled in butterfly mode (the auto-separation axis logic didn't track manual rotation). The renderer's `applyFlips()` butterfly branch was actually already rotation-aware — it picks the separation axis from the rotated bounds and uses `axesSwapped` to flip the right board axis under 90°/270°. The toolbar gate was the only thing in the way. Preference persists per-install. (`6e2b835`)

### Fixed

- **PDF text extraction on Safari < 17.4.** `pdf.js` v5's `getTextContent()` iterates the underlying ReadableStream with `for await`, which needs `ReadableStream[@@asyncIterator]` — absent on Safari before 17.4. Users on Safari 16.4–17.3 could render PDFs fine (the `sendWithPromise` path is unaffected) but PDF text scan / search returned nothing. The text-extractor now drives `streamTextContent().getReader()` directly. Safari stacks omit `err.message`, so log lines explicitly include `err.name + err.message` for diagnosability on the field. (`609f8cc`)

- **PDF: macOS rubber-band overscroll killed, zoom/resize tightened.** Trackpad momentum-phase wheel events at the top of page 1 were leaking past `preventDefault` and triggering the browser-native rubber-band bounce, briefly showing the page behind the canvas. `overscroll-behavior: none` on html/body/#root and `contain` on `.pdf-canvas-container` close that. Additional polish: zoom-around-cursor honours `transformOrigin` consistently across resize transitions; ResizeObserver no longer fires spurious resizes during DPI changes. (`a876c74`)

- **Scanner: garbage-name PDF auto-binding cured + historical bindings pruned.** The auto-match phase scored 50 for any pair where one filename's lowercased base contained the other's — with no minimum-length guard. A PDF named `1.pdf` matched every board whose name contained a "1" (i.e., most of them); a single page-fragment with a short generic name silently latched onto dozens of unrelated boards. Now a minimum substring length (≥4 chars) and a stop-list (`pdf`, `boardview`, page-marker patterns) gate the score. `migrateV9` runs once on hydration to delete pre-existing garbage bindings produced by the old heuristic — the scan re-runs cleanly on next bind. (`e81bdcd`, `7c1ffce`)

### Self-update overlay

- **The update-in-progress overlay now shows the captured progress log + a live elapsed-time counter.** The first measured clean v0.20.8 → v0.20.9 update on local Docker swapped in 9 s end-to-end (vs. the previous "30–60 seconds" copy the overlay used to display). During those 9 s the SSE stream emitted 14 informative entries — "Tagged previous image", "Pulling …@digest", "Locating self container", "Orchestrator launched — this container will exit and the new image will start momentarily" — which were sitting in `updateStore.progress[]` but were never rendered to the user. The overlay now subscribes to that array via a primitive `progressLen` `useSyncExternalStore` snapshot (keeps the stability invariant intact) and renders the last 14 entries in a scrollable monospace list, reusing the toolbar dropdown's existing `.update-progress-line` styling. New `<Elapsed: Ns>` counter ticks every second from overlay mount — the inner-component split means each restart transition mounts a fresh instance, so the counter naturally resets to 0 without a `setState`-in-effect. (`8b87a16`, `7f753d9` for the inner-component refactor cleaning up the react-hooks lint warning)

## v0.20.9 — 2026-05-13

### Fixed

- **TVW board outlines: `0x0B` drill-code is an ARC record, not another slot variant.** ThinkPad P14s Gen 2 NM-D352 ships 59 of these `0x0B` records alongside 90 real `0x0A` slots in its OUTLINE Roul layer. The parser was folding `0x0A` and `0x0B` into the same `DrillSlot` branch (inherited from eagleview) and reading both as straight line segments — the misread center+radius bytes happened to plot as 4,000–12,000 mil diagonals back near the origin, and `gfx.fill()` then cross-hatched the board with PixiJS's even-odd rule across the 98 disjoint sub-paths. `0x0B` has the same 29-byte footprint as `0x0A` but a different field layout (`net:s32, tool:u32, center:Vec2S, radius:Fixed32, start:f32 deg, sweep:f32 deg`); the parser now tessellates it to a 16-segment polyline so `chainLines` sees connected geometry, matching the Logic-layer arc-tessellation constants. (`0cc71c8`)

- **Clean `docker compose up -d` no longer restart-loops on Linux hosts.** `Dockerfile:52` ships `USER 65532:65532` for safety, but a fresh `docker compose up` on Linux has the Docker daemon create `./data` as root, which UID 65532 can't write — `databank.Open` then `log.Fatal`s at boot and the container exits. The bundled `docker-compose.yml` now overrides `user: "0:0"` (mirrors `deploy-remote.sh`) so the documented one-command install works. Users who'd rather keep 65532 can remove that line and either `chown -R 65532:65532 ./data` or switch to a named volume — Docker initializes named volumes from `/data` inside the image (pre-chowned to 65532 in the Dockerfile), so USER 65532 stays meaningful. (`f456c12`)

### Release pipeline

- **`SOURCES_CSV` no longer lists GHCR as a manifest source.** GHCR is a Docker Distribution v2 registry; `https://ghcr.io/.../manifest.json` returns HTTP 405 (it only speaks `/v2/`). Every install ever shipped wasted one HTTP request on a guaranteed-fail there before falling through to ripperdoc.de. Both the compiled-in `SOURCES_CSV` and the manifest's `source_list_next` field are now single-entry. GHCR is still used during `Apply` for pull-by-digest — different protocol on the same hostname. (`c4666b0`)

- **`scripts/release.sh` is now fully non-interactive.** Set `MINISIGN_PASSWORD` in `~/.config/boardripper/release.env` and the script pipes it to `minisign -S` over stdin (minisign accepts stdin when not on a tty). Falls back to the interactive prompt if the env var is unset, so hands-on runs still work. Combined with the `Build desktop Electron apps too? [y/N]` prompt's existing tty-check (which falls through to "off" in non-tty contexts), a release now runs end-to-end with zero operator input — chat-driven, cron-driven, CI-driven all behave the same. `--desktop` flag forces Electron builds when needed. (`fb0f91a`)

- **Version archive page at <https://www.ripperdoc.de/boardripper/archive.html>** is now regenerated on every release. Lists every CHANGELOG entry with per-version Docker-tarball / drop-bundle / GHCR-pull / source-tag links. The GitHub Releases page is intentionally scoped to the current release (older entries cleaned out 2026-05-13); the archive is the canonical "give me an older version" landing. Retention policy and tier-migration procedure documented in `docs/RELEASE_ARCHIVE.md`. (`fb0f91a`)

### Docs

- **README**: docker-compose snippet now includes the `user: "0:0"` override matching the in-repo `docker-compose.yml` (was missing, copy-paste users hit the restart loop). Self-update section corrected — the signed manifest is fetched from ripperdoc.de, then the image is pulled by content-addressed digest from GHCR; the previous "GHCR primary, ripperdoc.de fallback" phrasing was backwards (GHCR can't serve manifests). A new "Older versions" subsection points at the archive page. (`eca9d11`)

### CI

- **`--max-warnings 100` dropped from the eslint step.** The previous cap meant nearly every push hit the cap and failed CI (30 of the last 50 runs failed on the same `react-hooks/preserve-manual-memoization` and `react-refresh/only-export-components` warnings the React Compiler emits in batches); `tsc -b --noEmit` + backend tests + docker-build never ran because they `needs: lint-and-typecheck`. The cap was raised once before in `55a3a12` for the same reason — drift faster than the rules. Warnings still print to the run log; `tsc --noEmit` stays as the hard gate. (`ae68bc7`)

## v0.20.8 — 2026-05-13

### Important: silent-update-failure root cause

- **Auto-update silently rolled back on every install whose `/data` is mixed-ownership.** Since `430a219` (2026-05-12) the image ships `USER 65532:65532`. Production installs that override that at runtime (`docker run --user 0:0`, e.g. the maintainer's `deploy-remote.sh:143` does this because the Synology bind-mounted data dir is mixed root/65532) ran the OLD container as root. The orchestrator's `createBody`, however, did not propagate `Config.User` into the NEW container — it always started at the image default `65532`. The new binary then `log.Fatal`'d on `databank.Open` and update-secret read/create because the OLD container had written `/data/databank.db` and `/data/.update-secret` as root and 65532 can't write them; the process exited before listening on `:8080`; the orchestrator's 60s `/api/health` poll on the new container's IP timed out; rollback restored the old container; and the user saw nothing — the update "succeeded" silently and reverted. `findSelfContainer` now reads `Config.User` and `orchestrateRestart` includes `"User": self.User` in the create body. Image-default-USER installs (`self.User == ""`) fall through unchanged. (`b9b5e10`)

  **Chicken-and-egg caveat:** the fix lives in v0.20.8's binary, but the orchestrator that creates v0.20.8's container runs v0.20.7's (or earlier) code — which still has the bug. So the v0.20.7 → v0.20.8 update on an affected install **will still roll back**. Recovery: one manual `NASdeploy.sh` / `docker pull ghcr.io/alexeyinwerp/boardripper:v0.20.8 && docker rm -f boardripper && docker run -d ... boardripper:v0.20.8` to land v0.20.8 in place. From v0.20.8 onward, every future auto-update works as designed.

  The update-test harness (`tools/update-test/run.sh`) now passes `--user 0:0` on the OLD container, mirroring production. This reproduces the bug end-to-end (without the fix the harness fails the same way production fails); with the fix the harness passes in ~10 s. The new `scripts/release.sh` runs the harness as a mandatory gate before signing — same class of regression cannot land silently again.

### Fixed

- **Clicking a pin on a selected part no longer crashes the renderer with `Cannot set properties of undefined (setting 'fontSize')`.** The selected part's pin labels get raised into `netLabelLayer` mid-pass so they render above the netDim overlay. When `pinNetLabelBg` is on, those entries are `Container` wrappers (background Graphics + BitmapText child) rather than bare BitmapTexts. A later `acquireNetLabel` call in the same `renderSelection` walked `netLabelPoolIdx` into the wrapper's slot, cast it as BitmapText, and crashed on `label.style.fontSize` because `Container` has no `.style`. `acquireNetLabel` now skips past any non-BitmapText children at the current pool index before reusing or creating. Reported from a deployed v0.20.7 install. (`248f8eb`)

### Release pipeline

- **Single command owns the end-to-end release.** Today's v0.20.7 mishap (electron-only desktop release tagged ahead of `release.sh`'s run, then `release.sh` committed counter 17, failed at `git tag`, and exited 128 with no rollback help) exposed that nothing enforced CHANGELOG-entry presence, tag-collision detection, type-check / build preflight, update-test before signing, push, or GitHub Release creation. `scripts/release.sh` now owns all of it. Interactive `Build desktop Electron apps too? [y/N]` prompt; `--desktop` / `--no-desktop` / `--desktop-only` bypass the prompt. After GHCR push the script runs `tools/update-test/run.sh` as a mandatory sanity gate before signing. After commit + tag it pushes `main` + tag and creates a GitHub Release with the sliced CHANGELOG section + (if built) Electron zips as assets. Pre-release tags (`.beta` / `.rc` / `.alpha`) get `--prerelease` instead of `--latest`. New `--desktop-only` mode bumps `package.json` + builds + ships Electron apps + creates a GH release **without** touching `.release-counter`, Docker, manifest signing, or FTP — the recovery path for "in-app updater is fine, but desktop users need a hotfix." See `docs/RELEASE_RUNBOOK.md` for the full flag cheatsheet. (`4508c2d`)

## v0.20.7 — 2026-05-13

### Fixed

- **Board outline now reads as a clean filled rectangle on TVW files whose CAD source ships only straight edges (no corner arcs).** Some Teboview Roul Through layers encode the board edge as drill-slot line segments. `chainLines` would return dozens of 2-point sub-paths instead of one perimeter loop; `gfx.fill()` on that pile flowed PixiJS's even-odd rule across all the disconnected sub-paths and produced cross-hatched "wrong polygon fillings" (reported on ThinkPad P14s Gen 2 NM-D352). `drawOutline` now pre-passes to find the largest sub-path; when the largest is under 20 points (no real perimeter), it fills the outline-points bbox once and strokes the fragmented segments on top. Well-formed outlines (HY568, NM-D355 with its 415-pt perimeter) hit the existing path-fill branch unchanged. (`1a40813`)

- **Self-update check no longer logs a red `Check failed: HTTP 502` every 6 hours when you're already on the latest release.** After a successful self-update the install's counter file is bumped to the applied manifest's counter. The next background check fetched the same manifest, `ValidateManifest` rejected it at the `m.Counter <= installedCounter` branch (replay defence), `Check()` returned an error, the handler answered 502, and the frontend dutifully logged red. `Check()` now distinguishes the "manifest is exactly what we already applied" case (`m.Counter == installedCtr && m.Version == Version`) from a real validation failure and reports it as no-update with HTTP 200. Replay / downgrade / counter-regression cases still bubble through to the user. (`e184b94`)

- **Welcome-screen footer link points at the public GitHub repo** (was pointing at the old `inwerp/Boardviewer` placeholder URL that 404s after the public flip). (`350f636`)

### Docs

- **Welcome-screen copy refresh** — dropped stale wording from before the public release. (`cfb5f19`)

### Release pipeline

- **`NASdeploy.sh` bakes `PUBKEY` into the deployed image.** The Dockerfile defaults `ARG PUBKEY=""`; `release.sh` always read `~/.config/boardripper/release.pub` and passed it via `--build-arg PUBKEY`, but `NASdeploy.sh` only passed `APP_VERSION`. Every NAS deploy since the secure-update pipeline landed in v0.19.0 had therefore shipped with an empty PubKey baked into the binary, and every update check short-circuited at `updater not configured: PubKey is empty`. Users on a NAS deployed by `NASdeploy.sh` would see no update banner even with a fresh manifest live on GHCR + ripperdoc.de. `NASdeploy.sh` now reads `release.pub` (overridable via `$PUBKEY_FILE`) and passes it through. (`11b0959`)

## v0.20.6 — 2026-05-12

### Fixed

- **Library sidebar's search bar and stats bar regressed to scrolling with the file list.** After the post-OSS-flip change that kept all three sidebar panels mounted at once (`3267185`), each panel got wrapped in a `<div style={{ flex: 1, minHeight: 0 }}>` that expected a flex parent — but `.sidebar-content` was a plain block container, so the wrapper fell back to content-sized height. `LibraryPanel { height: 100% }` then resolved against an auto-height parent and collapsed; the search row scrolled with the list instead of staying pinned at top, and the stats bar (with `margin-top: auto`) had no room to push to the bottom — it landed at the end of the file list. `.sidebar-content` is now `display: flex; flex-direction: column` so the active panel actually claims the sidebar's height, internal scrolling stays inside `.library-content`, and pinned top/bottom rows behave like they used to. SettingsPanel and DebugPanel had the same latent issue and benefit from the same fix.

- **Library filter no longer freezes the input on large libraries.** Per-keystroke filtering was re-running `HistoryView`, `FolderView`, `LiveBrowser`, and the `filterFile` callback synchronously on every character. On a small library that's invisible; on a multi-thousand-file library the main-thread work blocked the input event loop and typing felt laggy. The filter pipeline now debounces with a 200 ms trailing delay — the input itself binds to the raw value so typed text appears instantly, only the downstream filtering waits. Empty values short-circuit the delay so clearing via the "x" button stays immediate.

### Changed

- **Toolbar "Open" button is "Upload" with an upload icon in the web build; Electron keeps "Open."** In a browser the picker reads the file into memory client-side — closer to "upload from your device" in a user's mental model than "open a path on disk." New web users were expecting an OS-style file-open dialog reaching into their library folder and clicking the button on the live site mismatched that expectation. Electron's file picker really does reach into the local filesystem, so it stays labeled "Open." Same handler, same `data-testid="open-btn"` (Playwright tests still pass on both builds), tooltip mirrors the distinction.

- **Settings ▸ Library tab now houses the library folder picker, auto-scan toggle, database info, and library prefs (auto-load bound PDFs, history depth).** They previously lived under Settings ▸ System inside a section titled "Server / Library" — a historical name from before a dedicated Library tab existed. With the Library tab covering sync and OBD already, the folder/DB fundamentals belong on the same tab. New ordering on the Library tab: **Library Folder & Database** → **Library Sync** → **OpenBoardData** (fundamentals → sync → external data). Internal section id stays `server` so per-user expansion state in localStorage carries over unchanged.

## v0.20.5 — 2026-05-12

### Fixed

- **TVW (Teboview) parser now handles two previously-unobserved variants — three sample boards that produced an empty viewer now parse cleanly.**
  - **Header `h5/h6/h7` Pascal strings.** Three pstr fields between `date` and `size1` were being read as 3 raw bytes (`const3` in eagleview). In every previously-known sample those fields are empty (3 zero length-bytes), so the raw read worked by coincidence. `samples/BROKEN/NM-D355_r1.0_HT4BT.tvw` ships one of them as `"q798"`, which shifted every subsequent header field by 4 bytes; the parser then read `layerCount = 2` instead of 20 and bailed on the first layer with "unknown object type 20." Fix: parse the three fields as Pascal strings (byte-compatible with all prior samples).
  - **Per-pin opposite-side contact count.** The trailing `u32` after each pin's name pstr was assumed to be `Z2 == 0` (eagleview asserts this). It's actually a per-pin counter for opposite-side through-hole/edge contacts. When **any** pin in a part has it set, a mirrored-contact block follows the primary pin list: `(u32 cont_flag, u32 reserved)` then `Σ ext_contact_count` more pin records (no trailing counter of their own). The previous heuristic-based `looksLikePinExtension` detector was a weaker proxy for the same signal — it over-fired on NM-D355's H11 SWITCH (2 declared pins + 1 mirrored contact, read as 2 ext-pins instead of 1) and was inconsistent on Landrex connectors. Observed in three in-the-wild patterns:
    - LianBao SWITCH (NM-D355 H11): `pinCount=2`, sum=1 — mechanical switch with one mirrored mechanical contact
    - Landrex vertical connector (Gigabyte GV-N5080 CN1): `pinCount=82`, sum=82 — every pin mirrored on opposite copper layer
    - Landrex edge connector (Gigabyte GV-R79X MPCIE1): `pinCount=82`, sum=82 — PCIe slot dual-sided
  - **Verified across the 16-file TVW corpus:** `NM-D355` 0 → 3957 parts, `GV-N5080` 28 → 3161 parts, `GV-R79X` 0 → 4825 parts. Every other working sample unchanged. The format note is captured in `docs/formats/TVW_FORMAT.md` so upstream eagleview and future parsers don't make the same `Z2 == 0` assumption.

## v0.20.4 — 2026-05-10

### Fixed

- **Library files served from cloud-sync placeholders no longer reach the parser as truncated bytes.** When the user's library mount lives on a cloud-managed filesystem (Google Drive on macOS via File Provider, OneDrive on Windows via NTFS reparse points, iCloud, Dropbox Smart Sync), the OS lazily materializes content on read. `http.ServeFile` was happy to stream whatever the kernel returned — sometimes a partial file or zero bytes — and the frontend parser would fail with "empty/truncated file." The two cloud-exposed file-serve handlers (`files.Get`, `files.GetByPath`) now route through a new `serveFileEager` (`src/backend/handlers/serve.go`) that reads the file fully into memory and verifies byte count matches `stat().Size()` before responding. Truncated reads return 503 + `Retry-After: 5`; the 30s read deadline returns 503 + `Retry-After: 10`. Frontend `fetchWithCloudRetry` retries up to 6 attempts / 3 min, surfaces a "Downloading from cloud storage…" toast on retry, and surfaces an error toast on exhaustion. `databank.PreviewGet` deliberately keeps `http.ServeFile` — previews live in the always-local `<dataDir>/.previews/` and benefit from `ServeFile`'s ETag/304 caching there.

- **Docker-bound cloud placeholders surface a clear "materialize on host first" error** instead of a generic 500. When BoardRipper runs in a Docker container on macOS with a Google Drive folder bind-mounted as the library, the FUSE bridge can't drive host-side materialization and reads return `EDEADLK` (resource deadlock avoided). `serveFileEager` now detects this specific error and returns 503 with a body that tells the user how to fix it: "Cloud-storage placeholder: file not yet materialized on host. Open it on the host (Finder → right-click → 'Keep on this device' for Google Drive/iCloud, equivalent for OneDrive) or sync your library to a fully-local directory." Native macOS reads of the same placeholder block 1–2 seconds for materialization and succeed normally — `EDEADLK` only fires inside the container, so the friendly error is scoped to the case where it's actually useful.

### Trade-offs

- Range-request and `ETag`/`If-Modified-Since` caching are dropped on the two affected handlers. No current consumer relied on either (boardview parsers always read from byte 0; PDF.js doesn't issue range requests in the current implementation).
- 512 MiB cap on in-memory reads in `serveFileEager`. Boardview files are <10 MB, PDFs <100 MB; the cap is a safety net, not a hot path.

## v0.20.3 — 2026-05-10

### Fixed

- **OpenBoardData index now survives container updates.** OBD cache was rooted at `<libraryDir>/.boardripper/openboarddata/`. The library mount is `:ro` by default in Docker, so atomic writes silently failed and the index was effectively in-memory — gone on every container restart, including the restart triggered by self-update. Users had to re-sync (`POST /api/obd/index/sync`, ~2 min) after every release. Cache now lives at `<dataDir>/obd/`, which is the always-writable persistent volume by design. Existing caches at the legacy path are auto-migrated on first boot via `obd.MigrateLegacyCache`; cross-volume rename failures (typical when `/library` and `/data` are different mounts) fall back to a one-time re-sync. `obdStore` is no longer library-conditional — OBD works on fresh installs that haven't configured a library yet.

- **Library "Browse" tab respects the search filter in live-filesystem mode.** Typing into the filter input had no effect when the user was browsing live (`viewMode === 'folders' && browseMode === 'live'`). The filter wired to the database-backed `FolderView` was silently dropped on the `LiveBrowser` side. `LiveBrowser` now receives `searchFilter` from the same `localSearch` state every other view uses, applies a case-insensitive substring filter to both directories and files in the current directory. A directory whose name matches stays visible so the user can navigate toward something they remember the parent name of. No descent into subdirectories — that stays as future work.

## v0.20.2 — 2026-05-09

### New

- **Right-click context-menu selection header.** A muted, smaller-font line at the very top of the menu shows what Copy / Search will act on: `<component> · pin <pinId> · net <netName>` in board mode, or the cursor word in PDF mode. Hidden when the relevant fields are empty. Removes the "wait, what am I about to copy?" pause that the new icon-strip introduced in v0.20.1.

### Fixed

- **Right-click menu was blocking ~1 s on bound PDFs.** `pdfStore.countTextMatches` walked every line of every page synchronously, called 3× per PDF donor (default query, chip@pin variant, net variant), all before the menu rendered. With one bound PDF that's 3 sync scans gating the open. New `countTextMatchesAsync` yields every 8 pages via `setTimeout(0)`; ContextMenu dispatches the counts in a `useEffect` after first paint and replaces `(…)` placeholders as each promise resolves. AbortController cancels stale work when the menu closes or the selection changes. Board counts (`countInBoardTab`) stay sync — they walk in-memory parsed objects, not text.

### Docs

- **README has a Keyboard Shortcuts section** covering the new game-style shortcuts (WSAD, Q/E, Shift+W/S), the `~` library toggle (with the layout note about Backquote / IntlBackslash and the AZERTY caveat), and the configurable Settings ▸ Navigation knob.

## v0.20.1 — 2026-05-08

### New

- **Game-style keyboard shortcuts** (WSAD pan, Q/E rotate, Shift+W/S zoom, `~` toggles Library sidebar). Pan and zoom work on both board and PDF panels; rotate is board-only and silently no-ops on PDF. Library toggle binds to the physical key left of `1` via `KeyboardEvent.code` ('Backquote' on US, 'IntlBackslash' on German Mac), so `~` on US, `°` on German DE both fire the same toggle. Existing Cmd+arrow / Space / Cmd+F shortcuts unchanged. Auto-rendered in Settings ▸ Shortcuts and the home-screen Getting Started card under a new "WSAD Navigation" section. Pan and zoom step sizes configurable in Settings ▸ Navigation ▸ Keyboard pan / zoom (default: 10% of screen per pan, ×1.32 per zoom press; previous defaults were 15% / ×1.72).

- **Right-click context-menu icon strip.** A new top-of-menu icon row with up to 4 board buttons (Copy net, Copy part, Search net, Search part) or 2 PDF buttons (Copy, Search Web) for the cursor word. Copy uses `navigator.clipboard.writeText` with toast feedback; Search opens Google in a new tab with `noopener,noreferrer`. Strip hides entirely when no entity is selected. The existing donor-row search functionality is unchanged below.

- **Shortcut schema gained `code` (KeyboardEvent.code, single string or array for multi-layout binding), `displayLabel` (formatter override), and `ignoreShift` (matcher accepts shift-held events when set, used by the `~` library toggle so Shift+Backquote fires the same as bare Backquote).** Foundation for layout-aware keybinding (AZERTY remapping is queued for a future release).

### Fixed

- **The keyboard matcher was permissive about un-required modifiers.** `if (!requireShift && e.shiftKey) return false;` was missing — bare `W` would match `Shift+W` events, blocking the new zoom shortcut from registering distinctly. Added the symmetric guard. The `Shift+Cmd/Ctrl+F` "previous match" path (documented in the focusSearch shortcut description) re-enters with `{ ...focusSearch, shift: true }` so the routing block still receives both directions.

- **Pin labels were being painted under the highlight ring**, so the ring's stroke clipped the bottom of pin numerals on selected nets. Renderer now stacks labels above the ring graphics so the typography reads cleanly on top, and the ring stroke pops past the label outline rather than through it. (Reported by the user on a Quanta board where 0402 caps were unreadable on a selected ground net.)

## v0.19.9 — 2026-05-08

### Fixed

- **Self-update was silently broken on Synology DSM Container Manager.** v0.19.7 hardcoded the Engine API path to `/v1.44/` to fix Docker Engine 29.x rejecting `/v1.41/` as "too old"; the same hardcode now broke Synology DSM (Docker 20.10.3, max API 1.41) which rejects `/v1.44/` as `client version 1.44 is too new. Maximum supported API version is 1.41`. Every code path through `docker.sock` — pull, load, inspect, orchestrate — hit the same 400. Bundle-drop also affected (shares `dockerLoad`). User-reported on the maintainer's NAS, manual SSH swap was the only escape until this release. Fix: probe `GET /_ping` once on first use, parse the daemon's `Api-Version` header, and prefix every Engine API call with that. `sync.Once`-gated; falls back to `v1.41` if `/_ping` itself fails (in which case nothing else would work either, but no panic at first use). Replaces all 13 hardcoded `http://docker/v1.44/...` strings; the orchestrator shell script's `API=` line gets the same value via `Sprintf` so the alpine-curl payload speaks the same dialect. Forward-compatible to whatever Docker bumps the floor to next.

## v0.19.8 — 2026-05-08

### Fixed

- **Net highlights resolved to wrong parts on any file with ≥1 BOM-alternate cluster.** `buildRenderedBoard`'s filtered branch (BOM-alternate filter / hide-ghosts toggle) returned `nets: rev.nets` from before any parts were dropped. `Net.pinIndices` are positional `partIndex` refs into the array they were built against — after dropping a single part every index past that slot pointed one element off in the filtered array, scrambling every net on the board. Latent since `176cced` (2026-04-14, hide-ghosts toggle, default off — almost no one hit it). Default-on as of `48ce8ae` (2026-05-05): BOM-alternate cluster filtering with `showBomAlternates: false` default means any CAD/TVW file with ≥1 detected cluster drops one part on first render. ROG STRIX RTX 4090 sample (1 cluster, C1903/C1906) was the user-reported canary — clicking PC101 lit PC104 / PC258 / C415 instead of PC265, and 12V_F_R1's 36 refs landed on a completely different 27 parts than the file actually says. Fix: rebuild nets via `buildNets(filteredParts)` whenever any part is dropped. Regression spec asserts every `pinIndex` in every net resolves to a pin actually on that net after filtering.

## v0.19.7 — 2026-05-07

### Fixed

- **Self-update was silently broken on Docker Engine 29.x** (the floor for fresh Docker Desktop installs from January 2026). The in-binary updater hardcoded the Engine API path to `/v1.41/`; Engine 29 rejects that with HTTP 400 (`client version 1.41 is too old. Minimum supported API version is 1.44`). The first call (`findSelfContainer`) parsed the `{"message":...}` error body as a `[]struct` and failed with `cannot unmarshal object into ... []struct`; `tagPrevious` warned and continued, but every later docker.sock call also 400'd and the orchestrator was never created — Apply silently bailed out part-way. Bumped all Engine API URLs to `/v1.44/` (single `dockerAPIVersion` constant; keeps Docker 25+ compatibility — the floor on current Synology DSM Container Manager). `findSelfContainer` now also checks `resp.StatusCode` and surfaces the error body so the next floor bump shows up as `Docker API HTTP 400: ...` instead of an unmarshal error.
- **Apply errors were dropped on the floor by the HTTP handler.** `go h.upd.Apply()` discarded the return value, and several pre-orchestrate failure paths (manifest sha mismatch, `findSelfContainer` failure, etc.) returned without first logging a `status: error` progress entry. The frontend's SSE stream would just go silent and the UI hung on "Updating…" until the 2-minute health-poll timeout. New `Updater.PushError` helper funnels the return value into the SSE channel as a terminal error entry; `ApplyBundle` got the same treatment.
- **`waitForRestart` reloaded the page against the about-to-die backend.** `Apply()` returns the moment the orchestrator container is *launched*, but that orchestrator's first action is `apk add curl` (5–15 s) before it stops the running container. During that window `/api/health` on the OLD container returned 200 happily — the previous loop accepted that as "swap done" and reloaded the page right back into the dying backend. The user then saw a "rolled back" log line and sat on the unchanged UI until the next 30-minute background poll. Now waits for an authoritative `/api/update/status` to report the manifest's expected new version (cookie survives the swap because the per-install secret persists in `/data`); falls back to a downtime-then-up `/api/health` sequence if status auth races. Reload only fires when the swap is real.
- **Slow two-finger trackpad scroll on the PDF panel zoomed instead of paging.** Two related causes: (1) the `wheelDetection` burst-latch in `scroll-mode.ts` was defaulting every new burst to "wheel" — slow trackpad scrolls (gaps >35 ms — never reach the 6-fast-cadence demotion threshold) stayed latched and got reinterpreted as zoom. The first event of a new burst is now classified by signature (large integer `deltaY` with no `deltaX` → wheel; `ctrlKey`, `deltaX`, small magnitude, or fractional → trackpad), preserving the original Mac smooth-scroll mid-burst-flip fix while fixing slow trackpad scrolls. (2) The PDF panel's wheel handler no longer consults `looksLikeMouseWheel` at all — the safety net's purpose ("classic mouse wheel + pan mode = unusable") is board-only; on PDF, bare wheel scrolling is the natural way to walk through pages even with a real mouse wheel. Pinch (`ctrlKey`) still routes to zoom.

### Tooling

- **End-to-end self-update harness (`tools/update-test/`).** Builds OLD + NEW docker images pinned to a throwaway minisign key + a local Python http.server mirror at `host.docker.internal:18000`, signs a mock release manifest, starts the OLD container with `/var/run/docker.sock` mounted, and drives Playwright headless Chromium through the full apply→swap→reload, screenshotting every 2.5 s into `results/`. Asserts overlay visibility during restart, version flip via `/api/update/status`, and absence of JS crashes during the disconnect window. The harness reads `__brUpdateStore.{updating,restarting,progress.length}` directly via a deliberate `window` export so it can probe internal state without walking the React fiber. One command — `cd tools/update-test && ./run.sh` (add `BR_HARNESS_HEADED=1` to watch). Cached re-run completes in ~1 minute. **Run before any future updater change.**

## v0.19.6 — 2026-05-07

### Fixed

- **Small pins were unselectable in chain-adjacent / search-dim / spotlight modes.** PixiJS v8 Graphics inherit `eventMode` from their parent — the viewport is interactive (so pins receive clicks), so every Graphics added underneath was *also* interactive and any painted pixel under the cursor counted as a hit. The full-board dim layer drawn in those modes silently swallowed clicks before they reached the pin sprites; tiny 0402 caps and dense BGA pins were the worst affected. Decoration layers now explicitly set `eventMode='none'` at construction *and* at every `renderSelection` (the latter is an HMR safety-net — Vite replaces the module without re-instantiating the PixiJS Application, so layers in a hot-reloaded session would otherwise stay stale on `'auto'`). User-reported as "extreme regression."
- **XZZ multi-board packs were sometimes globally folded into one mirrored slab.** iPhone14 Pro/ProMax combined boardview was the canary — its tall portrait boards produce a strong mid-Y centroid gap (the empty CPU centerlines stacked on top of each other) that beat the X-direction inter-board gaps and slipped past the balance checks in `findFoldAxis()`. Now early-returns when the outline decomposes into ≥4 connected components that all pair off by `(width, height, segCount)`; per-board X-fold axes from `boardGroups` are the only thing the UI applies, with manual per-board folding still available from the sidebar. PARSER_VERSION bumped to invalidate cached entries.
- **Board rotation now pivots around the viewport's current focus**, not the board's geometric centre. Rotating while looking at a non-centred region used to slide that region off-screen. Implementation captures the viewport's world-centre before `applyFlips`, then pans so the same world point lands at screen-centre again after the rotation completes. Net-line geometry is now also recomputed and redrawn immediately on rotation (previously stayed at pre-rotation world positions until the next selection/pan/pulse-tick).
- **Flip-axis toggle now stays screen-stable across rotation.** Rotating to 90°/270° silently inverted the meaning of the flip-axis button — the stored hinge is a board-axis, but the user picks a *screen* direction. `rotateFlipAxis()` now flips the stored `'x'|'y'` whenever rotation crosses an axes-swap boundary so the screen direction the user selected is preserved. Toolbar icon and tooltip ('⇅ Vertical' vs '⇄ Horizontal') reflect the actual screen-axis result.

### New

- **180° rotation button** between the CCW/CW arrows. Repair work is dominated by boards photographed from the wrong end; one click is faster than two.
- **Rotation disabled in butterfly mode** with an explanatory tooltip — rotating a side-by-side spread tilted the joint off-screen, and the auto-separation axis logic didn't track manual rotation.
- **Public landing page** at <https://www.ripperdoc.de/boardripper/>. Plain HTML5, no JS, deployed via the RipperDocWeb rsync. Lives in `landing/`, excluded from the Docker image (the Dockerfile only `COPY`s `src/frontend/`, `src/backend/`, and `Board Database/boards.db`). See `landing/README.md` for the update workflow.

### Performance — renderer hot-path

Four findings from the 2026-05-07 review report; all sub-millisecond individually, compounding under sustained interaction. The bundle was reverted once when its `eventMode` interaction with the dim-layer bug surfaced as a click-blocking regression, then re-introduced piece by piece after that bug was traced to a separate root cause and fixed independently.

- **R-1** — restored G-3's zero-allocation property for the net-line render path. Per-pulse-frame `Map<color, Segment[]>` and `{start,end}` wrapper allocations (added in `a9d99b4` for chain-adjacent) are now built once in `recomputeNetLineSegments` (already dirty-tracked) as `netLineSegmentsByColor`. ~30 allocs/frame → 0 (single net) or ~150 → 0 (chain-adjacent on a 60-net rail).
- **R-2** — replaced `[...adjacentNets].sort().join(',')` sentinel with `.size` compare in `lastRenderedSel`. Content changes always co-occur with a change in `(partIndex, pinIndex, highlightedNet, board)` — the BFS inputs — so size is a sufficient sentinel. Saves ~0.05–0.3 ms per store notify on a 60-adjacent rail; biggest win during search iteration / PDF-binding refresh.
- **R-3** — pulled the OBD tooltip lookup off the per-`pointermove` path. `formatObdForNet` was running 6 regex tests + O(matches × |nets|) per move (~4 500 string compares on a 3-variant × 1 500-net board). Now: `obdNetIndex(boardNumber)` exposes a snapshot-keyed `Map<netName, ObdNet[]>` cached on a `WeakMap` keyed by the obd-store snapshot, and `BoardRenderer` memoises `extractBoardNumberFromFilename` against `boardStore.fileName`. Per-move cost: 1 string compare + 1 `Map.get`.
- **R-4** — promoted `crossSideGhostParts` from `number[]` to `Set<number>`. Two `.includes()` calls in the per-pin chain-mode net-line builder were O(g) linear scans called for every pin reference of every active net (~30 000 array scans → ~600 hash lookups on a busy 5 V rail with 60 nets, 10 pins, 50 ghosts).

### Updater hardening

Closes the two Important findings from `docs/analysis/2026-05-07-updater-security.md`. The crypto primitives were already well-covered; these tighten the surrounding I/O envelope.

- **Enforce `released_at` freshness window in `ValidateManifest`.** The existing check rejected expired manifests (90-day `not_after`) but ignored `released_at`, so a compromised mirror could re-serve any signed-but-stale manifest from anywhere in the 90-day window — defeating the counter check on first install (where `installedCounter == 0` skips), and freezing installed clients on outdated releases. Now requires `released_at ∈ [now − 30 d, now + 24 h]`. The 30 d past bound is wide enough not to bite the maintainer's normal cadence (5 releases in 9 days during the v0.19 cycle); the 24 h future slack tolerates clock-skew between signing host and client. Manifests without `released_at` are rejected outright.
- **Cap, time-out, and stream-verify the tarball download.** `downloadAsset()` previously did a plain `http.Get()` with no timeout, no size cap, and no streaming integrity check; `applyTarball` then re-read the whole tarball off disk to compute SHA-256, doubling peak RAM. New `downloadAssetVerified()` does it in one streaming pass: 10 min `http.Client.Timeout`, body cap = manifest's signed `SizeBytes` (or 1 GiB legacy fallback) by reading one byte past the cap so over-long streams are observed not silently truncated, incremental SHA-256 via `io.MultiWriter(file, sha256.New())` so peak memory stays at io.Copy's 32 KiB buffer. Rejects on size mismatch, SHA mismatch, or non-200.
- **Test coverage for orchestration helpers.** v0.19.2 (image-ref form), v0.19.3 (ghost-pulse), and v0.19.4 (healthcheck-by-name) all regressed in the orchestration layer despite well-tested crypto primitives. `parseDockerImageRef` and `selectNewImageRef` extracted as pure functions and covered with 25 tests across `parseDockerImageRef` (6 forms incl. embedded-colon-in-digest), `selectNewImageRef` (4 paths incl. the v0.19.2 fallback case), `extractBundle` (path-traversal guard, bsdtar/gnu `./` parity, ignored-extras), `bindsFromMounts`, and `shortID`.

### Release pipeline

- **Multi-arch INDEX digest is now captured for both the BoardRipper image and the orchestrator alpine.** Two same-class fixes: (a) `release.sh` was reading `--raw | jq '.manifests[0].digest'` for the BoardRipper image, which grabs the *first* platform manifest (amd64) from the multi-arch index, then signing that amd64-only digest into `manifest.json`. amd64 hosts pulled fine; an arm64 install would error. Now uses the non-raw `imagetools inspect`'s top-level `Digest:` line, hard-failing if the parse returns empty. (b) Same bug class on `alpine:3.19` for the orchestrator: `docker pull --platform linux/amd64` then `RepoDigests[0]` gave the per-platform manifest digest, not the index digest. Now pulls without `--platform` and reads via `buildx imagetools`. v0.19.5's NAS deploy was unaffected because the maintainer's NAS is amd64-only.

## v0.19.5 — 2026-05-06

### New: update-in-progress modal

When the user clicks **Update Now**, BoardRipper now shows a centered modal: *"Update in progress — the page will reload automatically in 30–60 seconds."* The modal stays up across the SSE-disconnect window (the orchestrator deliberately stops the running container, killing the progress stream — that is the **expected** success path, not a failure). Once the new container's `/api/health` responds, the page reloads automatically; the modal vanishes.

A `boardripper-update-in-flight` flag in localStorage persists across page refreshes mid-update — refreshing the tab while the update is in flight no longer presents a fresh dashboard with an "Update" button that could be clicked again. The flag is cleared on completion or after 5 minutes (whichever comes first). Backend health-poll runs every 2 seconds for up to 120 seconds while waiting for the new container.

### New: drop-to-update fallback

When the in-app update button can't reach GHCR or ripperdoc.de — or when a future broken-orchestrator bug strands an install — users can now download a single bundle file and drag it onto the BoardRipper window to apply the update. Each release publishes `boardripper-update-vX.Y.Z.tar` (and a stable `latest-update.tar` alias) at <https://www.ripperdoc.de/boardripper/releases/>. The bundle contains the signed manifest, its signature, and the OCI image tarball; the running container verifies the signature against its compiled-in public key, validates counter/expiry/min-version, checks the tarball sha256, then runs the same orchestrator restart as the network path. Same trust envelope: only the manifest signature grants trust; the file itself is untrusted bytes until verification passes. Recovery escape-hatch for any future broken-self-update situation, but only available once the running container is on v0.19.5+.

### Internal

- `update-store.ts` gains `restarting` / `restartingFromVersion` getters and an internal `streamProgress()` + `waitForRestart()` flow shared between `apply()` and `applyBundle()`.
- New `UpdateProgressOverlay` React component, mounted at the App root, gated on `updateStore.restarting`.
- New backend endpoint `POST /api/update/apply-bundle` (multipart upload, same auth-cookie middleware as the other `/api/update/*` routes).
- New helper `updater.ApplyBundle([]byte)` reuses every existing piece (`VerifyManifest`, `ValidateManifest`, `VerifyTarballSHA256`, `dockerLoad`, `orchestrateRestart`).
- `release.sh` now produces `out/boardripper-update-$VERSION.tar` alongside the regular tarball and uploads it to FTP atomically.
- `scripts/release/site-artifacts.sh` no longer requires `pandoc` — built-in renderer (perl + sed + awk) handles the BoardRipper CHANGELOG.md format. Without this, missing pandoc on the maintainer's machine silently uploaded a 141-byte stub instead of the rendered changelog.

## v0.19.4 — 2026-05-06

### Fixed

- **Auto-update silently rolled back on default Docker bridge.** The orchestrator polled `http://<container-name>:8080/api/health`, but Docker's default bridge network does not provide DNS-by-name for containers (only user-defined networks do). The poll never resolved, the 60-second healthcheck timed out, and the orchestrator restored the previous container — looking from outside as if "the update silently undid itself." Fix: query the new container's IP via `containers/{id}/json` and poll that IP. Falls back to name lookup if IP can't be parsed (preserves user-defined-network behavior).
- **Status bar showed wrong version after update** (e.g. `0.19.0` while backend was on `0.19.2`). The frontend bundle injects `__APP_VERSION__` from `src/frontend/package.json` at build time, which was being bumped by hand. The backend version comes from `release.sh`'s `--build-arg APP_VERSION`. The two drift apart whenever release.sh runs without a prior `package.json` edit. Fix: `release.sh` now writes `$VERSION` (sans `v` prefix) into `package.json` before the build, then commits the change as part of the release commit. Single source of truth from this release on.

### Migration note

Existing v0.19.0–v0.19.3 installs cannot auto-update to v0.19.4 (their bundled orchestrator still has the healthcheck-by-name bug). One manual `docker pull ghcr.io/alexeyinwerp/boardripper:v0.19.4 && recreate-container` is required. After landing on v0.19.4 once, future auto-updates work normally.

## v0.19.3 — 2026-05-06

### Fixed

- **Cross-side ghost outlines no longer flash and tank framerate during pan/zoom.** The ghost-pulse animation was rebuilding the entire `crossSideGhostGfx` Graphics object every tick (clearing, recomputing each part's polygon/bounds, drawing fill+stroke+pins), running at 60 fps regardless of whether the user was interacting. On boards with many hidden-side parts on a selected net, this competed with viewport updates and produced visible stutter. On top of that, `onZoomFrame()` was clearing the ghost geometry on every zoom frame, so during continuous wheel scrolling the ghosts vanished and reappeared on each 32 ms settle, producing the visible "flash".
  - Net-line + ghost pulse now freezes for a 100 ms window after every viewport `'moved'` event; pan and zoom no longer pay the per-frame Graphics rebuild. Phase doesn't advance during the pause, so the breathing resumes jump-free once the viewport settles.
  - The ghost gfx is no longer cleared in `onZoomFrame()` — ghost stroke widths are world-space and stay visually correct at any zoom, so the ghost stays drawn (frozen at last alpha) during zoom instead of vanishing/reappearing.

## v0.19.2 — 2026-05-06

### Fixed

- **Self-update would leave the host with no running container** when updating from v0.19.0 or v0.19.1. The orchestrator built the new container's image reference as `boardripper:<version>` (a leftover from the legacy tarball-load deploy convention), but the GHCR pull stores the image as `<registry>@<digest>` with no local named tag. The Docker daemon returned 404 on `containers/create`, the orchestrator's `set -e` killed the script before the rollback path could run, and the old container was left renamed to `-old` and stopped.
  - Now uses the canonical `<registry>@<digest>` reference, falling back to `<registry>:<tag>` if the digest is absent. Both pull-by-digest and tarball-load paths resolve correctly.
  - **Existing v0.19.0 / v0.19.1 installs cannot auto-update to v0.19.2** because their bundled orchestrator still has the bug. One manual `docker pull ghcr.io/alexeyinwerp/boardripper:v0.19.2 && recreate-container` is required. After landing on v0.19.2 once, future auto-updates work.
  - Recovery procedure for anyone hit by this on v0.19.0/v0.19.1: `docker rename boardripper-old boardripper && docker start boardripper` puts the host back on the old version.

## v0.19.1 — 2026-05-06

First release through the new pipeline end-to-end (no GitHub Actions). Pure cosmetic fixes; **the update flow itself is what's being validated.**

### Fixed

- **Quick settings labels on the home dashboard** now read identically to the Settings panel. Previously the dashboard showed glyphs (⇧ ⌃ ⌘ ⊞) and a half-translated `Cmd+Scroll / Win+Scroll` form for the PDF meta slot, while the Settings panel said `Shift + Scroll / Ctrl + Scroll (fast)` and `⌘ + Scroll / Ctrl + Scroll`. Both surfaces now use the same wording.
  - Slot labels: `Left-drag`, `Shift + Left-drag`, `Scroll`, `Shift + Scroll / Ctrl + Scroll (fast)`, `⌘ + Scroll` (Mac) / `Ctrl + Scroll` (Windows/Linux).
  - Row labels tidied: `Board: CLICK+DRAG` → `Board: Drag`; `Board: 2Finger/Scroll` → `Board: Scroll`; `PDF: Scroll` consistent.
  - Hint tooltips also match: "Drag pills between slots to reassign scroll actions."
- **Settings page subsection** "Mouse drag behavior" renamed to "Trackpad/Mouse drag behavior" — matches the QuickSettings hint already in place.

### Internal

- `scripts/release.sh` no longer uses the unsupported `lftp mv -f` syntax — atomic rename now does explicit `rm -f && mv`. (Already fixed in `84308b3`; this is the first release that benefits.)

## v0.19.0 — 2026-05-05

### New: secure update pipeline (replaces GitHub-token flow)

Updates no longer require `GITHUB_TOKEN`. Each release is now signed offline by
the maintainer (Ed25519 / minisign), and the running container verifies that
signature against a public key compiled into its own binary before applying any
update.

**For end users:** you can remove `GITHUB_TOKEN` from your `docker-compose.yml`
after this update. The toolbar update button keeps working with no token. If you
prefer to update manually, both sources are public and free:

```bash
docker pull ghcr.io/alexeyinwerp/boardripper:latest
docker compose up -d
```

…or the signed-tarball mirror (no Docker registry required, useful behind
firewalls):

```bash
curl -O https://www.ripperdoc.de/boardripper/releases/latest.tar.gz
docker load < latest.tar.gz
docker compose up -d
```

**What changed under the hood:**

- **Two delivery sources.** `ghcr.io/alexeyinwerp/boardripper` (public registry,
  fast layer dedup) and `https://www.ripperdoc.de/boardripper/` (signed tarball
  mirror). Updater walks them in order and accepts the first source whose
  manifest signature verifies. A hijacked mirror cannot deliver a forged update.
- **Manifest schema.** `manifest.json` carries `version`, `counter`,
  `released_at`, `not_after`, `important` flag, image digest, and tarball
  sha256. Replay/freeze attacks closed by a monotonic counter; dropped manifests
  closed by a 90-day expiry.
- **Notify-only UX, no auto-apply.** Updates appear as a banner; nothing
  installs without you clicking. Releases marked `important` (security fixes)
  show with a red banner instead of the normal blue.
- **Healthcheck-based rollback.** If the new container fails its healthcheck
  within 60 s of starting, the orchestrator auto-reverts to the previous image.
- **Per-install auth on `/api/update/*`.** A 32-byte secret is generated on
  first boot (`/data/.update-secret`, mode 0600). LAN drive-by requests to
  `/api/update/apply` now return 401. The web UI bootstraps an `HttpOnly +
  SameSite=Strict` cookie on first load.

Maintainer release runbook: `docs/RELEASE_RUNBOOK.md`.

### Fixed

- Polyfilled `Promise.withResolvers` for older browser engines (R3dfox / Mypal
  on Win7 etc.). pdfjs-dist@5 calls it directly and would throw before any PDF
  byte was read.

### Misc

- Landing page footer credits "Alexey Lavrov / RipperDoc Munich".
- `CLAUDE.md` documents the `landing/` folder workflow.

### Bridge release note (one-time)

This release is the last one published to the private GitHub Releases page —
it's the bridge release that moves existing token-using clients onto the new
system. From v0.19.1 onward, releases will only appear at GHCR + ripperdoc.de.

---

## v0.18.1 — 2026-05-05

### Fixed

- **FZ load failures on real-world ASUS / MSI / ASRock boardviews.** The dominant variant in our 116-file NAS corpus (84%) carries an undocumented 4-byte forward-pointer that strict zlib decoders reject as trailing junk. We now detect and trim it before decompression, and we replaced the browser-native `DecompressionStream` with `pako.inflate` for tighter error reporting. Combined fix: ~80% of previously-broken FZ files now load.

## v0.18.0 — 2026-05-05

### New: themes — accent / background / chrome split

Themes are now two independent surfaces. The `THEMES` registry covers **board-side** concerns only (pin colours, part fills, background-of-board) and the board adopts whichever entry matches its file family. **UI chrome** obeys three independent knobs the user can set from the QuickSettings home dashboard or from Settings ▸ Themes:

- `accent` — buttons, focus rings, primary chrome (with auto-flipped text colour against perceived brightness)
- `background` — app shell background
- `chrome` — toolbar / status bar / sidebar chrome

Five accent presets ship: BoardRipper default (recoloured away from generic AI-cliché blue), and four ATARI homages (Pantone Bright Red C plus the Atari 2600 silver-label rainbow stripes). Each knob persists separately.

### New: Mentor Boardstation Neutral parser

11th supported format. Mentor Graphics Boardstation/Expedition exports a plain-text "neutral file" with the `.cad` extension shipped with some Samsung / Quanta / Compal / Acer notebook board packages — **not** GenCAD despite the shared extension. Detection cue: `# file : ...` first comment + `BOARD ... OFFSET ... ORIENTATION` record + `###Section` banners. Outline is synthesized from drill-hole geometry. See `docs/formats/MENTOR_NEUTRAL_FORMAT.md` for the full spec; AGPL provenance recorded in the spec footer.

### New: board-overlay search dropdowns + customizer

The floating in-canvas overlay (top/bottom toggle, flip-axis, parts/nets filters, dim-mode tri-state, selection-name label) is now slot-driven and user-customizable. Drag-and-drop in Settings ▸ Board overlay reorders or hides slots; "Add separator" inserts a divider; layout is persisted. Parts and Nets dropdowns use a shared popover scaffold with a memoized natural-sort index (refdes-aware) and a No-Connect partition for nets.

The dim-mode button cycles three states (off / search-dim / spotlight) — spotlight is a smooth dark gradient with a clear core sized to the selected component; selected pins draw above the spotlight so the component stays fully bright.

### New: home dashboard — bindings matrix + behaviour toggles

The HomeBackdrop dashboard now carries a Bindings matrix (board↔PDF associations from the library) and Behaviour toggles (auto-open PDF on board load, theme switch). The QuickSettings strip got a compact accent picker.

### Fixed

- **Allegro pad rotation on diagonally-placed footprints.** 45° QFNs and similar non-axis-aligned packages now render with correctly rotated pads.
- **`useThemeOverrides` `useSyncExternalStore` infinite loop.** Snapshot now caches a stable reference; the same fix shape applied to HomeBackdrop earlier in the cycle (`01eda1c`).
- **Settings panel crash guards** for the new overlay/themes subtree (`?? DEFAULTS` + try/catch defensive paths in fresh code).
- Browser-native page-zoom (Ctrl+/Ctrl-/Ctrl+wheel-on-page-chrome) no longer fires inside the BoardRipper window — would previously double-count with the in-canvas zoom.

### Internal

- `theme-store.ts` consolidated; the parallel registry shipped as a stop-gap was dropped.
- `boardOverlay` slot registry under `components/BoardOverlay/` with per-slot toggle components and a Separator slot.
- `panToPart` / `panToNetIfOffscreen` helpers added in renderer; focus-zoom capped at 3× fit-to-board scale.

## v0.17.1 — 2026-05-04

### New

- **PixiJS `CullerPlugin` enabled.** Off-viewport pin labels and parts no longer pay GPU per frame; expect 5–20× p95 improvement at deep zoom on dense boards. Closes a long-deferred research item.
- **Opt-in WebGPU backend** (PixiJS will fall back to WebGL if unavailable). Off by default.
- **Tidier QuickSettings home dashboard** — Library stats and Cache actions hoisted above the keyboard-shortcut instructions.

### Fixed

- Part-hull polygon now generates a tighter axis-aligned chip-layout guard, fixing selection misses on small chip caps near component-clusters.

## v0.17.0 — 2026-05-03

### New: Cadence Allegro v15.x BRD support

A second Allegro parser family. v15.x (magic `0x0012XXXX`) is a different binary from the v16/v17 family already supported (`0x0013XXXX`) — different header, different block table — but many block payloads are shared. Reverse-engineered blind from a 15.5.7 / 15.5.2 corpus over the previous week:

- Component definitions (LL_0x06), footprints (LL_0x2B), placements (BLK_0x2D), refdes strings (BLK_0x07), nets (LL_0x1B), pad geometry (BLK_0x48), pin-net assignment (Route 5: BLK_0xC8 back-link + multi-layer variants).
- **99.4%** perfect net coverage on the 15.5.7 corpus, ~92.7% on 15.5.2 (variant-split documented).
- A per-component oracle correctness gate runs in CI to prevent regressions.

Spec: `docs/formats/ALLEGRO_V15_FORMAT.md`. Future-work items captured inline.

### Fixed

- **BDV `BRDOUT: 0 0 0` (zero outline) regression.** v0.17.0-development restored the max-part-Y mirror axis fallback for files that ship a zeroed BRDOUT (e.g. creator 1457685 / DAG3BEMBCD0 — HP 17-an100 Quanta G3BE). Canary regression test pins it.

## v0.16.15 — 2026-05-03

### Fixed

- **Library sync no longer re-downloads zero-byte files forever.** A long-tail of intentionally-empty files (placeholder schematics, `.gitkeep`-shaped markers) was bypassing the local-cache "skip if same size" check because zero-size compared as falsy in the diff path; we now treat 0 as a real size.

## v0.16.14 — 2026-05-03

### Fixed

- **Library sync errors are now surfaced in the UI** instead of silently logging. The Settings ▸ Library section shows the most recent sync's status (success/fail/in-progress) and the failing path; a "Retry" button re-runs the failed step.

## v0.16.13 — 2026-05-03

### Fixed

- **Library sync manifest parser preserves spaces in paths.** WebDAV PROPFIND responses with `<D:href>/Library/Apple iPhone 14/...</D:href>` were splitting on the space; sync skipped any board folder whose name contained a space. Fix: parse `<D:href>` as a single token, URL-decode after extraction.

## v0.16.12 — 2026-05-03

### Fixed

- **Library sync diff phase no longer blocks for hours.** The diff was doing a per-file HEAD on every remote candidate, which on a 60k-file mirror added minutes-to-hours before any actual transfer started. We now use the manifest's enclosed PROPFIND size+mtime as authoritative and reserve HEAD for tiebreakers.

## v0.16.11 — 2026-05-02

### New: library sync (WebDAV pull)

A scheduled background sync pulls a remote WebDAV-served library mirror into the local `/library/` mount. Settings ▸ Library exposes the endpoint, schedule, and a "Sync now" button. Diff-then-fetch semantics; per-file resume; never deletes remotely-missing files (Phase 1: pull-only). Useful for repair shops who keep an authoritative library on a NAS or office server and want every workstation to mirror it without manual copy.

### Performance

- **Net-line pulse skips when the page is hidden or the window is unfocused.** Browsers had been paying the 60 fps Graphics rebuild cost on background tabs; cutting it slashes the renderer's idle CPU.

## v0.16.10 — 2026-05-02

### New

- **Per-tab sidebar isolation.** Each BoardViewer panel tab now keeps its own sidebar selection, scroll position, and overlay-toolbar state. Switching tabs no longer wipes the Component Info pane in the other tab.
- **InfoTab OBData notes.** OBD readings (Diagnosis, Notes, Photos) now appear in the BoardSidebar InfoTab the same way they appear in the LibraryPanel's ObdSection.
- **TVW BOM-variant + ghost detection.** TVW boards now light up the Revisions tab — bbox-overlap clustering catches stacked-cap "alternate parts" that share refdes but differ in value. The per-pair swap button (added in v0.16.9 for Revisions) now applies to TVW too.

### Fixed

- **TVW empty Through layer** (Landrex variant on Gigabyte boards) no longer fails to load.
- **TVW pin-extension block** now fires on `partType=0x11` too — fixes broken pin geometry on the Gigabyte/Landrex variant.
- **Net search** can now expand a selected net into its component spoiler.

## v0.16.9 — 2026-05-01

### New

- **OBD structured DIAGNOSIS.** OpenBoardData diagnosis text is now parsed into collapsible sections with clickable refs (component refdes, net names) that select on the canvas. Multi-variant tables with comments displayed inline.

## v0.16.8 — 2026-05-01

### Fixed

- **PDF↔board lookup** — net-line drawing across the schematic, board-search mirror behaviour. Focus-zoom capped at 600% so opening a tiny test pad doesn't fly the viewport into pixel territory.

## v0.16.7 — 2026-05-01

### New: OpenBoardData (OBD) integration

BoardRipper now reads the public [OpenBoardData](https://openboarddata.org) corpus — community-maintained per-board diagnostics, pin readings, schematics, and notes — and surfaces it inline.

- **Backend:** `OBDATA_V002` parser, filesystem cache with atomic writes + `bpath` sandboxing, scraper with drop-guard, four HTTP handlers under `/api/obd/*` with single-flight, integration tests.
- **Frontend:** `obdStore`, `useObdForBoard` hook, Settings ▸ Library tab with disclaimer + "Sync OBD" button, `ObdSection` in LibraryPanel detail with a multi-variant table and visible comments. Canvas tooltip + Info pane surface readings on hover.
- **Disclosure:** OBD content is third-party; the disclaimer in the sync UI sets expectations clearly. Cache is bounded; sync is opt-in.

The aligned-with-real-format scraper fix in this release brought OBD live.

## v0.16.6 — 2026-04-30

### New

- **Local-LLM NAS classifier.** A second-pass classifier runs against the maintainer's NAS dump using a local LLM, filling Brand/Family/Board placeholders for the boards the heuristic + Tavily passes left in `Unsorted`. Round 1 imported **1024** new boards.
- **Family-hierarchy normalization** across all brands (so Apple `MacBook Pro` is one family, not three near-duplicates separated by capitalization).

## v0.16.5 — 2026-04-29

### New / Cleanup

- Tightened the file-extension whitelist used by the librarian's filename scanner — drops dead `.cae` and `.xzz` (the parser handles `.xzz`; the scanner doesn't).
- **Tavily classifier residue cleared.** From 1091 Unsorted → **170** Unsorted left.

## v0.16.4 — 2026-04-29

### New

- **Tavily search backend** wired into the offline classifier (`--search-backend tavily`). LLM classifier is now searchable in three modes: offline (heuristic only), DuckDuckGo, Tavily.
- boards.db curated from the v0.16.3 raw import down to **1091 Unsorted** (was ~2,800 after the filename-scan import).

## v0.16.3 — 2026-04-29

### New

- **`apple-boards.ts` retired** — the hardcoded Apple-board lookup is gone; `boards.db` is now the single source of truth.
- **Rescan re-resolves metadata.** Renaming a board in the DB no longer requires re-importing files.

## v0.16.2 — 2026-04-29

### Fixed

- **Auto-bind log spam** on `FOREIGN KEY constraint failed` (787) now bounded — previously one full line per failed pair hammered stdout and the writer mutex on a busy rescan after Reset All.

### Internal

- Release pipeline trimmed to Docker-only (legacy CI tarball path removed).

## v0.16.1 — 2026-04-29

### New

- **`boards.db` is now bundled inside the Docker image** at `/build/boards.db`. Fresh installs no longer need a side-channel DB download.
- Desktop builds (Electron Mac/Windows) paused for this release window.

## v0.16.0 — 2026-04-29

### New: boards.db 20× expansion (145 → 2,914 boards)

The board reference database expanded from 145 hand-curated entries to **2,914** via three import slices, all converging on the v2 schema:

1. **Wikidata Macs import (Slice 1).** SPARQL fetch of all Apple Mac models → staging file → apply with INSERT OR IGNORE under v2 placeholders. Family resolver auto-assigns `MacBook` / `iMac` / `Mac mini` / `Mac Pro` / `Mac Studio`.
2. **XZZ Apple-laptop skeleton import.** Replaces the Wikidata path with a filesystem walk of the maintainer's XZZ corpus — recovers boards Wikidata doesn't carry (Quanta / Compal / Foxconn ODM codes).
3. **Filename-scan importer (Slice 1).** A pattern battery walks `/library/`, cross-references existing boards, tokenizes unmatched substrings, and emits a Markdown observation report + JSON sidecar. The JSON sidecar feeds an importer that creates placeholder Brand/Family/Board entries with `INSERT OR IGNORE`. **2.8K new boards** added in one pass.

A snapshot of the 2026-04-29 observation report is archived under `docs/scan/archive/`.

### Internal

- All three importers landed via per-slice spec → plan → implementation, merged into main as separate feature branches (`feat/wikidata-macs-import`, `feat/filename-scan-observation`).

## v0.15.0 — 2026-04-28

### New: boards.db v2 schema redesign + Database Editor

The flat `boards` table is replaced by an **entity hierarchy**: Brand → Family → Board, with a color cascade and an explicit `family` field on each Board. The v2 resolver walks the hierarchy and returns the most specific colour/identity available; UUIDs are always freshly generated in the migration so old `BoardColorHex` values don't pin to retired entries.

- v2 migration script with full test coverage; step tracking + orphan-row defense; case-insensitive brand match; `FAMILY_PATTERNS` extended.
- `boards.db` rewritten on the v2 schema; `create_mockup_db.sql` rewritten; `build_full_db.sql` archived.
- **Database Editor panel** (Library tab) — read-only first slice. Lists Brands, Families, Boards in a tree view; clicking a Board surfaces its full row.

### Fixed

- **HomeBackdrop hides** when any Dockview panel is opened — previously it leaked through float-window seams.

---

## v0.14.0 and earlier

For releases prior to v0.15.0, see the git tags directly:
[`git log --oneline --tags`](https://github.com/AlexeyInwerp/BoardRipper/releases)
(maintainer-only access until the repo is open-sourced).
