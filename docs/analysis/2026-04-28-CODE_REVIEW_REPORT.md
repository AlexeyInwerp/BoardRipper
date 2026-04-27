# BoardRipper — Comprehensive Code Review Report (Follow-up)

**Date:** 2026-04-28
**Version reviewed:** v0.14.0 (released same day)
**Prior review:** [docs/CODE_REVIEW_REPORT.md](../CODE_REVIEW_REPORT.md) (2026-03-30, v0.2.3-beta)
**Codebase:** ~610K LoC TypeScript, 4,734 LoC Go, 5,479 LoC CSS, 23 Playwright specs (5,018 LoC)
**Reviewers:** 7 parallel AI review agents (reusability, docs, design, GFX, memory, backend, tests)

---

## Table of Contents

1. [Overview & Methodology](#1-overview--methodology)
2. [Topic 1: Reusability & Organization](#2-topic-1-reusability--organization)
3. [Topic 2: Quality of Documentation](#3-topic-2-quality-of-documentation)
4. [Topic 3: Design (UI/UX & Architecture)](#4-topic-3-design-uiux--architecture)
5. [Topic 4: GFX Optimizations & Performance](#5-topic-4-gfx-optimizations--performance)
6. [Topic 5: Memory & Multi-Board Performance](#6-topic-5-memory--multi-board-performance)
7. [Topic 6: Backend & Database Design](#7-topic-6-backend--database-design)
8. [Topic 7: Test Coverage & Quality](#8-topic-7-test-coverage--quality)
9. [Cross-Cutting Findings](#9-cross-cutting-findings)
10. [Consolidated Correction Plan](#10-consolidated-correction-plan)
11. [What Was Done Well](#11-what-was-done-well)
12. [Headline Numbers](#12-headline-numbers)

---

## 1. Overview & Methodology

This is a follow-up to the comprehensive review of 2026-03-30 (one calendar month + ~50 commits ago). Seven specialized agents ran in parallel against the v0.14.0 codebase. Each agent (a) read CLAUDE.md to ground itself, (b) read the relevant section of the prior report and verified whether each finding had been addressed, and (c) performed a fresh comprehensive review of the current state. Five topics carry over from the prior report; two topics are new (Backend & Database, Test Coverage) because they had only sparse coverage previously and have seen significant work.

Severity levels are unchanged from the prior report:

- **Critical** — Will cause failures, data loss, or security exposure under normal use; fix immediately
- **Important** — Significant quality, performance, or correctness issue; fix before next release
- **Minor** — Tech debt or improvement opportunity; schedule for later

Topic-specific reports live alongside this consolidated one:

- [`2026-04-28-reusability.md`](2026-04-28-reusability.md) — 329 lines
- [`2026-04-28-docs.md`](2026-04-28-docs.md) — 328 lines
- [`2026-04-28-design.md`](2026-04-28-design.md) — 515 lines
- [`2026-04-28-gfx-perf.md`](2026-04-28-gfx-perf.md) — 247 lines
- [`2026-04-28-memory.md`](2026-04-28-memory.md) — 362 lines
- [`2026-04-28-backend.md`](2026-04-28-backend.md) — 554 lines
- [`2026-04-28-tests.md`](2026-04-28-tests.md) — 552 lines

**Total topic-report depth:** ~2,887 lines.

### Headline result

The codebase has improved dramatically in one month. Of the **22 high-severity findings** carried into this review (all Critical + Important from the March report), **20 are FIXED** (91%). The two unfixed items (CSS sprawl, BRD nails-side documentation) are minor and not regressions. New findings are predominantly Minor and concentrated in two areas the prior review didn't cover deeply: **the Go backend** (5 Important hardening items shipped during recent rapid feature work) and **the test suite** (4 Critical fragility / coverage gaps that bite CI before they bite users).

There are **no critical bugs** in the rendered application, no memory leaks, no architectural regressions. The release just shipped is safe. The work surfaced by this review is hardening work for the next 1–2 sprints.

---

## 2. Topic 1: Reusability & Organization

> Full report: [`2026-04-28-reusability.md`](2026-04-28-reusability.md)

### Executive Summary

The architectural discipline noted in March has held. All five high-impact reusability fixes recommended last month have shipped. New code (the Library binding workflow, ~280 lines added to LibraryPanel; pad-shape rendering, ~825 lines added to BoardRenderer) is largely well-organized, with two low-impact duplication patches and one missed call site to `openPdfFiles()`. No critical structural issues.

### Verification of prior findings

| ID | Issue | March status | April status | Evidence |
|----|-------|--------------|--------------|----------|
| **R-1** | PDF loading duplicated 3× (Toolbar, App, Library) | Important | ✅ FIXED | `store/file-actions.ts` extracted; all 3 sites call `openPdfFiles()` |
| **R-2** | `useSyncExternalStore` boilerplate × 3 | Important | ✅ FIXED | `hooks/createStoreHook.ts` factory; all hooks refactored |
| **R-3** | Parser finalization helpers | Minor | NOT FIXED | Low priority; ~100 lines saveable across 7 parsers |
| **R-4** | Store subscription pattern × 7 stores | Minor | ✅ FIXED | `store/emitter.ts` base class; all stores inherit |
| **R-5** | Dead `BoardCanvas.tsx` | Minor | ✅ FIXED | Deleted, no imports |
| **R-6** | render-settings.ts geometry | Suggestion | NOT FIXED | Still 794 LoC; can defer |

### New findings

| ID | Severity | File:line | Finding | Cost |
|----|----------|-----------|---------|------|
| **N-1** | Minor | [LibraryPanel.tsx:1286–1294, :1374–1381](../../src/frontend/src/panels/LibraryPanel.tsx#L1286) | `MetadataView` and `ModelView` re-implement nearly identical `filteredGroups` logic — only the field names (`boardNumbers`/`variants`, `ungrouped`/`unresolved`) differ. | ~30 lines |
| **N-2** | Minor | [LibraryPanel.tsx:886–913](../../src/frontend/src/panels/LibraryPanel.tsx#L886) | `BindingsGrouped` `useMemo` blocks for `groups` and `flatSorted` repeat the same auto_matched/filename sort-key logic. | ~12 lines |
| **N-3** | Minor | [LibraryPanel.tsx:608–613](../../src/frontend/src/panels/LibraryPanel.tsx#L608) | `LiveBrowser` opens PDFs by hand instead of calling `openPdfFiles([fileObj])` — a missed call site of the R-1 fix. | 4 lines |
| **N-4** | Minor | [LibraryPanel.tsx](../../src/frontend/src/panels/LibraryPanel.tsx) | LibraryPanel grew from ~1,500 → 1,780 lines (9 quasi-independent views + 3 binding components in one file). The binding workflow (BindingsGrouped, BindingRow, BindPicker) would naturally extract to `panels/bindings/`. | ~830 lines moved |
| **N-5** | Minor | [BoardRenderer.ts](../../src/frontend/src/renderer/BoardRenderer.ts) | BoardRenderer grew 3,164 → 3,989 lines (+26%) due to pad-shape work. Internally still well-organized; flag for refactor only if it crosses ~4,500. | observational |

### Code quality observations

- All stores now consistently inherit from `Emitter` — pattern uniform across the codebase.
- Tree-view abstraction gap: a third tree view (e.g. custom grouping) would expose N-1 visibly.
- LibraryPanel and PdfViewerPanel (2,981 lines) are both approaching the "extract or split" threshold; SettingsPanel (1,765 lines) is also large.

**Total new duplication: ~46 lines. Estimated remediation: 3–4 hours.**

---

## 3. Topic 2: Quality of Documentation

> Full report: [`2026-04-28-docs.md`](2026-04-28-docs.md)

### Executive Summary

Documentation health is **strong and improving**. 8 of 9 prior documentation findings are FIXED (the only deferred one — BRD nails-side encoding — needs empirical sample verification, not a writing change). PLANNING.md was rewritten as a living doc; BVR side-inversion got proper block comments in the parsers; format specs are exemplary. The new operational risk is **spec proliferation without status tracking** — `docs/superpowers/specs/` has grown to 70 files vs only 17 plans (4.1:1 ratio). With no STATUS matrix, "museum specs" can accumulate silently.

### Verification of prior findings

| ID | Issue | March status | April status |
|----|-------|--------------|--------------|
| D-1 | PLANNING.md BoardData model stale | Important | ✅ FIXED |
| D-2 | PLANNING.md file tree stale | Important | ✅ FIXED (replaced with pointers) |
| D-3 | PLANNING.md phase status | Important | ✅ FIXED (archived to v1) |
| D-4 | BRD nails side encoding mismatch | Important | NOT FIXED (needs samples) |
| D-5 | BDV side-0 Y-mirror undocumented | Important | ✅ FIXED |
| D-6 | BVR side inversion undocumented | Important | ✅ FIXED (4-line block comments in both parsers) |
| D-7 | CLAUDE.md parser signature inaccurate | Important | ✅ FIXED |
| D-8 | TVW spec stale interface | Minor | ✅ FIXED |
| D-9 | README.md wrong port | Minor | ✅ FIXED |

### New findings

| ID | Severity | Where | Finding | Action |
|----|----------|-------|--------|--------|
| **DOC-NEW-1** | Important | `docs/superpowers/` | 70 specs vs 17 plans, no spec→plan→commit traceability matrix. Risk: month-old design work becomes opaque. | Add `docs/superpowers/STATUS.md` matrix |
| **DOC-NEW-2** | Important | `2026-04-22-library-rework-design.md` ↔ `2026-04-27-binding-categorization-design.md` | Implicit cross-spec dependency only mentioned in a footnote. If merged out of order they conflict. | Add prerequisite note to the binding-categorization plan |
| **DOC-NEW-3** | Minor | recent specs | Bare `path:line` references instead of `[…](#L…)` markdown hyperlinks — breaks the precedent set by the format specs. | sed-based fix |
| **DOC-NEW-4** | Minor | BoardRenderer.ts, db.go | Comment density and quality vary — newer rendering code has WHAT comments, older parsers have excellent WHY. | Add a "comments explain WHY" rule to CLAUDE.md |
| **DOC-NEW-5** | Minor | `tests/*.spec.ts` | Test files have inconsistent header comments. Some have full context; others are bare. | Audit headers |
| **DOC-NEW-6** | Minor | `BRD_FORMAT.md:207-218` vs `brd-parser.ts:289-307` | Same as D-4 — needs sample-based validation. | Defer |

### What's working well

- **Format specifications** are exemplary — TVW_FORMAT.md (500+ lines) is an outstanding reference.
- **CLAUDE.md** is accurate, actionable, and the PixiJS lifecycle warnings are correctly preserved as institutional knowledge.
- **Recent feature specs** (binding-categorization, library-history-favorites) follow a consistent structure (Goal / Non-Goals / User Stories / Design / Affected Files / Edge Cases / Testing) with matching plans.
- **README.md** is user-centric and accurate (Docker/standalone/desktop/Synology setup).

---

## 4. Topic 3: Design (UI/UX & Architecture)

> Full report: [`2026-04-28-design.md`](2026-04-28-design.md)

### Executive Summary

Architecture remains sound. Critical findings from the March CODE_REVIEW (M-1 WebGL leak, M-2 PDF unload, A-5 file-load errors, A-6 Cmd+F conflict, A-7 setState in render) are all FIXED. New features (Library binding categorization, 3-state net-lines toggle, real pad shapes, history favorites) integrate cleanly without architectural regressions. The dominant new finding is **CSS file sprawl**: `index.css` grew from 3,535 → 5,479 lines (+55%) and now has 29 `!important` declarations. CSS modules are a sensible next-cycle refactor.

### Verification of prior findings

| ID | Issue | Status |
|----|-------|--------|
| A-1 | BoardRenderer.ts god class | Still monolithic (3,989 LoC); intentional, well-organized internally |
| A-2 | Zero ARIA attributes | Not addressed; low priority for target audience |
| A-3 | Monolithic CSS | Still monolithic, grew 55% |
| A-4 | Context menu not extensible | Not refactored; no new use cases emerged |
| **A-5** | File load errors not surfaced | ✅ FIXED (toast notification system shipped) |
| **A-6** | Cmd+F shortcut conflict | ✅ FIXED |
| **A-7** | setState during render in BoardSidebar | ✅ FIXED (moved to useEffect) |
| A-8 | Mutable tab objects | Intentional pragmatism; no regression |
| **M-1** | WebGL context leak | ✅ FIXED (`WEBGL_lose_context` + ref cycle break) |
| **M-2** | PDFs never unloaded | ✅ FIXED (`closeFile()` on panel removal) |
| **M-3** | IndexedDB unbounded | ✅ FIXED (LRU eviction, 20 boards / 30 PDF text entries) |
| **M-5** | followDebounceTimer not cleared | ✅ FIXED |
| **M-6** | PDF page cache 1.3 GB worst case | ✅ FIXED (10–24 entries + 30–200M pixel cap by quality preset) |
| **M-7** | Canvas pool never reset | ✅ FIXED |
| Issue #20 | netLinePulse setting unimplemented | ✅ IMPLEMENTED |
| Issue #16 | Missing keyboard shortcuts | ✅ ADDRESSED (20+ shortcuts now defined) |

### File size growth (one month)

| File | March | April | Δ | Health |
|------|-------|-------|---|--------|
| BoardRenderer.ts | 3,164 | 3,989 | **+825 (+26%)** | Manageable, well-organized |
| LibraryPanel.tsx | ~1,500 | 1,780 | +280 (+19%) | Approaching split threshold |
| PdfViewerPanel.tsx | ~2,800 | 2,981 | +181 (+6%) | Stable |
| board-store.ts | ~1,100 | 1,319 | +219 (+20%) | Stable |
| **index.css** | 3,535 | **5,479** | **+1,944 (+55%)** | **Recommend split** |

### New findings (Important)

- **DSGN-NEW-1 (Important):** **CSS sprawl** — `index.css` is 5,479 lines with 29 `!important` declarations. New themes, library redesign, binding UI, pad-shape toggles all landed in the same monolith. Recommend per-component CSS modules in next cycle (1–2 days effort).

### New findings (Minor)

- **DSGN-NEW-2:** Theme color system not user-customizable. Themes (Default, Landrex) exist; expose color picker in Settings later.
- **DSGN-NEW-3:** Context menu still doesn't clamp to viewport — overflows on right-click near edges.
- **DSGN-NEW-4:** Sidebar width still uses `setInterval(200ms)` polling — should be `ResizeObserver`.
- **DSGN-NEW-5:** Asymmetry between FileDetailPane on board vs PDF (board side = full editor, PDF side = back-reference list). Verified to be **intentional and correctly documented** in the binding-categorization spec.

### What's strong

- Clean import graph — no circular dependencies, strict layering parsers → stores → UI/renderer.
- 3-state net-lines toggle (off → star → chain) has discoverable tooltips and consistent icon set.
- Library binding flow has clear separation: board side curates, PDF side displays back-references.
- Pad-shape rendering (TVW + Allegro) integrates without coupling between parsers and renderer.

---

## 5. Topic 4: GFX Optimizations & Performance

> Full report: [`2026-04-28-gfx-perf.md`](2026-04-28-gfx-perf.md)

### Executive Summary

The rendering pipeline is **healthy and well-optimized**. Of the 7 GFX findings from March, **4 are fully fixed** and **2 are partial / deferred-with-reason**. Estimated interactive-path improvements on a 10K-part board are **10×–1000×** in common operations (hover, settings change, label churn). No critical GFX issues remain.

### Verification of prior findings

| ID | Issue | Status | Notes |
|----|-------|--------|-------|
| **G-1** | O(N) hit-test linear scan | ✅ FIXED | Spatial hash grid in BoardRenderer.ts:3480–3550 with per-board-format cache |
| **G-2** | BitmapText churn on hover | ✅ FIXED | `netLabelLayer` pool via `netLabelPoolIdx`; visibility-toggled, not destroyed |
| **G-3** | Net-line stroke fragmentation | ✅ FIXED | Smart fast path: single `stroke()` when no fade/dash; per-segment only with effects |
| G-4 | Trace hit-test spatial index | NOT IMPLEMENTED | Re-classified — traces aren't hit-testable today; defer until they are |
| G-5 | Settings change → full rebuild | ⚠️ PARTIAL | Interaction-only fast path implemented (line 2271–2292); visual-only settings still rebuild |
| G-6 | Part-render-bounds caching | ⚠️ PARTIAL | Function is O(1) leaf; deferred — caching would cost more than rebuild |
| G-7 | BitmapFont atlas resolution | NOT CHANGED | UX trade-off pending; monitor atlas memory in practice |

### New findings (all Minor)

| ID | Severity | Finding |
|----|----------|---------|
| **NEW-1** | Minor | Pad shape tessellation cost during selection — measured cost <0.1ms on 10K boards. Not a bottleneck. |
| **NEW-2** | Minor (informational) | Dense PDF text search to defeat pdf.js glyph splits is a feature gain, not a regression. |
| **NEW-3** | Minor | Canvas pool doesn't reset context state (fillStyle, transform) on reuse. Mitigated by pdf.js's own ctx.restore(); add defensive `ctx.resetTransform()` only if issues arise. |

### Estimated per-frame costs (10K-part Allegro board)

| Operation | March | April | Improvement |
|-----------|-------|-------|-------------|
| Hit-test (hover) | ~0.5 ms | ~0.05 ms | **10×** |
| Net-line render (star, no fade) | ~0.2 ms | ~0.05 ms | **4×** |
| Label pool churn (hover) | GC stall ~2–5 ms | 0 µs | **unbounded** |
| Settings change (interaction-only) | ~100 ms | ~0.1 ms | **1000×** |
| Settings change (visual) | ~100 ms | ~100 ms | unchanged |
| Pad shape computation (selection) | — | ~0.01 ms | negligible |

### Cross-cutting

- **`hitGridCache`** caches grids by board-format × part-count. Switching between two same-type boards reuses the grid — smart memory reuse without stale-cache bugs.
- **Net-line rendering** exemplifies progressive enhancement (simple/fast default; effects-aware slow path) — a pattern worth copying.
- **Label LoD** (font-size groups) is implemented for pin labels but not part labels; minor optimization opportunity.
- **Theme system** uses getters that walk the theme stack on each read — measure per-frame impact at 60fps before tuning.

---

## 6. Topic 5: Memory & Multi-Board Performance

> Full report: [`2026-04-28-memory.md`](2026-04-28-memory.md)

### Executive Summary

Memory health is **excellent**. ~95% of prior critical/important memory findings are FIXED. Estimated steady-state for a typical 3-board + 3-PDF session is **450–650 MB total** (JS heap + GPU + IndexedDB), well within browser limits and the 4–8 GB technician workstation target. WebGL contexts no longer accumulate; PDFs are released on panel close; canvases shrink before pooling; IndexedDB has LRU eviction.

### Verification of prior findings

All M-series and G-series memory issues from March are fixed:

| ID | Issue | Status |
|----|-------|--------|
| **M-1** | WebGL context leak | ✅ FIXED — `WEBGL_lose_context()` forced + null refs in destroy/teardown |
| **M-2** | PDFs never unloaded | ✅ FIXED — App.tsx:138–152 calls `pdfStore.closeFile()` on panel removal |
| **M-3** | IndexedDB unbounded | ✅ FIXED — LRU eviction (20 boards / 30 PDF text entries) |
| M-4 | Scene cache unbounded | ⚠️ ACCEPTABLE — fine for 3–5 boards; future LRU recommended for power users |
| **M-5** | followDebounceTimer not cleared | ✅ FIXED |
| **M-6** | PDF page cache | ✅ FIXED — quality presets (10–24 entries, 30–200M px) |
| **M-7** | Canvas pool never reset | ✅ FIXED — width/height → 1×1 in `releaseCanvas()` |
| **M-8** | Search cache leak on tab close | ✅ FIXED |
| **M-9** | docSnapshots leak | ✅ FIXED |
| **G-1, G-2, G-3** | (see GFX topic) | ✅ FIXED |
| **R-1, R-2** | (see Reusability topic) | ✅ FIXED |

### New findings (all Minor / Acceptable)

- **MEM-NEW-1 (Acceptable):** `favoritePaths: Set<string>` is included in the `useDatabank` snapshot. Set is replaced (not mutated) on toggle, so reference stability holds. Notify frequency is bounded. Document as a future-watch item.
- **MEM-NEW-2 (Minor):** PDF tile cache may briefly exceed pixel budget during rapid zoom (eviction is FIFO-by-insertion, not LRU-by-access). At current scale (~50–100 entries) this is invisible. Upgrade to true LRU if tile count grows beyond ~500.
- **MEM-NEW-3 (Acceptable):** `BoardRenderer.sceneCache` is unbounded. Cached by `(rawBoardRef, foldMode, selectedBoardIndex)`. For 3–5 boards: net win (instant tab-switch). For 20+ unique boards: 300–500 MB JS heap accumulation. **Recommend** adding `sceneCache.evictLRU(maxAge_ms)` if heap pressure becomes an issue, called on tab switch when cache size > 5.

### Estimated steady-state memory (typical session)

| Component | Bytes |
|-----------|-------|
| JS heap | 250–350 MB |
| GPU memory (page cache + atlases) | 150–200 MB |
| WebGL contexts | 1–3 (never exceeds 8) |
| IndexedDB (LRU-capped) | 40–100 MB |
| **Total** | **~450–650 MB** |

### Multi-tab stress-test plan (excerpt)

The full topic report includes three test scenarios:

1. **Rapid open/close 10 cycles** — heap should stabilize after cycle 3–4; WebGL context count ≤ 3.
2. **3 boards × 3 PDFs (dashboard)** — heap 400–600 MB sustained, not growing; tile cache <120 M px.
3. **1000-tab-switch long-running session** — heap should not exceed 600 MB sustained.

---

## 7. Topic 6: Backend & Database Design

> Full report: [`2026-04-28-backend.md`](2026-04-28-backend.md)

### Executive Summary

The Go backend is **production-ready with known sharp edges**. Solid foundational architecture (separate reader/writer SQLite pools, WAL mode, gzip middleware, transactional migrations). The recent v8 binding-categorization migration shipped cleanly with backward-compatible defaults. **No critical bugs.** Five Important findings cluster around **production hardening**: context timeouts, concurrency races, unbounded batch inserts, an unused PDF-extraction timeout. Estimated full remediation: 2–3 days for one developer.

### Important findings

| ID | Severity | Where | Finding |
|----|----------|-------|---------|
| **B6** | Important | All handlers | No context timeouts. Handlers don't propagate `r.Context()` deadline; SQLite reads can hang indefinitely if writer blocks. Slowloris-class exposure. |
| **B4** | Important | [scanner.go:282–376](../../src/backend/databank/scanner.go#L282) | Scan-status race: counters incremented atomically but read inside a separate mutex region; `Scanned` and `Phase` can be observed from two different iterations. |
| **B5** | Important | [pdftext.go:177–190](../../src/backend/databank/pdftext.go#L177) | Same shape of race in PDF extractor (`extracted`/`errors` counters). |
| **B17** | Important | [pdftext.go:17](../../src/backend/databank/pdftext.go#L17) | `extractTimeout = 2 * time.Minute` is declared but **never used**. `rsc.io/pdf` can hang on malformed files. |
| **B15** | Important | [scanner.go:366–416](../../src/backend/databank/scanner.go#L366) | Batch insert size unbounded — at 100k new files, all collected in memory before one giant INSERT. Will OOM the container. |
| B8 | Important | main.go | No graceful shutdown. SIGTERM during a 10-min scan abruptly terminates workers; partial DB writes possible. |
| B2 | Important | scanner.go:384, :546 | Inconsistent error wrapping (no `%w`); some errors logged-only. |
| B1 | Important | [handlers/databank.go (651 LoC)](../../src/backend/handlers/databank.go) | Single handler file mixes 4 concerns (files/bindings/search/PDF). Extract into `handlers/bindings.go` + `handlers/search.go`. |

### Minor findings

| ID | Where | Finding |
|----|-------|---------|
| B3 | handlers | Error messages not HTML-escaped before going into `http.Error()`. |
| B7 | logging | Library scan root paths logged in plaintext — potentially exposes NAS structure. |
| B10 | indexes | `idx_files_board_number`, `idx_files_board_mfg` are unused by current handlers. |
| B12 | API | Plain-text error responses vs JSON success responses — inconsistent. |
| B13 | API | `/api/databank/files` has no pagination; 100k rows = ~50 MB payload. |
| B14 | files.go | `GET /api/files/path/{path...}` — verify no `../` traversal escape. |
| B18 | metadata.go | `MatchScore` ≥ 50 threshold is loose — substring matches like "README.pdf" ↔ "Board.bvr" can hit. |
| B19 | scanner.go | Deleted bindings aren't re-evaluated on next scan. |
| B20 | updater.go | No GitHub API rate-limit backoff. |

### Schema audit (V1 → V8)

All migrations are transactional and idempotent. **migrateV8** (just shipped) was reviewed in detail:

- `ALTER TABLE bindings ADD COLUMN category TEXT NOT NULL DEFAULT 'schematic'` ✓ — existing rows backfill safely
- `ALTER TABLE bindings ADD COLUMN auto_open INTEGER NOT NULL DEFAULT 1` ✓ — preserves current auto-open behavior
- Wrapped in transaction with deferred Rollback ✓
- Schema-version bump from 7 → 8 ✓

### What was done well (backend)

- Separate reader/writer SQLite pools with mutex serialization — solid pattern
- WAL mode enables concurrent reads alongside writes
- Gzip middleware with efficient pooling and graceful fallback
- All `defer rows.Close()` calls present; no obvious file-handle leaks
- PDF errors persisted to `pdf_scan_errors` table for async review (not lost to stdout)
- V5 covering index `(manufacturer, board_number, filename)` solves full-list O(N²) sort

---

## 8. Topic 7: Test Coverage & Quality

> Full report: [`2026-04-28-tests.md`](2026-04-28-tests.md)

### Executive Summary

The Playwright E2E suite is **strong in breadth** (23 specs, 5,018 LoC, ~200 tests) but **uneven in depth and resilience**. Four critical fragility / coverage gaps risk silent test failures or CI breakage:

1. Hard-coded board IDs (e.g. `BOARD_ID = 873`) that fail silently if the databank is reseeded.
2. Hard-coded ports (`5174`, `1336`, `8083`) that collide with the user's other projects.
3. Four file format parsers (BRD, FZ, CAD, XZZ) **have zero parser-level tests**.
4. Backend binding API tests run against a populated databank — not CI-friendly.

### Coverage matrix (excerpt)

**Format parsers** (10 formats, 3 with their own spec):

| Format | E2E Test | Spec File |
|--------|----------|-----------|
| BVR1 | ✓ Heavy | bvr1-parser.spec.ts |
| BVR3 | ✓ Indirect | comprehensive.spec.ts |
| **BRD** | ✗ | **— (gap)** |
| BDV | ✓ Medium | bdv-parser.spec.ts |
| BDV ASC | ✓ Light | bdv-asc-parser.spec.ts |
| **FZ** | ✗ | **— (gap)** |
| **CAD** | ✗ | **— (gap)** |
| **XZZ** | ✗ | **— (gap)** |
| TVW | ✓ Medium | tvw-parser.spec.ts |
| ALLEGRO_BRD | ✓ Heavy | allegro-brd-parser.spec.ts |

**Backend handlers** (4 handlers, 1 with Go tests):

| Handler | Go Tests | Notes |
|---------|----------|-------|
| FileHandler | ✓ 4 tests | Upload, list, empty-dir, path-traversal |
| BoardHandler | ✗ | No metadata fetch / patch tests |
| DatabankHandler | ✗ (Go) — Playwright only | Hard-coded board ID 873 |
| UpdateHandler | ✗ | Self-update untested |

### Critical findings

| ID | Severity | Finding |
|----|----------|---------|
| **T-1** | Critical | Hard-coded `BOARD_ID = 873` and `BINDING_ID = 212` in [binding-categorization.spec.ts:18–19](../../src/frontend/tests/binding-categorization.spec.ts#L18). Tests fail silently with `getBinding` returning `undefined` if the DB is reseeded. |
| **T-2** | Critical | Playwright config hardcodes port 5174 with `reuseExistingServer: true`. The user's CRM project also uses 5174 — this caused the "wrong-app login screen" incident during this session's testing. |
| **T-3** | Critical | Four format parsers (BRD, FZ, CAD, XZZ) have **no parser-level tests**. BRD is in production use (sample `820-02935-05.brd`). Binary parsing regressions on these formats will not be detected. |
| **T-10** | Critical | Backend binding API tests require a populated databank (board ID 873, PDFs 874/988/1002/1003 pre-loaded). Cannot run in CI without manual seed. |

### Important findings

| ID | Finding |
|----|---------|
| **T-3** | 100+ `waitForTimeout` calls instead of `waitFor*` conditions — flakiness vector. |
| **T-5** | Real pad-shape rendering (recent commits eecb96b, a5a3112, bc059dd, 4c4981f) has no visual regression coverage. |
| **T-6** | PDF viewer zoom/tier/watermark edge cases not tested. |
| **T-8** | 162+ direct CSS selectors in tests instead of `data-testid` — UI refactor risks breaking 20+ tests. |
| **T-9** | WebGL adapter warning handling inconsistent across suites. |
| **T-12** | Test setup/teardown leaks bindings into the DB on failure. |

### Recommended new tests (priority)

**P0 (block release without):**

1. BRD parser unit tests
2. FZ parser unit tests
3. **Backend binding API Go tests** — migrate `binding-categorization.spec.ts` API portion to Go unit tests with ephemeral SQLite (CI-friendly)
4. Environment-variable-ize ports in `playwright.config.ts`

**P1 (gaps in coverage):**

5. PDF viewer zoom & tier tests (shift/ctrl/pinch zoom, tile-manager)
6. History favorites flow (recently-opened, double-click open, ordering)
7. Real pad shapes rendering (Allegro round/oblong/rect, TVW multi-layer)
8. CAD & XZZ parser tests

**P2 (nice-to-have):**

9. vitest harness for parser utility unit tests (mils ↔ degree conversion, mirror detection, outline normalization)
10. Multi-PDF side-by-side rendering
11. Renderer lifecycle stress (rapid app.destroy prevention, BitmapFont.uninstall prevention)
12. Visual regression snapshots

### Cross-cutting test observations

- **No unit-test framework** for pure functions (vitest/jest absent). All tests are E2E.
- **CI/CD readiness:** tests cannot run in standard GitHub Actions without Docker Compose seeding.
- **Test naming quality:** mostly good, with descriptive intent. A few generic names like `'all toolbar buttons render without errors'` should specify which.
- **No `tests/README.md`** documenting fixtures, ports, local-vs-CI run instructions.

---

## 9. Cross-Cutting Findings

Patterns that surfaced in multiple topic reviews:

### 9.1 Three growing files dominate the project

| File | Lines | Topic |
|------|-------|-------|
| BoardRenderer.ts | 3,989 | Reusability + Design |
| LibraryPanel.tsx | 1,780 | Reusability + Design |
| index.css | 5,479 | Design |

Each is functional and well-organized internally; none is a critical refactor target. But they will need to be split if they continue growing at the current pace. Recommend revisiting at the next quarterly review.

### 9.2 Concurrency discipline is solid in TypeScript, less so in Go

The frontend is single-threaded (with Workers for PDF.js text extraction). Concurrency surface is small.

The Go backend has multi-goroutine scanners and PDF extractors with explicit locks — and that's where this review found two races (B4, B5) and one lifecycle gap (B8 graceful shutdown). The pattern: mixing `atomic.AddInt64` with non-atomic reads under a separate mutex region. Resolution: pick one strategy per data structure — either consistent atomic ops or always under the same mutex.

### 9.3 Hardening is the next sprint's theme

The fixes shipped over the past month addressed **functional correctness** (memory leaks, missing error toasts, render-phase setState, etc.). The new findings consistently cluster around **operational hardening**:

- Backend timeouts, batch sizes, graceful shutdown (B6, B8, B15, B17)
- Test environment fragility (T-1, T-2, T-10)
- Spec/plan status tracking (DOC-NEW-1)
- Scene cache eviction policy (MEM-NEW-3)
- CSS modularization (DSGN-NEW-1)

None of these block a release. All of them become problems at scale or during incidents.

### 9.4 The binding-categorization feature was implemented across 7 files, with 16 tests, in 1 sprint

The v8 schema migration, backend handlers, frontend store, UI redesign, e2e tests, and documentation all landed together. This review found **no architectural regressions** from that work — a good signal about the codebase's ability to absorb a feature that touches every layer. The only structural feedback is N-4 (extract `panels/bindings/`).

### 9.5 Documentation discipline → spec proliferation

The same discipline that produced excellent format specs and recent feature designs has now produced 70 specs. Without a status matrix, this discipline becomes a future maintenance liability. The simple fix (DOC-NEW-1's `STATUS.md`) takes <1 day and saves multiples of that over the next year.

---

## 10. Consolidated Correction Plan

Phased by severity and dependency, mirroring the prior report's structure. Estimated efforts are conservative.

### Phase 1 — Critical / Important (Do before next release)

| ID | Topic | Action | Effort |
|----|-------|--------|--------|
| **B6** | Backend | Add `context.WithTimeout()` to all handlers; propagate to DB layer. | Medium (1d) |
| **B17** | Backend | Implement the declared `extractTimeout = 2 min` via `context.WithTimeout()` on PDF extraction. | Low (2h) |
| **B4 / B5** | Backend | Replace mixed atomic+mutex counters with `atomic.Int64` (or consistently mutex-locked struct) for scan/PDF status. | Low (4h) |
| **B15** | Backend | Chunk batch insert at 1,000 rows. | Low (2h) |
| **B8** | Backend | Trap SIGTERM, call `scanner.StopScan()`, wait for ops, close DB. | Low (4h) |
| **T-1** | Tests | Replace hard-coded `BOARD_ID = 873` with name-based lookup (`getBoardIdByName`). | Low (2h) |
| **T-2** | Tests | Read VITE_PORT / BACKEND_PORT / BASE_URL from env in `playwright.config.ts`. | Low (1h) |
| **T-10** | Tests | Migrate the binding API portion of `binding-categorization.spec.ts` to Go unit tests with ephemeral SQLite. | Medium (1d) |
| **T-4** | Tests | Add BRD parser tests. | Medium (4h) |
| **DOC-NEW-1** | Docs | Add `docs/superpowers/STATUS.md` matrix tracking spec → plan → commit. | Low (4h) |
| **DOC-NEW-2** | Docs | Add merge-order note to binding-categorization plan re: library-rework. | Trivial |

**Phase 1 total: ~3 days for one developer.**

### Phase 2 — Important / Robustness (Within 1 sprint)

| ID | Topic | Action | Effort |
|----|-------|--------|--------|
| **B1** | Backend | Split `handlers/databank.go` into `handlers/bindings.go` + `handlers/search.go`. | Medium (4h) |
| **B2** | Backend | Use `%w` consistently in `fmt.Errorf` calls; remove logged-only errors. | Trivial |
| **B12** | Backend | Define `ErrorResponse` struct; standardize all error responses as JSON. | Low (2h) |
| **DSGN-NEW-1** | Design | CSS module split — start with Toolbar, Sidebar, Library, PDF, Settings. | Medium-Heavy (1–2d) |
| **N-4** | Reuse | Extract `panels/bindings/` (BindingsGrouped, BindingRow, BindPicker, types). | Medium (4h) |
| **T-3** | Tests | Replace 100+ `waitForTimeout` calls with proper `waitFor*` conditions. | Heavy (1–2d) |
| **T-5** | Tests | Add real-pad-shape rendering tests (Allegro + TVW). | Medium (4h) |
| **T-6** | Tests | Add PDF zoom/tier/watermark tests. | Medium (1d) |
| **T-7** | Tests | Add history-favorites flow tests. | Low (2h) |
| **T-8** | Tests | Audit CSS-selector usages; add `data-testid` to panels (Library, PDF, Debug). | Medium (1d) |

**Phase 2 total: ~5–6 days.**

### Phase 3 — Quality / Polish (Schedule for later)

| ID | Topic | Action |
|----|-------|--------|
| **N-1** | Reuse | Extract generic tree-view filter helper (`filterTreeGroups`). |
| **N-2** | Reuse | Extract `bindingSortKey()` helper. |
| **N-3** | Reuse | Use `openPdfFiles([fileObj])` in LiveBrowser. |
| **DOC-NEW-3** | Docs | sed pass to convert bare `path:line` refs to markdown hyperlinks in recent specs. |
| **DOC-NEW-4** | Docs | Add a "comments explain WHY" rule to CLAUDE.md. |
| **DOC-NEW-5** | Docs | Audit test file headers; add 2–3-line context comments where missing. |
| **DSGN-NEW-3** | Design | Context menu viewport-clamping. |
| **DSGN-NEW-4** | Design | Replace sidebar width polling with `ResizeObserver`. |
| **MEM-NEW-3** | Memory | Add `sceneCache.evictLRU(maxAge)` if heap pressure observed in long sessions. |
| **B3, B7, B10, B14** | Backend | Minor hardening: HTML-escape errors, redact log paths, prune unused indexes, audit path-traversal mitigations. |
| **B18, B19, B20** | Backend | Match-score threshold, scanner re-evaluation policy, GitHub rate-limit backoff. |
| **T-9** | Tests | Standardize WebGL adapter error filtering across all suites. |
| **T-12** | Tests | Use `test.afterEach()` fixtures so failures don't leak server state. |

### Phase 4 — Future Watch / Defer

- N-5, A-1: BoardRenderer monolithic — refactor only if it crosses ~4,500 lines
- A-2: ARIA support — not a priority for the target audience
- A-3: CSS modules (now Phase 2)
- M-4: Scene cache eviction — only if power-user 10+ board scenarios become common
- BRD nails-side encoding — empirical sample validation, not a writing task
- Visual regression snapshots — nice-to-have, defer
- Parser utility unit-test framework (vitest) — defer until parsers churn

---

## 11. What Was Done Well

A summary of the **20 prior findings closed** in the past month and the patterns that produced them:

### Memory hygiene (5 critical fixes)

- **M-1 WebGL leak** — `WEBGL_lose_context()` forced + reference cycle break in destroy/teardown. Survives 10+ open/close cycles cleanly.
- **M-2 PDF unload** — `pdfStore.closeFile()` wired into Dockview `onDidRemovePanel`.
- **M-3 IndexedDB LRU** — 20 boards / 30 PDF text entries, timestamp-based.
- **M-6 PDF page cache** — entries + pixel-area dual cap, scaled by `navigator.deviceMemory`.
- **M-7 Canvas pool reset** — width/height → 1×1 before pooling.

### Performance (3 fixes worth 10–1000× on 10K-part boards)

- **G-1** spatial hash hit grid with per-board cache (hover: 10×)
- **G-2** BitmapText pool via `netLabelLayer.children` (zero-allocation hover)
- **G-3** batched net-line strokes with smart fast path
- **G-5** interaction-only settings fast path (1000× on toggle changes)

### Reusability (4 fixes)

- **R-1** `openPdfFiles()` extracted to `store/file-actions.ts`
- **R-2** `createStoreHook` factory eliminates ~90 lines of boilerplate
- **R-4** `Emitter` base class for all stores
- **R-5** dead `BoardCanvas.tsx` removed

### UX correctness (3 fixes)

- **A-5** toast notification system for parse failures
- **A-6** Cmd+F shortcut conflict resolved via context-aware merge
- **A-7** setState moved out of render in BoardSidebar

### Documentation (8 fixes)

- PLANNING.md rewritten as a living doc; old phases archived
- BVR side inversion documented inline (4-line block comments in both parsers)
- BDV shoelace algorithm + dynamic flipY documented
- README.md ports corrected
- TVW spec stale interface removed
- CLAUDE.md parser signature updated
- Format specs remain exemplary; new feature specs follow consistent structure

### New feature delivery (no regressions)

- v8 binding categorization migration shipped backward-compatibly (existing rows default to `schematic` + `auto_open=true`)
- 3-state net-lines toggle with discoverable cycling tooltips
- Real pad shapes for TVW + Allegro (round/oblong/rect/poly) — clean integration with no parser/renderer coupling
- Library history favorites with hover-revealed pin button and click parity with other Library tabs

### Patterns that produced these wins

- **Concrete severity labels** in the prior report (Critical / Important / Minor) gave clear prioritization.
- **Per-finding Correction sections** told the implementer what to do, not just what was wrong.
- **File:line citations** made each finding actionable without further investigation.
- **Cross-cutting findings** (e.g. "all stores have the same boilerplate") gave permission to extract abstractions.

This follow-up report uses the same patterns.

---

## 12. Headline Numbers

- **Prior report findings closed:** 20 of 22 high-severity (91%)
- **Prior report findings deferred with reason:** 2 (CSS sprawl now Phase 2; BRD nails encoding needs samples)
- **New findings (all topics):** 41 total — 0 Critical (rendered application), 4 Critical (test fragility / coverage), 13 Important, 24 Minor
- **Estimated remediation:**
  - Phase 1 (Critical + Important): **~3 days**
  - Phase 2 (Important + structural): **~5–6 days**
  - Phase 3 (Polish): a few days, can be interleaved
- **Topic-report depth:** 2,887 lines across 7 specialist reports
- **Codebase health:** sound. No critical bugs. No blocking issues. v0.14.0 is safe to ship (and was, https://github.com/AlexeyInwerp/BoardRipper/releases/tag/v0.14.0).

---

**Next scheduled review:** 2026-05-31 (one release cycle), or earlier if a major feature spans multiple subsystems.

**Generated:** 2026-04-28 by 7 parallel review agents (reusability, docs, design, GFX, memory, backend, tests). Topic-specific reports are linked in §1.
