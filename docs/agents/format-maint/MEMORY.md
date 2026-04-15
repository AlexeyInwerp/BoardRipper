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
| traces | — | — | — | — | — | — | — | yes | partial |
| vias | — | — | — | — | — | — | — | yes | partial |
| layerNames | — | — | — | — | — | — | — | yes | partial |
| flipY | false | false | descriptor | per-file | descriptor | descriptor | descriptor | descriptor | descriptor |
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
9. **Allegro audit gap** — **PARTIAL**. Float endianness fixed in 5de2b24 (arcs now geometrically correct). Trace/via coverage still partial per assembler status; full audit deferred.
10. **Allegro trace direction / arc sweep** — **PARTIAL**. Endianness fix (5de2b24) resolves the observed arc-center drift but does not confirm sweep orientation is correct across all v16.0–17.4 revisions.
11. **CAD single-revision limitation** — **CLOSED**. Commits 5b319e6 / 17e572e / 980aa92 / db38f68 add multi-revision accumulation with delta dedup and shape-local recentering. Matrix gains a `multi-revision` row.
12. **BVR3 flipY inconsistency with other text formats** — **OPEN**. Still `flipY:false` while BDV/CAD/FZ/XZZ are `true`.

### Allegro row re-validation (post 5de2b24)

- `parts[].origin` / `parts[].bounds` / `pins` — **now trustworthy** for parts whose pad geometry came from arc-bearing shapes. Previously the wrong endian on allegroFloat corrupted arc center coordinates, which fed into computePartGeometry bounds. Non-arc parts were unaffected.
- `outline` — still `synthetic` from overall bounds (no change).
- `traces` / `vias` — still **partial**: block-level parsing exists but assembler does not emit a full traces[] / vias[] on `BoardData` for all revisions. Needs audit next pass.

### CAD multi-revision (post 5b319e6, 980aa92, 17e572e, db38f68)

- New matrix row: `multi-revision` — only CAD populates `revisions[]` on BoardData.
- Parser now walks accumulated shape deltas rather than taking only the last revision.
- Shape-local frames are recentered when stale, fixing ghost drift in multi-rev exports.
- Dedup is delta-based so identical unchanged shapes do not duplicate across revisions.
- See `cad-parser.ts` (now 557 lines, up from 255) and `types.ts` (CadRevision types).
