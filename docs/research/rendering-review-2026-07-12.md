# Rendering Review — 2026-07-12

*Scope: `src/frontend/src/renderer/BoardRenderer.ts` (5,620 lines) and
`src/frontend/src/renderer/board-scene.ts` (2,058 lines) at v0.31.35.
Performance-focused review: runtime jank, build-time waste, leaks. Two
independent review passes (runtime host / scene build), top findings
spot-verified against source. Companion docs:
`wasm-webgpu-acceleration-plan.md` (architecture-level plan; this review is
the tactical layer beneath it — most findings below are worth fixing even if
the instancing phases never land) and
`docs/plans/2026-07-12-parse-time-optimization-plan.md` (parse side).*

**Verification status:** findings marked ✅ were re-checked against the code
by a second pass; unmarked ones carry exact citations from the reviewing
pass but were not independently re-verified.

---

## A. Runtime jank (per-pointermove / per-frame)

### A1 ✅ Unthrottled hover chain with two forced reflows per mouse move
`handleHover` (BoardRenderer.ts:4873) runs on every raw `pointermove`
(60–120 Hz): 2× `viewport.toWorld`, a `hitTestStack` that allocates a `Set`
+ `.sort` + `.map` (4739/4818-4819), then `showTooltip` unconditionally
rewrites all six spans **including two `innerHTML` parses**
(4980, 4987) and reads `el.offsetWidth/offsetHeight` immediately after
writing `style.left/top='0'` (4991-4998) — two synchronous reflows per
move, even when the hovered target didn't change.
**Fix:** cache a `lastHoverKey = partIndex|pinIndex|traceIndex`; on
unchanged key, skip all content writes and measurements (reposition only).
Coalesce the handler to one run per rAF. Biggest idle-interaction win in
the file.

### A2 ✅ `traceHitTest` linearly scans every trace on every hover miss
BoardRenderer.ts:4823-4863 — called whenever no pin is hit (i.e. most
moves), loops **all** `board.traces` with a point-to-segment distance test.
Parts have `hitGrid`; traces have no spatial structure. On trace-heavy
boards (TVW/Allegro, 10k-100k segments) this is millions of ops/sec while
moving over empty board.
**Fix:** bucket segments into a spatial hash parallel to `buildHitGrid`
(4646-4694), and only run after a hover-key change (A1).

### A3 Hover in ambient-dim mode triggers full `renderSelection` per net crossed
`setHoverNet` (4938-4939) → full clear+redraw of the dim overlay, search
outlines, label pool. `renderSelection` also unconditionally sets
`netLinesDirty = true` (3346), forcing the next pulse frame to re-run the
O(K² log K) chain recompute (4331-4353) even when the selection net didn't
change.
**Fix:** dedupe on `hoverNet` + rAF-throttle; set `netLinesDirty` only when
the selection actually changed.

### A4 `redrawMultiHighlight` rebuilds per viewport-moved frame
Every pan/zoom frame (1167 → 5217) clears and re-strokes the worklist
highlight outlines, rebuilding the `refdes→index` map (`buildRefdesIndex`,
5255) each frame during inertial pans.
**Fix:** cache the refdes index (invalidate on worklist/board change); skip
the redraw when neither the highlight set nor the screen-space stroke width
changed.

### A5 Net-line pulse rebuilds full path geometry 60×/s to animate a color
`renderNetLines` (4355-4396) clears + re-issues `moveTo/lineTo` for every
segment each pulse frame; only `lerpColor` (4379) changes.
**Fix:** retain the built path and re-stroke with the new tint only (or
two pre-baked Graphics cross-faded by alpha).

---

## B. Heavy-when-fired paths

### B1 `updateBorderWidths` re-emits all border geometry per LoD step
board-scene.ts:592-614, driven from `updateLoD` on any >10% scale change:
past a 2% tolerance (checked against `batches[0]` only) every batch gets
`clear()` + full path rebuild + re-stroke.
**Fix:** retain paths, vary stroke width only; or per-batch tolerance.

### B2 ✅ `rebuildLabelCounts` walks every label with the perf overlay closed
BoardRenderer.ts:1648 → 1652-1658: full iteration of all part+pin labels on
every LoD visibility flip; consumed **only** by `flushPerfOverlay` (1505).
**Fix:** `if (changed && this.perfVisible)` — one-line.

---

## C. Leaks / unbounded growth

### C1 ✅ `viewportStates` strongly retains every derived board
BoardRenderer.ts:546 — `Map<BoardData, ViewportState>` keyed on
**derived** boards, which get a fresh object on every fold/filter toggle;
cleared only in `destroy()` (5615). Each toggle pins a full derived
`BoardData` (potentially tens of MB) for the renderer's lifetime. The
scene cache deliberately keys on `rawBoard` to avoid exactly this
(475-478); this map predates that fix.
**Fix:** `WeakMap<BoardData, ViewportState>` (only ever direct-key lookup,
2106) — one-line, clearest true leak in the review.

### C2 `sceneCache` / `hitGridCache` have no eviction
471/504, populated 2088-2089/4693: one full GPU scene per
(rawBoard, foldMode, selectedBoardIndex), destroyed only on settings/theme
invalidation or teardown. Board-hopping across many tabs/fold modes keeps
every scene GPU-resident. (Destruction itself is correct —
`destroy({children:true})` with persistent overlays detached first,
2287-2306 — this is retention, not a destroy bug.)
**Fix:** small LRU (2-3 scenes); evicting destroys the scene + its hit-grid
entry.

---

## D. Multi-tab / rebuild storms

