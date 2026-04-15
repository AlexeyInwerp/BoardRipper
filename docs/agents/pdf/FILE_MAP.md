# PDF Agent — File Map

**git_hash:** a5a2f8e
**last_updated:** 2026-04-15

## Staleness Check

```bash
git log --oneline a7bbb79..HEAD -- src/frontend/src/pdf/ src/frontend/src/panels/PdfViewerPanel.tsx src/frontend/src/store/pdf-store.ts
```

## Domain: PDF Utilities (`src/frontend/src/pdf/`)

| File | Lines | Purpose |
|------|-------|---------|
| `glyph-overlay.ts` | 311 | Render extracted glyphs as overlay canvas |
| `tile-manager.ts` | 244 | **NEW (v0.4.2-pdf-beta)** — per-tile DOM canvas LRU, best-tile cache lookup, page-aware keys |
| `glyph-extractor.ts` | 222 | Extract glyph images from PDF fonts |
| `glyph-types.ts` | 159 | Type definitions for glyph system |
| `glyph-simplifier.ts` | 127 | Simplify/smooth glyph Bezier curves |
| `bezier-utils.ts` | 101 | Bezier math (evaluation, arc length, splitting) |
| `glyph-replacer.ts` | 72 | Replace pdf.js text rendering with extracted glyphs |

**Total: ~1,236 lines**

## Domain: Panel

| File | Lines | Purpose |
|------|-------|---------|
| `PdfViewerPanel.tsx` | 2,869 | Multi-PDF viewer: zoom/pan/page, text search, bookmarks, night mode, quality presets, glyph overlay, component click-to-focus, tiled rendering (zoom>1), watermark filter, Cmd+F search UX |

## Domain: Store

| File | Lines | Purpose |
|------|-------|---------|
| `pdf-store.ts` | 1,469 | PDF document state, text extraction, search, render cache (tier system), bookmarks, quality presets, watermark skip-set cache (operationsFilter) |

## Render Pipeline (from CLAUDE.md)

```
Zoom → mainTierFromZoom() (capped by quality preset)
     → quantiseTier() (0.5 steps for cache hits)
     → hysteresisFilter() (5%/10% band prevents thrashing)
     → pdf.js render
     → ImageBitmap cache
```

- Adjacent pages render center-out with AbortController cancellation
- Separate preview cache (tier-1, never evicted by hi-res) for instant fallback
- Quality presets: max/high/medium/low via PdfQualityConfig

## Canvas Rules (CRITICAL)

1. **Only pooled offscreen canvases** use `getContext('2d', { alpha: false })`
2. **Persistent canvases** (main, adjacent) must NOT use `alpha: false` — browser doesn't reliably reset alpha on `canvas.width` change → mirroring artifacts
3. **Never pool pdf.js-rendered canvases** — eliminates mirroring
4. Canvas pool (8 entries) shrinks backing store synchronously before pooling — never defer (race condition)

## Per-Document State Pattern

- `usePdfDoc(fileName)` hook for per-document state → multiple PDFs side-by-side
- `pdfStore` singleton tracks "active" doc for mutations
- Each panel reads its own doc's state independently

## Recent Stability Fixes (v0.3.3–v0.3.5)

- `cb3b309` — never pool pdf.js-rendered canvases
- `b77a38c` — remove alpha:false from persistent canvases
- `2e155da` — don't pool cancelled render canvases
- `1a1be72` — reset hysteresis in debounce for crisp zoom settle
- `4c658dd` — filter degenerate text items, fix false word breaks

## Recent churn (a7bbb79..a5a2f8e) — PDF domain is the highest-churn area

Tiled rendering landed in v0.4.2-pdf-beta, search/watermark/stability follow-ups through v0.4.2-pdf-beta.1.

- a10ccf1 — perf: PDF viewer Phase 3 quick wins
- 9a9052b — chore: bump quality presets for crispness
- 6ab75e1 — feat: PDF click-to-lookup, search nav hint, sidebar & renderer polish
- 875b8ed — fix: PDF search highlights, follow-target highlight, dpr-aware rendering
- 281f629 — feat: restore tile-manager + getBestTileCached
- af53874 / 74d0488 / 0a0b0a3 — feat: per-tile DOM canvases, wire tile routing at zoom>1
- 8cd33a8 / 43f70a6 / 202a0fd / 98339df — tiled rendering fixes (no blank flash, correct highlights, best-available cache)
- 837bd94 — fix: PDF search bar rework, scrollbar visibility, bookmark grouping
- 1a4054d / 7e9268b / dc69450 — fix: page transition flash (page-aware tile keys, StrictMode double-fire, deferred adj cleanup)
- 8ec68f4 — feat: PDF watermark filter via pdf.js operationsFilter
- 02b526c / db262d1 / 24f60d2 — fix: Cmd/Ctrl+F PDF search UX + match-nav edge cases
- 029cb7e — feat: Enter/Shift+Enter step through PDF search matches
- 695920c — chore: clamp logging, idle-gated prewarm, docs refresh

See docs/PDF_VIEWER.md (touched in 695920c) for the canonical pipeline description. See ERROR_LOG 2026-04-15 entry for the ping-pong debug story and systematic-debugging requirement on future PDF bugs.
