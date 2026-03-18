# PDF Glyph Debug & Optimization — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a debug overlay and two optimization modes (glyph simplification, monospace substitution) to the PDF viewer for inspecting and remediating poorly rasterized font glyphs in schematic PDFs.

**Architecture:** Extract font data from pdf.js's `commonObjs` (with `fontExtraProperties: true`), parse with opentype.js, render debug/optimized overlays on a third canvas inside the existing `pdf-page-wrapper`. When simplify/replace is active, the overlay canvas composites the PDF render + modifications (blit PDF → cut text → draw replacement). All state is component-local in `PdfViewerPanel`.

**Tech Stack:** opentype.js (font parsing), pdf.js (existing), Canvas 2D (overlay rendering), RDP algorithm (inline)

**Spec:** `docs/superpowers/specs/2026-03-18-pdf-glyph-debug-optimization-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/frontend/src/pdf/glyph-types.ts` | Create | Shared types + `itemRect()` utility |
| `src/frontend/src/pdf/bezier-utils.ts` | Create | Adaptive Bezier sampling + RDP simplification algorithm |
| `src/frontend/src/pdf/glyph-extractor.ts` | Create | Font extraction pipeline: pdf.js commonObjs → opentype.js → glyph paths per text item |
| `src/frontend/src/pdf/glyph-overlay.ts` | Create | Canvas rendering for boxes and outlines debug modes |
| `src/frontend/src/pdf/glyph-simplifier.ts` | Create | RDP-based glyph simplification + overlay rendering |
| `src/frontend/src/pdf/glyph-replacer.ts` | Create | Monospace substitution rendering |
| `src/frontend/src/store/pdf-store.ts` | Modify | Extend `PdfTextItem` with `fontName`; add `reloadWithFontData()`, `getDocProxy()` |
| `src/frontend/src/panels/PdfViewerPanel.tsx` | Modify | Add debug menu dropdown, overlay canvas ref, state, and rendering integration |
| `src/frontend/src/index.css` | Modify | Styles for debug dropdown menu |
| `src/frontend/package.json` | Modify | Add `opentype.js` dependency |

---

## Task 1: Add opentype.js dependency

**Files:**
- Modify: `src/frontend/package.json`

- [ ] **Step 1: Install opentype.js**

```bash
cd src/frontend && npm install opentype.js
```

- [ ] **Step 2: Verify installation**

```bash
cd src/frontend && node -e "require('opentype.js'); console.log('ok')"
```

Expected: `ok`

- [ ] **Step 3: Commit**

```bash
git add src/frontend/package.json src/frontend/package-lock.json
git commit -m "feat: add opentype.js dependency for glyph extraction"
```

---

## Task 2: Shared types + itemRect utility

**Files:**
- Create: `src/frontend/src/pdf/glyph-types.ts`

- [ ] **Step 1: Create the types file**

```typescript
// src/frontend/src/pdf/glyph-types.ts

import type { Font, Path } from 'opentype.js';
import { pdfFontSize } from '../store/pdf-store';

/** Debug overlay + optimization state — component-local in PdfViewerPanel */
export interface GlyphDebugState {
  overlayMode: 'off' | 'boxes' | 'outlines';
  simplifyEnabled: boolean;
  simplifyTolerance: number;  // 0.1–5.0, default 1.0
  replaceEnabled: boolean;
  replaceFont: string;        // e.g. 'Courier New'
}

export const DEFAULT_GLYPH_DEBUG_STATE: GlyphDebugState = {
  overlayMode: 'off',
  simplifyEnabled: false,
  simplifyTolerance: 1.0,
  replaceEnabled: false,
  replaceFont: 'Courier New',
};

/** A single glyph's path data + metrics for overlay rendering */
export interface GlyphPathData {
  path: Path;
  commandCount: number;
  vertexCount: number;
  advanceWidth: number;
  glyphIndex: number;
  isNotdef: boolean;
}

/** Cached parsed font with metadata */
export interface FontCacheEntry {
  font: Font;
  fontName: string;
  isType3: boolean;
  glyphCount: number;
  unitsPerEm: number;
}

/** All glyph data for a single text item on a page */
export interface TextItemGlyphData {
  str: string;
  fontName: string;
  transform: number[];
  width: number;
  glyphs: GlyphPathData[] | null;
  isType3: boolean;
  avgVertexCount: number;
  unitsPerEm: number;
}

/** All glyph data for a single page */
export interface PageGlyphData {
  pageIndex: number;
  items: TextItemGlyphData[];
  fontNames: string[];
  status: 'idle' | 'loading' | 'ready' | 'error';
  error?: string;
}

/** Complexity color thresholds */
export const COMPLEXITY = {
  LOW_THRESHOLD: 20,
  HIGH_THRESHOLD: 50,
  LOW_COLOR: 'rgba(0, 200, 80, 0.3)',
  MED_COLOR: 'rgba(255, 200, 0, 0.3)',
  HIGH_COLOR: 'rgba(255, 50, 50, 0.3)',
  TYPE3_COLOR: 'rgba(128, 128, 128, 0.3)',
  NOTDEF_COLOR: 'rgba(255, 0, 0, 0.5)',
} as const;

const LINE_HEIGHT_RATIO = 1.2;

/** Compute a text item's bounding rect in canvas-space.
 *  Shared utility — same logic as textItemRect in PdfViewerPanel. */
export function itemRect(
  item: { transform: number[]; width: number },
  vpT: number[],
  scale: number,
): { x: number; y: number; w: number; h: number } {
  const fontSize = pdfFontSize(item.transform);
  const vx = vpT[0] * item.transform[4] + vpT[2] * item.transform[5] + vpT[4];
  const vy = vpT[1] * item.transform[4] + vpT[3] * item.transform[5] + vpT[5];
  return {
    x: vx * scale,
    y: vy * scale - fontSize * scale,
    w: item.width * scale,
    h: fontSize * scale * LINE_HEIGHT_RATIO,
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add src/frontend/src/pdf/glyph-types.ts
git commit -m "feat: add shared types and itemRect utility for glyph debug system"
```

