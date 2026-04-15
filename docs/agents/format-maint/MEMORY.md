# Format Maintenance — Memory

## Consistency Matrix Snapshot (2026-04-15)

### Field Population by Format

| Field | BVR1 | BVR3 | BRD | BDV | FZ | CAD | XZZ | TVW | Allegro |
|-------|------|------|-----|-----|-----|-----|-----|-----|---------|
| outline | file | file | file | file | synthetic | synthetic | file (chainSegments + butterfly cut) | per-layer | synthetic |
| parts[].side | inverted | inverted | heuristic | direct | direct | direct | derived (butterfly fold / signal clustering) | direct | direct |
| parts[].type | hardcoded smd | from file | hardcoded smd | hardcoded smd | hardcoded smd | from file | hardcoded smd | hardcoded smd | hardcoded smd |
| parts[].origin | computed | file+fallback | computed | file | computed | computed | computed (bounds midpoint) | file | computed |
| parts[].bounds | computed | computed | computed | file∪computed | computed | computed | computed | file | computed |
| pins[].side | inverted | inverted | from part | special side=0 | from part | overridden | from part (butterfly-derived) | from layer | from part |
| pins[].net | yes | yes | yes | yes | yes | yes | yes | yes | yes |
| nails | yes | empty | yes | yes | yes | empty | yes (testPads) | yes | empty |
| nets | buildNets | buildNets | buildNets | buildNets | buildNets | buildNets | buildNets | buildNets | buildNets |
| traces | — | — | — | — | — | — | — | yes | yes (ETCH-class 0x05 tracks; arcs linearized at ~10° via subType&0x40) |
| vias | — | — | — | — | — | — | — | yes | yes (0x33 blocks; diameter from bbox, layers=[] through-hole) |
| layerNames | — | — | — | — | — | — | — | yes | yes (ETCH 0x2A layer list: V165+ string-ref entries, pre-V165 inline names) |
| flipY | false (correct: Y-down) | false (correct: Y-down) | false (descriptor) | per-file auto-detect | true | true | true | true | true |
| multi-revision | — | — | — | — | — | yes (v0.4.3+) | — | — | — |

### Key Decisions to Make

1. Should side inversion be standardized to descriptor flag only, or is parser-level inversion acceptable?
2. Should all parsers attempt mount type detection, or document why they can't?
3. Should origin always be computed from pins (consistent) or preserve file values (accurate)?
4. Allegro trace/via/layerNames coverage: currently "partial" — re-audit once assembler is feature-complete. XZZ has no trace/via data in file format.

### Interface Contract (current de facto)

```typescript
// FormatDescriptor.parse signature
parse: (buffer: ArrayBuffer) => BoardData | Promise<BoardData>

// BoardData must always have:
format: string          // format ID from descriptor
outline: Point[]        // board polygon (explicit or synthetic)
parts: Part[]          // components with nested pins
nails: Nail[]          // test points (empty array if format lacks them)
nets: Map<string, Net> // built via buildNets(parts)
bounds: BBox           // overall bounding box

// BoardData optional:
traces?: Trace[]       // only TVW, Allegro
vias?: Via[]           // only TVW, Allegro
layerNames?: string[]  // only TVW, Allegro
butterflyFoldAxis?: 'x' | 'y'  // only TVW, XZZ
flipY?: boolean        // only BDV (per-file override)
revisions?: CadRevision[]  // only CAD (multi-rev stack, v0.4.3+)
```

## Known Divergences — Status (as of 2026-04-15, a5a2f8e)

Cross-reference: the agent FILE_MAP originally tagged ~12 consistency issues. Status marks are based on current parser source, not tickets.

