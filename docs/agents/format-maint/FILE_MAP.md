# Format Maintenance — File Map

**git_hash:** a5a2f8e
**last_updated:** 2026-04-15

## Staleness Check

```bash
git log --oneline a5a2f8e..HEAD -- src/frontend/src/parsers/ docs/formats/
```

If any output, re-scan changed files before working.

## Domain: `src/frontend/src/parsers/`

### Core Infrastructure

| File | Lines | Role |
|------|-------|------|
| `types.ts` | 356 | BoardData, Part, Pin, Net, Nail, Trace, Via, BBox, utility functions (buildNets, computeBBox, computePartGeometry, generateSyntheticOutline, chainSegments); now also CAD revision types |
| `registry.ts` | 95 | FormatDescriptor interface, format registration, content-based detection, `identifyFormat()` (parserVersion tracked for cache) |
| `index.ts` | 46 | Imports all formats, exports `parseBoardFile()`. Detection order: BVR1 → BVR3 → BDV ASC → BDV → Allegro → BRD → FZ → CAD → XZZ → TVW |
| `export-bvr3.ts` | 47 | Export BoardData back to BVR3 format |

### Format Descriptors (`*-format.ts`)

Each implements `FormatDescriptor`: id, name, extensions, detect(), parse reference, flags.

| File | Lines | Format | Key Flags |
|------|-------|--------|-----------|
| `bvr1-format.ts` | 21 | BVR1 | flipY:false, swapSides:false |
| `bvr3-format.ts` | 21 | BVR3 | flipY:false, swapSides:false |
| `brd-format.ts` | 24 | BRD | flipY:true, swapSides:true |
| `bdv-format.ts` | 30 | BDV | flipY:true, swapSides:false |
| `bdv-asc-format.ts` | 33 | BDV_ASC | flipY:true, swapSides:false. Detect: `dd:1.3?,r?-=bb` signature |
| `fz-format.ts` | 35 | FZ | flipY:true, swapSides:false |
| `cad-format.ts` | 22 | CAD | flipY:true, swapSides:false |
| `xzz-format.ts` | 35 | XZZ | flipY:true, swapSides:false |
| `tvw-format.ts` | 61 | TVW | flipY:true, swapSides:false, hasLayers:true, hasTraces:true |
| `allegro-brd-format.ts` | 41 | ALLEGRO_BRD | flipY:true, swapSides:false, hasTraces:true |

### Parsers (`*-parser.ts`)

| File | Lines | Sync/Async | Notes |
|------|-------|-----------|-------|
| `bvr1-parser.ts` | 106 | Sync | Side inversion baked in (T→bottom). Coords ×1000 |
| `bvr3-parser.ts` | 214 | Sync | Side inversion baked in (T→bottom). Relative pin coords |
| `brd-parser.ts` | 312 | Sync | Byte deobfuscation. `detectSideInversion()` heuristic. swapSides flag |
| `bdv-parser.ts` | 267 | Sync | Per-file flipY via shoelace winding. Y-mirror detection |
| `bdv-asc-decoder.ts` | 29 | Sync | Line-key cipher (count=0xA0, increments on CRLF). Ports OpenBoardView `decode_bdv` |
| `bdv-asc-parser.ts` | 160 | Sync | Honhan / Tebo-ICT multi-section ASC. Inch→mil ×1000. Per-file flipY via shoelace winding |
| `fz-parser.ts` | 430 | **Async** | RC6 decrypt + zlib decompress. Unit multiplier (mils or mm) |
| `cad-parser.ts` | 557 | Sync | GenCAD 1.4 text. $SIGNALS for pin-net mapping. Multi-revision support with delta-based dedup + shape-local recenter (see 5b319e6, 17e572e, 980aa92) |
| `xzz-parser.ts` | 821 | **Async** | DES decrypt. XOR obfuscation variant. Butterfly fold: dual-side layout derived from signal clustering |
| `tvw-parser.ts` | 1467 | **Async** | Multi-layer binary. Traces, vias, butterfly layout. Per-layer outlines |

