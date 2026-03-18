# PDF Glyph Debug & Optimization System

## Problem

Some schematic PDFs contain fonts with poorly rasterized glyphs — auto-traced bitmaps with excessive control points, jagged outlines, stray artifacts, or fill-rule issues. These degrade both rendering quality and performance. The user needs to:

1. **Inspect** the actual glyph data to understand the problem
2. **Decide** between two remediation strategies and apply them

## Solution

A debug/optimization system in the PDF viewer toolbar with three capabilities:

1. **Debug Overlay** — inspect glyph paths from embedded fonts
2. **Glyph Simplification** — reduce overcomplex paths via curve simplification
3. **Monospace Substitution** — replace rendered text with a clean monospace font

## Architecture

### Font Extraction Pipeline (shared)

All three features share a common font extraction pipeline:

1. **Extract font buffers from pdf.js** — access `FontFaceObject.data` via `page.commonObjs`. **Requires `fontExtraProperties: true`** in the `getDocument()` call — without this, pdf.js calls `font.clearData()` after binding, zero-filling the buffer. This option is set conditionally: only when the user first activates any debug/optimization mode, the PDF is reloaded with this flag. The converted font buffers are pdf.js's *reconstructed* OpenType/TrueType representation (not the raw PDF font stream), which is sufficient for path inspection and simplification.
2. **Parse with opentype.js** — feed converted buffers to opentype.js, producing `Font` objects with full glyph path access. **Parsing is async** — run in a Web Worker or chunked via `setTimeout(0)` between fonts to avoid main-thread blocking (50-200ms per large font). Show a loading indicator during font parsing.
3. **Cache by font name** — fonts are reused across pages; cache parsed `Font` objects keyed by font name (including subset prefix, e.g., `ABCDEF+ArialMT`) to avoid re-parsing.
4. **Map TextItem to glyph paths** — for each pdf.js `TextItem`, use `font.charToGlyphIndex()` from opentype.js on each character of the `.str` string. Since pdf.js's converted fonts preserve Unicode cmap entries, this works for most Latin text. **Encoding fallback:** if `charToGlyphIndex()` returns `.notdef` (index 0), flag the glyph as unmappable — render a placeholder (red dotted box) in the overlay instead of silently failing. The `PdfTextItem` interface in `pdf-store.ts` must be extended to include `fontName: string`, and text extraction must capture `TextContent.styles` for font metadata.
5. **Transform pipeline** — font units → PDF user space (via font matrix + text item transform) → canvas pixels (via viewport scale + pan/zoom)

### Type3 Font Handling

Type3 fonts define glyphs as PDF content streams, not TrueType/OpenType outlines — there is no `.data` buffer. opentype.js cannot parse them. **Handling:** detect `isType3Font` via `FontFaceObject` and render a gray box labeled "Type3" in the overlay. Type3 glyph outlines can optionally be extracted from `charProcOperatorList` in a future iteration but are out of scope initially.

### Feature 1: Debug Overlay

Two inspection modes, toggled in the toolbar:

**Glyph Boxes mode:**
- Semi-transparent colored rectangle around each text item
- Label: font name (with subset prefix), glyph count, average vertices per glyph
- Color-coded by complexity:
  - Green: < 20 avg vertices/glyph (simple, healthy)
  - Yellow: 20–50 avg vertices/glyph (moderate)
  - Red: > 50 avg vertices/glyph (overcomplex, likely problematic)
- Type3 fonts: gray box with "Type3" label
- Unmappable glyphs (.notdef): red dotted box

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
3. **Render** — draw simplified paths as polylines on overlay canvas (straight line segments from the simplified points — avoids the complexity of cubic Bezier reconstruction while still demonstrating the reduction). Curve fitting for smooth reconstruction can be added in a later iteration if the polyline quality is insufficient.
4. **Blank original** — use `globalCompositeOperation = 'destination-out'` to cut holes in original text regions before drawing simplified glyphs, avoiding background color detection issues.

Tolerance slider controls the epsilon value for RDP. Higher = more aggressive simplification = fewer points but more deviation from original.

