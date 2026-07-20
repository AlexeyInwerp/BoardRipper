# Renderer Optimizations Round 2 — Quick-Fix Wave

**Goal:** Close the remaining per-frame and retention findings from
`docs/research/rendering-review-2026-07-12.md` (A3-résidu/A4/A5, C1, D1) plus
the Text-fast-mode polish list from the v0.31.40 whole-branch review. Ships as
one release. The instanced-pins feature (acceleration plan Phase 1) is NOT in
this wave — it gets its own plan next.

**Execution:** inline (single session), per-task commits, `tsc --noEmit` +
`vitest run` per commit, Playwright spot-checks at the end
(label-overlay + memory-release + boardripper count-parity). Line refs
verified against HEAD 2026-07-20 (`perf/renderer-round2` off main).

## Tasks

1. **C1 — `viewportStates` WeakMap** (BoardRenderer.ts:633). Strong `Map`
   keyed on derived boards pins tens of MB per fold/filter toggle. WeakMap;
   remove any `.clear()` in destroy (WeakMap has none — GC handles it).
2. **A4 — multi-highlight redraw caching** (:5606, :4500). Cache the
   refdes→index map per board (invalidate where hitGrid invalidates); skip
   the redraw when (highlight set identity, screen-px stroke width bucket)
   unchanged since the last draw.
3. **A3 residual — `netLinesDirty` only on selection change** (:3686).
   `renderSelection` unconditionally sets `netLinesDirty = true`, forcing the
   O(K² log K) chain recompute on the next pulse frame even for hover-dim
   repaints. Track the (net, partIndex, pinIndex) selection key; set
   `netLinesDirty` only when it changed.
4. **A5 — net-line pulse without geometry rebuild** (:4704). Replace the
   per-pulse-frame clear+moveTo/lineTo with two pre-baked Graphics: base
   color + pulse color, identical geometry, rebuilt only when
   `netLinesDirty`; the pulse animates the overlay's `alpha` (lerp t) only.
   Dashed mode keeps the rebuild path (geometry genuinely changes per frame)
   — gate the fast path on `!netLineDashed`.
5. **D1 — inactive-tab rebuild deferral** (`onSettingsUpdate` :3350-area,
   `onThemeUpdate`). When `boardStore.activeTabId !== this.tabId`, set
   `pendingSettingsRebuild = true` instead of `scheduleRebuild()`; on
   `resume()`/tab-activation, if pending → rebuild once. Snapshot bookkeeping
   (`lastSettingsSnapshot`) must still update so the deferred rebuild diffs
   correctly.
6. **Fast-mode polish batch** (one commit):
   - HUD + perf overlay z-index above the label overlay canvas (z 2 → give
     HUD/perf z 3+).
   - `deepPause()` shrinks the overlay backing store (1×1) — recreated by
     `resize()` on resume.
   - `label-overlay.ts` draw: measure text once per bg-label (reuse for
     anchor + backing rect).
   - Throttle the >12 ms slow-draw `log.perf` line (≥1 s between emits).
   - Arm `cullRefreshFrames` on the `onBoardUpdate` flip path too.
   - Fix stale fixture path in `tests/drag-to-zoom.spec.ts`
     (`samples/820-02016/820-02016.bvr`) so drag-zoom coverage runs again.
7. **Search-dim spotlight parity (attempt, timeboxed):** populate
   `litPartIndices` from the search-match part set when search-dim is active
   with no net selection, so overlay labels spotlight search results like the
   Pixi path dims around them. If the match set isn't cleanly reachable in
   `renderSelection`, defer with a note.

## Verification gates
Per task: `npx tsc --noEmit` + `npx vitest run` (52 green). End of wave:
`npx playwright test tests/label-overlay.spec.ts tests/memory-release.spec.ts
tests/drag-to-zoom.spec.ts tests/boardripper.spec.ts` — drag-to-zoom must now
RUN (not skip); others match baseline. Manual :1234 deploy for user check.

## Deferred out of this wave
D2 (settings stringify diff — low value), B1 (dies under instancing),
C2 scene-cache LRU (bundle with instancing round), BitmapText-path
retirement, instanced pins (own plan).
