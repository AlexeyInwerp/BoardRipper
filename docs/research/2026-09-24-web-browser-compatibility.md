# Web build: browser and iOS compatibility (2026-09-24)

Scope: the hosted web app (`ripperdoc.de/boardripper/web`, lite build) and the
NAS-served SPA — the same frontend bundle either way. Desktop gets a footnote.
Numbers come from `@mdn/browser-compat-data` 8.1.3 (2026-09-24), the installed
packages, and greps over `src/` and the built `dist-lite/` of v0.43.4. Safari
version = iOS version throughout; every browser on iOS is WebKit, so "Chrome on
iPad" sits in the same row as Safari.

## 1. Where the floor comes from

| Layer | Version | Floor it imposes | Why |
|---|---|---|---|
| Vite | 7.3.1 | **iOS 16.4** / Chrome 111 / Firefox 114 | `build.target` is unset, so it is Vite 7's default `baseline-widely-available`. esbuild lowers syntax only down to that; Lightning CSS likewise. **The default moves with each Vite major** — pin it. |
| Own code | — | iOS 16.4 | One regex lookbehind in `pdf-store.ts:790` is kept as a literal at that target and sits in the 2.8 MB main chunk: on iOS ≤ 16.3 the chunk fails to *parse* and the page stays blank. `structuredClone` (23 sites) needs 15.4; `OffscreenCanvas` for PDF thumbnails (`databank-store.ts:2074`, unguarded) 16.4; `color-mix()` on 73 theme tokens 16.2. Everything else is guarded (`BroadcastChannel`, `randomUUID`, clipboard, `requestIdleCallback`, `deviceMemory`, `GestureEvent`). |
| pixi.js | 8.17.0 | iOS 15 | Prefers WebGL2, falls back to WebGL1 (`GlContextSystem.createContext`), throws only when neither exists. `Object.hasOwn` (15.4), `Intl.Segmenter` (14.5), `createImageBitmap` (15). No usable "no WebGL" UI: `app.init` failure is only logged. |
| pixi-viewport 6 / dockview 5 / React 19 | — | ≤ iOS 13.4 | `ResizeObserver`, `queueMicrotask`, `PointerEvent`. Nothing above the others. |
| pdfjs-dist | 5.5.207 (2026-03-01; upstream is 6.3.289) | iOS 16.4 *with* the project's polyfills, iOS 18.2 without | See §3. Upstream's own statement for the current wiki: legacy build = Chrome 125+, Safari 18+; modern build = "latest browsers". |
| vite-plugin-pwa 1.3 (Workbox) | — | iOS 11.3 | Service worker, `prompt` register. |
| Folder library | — | iOS 18.4 for a folder, any version for single files | `<input webkitdirectory>` reached iOS in 18.4. `showDirectoryPicker`/`getAsFileSystemHandle`: never on WebKit (Chromium only). |
| HDR selection outline | — | iOS 16 (AVIF) | Opt-in; `dynamic-range-limit` (iOS 26) is set via `setProperty` and simply ignored earlier. |

**Effective floor today: iOS/iPadOS 16.4.** Verified for the syntax side by
re-transforming the built main chunk: at `safari16.4` esbuild leaves it
untouched; at `safari15.4` it rewrites the lookbehind to `new RegExp()` and
lowers the class fields, i.e. the *only* hard parse-time blocker below 16.4 is
that one regex.

## 2. Compatibility chart by iOS / iPadOS version

