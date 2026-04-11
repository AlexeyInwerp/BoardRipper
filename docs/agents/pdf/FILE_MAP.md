# PDF Agent — File Map

**git_hash:** a7bbb79
**last_updated:** 2026-04-11

## Staleness Check

```bash
git log --oneline a7bbb79..HEAD -- src/frontend/src/pdf/ src/frontend/src/panels/PdfViewerPanel.tsx src/frontend/src/store/pdf-store.ts
```

## Domain: PDF Utilities (`src/frontend/src/pdf/`)

| File | Lines | Purpose |
|------|-------|---------|
| `glyph-overlay.ts` | 311 | Render extracted glyphs as overlay canvas |
| `glyph-extractor.ts` | 222 | Extract glyph images from PDF fonts |
| `glyph-types.ts` | 159 | Type definitions for glyph system |
| `glyph-simplifier.ts` | 127 | Simplify/smooth glyph Bezier curves |
| `bezier-utils.ts` | 101 | Bezier math (evaluation, arc length, splitting) |
| `glyph-replacer.ts` | 72 | Replace pdf.js text rendering with extracted glyphs |

**Total: ~992 lines**

## Domain: Panel

| File | Lines | Purpose |
|------|-------|---------|
| `PdfViewerPanel.tsx` | 2,272 | Multi-PDF viewer: zoom/pan/page, text search, bookmarks, night mode, quality presets, glyph overlay, component click-to-focus |

## Domain: Store

| File | Lines | Purpose |
|------|-------|---------|
| `pdf-store.ts` | 1,192 | PDF document state, text extraction, search, render cache (tier system), bookmarks, quality presets |

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

All recent commits in this domain were stability fixes:
- `cb3b309` — never pool pdf.js-rendered canvases
- `b77a38c` — remove alpha:false from persistent canvases
- `2e155da` — don't pool cancelled render canvases
- `1a1be72` — reset hysteresis in debounce for crisp zoom settle
- `4c658dd` — filter degenerate text items, fix false word breaks
