# BoardRipper — Comprehensive Code Review Report

**Date:** 2026-03-30
**Version:** v0.2.3-beta
**Codebase:** ~603K lines TypeScript, 3327 files, 12 Playwright test suites
**Reviewers:** 5 parallel AI review agents (reusability, docs, design, GFX, memory)

---

## Table of Contents

1. [Overview & Methodology](#1-overview--methodology)
2. [Topic 1: Reusability & Organization](#2-topic-1-reusability--organization)
3. [Topic 2: Quality of Documentation](#3-topic-2-quality-of-documentation)
4. [Topic 3: Design (UI/UX & Architecture)](#4-topic-3-design-uiux--architecture)
5. [Topic 4: GFX Optimizations & Performance](#5-topic-4-gfx-optimizations--performance)
6. [Topic 5: Memory & Multi-Board Performance](#6-topic-5-memory--multi-board-performance)
7. [Cross-Cutting Findings](#7-cross-cutting-findings)
8. [Consolidated Correction Plan](#8-consolidated-correction-plan)
9. [What Was Done Well](#9-what-was-done-well)

---

## 1. Overview & Methodology

Five specialized review agents operated in parallel, each reading the full relevant source files and cross-referencing across modules. The review covers:

- **Frontend:** React 19 + TypeScript + PixiJS v8 + Dockview v5 (~20K lines of application TypeScript)
- **Backend:** Go net/http server (stateless, file serving)
- **Tests:** 12 Playwright spec files (3,366 lines)
- **Docs:** 8 format specs + PLANNING.md + CLAUDE.md + README.md

Severity levels:
- **Critical** — Will cause failures/data loss under normal use; fix immediately
- **Important** — Significant quality/perf issue; fix before next release
- **Minor** — Tech debt or improvement opportunity; schedule for later

---

## 2. Topic 1: Reusability & Organization

### Executive Summary
The codebase has strong architectural discipline — parser registry, centralized types, clean import graph with no circular dependencies. Three areas of meaningful duplication exist totaling ~280 recoverable lines.

### Issues

#### [Important] R-1: PDF Loading Workflow Duplicated in 3 Locations
**Files:** `Toolbar.tsx:42-76`, `App.tsx:117-152`, `LibraryPanel.tsx:106-124`

The sequence `addPdf → autoBindPdf → addPdfBinding → pdfStore.loadFile → ensurePdfPanel → pdfStore.switchTo` is repeated with slightly different error handling in each location.

**Correction:** Extract a shared `openPdfFiles(files, activeTabId)` into `store/file-actions.ts`. All 3 call sites reduce to a single function call.

**Impact:** Eliminates ~60 duplicate lines, single source of truth for PDF opening behavior.

---

#### [Important] R-2: useSyncExternalStore Hook Boilerplate Duplicated 3x
**Files:** `hooks/useBoardStore.ts:36-83`, `hooks/usePdfStore.ts:25-63`, `hooks/useDatabank.ts:31-75`

All three hooks repeat the same version-counter caching pattern (~30 lines each): module-level `cachedSnapshot`, `snapshotVersion`, `lastVersion`, subscribe wrapper, getSnapshot with rebuild-on-version-advance.

**Correction:** Create `hooks/createStoreHook.ts` — a generic factory that encapsulates the caching logic. Each hook reduces to a `createStoreHook(store, buildSnapshot)` call.

**Impact:** Eliminates ~60 lines of duplicated caching logic.

---

#### [Minor] R-3: Parser Finalization Sequence Repeated Across 7 Parsers
**Files:** `bvr1-parser.ts:86-101`, `bvr3-parser.ts:126-211`, `bdv-parser.ts:202-260`, `brd-parser.ts:267-317`, `fz-parser.ts:351-396`, `cad-parser.ts:229-267`, `xzz-parser.ts:821-848`

Each parser independently computes part origin from pin centroid, bounds via `computeBBox`, collects allPoints, calls `buildNets`, and assembles the return object. FZ and CAD parsers also share identical rectangular-outline-from-pin-bounds logic.

**Correction:** Add helper functions to `types.ts`:
- `finalizePart(name, side, type, pins, origin?)` — computes origin/bounds with empty-pin fallback
- `finalizeBoardData(format, outline, parts, nails, extras?)` — computes global bounds, calls buildNets
- `generateRectOutline(points, margin)` — shared FZ/CAD outline generation

**Impact:** Removes ~100 lines of duplicated logic across 7 parsers.

---

#### [Minor] R-4: Store Subscription Pattern Not Abstracted (7 stores)
**Files:** All 7 store files

Every store implements the same 3-line `_listeners/subscribe/notify` pattern.

**Correction:** Create `store/emitter.ts` base class or mixin providing `subscribe()` and `notify()`.

**Impact:** Saves ~21 lines; main benefit is single-point-of-change for future enhancements (batched notifications, debug logging).

---

#### [Minor] R-5: BoardCanvas.tsx is Dead Code
**File:** `components/BoardCanvas.tsx` (36 lines)

Not imported anywhere. Board rendering is done by `BoardViewerPanel.tsx`.

**Correction:** Delete `BoardCanvas.tsx`.

---

#### [Suggestion] R-6: render-settings.ts Has Mixed Concerns (794 lines)
**File:** `store/render-settings.ts`

Contains three distinct concerns: settings type/defaults, pure geometry computation functions, and the store class. The geometry functions (`computeEffectiveBounds`, `computeDiagonalOBB`, etc.) have no dependency on the store.

**Correction:** Extract geometry computations into `render-geometry.ts`.

---

### Positive Findings
- **Parser registry pattern** is clean and extensible — adding a format requires 2 files + 1 line
- **Types are centralized** in `parsers/types.ts` with zero duplication
- **No circular dependencies** detected in the import graph
- **Allegro parser** is the most complex (4100+ lines) and is well-modularized into 6 sub-modules

---

## 3. Topic 2: Quality of Documentation

### Executive Summary
Documentation is above average for a private project. Format specs are thorough and well-structured. However, PLANNING.md has significant staleness (data model, file tree, phase status all outdated), and there are spec-to-parser discrepancies in BRD nails side encoding and BDV side-0 handling.

### Issues

#### [Important] D-1: PLANNING.md BoardData Model is Stale
**File:** `docs/PLANNING.md:153-188`

Shows `format: 'BVR1' | 'BVR3'` — missing 7 of 9 formats. Missing fields: `traces`, `vias`, `layerNames`, `butterflyFoldAxis`, `flipY`, `bounds`.

**Correction:** Update to mirror actual `types.ts` interface definitions.

---

#### [Important] D-2: PLANNING.md File Structure Tree is Stale
**File:** `docs/PLANNING.md:222-276`

Omits: entire `allegro/` subdirectory, BDV/XZZ/TVW/FZ/CAD parsers, `registry.ts`, `export-bvr3.ts`, `BindLink.tsx`, `BoardSidebar.tsx`, `DebugPanel.tsx`, `LibraryPanel.tsx`, `BoardViewerPanel.tsx`, 6 store files.

**Correction:** Regenerate or replace with pointer: "See `parsers/registry.ts` for the complete format list."

---

#### [Important] D-3: PLANNING.md Phase Status Outdated
**File:** `docs/PLANNING.md:89-97`

PDF viewer listed as "Future" but is fully implemented (multi-doc, text search, bookmarks, night mode, component click-to-focus).

**Correction:** Mark PDF features as done. Audit Phase 5 items against actual code.

---

#### [Important] D-4: BRD Format Spec — Nails Side Encoding Discrepancy
**Files:** `docs/formats/BRD_FORMAT.md:207-218`, `parsers/brd-parser.ts:289-307`

Spec says column 3 is "Unknown type code (constant 2)". Parser interprets it as `side(1=top, else=bottom)`. They disagree.

**Correction:** Verify against additional BRD samples. Update whichever is wrong.

---

#### [Important] D-5: BDV Format Spec — Missing side=0 Y-mirror Behavior
**Files:** `docs/formats/BDV_FORMAT.md:107-128`, `parsers/bdv-parser.ts:170-193`

Parser handles `side=0` (Y-mirrored bottom-side coords) and dynamic flipY via shoelace-algorithm. Neither is documented.

**Correction:** Add "Parser Notes" addendum to `BDV_FORMAT.md`.

---

#### [Important] D-6: BVR1/BVR3 Side Mapping Appears Inverted — No Explanation
**Files:** `parsers/bvr1-parser.ts:46`, `parsers/bvr3-parser.ts:111`

`(T)` maps to `'bottom'` and `(B)` to `'top'` — opposite of what the spec says. Presumably intentional coordinate compensation but completely undocumented.

**Correction:** Add inline comments explaining WHY side is inverted.

**Impact:** High — this is exactly the kind of non-obvious behavior that causes regressions.

---

#### [Minor] D-7: CLAUDE.md Parser Signature Inaccurate
**File:** `CLAUDE.md:71`

States `(text: string) => BoardData`. Actual signature is `(buffer: ArrayBuffer) => BoardData | Promise<BoardData>` for most parsers.

**Correction:** Update to match `FormatDescriptor.parse` signature from `registry.ts`.

---

#### [Minor] D-8: TVW Format Spec Contains Stale TvwBoardData Interface
**File:** `docs/formats/TVW_FORMAT.md:498-508`

Shows `TvwBoardData extends BoardData` — never implemented. Actual parser uses standard `BoardData`.

**Correction:** Replace with note about which `BoardData` fields are populated.

---

#### [Minor] D-9: README.md Wrong Backend Port
**File:** `README.md:78`

Shows `localhost:8080` but local dev uses port 1336.

**Correction:** Clarify port usage or add `PORT=1336` env var.

---

### Positive Findings
- **Parser file headers** are consistently excellent across all 9 parsers
- **Format specs** are well-structured with consistent formatting
- **Registry JSDoc** is thorough, including a "how to add a new format" guide
- **CLAUDE.md** is accurate as an AI-assisted development guide
- **PixiJS destroy warning** is valuable institutional knowledge properly documented

---

## 4. Topic 3: Design (UI/UX & Architecture)

### Executive Summary
Well-architected with clean separation between rendering, state management, and UI. Primary concerns: (1) `BoardRenderer.ts` is a 3,164-line god class, (2) monolithic 3,535-line CSS file with growing specificity issues, (3) zero accessibility support.

### Issues

#### [Critical] A-1: BoardRenderer.ts — 3,164-Line God Class
**File:** `renderer/BoardRenderer.ts`

Single class with ~50 private fields and ~30 methods handling: PixiJS lifecycle, viewport management, scene building/caching, selection rendering, net lines, net dimming, butterfly mode, cross-side ghosts, hover tooltips, HUD overlay, perf overlay, elevated labels, zoom animations, LoD, text hiding, context menu, PDF follow mode, WebGL recovery, gesture handling, hit-testing, resize observation.

**Correction:** Extract into composable subsystems:
- `ViewportManager` — pan/zoom, resize, animated zoom, gestures
- `SelectionRenderer` — selection rect, net dim, blink, elevated labels
- `NetLineRenderer` — net line geometry, pulse animation, cross-side ghosts
- `HudOverlay` — HUD, perf overlay, selection overlay (DOM elements)
- `SceneManager` — scene cache, tab switching, board activation
- `HitTester` — click/hover detection, context menu triggering

**Impact:** #1 refactoring priority for maintainability.

---

#### [Critical] A-2: Zero ARIA Attributes in Interactive Components
**Files:** All components and panels

No `aria-label`, `role`, or `tabIndex` anywhere. Context menu has no `role="menu"`. Toolbar buttons use unicode symbols (↺, ↻, ⇔) with no screen reader support. No keyboard navigation in menus.

**Correction:** At minimum: `role="menu"` on context menu, `aria-label` on icon-only buttons, `role="search"` on search input, `role="tablist/tab/tabpanel"` on sidebar tabs.

**Impact:** Low priority for target audience (repair technicians) but important for inclusive design.

---

#### [Important] A-3: Monolithic 3,535-Line CSS File
**File:** `src/frontend/src/index.css`

All styles in one file, global class names, 20 `!important` declarations, zero `@media` responsive breakpoints.

**Correction:** Split into per-component CSS modules (`Toolbar.module.css`, etc.). Isolate Dockview overrides into `dockview-overrides.css`. Add basic responsive breakpoints for toolbar/statusbar.

---

#### [Important] A-4: Context Menu Not Extensible
**File:** `components/ContextMenu.tsx`

Hardcoded to PDF search. No generic menu item system.

**Correction:** Refactor `ContextMenuState` to accept `MenuItem[]` with `label`, `action`, `disabled`, `submenu`. Renderer pushes items when showing menu.

---

#### [Important] A-5: File Load Errors Not Surfaced to Users
**File:** `store/board-store.ts:379-390`

Parse failures logged to debug console but never shown in UI. Tab silently vanishes.

**Correction:** Add a toast/notification system. Display "Failed to load {fileName}: {error}" on failure.

---

#### [Important] A-6: Cmd+F Shortcut Conflict
**Files:** `store/keyboard-shortcuts.ts:53-58` and `:143-148`

Both `focusSearch` and `pdfSearch` bound to Cmd+F. Resolved implicitly at runtime but visible as conflict in settings.

**Correction:** Merge into single context-aware shortcut, or give PDF search Cmd+Shift+F.

---

#### [Important] A-7: setState During Render Phase
**File:** `components/BoardSidebar.tsx:25-28`

`setActiveTab` called directly in render body, not in `useEffect`. React anti-pattern that can cause double-renders.

**Correction:** Move to `useEffect` with `requestedTab` dependency.

---

#### [Important] A-8: Mutable Tab Objects via Object.assign
**File:** `store/board-store.ts:279-283`

`updateActiveTab` mutates tab objects directly. Works with current notification pattern but fragile under refactoring.

**Correction:** Document as intentional, or switch to immutable updates.

---

#### [Minor] A-9: No Context Menu Viewport Clamping
**File:** `components/ContextMenu.tsx:133`

Menu positioned at raw screen coordinates. Overflows when right-clicking near viewport edges.

**Correction:** Measure menu element after render, clamp to viewport bounds.

---

#### [Minor] A-10: DOM Overlays Created Imperatively in Renderer
**File:** `renderer/BoardRenderer.ts`

HUD, tooltip, perf overlay created as raw DOM elements bypassing React lifecycle.

**Correction:** Move to React portals rendered inside `BoardViewerPanel`.

---

#### [Minor] A-11: Browser Zoom Blocked Globally
**File:** `hooks/useKeyboardShortcuts.ts:130-137`

Ctrl+wheel/Ctrl+Plus blocked document-wide instead of per-canvas.

**Correction:** Scope zoom blocking to board canvas elements only.

---

#### [Minor] A-12: Sidebar Width Polling (200ms setInterval)
**File:** `store/dockview-api.ts:60-64`

Polls sidebar width every 200ms because Dockview lacks resize events.

**Correction:** Use `ResizeObserver` on the sidebar group's DOM element.

---

### Positive Findings
- **Dockview integration** is clean with `dockview-api.ts` abstraction layer
- **Keyboard shortcuts** have Mac/Windows detection and formatting
- **Store architecture** is consistent and well-bounded
- **`buildBoardScene()` shared function** ensures visual consistency between renderer and settings mockup
- **Error recovery** for WebGL context loss is thorough

---

## 5. Topic 4: GFX Optimizations & Performance

### Executive Summary
The rendering pipeline is well-optimized with on-demand rendering, spatial grid culling, BitmapText with quantized font steps, batched borders, and event system bypass. The architecture is fundamentally sound. Remaining gains are in hit-testing (O(N) linear scan), transient BitmapText allocations during selection, and net line draw call fragmentation.

### Issues

#### [Important] G-1: Hit-Test Performs O(N) Linear Scan on Every Pointer Event
**File:** `renderer/BoardRenderer.ts:2801-2873`

`hitTest()` iterates ALL parts twice (pin-level + bounds) on every click and hover. For 3,075 parts + 11,129 pins = ~14K distance computations per pointermove.

**Correction:** Build spatial hash/grid index at scene construction time. Look up only cells near the pointer.

**Expected improvement:** Hit-test drops from ~0.5ms to ~0.05ms per event.

---

#### [Important] G-2: BitmapText Label Clones Allocated on Every Selection Change
**File:** `renderer/BoardRenderer.ts:2046-2076`

`renderSelection()` creates new `BitmapText` objects for every affected part's label when net-dim is active. Previous labels destroyed via `removeChildren()`. Each hover triggers this cycle.

**Correction:** Maintain a pool of reusable BitmapText objects. Update text/position/visibility instead of destroy/recreate.

**Expected improvement:** Eliminates GC pressure during hover-based dim updates.

---

#### [Important] G-3: Net Line Fade+Dash Creates Excessive stroke() Calls
**File:** `renderer/BoardRenderer.ts:2720-2758`

Each of 4 fade steps + remainder issues its own `stroke()`. For 20 target parts = potentially 100 stroke() calls per frame during pulse animation.

**Correction:** Batch all segments of the same alpha level into a single `moveTo/lineTo` chain before calling `stroke()`.

**Expected improvement:** ~5x fewer draw calls for animated net lines.

---

#### [Important] G-4: Trace Hit-Test is O(N) With No Spatial Index
**File:** `renderer/BoardRenderer.ts:2889-2917`

Iterates every trace segment for point-to-line distance. Allegro/TVW boards may have tens of thousands of traces.

**Correction:** Build grid index for trace segments at scene construction.

---

#### [Minor] G-5: Settings Changes Trigger Full Scene Rebuild
**File:** `renderer/BoardRenderer.ts:1767-1790`

Any settings change calls `invalidateAllScenes()` + `activateScene()`, rebuilding the entire PixiJS scene graph.

**Correction:** Categorize settings into "visual-only" (update existing Graphics styles) vs "structural" (require rebuild). Visual changes skip rebuild.

**Expected improvement:** Saves 50-200ms per settings tweak.

---

#### [Minor] G-6: renderSelection() Recomputes Part Bounds
**File:** `renderer/BoardRenderer.ts:1884-1904`

`computePartRenderBounds()` and `computePartRenderPoly()` recomputed for each highlighted part despite being computable at scene build time.

**Correction:** Cache render bounds/polygon per part at scene build time in a `Map<number, {...}>`.

---

#### [Minor] G-7: BitmapFont Atlas Resolution 8x May Be Excessive for Small Fonts
**File:** `renderer/board-scene.ts:142`

`BITMAP_FONT_RESOLUTION = 8` means 4-mil font → 32px effective. With 11 font steps + shadow variants = 22+ atlas textures.

**Correction:** Lower to 4x for font sizes below 8. Halves GPU memory for small-text atlases.

---

#### [Minor] G-8: Greedy MST for Net Lines is O(N²)
**File:** `renderer/BoardRenderer.ts:2539-2558`

For each node added to `connected`, scans all remaining nodes. Noticeable for nets with 50+ pins.

**Correction:** Not a hot path (runs only on `netLinesDirty=true`), but could use a priority queue for large nets.

---

### Optimization Roadmap

| Priority | Issue | Expected FPS Impact | Effort |
|----------|-------|-------------------|--------|
| 1 | G-1: Spatial hash for hit-test | Hover ~0.5ms→0.05ms | Medium |
| 2 | G-2: Pool BitmapText clones | Eliminates GC micro-stalls | Low |
| 3 | G-3: Batch net line strokes | ~5x fewer draw calls during animation | Low |
| 4 | G-5: Categorize settings changes | Skip rebuild for visual changes | Medium |
| 5 | G-6: Cache part render bounds | Less work during selection render | Low |
| 6 | G-4: Spatial index for traces | Required for Allegro/TVW boards | Medium |
| 7 | G-7: Reduce atlas resolution | ~50% GPU mem for small text | Low |

### Positive Findings
- **On-demand rendering** (`needsRender` flag) — zero GPU cost when idle
- **Spatial grid culling** for pins — PixiJS skips off-screen groups entirely
- **Font-size-group LoD** — O(groups) not O(labels) visibility toggle
- **BitmapText with quantized font steps** — atlas sharing across 11 discrete sizes
- **Event system bypass** (`interactiveChildren = false`) — no scene graph walk for pointer events
- **Border batching** — 3,000 part borders collapsed to 2 draw calls
- **Text hide during zoom** — O(1) container toggle during zoom
- **Pin color batching** in grid cells — one fill per unique color per cell
- **Ticker pause for inactive tabs** — zero CPU for hidden panels
- **Net line segment caching** — geometry recomputed only when dirty

---

## 6. Topic 5: Memory & Multi-Board Performance

### Executive Summary
There is a **critical WebGL context accumulation problem** — contexts are never released due to the intentional `app.destroy()` avoidance. PDF documents are never unloaded when panels close. Under the target scenario (3 boards + 3 PDFs), estimated memory is 400-600 MB JS heap + 3-4 leaked WebGL contexts approaching browser limits.

### Memory Estimates: 3 Boards (3K components each) + 3 PDFs (50 pages each)

| Resource | Per-Instance | Total |
|----------|-------------|-------|
| BoardData in JS heap | 15-30 MB | 45-90 MB |
| PixiJS scene graph (sceneCache) | 20-40 MB | 60-120 MB |
| WebGL contexts (active) | 1 per renderer | 3 (within limit) |
| WebGL contexts (leaked) | 1 per close/reopen | 0-N (**unbounded**) |
| PDF originalBuffer | 5-15 MB | 15-45 MB |
| PDF textPages + proxy | 7-15 MB | 21-45 MB |
| PDF page render cache (ImageBitmaps) | Up to 20 shared | 50-200 MB GPU |
| **Estimated Total JS Heap** | | **200-350 MB** |
| **Estimated Total GPU Memory** | | **150-350 MB** |

### Growth After Multiple Open/Close Cycles

| Resource | Pattern |
|----------|---------|
| WebGL contexts | +1 per board close (**will hit browser limit of 8-16**) |
| PDF documents | +1 per PDF close (**unbounded heap growth**) |
| IndexedDB cache | +1 per unique board/PDF (**unbounded disk growth**) |

### Issues

#### [Critical] M-1: WebGL Context Leak — Never-Destroyed PixiJS Applications
**File:** `renderer/BoardRenderer.ts:361-406` (teardownForReinit), `:3090-3163` (destroy)

Due to the PixiJS v8 `GlobalResourceRegistry.clear()` bug, `app.destroy()` is never called. But `destroy()` doesn't null out `this.app`, `this.viewport`, or any PixiJS objects. The `onTick` arrow function captures `this`, creating a strong reference cycle preventing GC. `reinitApp()` creates a new Application at line 543 without cleanup of the old one.

After opening/closing 4-5 boards, the user will hit the browser's WebGL context limit and new renderers will fail to initialize.

**Correction:** After removing canvas from DOM:
1. Call `this.app.renderer.gl.getExtension('WEBGL_lose_context')?.loseContext()` to force GPU context release
2. Null out `this.app`, `this.viewport`, `this.activeScene` in `destroy()` to break reference cycles
3. Do the same in `teardownForReinit()` for the old Application before creating new one

---

#### [Critical] M-2: PDF Documents Never Unloaded When Panel Closes
**Files:** `App.tsx:171-187` (onDidRemovePanel), `store/pdf-store.ts:1168-1179` (closeFile)

When a PDF panel is closed via Dockview X button, `App.tsx` only calls `boardStore.removePdfBinding()` — never `pdfStore.closeFile(fileName)`. The `PdfDocument` stays in `pdfStore._documents` indefinitely, retaining `originalBuffer` (full ArrayBuffer), `doc` (PDFDocumentProxy), `strippedDoc`, and `textPages`.

Three unclosed PDFs leak 20-60 MB.

**Correction:** In `onDidRemovePanel` for PDF panels, add `pdfStore.closeFile(pdfFileName)` and `boardStore.removePdf(pdfFileName)`.

---

#### [Important] M-3: IndexedDB Cache Has No Size Limit or Eviction
**File:** `store/board-cache.ts`

Writes to IndexedDB with `put()` but never checks total size. Each board = 2-5 MB, each PDF text cache = 1-3 MB. Grows unbounded over time.

**Correction:** Add max entry count (e.g., 20 boards, 30 PDFs) with timestamp-based LRU eviction after each `put()`.

---

#### [Important] M-4: All Board Data Retained in Memory for All Open Tabs
**File:** `store/board-store.ts:98-99, 319-320`

`_tabs` holds `BoardTab` objects with full `board: BoardData`. Three boards = 45-90 MB of parsed data in heap. Each `BoardRenderer` also maintains a `sceneCache` with the full PixiJS scene graph.

**Correction:** Consider "active tab only" approach — evict inactive board scenes from `sceneCache` after timeout, reload from IndexedDB when switching back. Add option to limit cached scenes (e.g., 2 most recent).

---

#### [Important] M-5: followDebounceTimer Not Cleared in destroy()
**File:** `renderer/BoardRenderer.ts:3090-3163`

`destroy()` clears `selectionBlinkTimer`, `zoomSettleTimer`, `netLineSettleTimer`, `_pendingFitTimer`, `wheelIdleTimer` — but NOT `followDebounceTimer` (declared at line 215). Timer fires after destruction.

**Correction:** Add `clearTimeout(this.followDebounceTimer)` at top of `destroy()`.

---

#### [Important] M-6: PDF Page Render Cache — 20 ImageBitmaps at Up to 64MB Each
**File:** `panels/PdfViewerPanel.tsx:58-95`

Module-level `_pageCache` holds up to 20 `CachedRender` entries with `ImageBitmap`. At max canvas dimensions (4096x4096), a single entry = ~64 MB GPU. Worst case = ~1.3 GB.

**Correction:** Reduce `PAGE_CACHE_MAX` to 8-10 or make dynamic based on total pixel area (e.g., cap at 100M pixels total).

---

#### [Important] M-7: Offscreen Canvas Pool Never Releases Memory
**File:** `panels/PdfViewerPanel.tsx:29-39`

Pool holds up to 4 `HTMLCanvasElement` at potentially 4096x4096 resolution permanently.

**Correction:** Reset canvas dimensions to 1x1 before returning to pool: `c.width = 1; c.height = 1` in `releaseCanvas()`.

---

#### [Minor] M-8: Search Cache Holds Reference to Closed Board
**File:** `store/board-store.ts:649-653`

`_cachedSearchBoard` retains strong reference to last-searched BoardData after tab close.

**Correction:** Null `_cachedSearchBoard` in `closeTab()` if it belongs to the closed tab.

---

#### [Minor] M-9: usePdfStore Snapshot Cache for Closed Documents
**File:** `hooks/usePdfStore.ts:86-112`

`docSnapshots` Map never cleaned up when PDFs close. Small objects but indicates pattern gap.

**Correction:** Clear entry when snapshot shows `isLoaded: false`.

---

### Positive Findings
- **Go backend** is well-implemented: 50MB upload limit, `http.ServeFile` (sendfile), stateless handlers — no backend memory issues
- **Ticker pause for inactive tabs** eliminates CPU cost for hidden panels
- **IndexedDB caching** prevents redundant re-parsing (just needs eviction)
- **`ImageBitmap.close()` on cache eviction** is correctly implemented

---

## 7. Cross-Cutting Findings

Issues that emerged independently from multiple review agents:

### BoardRenderer.ts is the #1 Technical Debt Item
All five agents flagged this file. At 3,164 lines with ~50 responsibilities, it is:
- The god class blocking refactoring (Design agent)
- The source of hit-test performance issues (GFX agent)
- The source of WebGL context leaks (Memory agent)
- The source of timer leaks (Memory agent)
- The source of BitmapText allocation churn (GFX agent)
- Where DOM overlays bypass React (Design agent)

**Recommendation:** Decomposing `BoardRenderer` should be the top priority. Many GFX and memory fixes become simpler once the class is split into focused subsystems.

### PDF Lifecycle is Incomplete
- PDFs are never unloaded on panel close (Memory agent — Critical)
- PDF loading is duplicated in 3 locations (Reusability agent — Important)
- PDF canvas pool never releases memory (Memory agent — Important)
- PDF page cache may consume up to 1.3GB (Memory agent — Important)

**Recommendation:** Fix the lifecycle gap (M-2) first, then consolidate the loading code (R-1), then tune the cache (M-6, M-7).

### Documentation-Code Drift
- BVR side inversion undocumented (Docs agent — Important)
- BRD nails side encoding contradicts spec (Docs agent — Important)
- BDV side-0 handling undocumented (Docs agent — Important)
- PLANNING.md significantly stale (Docs agent — 3 Important issues)

**Recommendation:** Bundle as a single "docs sync" task.

---

## 8. Consolidated Correction Plan

Corrections ordered by combined severity × impact × dependency. Items that unblock others are prioritized.

### Phase 1: Critical Fixes (Do First)

| ID | Description | Files | Effort |
|----|-------------|-------|--------|
| M-1 | Force WebGL context release on destroy + null references | `BoardRenderer.ts` | Low |
| M-2 | Close PDF documents when panel is removed | `App.tsx`, `pdf-store.ts` | Low |

### Phase 2: Important — Memory & Performance

| ID | Description | Files | Effort |
|----|-------------|-------|--------|
| M-5 | Clear followDebounceTimer in destroy() | `BoardRenderer.ts` | Trivial |
| M-6 | Reduce PDF page cache to 8-10 or area-based | `PdfViewerPanel.tsx` | Low |
| M-7 | Reset pooled canvas dimensions on release | `PdfViewerPanel.tsx` | Trivial |
| M-3 | Add IndexedDB LRU eviction | `board-cache.ts` | Medium |
| G-1 | Spatial hash for hit-testing | `BoardRenderer.ts`, `board-scene.ts` | Medium |
| G-2 | Pool BitmapText label clones | `BoardRenderer.ts` | Low |
| G-3 | Batch net line strokes by alpha | `BoardRenderer.ts` | Low |

### Phase 3: Important — Code Quality

| ID | Description | Files | Effort |
|----|-------------|-------|--------|
| R-1 | Extract shared PDF loading function | `Toolbar.tsx`, `App.tsx`, `LibraryPanel.tsx` → `file-actions.ts` | Low |
| R-2 | Create generic store hook factory | `hooks/` | Low |
| A-5 | Add toast/notification for load errors | `board-store.ts`, new component | Medium |
| A-4 | Make context menu extensible | `ContextMenu.tsx`, `context-menu-store.ts` | Medium |
| A-6 | Resolve Cmd+F shortcut conflict | `keyboard-shortcuts.ts` | Low |
| A-7 | Fix setState during render in BoardSidebar | `BoardSidebar.tsx` | Trivial |

### Phase 4: Important — Documentation Sync

| ID | Description | Files | Effort |
|----|-------------|-------|--------|
| D-1 | Update PLANNING.md BoardData model | `docs/PLANNING.md` | Low |
| D-2 | Update PLANNING.md file tree | `docs/PLANNING.md` | Low |
| D-3 | Update PLANNING.md phase status | `docs/PLANNING.md` | Low |
| D-4 | Reconcile BRD nails side encoding | `BRD_FORMAT.md` or `brd-parser.ts` | Low |
| D-5 | Document BDV side-0 behavior | `BDV_FORMAT.md` | Low |
| D-6 | Document BVR side inversion | `bvr1-parser.ts`, `bvr3-parser.ts` | Trivial |
| D-7 | Fix CLAUDE.md parser signature | `CLAUDE.md` | Trivial |

### Phase 5: Architecture Refactoring

| ID | Description | Files | Effort |
|----|-------------|-------|--------|
| A-1 | Decompose BoardRenderer into 6 subsystems | `renderer/` | High |
| A-3 | Split monolithic CSS into modules | `index.css` → per-component | High |
| R-6 | Extract render-geometry from render-settings | `store/` | Low |
| M-4 | Add scene cache eviction for inactive boards | `BoardRenderer.ts` | Medium |

### Phase 6: Nice-to-Have

| ID | Description | Effort |
|----|-------------|--------|
| R-3 | Parser finalization helpers | Low |
| R-4 | Store emitter base class | Low |
| R-5 | Delete dead BoardCanvas.tsx | Trivial |
| A-2 | Add minimum ARIA attributes | Medium |
| A-9 | Context menu viewport clamping | Low |
| A-10 | Move DOM overlays to React portals | Medium |
| A-11 | Scope zoom blocking to canvas only | Low |
| A-12 | Replace sidebar polling with ResizeObserver | Low |
| G-5 | Categorize settings changes (skip rebuild) | Medium |
| G-6 | Cache part render bounds at build time | Low |
| G-4 | Spatial index for trace hit-test | Medium |
| G-7 | Lower atlas resolution for small fonts | Low |

---

## 9. What Was Done Well

The review agents consistently praised these aspects:

1. **On-demand rendering** — `needsRender` flag means zero GPU cost when idle
2. **Spatial grid culling** — Off-screen pin groups skipped entirely by PixiJS
3. **BitmapText with quantized font steps** — Efficient atlas sharing across 11 sizes
4. **Border batching** — 3,000 part borders → 2 draw calls
5. **Parser registry pattern** — Clean, extensible, adding a format = 2 files + 1 line
6. **Centralized types** — Zero type duplication, clean `parsers/types.ts`
7. **No circular dependencies** — Import graph is strictly layered
8. **Format specifications** — Thorough, well-structured, consistent formatting
9. **Parser file headers** — Clear block comments explaining format, pipeline, references
10. **Store architecture** — Consistent class-based singletons with clean boundaries
11. **Dockview abstraction** — `dockview-api.ts` properly encapsulates panel management
12. **Go backend** — Stateless, bounded uploads, minimal footprint
13. **PixiJS destroy documentation** — Critical institutional knowledge properly preserved
14. **WebGL context loss recovery** — `teardownForReinit()` pattern is battle-tested
15. **Ticker pause for inactive tabs** — Zero CPU for hidden panels

---

**Total issues found: 39** (4 Critical, 16 Important, 14 Minor, 5 Suggestions)
**Estimated recoverable duplication: ~280 lines**
**Estimated memory savings from fixes: 100-300 MB in multi-board scenario**
**Estimated WebGL context leak: eliminated (currently unbounded)**

---

## 10. Resolution Status

### Fixed (22 items)

| ID | Description | Status |
|----|-------------|--------|
| M-1 | WebGL context leak — `WEBGL_lose_context` + null refs in destroy/teardown | **Fixed** |
| M-2 | PDF never unloaded — `closeFile` + `removePdf` on panel remove | **Fixed** |
| M-3 | IndexedDB LRU eviction (20 boards, 30 PDF text entries) | **Fixed** |
| M-5 | followDebounceTimer not cleared in destroy() | **Fixed** |
| M-6 | PDF page cache reduced to 10 entries + 80M pixel area cap | **Fixed** |
| M-7 | Canvas pool resets dimensions to 1x1 on release | **Fixed** |
| M-8 | Search cache reference cleared on tab close | **Fixed** |
| G-1 | Spatial hash grid for O(1) hit-testing | **Fixed** |
| G-2 | BitmapText pool in netLabelLayer (reuse instead of destroy/recreate) | **Fixed** |
| G-3 | Batched net line strokes (single stroke() for non-dashed segments) | **Fixed** |
| R-1 | Shared `openPdfFiles()` in `store/file-actions.ts` | **Fixed** |
| R-2 | Generic `createStoreHook` factory (3 hooks refactored) | **Fixed** |
| R-5 | Dead `BoardCanvas.tsx` deleted | **Fixed** |
| A-5 | Toast notification system for load errors | **Fixed** |
| A-6 | Cmd+F shortcut conflict resolved (merged into focusSearch) | **Fixed** |
| A-7 | setState during render in BoardSidebar → useEffect | **Fixed** |
| D-1 | PLANNING.md BoardData model updated (9 formats, all fields) | **Fixed** |
| D-2 | PLANNING.md file tree replaced with stable high-level description | **Fixed** |
| D-3 | PLANNING.md phase status updated (PDF marked done) | **Fixed** |
| D-5 | BDV side-0 and dynamic flipY documented | **Fixed** |
| D-6 | BVR side inversion documented in both parsers | **Fixed** |
| D-7 | CLAUDE.md parser signature corrected | **Fixed** |

### Deferred — Won't Fix

| ID | Description | Reason |
|----|-------------|--------|
| A-1 | Decompose BoardRenderer into 6 subsystems | Kept monolithic — renderer is inherently coupled, single-dev project, well-structured with comment sections |
| A-3 | Split monolithic CSS into modules | Low priority for current project scope |

### Remaining (10 items, all Minor/Nice-to-Have)

| ID | Description | Effort |
|----|-------------|--------|
| D-4 | BRD nails side encoding — needs sample verification | Low |
| D-8 | TVW spec TvwBoardData replaced with field mapping | **Fixed** |
| R-3 | Parser finalization helpers | Low |
| R-4 | Store emitter base class | Low |
| A-2 | Minimum ARIA attributes | Medium |
| A-9 | Context menu viewport clamping | Low |
| A-10 | Move DOM overlays to React portals | Medium |
| A-11 | Scope zoom blocking to canvas only | Low |
| G-4 | Spatial index for trace hit-test | Medium |
| G-5 | Categorize settings changes (skip rebuild for visual-only) | Medium |
| G-6 | Cache part render bounds at scene build time | Low |
| G-7 | Lower BitmapFont atlas resolution for small fonts | Low |
