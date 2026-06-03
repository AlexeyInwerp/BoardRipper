# `patches/` — vendored modifications to npm dependencies

This folder contains diffs produced by [`patch-package`](https://github.com/ds300/patch-package).
Each `.patch` file is named `<package>+<version>.patch`. The diffs are
applied automatically after every `npm install` / `npm ci` by the
`postinstall` script wired into [`../package.json`](../package.json):

```json
"scripts": {
  "postinstall": "patch-package"
}
```

Do **not** edit files in `node_modules/<package>/` and expect those edits
to survive — they live entirely inside `.gitignore`'d territory. The diff
in this folder is the source of truth.

---

## Active patches

### `pdfjs-dist+5.5.207.patch` — parse-time watermark filter

**Why we patch:** BoardRipper hides repair-site watermarks
(`www.chinafix.com`, `Vinafix`, etc.) in viewed schematics. Some donor PDFs
ship 5 000+ watermark glyph runs per page. Filtering them via pdf.js's
public `operationsFilter` callback works only post-parse — the worker
still tokenises every watermark op, streams it to the main thread, and
allocates it into the operator list. That kills FPS on heavy pages.

The patch teaches the worker to drop the watermark `showText` ops at parse
time, before they enter the operator stream. Net effect:

- No client-side filter callbacks (was one call per op, ~2k–10k per page)
- Operator list never carries watermark ops → fewer allocations, smaller
  intentState memory, smaller chunks across the postMessage boundary
- Click-test path in `panels/PdfViewerPanel.tsx` (which reads textPages
  directly and runs `isPdfWatermarkText`) is unaffected — watermark text
  remains *unselectable* but the glyphs are gone

**Six edits across two files:**

| File | Site | What changes |
|---|---|---|
| `build/pdf.mjs` | `PDFPageProxy.render(...)` | Accept a `watermarkFilter: string[] \| null` option and attach it to `intentArgs` before `_pumpOperatorList` runs. |
| `build/pdf.mjs` | `_pumpOperatorList(...)` | Forward `watermarkFilter` in the `GetOperatorList` worker message. |
| `build/pdf.worker.mjs` | top of file | Worker-context shims for `Uint8Array.prototype.toHex` and `Map.prototype.getOrInsertComputed`. pdf.js 5.5 calls both directly (`fingerprints` getter, font caches, AcroForm, XFA — 6 call sites total). Main-thread polyfills in `pdf-store.ts` don't cross the Worker boundary, so older Chromium/Firefox/Safari and legacy Electron forks crash with `hashOriginal.toHex is not a function` on PDF open. Idempotent (`typeof !== 'function'` guard) so we don't shadow native impls on Chrome 136+. |
| `build/pdf.worker.mjs` | `handler.on("GetOperatorList", ...)` | Read `data.watermarkFilter` and pass it into `page.getOperatorList(...)`. |
| `build/pdf.worker.mjs` | `Page.prototype.getOperatorList(...)` | Forward `watermarkFilter` into the `PartialEvaluator.getOperatorList(...)` call. |
| `build/pdf.worker.mjs` | `PartialEvaluator.prototype.getOperatorList(...)` | Accept `watermarkFilter`, stash it on `this`, and right before `operatorList.addOp(fn, args)` check whether `fn === OPS.showText` and the reconstructed glyph string substring-matches any term. If so, `continue` instead of emitting the op. |

**Matching rule (must stay in lock-step with `src/store/render-settings.ts`'s `normalizeForWatermark`):** **NFKC-normalise**, strip whitespace, lowercase, substring-match. NFKC matters: many vendor watermark fonts emit Latin ligatures like `ﬁ` (U+FB01) instead of two characters `fi`. Without NFKC, `"Vinaﬁx.com"` never substring-matches the user's `"Vinafix"` term. The click-test path and the worker filter must apply identical normalisation or the two diverge on these PDFs — `820-01700.pdf` is a real specimen.

**Four non-obvious traps the patch had to get right:**

- **`self` vs `this` in the showText branch.** The big switch sits inside `new Promise(function promiseBody(resolve, reject) { … })` — a regular function, so `this` is `undefined` in strict-mode module scope. The patch must read `self.watermarkFilter` (where `const self = this` is captured at the top of `getOperatorList`). Reading `this.watermarkFilter` instead throws `TypeError: Cannot read properties of undefined (reading 'watermarkFilter')` — pdf.js's `ignoreErrors` catch then silently drops the whole operator list, which manifests to the user as "no text renders at all".
- **`showSpacedText` glyph arrays interleave numeric kerning entries.** `args[0]` after `handleText` looks like `[Glyph, 17.6, Glyph, Glyph, -50, Glyph, …]`. Skip non-objects (or objects without a `.unicode` property) when reconstructing the string.
- **Many PDFs emit one `showText` per glyph for sub-pixel positioning.** A `"Gigabyte Confidential Do not Copy"` watermark can be 30+ separate showText ops, each with a single-character glyph array. Per-op substring matching never sees the whole word. The patch tracks every `showText`'s `args` reference (and the accumulated glyph string) between `OPS.beginText` and `OPS.endText` but **lets every op flow through `addOp` in source order**. At ET, if any filter term matches the accumulated string, the patch retroactively sets each tracked showText's `args[0] = []`, so the op still executes (state advances correctly) but draws nothing. We tried buffering whole BT…ET blocks and emitting them as a batch at ET — that broke rendering on PDFs where state-changing ops (`setFont`) are async-emitted directly by `handleSetFont` and would land before our buffered BT in the operator list, throwing pdf.js's renderer out of order. The in-place-zap approach has no reorder problem because nothing waits on a buffer.
- **NFKC ligature normalisation.** Vendor watermark fonts emit `ﬁ` (U+FB01) instead of `f` + `i`. Without `.normalize("NFKC")` `"Vinaﬁx.com"` never substring-matches `"Vinafix"`.

**Why we use the unminified worker.** `src/store/pdf-store.ts` imports
`pdfjs-dist/build/pdf.worker.mjs` (not `.min.mjs`) because the patch
targets readable source. Vite still minifies the worker chunk for prod,
so there's no runtime cost.

---

## Updating the patch when pdf.js is upgraded

The diff is anchored to specific source structure in 5.5.207. Any pdf.js
version bump will almost certainly need the patch re-ported.

### When you bump `pdfjs-dist`

1. Bump the version in [`../package.json`](../package.json) and run `npm install`.
2. `npm install` will fail loudly when `patch-package` can't apply the
   old diff — that's the intended early-warning system. Example failure:

   ```
   ERROR Failed to apply patch for package pdfjs-dist at path
     node_modules/pdfjs-dist
       This error was caused because patch-package cannot apply the
       following patch file:
         patches/pdfjs-dist+5.5.207.patch
   ```

3. Delete the now-stale patch file:
   ```bash
   rm src/frontend/patches/pdfjs-dist+5.5.207.patch
   ```

4. Re-port each of the five edits. The reference locations in 5.5.207:

   | Site | Approximate line in 5.5.207 | What to look for |
   |---|---|---|
   | `pdf.mjs::render` destructure | ~14867 | `operationsFilter = null` — add `watermarkFilter = null` next to it |
   | `pdf.mjs::render` intentArgs | ~14870 | line after `getRenderingIntent(...)` — append `intentArgs.watermarkFilter = watermarkFilter;` |
   | `pdf.mjs::_pumpOperatorList` | ~15108 | destructure `modifiedIds` from arg; also the `sendWithStream("GetOperatorList", { ... })` body |
   | `pdf.worker.mjs::handler.on("GetOperatorList")` | ~62941 | the `page.getOperatorList({...})` call inside |
   | `pdf.worker.mjs::Page.getOperatorList` | ~58730 | destructured options + the `partialEvaluator.getOperatorList(...)` call below |
   | `pdf.worker.mjs::PartialEvaluator.getOperatorList` destructure | ~35472 | add `watermarkFilter = null` and assign to `this.watermarkFilter` |
   | `pdf.worker.mjs::PartialEvaluator.getOperatorList` filter check | ~35981 | the `operatorList.addOp(fn, args)` call near the end of the big switch — guard it with the watermark check |

   The existing patch file in this folder reads as a recipe. Use it as a
   reference for the exact text to insert; the locations move but the
   logic doesn't.

5. **Verify in two places.** The worker normalises `showSpacedText`,
   `nextLineShowText`, and `nextLineSetSpacingShowText` into plain
   `OPS.showText` with glyph arrays before the final `addOp`. As long as
   that conversion still happens upstream of our `addOp` check, one
   guard covers all four input opcodes. If pdf.js refactors the
   conversion to a different point, the check must move with it.

6. Re-save the diff:
   ```bash
   cd src/frontend
   npx patch-package pdfjs-dist
   ```
   This writes `patches/pdfjs-dist+<new-version>.patch`. Commit it along
   with the `package.json` / `package-lock.json` bump.

7. Smoke-test:
   - Open `samples/820-00165/820-00165.pdf` (chinafix watermark).
   - Toggle the wand in the toolbar. The watermark text should disappear
     **and** become unselectable.
   - Open the DevTools console. There should be **no** `[wmFilter]` log
     lines — the old client-side filter is gone. There should be no
     `Cannot read properties of undefined` errors from inside pdf.js.
   - Run `npm run test` — the Playwright PDF specs cover page
     transitions and search, both of which exercise the operator-list
     path.

### When the patch refuses to apply but pdf.js wasn't bumped

Means someone edited `node_modules/pdfjs-dist/` by hand and made the
upstream diverge from the clean baseline. Run `rm -rf
node_modules/pdfjs-dist && npm install` to re-fetch the clean copy, then
the patch should apply again.

### Sanity-check that the patch is active at runtime

The simplest way: the watermark wand visibly hides text **and** the
DevTools `Performance` flamegraph on a heavy-watermark PDF shows no
`paintChar` time for the watermark glyphs (because they aren't in the
operator list at all, the painter never sees them).

A faster check during development — add `console.warn` at the top of the
patch's filter branch in `pdf.worker.mjs` and look for it in the DevTools
console. Just remember to remove the warn before saving the patch.

---

## Adding new patches

```bash
# Edit node_modules/<package>/<file> however you need.
cd src/frontend
npx patch-package <package>
git add patches/<package>+<version>.patch
```

Add a section to this README describing **why** the patch exists and
**which call sites** it touches, so the next person upgrading that
package doesn't have to reverse-engineer the diff.

## Removing a patch

```bash
rm src/frontend/patches/<package>+<version>.patch
# Then delete the corresponding section from this README.
# Run `npm install` to re-fetch a clean copy of the package.
```