1. **Side inversion inconsistency** (BVR1/3 invert in-parser vs BRD heuristic vs others direct) — **OPEN**. Untouched in this window.
2. **flipY inconsistency** (BDV auto-detect vs descriptor hardcodes) — **OPEN**. `refactor: remove format overrides system` (0355f93) cleaned up override layer but did not unify flipY semantics.
3. **Mount type data loss** (6/9 parsers hardcode `'smd'`) — **OPEN**. XZZ confirmed as hardcoded-smd; Allegro still hardcoded-smd.
4. **Origin semantics** (file-origin vs computed-from-pins) — **OPEN**.
5. **Async/sync split** (FZ, XZZ, TVW async; rest sync) — **UNCHANGED** (architectural).
6. **Nails missing** (BVR3, CAD return empty nails) — **OPEN**.
7. **Synthetic vs explicit outline** — **OPEN**. XZZ confirmed file-derived (butterfly cut on chainSegments polygon).
8. **XZZ audit gap** — **CLOSED**. Column filled this session from `xzz-parser.ts` (parts pushed at line 801, testPads → nails at 805, no traces/vias emitted).
9. **Allegro audit gap** — **CLOSED** (2026-04-15 audit). `allegro-assembler.ts` emits `traces`, `vias`, `layerNames` on `BoardData` for all versions v16.0–17.4. No version gates around extractTraces/extractVias/extractLayerNames — they iterate all 0x05/0x33 blocks and the ETCH layer list uniformly. Fields are emitted as `undefined` when arrays are empty (assembler.ts:85-87) so downstream code must still null-check. Layer-name extraction has a V165 split (`refEntries` vs `nonRefEntries` in extractLayerNames at assembler.ts:539-566) but both paths are active.
10. **Allegro trace direction / arc sweep** — **CLOSED** (2026-04-15 audit). `linearizeArc` in `allegro-assembler.ts:330-393` reads the direction bit directly: `const clockwise = (arc.subType & 0x40) !== 0` (line 357), which matches the spec in `docs/formats/ALLEGRO_BRD_FORMAT.md` line 272 ("bit 6: 0 = CCW, 0x40 = CW"). Sweep angle is computed as `start-end` (CW) or `end-start` (CCW), wrapped to positive, then stepped in ~10° increments with a terminal snap to the exact endpoint (lines 375-390). Arcs become polyline `Trace[]` segments before reaching the renderer, so rendering is convention-independent — as long as `linearizeArc` is correct (and it follows the documented bit), sweep orientation is correct across all v16.0–17.4 revisions since the `subType` byte position in `BLK_0x01_ARC` is version-invariant (`parseBlock0x01` in `allegro-blocks.ts:81-121` has no version conditional around `subType`). Only the `unknown6` field is version-gated (>= V_172), which does not affect sweep. No sample-based visual verification was performed, but the code path is analytically correct against the documented spec.
11. **CAD single-revision limitation** — **CLOSED**. Commits 5b319e6 / 17e572e / 980aa92 / db38f68 add multi-revision accumulation with delta dedup and shape-local recentering. Matrix gains a `multi-revision` row.
12. **BVR3 flipY inconsistency with other text formats** — **CLOSED — INTENTIONAL** (2026-04-15 audit). Not a divergence, rather a format difference. `bvr3-parser.ts` reads Y coordinates verbatim (no `height - y` transform; the only `.y` writes at lines 169-174 are direct assignments from the parsed file value). `bvr3-format.ts` does not set `flipY` (defaults to false via `registry.ts:26`). BVR1 and BRD are identical: neither their parsers nor descriptors Y-flip. Docs (`docs/formats/BVR_FORMAT.md`) don't specify Y convention, but the fact that BVR1/BVR3/BRD have shipped without mirroring complaints indicates these text/binary "boardview export" formats natively use screen-space Y-down, while BDV/CAD/FZ/XZZ/TVW/Allegro come from CAD-style Y-up source formats and legitimately need flipping. Note: the comment in `BoardRenderer.ts:1108-1110` ("BVR files use Y-up math convention. Screen uses Y-down. Always flip Y to convert") is misleading/legacy — actual runtime behavior (line 1114 `fmt.flipY ?? false`) does NOT flip BVR, and has not for a long time. The comment should be corrected by the renderer agent; no data-path change needed.

### Allegro row re-validation (post 5de2b24, audited 2026-04-15)

- `parts[].origin` / `parts[].bounds` / `pins` — **now trustworthy** for parts whose pad geometry came from arc-bearing shapes. Previously the wrong endian on allegroFloat corrupted arc center coordinates, which fed into computePartGeometry bounds. Non-arc parts were unaffected.
- `outline` — still `synthetic` from overall bounds (no change).
- `traces` — **emitted**. `extractTraces` (assembler.ts:268-324) walks every 0x05 ETCH track, follows `firstSegPtr → 0x15/0x16/0x17` chain, linearizes 0x01 arcs, attaches resolved net + ETCH-subclass layer index. Uniform across all versions.
- `vias` — **emitted**. `extractVias` (assembler.ts:397-427) iterates every 0x33 block, resolves net via `netAssignMap`, computes diameter from bbox. Uniform across all versions.
- `layerNames` — **emitted**. `extractLayerNames` (assembler.ts:539-566) reads the ETCH `0x2A` layer list from the header layer map. Handles pre-V165 (inline names) and V165+ (string-table refs) paths.
- `traces` / `vias` / `layerNames` are set to `undefined` (not `[]`) when empty — downstream must null-check.

### CAD multi-revision (post 5b319e6, 980aa92, 17e572e, db38f68)

- New matrix row: `multi-revision` — only CAD populates `revisions[]` on BoardData.
- Parser now walks accumulated shape deltas rather than taking only the last revision.
- Shape-local frames are recentered when stale, fixing ghost drift in multi-rev exports.
- Dedup is delta-based so identical unchanged shapes do not duplicate across revisions.
- See `cad-parser.ts` (now 557 lines, up from 255) and `types.ts` (CadRevision types).
