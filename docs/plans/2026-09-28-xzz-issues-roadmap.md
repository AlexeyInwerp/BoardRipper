# XZZ issues — roadmap for one update

Date: 2026-09-28. Baseline: `main` at 6e16bdb (v0.43.2 + touch work), `PARSER_VERSION` 93.

## Status (2026-10-04)

- **Step 2 (#37) landed** by cherry-pick (`8680270`..`5550d53`), plus `f48c611`: the JSON tail's part renames hid legacy readings on three files, and a purely numeric net alias is no longer applied. Local corpus (350 files): diode readings 73,753 → 144,707, no file loses one, part and pin counts unchanged, eight files change net names (GB2312 now decodes; XZZ's own net-rename table now reaches past 4 KB).
- **Step 4 (#38) parser side landed** (`7ce1f6d`, `fb563dd`): 17 tables on 11 files, 34 files with a net glossary. `0643f1e` makes both survive a board-cache hit.
- **#38 UI landed as the board sidebar's Notes tab** (`b4ad6de`), not in the Info tab: see `docs/specs/2026-09-29-board-knowledge-layer-review.md`. Tab shown only when a knowledge source has content.
- **Open:** step 1 / #36 (the translate crash is wider than the pin table: the History panel crashes too; under investigation), step 3 / #39 (test points).

## The issues, by importance

All four open issues come from @sjohnson1021, filed 2026-09-23, each with a
working branch on his fork. Two earlier XZZ issues from him (#27 part values,
#32 drill / oblong pads) already landed with credit in the code.

| Rank | Issue | Kind | Why this rank | Fix on fork |
|---|---|---|---|---|
| 1 | **#37** parser silently drops diode readings and part values | bug | Data loss with no error. Across 338 library files 8,833 BGA readings are dropped (iPhone14 `U1000`: 0 of 1,813 pins get a reading, should be 1,021), 32 files lose one of two diode encodings, and every Chinese or `Ω` part value is discarded. Diode readings are the reason these files are opened. Also carries the latent test-pad net-index bug that #39 depends on. | `feat/xzz-parser-fixes` (6 commits, +507/−89) |
| 2 | **#39** top-level test points aren't drawn, nets look incomplete | bug | Visible hole on the board (Black Shark3: 267 missing pads; iPadAir3: 538) and a net that shows only the BGA ball when the probe point is 0.3" away. Only on files that store test points as `0x09` records, not as TP parts. Needs the net-index fix from #37. | `feat/xzz-test-points` (1 commit on top of #37, +59/−6) |
| 3 | **#36** "Translate page" crashes the Board Viewer on pin select | bug | Whole panel replaced by "This panel crashed", any format. Only hits users with browser translation on, but those are exactly the users #38 is for. Two-line fix. | `feat/translate-safe-info-panel` (1 commit, +60/−1) |
| 4 | **#38** repair tables and net glossary on "Common problems" boards | enhancement | Nice-to-have by the reporter's own rating. 11 iPhone FAQ boards in the corpus draw a symptom/cause/fix table whose text we skip; XS Max carries 505 net descriptions. Largest change: new parser module, new `BoardData` fields, new Info-tab UI. | `feat/xzz-annotation-tables` (8 commits on top of #37, includes the #36 fix, +1,432/−93) |
| — | `XZZ_FORMAT.md` corrections | docs | Spec claims that the corpus contradicts (only part blocks are DES-encrypted, net names are not null-terminated, 1,978 test pads carry a drill). Rides along in every branch above. | `feat/xzz-spec-corrections` |

## What the merge check found

- All four branches fork from `81ea0b8` (v0.43.1), 38 commits behind `main`, and every one of them merges onto `main` **without conflicts** (`git merge-tree`).
- The two feature branches conflict **with each other** on exactly two files: `board-cache.ts` (both bump `PARSER_VERSION` from 97 to 98) and `XZZ_FORMAT.md` (two differently-hashed "limit the spec" commits). Trivial, resolved by hand at step 4.
- Unit tests on the fork (`xzz-testpad`, `xzz-text-decode`, `xzz-tail-annotations`, `annotation-tables`) use inline bytes, so they run in CI. The E2E spec `xzz-annotation-tables.spec.ts` expects `samples/XZZ PCB SAMPLES/iPhoneXSMAX/…`; on this machine the file is at `samples/XZZ PCB SAMPLES/nas-iphone/XZZ/Phones/iPhone/iPhoneXSMAX/FAQs/`. Fix the path or it skips silently.
- Local corpus: 350 `.pcb` files. Present: iPhone14_14Plus, iPhone13 (Diode value), iPhoneXSMAX Common problems and all 11 FAQ boards. The four acceptance files for #37-3, #39 and the naming question — Black Shark3, iPadAir3 820-01531, DJI PP00266604, Xbox 360 Trinity — were pulled from the NAS on 2026-09-28 into `samples/XZZ PCB SAMPLES/nas-issues/`.

## Roadmap

Landing method, decided 2026-09-29: **cherry-pick, not merge**, the way #27 and #32 were landed. `git fetch https://github.com/sjohnson1021/BoardRipper.git <branch>` then `git cherry-pick -x <sha>` one commit at a time, in stack order. `-x` records the origin hash in the message, authorship stays his, and every commit gets read and, where we disagree, amended before it lands. The parser commits are taken as they are (each has a failing-before test); the UI commits of #38 are re-implemented against the design below rather than picked. "Merge" in the steps means this.

Order follows the dependency stack, lowest risk first.

### Step 1 — #36 translate crash (½ h)
Merge `feat/translate-safe-info-panel`. The fix wraps the net name in `<span translate="no">`. Add the same guard wherever a bare text node gets a sibling inserted on state change: the Net List row and the search-result rows are the candidates, grep for `{pin.net}`-shaped children next to a conditional icon. `tests/page-translation.spec.ts` runs on the bundled `test-board.bvr`, so it always runs.

### Step 2 — #37 parser fixes (½ day, most of it verification)
Merge `feat/xzz-parser-fixes`. Four behaviour changes, each a commit with a failing-before test:
1. `parseTestPadBlock` reads the net index at `24 + nameLen + 32`, not the last 4 bytes.
2. Legacy diode regex accepts pad names (`N485(D9)`), not only digits.
3. Tail with both encodings: legacy records always read, JSON located by its `===PCB` banner and bounded by the next `\n===` section.
4. `decodeXzzText`: strict UTF-8 kept only when its non-ASCII characters are plausible for these files, else GB18030.

Verification before trusting it, because names feed net identity on XZZ and the board-pack code keys on names:
- Corpus script over all 350 local files, before/after: per file, diode reading count, part-with-value count, net count, part count. Readings and values may only go up; net and part counts must not change. The 78 trace-carrying pack files must still fold identically (`xzz-*` E2E specs).
- Spot checks named in the issue: iPhone14 `U1000` 0 → 1,021; iPhone13 Diode-value tail (62 KB of legacy records before the JSON).
- Black Shark3, DJI, iPadAir3 (in `nas-issues/`) for #37-2/#37-3: `N138` 0 → 47; DJI parts with a value 282 → 574.
- Risk to watch: a net name that was `U+FFFD`-garbled before and is Chinese now no longer collides with other garbled names. That is the intended fix, but any file whose net count changes needs a look.

### Step 3 — #39 test points (½ day)
Merge `feat/xzz-test-points`. Each `0x09` record becomes a one-pin part `TP<padnumber>` with the pad's real size, shape and drill; nails are still built for the status bar; the legacy fold path (`findFoldAxis`) now mirrors test points onto the bottom side and sets `side`. No renderer change.

Decisions to make here:
- **Naming.** Pad numbers repeat (Xbox 360 Trinity: 455 of 497 records are "1" → `TP1`, `TP1-2` … `TP1-455`). Recommendation: keep `TP<n>` with the `-k` suffix. A net-based name reads better on Xbox but repeats just as badly on GND and would make the part name depend on the net-rename table.
- **Other formats' nails** (BRD/BDV/FZ) stay undrawn. Same treatment is a follow-up, not this update.

Verification: iPadAir3 538 appear, 530 with a net, 8 `NC`. Status bar `Parts` grows by the nail count, that is expected. Check a 2008–2015 touching-halves MacBook file (the `splitSymmetricLoop` path) since test points now take a side there for the first time, and one iPhone pack (test points get `boardIndex` and must land on the right board in "Show all sides").

### Step 4 — #38 annotation tables + glossary (1 day)
Merge `feat/xzz-annotation-tables`. Resolve the two conflicts against step 3 (`PARSER_VERSION`: one bump per release is enough, `93 → 94`, keep Sean's per-change notes in the comment block; `XZZ_FORMAT.md`: take the annotation branch's file, re-apply the test-point drill sentence). Its #36 commit is identical to step 1's and merges clean.

What it adds: top-level `0x06` text records read (`BoardText`); `parsers/annotation-tables.ts` rebuilds tables from label positions (Otsu row split, 1,500 mil column split, flowchart rejection; verified 17 tables on 11 boards, 0 on the 2 flowcharts); `===信号` glossary into `BoardData.netDescriptions`; `AnnotationTables.tsx` in the Info tab as HTML so the browser's translator works, with `lang="zh-CN"` on prose and `translate="no"` on identifiers; net description under the net name in the pin table.

The parser side (`0x06` records, `annotation-tables.ts`, the glossary, the two new `BoardData` fields) is cherry-picked. The UI side is built here; his `AnnotationTables.tsx` and the pin-table description line are the reference, not the code that lands. **Decided 2026-09-29: the UI is not XZZ-shaped.** The tables and glossary go through a source-tagged board-knowledge layer in the OBD data shape and render via the existing `DiagnosisNotes` / pin-table / tooltip paths, so the same surface later takes OBD, local and wiki notes. Review and rationale: `docs/specs/2026-09-29-board-knowledge-layer-review.md`. The placement and markup rules below still hold, they describe that surface.

- **Cache.** `annotations` and `netDescriptions` (a `Map`) must survive the IndexedDB round-trip; his `board-cache.ts` diff touches the serialiser, confirm both fields come back on a cache hit.

Verification: XS Max Common problems gives one 7×3 table captioned 通病 and 505 descriptions, 420 on nets the board has. Fix the E2E sample path (see above). Open two FAQ boards side by side to catch a state leak between tabs.

#### Design: where the Chinese notes go

Three kinds of vendor text come out of these files, and they are shown in three different places because they are read at three different moments.

1. **Repair tables and loose notes** (board-level: symptom / fault point / fix, plus legend and flowchart text). These are the same kind of thing as the OBD DIAGNOSIS notes, which the Info tab already renders board-level, whether or not a part is selected (`obdNotes` in `ComponentInfoBody`, both return branches). The XZZ notes go in the same slot, as one `<details>` block per file in the `DiagnosisNotes` style, titled **Board notes** with the table count, open by default in the empty state and collapsed once a part is selected, so a big table does not push the pin list off screen. Each table is a real `<table>` with the file's header row; part and net names inside cells are `PartChip` / `NetChip` (he exported both for this), so a row's fault point is one click from the board. The loose notes follow the tables as a plain list. **Not** on the board itself in this release: drawing the text in place through the label overlay is faithful but untranslatable, and the ruled grid already shows where the table sits; in-place text is a follow-up once the sidebar version has been used.

2. **Net descriptions** (per net: `PP_VDD_BOOST = 升压供电`). Shown wherever a net name is already shown, as a muted second line under the name, never in place of it: the pin table in the Info tab (his `pin-net-desc`), the Net List row, and the canvas tooltip when a pin is hovered (the tooltip already carries a second line for OBD readings and the compare result, same slot). The Info tab's net-branch header gets it too. No new panel; a glossary list nobody scrolls is not a UI.

3. **Part values** in Chinese (#37-3, e.g. `力特自恢复保险丝…`). Already have a home, the Info pane's value field. Nothing to design; they only need the language mark below.

Markup rules that make the browser's translator work, and the reason the notes are HTML at all:
- Prose carries `lang="zh-CN"` (the translator's language detection is per element, and short cells detect badly without it). Nothing in the app declares a language today.
- Identifiers carry `translate="no"`: part names, net names, pin names, board numbers, file names. A translated net name no longer matches the board.
- Every text node that can gain or lose a sibling on re-render sits in its own element. That is the #36 rule; see the release gate below.

#### Release gate: page translation must not crash anything

#38 puts Chinese prose in front of users whose next move is "Translate page", so #36's fix alone is not enough; the whole app has to survive the translator, which replaces text nodes with `<font>` wrappers and leaves React holding stale references. Before v0.44.0 ships:
- Extend `tests/page-translation.spec.ts` into a harness: apply the translator's DOM mutation, then drive selection changes in every panel that renders board text: Info tab (with an XZZ FAQ board loaded, so the notes are present), Net List, Search Results, Library (OBD notes), Worklist. Any `NotFoundError` fails the run.
- Audit for the pattern by hand: a bare `{name}` child next to a conditional `{cond && <Icon/>}` sibling. The pin-table net cell was one; expect a handful more.
- `PanelErrorBoundary` already offers a reset button. Keep it as the last line of defence, not as the fix.
- Chrome and Edge are the confirmed translators; assume Safari's does the same to the DOM and test it on the iPad, since that is where the FAQ boards get read.

### Step 5 — docs, notes, release (½ day)
- `XZZ_FORMAT.md` lands with the stack. Update the XZZ entry in `CLAUDE.md`: GB18030 decode rule, both-encodings tail, `0x09` → TP parts, `0x06` text + tables, glossary.
- Rename-safe cache: one `PARSER_VERSION` bump with a combined note.
- Close #36, #37, #38, #39 from the release notes; credit @sjohnson1021 in each.
- Version: new UI surface + new `BoardData` fields is a second-digit release with desktop, **v0.44.0**. Pre-flight the tree on rd-nas:1234 via `scripts/devdeploy.sh --head` before `release.sh`, per the usual rule.

## How the contributor's fork syncs afterwards

Nothing on his side has to be rebased onto us. A fork syncs one way: after the release he pulls our `main` into his (GitHub's "Sync fork" button, or `git pull upstream main`).

Because we cherry-pick, his commits land under new hashes and his feature branches end up diverging from `main` by commits whose *content* is already upstream. Two clean ways out for him, both routine:
- `git rebase upstream/main` on a branch drops every commit whose patch already applies (git compares patch ids) and leaves at most the ones we amended, which he then discards.
- Or simply delete the four branches and reset his `main` to upstream. The `-x` lines in our commit messages point back at his originals, so the provenance is on record either way.

His next piece of work starts from a fresh branch off the synced `main`. Tell him this in the closing comment on each issue, with the landing commit hashes, so he does not try to rebase our changes onto his stale branches.

## Effort

About three working days end to end, of which merging is under half a day. The rest is the corpus verification in step 2 and the two UI decisions in steps 3 and 4. Nothing here needs new reverse engineering; the reporter measured every number above on the library.
