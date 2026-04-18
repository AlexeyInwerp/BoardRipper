# XZZ parser + outline rendering — dead-session progress

**Status:** in-progress (uncommitted). Session died before verification / commit.
**Files touched:** `src/frontend/src/parsers/xzz-parser.ts`, `src/frontend/src/renderer/board-scene.ts`.
**Sample available:** `samples/820-00165.pcb` (1.3 MB, XZZ `.pcb`).

## What the session was trying to fix

Outline rendering on XZZ `.pcb` files was visibly broken. Multiple distinct glitches
were tangled together, each with its own root cause:

| # | Glitch | Root cause |
|---|--------|------------|
| 1 | "Star burst" arcs on iPhone files | Arc start/end angles parsed with wrong divisor (`/10` instead of `/XZZ_SCALE=10000`). |
| 2 | "Spaghetti" lines crossing the board | Shared `chainSegments()` in `types.ts` is globally greedy — jumps between disconnected outline components. |
| 3 | Diagonal lines closing open L-bracket features | `drawOutline()` called `gfx.closePath()` on every sub-path unconditionally; open chains got a spurious closing stroke. |
| 4 | Flat / multi-board files rendered half-missing with mirrored parts | `findFoldAxis()` had a default "Y midpoint fold" fallback that fired on non-butterfly files, mirroring real parts into phantom bottom-side positions and clipping half the outline. |

Secondary scope expanded during the session:

| # | Item | Status |
|---|------|--------|
| 5 | XZZ multi-layer trace data (copper / mask / silkscreen) | Added — emitted from block types `0x01`/`0x05` on layers 1–17. |
| 6 | Trace mirroring on butterfly fold | Added — prevents parts-vs-traces misalignment on narrow sub-boards. |

## Changes made (uncommitted)

### [src/frontend/src/parsers/xzz-parser.ts](src/frontend/src/parsers/xzz-parser.ts)

- **Arc angle parsing (line ~788):** `ri32(blockData, 16) / 10` → `/ XZZ_SCALE`. Reference: OBV `XZZPCBFile.cpp:258-260`.
- **`clusterSegments()`:** union-find by endpoint proximity (eps=1.0 mil). Returns an array of segment-index groups, one per connected component.
- **`chainComponent()`:** topological walker for a single component. Bucketed endpoint lookup; prefers degree-1 starts so open walks run end-to-end; walks only segments that *share* an endpoint (no long-distance jumps).
- **`chainByComponent()`:** cluster + per-component walk + NaN pen-ups between components. Replaces `chainSegments()` at line 1009.
- **`findFoldAxis()`:** removed midpoint-fold fallback (lines ~670–682 in old code). Returns `null` when no butterfly signal. Rewrote the header doc to spell out the three .pcb layout styles (unfolded butterfly, multi-board assembly, flat single-side).
- **Block `0x01` (arc) handler:** now reads `width` and `netIndex` past the core arc fields; linearizes arcs on layers 1–17 into trace segments (9 sub-segs, matches OBV `numPoints`).
- **Block `0x05` (line) handler:** same treatment — reads `width` + `netIndex`, emits traces for layers 1–17.
- **Trace mirroring:** runs inside the butterfly-fold branch, flips `(x1,y1)-(x2,y2)` for bottom-side traces around the fold axis.
- **Layer ID → 0-based index mapping:** `LAYER_NAME_HINT` naming table + per-file sorted `usedLayers` → `layerNames` list. `BoardData.traces` and `BoardData.layerNames` populated when traces are present.
- **Parser log:** added a flat-path log line `(pcb flat) no butterfly signal …` and a trace-summary line `(pcb traces) N segments across K layer(s): …`.

### [src/frontend/src/renderer/board-scene.ts](src/frontend/src/renderer/board-scene.ts)

- **`drawOutline()`:** introduced `CLOSE_EPS = 2.0`. Tracks each sub-path's first point; `closePath()` only fires when the sub-path's last point is within `CLOSE_EPS` mils of the first. Open chains are left open so they don't render a diagonal closing stroke.

## What is *not* done