---

## Task 3: Bezier utilities + RDP algorithm

**Files:**
- Create: `src/frontend/src/pdf/bezier-utils.ts`

- [ ] **Step 1: Create bezier-utils.ts**

```typescript
// src/frontend/src/pdf/bezier-utils.ts

export interface Point { x: number; y: number; }

/** Sample a quadratic Bezier curve into polyline points (adaptive subdivision). */
export function sampleQuadratic(
  p0: Point, p1: Point, p2: Point, tolerance = 0.5,
): Point[] {
  const points: Point[] = [p0];
  subdivideQuad(p0, p1, p2, tolerance, points);
  points.push(p2);
  return points;
}

function subdivideQuad(p0: Point, p1: Point, p2: Point, tol: number, out: Point[]) {
  const mx = (p0.x + p2.x) / 2;
  const my = (p0.y + p2.y) / 2;
  const d = Math.abs(p1.x - mx) + Math.abs(p1.y - my);
  if (d < tol) return;
  const q0 = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
  const q1 = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
  const mid = { x: (q0.x + q1.x) / 2, y: (q0.y + q1.y) / 2 };
  subdivideQuad(p0, q0, mid, tol, out);
  out.push(mid);
  subdivideQuad(mid, q1, p2, tol, out);
}

/** Sample a cubic Bezier curve into polyline points (adaptive subdivision). */
export function sampleCubic(
  p0: Point, p1: Point, p2: Point, p3: Point, tolerance = 0.5,
): Point[] {
  const points: Point[] = [p0];
  subdivideCubic(p0, p1, p2, p3, tolerance, points);
  points.push(p3);
  return points;
}

function subdivideCubic(
  p0: Point, p1: Point, p2: Point, p3: Point, tol: number, out: Point[],
) {
  const dx = p3.x - p0.x;
  const dy = p3.y - p0.y;
  const d1 = Math.abs((p1.x - p3.x) * dy - (p1.y - p3.y) * dx);
  const d2 = Math.abs((p2.x - p3.x) * dy - (p2.y - p3.y) * dx);
  const dSq = d1 + d2;
  const lenSq = dx * dx + dy * dy;
  if (dSq * dSq <= tol * tol * lenSq) return;
  const q0 = mid(p0, p1), q1 = mid(p1, p2), q2 = mid(p2, p3);
  const r0 = mid(q0, q1), r1 = mid(q1, q2);
  const s = mid(r0, r1);
  subdivideCubic(p0, q0, r0, s, tol, out);
  out.push(s);
  subdivideCubic(s, r1, q2, p3, tol, out);
}

function mid(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/** Ramer-Douglas-Peucker line simplification. */
export function rdpSimplify(points: Point[], epsilon: number): Point[] {
  if (points.length <= 2) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  rdpRecurse(points, 0, points.length - 1, epsilon, keep);
  const result: Point[] = [];
  for (let i = 0; i < points.length; i++) {
    if (keep[i]) result.push(points[i]);
  }
  return result;
}

function rdpRecurse(
  pts: Point[], start: number, end: number, eps: number, keep: Uint8Array,
) {
  let maxDist = 0;
  let maxIdx = start;
  const dx = pts[end].x - pts[start].x;
  const dy = pts[end].y - pts[start].y;
  const lenSq = dx * dx + dy * dy;

  for (let i = start + 1; i < end; i++) {
    let dist: number;
    if (lenSq === 0) {
      const ex = pts[i].x - pts[start].x;
      const ey = pts[i].y - pts[start].y;
      dist = Math.sqrt(ex * ex + ey * ey);
    } else {
      const cross = Math.abs((pts[i].x - pts[start].x) * dy - (pts[i].y - pts[start].y) * dx);
      dist = cross / Math.sqrt(lenSq);
    }
    if (dist > maxDist) { maxDist = dist; maxIdx = i; }
  }

  if (maxDist > eps) {
    keep[maxIdx] = 1;
    if (maxIdx - start > 1) rdpRecurse(pts, start, maxIdx, eps, keep);
    if (end - maxIdx > 1) rdpRecurse(pts, maxIdx, end, eps, keep);
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/frontend/src/pdf/bezier-utils.ts
git commit -m "feat: add Bezier sampling and RDP simplification utilities"
```

---

## Task 4: Extend pdf-store (PdfTextItem + reloadWithFontData + getDocProxy)

**Files:**
- Modify: `src/frontend/src/store/pdf-store.ts`

- [ ] **Step 1: Add `fontName` to `PdfTextItem` interface**

In `pdf-store.ts` line 12-17, add `fontName`:

```typescript
export interface PdfTextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
  fontName: string;
}
```

- [ ] **Step 2: Capture fontName during text extraction**

In the `_extractText()` method (around line 396-406), update text item creation:

```typescript
const ti = item as TextItem;
if (ti.str) {
  items.push({
    str: ti.str,
    transform: ti.transform,
    width: ti.width,
    height: ti.height,
    fontName: (ti as any).fontName ?? '',
  });
}
```

- [ ] **Step 3: Add `reloadWithFontData()` method to PdfStore class**

