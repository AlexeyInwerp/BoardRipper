# Browser compatibility patch — plan (2026-09-24)

Companion to `docs/research/2026-09-24-web-browser-compatibility.md`, which has
the evidence. This is the work, sized. Web build only (lite + NAS SPA); the
desktop app is untouched except where it shares the bundle.

Three phases. 0 and 1 are cheap and independent of any iOS decision. 2 is the
iPadOS 15 floor; it is a day or two of code plus a test device, and it is
worth doing only with that device on the bench.

## Phase 0 — stop the blank page, freeze the floor (½ day)

1. **Pin `build.target`** in `vite.config.ts`:
   `['chrome111', 'edge111', 'firefox114', 'safari16.4', 'ios16.4']` — exactly
   what Vite 7's `baseline-widely-available` resolves to today. Vite 8 will move
   that default; a pinned list means a Vite bump cannot raise the floor without
   a diff in this file. 5 minutes.
2. **Boot gate** in `index.html`: a classic (non-module) inline script *before*
   the module tag. Non-module scripts run on every engine; a module chunk that
   fails to parse never runs anything. It tests the four things that decide
   whether the bundle can start — `structuredClone`, `OffscreenCanvas`, a
   lookbehind via `new RegExp('(?<=a)b')` in a `try`, and
   `canvas.getContext('webgl2') || getContext('webgl')` — and on failure writes a
   plain paragraph into `#root`: which check failed, the minimum versions, the
   Discord and GitHub links. It must stay ES5 (`var`, no arrow functions, no
   template strings). The lite build and the NAS SPA share `index.html`, the
   offline single-file build inlines it, so all three get it. ~1 h.
3. **Test**: `tests/boot-gate.spec.ts` — an init script deletes
   `window.structuredClone` before navigation and asserts the message is shown
   and `/assets/index-*.js` is never requested; a second case deletes nothing
   and asserts the message is absent. ~1 h.
4. **pdf.js API-creep test** (unit, `src/pdf/pdfjs-floor.test.ts`): read the
   installed `node_modules/pdfjs-dist/build/pdf.mjs` and `pdf.worker.mjs`, grep
   for a list of ES2025+ names (`withResolvers`, `Promise.try`, `URL.parse`,
   `transferToFixedLength`, `toBase64`, `fromBase64`, `toHex`,
   `getOrInsertComputed`, `sumPrecise`, `Float16Array`, `Iterator.`, `.take(`,
   `.drop(`), and for each hit require either a `typeof … !== "function"` guard
   in the same file or an entry in `src/polyfills.ts` + the worker patch. A
   pdfjs-dist bump then fails the unit run instead of an iPad in the field.
   ~1 h.

## Phase 1 — pdf.js assets that never reach production (½ day)

Not a browser matter, but found on the way and cheaper than explaining it twice.

1. `pdf-store.ts:66` derives `cMapUrl` / `standardFontDataUrl` by stripping
   `build/pdf.worker.mjs` from the worker URL. Vite emits the worker as
   `assets/pdf.worker-<hash>.mjs`, the regex never matches, and the built chunk
   requests `…/pdf.worker-<hash>.mjscmaps/`. Nothing from `cmaps/`,
   `standard_fonts/` or `wasm/` is copied into `dist*` at all.
2. Fix: a tiny Vite plugin (or `vite-plugin-static-copy`) that copies
   `node_modules/pdfjs-dist/{cmaps,standard_fonts,wasm}` to `dist*/pdfjs/`, and
   `pdf-store.ts` builds the three URLs from `import.meta.env.BASE_URL + 'pdfjs/'`.
   Add `wasmUrl` to `_getDocOpts` — that switches on OpenJPEG (JPX images),
   the jbig2 wasm decoder and qcms (ICC colour), which today either throw
   (`Ensure that the wasmUrl API parameter is provided`) or fall back with a
   warning.
3. Size: ~2.5 MB packed cmaps + ~1.7 MB fonts + 0.9 MB wasm. Keep them **out**
   of the PWA `globPatterns` (they are fetched on demand, rarely) so the lite
   precache does not grow by 5 MB; the offline single-file build cannot inline
   them and keeps today's behaviour (document that).
4. Verify with one CJK-font PDF and one JPX-image scan; both types exist in
   the OEM schematic corpus on the NAS. Existing `pdf-*.spec.ts` stay green.

## Phase 2 — iPadOS 15.4 floor (1–2 days + a device)

