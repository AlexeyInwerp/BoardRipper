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