```typescript
/** Reload a PDF with fontExtraProperties enabled (for glyph debug). Returns the new doc proxy. */
async reloadWithFontData(fileName: string): Promise<PDFDocumentProxy | null> {
  const pdfDoc = this._documents.get(fileName);
  if (!pdfDoc) return null;
  const buffer = pdfDoc.originalBuffer.slice(0);
  const oldDoc = pdfDoc.doc;
  const doc = await pdfjsLib.getDocument({
    data: buffer,
    fontExtraProperties: true,
  }).promise;
  pdfDoc.doc = doc;
  // Clean up old proxy (safe — only tears down worker connection, unlike PixiJS destroy)
  oldDoc.destroy().catch(() => {});
  this.notify();
  return doc;
}
```

- [ ] **Step 4: Add `getDocProxy()` method to PdfStore class**

```typescript
/** Get the effective PDFDocumentProxy for a loaded document. */
getDocProxy(fileName: string): PDFDocumentProxy | null {
  const d = this._documents.get(fileName);
  return d ? (d.cleanMode && d.strippedDoc ? d.strippedDoc : d.doc) : null;
}
```

- [ ] **Step 5: Verify build compiles**

```bash
cd src/frontend && npx tsc --noEmit
```

- [ ] **Step 6: Commit**

```bash
git add src/frontend/src/store/pdf-store.ts
git commit -m "feat: extend PdfTextItem with fontName, add reloadWithFontData and getDocProxy"
```

---

## Task 5: Font extraction pipeline (glyph-extractor.ts)

**Files:**
- Create: `src/frontend/src/pdf/glyph-extractor.ts`

Key design decisions addressing review feedback:
- Use synchronous `commonObjs.get(name)` (no callback) with try/catch, since fonts are already resolved after `getOperatorList()`
- Yield to browser between font parses with `setTimeout(0)` to avoid main-thread blocking
- Cache keyed by `docId:fontName` to prevent cross-panel cache interference
- Include `unitsPerEm` in cache entries and `TextItemGlyphData`

- [ ] **Step 1: Create glyph-extractor.ts**

```typescript
// src/frontend/src/pdf/glyph-extractor.ts

import opentype from 'opentype.js';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist/types/src/pdf';
import type { FontCacheEntry, GlyphPathData, TextItemGlyphData, PageGlyphData } from './glyph-types';
import type { PdfTextItem } from '../store/pdf-store';

/** Module-level font cache: "docFingerprint:fontName" → parsed Font */
const fontCache = new Map<string, FontCacheEntry>();

/** Clear cache entries for a specific document (by fingerprint). */
export function clearFontCache(docFingerprint?: string) {
  if (!docFingerprint) {
    fontCache.clear();
    return;
  }
  const prefix = docFingerprint + ':';
  for (const key of fontCache.keys()) {
    if (key.startsWith(prefix)) fontCache.delete(key);
  }
}

function cacheKey(docFingerprint: string, fontName: string) {
  return docFingerprint + ':' + fontName;
}

/** Yield to browser to avoid blocking the main thread. */
function yieldToMain(): Promise<void> {
  return new Promise(r => setTimeout(r, 0));
}

/**
 * Extract and parse fonts from a pdf.js page's commonObjs.
 * Requires the document to have been loaded with fontExtraProperties: true.
 */
async function parseFontsFromPage(
  page: PDFPageProxy,
  docFingerprint: string,
): Promise<void> {
  const ops = await page.getOperatorList();
  const fontNames = new Set<string>();
  const OPS = (await import('pdfjs-dist')).OPS;

  for (let i = 0; i < ops.fnArray.length; i++) {
    if (ops.fnArray[i] === OPS.setFont) {
      fontNames.add(ops.argsArray[i][0] as string);
    }
  }

  for (const name of fontNames) {
    const ck = cacheKey(docFingerprint, name);
    if (fontCache.has(ck)) continue;

    try {
      // After getOperatorList(), fonts should be resolved — use synchronous get
      let fontObj: any;
      try {
        fontObj = page.commonObjs.get(name);
      } catch {
        console.warn(`[glyph-extractor] Font ${name} not available in commonObjs, skipping`);
        continue;
      }

      if (!fontObj) continue;

      if (fontObj.isType3Font) {
        fontCache.set(ck, {
          font: null as any,
          fontName: name,
          isType3: true,
          glyphCount: 0,
          unitsPerEm: 1000,
        });
        continue;
      }

      const data = fontObj.data;
      if (!data || data.length === 0) {
        console.warn(`[glyph-extractor] Font ${name} has no data. Was fontExtraProperties enabled?`);
        continue;
      }

      // Parse font buffer with opentype.js
      const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      const font = opentype.parse(buffer);

      fontCache.set(ck, {
        font,
        fontName: name,
        isType3: false,
        glyphCount: font.glyphs.length,
        unitsPerEm: font.unitsPerEm,
      });

      // Yield between font parses to avoid blocking the main thread
      await yieldToMain();
    } catch (err) {
      console.warn(`[glyph-extractor] Failed to parse font ${name}:`, err);
    }
  }
}

/** Extract glyph path data for each character in a text item. */
function extractGlyphsForItem(
  item: PdfTextItem,
  cache: FontCacheEntry,
): GlyphPathData[] | null {
  if (cache.isType3 || !cache.font) return null;

  const glyphs: GlyphPathData[] = [];
  const font = cache.font;

  for (const char of item.str) {
    const glyphIndex = font.charToGlyphIndex(char);
    const glyph = font.glyphs.get(glyphIndex);
    const isNotdef = glyphIndex === 0;

    if (!glyph) {
      glyphs.push({
        path: new opentype.Path(),
        commandCount: 0,
        vertexCount: 0,
        advanceWidth: 0,
        glyphIndex: 0,
        isNotdef: true,
      });
      continue;
    }

    const path = glyph.getPath(0, 0, font.unitsPerEm);
    let vertexCount = 0;
    for (const cmd of path.commands) {
      if (cmd.type === 'M' || cmd.type === 'L') vertexCount += 1;
      else if (cmd.type === 'Q') vertexCount += 2;
      else if (cmd.type === 'C') vertexCount += 3;
    }

    glyphs.push({
      path,
      commandCount: path.commands.length,
      vertexCount,
      advanceWidth: glyph.advanceWidth ?? 0,
      glyphIndex,
      isNotdef,
    });
  }

  return glyphs;
}

/**
 * Build PageGlyphData for a given page.
 * Call this when debug mode is activated.
 */
export async function extractPageGlyphs(
  page: PDFPageProxy,
  doc: PDFDocumentProxy,
  textItems: PdfTextItem[],
  pageIndex: number,
): Promise<PageGlyphData> {
  const result: PageGlyphData = {
    pageIndex,
    items: [],
    fontNames: [],
    status: 'loading',
  };

  const docFingerprint = doc.fingerprints[0] ?? 'unknown';

  try {
    await parseFontsFromPage(page, docFingerprint);

    const fontNamesSet = new Set<string>();

    for (const item of textItems) {
      const fontName = item.fontName;
      fontNamesSet.add(fontName);
      const ck = cacheKey(docFingerprint, fontName);
      const cache = fontCache.get(ck);

      if (!cache) {
        result.items.push({
          str: item.str,
          fontName,
          transform: item.transform,
          width: item.width,
          glyphs: null,
          isType3: false,
          avgVertexCount: 0,
          unitsPerEm: 1000,
        });
        continue;
      }

      const glyphs = extractGlyphsForItem(item, cache);
      const avgVerts = glyphs
        ? glyphs.reduce((s, g) => s + g.vertexCount, 0) / Math.max(glyphs.length, 1)
        : 0;

      result.items.push({
        str: item.str,
        fontName,
        transform: item.transform,
        width: item.width,
        glyphs,
        isType3: cache.isType3,
        avgVertexCount: avgVerts,
        unitsPerEm: cache.unitsPerEm,
      });
    }

    result.fontNames = [...fontNamesSet];
    result.status = 'ready';
  } catch (err) {
    result.status = 'error';
    result.error = String(err);
    console.error('[glyph-extractor] extractPageGlyphs failed:', err);
  }

  return result;
}
```