### Allegro Subsystem (`allegro/`)

| File | Lines | Role |
|------|-------|------|
| `allegro-brd-parser.ts` | 16 | Entry point, delegates to assembler |
| `allegro-assembler.ts` | 566 | Reassembles blocks → BoardData |
| `allegro-blocks.ts` | 1774 | Block-level binary parsing |
| `allegro-header.ts` | 317 | File header, version detection |
| `allegro-stream.ts` | 195 | Binary stream reader utilities (allegroFloat endianness corrected in 5de2b24) |
| `allegro-db.ts` | 173 | Database structure parsing |
| `allegro-types.ts` | 1088 | Type definitions, enums, structures |

**Total parsers code: ~9,136 lines**

## Domain: `docs/formats/`

| File | Lines | Format | Status |
|------|-------|--------|--------|
| `BVR_FORMAT.md` | 246 | BVR1 + BVR3 | Complete |
| `BRD_FORMAT.md` | 258 | BRD (Apple) | Complete |
| `BDV_FORMAT.md` | 137 | BDV | Complete |
| `BDV_ASC_FORMAT.md` | 167 | BDV ASC (Honhan / Tebo-ICT) | Complete |
| `FZ_FORMAT.md` | 158 | FZ (ASUS) | Complete |
| `CAD_FORMAT.md` | 156 | CAD (GenCAD) | Complete |
| `XZZ_FORMAT.md` | 160 | XZZ | Complete |
| `TVW_FORMAT.md` | 508 | TVW (Teboview) | Complete |
| `ALLEGRO_BRD_FORMAT.md` | 353 | Allegro BRD | Complete (parser partial) |
| `TVW_PDF_CLEARANCE.md` | 204 | Legal/IP notes | Reference only |
| `tvw-reference/` | ~2,924 | Source references | eagleview, inflex, mmuman implementations |

## Known Consistency Issues (from 2026-04-11 audit)

### Critical
1. **Side inversion inconsistency** — BVR1/3 invert in-parser without swapSides flag; BRD uses both flag + heuristic; others direct
2. **flipY inconsistency** — BDV auto-detects per-file; 6 others hardcode in descriptor; BVR1/3 don't flip

### Medium
3. **Mount type data loss** — 6/9 parsers hardcode `'smd'`; only BVR3 + CAD extract actual type
4. **Origin semantics** — BVR3/BDV/TVW preserve file origin; BVR1/BRD/FZ/CAD compute from pins
5. **Async/sync split** — FZ, XZZ, TVW async; rest sync. Callers must always await

### Low
6. **Nails missing** — BVR3, CAD return empty nails despite format potentially supporting them
7. **Synthetic vs explicit outline** — FZ/CAD/Allegro generate from bounds; others parse from file
8. **XZZ + Allegro audit gaps** — Several fields marked "TBD" in consistency matrix

## Utility Functions (types.ts)

| Function | Used By | Purpose |
|----------|---------|---------|
| `buildNets(parts)` | All 9 | Group pins by net name → Map<string, Net> |
| `computeBBox(points)` | All 9 | Bounding box from point array |
| `computePartGeometry(part)` | BRD, FZ, CAD, TVW, Allegro | Origin + bounds from pin positions |
| `generateSyntheticOutline(points)` | FZ, CAD, Allegro | Rectangular outline from all points |
| `chainSegments(segments)` | BVR3, XZZ | Connect line segments into polygon |

## Recent churn (a7bbb79..a5a2f8e)

- 5de2b24 — fix(allegro): correct allegroFloat endianness for arc center/radius
- 5b319e6 — feat(cad): expose accumulated revisions in BoardData + smarter shape recentering
- 17e572e — fix(cad): delta-based shape dedup + recenter stale shape-local frames
- 980aa92 — fix(cad): dedupe accumulated revisions in multi-rev .cad exports
- 0355f93 — refactor: remove format overrides system, clamp sidebar width (touches parsers indirectly via registry/flipY)