### Feature 3: Monospace Substitution

Replaces all rendered text with a clean monospace font:

1. **Blank original** — use `globalCompositeOperation = 'destination-out'` to cut text regions (background-agnostic)
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

- Third canvas layer, placed **inside the `pdf-page-wrapper` div** alongside existing PDF and highlight canvases — inherits the same CSS `transform` for pan/zoom without needing its own transform logic
- Only created/rendered when any debug or optimization mode is active
- Re-rendered on: page change, mode toggle, tolerance change (NOT on pan/zoom — CSS transform handles that)
- Cleared when all modes turned off

## State Management

- All state local to `PdfViewerPanel` component (React `useState`)
- Not persisted to localStorage or any store
- No changes to `render-settings` or any shared state
- `GlyphDebugState` interface defined at top of `PdfViewerPanel.tsx` (component-local)
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

- **PDF reload state:** when debug mode is first activated, the PDF document is reloaded with `fontExtraProperties: true`. A `fontDataAvailable: boolean` flag tracks whether the current document was loaded with this option. On deactivation, no reload needed (extra data just uses more memory until the doc is closed).

## Dependencies

- **opentype.js** (~180KB) — font parsing, glyph path extraction
- **RDP algorithm** — implemented inline (~30 lines), no external dep

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/frontend/src/panels/PdfViewerPanel.tsx` | Modify | Add debug menu, overlay canvas, toggle handlers, PDF reload logic |
| `src/frontend/src/pdf/glyph-extractor.ts` | Create | Font extraction pipeline: commonObjs → opentype.js → cached Font map → glyph paths. Includes Web Worker chunking for parse. |
| `src/frontend/src/pdf/glyph-overlay.ts` | Create | Overlay rendering: boxes mode, outlines mode |
| `src/frontend/src/pdf/glyph-simplifier.ts` | Create | RDP simplification + polyline rendering |
| `src/frontend/src/pdf/glyph-replacer.ts` | Create | Monospace substitution rendering |
| `src/frontend/src/pdf/bezier-utils.ts` | Create | Shared: adaptive Bezier sampling, RDP algorithm |
| `src/frontend/src/store/pdf-store.ts` | Modify | Extend `PdfTextItem` with `fontName`; capture `TextContent.styles`; add `fontExtraProperties` reload support |
| `package.json` | Modify | Add opentype.js dependency |

## Performance Considerations

- Font parsing is expensive — cache aggressively by font name (including subset prefix)
- Parse fonts off main thread (Web Worker or chunked `setTimeout(0)`) with loading indicator
- Glyph path extraction per page — compute once per page render, cache until page changes
- Overlay canvas inside wrapper div — CSS transform handles pan/zoom, no re-render needed
- RDP runs per-glyph — tolerance changes trigger full re-computation for visible page only
- Large PDFs with many fonts: lazy-parse fonts only when debug mode is first activated
- CIDFonts with large glyph counts (30K+): cap overlay rendering to visible text items only

## Known Limitations

- **Type3 fonts:** displayed as gray placeholder boxes, not inspectable as outlines (no OpenType data)
- **Custom encodings:** some schematic PDF fonts use non-Unicode cmap mappings — these may produce `.notdef` results, shown as red dotted boxes in the overlay
- **Converted vs raw:** the glyph outlines shown are pdf.js's reconstructed OpenType representation, not the original PDF font stream. For most debugging purposes this is equivalent, but subtle differences may exist for exotic font formats
- **Simplification outputs polylines:** initial implementation renders simplified paths as straight line segments, not re-fitted curves. Smooth curve reconstruction can be added later if needed

## Non-Goals (deferred)

- Persisting optimization settings across sessions
- Applying simplification/substitution to the actual PDF file (export)
- Automatic detection of "bad" fonts (user inspects and decides)
- Bundling custom monospace fonts (use system fonts initially)
- Type3 font outline extraction via `charProcOperatorList`
- Smooth cubic Bezier reconstruction from simplified polylines