- [ ] **Step 2: Verify build**

```bash
cd src/frontend && npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/frontend/src/pdf/glyph-extractor.ts
git commit -m "feat: implement font extraction pipeline with opentype.js"
```

---

## Task 6: Debug overlay rendering (glyph-overlay.ts)

**Files:**
- Create: `src/frontend/src/pdf/glyph-overlay.ts`

Uses `unitsPerEm` from each item (not hardcoded 1000) for correct font-unit scaling.

- [ ] **Step 1: Create glyph-overlay.ts**

```typescript
// src/frontend/src/pdf/glyph-overlay.ts

import type { PageGlyphData, TextItemGlyphData } from './glyph-types';
import { COMPLEXITY, itemRect } from './glyph-types';
import { pdfFontSize } from '../store/pdf-store';

/**
 * Draw glyph bounding boxes colored by complexity.
 */
export function drawGlyphBoxes(
  ctx: CanvasRenderingContext2D,
  pageData: PageGlyphData,
  vpT: number[],
  scale: number,
) {
  ctx.save();
  ctx.font = `${Math.max(10, 10 * (scale / 100))}px monospace`;
  ctx.textBaseline = 'bottom';

  for (const item of pageData.items) {
    const rect = itemRect(item, vpT, scale);

    let color: string;
    if (item.isType3) {
      color = COMPLEXITY.TYPE3_COLOR;
    } else if (item.glyphs === null) {
      color = COMPLEXITY.TYPE3_COLOR;
    } else if (item.avgVertexCount > COMPLEXITY.HIGH_THRESHOLD) {
      color = COMPLEXITY.HIGH_COLOR;
    } else if (item.avgVertexCount > COMPLEXITY.LOW_THRESHOLD) {
      color = COMPLEXITY.MED_COLOR;
    } else {
      color = COMPLEXITY.LOW_COLOR;
    }

    ctx.fillStyle = color;
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);

    ctx.strokeStyle = color.replace('0.3', '0.8');
    ctx.lineWidth = 1;
    ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);

    const label = item.isType3
      ? `Type3: ${item.fontName}`
      : `${item.fontName.substring(0, 20)} avg:${Math.round(item.avgVertexCount)}v`;
    ctx.fillStyle = '#fff';
    ctx.fillText(label, rect.x, rect.y - 2);
  }

  ctx.restore();
}

/**
 * Draw actual glyph outlines with control point markers.
 */
export function drawGlyphOutlines(
  ctx: CanvasRenderingContext2D,
  pageData: PageGlyphData,
  vpT: number[],
  scale: number,
) {
  ctx.save();

  for (const item of pageData.items) {
    if (item.isType3 || !item.glyphs) {
      const rect = itemRect(item, vpT, scale);
      if (item.isType3) {
        ctx.fillStyle = COMPLEXITY.TYPE3_COLOR;
        ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
        ctx.fillStyle = '#aaa';
        ctx.font = '10px monospace';
        ctx.fillText('Type3', rect.x + 2, rect.y + rect.h - 2);
      }
      continue;
    }

    const fontSize = pdfFontSize(item.transform);
    const rect = itemRect(item, vpT, scale);
    const totalAdvance = item.glyphs.reduce((s, g) => s + g.advanceWidth, 0);
    const pxPerUnit = totalAdvance > 0 ? rect.w / totalAdvance : 0;
    const fontScale = (fontSize * scale) / item.unitsPerEm;

    let cursorX = rect.x;

    for (const glyph of item.glyphs) {
      if (glyph.isNotdef) {
        ctx.setLineDash([2, 2]);
        ctx.strokeStyle = COMPLEXITY.NOTDEF_COLOR;
        const gw = glyph.advanceWidth * pxPerUnit;
        ctx.strokeRect(cursorX, rect.y, gw || 8, rect.h);
        ctx.setLineDash([]);
        cursorX += gw || 8;
        continue;
      }

      const cmds = glyph.path.commands;
      const gw = glyph.advanceWidth * pxPerUnit;
      const baselineY = rect.y + rect.h;

      ctx.beginPath();
      const onCurvePoints: { x: number; y: number }[] = [];
      const offCurvePoints: { x: number; y: number; anchorX: number; anchorY: number }[] = [];

      for (const cmd of cmds) {
        const tx = (x: number) => cursorX + x * fontScale;
        const ty = (y: number) => baselineY - y * fontScale;

        switch (cmd.type) {
          case 'M':
            ctx.moveTo(tx(cmd.x), ty(cmd.y));
            onCurvePoints.push({ x: tx(cmd.x), y: ty(cmd.y) });
            break;
          case 'L':
            ctx.lineTo(tx(cmd.x), ty(cmd.y));
            onCurvePoints.push({ x: tx(cmd.x), y: ty(cmd.y) });
            break;
          case 'Q':
            ctx.quadraticCurveTo(tx(cmd.x1), ty(cmd.y1), tx(cmd.x), ty(cmd.y));
            offCurvePoints.push({ x: tx(cmd.x1), y: ty(cmd.y1), anchorX: tx(cmd.x), anchorY: ty(cmd.y) });
            onCurvePoints.push({ x: tx(cmd.x), y: ty(cmd.y) });
            break;
          case 'C':
            ctx.bezierCurveTo(tx(cmd.x1), ty(cmd.y1), tx(cmd.x2), ty(cmd.y2), tx(cmd.x), ty(cmd.y));
            offCurvePoints.push(
              { x: tx(cmd.x1), y: ty(cmd.y1), anchorX: tx(cmd.x), anchorY: ty(cmd.y) },
              { x: tx(cmd.x2), y: ty(cmd.y2), anchorX: tx(cmd.x), anchorY: ty(cmd.y) },
            );
            onCurvePoints.push({ x: tx(cmd.x), y: ty(cmd.y) });
            break;
          case 'Z':
            ctx.closePath();
            break;
        }
      }

      const hasQuad = cmds.some(c => c.type === 'Q');
      const hasCubic = cmds.some(c => c.type === 'C');
      ctx.strokeStyle = hasCubic ? 'rgba(255, 160, 0, 0.8)' : hasQuad ? 'rgba(80, 160, 255, 0.8)' : 'rgba(200, 200, 200, 0.6)';
      ctx.lineWidth = 1;
      ctx.stroke();

      // On-curve points (filled green)
      ctx.fillStyle = '#0f0';
      for (const p of onCurvePoints) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 2, 0, Math.PI * 2);
        ctx.fill();
      }

      // Off-curve control points (hollow red) with lines to anchor
      ctx.strokeStyle = 'rgba(255, 100, 100, 0.5)';
      ctx.setLineDash([1, 1]);
      for (const p of offCurvePoints) {
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.anchorX, p.anchorY);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(p.x, p.y, 2, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.setLineDash([]);

      // Vertex count label
      ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
      ctx.font = '8px monospace';
      ctx.fillText(`${glyph.vertexCount}`, cursorX, rect.y - 1);

      cursorX += gw || 8;
    }
  }

  ctx.restore();
}
```