| iOS / iPadOS | Board viewer | PDF viewer | Folder library | Install (Home Screen) | Verdict | Devices whose last OS this is |
|---|---|---|---|---|---|---|
| **27** (released 2026-09-14) | ✓ | ✓ | ✓ | ✓ | Full | current A14/M1+ iPads, iPhone 11+ |
| **26.x** | ✓ | ✓ (`Math.sumPrecise` self-polyfilled by pdf.js below 26.2) | ✓ | ✓ | Full | iPad 8, mini 5, Air 3, Pro 11" (1st), Pro 12.9" (3rd) — dropped by 27 |
| **18.4–18.7** | ✓ | ✓ | ✓ (first version with `webkitdirectory`) | ✓ | Full | iPad 7, iPhone XS/XR |
| **18.0–18.3** | ✓ | ✓ (`Promise.try`, `toBase64` polyfilled; native from 18.2) | ✗ folder pick — single files only | ✓ | Works | — |
| **17.4–17.7** | ✓ | ✓ (`withResolvers`, `URL.parse`, `transferToFixedLength` polyfilled; `Float16Array` guarded by pdf.js) | ✗ | ✓ | Works | iPad 6, Pro 10.5"/12.9" (2nd) |
| **17.0–17.3** | ✓ | ✓ (same polyfills) | ✗ | ✓ | Works | — |
| **16.4–16.7** | ✓ | ✓ — nothing above 16.4 is unpolyfilled | ✗ | ✓ | Works in principle, **never run** — no such device or WebKit build in the test matrix | iPad 5, Pro 9.7"/12.9" (1st), iPhone 8/X |
| **16.2–16.3** | ✗ | ✗ | ✗ | — | **Blank page** (lookbehind SyntaxError in the main chunk) | — |
| **16.0–16.1** | ✗ | ✗ | ✗ | — | Blank page; also no `color-mix()` | — |
| **15.4–15.8** | ✗ | ✗ | ✗ | — | Blank page. Reachable at cost (§4 B) | iPad Air 2, iPad mini 4, iPhone 6s/7/SE 1 |
| **≤ 15.3** | ✗ | ✗ | ✗ | — | Not worth it (`structuredClone`, `BroadcastChannel`, `Object.hasOwn` all 15.4) | iPad mini 2/3, Air 1, iPhone 5s/6 |

Other browsers, for completeness: Chrome/Edge 111+, Firefox 114+ (Vite target;
pdf.js's ES2025 calls are polyfilled on both threads, so Chrome < 140 and
Firefox < 133 work). Firefox has no `showDirectoryPicker` and takes the
`webkitdirectory` input like Safari. Desktop Safari follows the iOS rows.

Install base (Apple App Store measurements, iPhone): Feb 2026 — 66 % on iOS 26,
24 % on 18, 10 % older; June 2026 — 79 % on 26. iPads lag iPhones and the
repair-bench iPad is often an older Pro, which is why the 17.x and 18.x rows
matter more here than the iPhone numbers suggest. Every iPad that can still
run 16.4 can run 16.7, so the only *hardware* locked out today is 2014–2016
(A8/A9-era) and anything a user deliberately left on 16.0–16.3.

## 3. The PDF engine (pdfjs-dist 5.5.207 + watermark patch)

**What it calls directly, and how each is covered:**