- [x] ~~`PARSER_VERSION` not bumped.~~ Bumped to `3` in [board-cache.ts:23](src/frontend/src/store/board-cache.ts#L23).
- [x] ~~Type-check not run.~~ `npx tsc --noEmit` passes. `Trace` exported from `parsers/types.ts:44`; `BoardData.traces` / `BoardData.layerNames` fields present.
- [ ] **Visual verification still pending.** Numbers improved dramatically (see "Continuation work" below), but the user has not yet opened the `.pcb` files in the dev server to confirm.

## Continuation work (2026-04-18 session)

### New glitch identified: arc sub-segs fragment into 2-point orphans

Analyzed all available `.pcb` samples with a Node harness that parses the file and dumps outline sub-path stats. On iPhone13Pro AP, the walker emitted 34 sub-paths for 343 segments grouped into only 10 clusters — proving the walker was splitting connected components. Instrumentation showed 9 consecutive arc sub-segs (one rounded corner) each emitted as a separate 2-point chain, with shared endpoints bit-exactly equal across sub-paths.

### Root cause

[`chainComponent()`](src/frontend/src/parsers/xzz-parser.ts) walks only forward from the seed segment. When the seed is an interior segment of a long chain whose neighbor on one side was already consumed by an earlier walk, the walker can only advance 1 step and then breaks — emitting a 2-point chain. The rest of the arc then seeds more 2-point chains, one per remaining segment, because each one's "forward" direction leads to an already-used neighbor.

### Fix: bi-directional walker

Rewrote the walker to grow every chain from **both endpoints** of its seed segment. Added `walkFrom(fromPt, used, out)` helper; each new chain runs `walkFrom(s0.p2, ...)` into `forward` and `walkFrom(s0.p1, ...)` into `backward`, then stitches `[reversed backward, s0.p1, s0.p2, ...forward]`.

Side effect: degree-counting (`degreeAt`) is no longer load-bearing for correctness — the bi-directional walk handles any seed orientation. Renamed to `degreeAtBuckets` and kept only as a heuristic for seed ordering (leaf-first) so open walks ship out leaf-to-leaf instead of bouncing.

### Verification

Re-ran the Node analyzer across all 8 `.pcb` samples in `samples/BROKEN/PCB/` + `samples/820-00165.pcb`.

| File | Sub-paths before | Sub-paths after |
|------|-----------------:|----------------:|
| iPhone13Pro AP | 34 (many 2-pt) | 11 |
| iPhone16E AP *(user)* | 37 | 28 |
| iPhone16E BB | 30 | 24 |
| iPhone16E MB+SUB *(flat)* | 4 | 4 (no regression) |
| iPhoneXS *(flat)* | 4 | 4 (no regression) |
| 820-00165 *(flat)* | 1 | 1 (no regression) |

The residual open sub-paths on butterfly boards reflect real topological branches (Y-junctions on the outline). Rendering them as open polylines is visually correct — no spurious diagonal close and no "spaghetti" cross-board lines.

## Out of scope for this session

- `820-02382-16.pcb` and `A2485 820-02100-H M1 MAX.pcb` produce only 4 outline segments (from `16→4 segs` after butterfly filtering). `findFoldAxis` treats them as butterfly because the outline-component detector sees two tiny groups, but these are multi-board assemblies with sparse outlines — the detection heuristic needs more guards. Filed mentally, not fixed here.
- XZZ butterfly detection occasionally fires on files whose outline is dominated by connector / feature fragments rather than a real board outline.

## Follow-up

Fold ambiguity on multi-board files spawned a separate effort — rather than
improving detection, add a UI that lets the user choose between the parser's
suggestion and a raw "show all sides" view:

- Spec: [2026-04-18-xzz-fold-resolution-design.md](2026-04-18-xzz-fold-resolution-design.md)
- Plan: [../plans/2026-04-18-xzz-fold-resolution.md](../plans/2026-04-18-xzz-fold-resolution.md)
- Branch: `xzz-fold-resolution` (worktree at `Boardviewer-xzz-fold/`)

## References

- [docs/formats/XZZ_FORMAT.md](docs/formats/XZZ_FORMAT.md) — format spec.
- OpenBoardView `src/file_formats/XZZPCBFile.cpp` — reference parser (arc angle divisor at lines 258–260; trace block layouts).
- [src/frontend/src/parsers/types.ts](src/frontend/src/parsers/types.ts) — `chainSegments()` (the greedy chainer still used by BVR3) at line 321.