### D1 ✅ Settings and theme changes rebuild every open tab, not just the active one
`onBoardUpdate` guards on active tab (2333); `onSettingsUpdate` (2981) and
`onThemeUpdate` (3086) do not — one theme flip triggers a synchronous
~140 ms `scheduleRebuild` in **every** open renderer, back-to-back.
**Fix:** on inactive tabs set a `sceneDirty` flag and rebuild on
tab-activation/`resume()` instead.

### D2 Settings diff `JSON.stringify`s object fields on every notify
3013-3032: `applyGlobal` structured-clones settings, so object fields are
always fresh references; the diff then stringifies each to detect change,
on every settings notification. Allowlist semantics are correct; the
mechanism is just heavier than needed.
**Fix:** settings-version counter, or shallow primitive compare + hash for
object fields.

---

## E. Scene-build waste (`buildBoardScene`)

*These compound with the parse plan and the instancing phases — but all are
cheap standalone fixes. E1-E4 alone touch every one of ~100k pins/labels.*

### E1 ✅ Per-pin net-keyed work recomputed instead of memoized per net
board-scene.ts:1229-1231 (and pads 975-976): `pin.net?.toUpperCase()`
(fresh string per pin), `isOutlineOnlyNet`, `resolvePinColor` — all pure
functions of `(net, side)` — run per pin, 100k+ times for a few thousand
distinct nets. `resolvePinColor` runs twice more per pad.
**Fix:** one build-scoped `Map<net, {netUpper, isNc, colorTop, colorBottom}>`.

### E2 ✅ Theme color getters re-derive `hexToInt(activeTheme()...)` per label
BOARD_COLORS getters (board-scene.ts:46-58) are property getters that parse
a hex string on **every access**; label paths hit them per label
(1413, 1484, 1497, 1517, 1670) — up to ~200k theme lookups + hex parses per
build. The theme cannot change mid-build.
**Fix:** hoist to locals at the top of `buildBoardScene`.

### E3 `computePinRadius` recomputed 3-5× per pin
1190, 1333, 1393, 1454, 1512, 1538 — same `Math.min(computePinRadius(…),
maxNonOverlapRadius)` per site.
**Fix:** compute once at the top of the pin body.

### E4 Font-name resolution allocates a template string + Set probe per label
`ensurePinFont`/`ensureShadowFont` (401-417, 450-469) build
`` `board-pin-${size}-r${mult}` `` and probe the installed-set on every
call — per label — though quantization leaves only ~10-15 distinct sizes.
**Fix:** memoize resolved font-family names per quantized size.

### E5 Via-layer connectivity is quadratic on big nets and rebuilt every rebuild
1951-1977: per via, a linear scan of all trace endpoints on its net —
GND × thousands of vias × thousands of endpoints. Geometry-only, yet
recomputed on every theme/settings rebuild.
**Fix:** endpoint spatial grid + cache the result keyed on board identity.

### E6 Trace chaining: string-keyed endpoint hash, recomputed every rebuild
91-156, 816-847: `keyOf` builds `` `${x},${y}` `` strings per endpoint;
tail key recomputed in the walk; pure function of geometry, reruns on every
theme rebuild.
**Fix:** numeric keys; cache polylines across rebuilds.

### E7 Label pipeline: ~5 passes over every label
Created into deferred arrays (1149-1151, 1419-1526) → re-routed per part
with a second `posToCell` (1693-1706) → flushed (1786-1828) → flattened via
spread (1883-1896) → bucketed. Two 100k-element spread allocations.
**Fix:** route labels into their grid cell + font-size bucket at creation.

### E8 ✅ `pinColIndex` array allocated per part unconditionally
1208: allocated + filled for every part (incl. 2-pin, and with pin numbers
off) but only read under `isMultiPin && s.showPinNumbers` (1403, 1465).
**Fix:** move allocation inside that guard.

### E9 Assorted per-pin/per-part churn
Loop-invariant per part recomputed per pin (`padShape` override 1253/1338,
`ncGfx` 1233 ✅); `posToCell` allocates a tuple per call (1071) ×
~300k calls; `part.pins.map(p => p.radius ?? 0)` per multi-pin part (1194);
diag-2-pin `map`+spread min/max (1317-1321); identical-branch `instanceof`
ternary per two-pin label (1703-1704); full pin-count reduce pass (1031)
recomputed per rebuild.
**Fix:** hoist/inline each; all mechanical.

---

## Checked and clean

- **Zoom-lerp settle** (572-591): terminates cleanly, no runaway renders.
- **needsRender discipline**: net-line static path correctly gated (620);
  render-on-demand removal of `app.render` from the ticker holds.
- **Culling after rotate/mirror/butterfly**: `cullArea` rects are local-frame;
  CullerPlugin transforms through `worldTransform` — correct through
  `applyFlips` and the butterfly reparent. No bug.
- **Timer/listener hygiene in teardown**: all seven timers cleared
  (5484-5495), canvas + context-loss listeners unbound (739-747). The leak
  surface is store subscriptions on inactive tabs (D1) and the two caches
  (C1/C2), not DOM listeners.
- **Scene destruction**: `destroy({children:true})` with persistent overlays
  detached first — correct.

## Suggested fix order (impact / effort)

1. **A1 + A2** — hover-key early-out + rAF coalescing + trace spatial hash
   (dominates idle interaction cost).
2. **C1** — `WeakMap` one-liner (true leak).
3. **B2** — perf-overlay gate one-liner.
4. **D1** — inactive-tab rebuild deferral (multi-tab CPU spike).
5. **E1-E4, E8-E9** — mechanical build-loop hoists/memos; worthwhile even
   with the instancing plan pending, since they also shrink every
   settings-change rebuild today.
6. **E5-E7, A3-A5, B1, C2, D2** — as touched, or bundled with the
   instancing phases (E7 disappears entirely under Phase 2 of the
   acceleration plan).
