# PDF Glyph Debug & Optimization System

## Problem

Some schematic PDFs contain fonts with poorly rasterized glyphs — auto-traced bitmaps with excessive control points, jagged outlines, stray artifacts, or fill-rule issues. These degrade both rendering quality and performance. The user needs to:

1. **Inspect** the actual glyph data to understand the problem
2. **Decide** between two remediation strategies and apply them

## Solution

A debug/optimization system in the PDF viewer toolbar with three capabilities:

1. **Debug Overlay** — inspect raw glyph paths from embedded fonts
2. **Glyph Simplification** — reduce overcomplex paths via curve simplification
3. **Monospace Substitution** — replace rendered text with a clean monospace font

## Architecture

### Font Extraction Pipeline (shared)

All three features share a common font extraction pipeline:

1. **Extract font buffers** — hook into pdf.js `page.commonObjs` to get raw font data that pdf.js has already extracted from the PDF
2. **Parse with opentype.js** — feed raw buffers to opentype.js, producing `Font` objects with full glyph path access
3. **Cache by font name** — fonts are reused across pages; cache parsed `Font` objects to avoid re-parsing
4. **Map TextItem to glyph paths** — for each pdf.js `TextItem`, resolve character codes to glyph indices, then extract `Path` command lists from opentype.js
5. **Transform pipeline** — font units → PDF user space (via font matrix + text item transform) → canvas pixels (via viewport scale + pan/zoom)

### Feature 1: Debug Overlay

Two inspection modes, toggled in the toolbar:

**Glyph Boxes mode:**
- Semi-transparent colored rectangle around each text item
- Label: font name, glyph count, average vertices per glyph
- Color-coded by complexity:
  - Green: < 20 avg vertices/glyph (simple, healthy)
  - Yellow: 20–50 avg vertices/glyph (moderate)
  - Red: > 50 avg vertices/glyph (overcomplex, likely problematic)

**Glyph Outlines mode:**
- Render actual Bezier paths from opentype.js onto overlay canvas
- On-curve points: filled circles (3px, zoom-independent)
- Off-curve control points: hollow circles with dashed lines to on-curve anchors
- Quadratic curves: blue strokes
- Cubic curves: orange strokes
- Per-glyph vertex count label (small, positioned above glyph)

### Feature 2: Glyph Simplification

Reduces excessive control points while preserving glyph shape:

1. **Sample** — convert cubic/quadratic Bezier segments to polyline samples (adaptive sampling based on curvature)
2. **Simplify** — run Ramer-Douglas-Peucker on the polyline at configurable epsilon (tolerance slider)
3. **Reconstruct** — fit simplified polyline back to cubic Bezier curves
4. **Render** — draw simplified paths on overlay canvas
5. **Blank original** — fill original text regions with page background color before drawing simplified glyphs

Tolerance slider controls the epsilon value for RDP. Higher = more aggressive simplification = fewer points but more deviation from original.

### Feature 3: Monospace Substitution

Replaces all rendered text with a clean monospace font:

1. **Blank original** — fill original text regions with page background color
2. **Render replacement** — use Canvas 2D `fillText()` with selected monospace font
3. **Position** — use the pdf.js text item transform matrix for placement
4. **Size** — derive from transform matrix via existing `pdfFontSize()` utility
5. **Spacing** — adjust character spacing to match original text item width

Available fonts: system Courier, Courier New, monospace fallback. No bundled fonts initially — can add later if needed.

## UI: Debug Menu in PDF Toolbar

```
[Debug Glyphs v]
  ( ) Off
  ( ) Show Boxes
  ( ) Show Outlines
  ---
  [ ] Simplify Glyphs  [tolerance: ---o---]
  [ ] Monospace Replace [font: Courier v]
```

- Overlay modes: radio group (Off / Boxes / Outlines)
- Simplify and Replace: checkboxes, mutually exclusive (enabling one disables the other)
- Tolerance slider: visible only when Simplify is checked
- Font picker: visible only when Replace is checked

## Overlay Canvas

- Third canvas layer, stacked above PDF canvas and highlight canvas
- Only created/rendered when any debug or optimization mode is active
- Re-rendered on: page change, zoom/pan, mode toggle, tolerance change
- Culled to visible viewport for performance
- Cleared when all modes turned off

## State Management

- All state local to `PdfViewerPanel` component (React `useState`)
- Not persisted to localStorage or any store
- No changes to `render-settings`, `pdf-store`, or any shared state
- State shape:

```typescript
interface GlyphDebugState {
  overlayMode: 'off' | 'boxes' | 'outlines';
  simplifyEnabled: boolean;
  simplifyTolerance: number;    // 0.1 – 5.0, default 1.0
  replaceEnabled: boolean;
  replaceFont: string;          // e.g. 'Courier New'
}
```

## Dependencies

- **opentype.js** (~180KB) — font parsing, glyph path extraction
- **RDP algorithm** — implemented inline (~30 lines), no external dep
- **Cubic Bezier curve fitting** — implemented inline (~80 lines), no external dep

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/frontend/src/panels/PdfViewerPanel.tsx` | Modify | Add debug menu, overlay canvas, toggle handlers |
| `src/frontend/src/pdf/glyph-extractor.ts` | Create | Font extraction pipeline: commonObjs → opentype.js → cached Font map → glyph paths |
| `src/frontend/src/pdf/glyph-overlay.ts` | Create | Overlay rendering: boxes mode, outlines mode |
| `src/frontend/src/pdf/glyph-simplifier.ts` | Create | RDP simplification + cubic Bezier reconstruction |
| `src/frontend/src/pdf/glyph-replacer.ts` | Create | Monospace substitution rendering |
| `src/frontend/src/pdf/bezier-utils.ts` | Create | Shared: adaptive Bezier sampling, RDP, curve fitting |
| `package.json` | Modify | Add opentype.js dependency |

## Performance Considerations

- Font parsing is expensive — cache aggressively by font name
- Glyph path extraction per page — compute once per page render, cache until page changes
- Overlay rendering should be requestAnimationFrame-aligned with zoom/pan
- RDP + curve fitting runs per-glyph — tolerance changes trigger full re-computation for visible page only
- Large PDFs with many fonts: lazy-parse fonts only when debug mode is first activated

## Non-Goals (deferred)

- Persisting optimization settings across sessions
- Applying simplification/substitution to the actual PDF file (export)
- Automatic detection of "bad" fonts (user inspects and decides)
- Bundling custom monospace fonts (use system fonts initially)