| API | iOS | Covered by |
|---|---|---|
| `Promise.withResolvers` | 17.4 | `src/polyfills.ts` (main) + patch (worker) |
| `Promise.try` | 18.2 | both |
| `URL.parse` | 18 | both |
| `ArrayBuffer.transferToFixedLength` | 17.4 | both |
| `Uint8Array.toBase64` / `fromBase64` | 18.2 | both |
| `Uint8Array.toHex`, `Map.getOrInsertComputed` | 18.2 / 26.2 | patch (worker only — main-thread build of 5.5 doesn't call them) |
| `Math.sumPrecise` | 26.2 | pdf.js 5.5 self-polyfills it |
| `Float16Array` (18.2), `ImageDecoder` (never on iOS), `OffscreenCanvas` | — | pdf.js feature-tests and falls back |
| `DecompressionStream` (16.4), `structuredClone` (15.4), `Array.at` (15.4), module `Worker` (15) | ≤ 16.4 | native at the floor |

So the PDF path holds at the same 16.4 floor as the rest — but only because of
seven hand-written shims. Every pdf.js bump adds to that list: **6.3.289** drops
the `sumPrecise` self-polyfill, calls `Map.getOrInsertComputed` on the main
thread (17 sites; iOS 26.2 native), and uses iterator helpers (`.take`/`.drop`,
iOS 18.4) and `Iterator.prototype.join` (in no shipping browser yet; it
self-polyfills that one). Unpolyfilled, 6.x would raise the PDF floor to
**iOS 26.2**. Upstream's `legacy/` build now ships core-js for exactly these
(its list: iterator helpers, `getOrInsert*`, `sumPrecise`, `Promise.try`,
`Uint8Array` base64/hex) but still assumes `withResolvers`, i.e. Safari 17.4+,
and is ~10 % larger.

**Two functional gaps found on the way, not iOS-specific — the second is a
production defect:**

1. **`wasmUrl` is never set.** pdf.js 5 decodes JPX (JPEG 2000) and JBIG2
   through OpenJPEG / jbig2 wasm and does ICC colour through qcms, all fetched
   from `wasmUrl`. Without it: `Ensure that the wasmUrl API parameter is
   provided` for JPX images (`DOMWasmFactory.fetch`), JBIG2 falls back to the
   JS decoder with a warning, ICC is skipped ("No ICC color space support").
   Scanned schematics are where JPX/JBIG2 turn up. 928 KB of `.wasm`, and the
   PWA `globPatterns` already list `wasm` — someone expected them to be there.
2. **`cMapUrl` / `standardFontDataUrl` are wrong in every production build.**
   `pdf-store.ts:66` derives them by stripping `build/pdf.worker.mjs` from the
   worker URL, but Vite emits the worker as `assets/pdf.worker-<hash>.mjs`, so
   the regex never matches and the built chunk (`dist-lite/assets/index-*.js`)
   literally computes `…/pdf.worker-C5C0d8od.mjscmaps/`. No `.bcmap` or
   standard-font file is copied into `dist`/`dist-lite` at all (0 found). It
   works under `vite dev` because there the URL really is
   `/node_modules/pdfjs-dist/build/pdf.worker.mjs`. Effect: any PDF that
   references a CMap (CJK / Identity-H vendor fonts, common in OEM schematics)
   loses that text — including for the watermark filter, which matches on
   reconstructed glyph strings — and standard-14 fonts rely on system-font
   fallback rather than the bundled ones.

## 4. Options, with costs

| # | Option | Cost | Gain | Recommendation |
|---|---|---|---|---|
| A | **Boot-time capability gate** in `index.html`: a small non-module (ES5) script that tests `structuredClone`, `OffscreenCanvas`, a lookbehind via `new RegExp`, and a WebGL context, and writes a one-paragraph "needs iOS 16.4 / Chrome 111 / Firefox 114" message instead of a blank page. | ~1 h; zero effect on supported browsers | Every locked-out user learns why, instead of a white screen. Also catches "WebGL disabled". | **Do it.** The blank page is the worst outcome in the chart. |
| B | **Pin `build.target`** explicitly (`['chrome111','firefox114','safari16.4','ios16.4']` or a tighter list). | 5 min | Freezes the floor so a Vite 8 default bump cannot silently move it to 17/18. | **Do it** with A. |
| C | **Fix §3.2 + §3.1**: copy `pdfjs-dist/{cmaps,standard_fonts,wasm}` into the bundle (a Vite copy step into `public/pdfjs/`, or `viteStaticCopy`) and build the three URLs from `import.meta.env.BASE_URL + 'pdfjs/…'`. | ~2 h + a JPX/CJK sample to verify; +~4 MB of static assets (~2.5 MB packed cmaps, ~1.7 MB fonts, 0.9 MB wasm). Precache bump for the lite PWA — keep cmaps/wasm out of `globPatterns` and let them fetch on demand. | CJK/vendor-CMap text and JPX/JBIG2 images render; watermark filter sees those glyphs. | **Do it.** This is broken today, independent of any browser. |
| D | **Lower the floor to iOS 15.4**: `build.target` → `safari15.4`; guard the `OffscreenCanvas` thumbnail with an `HTMLCanvasElement` fallback; `color-mix()` fallback for 15.4–16.1 (Lightning CSS cannot lower `var()`-based `color-mix`, so either an `@supports not (color: color-mix(in srgb, red, blue))` block with static colours, or compute the 73 derived tokens in `themeStore` JS — the latter is the honest fix since accent is user-picked). | ~1–2 days incl. finding a device; no iOS 15/16 device or WebKit build exists in the current test setup | iPad Air 2 / mini 4 / iPhone 6s-7 (2014–2016, 2 GB RAM, A8/A9) — small boards and PDFs, not large Allegro/TVW | Reasonable when a 15.x device is on the bench; sized in `docs/plans/2026-09-24-browser-compat-patch.md` phase 2. |
| E | **Verify 16.4–17.3 for real.** Nothing in CI runs an old WebKit: Playwright 1.58 ships current WebKit only, and the `webkit-ipad` project is the Mac port. Either an old Playwright `playwright-core` webkit build (≈ Safari 16.4-era engine, drivable by the existing specs) or a real-device minute on BrowserStack/LambdaTest. | ~half a day for the old-WebKit route; recurring $ for real devices | Turns "works in principle" into "tested" for the three rows the repair-bench iPads sit in | Worth one afternoon; the old-WebKit build also catches future API creep (see F). |
| F | **pdf.js upgrade policy.** Staying on 5.5 is free. Moving to 6.x costs the patch re-port (the five-site recipe in `patches/README.md`) plus 3–4 new shims (`getOrInsertComputed`, iterator helpers, `sumPrecise`, `toHex`) on both threads, or switching to the `legacy/` build (+10 % size, still needs `withResolvers`). Either way add a unit test that greps the installed `build/*.mjs` for the known ES2025+ names and fails when an unshimmed one appears. | 1 day per bump; the grep test ~1 h once | Upstream fixes; the test stops the floor drifting to 26.2 unnoticed | Stay on 5.5 until a concrete fix is needed; write the grep test now. |
| G | **Storage eviction hint.** Safari evicts all script-writable storage (IndexedDB board cache, folder-library index) after 7 days without a visit unless the site is installed to the Home Screen. `navigator.storage.persist()` is not honoured by WebKit, so the only mitigation is telling the user: one line in the folder-library empty state / chip on WebKit. | ~1 h | Fewer "my library vanished" reports on iPad | Cheap; do it alongside A. |
| H | **Live WebGL context cap.** WebKit limits live contexts (~16 per page in practice) and reclaims under memory pressure; each open board tab holds one. `webglcontextlost` → reinit already exists; releasing hidden tabs' renderers would avoid the loss in the first place. | ~1–2 days | Stability with many boards open on an 8 GB iPad | Only if the field reports it. |

Desktop footnote: Electron 35.7 (Chromium 134) and the Legacy build on
Electron 22 (Chromium 108, Catalina) — the ES2025 shims were written for the
latter and cover it; Chromium 108 is below Vite's `chrome111` target only in
name, since the emitted syntax is plain ES2022 that 108 already runs.

## Sources

- MDN browser-compat-data 8.1.3, 2026-09-24 (`javascript.builtins.*`, `api.*`, `css.*`).
- Vite build options — default `build.target` = `baseline-widely-available` = chrome111 / edge111 / firefox114 / safari16.4 / ios16.4: https://vite.dev/config/build-options.html
- pdf.js FAQ, supported browsers: https://github.com/mozilla/pdf.js/wiki/Frequently-Asked-Questions
- Apple iOS 26 adoption (Feb/Jun 2026): https://www.macrumors.com/2026/02/17/how-popular-is-ios-26/ , https://appleinsider.com/articles/26/06/10/fewer-iphone-users-are-updating-to-ios-26-than-they-did-with-ios-18
- iPadOS 27 device drop: https://www.macrumors.com/2026/06/08/ipados-27-drops-support-for-a-wave-of-ipads/
- iOS 27 / Safari 27 release 2026-09-14: https://www.macrumors.com/2026/09/09/apple-announces-ios-27-release-date/