- [ ] **Step 2: Commit**

```bash
git add src/frontend/src/pdf/glyph-overlay.ts
git commit -m "feat: implement glyph debug overlay rendering (boxes + outlines)"
```

---

## Task 7: Glyph simplification (glyph-simplifier.ts)

**Files:**
- Create: `src/frontend/src/pdf/glyph-simplifier.ts`

**Key design for blanking:** When simplify/replace is active, the integration code (Task 10) will blit the PDF canvas onto the overlay canvas first. The simplifier draws opaque white rects to cover original text, then draws simplified glyphs on top. This avoids the `destination-out` issue (can't erase through to another canvas).

- [ ] **Step 1: Create glyph-simplifier.ts**

```typescript
// src/frontend/src/pdf/glyph-simplifier.ts

import type { PageGlyphData } from './glyph-types';
import { itemRect } from './glyph-types';
import { sampleQuadratic, sampleCubic, rdpSimplify } from './bezier-utils';
import type { Point } from './bezier-utils';
import { pdfFontSize } from '../store/pdf-store';

/**
 * Render simplified glyph outlines on a canvas that already has the PDF blit.
 * Covers original text with white, then draws simplified polyline glyphs.
 */
export function drawSimplifiedGlyphs(
  ctx: CanvasRenderingContext2D,
  pageData: PageGlyphData,
  vpT: number[],
  scale: number,
  epsilon: number,
) {
  ctx.save();

  for (const item of pageData.items) {
    if (item.isType3 || !item.glyphs) continue;

    const fontSize = pdfFontSize(item.transform);
    const rect = itemRect(item, vpT, scale);
    const totalAdvance = item.glyphs.reduce((s, g) => s + g.advanceWidth, 0);
    const pxPerUnit = totalAdvance > 0 ? rect.w / totalAdvance : 0;
    const fontScale = (fontSize * scale) / item.unitsPerEm;

    // Cover original text with white
    ctx.fillStyle = '#fff';
    ctx.fillRect(rect.x - 1, rect.y - 1, rect.w + 2, rect.h + 2);

    let cursorX = rect.x;
    const baselineY = rect.y + rect.h;

    for (const glyph of item.glyphs) {
      if (glyph.isNotdef) {
        cursorX += glyph.advanceWidth * pxPerUnit || 8;
        continue;
      }

      const cmds = glyph.path.commands;
      const tx = (x: number) => cursorX + x * fontScale;
      const ty = (y: number) => baselineY - y * fontScale;

      // Build polyline contours from path commands
      const contours: Point[][] = [];
      let current: Point[] = [];

      for (const cmd of cmds) {
        switch (cmd.type) {
          case 'M':
            if (current.length > 0) contours.push(current);
            current = [{ x: tx(cmd.x), y: ty(cmd.y) }];
            break;
          case 'L':
            current.push({ x: tx(cmd.x), y: ty(cmd.y) });
            break;
          case 'Q': {
            const prev = current[current.length - 1] || { x: 0, y: 0 };
            const pts = sampleQuadratic(prev, { x: tx(cmd.x1), y: ty(cmd.y1) }, { x: tx(cmd.x), y: ty(cmd.y) });
            current.push(...pts.slice(1));
            break;
          }
          case 'C': {
            const prev = current[current.length - 1] || { x: 0, y: 0 };
            const pts = sampleCubic(
              prev,
              { x: tx(cmd.x1), y: ty(cmd.y1) },
              { x: tx(cmd.x2), y: ty(cmd.y2) },
              { x: tx(cmd.x), y: ty(cmd.y) },
            );
            current.push(...pts.slice(1));
            break;
          }
          case 'Z':
            if (current.length > 0) {
              contours.push(current);
              current = [];
            }
            break;
        }
      }
      if (current.length > 0) contours.push(current);

      // Simplify each contour and render as filled polyline
      ctx.beginPath();
      for (const contour of contours) {
        const simplified = rdpSimplify(contour, epsilon);
        if (simplified.length < 2) continue;
        ctx.moveTo(simplified[0].x, simplified[0].y);
        for (let i = 1; i < simplified.length; i++) {
          ctx.lineTo(simplified[i].x, simplified[i].y);
        }
        ctx.closePath();
      }
      ctx.fillStyle = '#000';
      ctx.fill('evenodd');

      cursorX += glyph.advanceWidth * pxPerUnit || 8;
    }
  }

  ctx.restore();
}
```

- [ ] **Step 2: Commit**

```bash
git add src/frontend/src/pdf/glyph-simplifier.ts
git commit -m "feat: implement RDP-based glyph simplification with overlay rendering"
```

---

## Task 8: Monospace substitution (glyph-replacer.ts)

**Files:**
- Create: `src/frontend/src/pdf/glyph-replacer.ts`

Same blanking approach: draw on a canvas that already has the PDF blit, cover text with white, draw replacement.

- [ ] **Step 1: Create glyph-replacer.ts**

```typescript
// src/frontend/src/pdf/glyph-replacer.ts

import type { PageGlyphData } from './glyph-types';
import { itemRect } from './glyph-types';
import { pdfFontSize } from '../store/pdf-store';

/**
 * Replace all text with a monospace font on a canvas that already has the PDF blit.
 * Covers original text with white, then draws replacement text.
 */
export function drawMonospaceReplacement(
  ctx: CanvasRenderingContext2D,
  pageData: PageGlyphData,
  vpT: number[],
  scale: number,
  fontFamily: string,
) {
  ctx.save();

  for (const item of pageData.items) {
    const rect = itemRect(item, vpT, scale);
    const fontSize = pdfFontSize(item.transform);
    const pxSize = fontSize * scale;

    // Cover original text with white
    ctx.fillStyle = '#fff';
    ctx.fillRect(rect.x - 1, rect.y - 1, rect.w + 2, rect.h + 2);

    // Draw replacement text
    ctx.fillStyle = '#000';
    ctx.font = `${pxSize}px "${fontFamily}", monospace`;
    ctx.textBaseline = 'alphabetic';

    const measured = ctx.measureText(item.str);
    const scaleX = rect.w / (measured.width || 1);

    ctx.save();
    ctx.translate(rect.x, rect.y + rect.h);
    ctx.scale(scaleX, 1);
    ctx.fillText(item.str, 0, 0);
    ctx.restore();
  }

  ctx.restore();
}
```

- [ ] **Step 2: Commit**

```bash
git add src/frontend/src/pdf/glyph-replacer.ts
git commit -m "feat: implement monospace font substitution rendering"
```

---

## Task 9: Debug menu CSS

**Files:**
- Modify: `src/frontend/src/index.css`

- [ ] **Step 1: Add debug dropdown styles**

Append after the existing `.pdf-*` styles:

```css
/* Glyph debug dropdown */
.pdf-glyph-debug-wrapper {
  position: relative;
}
.pdf-glyph-debug-btn {
  background: transparent;
  border: 1px solid #555;
  color: #ccc;
  padding: 2px 8px;
  cursor: pointer;
  font-size: 11px;
  border-radius: 3px;
}
.pdf-glyph-debug-btn.active {
  border-color: #f80;
  color: #f80;
}
.pdf-glyph-debug-menu {
  position: absolute;
  top: 100%;
  right: 0;
  z-index: 100;
  background: #1e1e1e;
  border: 1px solid #555;
  border-radius: 4px;
  padding: 6px 0;
  min-width: 220px;
  box-shadow: 0 4px 12px rgba(0,0,0,0.5);
}
.pdf-glyph-debug-menu label {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 12px;
  cursor: pointer;
  font-size: 11px;
  color: #ccc;
}
.pdf-glyph-debug-menu label:hover {
  background: #2a2a2a;
}
.pdf-glyph-debug-menu hr {
  border: none;
  border-top: 1px solid #333;
  margin: 4px 0;
}
.pdf-glyph-debug-menu .pdf-glyph-slider-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 12px;
  font-size: 11px;
  color: #ccc;
}
.pdf-glyph-debug-menu .pdf-glyph-slider-row input[type="range"] {
  flex: 1;
  height: 14px;
}
.pdf-glyph-debug-menu select {
  background: #2a2a2a;
  border: 1px solid #555;
  color: #ccc;
  font-size: 11px;
  padding: 1px 4px;
  border-radius: 3px;
}
.pdf-glyph-overlay-canvas {
  position: absolute;
  top: 0;
  left: 0;
  pointer-events: none;
}
.pdf-glyph-loading {
  position: absolute;
  top: 4px;
  right: 4px;
  background: rgba(0,0,0,0.7);
  color: #f80;
  padding: 2px 8px;
  border-radius: 3px;
  font-size: 11px;
  z-index: 50;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/frontend/src/index.css
git commit -m "feat: add CSS styles for glyph debug dropdown and overlay"
```

---

## Task 10: Integrate into PdfViewerPanel

**Files:**
- Modify: `src/frontend/src/panels/PdfViewerPanel.tsx`

This is the main integration. Key architectural point: when simplify or replace is active, the overlay canvas gets a blit of the PDF canvas content first, then modifications are drawn on top. The PDF canvas underneath is hidden via CSS. For debug overlay (boxes/outlines), the overlay is transparent and PDF canvas stays visible.

- [ ] **Step 1: Add imports**

At the top of `PdfViewerPanel.tsx`:

```typescript
import type { GlyphDebugState, PageGlyphData } from '../pdf/glyph-types';
import { DEFAULT_GLYPH_DEBUG_STATE } from '../pdf/glyph-types';
import { extractPageGlyphs, clearFontCache } from '../pdf/glyph-extractor';
import { drawGlyphBoxes, drawGlyphOutlines } from '../pdf/glyph-overlay';
import { drawSimplifiedGlyphs } from '../pdf/glyph-simplifier';
import { drawMonospaceReplacement } from '../pdf/glyph-replacer';
```

- [ ] **Step 2: Add state and refs inside component**

After the existing `useState`/`useRef` declarations:

```typescript
const [glyphDebug, setGlyphDebug] = useState<GlyphDebugState>(DEFAULT_GLYPH_DEBUG_STATE);
const [glyphMenuOpen, setGlyphMenuOpen] = useState(false);
const [fontDataLoaded, setFontDataLoaded] = useState(false);
const [glyphLoading, setGlyphLoading] = useState(false);
const glyphCanvasRef = useRef<HTMLCanvasElement>(null);
const pageGlyphDataRef = useRef<PageGlyphData | null>(null);
const glyphMenuTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

const isGlyphActive = glyphDebug.overlayMode !== 'off' || glyphDebug.simplifyEnabled || glyphDebug.replaceEnabled;
const isGlyphComposite = glyphDebug.simplifyEnabled || glyphDebug.replaceEnabled;
```

- [ ] **Step 3: Add font data reload effect**

```typescript
useEffect(() => {
  if (!isGlyphActive || fontDataLoaded || !isLoaded) return;
  let cancelled = false;
  (async () => {
    setGlyphLoading(true);
    try {
      await pdfStore.reloadWithFontData(pdfFileName);
      if (!cancelled) {
        setFontDataLoaded(true);
        // Force re-render since doc proxy changed
        renderPageRef.current();
      }
    } catch (err) {
      console.error('[PdfViewerPanel] reloadWithFontData failed:', err);
    } finally {
      if (!cancelled) setGlyphLoading(false);
    }
  })();
  return () => { cancelled = true; };
}, [isGlyphActive, fontDataLoaded, isLoaded, pdfFileName]);
```

- [ ] **Step 4: Add glyph extraction + overlay rendering effect**

```typescript
useEffect(() => {
  if (!isGlyphActive || !fontDataLoaded || !isLoaded) {
    const gc = glyphCanvasRef.current;
    if (gc) {
      const gCtx = gc.getContext('2d');
      if (gCtx) gCtx.clearRect(0, 0, gc.width, gc.height);
    }
    pageGlyphDataRef.current = null;
    return;
  }

  let cancelled = false;
  (async () => {
    setGlyphLoading(true);
    try {
      const page = await pdfStore.getPageFor(pdfFileName, currentPage);
      const doc = pdfStore.getDocProxy(pdfFileName);
      if (!doc || cancelled) return;
      const pageIndex = currentPage - 1;
      const textItems = pdfStore.getDocTextItemsForPage(pdfFileName, pageIndex);
      const pageData = await extractPageGlyphs(page, doc, textItems, pageIndex);
      if (cancelled) return;
      pageGlyphDataRef.current = pageData;

      const gc = glyphCanvasRef.current;
      const pdfCanvas = canvasRef.current;
      if (!gc || !pdfCanvas) return;
      gc.width = pdfCanvas.width;
      gc.height = pdfCanvas.height;
      gc.style.width = pdfCanvas.style.width;
      gc.style.height = pdfCanvas.style.height;

      const gCtx = gc.getContext('2d')!;
      gCtx.clearRect(0, 0, gc.width, gc.height);

      // For simplify/replace: blit PDF canvas onto overlay first, then modify
      if (isGlyphComposite) {
        gCtx.drawImage(pdfCanvas, 0, 0);
      }

      const vpT = viewportTransformRef.current;
      const renderScale = scaleRef.current * renderTierRef.current;

      if (glyphDebug.overlayMode === 'boxes') {
        drawGlyphBoxes(gCtx, pageData, vpT, renderScale);
      } else if (glyphDebug.overlayMode === 'outlines') {
        drawGlyphOutlines(gCtx, pageData, vpT, renderScale);
      }

      if (glyphDebug.simplifyEnabled) {
        drawSimplifiedGlyphs(gCtx, pageData, vpT, renderScale, glyphDebug.simplifyTolerance);
      } else if (glyphDebug.replaceEnabled) {
        drawMonospaceReplacement(gCtx, pageData, vpT, renderScale, glyphDebug.replaceFont);
      }
    } catch (err) {
      console.error('[PdfViewerPanel] glyph overlay failed:', err);
    } finally {
      if (!cancelled) setGlyphLoading(false);
    }
  })();

  return () => { cancelled = true; };
}, [isGlyphActive, isGlyphComposite, fontDataLoaded, isLoaded, pdfFileName, currentPage, glyphDebug]);
```

- [ ] **Step 5: Add cleanup effect**

```typescript
useEffect(() => {
  return () => {
    const doc = pdfStore.getDocProxy(pdfFileName);
    clearFontCache(doc?.fingerprints[0]);
    pageGlyphDataRef.current = null;
  };
}, [pdfFileName]);
```

- [ ] **Step 6: Add debug menu dropdown JSX**

In the toolbar, before `<div className="pdf-toolbar-spacer" />`, add:

```tsx
<div className="pdf-glyph-debug-wrapper">
  <button
    className={`pdf-glyph-debug-btn${isGlyphActive ? ' active' : ''}`}
    onClick={() => setGlyphMenuOpen(v => !v)}
    title="Glyph debug & optimization"
  >
    Glyphs
  </button>
  {glyphMenuOpen && (
    <div
      className="pdf-glyph-debug-menu"
      onMouseEnter={() => { if (glyphMenuTimerRef.current) { clearTimeout(glyphMenuTimerRef.current); glyphMenuTimerRef.current = null; } }}
      onMouseLeave={() => { glyphMenuTimerRef.current = setTimeout(() => setGlyphMenuOpen(false), 300); }}
    >
      {(['off', 'boxes', 'outlines'] as const).map(mode => (
        <label key={mode}>
          <input
            type="radio"
            name="glyphOverlay"
            checked={glyphDebug.overlayMode === mode}
            onChange={() => setGlyphDebug(s => ({ ...s, overlayMode: mode }))}
          />
          {mode === 'off' ? 'Off' : mode === 'boxes' ? 'Show Boxes' : 'Show Outlines'}
        </label>
      ))}
      <hr />
      <label>
        <input
          type="checkbox"
          checked={glyphDebug.simplifyEnabled}
          onChange={() => setGlyphDebug(s => ({
            ...s,
            simplifyEnabled: !s.simplifyEnabled,
            replaceEnabled: !s.simplifyEnabled ? false : s.replaceEnabled,
          }))}
        />
        Simplify Glyphs
      </label>
      {glyphDebug.simplifyEnabled && (
        <div className="pdf-glyph-slider-row">
          <span>Tol</span>
          <input
            type="range"
            min={0.1}
            max={5}
            step={0.1}
            value={glyphDebug.simplifyTolerance}
            onChange={e => setGlyphDebug(s => ({ ...s, simplifyTolerance: Number(e.target.value) }))}
          />
          <span>{glyphDebug.simplifyTolerance.toFixed(1)}</span>
        </div>
      )}
      <label>
        <input
          type="checkbox"
          checked={glyphDebug.replaceEnabled}
          onChange={() => setGlyphDebug(s => ({
            ...s,
            replaceEnabled: !s.replaceEnabled,
            simplifyEnabled: !s.replaceEnabled ? false : s.simplifyEnabled,
          }))}
        />
        Monospace Replace
      </label>
      {glyphDebug.replaceEnabled && (
        <div className="pdf-glyph-slider-row">
          <span>Font</span>
          <select
            value={glyphDebug.replaceFont}
            onChange={e => setGlyphDebug(s => ({ ...s, replaceFont: e.target.value }))}
          >
            <option value="Courier New">Courier New</option>
            <option value="Courier">Courier</option>
            <option value="monospace">monospace</option>
          </select>
        </div>
      )}
    </div>
  )}
</div>
```

- [ ] **Step 7: Add overlay canvas and loading indicator to JSX**

Inside the `pdf-canvas-container` div, before the wrapper div, add the loading indicator:

```tsx
{glyphLoading && <div className="pdf-glyph-loading">Parsing fonts...</div>}
```

Inside the `pdf-page-wrapper` div, after the highlight canvas, add the overlay canvas. Also conditionally hide the PDF canvas when composite mode is active:

```tsx
<canvas ref={canvasRef} style={isGlyphComposite && !glyphLoading ? { visibility: 'hidden' } : undefined} />
<canvas ref={highlightRef} className="pdf-highlight-canvas" />
<canvas ref={glyphCanvasRef} className="pdf-glyph-overlay-canvas" />
```

- [ ] **Step 8: Verify build**

```bash
cd src/frontend && npx tsc --noEmit
```

- [ ] **Step 9: Manual test**

1. `cd src/frontend && npm run dev`
2. Open a PDF in the viewer
3. Click "Glyphs" button → toggle Off / Show Boxes / Show Outlines
4. Enable "Simplify Glyphs" → adjust tolerance slider → verify PDF canvas hides and overlay shows modified text
5. Enable "Monospace Replace" → change font → verify clean monospace text
6. Toggle back to Off → verify overlay clears and original PDF returns
7. Test zoom/pan with debug active

- [ ] **Step 10: Commit**

```bash
git add src/frontend/src/panels/PdfViewerPanel.tsx
git commit -m "feat: integrate glyph debug overlay and optimization into PDF viewer"
```

---

## Task 11: Final build verification

- [ ] **Step 1: Full build**

```bash
cd src/frontend && npm run build
```

Expected: build succeeds

- [ ] **Step 2: Lint**

```bash
cd src/frontend && npm run lint
```

Expected: no new errors

- [ ] **Step 3: Commit any fixes**

```bash
git add -A && git commit -m "fix: address build/lint issues from glyph debug feature"
```
