// src/frontend/src/pdf/glyph-types.ts

import type { Font, Path } from 'opentype.js';

/** Debug overlay + optimization state — component-local in PdfViewerPanel */
export interface GlyphDebugState {
  overlayMode: 'off' | 'boxes' | 'outlines' | 'textItems';
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

/**
 * Transform a point (px, py) in PDF user-space to canvas-pixel-space.
 * vpT is the 6-element viewport transform, scale is the render scale.
 */
export function toCanvas(px: number, py: number, vpT: number[], scale: number): [number, number] {
  return [
    (vpT[0] * px + vpT[2] * py + vpT[4]) * scale,
    (vpT[1] * px + vpT[3] * py + vpT[5]) * scale,
  ];
}

/**
 * Compute the unit text direction and perpendicular (up) direction
 * from a PDF text transform matrix [a, b, c, d, e, f].
 */
function textDirs(t: number[]) {
  const fsx = Math.sqrt(t[0] * t[0] + t[1] * t[1]);
  const fsy = Math.sqrt(t[2] * t[2] + t[3] * t[3]);
  return {
    fsx, fsy,
    dx: fsx > 0 ? t[0] / fsx : 1,
    dy: fsx > 0 ? t[1] / fsx : 0,
    ux: fsy > 0 ? t[2] / fsy : 0,
    uy: fsy > 0 ? t[3] / fsy : 1,
  };
}

/** Compute a text item's axis-aligned bounding rect in canvas-space.
 *  Handles rotated/skewed text by projecting all 4 corners of the oriented
 *  text rectangle through the viewport transform and taking the AABB.
 *
 *  The text baseline is at (e, f). Ascent goes in the (c, d) "up" direction,
 *  descent goes opposite. Default split: ascent = 1.0×fontSize, descent = 0.2×fontSize.
 *  @param heightRatio — total height as multiple of fontSize (default 1.2). */
export function itemRect(
  item: { transform: number[]; width: number },
  vpT: number[],
  scale: number,
  heightRatio = LINE_HEIGHT_RATIO,
): { x: number; y: number; w: number; h: number } {
  const t = item.transform;
  const { fsy, dx, dy, ux, uy } = textDirs(t);
  const fontSize = fsy;

  const ascent = fontSize;                           // 1.0 × fontSize above baseline
  const descent = (heightRatio - 1.0) * fontSize;   // 0.2 × fontSize below baseline

  const w = item.width;
  const ex = t[4], ey = t[5];

  // 4 corners: baseline ± ascent/descent in up direction, ± width in text direction
  const c0 = toCanvas(ex - descent * ux,           ey - descent * uy,           vpT, scale); // bottom-left
  const c1 = toCanvas(ex + w * dx - descent * ux,  ey + w * dy - descent * uy,  vpT, scale); // bottom-right
  const c2 = toCanvas(ex + ascent * ux,             ey + ascent * uy,             vpT, scale); // top-left
  const c3 = toCanvas(ex + w * dx + ascent * ux,    ey + w * dy + ascent * uy,    vpT, scale); // top-right

  const minX = Math.min(c0[0], c1[0], c2[0], c3[0]);
  const minY = Math.min(c0[1], c1[1], c2[1], c3[1]);
  const maxX = Math.max(c0[0], c1[0], c2[0], c3[0]);
  const maxY = Math.max(c0[1], c1[1], c2[1], c3[1]);

  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** Return the 4 corners of the oriented text rectangle in canvas-space.
 *  Order: baseline-start, baseline-end, top-end, top-start (CW for standard pages). */
export function textItemCorners(
  transform: number[], width: number,
  vpT: number[], scale: number,
  heightRatio = LINE_HEIGHT_RATIO,
): [[number, number], [number, number], [number, number], [number, number]] {
  const t = transform;
  const { fsy, dx, dy, ux, uy } = textDirs(t);
  const fontSize = fsy;
  const ascent = fontSize;
  const descent = (heightRatio - 1.0) * fontSize;

  const ex = t[4], ey = t[5];
  return [
    toCanvas(ex - descent * ux,          ey - descent * uy,          vpT, scale),
    toCanvas(ex + width * dx - descent * ux, ey + width * dy - descent * uy, vpT, scale),
    toCanvas(ex + width * dx + ascent * ux,  ey + width * dy + ascent * uy,  vpT, scale),
    toCanvas(ex + ascent * ux,            ey + ascent * uy,            vpT, scale),
  ];
}