**Who gains:** iPad Air 2 (A8X, 2 GB), iPad mini 4 (A8, 2 GB), iPhone 7 / 6s /
SE 1 — all end at 15.8. Nothing is stuck between 15.8 and 16.4, and 15.4 is the
first version with `structuredClone`, `BroadcastChannel`, `Object.hasOwn`,
`Array.at`, `:focus-visible`, `contain`, so **15.4 is the natural floor**;
15.0–15.3 would add two shims for users who can simply update. Below 15:
no `Intl.Segmenter` (pixi), no WebGL2 (pixi falls back to WebGL1, untested),
`WeakRef` 14.5 — not worth it.

**What actually stands between 16.4 and 15.4** (from the research doc, verified
by re-transforming the built chunk with esbuild at `safari15.4`):

| Blocker | Where | Fix | Effort |
|---|---|---|---|
| Regex lookbehind literal → SyntaxError parsing the main chunk | `pdf-store.ts:790` (`/(?<=\w) (?=\w)/g`) | Rewrite without lookbehind (`replace(/(\w) (?=\w)/g, '$1')`). Lowering the target alone only turns it into a runtime `new RegExp()` that throws when the line runs. | 10 min |
| Class fields / static blocks / `#x in` | our code, pixi, pdf.mjs | `build.target` → `['chrome111','edge111','firefox114','safari15.4','ios15.4']`; esbuild lowers them. The worker asset is already minified at `es2020`. | 5 min |
| `color-mix()` (iOS 16.2) | `index.css`: 17 token definitions + 56 inline uses | Lightning CSS cannot lower `color-mix` over `var()`. Move every mix into `themes.ts` `applyTheme`, which already computes `--bg-secondary`/`--border` in JS with `shadeToward` and writes them with `setProperty`: add a `mix(a, b, pct)` over hex, derive ~20 tokens (`--accent-hover`, `--scrim`, `--accent-10`, `--accent-20`, `--border-55`, …) once per theme change, and replace the 56 inline `color-mix(...)` with those tokens. Removes the dependency instead of guarding it, and makes the palette one place. | ½ day |
| `OffscreenCanvas` (16.4) | `databank-store.ts:2074` PDF thumbnail (NAS build only, `hasBackend()`) | `typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w,h) : Object.assign(document.createElement('canvas'), {width:w, height:h})`, and `convertToBlob` → `toBlob` on the fallback. | 15 min |
| `DecompressionStream` (16.4) | pdf.js worker, brotli/deflate fast path | Already in a `try` with the JS `FlateStream` fallback (`asyncGetBytes`). Nothing to do; note it in the floor test. | — |
| `scrollbar-width` (18.2), `overscroll-behavior` (16 partial), `accent-color` | cosmetic | Already have `::-webkit-scrollbar` fallbacks; leave. | — |

**Not in scope, by design:** folder library on 15.x (no `webkitdirectory`
until 18.4 — single files only, same as 16.4–18.3); memory. A 2 GB iPad gives a
Safari tab roughly 1–1.4 GB before jetsam; a 300 MB Allegro parse or a 39k-trace
TVW board will not fit, and that is a hardware statement the support page makes.
BRD/BVR/BDV/FZ/XZZ boards (a few MB) and the PDF `medium` preset (already the
touch default, with halved caches when `deviceMemory` is missing) are the
realistic use.

**Testing — this is the actual cost:**

1. Old WebKit through Playwright. Playwright 1.20 (March 2022) shipped WebKit
   ≈ Safari 15.4, 1.32 (March 2023) ≈ 16.4. In a scratch dir:
   `npx -p playwright@1.20.2 playwright install webkit`, then point a copy of
   `playwright.config.ts` (`webkit-ipad` project) at the dev server. The old Mac
   build may refuse to launch on a current macOS (frameworks moved); budget one
   hour to find out. If it runs, the existing `pdf-touch`, `touch-pinch-zoom`
   and a board-open smoke give real coverage of the API floor.
2. A device. A used iPad Air 2 or mini 4 is €40–60 and is *the* 15.8 ceiling
   device; it is also the only way to see the memory behaviour. Point it at
   `rd-nas:1234` through `scripts/devdeploy.sh` like the current iPad.
3. Add `ios15.4` to the floor test's expectations and a `tests/boot-gate.spec.ts`
   case that the gate now *passes* with `OffscreenCanvas` absent.

**Decision rule:** do phase 2 when a 15.x device is on the bench or someone
asks on Discord with a device in hand. Without either, phases 0 and 1 already
turn the blank page into a sentence and fix the PDF assets, and the support
page says "iPadOS 15: doable on request", which is true.

## Order and totals

| Phase | Effort | Ships with |
|---|---|---|
| 0 — pin target, boot gate, floor test | ½ day | next patch release |
| 1 — pdf.js assets | ½ day | same release (it changes the bundle layout; do it before the lite deploy) |
| 2 — 15.4 floor | 1–2 days + device | its own minor release; support page row flips from "blank page" to "works" for Air 2 / mini 4 |
